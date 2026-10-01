import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash, createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { AccountError } from '../src/accounts/types.js';
import { executeAccountIdentity, IDENTITY_FAILURE, identityDiagnostic, preflightAccountIdentity, readIdentityStdin, writeIdentityDiagnostic, type IdentityDiagnostic } from '../src/accounts/account-identity-runtime.js';

const now = Date.UTC(2026, 8, 29, 12);
const mexcUid = '12888888888888888888888888881', okxUid = '12999999999999999999999999992';
const base = { schema: 1, environment: 'mainnet', region: 'global' };
const mexc = { ...base, venue: 'mexc', apiKey: 'MEXC_PRIVATE_TEST_KEY_912', apiSecret: 'MEXC_PRIVATE_TEST_SECRET_913' };
const okx = { ...base, venue: 'okx', apiKey: 'OKX_PRIVATE_TEST_KEY_914', apiSecret: 'OKX_PRIVATE_TEST_SECRET_915', passphrase: 'OKX_PRIVATE_TEST_PASSPHRASE_916' };
const input = () => ({ schema: 1, mexc: { ...mexc }, okx: { ...okx } });
const raw = () => Buffer.from(JSON.stringify(input()));
const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'identity-runtime-test-')); roots.push(root);
  const paths = { archive: join(root, 'archive'), observer: join(root, 'observer') };
  await mkdir(paths.archive, { mode: 0o700 }); await mkdir(paths.observer, { mode: 0o700 });
  await writeFile(join(paths.observer, 'cooldowns.json'), JSON.stringify({ schema: 1, mexc: 0, okx: 0 }), { mode: 0o600 });
  return { root, paths };
}
function success(target: string | URL | Request, uid = okxUid, mainUid = okxUid, type = '0') {
  return Response.json(new URL(String(target)).origin === 'https://api.mexc.com' ?
    { uid: mexcUid, privateLabel: 'UPSTREAM_PRIVATE_LABEL' } :
    { code: '0', data: [{ uid, mainUid, type, privateLabel: 'UPSTREAM_PRIVATE_LABEL', apiKey: 'UPSTREAM_PRIVATE_KEY' }] });
}
const fetcher = () => vi.fn<typeof fetch>(async target => success(target));
async function archiveNames(path: string) { return (await readdir(path)).filter(name => name.startsWith('identity-')); }
async function expectFailure(result: Awaited<ReturnType<typeof executeAccountIdentity>>) {
  expect(result).toMatchObject({ success: false, output: JSON.stringify(IDENTITY_FAILURE) });
  if (!result.success) expect(result.diagnostic === null || Object.keys(result.diagnostic).sort().join(',') === 'reason,stage').toBe(true);
}

 describe('protected pair identity observation', () => {
  it('reads exactly UID/config with separate credentials and preserves IDs only in a private hashed archive', async () => {
    const f = await setup(), network = fetcher();
    const result = await executeAccountIdentity(raw(), { paths: f.paths, fetch: network, clock: () => now });
    expect(result.success).toBe(true); expect(network).toHaveBeenCalledTimes(2);
    const [mexcTarget, mexcInit] = network.mock.calls[0], [okxTarget, okxInit] = network.mock.calls[1];
    const mexcUrl = new URL(String(mexcTarget));
    expect(mexcUrl.origin + mexcUrl.pathname).toBe('https://api.mexc.com/api/v3/uid');
    expect([...mexcUrl.searchParams.keys()]).toEqual(['timestamp', 'signature']);
    expect(mexcUrl.searchParams.get('signature')).toBe(createHmac('sha256', mexc.apiSecret).update(`timestamp=${now}`).digest('hex'));
    expect(new Headers(mexcInit!.headers).get('X-MEXC-APIKEY')).toBe(mexc.apiKey);
    expect(new Headers(mexcInit!.headers).has('OK-ACCESS-KEY')).toBe(false);
    expect(String(okxTarget)).toBe('https://www.okx.com/api/v5/account/config');
    expect(new Headers(okxInit!.headers).get('OK-ACCESS-KEY')).toBe(okx.apiKey);
    expect(new Headers(okxInit!.headers).get('OK-ACCESS-PASSPHRASE')).toBe(okx.passphrase);
    expect(new Headers(okxInit!.headers).has('X-MEXC-APIKEY')).toBe(false);
    for (const [, init] of network.mock.calls) expect(init).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store' });
    const report = JSON.parse(result.output!);
    expect(report).toMatchObject({ schema: 1, mode: 'account-identity-readonly', reportWritten: true, executable: false, identityEnrolled: false, requestCount: 2,
      mexc: { observed: true, mainAccountConfirmed: false }, okx: { observed: true, mainAccountConfirmed: true } });
    expect(result.output).not.toContain(mexcUid); expect(result.output).not.toContain(okxUid);
    const names = await archiveNames(f.paths.archive); expect(names).toEqual(['identity-' + report.receipt.archiveId + '.json']);
    const path = join(f.paths.archive, names[0]), bytes = await readFile(path), archive = JSON.parse(bytes.toString());
    expect(report.receipt.archiveHash).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(archive).toMatchObject({ kind: 'account-identity-observation', startedAt: now, endedAt: now, identityEnrolled: false, fundsBound: false,
      executable: false, requestCount: 2, mexc: { uid: mexcUid, mainUid: null }, okx: { uid: okxUid, mainUid: okxUid } });
    expect((await lstat(path)).mode & 0o777).toBe(0o600); expect((await lstat(path)).nlink).toBe(1);
    expect(bytes.toString()).not.toContain('UPSTREAM_PRIVATE');
    for (const secret of [mexc.apiKey, mexc.apiSecret, okx.apiKey, okx.apiSecret, okx.passphrase]) {
      expect(result.output).not.toContain(secret); expect(bytes.toString()).not.toContain(secret);
    }
    expect(await readdir(f.paths.observer)).toEqual(['cooldowns.json']);
  });
  it('keeps an opaque MEXC identity exact in the private archive and absent from stdout', async () => {
    const f = await setup(), opaqueUid = '5c85987e-fef9-4b82-b9cd-bbb9a67599a9';
    const network = vi.fn<typeof fetch>(async target => String(target).includes('api.mexc.com') ? Response.json({ uid: opaqueUid }) : success(target));
    const result = await executeAccountIdentity(raw(), { paths: f.paths, fetch: network, clock: () => now });
    expect(result.success).toBe(true); expect(network).toHaveBeenCalledTimes(2);
    expect(result.output).not.toContain(opaqueUid);
    const files = await archiveNames(f.paths.archive); expect(files).toHaveLength(1);
    const archive = JSON.parse(await readFile(join(f.paths.archive, files[0]), 'utf8'));
    expect(archive).toMatchObject({ identityEnrolled: false, fundsBound: false, executable: false,
      mexc: { uid: opaqueUid, mainUid: null, mainAccountConfirmed: false } });
    expect((await lstat(join(f.paths.archive, files[0]))).mode & 0o777).toBe(0o600);
  });
  it('observes an OKX subaccount without approving it or inventing main status', async () => {
    const f = await setup(), network = vi.fn<typeof fetch>(async target => success(target, okxUid, '123456789', '1'));
    const result = await executeAccountIdentity(raw(), { paths: f.paths, fetch: network, clock: () => now });
    expect(result.success).toBe(true); expect(JSON.parse(result.output!)).toMatchObject({ identityEnrolled: false, executable: false, okx: { mainAccountConfirmed: false } });
  });
  it('does not turn a changed UID on the next observation into enrollment or overwrite the first archive', async () => {
    const f = await setup(), first = await executeAccountIdentity(raw(), { paths: f.paths, fetch: fetcher(), clock: () => now });
    const second = await executeAccountIdentity(raw(), { paths: f.paths, fetch: async target => success(target, '321', '321'), clock: () => now + 1 });
    expect(first.success && second.success).toBe(true); expect(await archiveNames(f.paths.archive)).toHaveLength(2);
    expect(JSON.parse(second.output!)).toMatchObject({ identityEnrolled: false, executable: false });
  });
  it('snapshots input bytes, paths and fetch before awaiting I/O', async () => {
    const f = await setup(), other = await setup(), bytes = raw(), paths = { ...f.paths };
    const changedFetch = vi.fn<typeof fetch>(async () => { throw new Error('UNEXPECTED_CHANGED_FETCH'); });
    const options: Parameters<typeof executeAccountIdentity>[1] = { paths, clock: () => now };
    const network = vi.fn<typeof fetch>(async target => {
      if (network.mock.calls.length === 1) { bytes.fill(0); paths.archive = other.paths.archive; paths.observer = other.paths.observer; options!.fetch = changedFetch; }
      return success(target);
    });
    options!.fetch = network;
    const result = await executeAccountIdentity(bytes, options);
    expect(result.success).toBe(true); expect(network).toHaveBeenCalledTimes(2); expect(changedFetch).not.toHaveBeenCalled();
    expect(await archiveNames(f.paths.archive)).toHaveLength(1); expect(await archiveNames(other.paths.archive)).toHaveLength(0);
  });
});

