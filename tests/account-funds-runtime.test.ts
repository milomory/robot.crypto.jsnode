import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeAccountFunds, executeAccountFundsEnrollment, preflightAccountFunds, preflightAccountFundsEnrollment, FUNDS_FAILURE } from '../src/accounts/account-funds-runtime.js';
const now = Date.UTC(2026, 8, 30, 10);
const mexcUid = 'mexc-private-account-funds-test-uuid', okxUid = '98765432101010101';
const base = { schema: 1, environment: 'mainnet', region: 'global' };
const mexc = { ...base, venue: 'mexc', apiKey: 'MEXC_TEST_FUNDS_KEY_84928', apiSecret: 'MEXC_TEST_FUNDS_SECRET_453984' };
const okx = { ...base, venue: 'okx', apiKey: 'OKX_TEST_FUNDS_KEY_453888', apiSecret: 'OKX_TEST_FUNDS_SECRET_92193', passphrase: 'OKX_TEST_FUNDS_PHRASE_38291' };
const frame = () => ({ schema: 1, mexc: { ...mexc }, okx: { ...okx } });
const raw = () => Buffer.from(JSON.stringify(frame()));
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function setup(enroll = true) {
  const root = await mkdtemp(join(tmpdir(), 'funds-runtime-test-')); roots.push(root);
  const paths = { archive: join(root, 'archive'), observer: join(root, 'observer'), binding: join(root, 'binding'), manifest: join(root, 'release', 'manifest.json') };
  for (const dir of [paths.archive, paths.observer, paths.binding, join(root, 'release')]) await mkdir(dir, { mode: 0o700 });
  await writeFile(paths.manifest, '{"artifact":"synthetic-only"}', { mode: 0o600 });
  const sourceHash = createHash('sha256').update(await readFile(paths.manifest)).digest('hex');
  const identities = { mexc: { venue: 'mexc', uid: mexcUid, mainUid: null, accountType: null, mainAccountConfirmed: false,
    mainAccountEvidence: 'not-reported', source: '/api/v3/uid', requestedAt: now - 2000, receivedAt: now - 1500 },
  okx: { venue: 'okx', uid: okxUid, mainUid: okxUid, accountType: '0', mainAccountConfirmed: true,
    mainAccountEvidence: 'uid-mainUid-and-account-type', source: '/api/v5/account/config', requestedAt: now - 1500, receivedAt: now - 1000 } };
  const selection = { schema: 1, kind: 'explicit-account-selection', selection: { kind: 'explicit-accepted-observation',
    receipt: { schema: 1, kind: 'account-identity-observation-receipt', archiveId: 'b223a553-8322-44d5-9a31-70b4b20fbba0', archiveHash: 'a'.repeat(64) }, selectedAt: now - 900 },
  sourceHash, bundleVersion: 'f5df060f-6e8f-4051-9179-3137049478c0', identities };
  await writeFile(join(paths.binding, 'selection.json'), JSON.stringify(selection) + '\n', { mode: 0o600 });
  await writeFile(join(paths.binding, 'binding-key'), randomBytes(32), { mode: 0o600 });
  await writeFile(join(paths.observer, 'cooldowns.json'), '{"schema":1,"mexc":0,"okx":0}', { mode: 0o600 });
  const network = vi.fn<typeof fetch>(async () => { throw new Error('ENROLLMENT_MUST_NOT_USE_NETWORK'); });
  if (enroll) expect(await executeAccountFundsEnrollment(raw(), { paths, clock: () => now, fetch: network })).toMatchObject({ success: true });
  expect(network).not.toHaveBeenCalled();
  return { root, paths, selection };
}
function response(target: string | URL | Request) {
  const path = new URL(String(target)).pathname;
  if (path === '/api/v3/uid') return { uid: mexcUid };
  if (path === '/api/v5/account/config') return { code: '0', data: [{ uid: okxUid, mainUid: okxUid, type: '0', acctLv: '1', autoLoan: false, enableSpotBorrow: false, spotBorrowAutoRepay: false }] };
  if (path === '/api/v3/account') return { accountType: 'SPOT', canTrade: true, updateTime: null, balances: [
    { asset: 'USDT', free: '123.456789', locked: '2', available: '17.1' }, { asset: 'BTC', free: '0.00005', locked: '0', available: '0.00005' }] };
  if (path === '/api/v5/account/balance') return { code: '0', data: [{ uTime: String(now), details: [
    { ccy: 'USDT', cashBal: '31.412323', availBal: '29.1', frozenBal: '2.312323', liab: '', crossLiab: '', isoLiab: '', interest: '0', borrowFroz: '', uTime: String(now) }] }] };
  throw new Error('UNEXPECTED_ROUTE');
}
const fetcher = () => vi.fn<typeof fetch>(async target => Response.json(response(target)));
async function captures(path: string) { return (await readdir(path)).filter(n => n.startsWith('funds-')); }
function failed(value: Awaited<ReturnType<typeof executeAccountFunds>>) { expect(value).toMatchObject({ success: false, output: JSON.stringify(FUNDS_FAILURE) }); }

