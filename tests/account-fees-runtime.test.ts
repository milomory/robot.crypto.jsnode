import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeAccountFees, preflightAccountFees, FEES_FAILURE } from '../src/accounts/account-fees-runtime.js';
import { createAccountBindingPin, ACCOUNT_BINDING_CONTEXT, ACCOUNT_BINDING_REFERENCES, ACCOUNT_BINDING_POLICY_HASH } from '../src/accounts/account-binding.js';

const now = Date.UTC(2026, 9, 1, 10);
const mexcUid = 'mexc-private-fee-test-account', okxUid = '98765432101010101';
const base = { schema: 1, environment: 'mainnet', region: 'global' };
const mexc = { ...base, venue: 'mexc', apiKey: 'MEXC_FAKE_FEES_KEY_84928', apiSecret: 'MEXC_FAKE_FEES_SECRET_453984' };
const okx = { ...base, venue: 'okx', apiKey: 'OKX_FAKE_FEES_KEY_453888', apiSecret: 'OKX_FAKE_FEES_SECRET_92193', passphrase: 'OKX_FAKE_FEES_PHRASE_38291' };
const frame = () => ({ schema: 1, mexc: { ...mexc }, okx: { ...okx } });
const raw = () => Buffer.from(JSON.stringify(frame()));
const hash = (raw: Buffer | string) => createHash('sha256').update(raw).digest('hex');
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'fees-runtime-test-')); roots.push(root);
  const paths = { archive: join(root, 'archive'), observer: join(root, 'observer'), binding: join(root, 'binding'),
    bindingSource: join(root, 'binding-source', 'manifest.json'), manifest: join(root, 'release', 'manifest.json') };
  for (const dir of [paths.archive, paths.observer, paths.binding, join(root, 'release'), join(root, 'binding-source')]) await mkdir(dir, { mode: 0o700 });
  await writeFile(paths.manifest, '{"collector":"synthetic-fees-only"}', { mode: 0o600 });
  await writeFile(paths.bindingSource, '{"artifact":"synthetic-accepted-funds"}', { mode: 0o600 });
  const sourceHash = hash(await readFile(paths.bindingSource));
  const identities = { mexc: { venue: 'mexc', uid: mexcUid, mainUid: null, accountType: null, mainAccountConfirmed: false,
    mainAccountEvidence: 'not-reported', source: '/api/v3/uid', requestedAt: now - 2000, receivedAt: now - 1500 },
  okx: { venue: 'okx', uid: okxUid, mainUid: okxUid, accountType: '0', mainAccountConfirmed: true,
    mainAccountEvidence: 'uid-mainUid-and-account-type', source: '/api/v5/account/config', requestedAt: now - 1500, receivedAt: now - 1000 } };
  const selection = { schema: 1, kind: 'explicit-account-selection', selection: { kind: 'explicit-accepted-observation',
    receipt: { schema: 1, kind: 'account-identity-observation-receipt', archiveId: 'b223a553-8322-44d5-9a31-70b4b20fbba0', archiveHash: 'a'.repeat(64) }, selectedAt: now - 900 },
  sourceHash, bundleVersion: 'f5df060f-6e8f-4051-9179-3137049478c0', identities };
  const key = randomBytes(32);
  const pin = createAccountBindingPin({ selection: selection.selection, identities, sourceHash, bundleVersion: selection.bundleVersion,
    context: ACCOUNT_BINDING_CONTEXT, references: ACCOUNT_BINDING_REFERENCES, policyHash: ACCOUNT_BINDING_POLICY_HASH, credentials: frame() }, key);
  await writeFile(join(paths.binding, 'selection.json'), JSON.stringify(selection) + '\n', { mode: 0o600 });
  await writeFile(join(paths.binding, 'binding-key'), key, { mode: 0o600 }); key.fill(0);
  await writeFile(join(paths.binding, 'pin.json'), JSON.stringify(pin) + '\n', { mode: 0o600 });
  await writeFile(join(paths.observer, 'cooldowns.json'), '{"schema":1,"mexc":0,"okx":0}', { mode: 0o600 });
  return { root, paths, selection };
}
function response(target: string | URL | Request) {
  const path = new URL(String(target)).pathname;
  if (path === '/api/v3/uid') return { uid: mexcUid };
  if (path === '/api/v5/account/config') return { code: '0', data: [{ uid: okxUid, mainUid: okxUid, type: '0', feeType: '1' }] };
  if (path === '/api/v3/tradeFee') return { code: 0, data: { makerCommission: '0.0000312345', takerCommission: '0.0005612345' }, timestamp: now };
  if (path === '/api/v3/mxDeduct/enable') return { code: 0, data: { mxDeductEnable: false } };
  if (path === '/api/v5/account/trade-fee') return { code: '0', data: [{ instType: 'SPOT', instId: 'BTC-USDT', ts: String(now), feeGroup: [{ groupId: '1', maker: '-0.0007812345', taker: '-0.0010612345' }] }] };
  throw new Error('UNEXPECTED_ROUTE');
}
const fetcher = () => vi.fn<typeof fetch>(async target => Response.json(response(target)));
async function captures(path: string) { return (await readdir(path)).filter(n => n.startsWith('fees-')); }
function failed(value: Awaited<ReturnType<typeof executeAccountFees>>) { expect(value).toMatchObject({ success: false, output: JSON.stringify(FEES_FAILURE) }); }