describe('private preflight and bounded inputs', () => {
  it('performs no network or archive write during preflight', async () => {
    const f = await setup(), network = fetcher(); vi.stubGlobal('fetch', network);
    expect(await preflightAccountIdentity(f.paths, now)).toEqual({ schema: 1, mexc: 0, okx: 0 });
    expect(network).not.toHaveBeenCalled(); expect(await readdir(f.paths.archive)).toEqual([]);
  });
  it('rejects expanded runtime options and paths before either GET', async () => {
    const f = await setup(), network = fetcher();
    const options = { paths: f.paths, fetch: network, clock: () => now, enroll: true };
    await expectFailure(await executeAccountIdentity(raw(), options));
    const paths = { ...f.paths, credentials: '/private/file' };
    await expectFailure(await executeAccountIdentity(raw(), { paths, fetch: network, clock: () => now }));
    expect(network).not.toHaveBeenCalled(); expect(await readdir(f.paths.archive)).toEqual([]);
  });
  it.each([NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER])('rejects invalid starting clock %s before network', async value => {
    const f = await setup(), network = fetcher();
    await expectFailure(await executeAccountIdentity(raw(), { paths: f.paths, fetch: network, clock: () => value })); expect(network).not.toHaveBeenCalled();
  });
  it.each(['archive', 'observer'] as const)('rejects nonprivate %s directory and symlink aliases', async field => {
    const f = await setup(), network = fetcher(); await chmod(f.paths[field], 0o755);
    await expectFailure(await executeAccountIdentity(raw(), { paths: f.paths, fetch: network, clock: () => now }));
    await chmod(f.paths[field], 0o700); const alias = join(f.root, 'alias'); await symlink(f.paths[field], alias);
    await expectFailure(await executeAccountIdentity(raw(), { paths: { ...f.paths, [field]: alias }, fetch: network, clock: () => now }));
    expect(network).not.toHaveBeenCalled();
  });
  it('rejects shared archive/observer or noncanonical relative path', async () => {
    const f = await setup();
    for (const paths of [{ archive: f.paths.observer, observer: f.paths.observer }, { ...f.paths, archive: './archive' },
      { ...f.paths, archive: f.paths.archive + '/.' }]) await expect(preflightAccountIdentity(paths, now)).rejects.toThrow();
  });
  it('rejects missing, readable, symlinked and multiply linked cooldown state', async () => {
    const f = await setup(), path = join(f.paths.observer, 'cooldowns.json'), network = fetcher();
    const run = async () => expectFailure(await executeAccountIdentity(raw(), { paths: f.paths, fetch: network, clock: () => now }));
    await chmod(path, 0o644); await run(); await chmod(path, 0o600);
    const twin = join(f.root, 'twin'); await link(path, twin); await run(); await rm(twin);
    const saved = await readFile(path); await rm(path); await run(); await writeFile(twin, saved, { mode: 0o600 }); await symlink(twin, path); await run();
    expect(network).not.toHaveBeenCalled();
  });
  it.each([
    '{"schema":1,"mexc":0,"mexc":0}', '{"schema":1,"mexc":0,"okx":NaN}', '{"schema":1,"mexc":1e3,"okx":0}',
    '{"schema":1,"mexc":-1,"okx":0}', '{"schema":true,"mexc":0,"okx":0}', '{"schema":1,"mexc":0,"okx":0,"extra":0}',
    '{"schema":1,"mexc":0,"okx":8640000000000001}', '{"schema":1,"mexc":0,"okx":0', ' '.repeat(4097),
  ])('rejects malformed cooldown bytes: case %#', async content => {
    const f = await setup(), network = fetcher(); await writeFile(join(f.paths.observer, 'cooldowns.json'), content);
    await expectFailure(await executeAccountIdentity(raw(), { paths: f.paths, fetch: network, clock: () => now })); expect(network).not.toHaveBeenCalled();
  });
  it.each(['mexc', 'okx'] as const)('honors existing %s backoff before either GET', async venue => {
    const f = await setup(), network = fetcher(); await writeFile(join(f.paths.observer, 'cooldowns.json'), JSON.stringify({ schema: 1, mexc: 0, okx: 0, [venue]: now + 1 }));
    await expectFailure(await executeAccountIdentity(raw(), { paths: f.paths, fetch: network, clock: () => now })); expect(network).not.toHaveBeenCalled();
  });
  it('stops at the archive retention bound without deleting existing evidence', async () => {
    const f = await setup(), network = fetcher();
    for (let i = 0; i < 20; i++) await writeFile(join(f.paths.archive, `identity-${i}.json`), 'private evidence', { mode: 0o600 });
    await expectFailure(await executeAccountIdentity(raw(), { paths: f.paths, fetch: network, clock: () => now }));
    expect(network).not.toHaveBeenCalled(); expect(await archiveNames(f.paths.archive)).toHaveLength(20);
  });
  it.each([
    () => '', () => ' '.repeat(40 * 1024 + 1), () => '{', () => JSON.stringify({ ...input(), path: '/arbitrary' }),
    () => JSON.stringify({ ...input(), schema: '1' }), () => JSON.stringify({ schema: 1, mexc: okx, okx: mexc }),
    () => JSON.stringify({ ...input(), mexc: { ...mexc, environment: 'testnet' } }),
    () => JSON.stringify({ ...input(), okx: { ...okx, region: 'eu' } }),
    () => JSON.stringify({ ...input(), okx: { ...okx, passphrase: undefined } }),
    () => JSON.stringify({ ...input(), mexc: { ...mexc, keyFile: '/credential' } }),
  ])('rejects malformed or expanded credential input: case %#', async make => {
    const f = await setup(), network = fetcher(); await expectFailure(await executeAccountIdentity(Buffer.from(make()), { paths: f.paths, fetch: network, clock: () => now }));
    expect(network).not.toHaveBeenCalled(); expect(await archiveNames(f.paths.archive)).toHaveLength(0);
  });
});

