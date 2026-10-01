import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrderRecoveryReader } from '../src/accounts/order-recovery-reader.js';
import { applyLiveOrderEvent, createLiveOrderState, deriveLiveClientOrderId, type LiveOrderEvent } from '../src/live/order-lifecycle.js';
import { createLiveOrderJournal, appendLiveOrderJournal, readLiveOrderJournal } from '../src/live/order-journal.js';
import { collectLiveOrderRecovery, ORDER_RECOVERY_POLICY } from '../src/live/order-recovery-collection.js';
import { buildLiveOrderRecoveryEvidence } from '../src/live/order-recovery-evidence.js';
import { applyCapturedOrderRecovery } from '../src/live/order-recovery-journal.js';

const BASE = Date.UTC(2026, 8, 28, 12), id = (n: number) => `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const intentId = id(100), clientId = deriveLiveClientOrderId('mexc', intentId);
const events: LiveOrderEvent[] = [
  { eventId: id(1), at: new Date(BASE + 1000).toISOString(), type: 'intent-created', intent: {
    orderIntentId: intentId, venue: 'mexc', account: 'main', symbol: 'BTC/USDT', side: 'buy', orderType: 'limit',
    baseQuantity: '0.001', limitPrice: '100000', maxQuoteAmount: '100', feeCaps: { BTC: '0', USDT: '1', MX: '0' },
  } },
  { eventId: id(2), at: new Date(BASE + 2000).toISOString(), type: 'dispatch-marked', orderIntentId: intentId, clientOrderId: clientId },
];
const orderBody = { symbol: 'BTCUSDT', orderId: 'fixture-order', clientOrderId: clientId, side: 'BUY', type: 'LIMIT',
  price: '100000', Qty: '0.001', executedQty: '0.0004', cumulativeQuoteQty: '40',
  status: 'PARTIALLY_CANCELED', time: BASE + 2000, updateTime: BASE + 3000 };
const fillBody = { symbol: 'BTCUSDT', orderId: 'fixture-order', clientOrderId: clientId, id: 'fixture-fill',
  price: '100000', qty: '0.0004', quoteQty: '40', commission: '0.02', commissionAsset: 'USDT',
  time: BASE + 3000, isBuyer: true, isSelfTrade: false };
function state() { return events.reduce(applyLiveOrderEvent, createLiveOrderState()); }
function ports(responses: unknown[] = [orderBody, [fillBody], orderBody]) {
  let time = BASE + 10_000;
  const fetcher = vi.fn(async () => new Response(JSON.stringify(responses.shift()), { status: 200 }));
  const clock = () => ++time;
  const reader = new OrderRecoveryReader('mexc', { credentials: { apiKey: 'fixture-key', apiSecret: 'fixture-secret' },
    fetch: fetcher as unknown as typeof fetch, clock });
  const options = { clock, wait: async (ms: number) => { time += ms; } };
  return { reader, fetcher, options, clock };
}
async function offlineCli(args: string[]) {
  const source = `
    import net from 'node:net'; import tls from 'node:tls';
    import http from 'node:http'; import https from 'node:https';
    import { syncBuiltinESMExports } from 'node:module';
    const deny = () => { throw Error('NETWORK_FORBIDDEN'); };
    globalThis.fetch = deny; net.Socket.prototype.connect = deny;
    net.connect = deny; tls.connect = deny; http.request = deny; https.request = deny;
    syncBuiltinESMExports();
    Date.now = () => Number(process.env.CRYPTO_RECOVERY_TEST_NOW);
    process.argv = [process.execPath, 'src/scripts/order-recovery.ts', ...JSON.parse(process.env.CRYPTO_RECOVERY_TEST_ARGS)];
    await import('./src/scripts/order-recovery.ts');
  `;
  return await new Promise<{ code: number; output: string; error: string }>(resolve => {
    execFile(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
      cwd: process.cwd(), timeout: 15_000, maxBuffer: 128 * 1024,
      env: { ...process.env, CRYPTO_RECOVERY_TEST_ARGS: JSON.stringify(args), CRYPTO_RECOVERY_TEST_NOW: String(BASE + 20_000),
        TRADING_MODE: 'live', LIVE_TRADING_LOCKED: 'false' },
    }, (error, output, stderr) => resolve({ code: error ? 1 : 0, output, error: stderr }));
  });
}
const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function journal() {
  const root = await mkdtemp(join(tmpdir(), 'recovery-integration-')); roots.push(root);
  const directory = join(root, 'journal');
  let saved = await createLiveOrderJournal(directory);
  for (const event of events) saved = await appendLiveOrderJournal(directory, event, saved.checkpoint);
  return { directory, saved, root };
}

describe('read-only capture through response binding and durable rehearsal', () => {
  it('performs three narrowly selected GET reads and accounts the exact reported fill once', async () => {
    const { directory, saved } = await journal(), port = ports();
    const capture = await collectLiveOrderRecovery(saved.state, intentId, port.reader, port.options);
    expect(port.fetcher).toHaveBeenCalledTimes(3);
    const calls = port.fetcher.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map(([, options]) => options.method)).toEqual(['GET', 'GET', 'GET']);
    expect(new URL(calls[0][0]).searchParams.get('origClientOrderId')).toBe(clientId);
    expect(new URL(calls[2][0]).searchParams.get('orderId')).toBe('fixture-order');
    expect(new URL(calls[2][0]).searchParams.has('origClientOrderId')).toBe(false);
    expect(Object.isFrozen(capture.orderBefore.data)).toBe(true);
    expect(JSON.stringify(capture)).not.toMatch(/fixture-secret|fixture-key|signature|X-MEXC/);
    const result = await applyCapturedOrderRecovery(directory, saved.checkpoint, intentId, capture, port.clock());
    expect(result.plan.blockers).toEqual([]);
    expect(result).toMatchObject({ executable: false, captureProvenanceVerified: false, appended: 3 });
    expect((await readLiveOrderJournal(directory)).state.orders[0]).toMatchObject({ phase: 'reconciled',
      cashDelta: { BTC: '0.0004', USDT: '-40.02', MX: '0' }, reserved: { BTC: '0', USDT: '0', MX: '0' } });
    const again = await applyCapturedOrderRecovery(directory, saved.checkpoint, intentId, capture, port.clock());
    expect(again).toMatchObject({ appended: 0, alreadyApplied: 3 });
    expect(again.checkpoint).toEqual(result.checkpoint);
  });

  it('resumes a published prefix after a long interruption without admitting stale unstarted evidence', async () => {
    const a = await journal(), port = ports();
    const capture = await collectLiveOrderRecovery(a.saved.state, intentId, port.reader, port.options);
    const plan = buildLiveOrderRecoveryEvidence(a.saved.state, intentId, capture, { ...ORDER_RECOVERY_POLICY, now: port.clock() });
    expect(plan.events).toHaveLength(3);
    await appendLiveOrderJournal(a.directory, plan.events[0], a.saved.checkpoint);
    const result = await applyCapturedOrderRecovery(a.directory, a.saved.checkpoint, intentId, capture, capture.receivedAt + 120_000);
    expect(result).toMatchObject({ alreadyApplied: 1, appended: 2, captureTiming: 'resumed-historical' });
    const b = await journal();
    const blocked = await applyCapturedOrderRecovery(b.directory, b.saved.checkpoint, intentId, capture, capture.receivedAt + 120_000);
    expect(blocked.appended).toBe(0);
    expect(blocked.plan.blockers).toContain('invalid-or-stale-capture-time');
    expect((await readLiveOrderJournal(b.directory)).revision).toBe(2);
  });

  it('preserves the already published prefix when unrelated work changes the journal', async () => {
    const { directory, saved } = await journal(), port = ports();
    const capture = await collectLiveOrderRecovery(saved.state, intentId, port.reader, port.options);
    const plan = buildLiveOrderRecoveryEvidence(saved.state, intentId, capture, { ...ORDER_RECOVERY_POLICY, now: port.clock() });
    const prefix = await appendLiveOrderJournal(directory, plan.events[0], saved.checkpoint);
    await appendLiveOrderJournal(directory, { eventId: id(500), at: new Date(capture.receivedAt + 1).toISOString(),
      type: 'dispatch-uncertain', orderIntentId: intentId, reason: 'process-recovery' }, prefix.checkpoint);
    await expect(applyCapturedOrderRecovery(directory, saved.checkpoint, intentId, capture, port.clock())).rejects.toThrow('recovery-head-conflict');
    const unchanged = await readLiveOrderJournal(directory);
    expect(unchanged.revision).toBe(4);
    expect(unchanged.state.orders[0].fills).toHaveLength(1);
    expect(unchanged.state.orders[0].reserved.USDT).toBe('101');
  });

  it('stops after lookup failure without retrying or changing the journal', async () => {
    const { directory, saved } = await journal(), port = ports([{ code: 22222, message: 'PRIVATE_ERROR_CANARY' }]);
    await expect(collectLiveOrderRecovery(saved.state, intentId, port.reader, port.options)).rejects.toThrow('recovery-read-unavailable');
    expect(port.fetcher).toHaveBeenCalledTimes(1);
    expect((await readLiveOrderJournal(directory)).checkpoint).toEqual(saved.checkpoint);
  });

  it('does not query a prepared intent, another venue or an order outside retention', async () => {
    const port = ports();
    const prepared = applyLiveOrderEvent(createLiveOrderState(), events[0]);
    await expect(collectLiveOrderRecovery(prepared, intentId, port.reader, port.options)).rejects.toThrow('recovery-ineligible-order');
    await expect(collectLiveOrderRecovery(state(), intentId, { ...port.reader, venue: 'okx',
      getOrder: port.reader.getOrder.bind(port.reader), getFills: port.reader.getFills.bind(port.reader) }, port.options)).rejects.toThrow('recovery-identity-mismatch');
    await expect(collectLiveOrderRecovery(state(), intentId, port.reader, { clock: () => BASE + 8 * 86400_000 })).rejects.toThrow('recovery-outside-retention');
    expect(port.fetcher).not.toHaveBeenCalled();
  });

  it('inspects and imports through separate offline processes with redacted metadata and no network', async () => {
    const { root, directory, saved } = await journal(), port = ports();
    const capture = await collectLiveOrderRecovery(saved.state, intentId, port.reader, port.options);
    const file = join(root, 'capture.json'), checkpoint = join(root, 'base.json'), output = join(root, 'report');
    await writeFile(file, JSON.stringify(capture), { mode: 0o600 });
    await writeFile(checkpoint, JSON.stringify(saved.checkpoint), { mode: 0o600 });
    const inspect = await offlineCli(['inspect', file, directory, checkpoint, intentId, output]);
    expect(inspect).toMatchObject({ code: 0, error: '' });
    expect(JSON.parse(inspect.output)).toMatchObject({ eventsProposed: 3, executable: false, reportWritten: true });
    expect((await readLiveOrderJournal(directory)).checkpoint).toEqual(saved.checkpoint);
    expect((await stat(output)).mode & 0o777).toBe(0o700);
    expect((await stat(join(output, 'report.json'))).mode & 0o777).toBe(0o600);
    const before = await readFile(join(output, 'report.json'));
    expect((await offlineCli(['inspect', file, directory, checkpoint, intentId, output])).code).toBe(1);
    expect(await readFile(join(output, 'report.json'))).toEqual(before);
    const imported = await offlineCli(['import', file, directory, checkpoint, intentId]);
    expect(imported).toMatchObject({ code: 0, error: '' });
    expect(JSON.parse(imported.output)).toMatchObject({ appended: 3, executable: false, accountIdentityVerified: false });
    expect(JSON.parse((await offlineCli(['import', file, directory, checkpoint, intentId])).output)).toMatchObject({ appended: 0, alreadyApplied: 3 });
    expect(inspect.output + imported.output).not.toMatch(/fixture-secret|fixture-key|fixture-order|fixture-fill|sourceUpdatedAt|cashDelta/);
    const invalid = await offlineCli(['submit', file, directory, checkpoint, intentId]);
    expect(invalid).toMatchObject({ code: 1, output: '' });
    expect(invalid.error).not.toContain('NETWORK_FORBIDDEN');
  }, 30_000);

  it('rejects a concurrent capture using the same reader and bounds a stuck response', async () => {
    vi.useFakeTimers();
    const reader = { venue: 'mexc' as const, getOrder: vi.fn(() => new Promise<never>(() => {})), getFills: vi.fn() };
    const first = collectLiveOrderRecovery(state(), intentId, reader, { clock: () => BASE + 10_000 });
    const rejected = expect(first).rejects.toThrow('recovery-deadline');
    await expect(collectLiveOrderRecovery(state(), intentId, reader, { clock: () => BASE + 10_000 })).rejects.toThrow('recovery-busy');
    await vi.advanceTimersByTimeAsync(5001);
    await rejected;
    expect(reader.getOrder).toHaveBeenCalledTimes(1); expect(reader.getFills).not.toHaveBeenCalled();
  });
});