// These fixtures construct only synthetic previous bindings; the production runtime has no enrollment entrypoint.
describe('account-bound personal fee capture', () => {
  it('captures five exact sequential GETs, keeps both source hashes and never exposes private fields', async () => {
    const f = await setup(), network = fetcher();
    const boundPaths = ['pin.json', 'selection.json', 'binding-key'].map(name => join(f.paths.binding, name)).concat(f.paths.bindingSource);
    const before = await Promise.all(boundPaths.map(path => readFile(path)));
    expect(await preflightAccountFees(f.paths, now)).toEqual({ schema: 1, preflightPassed: true, requestCount: 0 });
    const result = await executeAccountFees(raw(), { paths: f.paths, fetch: network, clock: () => now });
    expect(result.success).toBe(true);
    expect(network.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/api/v3/uid', '/api/v3/tradeFee', '/api/v3/mxDeduct/enable', '/api/v5/account/config', '/api/v5/account/trade-fee']);
    const output = JSON.parse(result.output!);
    expect(output).toMatchObject({ mode: 'account-fees-readonly', identityEnrolled: true, feesBound: true, feeAdmission: false, executable: false, requestCount: 5 });
    for (const [, init] of network.mock.calls) expect(init).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit' });
    expect(new URL(String(network.mock.calls[1][0])).searchParams.get('symbol')).toBe('BTCUSDT');
    expect(new URL(String(network.mock.calls[4][0])).searchParams.get('instId')).toBe('BTC-USDT');
    const files = await captures(f.paths.archive); expect(files).toEqual(['fees-' + output.receipt.archiveId + '.json']);
    const path = join(f.paths.archive, files[0]), bytes = await readFile(path), archive = JSON.parse(bytes.toString());
    expect(output.receipt.archiveHash).toBe(hash(bytes));
    expect(archive).toMatchObject({ identityEnrolled: true, feesBound: true, feeAdmission: false, executable: false,
      bindingSourceHash: f.selection.sourceHash, collectorSourceHash: hash(await readFile(f.paths.manifest)),
      mexc: { identity: { uid: mexcUid }, fees: { makerCostRate: '0.0000312345', takerCostRate: '0.0005612345' }, configuration: { mxDeductEnabled: false } },
      okx: { identity: { uid: okxUid }, fees: { makerCostRate: '0.0007812345', takerCostRate: '0.0010612345' }, configuration: { feeCurrencyMode: 'quote' } } });
    expect(archive.bindingSourceHash).not.toBe(archive.collectorSourceHash);
    expect((await lstat(path)).mode & 0o777).toBe(0o600); expect((await lstat(path)).nlink).toBe(1);
    for (const hidden of [mexcUid, okxUid, '0.0000312345', '0.0005612345', '0.0010612345', ...[mexc.apiKey, mexc.apiSecret, okx.apiKey, okx.apiSecret, okx.passphrase]]) expect(result.output).not.toContain(hidden);
    for (const secret of [mexc.apiKey, mexc.apiSecret, okx.apiKey, okx.apiSecret, okx.passphrase]) expect(bytes.toString()).not.toContain(secret);
    expect(await Promise.all(boundPaths.map(path => readFile(path)))).toEqual(before);
    expect(await readdir(f.paths.observer)).toEqual(['cooldowns.json']);
  });
  it('cannot auto-enroll if the existing pin is missing', async () => {
    const f = await setup(), network = fetcher(); await rm(join(f.paths.binding, 'pin.json'));
    failed(await executeAccountFees(raw(), { paths: f.paths, fetch: network, clock: () => now })); expect(network).not.toHaveBeenCalled();
    expect((await readdir(f.paths.binding)).sort()).toEqual(['binding-key', 'selection.json']);
  });
  it.each(['mexc-key', 'mexc-secret', 'okx-key', 'okx-secret', 'okx-passphrase'])('rejects credential rotation %s before any GET', async field => {
    const f = await setup(), network = fetcher(), changed = frame();
    if (field === 'mexc-key') changed.mexc.apiKey += '-ROTATED';
    if (field === 'mexc-secret') changed.mexc.apiSecret += '-ROTATED';
    if (field === 'okx-key') changed.okx.apiKey += '-ROTATED';
    if (field === 'okx-secret') changed.okx.apiSecret += '-ROTATED';
    if (field === 'okx-passphrase') changed.okx.passphrase += '-ROTATED';
    failed(await executeAccountFees(Buffer.from(JSON.stringify(changed)), { paths: f.paths, fetch: network, clock: () => now }));
    expect(network).not.toHaveBeenCalled(); expect(await captures(f.paths.archive)).toEqual([]);
  });
  it.each(['mexc', 'okx'])('blocks a different %s account before its fees GET', async venue => {
    const f = await setup(), network = vi.fn<typeof fetch>(async target => {
      const path = new URL(String(target)).pathname;
      if (venue === 'mexc' && path === '/api/v3/uid') return Response.json({ uid: 'unexpected-account' });
      if (venue === 'okx' && path === '/api/v5/account/config') return Response.json({ code: '0', data: [{ uid: '999123', mainUid: '999123', type: '0' }] });
      return Response.json(response(target));
    });
    failed(await executeAccountFees(raw(), { paths: f.paths, fetch: network, clock: () => now }));
    expect(network).toHaveBeenCalledTimes(venue === 'mexc' ? 1 : 4); expect(await captures(f.paths.archive)).toEqual([]);
  });
  it('snapshots mutable credentials/options before first await', async () => {
    const f = await setup(), other = await setup(), bytes = raw(), paths = { ...f.paths }, network = fetcher();
    const options = { paths, fetch: network, clock: () => now };
    const pending = executeAccountFees(bytes, options); bytes.fill(0); paths.binding = other.paths.binding; options.fetch = vi.fn();
    expect((await pending).success).toBe(true); expect(network).toHaveBeenCalledTimes(5);
  });
  it.each(['pin.json', 'selection.json', 'binding-key', 'bindingSource', 'manifest'])('refuses concurrent change of %s without publishing partial evidence', async file => {
    const f = await setup(); const network = vi.fn<typeof fetch>(async target => {
      if (new URL(String(target)).pathname === '/api/v5/account/trade-fee') await writeFile(file === 'bindingSource' || file === 'manifest' ? f.paths[file] : join(f.paths.binding, file), 'changed');
      return Response.json(response(target));
    });
    failed(await executeAccountFees(raw(), { paths: f.paths, fetch: network, clock: () => now })); expect(await captures(f.paths.archive)).toEqual([]);
  });
});

describe('private fee files, freshness and durable backoff', () => {
  it.each(['archive', 'binding', 'observer'] as const)('rejects unprivate or symlinked %s paths before network', async field => {
    const f = await setup(), network = fetcher(); await chmod(f.paths[field], 0o755);
    failed(await executeAccountFees(raw(), { paths: f.paths, fetch: network, clock: () => now }));
    await chmod(f.paths[field], 0o700); const alias = join(f.root, 'alias'); await symlink(f.paths[field], alias);
    failed(await executeAccountFees(raw(), { paths: { ...f.paths, [field]: alias }, fetch: network, clock: () => now })); expect(network).not.toHaveBeenCalled();
  });
  it.each(['pin.json', 'selection.json', 'binding-key', 'bindingSource', 'manifest'])('requires private regular single-link %s', async name => {
    const f = await setup(), network = fetcher(), path = name === 'bindingSource' || name === 'manifest' ? f.paths[name] : join(f.paths.binding, name);
    await chmod(path, 0o644); failed(await executeAccountFees(raw(), { paths: f.paths, fetch: network, clock: () => now }));
    await chmod(path, 0o600); await link(path, join(f.root, 'other'));
    failed(await executeAccountFees(raw(), { paths: f.paths, fetch: network, clock: () => now })); expect(network).not.toHaveBeenCalled();
  });
  it.each(['selection.json', 'pin.json'])('rejects duplicate/noncanonical JSON in %s', async name => {
    const f = await setup(), network = fetcher(), path = join(f.paths.binding, name), content = await readFile(path, 'utf8');
    for (const changed of [content.replace('{', '{"schema":999,'), content.trimEnd(), content + ' ']) {
      await writeFile(path, changed);
      failed(await executeAccountFees(raw(), { paths: f.paths, fetch: network, clock: () => now }));
    }
    expect(network).not.toHaveBeenCalled();
  });
  it.each(['old-hash', 'empty-new', 'new-is-old', 'future-selection', 'receipt', 'version', 'key', 'pin-integrity'])('rejects binding/source mismatch %s before any GET', async change => {
    const f = await setup(), network = fetcher();
    if (change === 'old-hash') await writeFile(f.paths.bindingSource, '{"wrong":"old-source"}');
    if (change === 'empty-new') await writeFile(f.paths.manifest, '');
    if (change === 'new-is-old') await writeFile(f.paths.manifest, await readFile(f.paths.bindingSource));
    if (['future-selection', 'receipt', 'version'].includes(change)) {
      if (change === 'future-selection') f.selection.selection.selectedAt = now + 1;
      if (change === 'receipt') f.selection.selection.receipt.archiveHash = 'c'.repeat(64);
      if (change === 'version') f.selection.bundleVersion = 'df760817-7d3a-4d99-829f-a603286dc481';
      await writeFile(join(f.paths.binding, 'selection.json'), JSON.stringify(f.selection) + '\n');
    }
    if (change === 'key') await writeFile(join(f.paths.binding, 'binding-key'), randomBytes(32));
    if (change === 'pin-integrity') {
      const path = join(f.paths.binding, 'pin.json'), pin = JSON.parse(await readFile(path, 'utf8'));
      pin.credentialFingerprint = 'c'.repeat(64); await writeFile(path, JSON.stringify(pin) + '\n');
    }
    failed(await executeAccountFees(raw(), { paths: f.paths, fetch: network, clock: () => now })); expect(network).not.toHaveBeenCalled();
  });
  it('rejects expanded runtime options or duplicate path targets', async () => {
    const f = await setup(), network = fetcher();
    failed(await executeAccountFees(raw(), { paths: { ...f.paths, other: '/extra' }, fetch: network, clock: () => now } as never));
    failed(await executeAccountFees(raw(), { paths: { ...f.paths, manifest: f.paths.bindingSource }, fetch: network, clock: () => now }));
    failed(await executeAccountFees(raw(), { paths: f.paths, fetch: network, clock: () => now, allow: true } as never));
    expect(network).not.toHaveBeenCalled();
  });
  it.each(['regression', 'deadline'])('stops after first GET on %s', async kind => {
    const f = await setup(); let time = now;
    const network = vi.fn<typeof fetch>(async target => { time = kind === 'regression' ? now - 1 : now + 30_000; return Response.json(response(target)); });
    failed(await executeAccountFees(raw(), { paths: f.paths, fetch: network, clock: () => time })); expect(network).toHaveBeenCalledTimes(1); expect(await captures(f.paths.archive)).toEqual([]);
  });
  it('rejects a pair completing at exactly the 30-second boundary', async () => {
    const f = await setup(); let time = now;
    const network = vi.fn<typeof fetch>(async target => { if (new URL(String(target)).pathname === '/api/v5/account/trade-fee') time += 30_000; return Response.json(response(target)); });
    failed(await executeAccountFees(raw(), { paths: f.paths, fetch: network, clock: () => time })); expect(network).toHaveBeenCalledTimes(5); expect(await captures(f.paths.archive)).toEqual([]);
  });
  it.each([418, 429])('persists HTTP %s cooldown and blocks a second capture without network', async status => {
    const f = await setup(), network = vi.fn<typeof fetch>(async () => new Response('', { status, headers: { 'retry-after': '123' } }));
    failed(await executeAccountFees(raw(), { paths: f.paths, fetch: network, clock: () => now })); expect(network).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(join(f.paths.observer, 'cooldowns.json'), 'utf8')).mexc).toBe(now + 123_000);
    network.mockClear(); failed(await executeAccountFees(raw(), { paths: f.paths, fetch: network, clock: () => now })); expect(network).not.toHaveBeenCalled();
  });
  it.each(['mexc', 'okx'])('persists a late %s body-level rate limit past the capture deadline', async venue => {
    const f = await setup(); let time = now;
    const network = vi.fn<typeof fetch>(async target => {
      const path = new URL(String(target)).pathname;
      if (path === (venue === 'mexc' ? '/api/v3/tradeFee' : '/api/v5/account/trade-fee')) {
        time += 30_001;
        return Response.json(venue === 'mexc' ? { code: 429, msg: 'PRIVATE_UPSTREAM_TEXT' } : { code: '50011', data: [], msg: 'PRIVATE_UPSTREAM_TEXT' });
      }
      return Response.json(response(target));
    });
    const result = await executeAccountFees(raw(), { paths: f.paths, fetch: network, clock: () => time }); failed(result);
    expect(network).toHaveBeenCalledTimes(venue === 'mexc' ? 2 : 5);
    expect(JSON.parse(await readFile(join(f.paths.observer, 'cooldowns.json'), 'utf8'))[venue]).toBe(now + 90_001);
    expect(await captures(f.paths.archive)).toEqual([]); expect(JSON.stringify(result)).not.toContain('PRIVATE_UPSTREAM_TEXT');
  });
  it('refuses a missing cooldown and a full archive without resetting either', async () => {
    const f = await setup(), network = fetcher();
    for (let i = 0; i < 20; i++) await writeFile(join(f.paths.archive, `fees-${i}.json`), 'private', { mode: 0o600 });
    failed(await executeAccountFees(raw(), { paths: f.paths, fetch: network, clock: () => now }));
    await rm(join(f.paths.observer, 'cooldowns.json')); failed(await executeAccountFees(raw(), { paths: f.paths, fetch: network, clock: () => now }));
    expect(network).not.toHaveBeenCalled(); expect(await captures(f.paths.archive)).toHaveLength(20);
  });
});
