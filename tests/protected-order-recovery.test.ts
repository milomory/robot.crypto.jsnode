import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { inspect } from 'node:util';
import { PassThrough, Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendLiveOrderJournal, createLiveOrderJournal, readLiveOrderJournal } from '../src/live/order-journal.js';
import { canonicalLiveOrderJson as canonical, deriveLiveClientOrderId } from '../src/live/order-lifecycle.js';
import { parseProtectedOrderRecoveryRequest, preflightProtectedOrderRecovery, readProtectedRecoveryCooldowns,
  PROTECTED_ORDER_RECOVERY_LIMITS } from '../src/live/order-recovery-request.js';
import { executeProtectedOrderRecovery, parseOrderRecoveryInput, persistProtectedRecoveryCooldowns, readOrderRecoveryStdin } from '../src/accounts/order-recovery-runtime.js';
import { createOrderRecoverySessionContext, readLiveOrderRecoveryArchive } from '../src/live/order-recovery-session.js';
const now = Date.UTC(2026, 8, 28, 12), intentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', requestId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const fake = { apiKey: 'PROTECTED_FAKE_ACCESS_KEY_123', apiSecret: 'PROTECTED_FAKE_SECRET_456', passphrase: 'PROTECTED_FAKE_PASSPHRASE_789' };
const roots: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function input(venue: 'mexc' | 'okx' = 'mexc', override: Record<string, unknown> = {}) {
  return { schema: 1, venue, [venue]: { schema: 1, venue, environment: 'mainnet', region: 'global', apiKey: fake.apiKey, apiSecret: fake.apiSecret,
    ...(venue === 'okx' ? { passphrase: fake.passphrase } : {}), ...override } };
}
const raw = (venue: 'mexc' | 'okx' = 'mexc') => Buffer.from(JSON.stringify(input(venue)));
async function setup(venue: 'mexc' | 'okx' = 'mexc') {
  const root = await mkdtemp(join(tmpdir(), 'protected-order-recovery-')); roots.push(root);
  const paths = { request: join(root, 'request', 'request.json'), journal: join(root, 'journal'), archiveParent: join(root, 'state'), observerState: join(root, 'observer-state') };
  for (const name of ['request', 'state', 'observer-state']) await mkdir(join(root, name), { mode: 0o700 });
  await writeFile(join(paths.observerState, 'cooldowns.json'), JSON.stringify({ schema: 1, mexc: 0, okx: 0 }), { mode: 0o600 });
  let snapshot = await createLiveOrderJournal(paths.journal);
  snapshot = await appendLiveOrderJournal(paths.journal, { eventId: '10000000-0000-4000-8000-000000000001', at: new Date(now - 9000).toISOString(),
    type: 'intent-created', intent: { orderIntentId: intentId, venue, account: 'main', symbol: 'BTC/USDT', side: 'buy', orderType: 'limit', baseQuantity: '0.001',
      limitPrice: '100000', maxQuoteAmount: '100', feeCaps: { BTC: '0', USDT: '0.1', MX: '0' } } }, snapshot.checkpoint);
  snapshot = await appendLiveOrderJournal(paths.journal, { eventId: '10000000-0000-4000-8000-000000000002', at: new Date(now - 8000).toISOString(),
    type: 'dispatch-marked', orderIntentId: intentId, clientOrderId: deriveLiveClientOrderId(venue, intentId) }, snapshot.checkpoint);
  const request = { schema: 1, kind: 'protected-order-recovery-request', requestId, venue, account: 'main', createdAt: now - 1000, expiresAt: now + 60_000,
    baseCheckpoint: snapshot.checkpoint, orderIntentId: intentId };
  const digest = await writeRequest(paths.request, request);
  return { root, paths, request, digest, snapshot };
}
async function writeRequest(path: string, request: unknown) { const text = canonical(request) + '\n'; await writeFile(path, text, { mode: 0o600 }); return createHash('sha256').update(text).digest('hex'); }
function mockedFetch(venue: 'mexc' | 'okx' = 'mexc') {
  const client = deriveLiveClientOrderId(venue, intentId);
  const order = venue === 'mexc' ? { symbol: 'BTCUSDT', orderId: 'remote-order-1', clientOrderId: client, price: '100000', Qty: '0.001', executedQty: '0.0004',
    cumulativeQuoteQty: '40', status: 'CANCELED', type: 'LIMIT', side: 'BUY', time: now - 8000, updateTime: now - 5000 } : {
      instType: 'SPOT', instId: 'BTC-USDT', ordId: 'remote-order-1', clOrdId: client, tdMode: 'cash', category: 'normal', side: 'buy', ordType: 'limit', state: 'canceled',
      sz: '0.001', px: '100000', accFillSz: '0.0004', avgPx: '100000', fee: '-0.04', feeCcy: 'USDT', rebate: '0', rebateCcy: 'USDT', cTime: now - 8000, uTime: now - 5000 };
  const fills = venue === 'mexc' ? [{ symbol: 'BTCUSDT', id: 'remote-fill-1', orderId: 'remote-order-1', price: '100000', qty: '0.0004', quoteQty: '40', commission: '0.04',
    commissionAsset: 'USDT', time: now - 7500, isBuyer: true }] : [{ instType: 'SPOT', instId: 'BTC-USDT', ordId: 'remote-order-1', clOrdId: client, tradeId: 'remote-fill-1', billId: '17',
      side: 'buy', subType: '1', execType: 'T', fillSz: '0.0004', fillPx: '100000', fee: '-0.04', feeCcy: 'USDT', fillTime: now - 7500, ts: now - 7499 }];
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(init).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store' });
    const target = new URL(String(url)); expect(target.origin).toBe(venue === 'mexc' ? 'https://api.mexc.com' : 'https://www.okx.com');
    const isFill = target.pathname.endsWith('/myTrades') || target.pathname.endsWith('/fills-history');
    return new Response(JSON.stringify(venue === 'mexc' ? isFill ? fills : order : { code: '0', data: isFill ? fills : [order] }), { status: 200 });
  });
}
const failure = { schema: 1, error: 'recovery-failed' };