describe('capture timing, errors and durable cooldown', () => {
  it.each(['mexc', 'okx'] as const)('persists full Retry-After on %s and never publishes a partial pair', async venue => {
    const f = await setup(); const network = vi.fn<typeof fetch>(async target => new URL(String(target)).origin.includes(venue) ?
      new Response('UPSTREAM_PRIVATE_TEXT', { status: 429, headers: { 'Retry-After': '120' } }) : success(target));
    await expectFailure(await executeAccountIdentity(raw(), { paths: f.paths, fetch: network, clock: () => now }));
    expect(network).toHaveBeenCalledTimes(venue === 'mexc' ? 1 : 2);
    expect(JSON.parse(await readFile(join(f.paths.observer, 'cooldowns.json'), 'utf8'))).toEqual({ schema: 1, mexc: 0, okx: 0, [venue]: now + 120_000 });
    expect(await archiveNames(f.paths.archive)).toHaveLength(0);
    await expectFailure(await executeAccountIdentity(raw(), { paths: f.paths, fetch: network, clock: () => now + 119_999 }));
    expect(network).toHaveBeenCalledTimes(venue === 'mexc' ? 1 : 2);
  });
  it.each([['mexc', 418], ['mexc', 429], ['okx', '50011'], ['okx', '50013'], ['okx', '50040']] as const)
    ('persists API-body rate limit for %s/%s', async (venue, code) => {
      const f = await setup(), network = vi.fn<typeof fetch>(async target => new URL(String(target)).origin.includes(venue) ? Response.json({ code, data: [], msg: 'PRIVATE' }) : success(target));
      await expectFailure(await executeAccountIdentity(raw(), { paths: f.paths, fetch: network, clock: () => now }));
      expect(JSON.parse(await readFile(join(f.paths.observer, 'cooldowns.json'), 'utf8'))[venue]).toBe(now + 60_000);
      expect(await archiveNames(f.paths.archive)).toHaveLength(0);
    });
  it('refuses a second GET and archive when cooldown persistence fails', async () => {
    const f = await setup(), network = vi.fn<typeof fetch>(async () => {
      await rm(join(f.paths.observer, 'cooldowns.json')); return new Response('PRIVATE', { status: 429, headers: { 'Retry-After': '120' } });
    });
    await expectFailure(await executeAccountIdentity(raw(), { paths: f.paths, fetch: network, clock: () => now }));
    expect(network).toHaveBeenCalledTimes(1); expect(await readdir(f.paths.archive)).toEqual([]);
  });
  it('preserves a newer persisted cooldown instead of overwriting another observer update', async () => {
    const f = await setup(), path = join(f.paths.observer, 'cooldowns.json');
    const concurrent = { schema: 1, mexc: now + 300_000, okx: now + 600_000 };
    const network = vi.fn<typeof fetch>(async () => {
      await writeFile(path, JSON.stringify(concurrent));
      return new Response('PRIVATE', { status: 429, headers: { 'Retry-After': '120' } });
    });
    await expectFailure(await executeAccountIdentity(raw(), { paths: f.paths, fetch: network, clock: () => now }));
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(concurrent);
    expect(network).toHaveBeenCalledTimes(1); expect(await readdir(f.paths.archive)).toEqual([]);
    expect(await readdir(f.paths.observer)).toEqual(['cooldowns.json']);
    await expectFailure(await executeAccountIdentity(raw(), { paths: f.paths, fetch: network, clock: () => now + 1 }));
    expect(network).toHaveBeenCalledTimes(1);
  });
  it('refuses publication when the archive directory becomes readable during collection', async () => {
    const f = await setup(), network = vi.fn<typeof fetch>(async target => {
      if (new URL(String(target)).origin === 'https://www.okx.com') await chmod(f.paths.archive, 0o755);
      return success(target);
    });
    await expectFailure(await executeAccountIdentity(raw(), { paths: f.paths, fetch: network, clock: () => now }));
    expect(network).toHaveBeenCalledTimes(2); expect(await readdir(f.paths.archive)).toEqual([]);
  });
  it('keeps a late 429 backoff even when the observation deadline has elapsed', async () => {
    const f = await setup(); let time = now;
    const network = vi.fn<typeof fetch>(async () => { time += 20_000; return new Response('PRIVATE', { status: 429, headers: { 'Retry-After': '120' } }); });
    await expectFailure(await executeAccountIdentity(raw(), { paths: f.paths, fetch: network, clock: () => time }));
    expect(JSON.parse(await readFile(join(f.paths.observer, 'cooldowns.json'), 'utf8')).mexc).toBe(now + 140_000);
    expect(network).toHaveBeenCalledTimes(1); expect(await archiveNames(f.paths.archive)).toHaveLength(0);
  });
  it('stops after the first successful read if the overall time limit expires', async () => {
    const f = await setup(); let time = now;
    const network = vi.fn<typeof fetch>(async target => { time += 20_000; return success(target); });
    await expectFailure(await executeAccountIdentity(raw(), { paths: f.paths, fetch: network, clock: () => time }));
    expect(network).toHaveBeenCalledTimes(1); expect(await archiveNames(f.paths.archive)).toHaveLength(0);
  });
  it('refuses backward clock movement between the two completed identity reads', async () => {
    const f = await setup(); let phase = 0;
    const clock = () => { if (phase === 1) { phase = 2; return now + 100; } return phase === 2 ? now + 50 : now; };
    const network = vi.fn<typeof fetch>(async target => { if (network.mock.calls.length === 1) phase = 1; return success(target); });
    await expectFailure(await executeAccountIdentity(raw(), { paths: f.paths, fetch: network, clock }));
    expect(network).toHaveBeenCalledTimes(1); expect(await archiveNames(f.paths.archive)).toHaveLength(0);
  });
  it.each(['throw', '401', '403', '500', 'invalid-json', 'bad-uid'] as const)('redacts %s failure and never retries or publishes a partial archive', async kind => {
    const f = await setup(), network = vi.fn<typeof fetch>(async () => {
      if (kind === 'throw') throw new Error(mexc.apiSecret + mexcUid);
      if (kind === 'invalid-json') return new Response(mexc.apiSecret);
      if (kind === 'bad-uid') return Response.json({ uid: mexc.apiSecret + '\n' });
      return new Response(mexc.apiSecret + mexcUid, { status: Number(kind) });
    });
    await expectFailure(await executeAccountIdentity(raw(), { paths: f.paths, fetch: network, clock: () => now }));
    expect(network).toHaveBeenCalledTimes(1); expect(await archiveNames(f.paths.archive)).toHaveLength(0);
  });
  it('does not archive an identity containing a credential value and keeps the failure report safe', async () => {
    const f = await setup(), value = input(); value.mexc.apiSecret = mexcUid;
    await expectFailure(await executeAccountIdentity(Buffer.from(JSON.stringify(value)), { paths: f.paths, fetch: fetcher(), clock: () => now }));
    expect(await readdir(f.paths.archive)).toEqual([]);
  });
  it('suppresses even the fixed failure string if that string contains a supplied credential', async () => {
    const f = await setup(), value = input(); value.mexc.apiSecret = 'identity-failed'; await rm(join(f.paths.observer, 'cooldowns.json'));
    expect(await executeAccountIdentity(Buffer.from(JSON.stringify(value)), { paths: f.paths, fetch: fetcher(), clock: () => now })).toMatchObject({ success: false, output: null });
  });
});