describe('explicit protected enrollment', () => {
  it('publishes a private pin from the selected old observation without any API read and never replaces it', async () => {
    const f = await setup(false), network = fetcher();
    expect(await preflightAccountFundsEnrollment(f.paths, now)).toMatchObject({ preflightPassed: true, requestCount: 0 });
    const result = await executeAccountFundsEnrollment(raw(), { paths: f.paths, clock: () => now, fetch: network });
    expect(result.success).toBe(true); expect(network).not.toHaveBeenCalled();
    expect(JSON.parse(result.output!)).toEqual({ schema: 1, mode: 'account-binding-enrollment', pinWritten: true, selectionBound: true, identityEnrolled: false, executable: false, requestCount: 0 });
    const path = join(f.paths.binding, 'pin.json'), before = await readFile(path);
    expect((await lstat(path)).mode & 0o777).toBe(0o600); expect((await lstat(path)).nlink).toBe(1);
    expect(JSON.parse(before.toString())).toMatchObject({ identities: f.selection.identities, admissionAllowed: false, fundsVerified: false, mexcMainStatus: 'user-declared-unverified' });
    failed(await executeAccountFundsEnrollment(raw(), { paths: f.paths, clock: () => now }));
    expect(await readFile(path)).toEqual(before);
    await expect(preflightAccountFundsEnrollment(f.paths, now)).rejects.toThrow();
    expect(await captures(f.paths.archive)).toEqual([]);
  });
  it('requires a previously selected observation and never manufactures a selection from credentials or a GET', async () => {
    const f = await setup(false), network = fetcher(); await rm(join(f.paths.binding, 'selection.json'));
    failed(await executeAccountFundsEnrollment(raw(), { paths: f.paths, clock: () => now, fetch: network }));
    expect(network).not.toHaveBeenCalled(); expect(await readdir(f.paths.binding)).toEqual(['binding-key']);
  });
  it('does not bind a different release or a selection from the future', async () => {
    const f = await setup(false), path = join(f.paths.binding, 'selection.json');
    f.selection.sourceHash = 'b'.repeat(64); await writeFile(path, JSON.stringify(f.selection) + '\n');
    failed(await executeAccountFundsEnrollment(raw(), { paths: f.paths, clock: () => now }));
    f.selection.sourceHash = createHash('sha256').update(await readFile(f.paths.manifest)).digest('hex'); f.selection.selection.selectedAt = now + 1;
    await writeFile(path, JSON.stringify(f.selection) + '\n'); failed(await executeAccountFundsEnrollment(raw(), { paths: f.paths, clock: () => now }));
  });
});