describe('strict pinned request and key-free preflight', () => {
  it('checks exact head/private files/TTL with no HTTP or secret input', async () => {
    const f = await setup(), fetcher = vi.fn(() => { throw new Error('OUTBOUND_ATTEMPT'); }); vi.stubGlobal('fetch', fetcher);
    const result = await preflightProtectedOrderRecovery(f.digest, { paths: f.paths, now });
    expect(result.summary).toEqual({ schema: 1, mode: 'order-recovery-preflight', requestSha256: f.digest, venue: 'mexc', ready: true,
      executable: false, captureProvenanceVerified: false, accountIdentityVerified: false });
    expect(fetcher).not.toHaveBeenCalled(); expect(await readdir(f.paths.archiveParent)).toEqual([]);
    expect((await readLiveOrderJournal(f.paths.journal)).checkpoint).toEqual(f.snapshot.checkpoint);
    expect(Object.isFrozen(result.request.baseCheckpoint)).toBe(true);
  });
  it.each([
    ['expired', (r: any) => { r.expiresAt = now; }],
    ['future', (r: any) => { r.createdAt = now + 1; }],
    ['zero TTL', (r: any) => { r.expiresAt = r.createdAt; }],
    ['too long TTL', (r: any) => { r.expiresAt = r.createdAt + 900001; }],
    ['unknown field', (r: any) => { r.secretReference = 'private-reference'; }],
    ['wrong account', (r: any) => { r.account = 'subaccount'; }],
    ['unknown venue', (r: any) => { r.venue = 'bybit'; }],
    ['uppercase UUID', (r: any) => { r.requestId = r.requestId.toUpperCase(); }],
    ['fake provenance', (r: any) => { r.captureProvenanceVerified = true; }],
  ])('rejects %s request', async (_label, mutate) => {
    const f = await setup(); mutate(f.request); expect(() => parseProtectedOrderRecoveryRequest(f.request, now)).toThrow('recovery-preflight-failed');
  });
  it('rejects digest mismatch and valid but noncanonical JSON bytes', async () => {
    const f = await setup(); await expect(preflightProtectedOrderRecovery('0'.repeat(64), { paths: f.paths, now })).rejects.toThrow('recovery-preflight-failed');
    const text = JSON.stringify(f.request); await writeFile(f.paths.request, text); const digest = createHash('sha256').update(text).digest('hex');
    await expect(preflightProtectedOrderRecovery(digest, { paths: f.paths, now })).rejects.toThrow('recovery-preflight-failed');
  });
  it('rejects stale checkpoint and never falls back to latest', async () => {
    const f = await setup(); await appendLiveOrderJournal(f.paths.journal, { eventId: '10000000-0000-4000-8000-000000000003', at: new Date(now - 1000).toISOString(),
      type: 'dispatch-uncertain', orderIntentId: intentId, reason: 'timeout' }, f.snapshot.checkpoint);
    await expect(preflightProtectedOrderRecovery(f.digest, { paths: f.paths, now })).rejects.toThrow('recovery-preflight-failed');
  });
  it('binds venue and intent to the persisted order', async () => {
    const f = await setup(); f.request.venue = 'okx'; let digest = await writeRequest(f.paths.request, f.request);
    await expect(preflightProtectedOrderRecovery(digest, { paths: f.paths, now })).rejects.toThrow('recovery-preflight-failed');
    f.request.venue = 'mexc'; f.request.orderIntentId = requestId; digest = await writeRequest(f.paths.request, f.request);
    await expect(preflightProtectedOrderRecovery(digest, { paths: f.paths, now })).rejects.toThrow('recovery-preflight-failed');
  });
  it('rejects request symlinks, hardlinks and permissive modes', async () => {
    const f = await setup(); await chmod(f.paths.request, 0o644);
    await expect(preflightProtectedOrderRecovery(f.digest, { paths: f.paths, now })).rejects.toThrow(); await chmod(f.paths.request, 0o600);
    await link(f.paths.request, join(f.root, 'request-hardlink')); await expect(preflightProtectedOrderRecovery(f.digest, { paths: f.paths, now })).rejects.toThrow();
    await rm(join(f.root, 'request-hardlink')); const actual = join(f.root, 'actual-request'); await writeFile(actual, await readFile(f.paths.request), { mode: 0o600 });
    await rm(f.paths.request); await symlink(actual, f.paths.request); await expect(preflightProtectedOrderRecovery(f.digest, { paths: f.paths, now })).rejects.toThrow();
  });
  it('rejects directory aliases and pre-existing output including broken symlinks', async () => {
    const f = await setup(); await symlink(f.paths.archiveParent, join(f.root, 'state-alias'));
    await expect(preflightProtectedOrderRecovery(f.digest, { paths: { ...f.paths, archiveParent: join(f.root, 'state-alias') }, now })).rejects.toThrow();
    await symlink('/missing-private-target', join(f.paths.archiveParent, requestId));
    await expect(preflightProtectedOrderRecovery(f.digest, { paths: f.paths, now })).rejects.toThrow();
  });
  it('requires existing valid private cooldown state and respects venue backoff', async () => {
    const f = await setup(), path = join(f.paths.observerState, 'cooldowns.json');
    await writeFile(path, JSON.stringify({ schema: 1, mexc: now + 1, okx: 0 })); await expect(preflightProtectedOrderRecovery(f.digest, { paths: f.paths, now })).rejects.toThrow();
    await writeFile(path, JSON.stringify({ schema: 1, mexc: 0, okx: now + 1 })); await expect(preflightProtectedOrderRecovery(f.digest, { paths: f.paths, now })).resolves.toHaveProperty('summary.ready', true);
    await rm(path); await expect(preflightProtectedOrderRecovery(f.digest, { paths: f.paths, now })).rejects.toThrow();
  });
  it('rejects oversized request before decoding', async () => {
    const f = await setup(); const bytes = Buffer.alloc(PROTECTED_ORDER_RECOVERY_LIMITS.requestBytes + 1, 32); await writeFile(f.paths.request, bytes);
    await expect(preflightProtectedOrderRecovery(createHash('sha256').update(bytes).digest('hex'), { paths: f.paths, now })).rejects.toThrow();
  });
});

