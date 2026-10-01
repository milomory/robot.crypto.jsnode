import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendLiveOrderJournal, createLiveOrderJournal, readLiveOrderJournal } from '../src/live/order-journal.js';
import { applyLiveOrderEvent, parseLiveOrderEvent, replayLiveOrderEvents, type LiveOrderEvent } from '../src/live/order-lifecycle.js';
import { OrderRecoveryReader } from '../src/accounts/order-recovery-reader.js';
import { AccountTransport } from '../src/accounts/transport.js';
import { collectLiveOrderRecovery, ORDER_RECOVERY_POLICY } from '../src/live/order-recovery-collection.js';
import { buildLiveOrderRecoveryEvidence } from '../src/live/order-recovery-evidence.js';

const fixture = JSON.parse(await readFile('fixtures/live-order-rehearsal/partial-cancel.json', 'utf8')) as { events: unknown[] };
const events = fixture.events.map(parseLiveOrderEvent);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function prepared() {
  const root = await mkdtemp(join(tmpdir(), 'live-recovery-boundary-')); roots.push(root);
  const directory = join(root, 'journal');
  let snapshot = await createLiveOrderJournal(directory);
  for (const event of events.slice(0, 2)) snapshot = await appendLiveOrderJournal(directory, event, snapshot.checkpoint);
  return { directory, snapshot };
}
function readOnlyBatch(): LiveOrderEvent[] {
  const fill = structuredClone(events[4]), observation = structuredClone(events[7]);
  if (fill.type !== 'fill-recorded' || observation.type !== 'order-observed') throw new Error('invalid-test-fixture');
  fill.source = 'declared-recorded'; observation.observation.source = 'declared-recorded';
  return [fill, observation];
}

describe('independent durable recovery batch boundaries', () => {
  it('resumes an interrupted event prefix once without promoting declared evidence or releasing reservations', async () => {
    const { directory, snapshot } = await prepared(), batch = readOnlyBatch();
    await appendLiveOrderJournal(directory, batch[0], snapshot.checkpoint);
    const restarted = await readLiveOrderJournal(directory, snapshot.checkpoint);
    expect(restarted.revision).toBe(3);
    expect(restarted.state.orders[0]).toMatchObject({ phase: 'unknown', reserved: { BTC: '0', USDT: '100.1', MX: '0' },
      cashDelta: { BTC: '0.0004', USDT: '-40.04', MX: '0' } });
    const repeated = await appendLiveOrderJournal(directory, batch[0], snapshot.checkpoint);
    expect(repeated.appended).toBe(false);
    const complete = await appendLiveOrderJournal(directory, batch[1], repeated.checkpoint);
    expect(complete.revision).toBe(4);
    expect(complete.state.orders[0]).toMatchObject({ phase: 'terminal-unreconciled', reserved: { BTC: '0', USDT: '100.1', MX: '0' },
      cashDelta: { BTC: '0.0004', USDT: '-40.04', MX: '0' } });
    expect(complete.state.orders[0].fills).toHaveLength(1);
    expect(complete).toMatchObject({ nonExecutable: true, captureProvenanceVerified: false });
    expect(complete.state).toMatchObject({ nonExecutable: true, captureProvenanceVerified: false });
  });

  it('does not rewrite timestamps or rollback published evidence when another writer advances the stream', async () => {
    const { directory, snapshot } = await prepared(), batch = readOnlyBatch();
    const partial = await appendLiveOrderJournal(directory, batch[0], snapshot.checkpoint);
    const changed = await appendLiveOrderJournal(directory, { eventId: '90000000-0000-4000-8000-000000000001',
      at: '2026-09-28T12:00:09.000Z', type: 'dispatch-uncertain', orderIntentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      reason: 'process-recovery' }, partial.checkpoint);
    const prefixReplay = await appendLiveOrderJournal(directory, batch[0], snapshot.checkpoint);
    expect(prefixReplay.appended).toBe(false);
    expect(prefixReplay.headHash).toBe(changed.headHash);
    await expect(appendLiveOrderJournal(directory, batch[1], prefixReplay.checkpoint)).rejects.toThrow('journal-event-invalid');
    const recovered = await readLiveOrderJournal(directory, changed.checkpoint);
    expect(recovered.headHash).toBe(changed.headHash);
    expect(recovered.state.orders[0].fills).toHaveLength(1);
    expect(recovered.state.orders[0].reserved.USDT).toBe('100.1');
  });
});

