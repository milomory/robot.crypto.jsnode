import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { appendLiveOrderJournal, createLiveOrderJournal, readLiveOrderJournal } from '../src/live/order-journal.js';
import { canonicalLiveOrderJson as canonical, deriveLiveClientOrderId } from '../src/live/order-lifecycle.js';
import { captureLiveOrderRecoverySession, readLiveOrderRecoveryArchive, ORDER_RECOVERY_SESSION_LIMITS,
  createOrderRecoverySessionContext, snapshotOrderRecoverySessionCooldowns,
  type LiveOrderRecoverySessionInput } from '../src/live/order-recovery-session.js';

const intentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const now = Date.parse('2026-09-28T12:00:10.000Z');
const fakeCredentials = { apiKey: 'SESSION_FAKE_ACCESS_KEY_123', apiSecret: 'SESSION_FAKE_SECRET_456', passphrase: 'SESSION_FAKE_PASSPHRASE_789' };
const roots: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function setup(venue: 'mexc' | 'okx' = 'mexc') {
  const root = await mkdtemp(join(tmpdir(), 'order-recovery-session-')); roots.push(root);
  const directory = join(root, 'journal'), parent = join(root, 'captures'), archive = join(parent, 'capture-1');
  await mkdir(parent, { mode: 0o700 });
  let snapshot = await createLiveOrderJournal(directory);
  snapshot = await appendLiveOrderJournal(directory, { eventId: '10000000-0000-4000-8000-000000000001', at: new Date(now - 9000).toISOString(),
    type: 'intent-created', intent: { orderIntentId: intentId, venue, account: 'main', symbol: 'BTC/USDT', side: 'buy',
      orderType: 'limit', baseQuantity: '0.001', limitPrice: '100000', maxQuoteAmount: '100', feeCaps: { BTC: '0', USDT: '0.1', MX: '0' } } }, snapshot.checkpoint);
  snapshot = await appendLiveOrderJournal(directory, { eventId: '10000000-0000-4000-8000-000000000002', at: new Date(now - 8000).toISOString(),
    type: 'dispatch-marked', orderIntentId: intentId, clientOrderId: deriveLiveClientOrderId(venue, intentId) }, snapshot.checkpoint);
  const input = { journalDirectory: directory, expectedCheckpoint: snapshot.checkpoint, orderIntentId: intentId,
    archiveDirectory: archive, credentials: { ...fakeCredentials }, clock: () => now, wait: async () => {}, context: createOrderRecoverySessionContext() };
  return { root, parent, directory, archive, snapshot, input };
}
function source(venue: 'mexc' | 'okx' = 'mexc') {
  const client = deriveLiveClientOrderId(venue, intentId);
  if (venue === 'mexc') return {
    order: { symbol: 'BTCUSDT', orderId: 'remote-order-1', clientOrderId: client, price: '100000', Qty: '0.001',
      executedQty: '0.0004', cumulativeQuoteQty: '40', status: 'CANCELED', type: 'LIMIT', side: 'BUY', time: now - 8000, updateTime: now - 5000 },
    fills: [{ symbol: 'BTCUSDT', id: 'remote-fill-1', orderId: 'remote-order-1', price: '100000', qty: '0.0004', quoteQty: '40',
      commission: '0.04', commissionAsset: 'USDT', time: now - 7500, isBuyer: true }],
  };
  return {
    order: { instType: 'SPOT', instId: 'BTC-USDT', ordId: 'remote-order-1', clOrdId: client, tdMode: 'cash', category: 'normal',
      side: 'buy', ordType: 'limit', state: 'canceled', sz: '0.001', px: '100000', accFillSz: '0.0004', avgPx: '100000',
      fee: '-0.04', feeCcy: 'USDT', rebate: '0', rebateCcy: 'USDT', cTime: now - 8000, uTime: now - 5000 },
    fills: [{ instType: 'SPOT', instId: 'BTC-USDT', ordId: 'remote-order-1', clOrdId: client, tradeId: 'remote-fill-1', billId: '17',
      side: 'buy', subType: '1', execType: 'T', fillSz: '0.0004', fillPx: '100000', fee: '-0.04', feeCcy: 'USDT', fillTime: now - 7500, ts: now - 7499 }],
  };
}
function mockedFetch(venue: 'mexc' | 'okx' = 'mexc', rows: ReturnType<typeof source> = source(venue)) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(init?.method).toBe('GET'); expect(init?.redirect).toBe('error'); expect(init?.credentials).toBe('omit');
    expect(url.origin).toBe(venue === 'mexc' ? 'https://api.mexc.com' : 'https://www.okx.com');
    const fills = url.pathname.endsWith('/myTrades') || url.pathname.endsWith('/fills-history');
    const data = fills ? rows.fills : rows.order;
    return new Response(JSON.stringify(venue === 'mexc' ? data : { code: '0', data: fills ? data : [data], msg: '' }), { status: 200 });
  });
}
function withFetch(input: Omit<LiveOrderRecoverySessionInput, 'fetch'>, fetcher = mockedFetch()) {
  return { ...input, fetch: fetcher as typeof fetch };
}
async function capture(venue: 'mexc' | 'okx' = 'mexc') {
  const paths = await setup(venue), fetcher = mockedFetch(venue);
  const result = await captureLiveOrderRecoverySession(withFetch(paths.input, fetcher));
  return { ...paths, fetcher, result };
}
const faultSource = [
  "import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';",
  "const [mode,inputPath]=process.argv.slice(1);const config=JSON.parse(await fs.readFile(inputPath,'utf8'));",
  "const originalOpen=fs.open;let written=false;const pause=async()=>{setInterval(()=>{},1000);process.send({boundary:mode});await new Promise(()=>{});};",
  "fs.open=async(...args)=>{const file=await originalOpen(...args),write=file.writeFile.bind(file),sync=file.sync.bind(file);file.writeFile=async(value,...rest)=>{if(String(args[0]).endsWith('/capture.json')&&mode==='during-write'){await write(String(value).slice(0,20));await pause();}const result=await write(value,...rest);if(String(args[0]).endsWith('/capture.json'))written=true;return result;};file.sync=async()=>{if(mode==='file-sync-error'&&String(args[0]).endsWith('/capture.json'))throw Error('PRIVATE_IO_DETAIL');if(mode==='directory-sync-error'&&written&&String(args[0])===config.input.archiveDirectory)throw Error('PRIVATE_IO_DETAIL');const result=await sync();if(mode==='after-file-sync'&&String(args[0]).endsWith('/capture.json'))await pause();return result;};return file;};syncBuiltinESMExports();",
  "const api=await import('./src/live/order-recovery-session.ts');",
  "try{const result=await api.captureLiveOrderRecoverySession({...config.input,context:api.createOrderRecoverySessionContext(),clock:()=>config.now,wait:async()=>{},fetch:async(url)=>new Response(JSON.stringify(String(url).includes('/myTrades')?config.source.fills:config.source.order),{status:200})});console.log(JSON.stringify(result));}catch(error){console.log(JSON.stringify({error:error.code??'fixed-failure'}));}",
].join('\n');
async function faultChild(mode: string, paths: Awaited<ReturnType<typeof setup>>) {
  const inputPath = join(paths.root, 'fault-input.json');
  await writeFile(inputPath, JSON.stringify({ input: paths.input, now, source: source() }), { mode: 0o600 });
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', faultSource, mode, inputPath],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = '', error = '', killed = false;
  child.stdout!.on('data', value => { output += value; }); child.stderr!.on('data', value => { error += value; });
  child.on('message', message => { if ((message as { boundary?: string }).boundary === mode) { killed = true; child.kill('SIGKILL'); } });
  return new Promise<{ output: string; error: string; killed: boolean; signal: string | null }>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('child-timeout')); }, 10_000);
    child.once('error', cause => { clearTimeout(timer); reject(cause); });
    child.once('close', (_code, signal) => { clearTimeout(timer); resolve({ output, error, killed, signal }); });
  });
}
const cliSource = `
import fs from 'node:fs';import net from 'node:net';import tls from 'node:tls';import http from 'node:http';import https from 'node:https';
import {syncBuiltinESMExports} from 'node:module';
const blocked=()=>{fs.writeSync(2,'OUTBOUND_ATTEMPT');throw Error('OUTBOUND_ATTEMPT');};
globalThis.fetch=blocked;net.connect=blocked;net.createConnection=blocked;tls.connect=blocked;http.request=blocked;http.get=blocked;https.request=blocked;https.get=blocked;syncBuiltinESMExports();
Date.now=()=>${now};process.argv=[process.execPath,'src/scripts/order-recovery.ts',...JSON.parse(process.env.SESSION_TEST_ARGS)];
await import('./src/scripts/order-recovery.ts');`;
async function cli(args: string[]) {
  return new Promise<{ failed: boolean; output: string; error: string }>(resolve => {
    execFile(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', cliSource],
      { cwd: process.cwd(), timeout: 10_000, maxBuffer: 128 * 1024,
        env: { ...process.env, SESSION_TEST_ARGS: JSON.stringify(args), TRADING_MODE: 'live', LIVE_TRADING_LOCKED: 'false' } },
      (error, output, stderr) => resolve({ failed: error !== null, output, error: stderr }));
  });
}