describe('one-venue secret input and protected read-only runtime', () => {
  it.each(['mexc', 'okx'] as const)('accepts only one strict %s bundle and exposes no keys', venue => {
    const parsed = parseOrderRecoveryInput(raw(venue)); expect(parsed.venue).toBe(venue);
    for (const secret of Object.values(fake)) { expect(JSON.stringify(parsed)).not.toContain(secret); expect(inspect(parsed)).not.toContain(secret); }
    expect(Object.keys(parsed).sort()).toEqual(['assertNoSecrets', 'capture', 'venue']); expect(Object.isFrozen(parsed)).toBe(true);
  });
  it.each([
    ['both venues', () => ({ ...input('mexc'), okx: input('okx').okx })],
    ['bundle venue mismatch', () => ({ schema: 1, venue: 'mexc', mexc: input('okx').okx })],
    ['demo environment', () => input('mexc', { environment: 'testnet' })],
    ['wrong region', () => input('okx', { region: 'eu' })],
    ['missing passphrase', () => { const value = input('okx') as any; delete value.okx.passphrase; return value; }],
    ['extra secret path', () => ({ ...input('mexc'), keyFile: '/private/secret' })],
    ['extra credential field', () => input('mexc', { token: 'private-value' })],
  ])('rejects %s input with a fixed error', (_label, fixture) => {
    expect(() => parseOrderRecoveryInput(Buffer.from(JSON.stringify(fixture())))).toThrow('recovery-runtime-failed');
  });
  it('guards both literal and JSON-escaped secret representations', () => {
    const secret = 'PROTECTED_QUOTED_"_SECRET', parsed = parseOrderRecoveryInput(Buffer.from(JSON.stringify(input('mexc', { apiSecret: secret }))));
    expect(() => parsed.assertNoSecrets('prefix' + secret)).toThrow(); expect(() => parsed.assertNoSecrets(JSON.stringify({ text: secret }))).toThrow();
    expect(() => parsed.assertNoSecrets('safe fixed summary')).not.toThrow();
  });
  it.each(['mexc', 'okx'] as const)('captures three mocked %s GETs and writes only a private original archive', async venue => {
    const f = await setup(venue), fetcher = mockedFetch(venue);
    const result = await executeProtectedOrderRecovery(f.digest, raw(venue), { paths: f.paths, clock: () => now, fetch: fetcher, wait: async () => {} });
    expect(result.success).toBe(true); expect(fetcher).toHaveBeenCalledTimes(3);
    const summary = JSON.parse(result.output!); expect(summary).toMatchObject({ schema: 1, mode: 'order-recovery-readonly', requestSha256: f.digest, venue,
      reportWritten: true, executable: false, captureProvenanceVerified: false, accountIdentityVerified: false, requestCount: 3 });
    expect(result.output).not.toMatch(/remote-order|remote-fill|aaaaaaaa|PROTECTED_FAKE/);
    const archiveDirectory = join(f.paths.archiveParent, requestId), archive = await readLiveOrderRecoveryArchive(archiveDirectory, summary.receipt);
    expect(archive.orderIntentId).toBe(intentId); expect((await lstat(join(archiveDirectory, 'capture.json'))).mode & 0o777).toBe(0o600);
    expect((await readLiveOrderJournal(f.paths.journal)).checkpoint).toEqual(f.snapshot.checkpoint);
    expect(await readProtectedRecoveryCooldowns(f.paths.observerState)).toEqual({ schema: 1, mexc: 0, okx: 0 });
  });
  it('rejects wrong-venue keys, expired request and changed head before HTTP', async () => {
    const f = await setup(), fetcher = mockedFetch();
    expect(await executeProtectedOrderRecovery(f.digest, raw('okx'), { paths: f.paths, clock: () => now, fetch: fetcher })).toEqual({ success: false, output: JSON.stringify(failure) });
    expect(await executeProtectedOrderRecovery(f.digest, raw(), { paths: f.paths, clock: () => now + 60_000, fetch: fetcher })).toEqual({ success: false, output: JSON.stringify(failure) });
    await appendLiveOrderJournal(f.paths.journal, { eventId: '10000000-0000-4000-8000-000000000003', at: new Date(now - 1000).toISOString(),
      type: 'dispatch-uncertain', orderIntentId: intentId, reason: 'timeout' }, f.snapshot.checkpoint);
    expect((await executeProtectedOrderRecovery(f.digest, raw(), { paths: f.paths, clock: () => now, fetch: fetcher })).success).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('stops before the next GET if the pinned request expires during capture', async () => {
    const f = await setup(), plain = mockedFetch(); let current = now;
    const fetcher = vi.fn(async (...args: Parameters<typeof fetch>) => { const response = await plain(...args); current = now + 60_000; return response; });
    const result = await executeProtectedOrderRecovery(f.digest, raw(), { paths: f.paths, clock: () => current, fetch: fetcher, wait: async () => {} });
    expect(result.success).toBe(false); expect(fetcher).toHaveBeenCalledTimes(1); expect(await readdir(f.paths.archiveParent)).toEqual([]);
  });
  it('persists 429 Retry-After and refuses another process-context read until it expires', async () => {
    const f = await setup(), fetcher = vi.fn(async () => new Response('', { status: 429, headers: { 'Retry-After': '3600' } }));
    const options = { paths: f.paths, clock: () => now, fetch: fetcher, wait: async () => {} };
    expect((await executeProtectedOrderRecovery(f.digest, raw(), options)).success).toBe(false);
    expect((await readProtectedRecoveryCooldowns(f.paths.observerState)).mexc).toBe(now + 3600_000);
    expect((await executeProtectedOrderRecovery(f.digest, raw(), options)).success).toBe(false); expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await lstat(join(f.paths.observerState, 'cooldowns.json'))).mode & 0o777).toBe(0o600);
  });

  it('retains a 429 received after request expiry instead of dropping its server cooldown', async () => {
    const f = await setup(); let current = now;
    const fetcher = vi.fn(async () => { current = now + 60_000; return new Response('', { status: 429, headers: { 'Retry-After': '3600' } }); });
    const result = await executeProtectedOrderRecovery(f.digest, raw(), { paths: f.paths, clock: () => current, fetch: fetcher, wait: async () => {} });
    expect(result.success).toBe(false); expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await readProtectedRecoveryCooldowns(f.paths.observerState)).mexc).toBe(now + 60_000 + 3600_000);
  });
  it('persists API-200 rate limits instead of treating them as an empty order', async () => {
    const f = await setup('okx'), fetcher = vi.fn(async () => new Response(JSON.stringify({ code: '50011', data: [] }), { status: 200 }));
    expect((await executeProtectedOrderRecovery(f.digest, raw('okx'), { paths: f.paths, clock: () => now, fetch: fetcher, wait: async () => {} })).success).toBe(false);
    expect((await readProtectedRecoveryCooldowns(f.paths.observerState)).okx).toBe(now + 60_000);
  });
  it('refuses regression or permissive cooldown files and preserves the previous bytes', async () => {
    const f = await setup(), path = join(f.paths.observerState, 'cooldowns.json');
    await persistProtectedRecoveryCooldowns(f.paths.observerState, { schema: 1, mexc: now + 60_000, okx: 0 });
    const previous = await readFile(path, 'utf8');
    await expect(persistProtectedRecoveryCooldowns(f.paths.observerState, { schema: 1, mexc: 0, okx: 0 })).rejects.toThrow('recovery-runtime-failed');
    expect(await readFile(path, 'utf8')).toBe(previous); await chmod(path, 0o644);
    await expect(persistProtectedRecoveryCooldowns(f.paths.observerState, { schema: 1, mexc: now + 70_000, okx: 0 })).rejects.toThrow();
  });
  it('suppresses even the fixed failure summary when it contains a contrived known credential', async () => {
    const f = await setup(), bytes = Buffer.from(JSON.stringify(input('mexc', { apiKey: 'recovery-failed' })));
    const result = await executeProtectedOrderRecovery('0'.repeat(64), bytes, { paths: f.paths, clock: () => now }); expect(result).toEqual({ success: false, output: null });
  });
  it('does not log source exceptions or write credentials to the archive', async () => {
    const f = await setup(), fetcher = vi.fn(async () => { throw new Error(fake.apiSecret); });
    const result = await executeProtectedOrderRecovery(f.digest, raw(), { paths: f.paths, clock: () => now, fetch: fetcher, wait: async () => {} });
    expect(result.output).toBe(JSON.stringify(failure)); expect(await readdir(f.paths.archiveParent)).toEqual([]);
  });
});