describe('account-bound funds capture', () => {
  it('captures four exact sequential GETs, exact private amounts and no UID/amount/key in stdout', async () => {
    const f = await setup(), network = fetcher(), before = await readFile(join(f.paths.binding, 'pin.json'));
    expect(await preflightAccountFunds(f.paths, now)).toMatchObject({ preflightPassed: true, requestCount: 0 });
    const result = await executeAccountFunds(raw(), { paths: f.paths, fetch: network, clock: () => now });
    expect(result.success).toBe(true); expect(network.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/api/v3/uid','/api/v3/account','/api/v5/account/config','/api/v5/account/balance']);
    const output = JSON.parse(result.output!);
    expect(output).toMatchObject({ mode: 'account-funds-readonly', identityEnrolled: true, fundsBound: true, fundsAdmission: false, executable: false, requestCount: 4 });
    for (const [, init] of network.mock.calls) expect(init).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit' });
    const files = await captures(f.paths.archive); expect(files).toEqual(['funds-' + output.receipt.archiveId + '.json']);
    const path = join(f.paths.archive, files[0]), bytes = await readFile(path), archive = JSON.parse(bytes.toString());
    expect(output.receipt.archiveHash).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(archive).toMatchObject({ identityEnrolled: true, fundsBound: true, fundsAdmission: false, executable: false,
      mexc: { identity: { uid: mexcUid }, funds: { balances: [{ currency: 'USDT', free: '123.456789', locked: '2', available: '17.1' }, { currency: 'BTC' }] } },
      okx: { identity: { uid: okxUid }, funds: { balances: [{ currency: 'USDT', availBal: '29.1', liab: null, unavailableFields: { liab: 'empty' } }] } } });
    expect((await lstat(path)).mode & 0o777).toBe(0o600); expect((await lstat(path)).nlink).toBe(1);
    for (const hidden of [mexcUid, okxUid, '123.456789', '31.412323', '17.1', ...[mexc.apiKey,mexc.apiSecret,okx.apiKey,okx.apiSecret,okx.passphrase]]) expect(result.output).not.toContain(hidden);
    for (const secret of [mexc.apiKey,mexc.apiSecret,okx.apiKey,okx.apiSecret,okx.passphrase]) expect(bytes.toString()).not.toContain(secret);
    expect(await readFile(join(f.paths.binding, 'pin.json'))).toEqual(before);
    expect(await readdir(f.paths.observer)).toEqual(['cooldowns.json']);
  });
  it('cannot auto-enroll if the pin is missing', async () => {
    const f = await setup(false), network = fetcher();
    failed(await executeAccountFunds(raw(), { paths: f.paths, fetch: network, clock: () => now })); expect(network).not.toHaveBeenCalled();
    expect((await readdir(f.paths.binding)).sort()).toEqual(['binding-key','selection.json']);
  });
  it.each(['mexc-key','mexc-secret','okx-key','okx-secret','okx-passphrase'])('rejects credential rotation %s before any GET', async field => {
    const f = await setup(), network = fetcher(), changed = frame();
    if (field === 'mexc-key') changed.mexc.apiKey += '-ROTATED';
    if (field === 'mexc-secret') changed.mexc.apiSecret += '-ROTATED';
    if (field === 'okx-key') changed.okx.apiKey += '-ROTATED';
    if (field === 'okx-secret') changed.okx.apiSecret += '-ROTATED';
    if (field === 'okx-passphrase') changed.okx.passphrase += '-ROTATED';
    failed(await executeAccountFunds(Buffer.from(JSON.stringify(changed)), { paths: f.paths, fetch: network, clock: () => now }));
    expect(network).not.toHaveBeenCalled(); expect(await captures(f.paths.archive)).toEqual([]);
  });
  it.each(['mexc','okx'])('blocks a different %s account before its funds GET', async venue => {
    const f = await setup(), network = vi.fn<typeof fetch>(async target => {
      const path = new URL(String(target)).pathname;
      if (venue === 'mexc' && path === '/api/v3/uid') return Response.json({ uid: 'unexpected-account' });
      if (venue === 'okx' && path === '/api/v5/account/config') return Response.json({ code: '0', data: [{ uid: '999123', mainUid: '999123', type: '0' }] });
      return Response.json(response(target));
    });
    failed(await executeAccountFunds(raw(), { paths: f.paths, fetch: network, clock: () => now }));
    expect(network).toHaveBeenCalledTimes(venue === 'mexc' ? 1 : 3); expect(await captures(f.paths.archive)).toEqual([]);
  });
  it('snapshots mutable inputs/options before first await', async () => {
    const f = await setup(), other = await setup(), bytes = raw(), paths = { ...f.paths }, network = fetcher();
    const options = { paths, fetch: network, clock: () => now };
    const pending = executeAccountFunds(bytes, options); bytes.fill(0); paths.binding = other.paths.binding; options.fetch = vi.fn();
    expect((await pending).success).toBe(true); expect(network).toHaveBeenCalledTimes(4);
  });
  it('rejects a concurrent pin/selection/key change without publishing funds evidence', async () => {
    for (const file of ['pin.json','selection.json','binding-key']) {
      const f = await setup(); const network = vi.fn<typeof fetch>(async target => {
        if (new URL(String(target)).pathname === '/api/v5/account/balance') await writeFile(join(f.paths.binding, file), 'changed');
        return Response.json(response(target));
      });
      failed(await executeAccountFunds(raw(), { paths: f.paths, fetch: network, clock: () => now })); expect(await captures(f.paths.archive)).toEqual([]);
    }
  });
});

describe('private files, freshness and durable backoff', () => {
  it.each(['archive','binding','observer'] as const)('rejects unprivate or symlinked %s paths before network', async field => {
    const f = await setup(), network = fetcher(); await chmod(f.paths[field], 0o755);
    failed(await executeAccountFunds(raw(), { paths: f.paths, fetch: network, clock: () => now }));
    await chmod(f.paths[field], 0o700); const alias = join(f.root, 'alias'); await symlink(f.paths[field], alias);
    failed(await executeAccountFunds(raw(), { paths: { ...f.paths, [field]: alias }, fetch: network, clock: () => now }));
    expect(network).not.toHaveBeenCalled();
  });
  it.each(['pin.json','selection.json','binding-key'])('requires private regular single-link %s', async name => {
    const f = await setup(), network = fetcher(), path = join(f.paths.binding, name);
    await chmod(path, 0o644); failed(await executeAccountFunds(raw(), { paths: f.paths, fetch: network, clock: () => now }));
    await chmod(path, 0o600); await link(path, join(f.root, 'other'));
    failed(await executeAccountFunds(raw(), { paths: f.paths, fetch: network, clock: () => now })); expect(network).not.toHaveBeenCalled();
  });
  it('rejects duplicate JSON keys even if their last value matches the valid selection', async () => {
    const f = await setup(), network = fetcher(), path = join(f.paths.binding,'selection.json');
    const content = await readFile(path,'utf8'); await writeFile(path, content.replace('{','{"schema":999,'));
    failed(await executeAccountFunds(raw(), { paths: f.paths, fetch: network, clock: () => now })); expect(network).not.toHaveBeenCalled();
  });
  it('rejects a changed accepted receipt even when UID stays identical', async () => {
    const f = await setup(), network = fetcher(); f.selection.selection.receipt.archiveHash = 'c'.repeat(64);
    await writeFile(join(f.paths.binding,'selection.json'), JSON.stringify(f.selection)+'\n');
    failed(await executeAccountFunds(raw(), { paths: f.paths, fetch: network, clock: () => now })); expect(network).not.toHaveBeenCalled();
  });
  it('rejects wrong binding key, pin integrity and expanded paths/options', async () => {
    const f = await setup(), network = fetcher();
    failed(await executeAccountFunds(raw(), { paths: { ...f.paths, other: '/extra' }, fetch: network, clock: () => now } as never));
    failed(await executeAccountFunds(raw(), { paths: f.paths, fetch: network, clock: () => now, allow: true } as never));
    const pinPath = join(f.paths.binding,'pin.json'), pin = JSON.parse(await readFile(pinPath,'utf8')); pin.credentialFingerprint = 'c'.repeat(64); await writeFile(pinPath,JSON.stringify(pin)+'\n');
    failed(await executeAccountFunds(raw(), { paths: f.paths, fetch: network, clock: () => now })); expect(network).not.toHaveBeenCalled();
  });
  it.each(['regression','deadline'])('stops after first GET on %s', async kind => {
    const f = await setup(); let time = now;
    const network = vi.fn<typeof fetch>(async target => { time = kind === 'regression' ? now - 1 : now + 30_001; return Response.json(response(target)); });
    failed(await executeAccountFunds(raw(), { paths: f.paths, fetch: network, clock: () => time })); expect(network).toHaveBeenCalledTimes(1); expect(await captures(f.paths.archive)).toEqual([]);
  });
  it.each([418,429])('persists HTTP %s cooldown and refuses a second capture without any network', async status => {
    const f = await setup(), network = vi.fn<typeof fetch>(async () => new Response('', { status, headers: { 'retry-after':'123' } }));
    failed(await executeAccountFunds(raw(), { paths: f.paths, fetch: network, clock: () => now })); expect(network).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(join(f.paths.observer,'cooldowns.json'),'utf8')).mexc).toBe(now+123_000);
    network.mockClear(); failed(await executeAccountFunds(raw(), { paths: f.paths, fetch: network, clock: () => now })); expect(network).not.toHaveBeenCalled();
  });
  it('persists body-level OKX rate limits, keeps the pin and publishes no partial pair', async () => {
    const f = await setup(), before = await readFile(join(f.paths.binding,'pin.json'));
    const network = vi.fn<typeof fetch>(async target => String(target).includes('okx.com') ? Response.json({ code:'50011',data:[],msg:'PRIVATE_UPSTREAM_TEXT' }) : Response.json(response(target)));
    const result = await executeAccountFunds(raw(), { paths: f.paths, fetch: network, clock: () => now }); failed(result);
    expect(network).toHaveBeenCalledTimes(3); expect(JSON.parse(await readFile(join(f.paths.observer,'cooldowns.json'),'utf8')).okx).toBe(now+60_000);
    expect(await captures(f.paths.archive)).toEqual([]); expect(await readFile(join(f.paths.binding,'pin.json'))).toEqual(before); expect(JSON.stringify(result)).not.toContain('PRIVATE_UPSTREAM_TEXT');
  });
  it('refuses a missing cooldown and a full archive without resetting either', async () => {
    const f = await setup(), network = fetcher();
    for(let i=0;i<20;i++) await writeFile(join(f.paths.archive,`funds-${i}.json`),'private',{mode:0o600});
    failed(await executeAccountFunds(raw(),{paths:f.paths,fetch:network,clock:()=>now}));
    await rm(join(f.paths.observer,'cooldowns.json')); failed(await executeAccountFunds(raw(),{paths:f.paths,fetch:network,clock:()=>now}));
    expect(network).not.toHaveBeenCalled(); expect(await captures(f.paths.archive)).toHaveLength(20);
  });
});