const fakeCredentials = { apiKey: 'independent-recovery-fake-key', apiSecret: 'independent-recovery-fake-secret', passphrase: 'independent-fake-passphrase' };
function mexcSourceRows() {
  const time = Date.parse('2026-09-28T12:00:02.000Z'), updateTime = Date.parse('2026-09-28T12:00:05.000Z');
  const clientOrderId = 'CRM31773cc257f7e35f684975c6924da';
  return {
    order: { symbol: 'BTCUSDT', orderId: 'recovery-order-1', clientOrderId, price: '100000', Qty: '0.001',
      executedQty: '0.0004', cumulativeQuoteQty: '40', status: 'CANCELED', type: 'LIMIT', side: 'BUY', time, updateTime },
    fills: [{ symbol: 'BTCUSDT', id: 'recovery-fill-1', orderId: 'recovery-order-1', clientOrderId,
      price: '100000', qty: '0.0004', quoteQty: '40', commission: '0.04', commissionAsset: 'USDT',
      time: time + 500, isBuyer: true }],
  };
}

describe('independent recovery reader boundaries', () => {
  it('keeps a reader bound to its original venue at runtime', async () => {
    const rows = mexcSourceRows();
    const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(rows.order), { status: 200 }));
    const reader = new OrderRecoveryReader('mexc', { credentials: fakeCredentials, fetch: fetcher as typeof fetch,
      clock: () => Date.parse('2026-09-28T12:00:10.000Z') });
    expect(Reflect.set(reader, 'venue', 'okx')).toBe(false);
    const result = await reader.getOrderById('recovery-order-1');
    expect(result.venue).toBe('mexc');
    expect(new URL(String(fetcher.mock.calls[0][0])).origin).toBe('https://api.mexc.com');
  });

  it('rejects broadened scopes and ambiguous selectors before any outbound request', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 }));
    const transport = new AccountTransport({ credentials: fakeCredentials, fetch: fetcher as typeof fetch }, 'order-recovery');
    const auth = `recvWindow=5000&timestamp=1790596810000&signature=${'0'.repeat(64)}`;
    const urls = [
      `https://api.mexc.com/api/v3/account?${auth}`,
      `https://api.mexc.com/api/v3/order?symbol=ETHUSDT&orderId=1&${auth}`,
      `https://api.mexc.com/api/v3/order?symbol=BTCUSDT&orderId=1&origClientOrderId=${'a'.repeat(32)}&${auth}`,
      `https://api.mexc.com/api/v3/myTrades?symbol=BTCUSDT&limit=1000&${auth}`,
      `https://api.mexc.com.invalid/api/v3/order?symbol=BTCUSDT&orderId=1&${auth}`,
      'https://www.okx.com/api/v5/account/balance',
      `https://www.okx.com/api/v5/trade/order?instId=BTC-USDT&ordId=1&clOrdId=${'a'.repeat(32)}`,
      'https://www.okx.com/api/v5/trade/fills-history?instType=SPOT&instId=BTC-USDT&begin=1790596800000&end=1790596810000&limit=100',
      'https://www.okx.com/api/v5/asset/transfer',
    ];
    for (const url of urls) await expect(transport.request(url, {})).rejects.toThrow('account-unsupported-endpoint');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('binds a real-shaped three-read capture when independent clock reads advance by milliseconds', async () => {
    const rows = mexcSourceRows();
    let clockValue = Date.parse('2026-09-28T12:00:10.000Z');
    const clock = () => clockValue++;
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe('GET');
      expect(init?.redirect).toBe('error');
      const fills = new URL(String(url)).pathname === '/api/v3/myTrades';
      return new Response(JSON.stringify(fills ? rows.fills : rows.order), { status: 200 });
    });
    const reader = new OrderRecoveryReader('mexc', { credentials: fakeCredentials, fetch: fetcher as typeof fetch, clock });
    const state = replayLiveOrderEvents(events.slice(0, 2));
    const capture = await collectLiveOrderRecovery(state, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', reader,
      { clock, wait: async () => {} });
    const plan = buildLiveOrderRecoveryEvidence(state, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', capture,
      { ...ORDER_RECOVERY_POLICY, now: clock() });
    expect(plan.blockers).toEqual([]);
    expect(plan).toMatchObject({ nonExecutable: true, captureProvenanceVerified: false, accountIdentityVerified: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(plan.events.some(event => event.type === 'fill-recorded')).toBe(true);
  });
});