describe('additional protected boundaries', () => {

  it.each(['mexc', 'okx'] as const)('public %s credential closure cannot send keys to the opposite venue', async venue => {
    const opposite = venue === 'mexc' ? 'okx' : 'mexc', f = await setup(opposite), fetcher = mockedFetch(opposite);
    const credentials = parseOrderRecoveryInput(raw(venue));
    await expect(credentials.capture({ journalDirectory: f.paths.journal, expectedCheckpoint: f.snapshot.checkpoint,
      orderIntentId: intentId, archiveDirectory: join(f.paths.archiveParent, requestId), clock: () => now, wait: async () => {},
      context: createOrderRecoverySessionContext(), fetch: fetcher })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled(); expect(await readdir(f.paths.archiveParent)).toEqual([]);
  });
  it('clones cooldown input before awaiting and cannot serialize added private fields', async () => {
    const f = await setup(), next: any = { schema: 1, mexc: now + 60_000, okx: 0 };
    const operation = persistProtectedRecoveryCooldowns(f.paths.observerState, next);
    next.mexc = 0; next.privateSecret = fake.apiSecret; await operation;
    const text = await readFile(join(f.paths.observerState, 'cooldowns.json'), 'utf8');
    expect(JSON.parse(text)).toEqual({ schema: 1, mexc: now + 60_000, okx: 0 }); expect(text).not.toContain(fake.apiSecret);
  });
  it('rejects duplicate or escaped cooldown keys and unsupported number syntax', async () => {
    const f = await setup(), path = join(f.paths.observerState, 'cooldowns.json');
    for (const text of [
      '{"schema":1,"mexc":9999999999999,"mexc":0,"okx":0}',
      '{"schema":1,"\\u006dexc":0,"okx":0}',
      '{"schema":1,"mexc":1e3,"okx":0}',
    ]) {
      await writeFile(path, text); await expect(readProtectedRecoveryCooldowns(f.paths.observerState)).rejects.toThrow('recovery-preflight-failed');
    }
    await writeFile(path, ' { "okx" : 0, "schema" : 1, "mexc": 0 } \n');
    expect(await readProtectedRecoveryCooldowns(f.paths.observerState)).toEqual({ schema: 1, mexc: 0, okx: 0 });
  });
  it('rejects requests outside the bounded seven-day dispatched-intent retention', async () => {
    const f = await setup(), late = now + 7 * 86400_000;
    const digest = await writeRequest(f.paths.request, { ...f.request, createdAt: late, expiresAt: late + 60_000 });
    await expect(preflightProtectedOrderRecovery(digest, { paths: f.paths, now: late })).rejects.toThrow('recovery-preflight-failed');
  });

});

describe('bounded credential input and fixed protected CLI', () => {
  it('accepts one complete input frame and rejects empty/oversized frames', async () => {
    expect(await readOrderRecoveryStdin(Readable.from([raw()]))).toEqual(raw());
    await expect(readOrderRecoveryStdin(Readable.from([]))).rejects.toThrow('recovery-runtime-failed');
    await expect(readOrderRecoveryStdin(Readable.from([Buffer.alloc(40 * 1024 + 1)]))).rejects.toThrow('recovery-runtime-failed');
  });
  it('ends a stalled input and masks stream errors', async () => {
    const stream = new PassThrough(); const reading = readOrderRecoveryStdin(stream, { bytes: 1024, timeoutMs: 10 });
    stream.write('partial'); await expect(reading).rejects.toThrow('recovery-runtime-failed'); stream.destroy();
    const errorStream = new PassThrough(), second = readOrderRecoveryStdin(errorStream); errorStream.destroy(new Error(fake.apiSecret));
    await expect(second).rejects.toThrow('recovery-runtime-failed');
  });
  it.each([[], ['--request-digest', 'x'.repeat(64)], ['--request-digest', 'a'.repeat(64), '--live'], ['--preflight', '--request-digest', 'a'.repeat(64)]].map(args => ({ args })))('refuses unsupported CLI arguments $args without network or secret reads', async ({ args }) => {
    const guard = "import fs from 'node:fs';import net from 'node:net';import tls from 'node:tls';import {syncBuiltinESMExports} from 'node:module';const no=()=>{fs.writeSync(2,'OUTBOUND_ATTEMPT');throw Error('OUTBOUND_ATTEMPT');};globalThis.fetch=no;net.connect=no;net.createConnection=no;tls.connect=no;syncBuiltinESMExports();process.argv=[process.execPath,'protected-order-recovery.ts',...JSON.parse(process.argv[1])];await import('./src/scripts/protected-order-recovery.ts');";
    const result = await new Promise<{ failed: boolean; stdout: string; stderr: string }>(resolve => execFile(process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', guard, JSON.stringify(args)], { cwd: process.cwd(), timeout: 5000, env: { ...process.env, TRADING_MODE: 'live', LIVE_TRADING_LOCKED: 'false' } },
      (error, stdout, stderr) => resolve({ failed: error !== null, stdout, stderr })));
    expect(result.failed).toBe(true); expect(JSON.parse(result.stdout)).toEqual(failure); expect(result.stderr).toBe('');
  });
});