describe('bounded private stdin frame', () => {
  it('reads exactly one complete bounded frame and preserves the caller-owned chunks', async () => {
    const bytes = raw(), original = Buffer.from(bytes); const result = await readIdentityStdin(Readable.from([bytes.subarray(0, 7), bytes.subarray(7)]));
    expect(result.equals(original)).toBe(true); expect(bytes.equals(original)).toBe(true);
  });
  it('rejects empty and oversized input', async () => {
    await expect(readIdentityStdin(Readable.from([]))).rejects.toThrow('identity-failed');
    await expect(readIdentityStdin(Readable.from([Buffer.alloc(40 * 1024 + 1)]))).rejects.toThrow('identity-failed');
  });
  it('does not consume or echo a partial frame after timeout', async () => {
    const stream = new PassThrough(), pending = readIdentityStdin(stream, 10); stream.write(mexc.apiSecret);
    await expect(pending).rejects.toThrow('identity-failed'); expect(stream.isPaused()).toBe(true); stream.destroy();
  });
  it('rejects premature stream close and stream error', async () => {
    const closed = new PassThrough(), first = readIdentityStdin(closed); closed.write(mexc.apiKey); closed.destroy();
    await expect(first).rejects.toThrow('identity-failed');
    const broken = new PassThrough(), second = readIdentityStdin(broken); broken.destroy(new Error(okx.apiSecret));
    await expect(second).rejects.toThrow('identity-failed');
  });
  it.each([0, -1, 5001, NaN, 1.5])('rejects invalid timeout %s', async timeout => {
    const stream = new PassThrough(); await expect(readIdentityStdin(stream, timeout)).rejects.toThrow('identity-failed'); stream.destroy();
  });
});