function declaredCapture() {
  const rows = mexcSourceRows(), receivedAt = Date.parse('2026-09-28T12:00:10.000Z');
  return { schema: 1, kind: 'live-order-recovery-capture', venue: 'mexc', account: 'main',
    clientOrderId: rows.order.clientOrderId, requestedAt: receivedAt - 600, receivedAt,
    orderBefore: { kind: 'order', venue: 'mexc', requestedAt: receivedAt - 600, receivedAt: receivedAt - 500,
      query: { symbol: 'BTCUSDT', origClientOrderId: rows.order.clientOrderId }, data: structuredClone(rows.order) },
    fills: { kind: 'fills', venue: 'mexc', requestedAt: receivedAt - 400, receivedAt: receivedAt - 300,
      query: { symbol: 'BTCUSDT', orderId: 'recovery-order-1', limit: '1000' }, data: rows.fills },
    orderAfter: { kind: 'order', venue: 'mexc', requestedAt: receivedAt - 200, receivedAt,
      query: { symbol: 'BTCUSDT', orderId: 'recovery-order-1' }, data: structuredClone(rows.order) },
  };
}
describe('independent capture trust boundaries', () => {
  it('rejects contradictory known original-client identity instead of stripping it', () => {
    const state = replayLiveOrderEvents(events.slice(0, 2)), capture = declaredCapture();
    Object.assign(capture.orderBefore.data, { origClientOrderId: 'a'.repeat(32) });
    Object.assign(capture.orderAfter.data, { origClientOrderId: 'a'.repeat(32) });
    const plan = buildLiveOrderRecoveryEvidence(state, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', capture,
      { ...ORDER_RECOVERY_POLICY, now: capture.receivedAt });
    expect(plan.events).toEqual([]); expect(plan.blockers.length).toBeGreaterThan(0);
  });

  it('rejects caller-supplied provenance claims and leaves lifecycle state unchanged', () => {
    const state = replayLiveOrderEvents(events.slice(0, 2)), capture = declaredCapture();
    const plan = buildLiveOrderRecoveryEvidence(state, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      { ...capture, captureProvenanceVerified: true, accountIdentityVerified: true },
      { ...ORDER_RECOVERY_POLICY, now: capture.receivedAt });
    expect(plan.events).toEqual([]); expect(plan.blockers.length).toBeGreaterThan(0);
    expect(plan).toMatchObject({ captureProvenanceVerified: false, accountIdentityVerified: false });
    expect(state.orders[0].phase).toBe('unknown');
  });

  it('rejects an older source snapshot even when a later HTTP capture looks fresh', () => {
    let state = replayLiveOrderEvents(events.slice(0, 2));
    const first = declaredCapture();
    for (const read of [first.orderBefore, first.orderAfter]) Object.assign(read.data, {
      executedQty: '0', cumulativeQuoteQty: '0', status: 'NEW', updateTime: Date.parse('2026-09-28T12:00:06.000Z'),
    });
    first.fills.data = [];
    const initial = buildLiveOrderRecoveryEvidence(state, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', first,
      { ...ORDER_RECOVERY_POLICY, now: first.receivedAt });
    expect(initial.events.length).toBeGreaterThan(0);
    for (const event of initial.events) state = applyLiveOrderEvent(state, event);
    expect(state.orders[0].latestObservation?.sourceUpdatedAt).toBe('2026-09-28T12:00:06.000Z');
    const next = declaredCapture();
    next.requestedAt += 10_000; next.receivedAt += 10_000;
    for (const read of [next.orderBefore, next.fills, next.orderAfter]) { read.requestedAt += 10_000; read.receivedAt += 10_000; }
    // Once an exchange order ID is persisted, further reads must select exactly it.
    Object.assign(next.orderBefore, { query: { symbol: 'BTCUSDT', orderId: 'recovery-order-1' } });
    const regression = buildLiveOrderRecoveryEvidence(state, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', next,
      { ...ORDER_RECOVERY_POLICY, now: next.receivedAt });
    expect(regression.events).toEqual([]); expect(regression.blockers.length).toBeGreaterThan(0);
    expect(state.orders[0].latestObservation?.sourceUpdatedAt).toBe('2026-09-28T12:00:06.000Z');
  });
});