describe('protected recovery composition and durable capture archive', () => {
  it.each(['mexc', 'okx'] as const)('captures exactly three scoped %s GETs into a private archive without importing', async venue => {
    const paths = await capture(venue);
    expect(paths.fetcher).toHaveBeenCalledTimes(3);
    expect(paths.result).toMatchObject({ nonExecutable: true, captureProvenanceVerified: false,
      accountIdentityVerified: false, importPerformed: false, requestCount: 3, headMatchedBeforePublication: true });
    expect(JSON.stringify(paths.result)).not.toMatch(/remote-order|remote-fill|CRM|CRO|aaaaaaaa|SESSION_FAKE/);
    expect((await stat(paths.archive)).mode & 0o777).toBe(0o700);
    expect((await stat(join(paths.archive, 'capture.json'))).mode & 0o777).toBe(0o600);
    expect(await readdir(paths.archive)).toEqual(['capture.json']);
    const archived = await readLiveOrderRecoveryArchive(paths.archive, paths.result.receipt);
    expect(archived.baseCheckpoint).toEqual(paths.snapshot.checkpoint);
    expect(archived.venue).toBe(venue); expect(archived.orderIntentId).toBe(intentId);
    expect(Object.isFrozen(archived.capture.orderBefore.data)).toBe(true);
    expect((await readLiveOrderJournal(paths.directory)).checkpoint).toEqual(paths.snapshot.checkpoint);
    const text = await readFile(join(paths.archive, 'capture.json'), 'utf8');
    for (const value of Object.values(fakeCredentials)) expect(text).not.toContain(value);
    expect(text).not.toMatch(/signature|OK-ACCESS|X-MEXC|Authorization|cookie/i);
  });

  it('rejects a stale checkpoint before GET and does not fall back to the latest head', async () => {
    const paths = await setup(), fetcher = mockedFetch();
    await appendLiveOrderJournal(paths.directory, { eventId: '10000000-0000-4000-8000-000000000003', at: new Date(now - 7000).toISOString(),
      type: 'dispatch-uncertain', orderIntentId: intentId, reason: 'timeout' }, paths.snapshot.checkpoint);
    await expect(captureLiveOrderRecoverySession(withFetch(paths.input, fetcher))).rejects.toThrow('recovery-session-head-conflict');
    expect(fetcher).not.toHaveBeenCalled(); await expect(lstat(paths.archive)).rejects.toThrow();
  });

  it('rejects a journal advance during capture before creating any archive', async () => {
    const paths = await setup(), plain = mockedFetch(); let reads = 0;
    const fetcher = vi.fn(async (...args: Parameters<typeof fetch>) => {
      if (++reads === 3) await appendLiveOrderJournal(paths.directory, { eventId: '10000000-0000-4000-8000-000000000003',
        at: new Date(now - 1000).toISOString(), type: 'dispatch-uncertain', orderIntentId: intentId, reason: 'process-recovery' }, paths.snapshot.checkpoint);
      return plain(...args);
    });
    await expect(captureLiveOrderRecoverySession(withFetch(paths.input, fetcher))).rejects.toThrow('recovery-session-head-conflict');
    expect(fetcher).toHaveBeenCalledTimes(3); await expect(lstat(paths.archive)).rejects.toThrow();
    expect((await readLiveOrderJournal(paths.directory)).revision).toBe(3);
  });

  it('clones credentials and checkpoint before awaiting and guards using the original secrets', async () => {
    const paths = await setup(), rows = source('mexc');
    Object.assign(rows.order, { orderId: fakeCredentials.apiSecret });
    Object.assign(rows.fills[0], { orderId: fakeCredentials.apiSecret });
    const fetcher = mockedFetch('mexc', rows), input = withFetch(paths.input, fetcher);
    const result = captureLiveOrderRecoverySession(input);
    input.credentials.apiKey = 'MUTATED_ACCESS_KEY'; input.credentials.apiSecret = 'MUTATED_SECRET';
    input.expectedCheckpoint.headHash = '0'.repeat(64);
    await expect(result).rejects.toThrow('recovery-session-secret-contamination');
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect((fetcher.mock.calls[0][1]?.headers as Record<string, string>)['X-MEXC-APIKEY']).toBe(fakeCredentials.apiKey);
    await expect(lstat(paths.archive)).rejects.toThrow();
  });

  it('blocks credential substrings in valid projected fields before any archive write', async () => {
    const paths = await setup(), rows = source('mexc');
    Object.assign(rows.fills[0], { id: 'prefix_' + fakeCredentials.apiKey + '_suffix' });
    const result = captureLiveOrderRecoverySession(withFetch(paths.input, mockedFetch('mexc', rows)));
    await expect(result).rejects.toThrow('recovery-session-secret-contamination');
    expect(await readdir(paths.parent)).toEqual([]);
    expect((await readLiveOrderJournal(paths.directory)).revision).toBe(2);
  });

  it('fails conservatively for common credential text instead of truncating or exposing it', async () => {
    const paths = await setup(); paths.input.credentials.passphrase = 'capture';
    await expect(captureLiveOrderRecoverySession(withFetch(paths.input))).rejects.toThrow('recovery-session-secret-contamination');
    expect(await readdir(paths.parent)).toEqual([]);
  });

  it('strips unknown upstream secret-shaped fields without copying them into the original projected capture', async () => {
    const paths = await setup(), rows = source('mexc');
    Object.assign(rows.order, { privateToken: fakeCredentials.apiSecret, Authorization: 'SECRET_HTTP_HEADER_CANARY' });
    const result = await captureLiveOrderRecoverySession(withFetch(paths.input, mockedFetch('mexc', rows)));
    const archived = await readLiveOrderRecoveryArchive(paths.archive, result.receipt);
    expect(canonical(archived)).not.toMatch(/PRIVATE|Authorization|SECRET_HTTP_HEADER_CANARY|SESSION_FAKE/);
  });

  it.each(['venue', 'url', 'credentialFile', 'readerFactory'])('rejects unexpected %s input before network access', async name => {
    const paths = await setup(), fetcher = mockedFetch();
    const input = { ...withFetch(paths.input, fetcher), [name]: 'PRIVATE_ROUTING_CANARY' } as LiveOrderRecoverySessionInput;
    await expect(captureLiveOrderRecoverySession(input)).rejects.toThrow('recovery-session-invalid-input');
    expect(fetcher).not.toHaveBeenCalled(); expect(await readdir(paths.parent)).toEqual([]);
  });

  it('rejects unsafe archive parents and symlink parents before reading an account', async () => {
    const paths = await setup(), fetcher = mockedFetch();
    await chmod(paths.parent, 0o755);
    await expect(captureLiveOrderRecoverySession(withFetch(paths.input, fetcher))).rejects.toThrow('recovery-archive-invalid');
    await chmod(paths.parent, 0o700);
    const alias = join(paths.root, 'alias'); await symlink(paths.parent, alias);
    await expect(captureLiveOrderRecoverySession({ ...withFetch(paths.input, fetcher), archiveDirectory: join(alias, 'capture') }))
      .rejects.toThrow('recovery-archive-invalid');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('never creates archive entries inside the journal and preserves preexisting destinations', async () => {
    const paths = await setup(), fetcher = mockedFetch();
    await expect(captureLiveOrderRecoverySession({ ...withFetch(paths.input, fetcher), archiveDirectory: join(paths.directory, 'archive') }))
      .rejects.toThrow('recovery-session-invalid-input');
    await mkdir(paths.archive, { mode: 0o700 }); await writeFile(join(paths.archive, 'owner-work'), 'PRESERVE', { mode: 0o600 });
    await expect(captureLiveOrderRecoverySession(withFetch(paths.input, fetcher))).rejects.toThrow('recovery-archive-exists');
    expect(await readFile(join(paths.archive, 'owner-work'), 'utf8')).toBe('PRESERVE');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('allows one in-process capture for a journal and does not queue another signed sequence', async () => {
    const paths = await setup(), fetcher = mockedFetch();
    const first = captureLiveOrderRecoverySession(withFetch(paths.input, fetcher));
    await expect(captureLiveOrderRecoverySession({ ...withFetch(paths.input, fetcher), archiveDirectory: join(paths.parent, 'second') }))
      .rejects.toThrow('recovery-session-busy');
    await first; expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([429, 418, 200])('returns a fixed persistent-cooldown signal for HTTP/API rate limiting (%s)', async status => {
    const paths = await setup(), fetcher = vi.fn(async () => new Response(JSON.stringify({ code: 429, msg: 'PRIVATE_UPSTREAM_CANARY' }), { status }));
    await expect(captureLiveOrderRecoverySession(withFetch(paths.input, fetcher))).rejects.toThrow('recovery-session-rate-limited');
    expect(fetcher).toHaveBeenCalledTimes(1); expect(await readdir(paths.parent)).toEqual([]);
  });

  it('retains long Retry-After across new sessions and persists only immutable cooldown metadata', async () => {
    const paths = await setup(), persist = vi.fn(async (_value: Readonly<{ schema: 1; mexc: number; okx: number }>) => {});
    const context = createOrderRecoverySessionContext({ schema: 1, mexc: 0, okx: 0 }, { persist });
    const fetcher = vi.fn(async () => new Response('', { status: 429, headers: { 'retry-after': '3600' } }));
    const input = { ...withFetch(paths.input, fetcher), context };
    await expect(captureLiveOrderRecoverySession(input)).rejects.toThrow('recovery-session-rate-limited');
    await expect(captureLiveOrderRecoverySession({ ...input, clock: () => now + 300_000 })).rejects.toThrow('recovery-session-rate-limited');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(snapshotOrderRecoverySessionCooldowns(context)).toEqual({ schema: 1, mexc: now + 3_600_000, okx: 0 });
    expect(persist).toHaveBeenCalledTimes(1); expect(Object.isFrozen(persist.mock.calls[0][0])).toBe(true);
    expect(JSON.stringify(persist.mock.calls)).not.toMatch(/SESSION_FAKE|remote-order/);
    const restored = createOrderRecoverySessionContext(snapshotOrderRecoverySessionCooldowns(context));
    await expect(captureLiveOrderRecoverySession({ ...input, context: restored, clock: () => now + 300_000 })).rejects.toThrow('recovery-session-rate-limited');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('retains HTTP-200 API cooldown without another request from a fresh reader', async () => {
    const paths = await setup(), persist = vi.fn(async () => {});
    const context = createOrderRecoverySessionContext({ schema: 1, mexc: 0, okx: 0 }, { persist });
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ code: 429 }), { status: 200 }));
    const input = { ...withFetch(paths.input, fetcher), context };
    await expect(captureLiveOrderRecoverySession(input)).rejects.toThrow('recovery-session-rate-limited');
    await expect(captureLiveOrderRecoverySession(input)).rejects.toThrow('recovery-session-rate-limited');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(snapshotOrderRecoverySessionCooldowns(context).mexc).toBe(now + 60_000);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('latches a failed cooldown save closed without retrying even after its time window', async () => {
    const paths = await setup(), context = createOrderRecoverySessionContext({ schema: 1, mexc: 0, okx: 0 },
      { persist: async () => { throw Error('PRIVATE_PERSIST_CANARY'); } });
    const fetcher = vi.fn(async () => new Response('', { status: 429 }));
    const input = { ...withFetch(paths.input, fetcher), context };
    await expect(captureLiveOrderRecoverySession(input)).rejects.toThrow('recovery-session-cooldown-unavailable');
    await expect(captureLiveOrderRecoverySession({ ...input, clock: () => now + 120_000 })).rejects.toThrow('recovery-session-cooldown-unavailable');
    expect(fetcher).toHaveBeenCalledTimes(1); expect(await readdir(paths.parent)).toEqual([]);
  });

  it.each([1, 3])('stops another journal after shared persistence fails during GET %s', async pauseAt => {
    const paths = await setup('okx'), limiter = await setup('mexc');
    const context = createOrderRecoverySessionContext({ schema: 1, mexc: 0, okx: 0 },
      { persist: async () => { throw Error('PRIVATE_PERSIST_CANARY'); } });
    let signal!: () => void, release!: () => void, calls = 0;
    const reached = new Promise<void>(resolve => { signal = resolve; });
    const paused = new Promise<void>(resolve => { release = resolve; });
    const successful = mockedFetch('okx');
    const fetcher = vi.fn(async (...args: Parameters<typeof fetch>) => {
      if (++calls === pauseAt) { signal(); await paused; }
      return successful(...args);
    });
    const running = captureLiveOrderRecoverySession({ ...withFetch(paths.input, fetcher), context });
    const outcome = expect(running).rejects.toThrow('recovery-session-cooldown-unavailable');
    await reached;
    await expect(captureLiveOrderRecoverySession({ ...withFetch(limiter.input,
      vi.fn(async () => new Response('', { status: 429 }))), context })).rejects.toThrow('recovery-session-cooldown-unavailable');
    release(); await outcome;
    expect(fetcher).toHaveBeenCalledTimes(pauseAt);
    expect(await readdir(paths.parent)).toEqual([]); expect(await readdir(limiter.parent)).toEqual([]);
  });

  it('redacts upstream/network errors and stops without retry or archive', async () => {
    const paths = await setup(), fetcher = vi.fn(async () => { throw new Error('PRIVATE_NETWORK_CANARY ' + fakeCredentials.apiSecret); });
    await expect(captureLiveOrderRecoverySession(withFetch(paths.input, fetcher))).rejects.toThrow('recovery-session-capture-failed');
    expect(fetcher).toHaveBeenCalledTimes(1); expect(await readdir(paths.parent)).toEqual([]);
  });

  it('rejects corrupted, noncanonical and wrong-receipt archives without touching the journal', async () => {
    const paths = await capture(), file = join(paths.archive, 'capture.json'), original = await readFile(file, 'utf8');
    await expect(readLiveOrderRecoveryArchive(paths.archive, { ...paths.result.receipt, archiveHash: '0'.repeat(64) })).rejects.toThrow('recovery-archive-invalid');
    for (const content of ['{"schema":', original.replace('remote-order-1', 'remote-order-2'), ' ' + original]) {
      await writeFile(file, content); await expect(readLiveOrderRecoveryArchive(paths.archive)).rejects.toThrow('recovery-archive-invalid');
    }
    await writeFile(file, original);
    const altered = JSON.parse(original); altered.capture.orderBefore.query.signature = 'PRIVATE_QUERY_CANARY';
    altered.captureDigest = createHash('sha256').update(canonical(altered.capture)).digest('hex');
    const { archiveHash: _hash, ...body } = altered; altered.archiveHash = createHash('sha256').update(canonical(body)).digest('hex');
    await writeFile(file, canonical(altered) + '\n');
    await expect(readLiveOrderRecoveryArchive(paths.archive)).rejects.toThrow('recovery-archive-invalid');
    expect((await readLiveOrderJournal(paths.directory)).checkpoint).toEqual(paths.snapshot.checkpoint);
  });

  it('rejects unsafe archive files, directory modes, hardlinks and symlinks', async () => {
    const paths = await capture(), file = join(paths.archive, 'capture.json');
    await chmod(paths.archive, 0o755); await expect(readLiveOrderRecoveryArchive(paths.archive)).rejects.toThrow('recovery-archive-invalid'); await chmod(paths.archive, 0o700);
    await chmod(file, 0o644); await expect(readLiveOrderRecoveryArchive(paths.archive)).rejects.toThrow('recovery-archive-invalid'); await chmod(file, 0o600);
    const outside = join(paths.root, 'outside'); await link(file, outside);
    await expect(readLiveOrderRecoveryArchive(paths.archive)).rejects.toThrow('recovery-archive-invalid'); await rm(outside);
    const saved = await readFile(file); await rm(file); await writeFile(outside, saved, { mode: 0o600 }); await symlink(outside, file);
    await expect(readLiveOrderRecoveryArchive(paths.archive)).rejects.toThrow('recovery-archive-invalid');
  });

  it('rejects oversized and additional archive files before admitting evidence', async () => {
    const paths = await capture(), file = join(paths.archive, 'capture.json');
    await writeFile(join(paths.archive, 'extra.json'), '{}', { mode: 0o600 });
    await expect(readLiveOrderRecoveryArchive(paths.archive)).rejects.toThrow('recovery-archive-invalid');
    await rm(join(paths.archive, 'extra.json'));
    await writeFile(file, Buffer.alloc(ORDER_RECOVERY_SESSION_LIMITS.archiveBytes + 1));
    await expect(readLiveOrderRecoveryArchive(paths.archive)).rejects.toThrow('recovery-archive-limit');
  });

  it.each(['during-write', 'after-file-sync'])('retains evidence after actual SIGKILL at %s and never imports', async mode => {
    const paths = await setup(), result = await faultChild(mode, paths);
    expect(result.error).toBe(''); expect(result.killed).toBe(true); expect(result.signal).toBe('SIGKILL');
    expect((await stat(paths.archive)).mode & 0o777).toBe(0o700);
    if (mode === 'during-write') await expect(readLiveOrderRecoveryArchive(paths.archive)).rejects.toThrow('recovery-archive-invalid');
    else expect((await readLiveOrderRecoveryArchive(paths.archive)).baseCheckpoint).toEqual(paths.snapshot.checkpoint);
    expect((await readLiveOrderJournal(paths.directory)).checkpoint).toEqual(paths.snapshot.checkpoint);
    await expect(captureLiveOrderRecoverySession(withFetch(paths.input))).rejects.toThrow('recovery-archive-exists');
  }, 15_000);

  it.each(['file-sync-error', 'directory-sync-error'])('returns fixed error at %s and preserves recoverable bytes', async mode => {
    const paths = await setup(), result = await faultChild(mode, paths);
    expect(result.error).toBe(''); expect(result.output).not.toContain('PRIVATE_IO_DETAIL');
    expect(JSON.parse(result.output).error).toBe(mode === 'file-sync-error' ? 'recovery-archive-write-failed' : 'recovery-archive-publish-uncertain');
    expect((await readLiveOrderRecoveryArchive(paths.archive)).baseCheckpoint).toEqual(paths.snapshot.checkpoint);
    expect((await readLiveOrderJournal(paths.directory)).checkpoint).toEqual(paths.snapshot.checkpoint);
  }, 15_000);

  it('inspects a private capture archive in a fresh CLI process with every network entrypoint trapped', async () => {
    const paths = await capture(), receipt = join(paths.root, 'receipt.json');
    await writeFile(receipt, canonical(paths.result.receipt), { mode: 0o600 });
    const result = await cli(['inspect-archive', paths.archive, paths.directory, join(paths.root, 'report'), receipt]);
    expect(result.failed).toBe(false); expect(result.error).toBe('');
    expect(JSON.parse(result.output)).toMatchObject({ executable: false, captureProvenanceVerified: false, accountIdentityVerified: false,
      reportWritten: true, blockers: [] });
    expect(result.output).not.toMatch(/SESSION_FAKE|remote-order|remote-fill|OUTBOUND_ATTEMPT/);
    expect((await readLiveOrderJournal(paths.directory)).checkpoint).toEqual(paths.snapshot.checkpoint);
  }, 15_000);

  it('imports only when the separate offline archive command is explicitly invoked, then deduplicates repeat', async () => {
    const paths = await capture(), receipt = join(paths.root, 'receipt.json');
    await writeFile(receipt, canonical(paths.result.receipt), { mode: 0o600 });
    const first = await cli(['import-archive', paths.archive, paths.directory, receipt]);
    expect(first.failed).toBe(false); expect(first.error).toBe('');
    expect(JSON.parse(first.output)).toMatchObject({ executable: false, captureProvenanceVerified: false, accountIdentityVerified: false,
      appended: 3, alreadyApplied: 0, blockers: [] });
    const repeated = await cli(['import-archive', paths.archive, paths.directory, receipt]);
    expect(repeated.failed).toBe(false); expect(repeated.error).toBe('');
    expect(JSON.parse(repeated.output)).toMatchObject({ appended: 0, alreadyApplied: 3 });
    const recovered = await readLiveOrderJournal(paths.directory);
    expect(recovered.state.orders[0].cashDelta).toEqual({ BTC: '0.0004', USDT: '-40.04', MX: '0' });
    expect(recovered.state.orders[0].fills).toHaveLength(1);
  }, 15_000);
});