describe('closed private identity diagnostics', () => {
  it('reports only fixed credentials, preflight and archive stages with unchanged failure stdout', async () => {
    const f = await setup(), network = fetcher();
    const credentials = await executeAccountIdentity(Buffer.from('{'), { paths: f.paths, fetch: network, clock: () => now });
    expect(credentials).toEqual({ success: false, output: JSON.stringify(IDENTITY_FAILURE), diagnostic: { stage: 'credentials', reason: 'unavailable' } });
    await rm(join(f.paths.observer, 'cooldowns.json'));
    const preflight = await executeAccountIdentity(raw(), { paths: f.paths, fetch: network, clock: () => now });
    expect(preflight).toEqual({ success: false, output: JSON.stringify(IDENTITY_FAILURE), diagnostic: { stage: 'preflight', reason: 'ENOENT' } });
    expect(network).not.toHaveBeenCalled();
    await writeFile(join(f.paths.observer, 'cooldowns.json'), '{"schema":1,"mexc":0,"okx":0}', { mode: 0o600 });
    const publication = await executeAccountIdentity(raw(), { paths: f.paths, clock: () => now, fetch: async target => {
      if (String(target).includes('okx.com')) await chmod(f.paths.archive, 0o755);
      return success(target);
    } });
    expect(publication).toEqual({ success: false, output: JSON.stringify(IDENTITY_FAILURE), diagnostic: { stage: 'archive', reason: 'unavailable' } });
    expect(await readdir(f.paths.archive)).toEqual([]);
  });
  it.each([
    [{}, 'mexc-uid-missing'], [{ uid: 123456 }, 'mexc-uid-numeric'],
    [{ uid: mexc.apiSecret + '\n' }, 'mexc-uid-invalid-string'], [{ uid: { private: mexc.apiSecret } }, 'mexc-uid-invalid-type'],
  ])('classifies malformed MEXC UID without copying it: case %#', async (body, reason) => {
    const f = await setup(), network = vi.fn<typeof fetch>(async () => Response.json(body));
    const result = await executeAccountIdentity(raw(), { paths: f.paths, fetch: network, clock: () => now });
    expect(result).toEqual({ success: false, output: JSON.stringify(IDENTITY_FAILURE), diagnostic: { stage: 'mexc-read', reason } });
    expect(JSON.stringify(result)).not.toContain(mexc.apiSecret); expect(network).toHaveBeenCalledTimes(1);
    expect(await readdir(f.paths.archive)).toEqual([]);
  });
  it.each([
    [{ wrong: 'PRIVATE_API_TEXT' }, 'okx-invalid-envelope'],
    [{ code: '0', data: [] }, 'okx-invalid-row-count'],
    [{ code: '0', data: [{ uid: 123456, mainUid: okxUid, type: '0' }] }, 'okx-uid-invalid'],
    [{ code: '0', data: [{ uid: okxUid, mainUid: okx.apiSecret, type: '0' }] }, 'okx-mainuid-invalid'],
    [{ code: '0', data: [{ uid: okxUid, mainUid: okxUid, type: 'PRIVATE_API_TYPE' }] }, 'okx-account-type-unknown'],
    [{ code: '0', data: [{ uid: okxUid, mainUid: '4321', type: '0' }] }, 'okx-account-type-conflict'],
  ])('classifies malformed OKX response without copying identifiers or text: case %#', async (body, reason) => {
    const f = await setup(), network = vi.fn<typeof fetch>(async target => String(target).includes('okx.com') ? Response.json(body) : success(target));
    const result = await executeAccountIdentity(raw(), { paths: f.paths, fetch: network, clock: () => now });
    expect(result).toEqual({ success: false, output: JSON.stringify(IDENTITY_FAILURE), diagnostic: { stage: 'okx-read', reason } });
    for (const secret of [okx.apiSecret, okxUid, 'PRIVATE_API_TEXT', 'PRIVATE_API_TYPE']) expect(JSON.stringify(result)).not.toContain(secret);
    expect(network).toHaveBeenCalledTimes(2); expect(await readdir(f.paths.archive)).toEqual([]);
  });
  it.each([
    [new Error('PRIVATE_MESSAGE'), 'unavailable'],
    [new AccountError('PRIVATE_ACCOUNT_CODE'), 'unavailable'],
    [{ code: 'EACCES', message: 'PRIVATE_MESSAGE' }, 'unavailable'],
    [Object.assign(new Error('PRIVATE_MESSAGE'), { code: 'PRIVATE_FS_CODE' }), 'unavailable'],
    [Object.assign(new Error('PRIVATE_MESSAGE'), { code: 'EROFS', path: 'PRIVATE_PATH' }), 'EROFS'],
    [new AccountError('account-auth-failed'), 'account-auth-failed'],
  ])('serializes only allowlisted reason literals: case %#', (error, reason) => {
    expect(identityDiagnostic('preflight', error)).toEqual({ stage: 'preflight', reason });
  });
  it('ignores arbitrary identity detail and wrong-venue detail while retaining the stable AccountError code', () => {
    for (const detail of ['PRIVATE_RESPONSE', 'mexc-uid-numeric']) {
      const error = Object.assign(new AccountError('account-invalid-response'), { identityDiagnosticCode: detail });
      expect(identityDiagnostic('okx-read', error)).toEqual({ stage: 'okx-read', reason: 'account-invalid-response' });
    }
  });
  it('snapshots error code before classifying an accessor rather than rereading private data', () => {
    let reads = 0;
    const error = new AccountError('account-auth-failed');
    Object.defineProperty(error, 'code', { get: () => ++reads === 1 ? 'account-auth-failed' : 'PRIVATE_CODE' });
    expect(identityDiagnostic('mexc-read', error)).toEqual({ stage: 'mexc-read', reason: 'account-auth-failed' });
    expect(reads).toBe(1);
  });
  it('withholds diagnostic metadata that coincides with a credential value', async () => {
    const f = await setup(), value = input(); value.mexc.apiSecret = 'mexc-uid-numeric';
    const result = await executeAccountIdentity(Buffer.from(JSON.stringify(value)), { paths: f.paths, fetch: async () => Response.json({ uid: 12345 }), clock: () => now });
    expect(result).toEqual({ success: false, output: JSON.stringify(IDENTITY_FAILURE), diagnostic: null });
    expect(await readdir(f.paths.archive)).toEqual([]);
  });
  it('publishes a private immutable diagnostic with a hash receipt and without replacing previous evidence', async () => {
    const f = await setup(), diagnostic = identityDiagnostic('okx-read', new AccountError('account-auth-failed'));
    const first = await writeIdentityDiagnostic(diagnostic, f.paths.archive);
    const path = join(f.paths.archive, 'diagnostic-' + first.diagnosticId + '.json');
    const bytes = await readFile(path), info = await lstat(path);
    expect(first.diagnosticHash).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(JSON.parse(bytes.toString())).toEqual({ schema: 1, kind: 'account-identity-diagnostic', diagnosticId: first.diagnosticId, stage: 'okx-read', reason: 'account-auth-failed' });
    expect(info.mode & 0o777).toBe(0o600); expect(info.nlink).toBe(1);
    const second = await writeIdentityDiagnostic(diagnostic, f.paths.archive);
    expect(second.diagnosticId).not.toBe(first.diagnosticId); expect(await readFile(path)).toEqual(bytes);
    expect((await readdir(f.paths.archive)).sort()).toEqual(['diagnostic-' + first.diagnosticId + '.json', 'diagnostic-' + second.diagnosticId + '.json'].sort());
    expect(await archiveNames(f.paths.archive)).toEqual([]);
  });
  it.each([
    { stage: 'PRIVATE_STAGE', reason: 'unavailable' }, { stage: 'mexc-read', reason: 'PRIVATE_REASON' },
    { stage: 'mexc-read', reason: 'unavailable', uid: mexcUid },
    { stage: 'mexc-read', reason: 'unavailable', toJSON: () => ({ private: mexc.apiSecret }) },
  ])('refuses expanded or injected diagnostic data before publication: case %#', async diagnostic => {
    const f = await setup();
    await expect(writeIdentityDiagnostic(diagnostic as IdentityDiagnostic, f.paths.archive)).rejects.toThrow();
    expect(await readdir(f.paths.archive)).toEqual([]);
  });
  it('snapshots diagnostic fields once before awaited I/O', async () => {
    const f = await setup(); let reads = 0;
    const diagnostic = { stage: 'mexc-read', get reason() { return ++reads === 1 ? 'account-api-rejected' : mexc.apiSecret; } } as IdentityDiagnostic;
    const receipt = await writeIdentityDiagnostic(diagnostic, f.paths.archive);
    const saved = await readFile(join(f.paths.archive, 'diagnostic-' + receipt.diagnosticId + '.json'), 'utf8');
    expect(JSON.parse(saved).reason).toBe('account-api-rejected'); expect(saved).not.toContain(mexc.apiSecret); expect(reads).toBe(1);
  });
  it('refuses insecure directories and stops at twenty diagnostics without deleting evidence', async () => {
    const f = await setup(), diagnostic = identityDiagnostic('preflight', new Error());
    await chmod(f.paths.archive, 0o755);
    await expect(writeIdentityDiagnostic(diagnostic, f.paths.archive)).rejects.toThrow();
    await chmod(f.paths.archive, 0o700);
    for (let i = 0; i < 20; i++) await writeFile(join(f.paths.archive, `diagnostic-${i}.json`), 'PREVIOUS_EVIDENCE', { mode: 0o600 });
    await expect(writeIdentityDiagnostic(diagnostic, f.paths.archive)).rejects.toThrow();
    expect(await readdir(f.paths.archive)).toHaveLength(20);
    expect(await readFile(join(f.paths.archive, 'diagnostic-0.json'), 'utf8')).toBe('PREVIOUS_EVIDENCE');
  });
});
