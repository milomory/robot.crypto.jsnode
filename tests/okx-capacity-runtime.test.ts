import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeOkxCapacity, preflightOkxCapacity, CAPACITY_FAILURE } from '../src/accounts/okx-capacity-runtime.js';
import { createAccountBindingPin, ACCOUNT_BINDING_CONTEXT, ACCOUNT_BINDING_REFERENCES, ACCOUNT_BINDING_POLICY_HASH } from '../src/accounts/account-binding.js';

const now = Date.UTC(2026, 9, 1, 10);
const mexcUid = 'mexc-private-capacity-test-account', okxUid = '98765432101010101';
const base = { schema: 1, environment: 'mainnet', region: 'global' };
const mexc = { ...base, venue: 'mexc', apiKey: 'MEXC_FAKE_CAPACITY_KEY_84928', apiSecret: 'MEXC_FAKE_CAPACITY_SECRET_453984' };
const okx = { ...base, venue: 'okx', apiKey: 'OKX_FAKE_CAPACITY_KEY_453888', apiSecret: 'OKX_FAKE_CAPACITY_SECRET_92193', passphrase: 'OKX_FAKE_CAPACITY_PHRASE_38291' };
const frame = () => ({ schema: 1, mexc: { ...mexc }, okx: { ...okx } });
const raw = () => Buffer.from(JSON.stringify(frame()));
const hash = (raw: Buffer | string) => createHash('sha256').update(raw).digest('hex');
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'capacity-runtime-test-')); roots.push(root);
  const paths = { archive: join(root, 'archive'), observer: join(root, 'observer'), binding: join(root, 'binding'),
    bindingSource: join(root, 'binding-source', 'manifest.json'), manifest: join(root, 'release', 'manifest.json') };
  for (const dir of [paths.archive, paths.observer, paths.binding, join(root, 'release'), join(root, 'binding-source')]) await mkdir(dir, { mode: 0o700 });
  await writeFile(paths.manifest, '{"collector":"synthetic-capacity-only"}', { mode: 0o600 });
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
function configRow() { return { uid: okxUid, mainUid: okxUid, type: '0', acctLv: '1', autoLoan: false, enableSpotBorrow: false, spotBorrowAutoRepay: false, feeType: '1' }; }
function response(target: string | URL | Request) {
  const url = new URL(String(target));
  if (url.origin !== 'https://www.okx.com') throw new Error('NO_MEXC_OR_OTHER_ORIGIN');
  if (url.pathname === '/api/v5/account/config') return { code: '0', data: [configRow()] };
  if (url.pathname === '/api/v5/account/max-avail-size') return { code: '0', data: [{ instId: 'BTC-USDT', availBuy: '29.876543210012345678', availSell: '0.001234567890123456', tradeQuoteCcy: 'USDT' }] };
  throw new Error('UNEXPECTED_ROUTE');
}
const fetcher = () => vi.fn<typeof fetch>(async target => Response.json(response(target)));
async function captures(path: string) { return (await readdir(path)).filter(n => n.startsWith('capacity-')); }
function failed(value: Awaited<ReturnType<typeof executeOkxCapacity>>) { expect(value).toMatchObject({ success: false, output: JSON.stringify(CAPACITY_FAILURE) }); }

// These fixtures construct only synthetic previous bindings; the production runtime has no enrollment entrypoint.
describe('account-bound OKX cash capacity capture', () => {
  it('captures only three OKX GETs, preserves source hashes and hides private data', async () => {
    const f = await setup(), network = fetcher();
    const boundPaths = ['pin.json', 'selection.json', 'binding-key'].map(name => join(f.paths.binding, name)).concat(f.paths.bindingSource);
    const before = await Promise.all(boundPaths.map(path => readFile(path)));
    expect(await preflightOkxCapacity(f.paths, now)).toEqual({ schema: 1, preflightPassed: true, requestCount: 0 });
    const result = await executeOkxCapacity(raw(), { paths: f.paths, fetch: network, clock: () => now });
    expect(result.success).toBe(true);
    expect(network.mock.calls.map(([url]) => String(url))).toEqual([
      'https://www.okx.com/api/v5/account/config',
      'https://www.okx.com/api/v5/account/max-avail-size?instId=BTC-USDT&tdMode=cash&tradeQuoteCcy=USDT',
      'https://www.okx.com/api/v5/account/config',
    ]);
    const output = JSON.parse(result.output!);
    expect(output).toMatchObject({ mode: 'okx-capacity-readonly', identityEnrolled: true, credentialBundleMatched: true,
      capacityBound: true, capacityAdmission: false, executable: false, requestCount: 3,
      okx: { observed: true, identityMatched: true, mainAccountConfirmed: true, configurationStable: true } });
    expect(output).not.toHaveProperty('mexc');
    for (const [, init] of network.mock.calls) {
      expect(init).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit' });
      expect(JSON.stringify(init?.headers)).not.toContain(mexc.apiKey);
      expect(JSON.stringify(init?.headers)).not.toContain(mexc.apiSecret);
    }
    const files = await captures(f.paths.archive); expect(files).toEqual(['capacity-' + output.receipt.archiveId + '.json']);
    const path = join(f.paths.archive, files[0]), bytes = await readFile(path), archive = JSON.parse(bytes.toString());
    expect(output.receipt.archiveHash).toBe(hash(bytes));
    expect(archive).toMatchObject({ kind: 'okx-capacity-observation', identityEnrolled: true, credentialBundleMatched: true,
      capacityBound: true, capacityAdmission: false, executable: false,
      bindingSourceHash: f.selection.sourceHash, collectorSourceHash: hash(await readFile(f.paths.manifest)),
      okx: { before: { identity: { uid: okxUid } }, after: { identity: { uid: okxUid } },
        configurationStable: true, capacity: { buyQuoteAvailable: '29.876543210012345678', sellBaseAvailable: '0.001234567890123456', buyUnit: 'USDT', sellUnit: 'BTC', sourceUpdatedAt: null } } });
    expect(archive).not.toHaveProperty('mexc');
    expect(archive.bindingSourceHash).not.toBe(archive.collectorSourceHash);
    expect((await lstat(path)).mode & 0o777).toBe(0o600); expect((await lstat(path)).nlink).toBe(1);
    for (const hidden of [mexcUid, okxUid, '29.876543210012345678', '0.001234567890123456', ...[mexc.apiKey, mexc.apiSecret, okx.apiKey, okx.apiSecret, okx.passphrase]]) expect(result.output).not.toContain(hidden);
    for (const secret of [mexc.apiKey, mexc.apiSecret, okx.apiKey, okx.apiSecret, okx.passphrase]) expect(bytes.toString()).not.toContain(secret);
    expect(await Promise.all(boundPaths.map(path => readFile(path)))).toEqual(before);
    expect(await readdir(f.paths.observer)).toEqual(['cooldowns.json']);
  });
  it('preflights without network, credentials or any file write', async () => {
    const f = await setup(), network = vi.fn(() => { throw new Error('UNEXPECTED_NETWORK'); }); vi.stubGlobal('fetch', network);
    const files = ['pin.json', 'selection.json', 'binding-key'].map(name => join(f.paths.binding, name)).concat(f.paths.bindingSource, f.paths.manifest, join(f.paths.observer, 'cooldowns.json'));
    const before = await Promise.all(files.map(path => readFile(path)));
    expect(await preflightOkxCapacity(f.paths, now)).toEqual({ schema: 1, preflightPassed: true, requestCount: 0 });
    expect(network).not.toHaveBeenCalled(); expect(await readdir(f.paths.archive)).toEqual([]);
    expect(await Promise.all(files.map(path => readFile(path)))).toEqual(before);
  });
  it('cannot auto-enroll if the existing pin is missing', async () => {
    const f = await setup(), network = fetcher(); await rm(join(f.paths.binding, 'pin.json'));
    failed(await executeOkxCapacity(raw(), { paths: f.paths, fetch: network, clock: () => now })); expect(network).not.toHaveBeenCalled();
    expect((await readdir(f.paths.binding)).sort()).toEqual(['binding-key', 'selection.json']);
  });
  it.each(['mexc-key', 'mexc-secret', 'okx-key', 'okx-secret', 'okx-passphrase'])('rejects credential rotation %s before any GET', async field => {
    const f = await setup(), network = fetcher(), changed = frame();
    if (field === 'mexc-key') changed.mexc.apiKey += '-ROTATED';
    if (field === 'mexc-secret') changed.mexc.apiSecret += '-ROTATED';
    if (field === 'okx-key') changed.okx.apiKey += '-ROTATED';
    if (field === 'okx-secret') changed.okx.apiSecret += '-ROTATED';
    if (field === 'okx-passphrase') changed.okx.passphrase += '-ROTATED';
    failed(await executeOkxCapacity(Buffer.from(JSON.stringify(changed)), { paths: f.paths, fetch: network, clock: () => now }));
    expect(network).not.toHaveBeenCalled(); expect(await captures(f.paths.archive)).toEqual([]);
  });
  it('rejects another OKX UID before requesting capacity', async () => {
    const f = await setup(), network = vi.fn<typeof fetch>(async () => Response.json({ code: '0', data: [{ ...configRow(), uid: '999123', mainUid: '999123' }] }));
    failed(await executeOkxCapacity(raw(), { paths: f.paths, fetch: network, clock: () => now }));
    expect(network).toHaveBeenCalledTimes(1); expect(await captures(f.paths.archive)).toEqual([]);
  });
  it.each(['uid', 'acctLv', 'autoLoan', 'enableSpotBorrow', 'spotBorrowAutoRepay', 'feeType'])('refuses changed final %s without an archive', async field => {
    const f = await setup(); let calls = 0;
    const network = vi.fn<typeof fetch>(async target => {
      calls++;
      if (calls === 3) {
        const row: Record<string, unknown> = configRow();
        if (field === 'uid') { row.uid = '999123'; row.mainUid = '999123'; }
        else if (field === 'acctLv') row.acctLv = '2';
        else if (field === 'feeType') row.feeType = '0';
        else row[field] = true;
        return Response.json({ code: '0', data: [row] });
      }
      return Response.json(response(target));
    });
    failed(await executeOkxCapacity(raw(), { paths: f.paths, fetch: network, clock: () => now }));
    expect(network).toHaveBeenCalledTimes(3); expect(await captures(f.paths.archive)).toEqual([]);
  });
  it('snapshots mutable credentials/options before first await', async () => {
    const f = await setup(), other = await setup(), bytes = raw(), paths = { ...f.paths }, network = fetcher();
    const options = { paths, fetch: network, clock: () => now };
    const pending = executeOkxCapacity(bytes, options); bytes.fill(0); paths.binding = other.paths.binding; options.fetch = vi.fn();
    expect((await pending).success).toBe(true); expect(network).toHaveBeenCalledTimes(3);
  });
  it.each(['pin.json', 'selection.json', 'binding-key', 'bindingSource', 'manifest'])('refuses concurrent change of %s without publishing partial evidence', async file => {
    const f = await setup(); let calls = 0; const network = vi.fn<typeof fetch>(async target => {
      if (++calls === 3) await writeFile(file === 'bindingSource' || file === 'manifest' ? f.paths[file] : join(f.paths.binding, file), 'changed');
      return Response.json(response(target));
    });
    failed(await executeOkxCapacity(raw(), { paths: f.paths, fetch: network, clock: () => now })); expect(await captures(f.paths.archive)).toEqual([]);
  });
});

describe('private capacity files, freshness and durable backoff', () => {
  it.each(['archive', 'binding', 'observer'] as const)('rejects unprivate or symlinked %s paths before network', async field => {
    const f = await setup(), network = fetcher(); await chmod(f.paths[field], 0o755);
    failed(await executeOkxCapacity(raw(), { paths: f.paths, fetch: network, clock: () => now }));
    await chmod(f.paths[field], 0o700); const alias = join(f.root, 'alias'); await symlink(f.paths[field], alias);
    failed(await executeOkxCapacity(raw(), { paths: { ...f.paths, [field]: alias }, fetch: network, clock: () => now })); expect(network).not.toHaveBeenCalled();
  });
  it.each(['pin.json', 'selection.json', 'binding-key', 'bindingSource', 'manifest'])('requires private regular single-link %s', async name => {
    const f = await setup(), network = fetcher(), path = name === 'bindingSource' || name === 'manifest' ? f.paths[name] : join(f.paths.binding, name);
    await chmod(path, 0o644); failed(await executeOkxCapacity(raw(), { paths: f.paths, fetch: network, clock: () => now }));
    await chmod(path, 0o600); await link(path, join(f.root, 'other'));
    failed(await executeOkxCapacity(raw(), { paths: f.paths, fetch: network, clock: () => now })); expect(network).not.toHaveBeenCalled();
  });
  it.each(['selection.json', 'pin.json'])('rejects duplicate/noncanonical JSON in %s', async name => {
    const f = await setup(), network = fetcher(), path = join(f.paths.binding, name), content = await readFile(path, 'utf8');
    for (const changed of [content.replace('{', '{"schema":999,'), content.trimEnd(), content + ' ']) {
      await writeFile(path, changed);
      failed(await executeOkxCapacity(raw(), { paths: f.paths, fetch: network, clock: () => now }));
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
    failed(await executeOkxCapacity(raw(), { paths: f.paths, fetch: network, clock: () => now })); expect(network).not.toHaveBeenCalled();
  });
  it('rejects expanded runtime options or duplicate path targets', async () => {
    const f = await setup(), network = fetcher();
    failed(await executeOkxCapacity(raw(), { paths: { ...f.paths, other: '/extra' }, fetch: network, clock: () => now } as never));
    failed(await executeOkxCapacity(raw(), { paths: { ...f.paths, manifest: f.paths.bindingSource }, fetch: network, clock: () => now }));
    failed(await executeOkxCapacity(raw(), { paths: f.paths, fetch: network, clock: () => now, allow: true } as never));
    expect(network).not.toHaveBeenCalled();
  });
  it.each(['regression', 'deadline'])('stops after first GET on %s', async kind => {
    const f = await setup(); let time = now;
    const network = vi.fn<typeof fetch>(async target => { time = kind === 'regression' ? now - 1 : now + 30_000; return Response.json(response(target)); });
    failed(await executeOkxCapacity(raw(), { paths: f.paths, fetch: network, clock: () => time })); expect(network).toHaveBeenCalledTimes(1); expect(await captures(f.paths.archive)).toEqual([]);
  });
  it('rejects a capture completing at exactly the 30-second boundary', async () => {
    const f = await setup(); let time = now, calls = 0;
    const network = vi.fn<typeof fetch>(async target => { if (++calls === 3) time += 30_000; return Response.json(response(target)); });
    failed(await executeOkxCapacity(raw(), { paths: f.paths, fetch: network, clock: () => time })); expect(network).toHaveBeenCalledTimes(3); expect(await captures(f.paths.archive)).toEqual([]);
  });
  it.each([418, 429])('persists OKX HTTP %s cooldown and blocks a second capture without network', async status => {
    const f = await setup(), network = vi.fn<typeof fetch>(async () => new Response('', { status, headers: { 'retry-after': '123' } }));
    failed(await executeOkxCapacity(raw(), { paths: f.paths, fetch: network, clock: () => now })); expect(network).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(join(f.paths.observer, 'cooldowns.json'), 'utf8')).okx).toBe(now + 123_000);
    network.mockClear(); failed(await executeOkxCapacity(raw(), { paths: f.paths, fetch: network, clock: () => now })); expect(network).not.toHaveBeenCalled();
  });
  it.each([418, 429])('persists late HTTP %s cooldown when the reader deadline has expired', async status => {
    const f = await setup(); let time = now, calls = 0;
    const network = vi.fn<typeof fetch>(async target => {
      if (++calls === 2) { time += 30_001; return new Response('', { status, headers: { 'retry-after': '120' } }); }
      return Response.json(response(target));
    });
    failed(await executeOkxCapacity(raw(), { paths: f.paths, fetch: network, clock: () => time }));
    expect(network).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await readFile(join(f.paths.observer, 'cooldowns.json'), 'utf8'))).toEqual({ schema: 1, mexc: 0, okx: now + 150_001 });
    expect(await captures(f.paths.archive)).toEqual([]);
  });
  it.each([1, 2, 3])('persists late body-level OKX rate limit at request %s after capture deadline', async failedRequest => {
    const f = await setup(); let time = now, calls = 0;
    const network = vi.fn<typeof fetch>(async target => {
      if (++calls === failedRequest) { time += 30_001; return Response.json({ code: '50011', data: [], msg: 'PRIVATE_UPSTREAM_TEXT' }); }
      return Response.json(response(target));
    });
    const result = await executeOkxCapacity(raw(), { paths: f.paths, fetch: network, clock: () => time }); failed(result);
    expect(network).toHaveBeenCalledTimes(failedRequest);
    expect(JSON.parse(await readFile(join(f.paths.observer, 'cooldowns.json'), 'utf8'))).toEqual({ schema: 1, mexc: 0, okx: now + 90_001 });
    expect(await captures(f.paths.archive)).toEqual([]); expect(JSON.stringify(result)).not.toContain('PRIVATE_UPSTREAM_TEXT');
  });
  it('preserves prior MEXC cooldown while updating only OKX cooldown', async () => {
    const f = await setup(), path = join(f.paths.observer, 'cooldowns.json');
    await writeFile(path, JSON.stringify({ schema: 1, mexc: now - 1000, okx: 0 }));
    const network = vi.fn<typeof fetch>(async () => new Response('', { status: 429 }));
    failed(await executeOkxCapacity(raw(), { paths: f.paths, fetch: network, clock: () => now }));
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ schema: 1, mexc: now - 1000, okx: now + 60_000 });
    expect(network).toHaveBeenCalledTimes(1);
  });
  it('conservatively refuses active MEXC cooldown without making MEXC or OKX calls', async () => {
    const f = await setup(), path = join(f.paths.observer, 'cooldowns.json'), network = fetcher();
    const before = JSON.stringify({ schema: 1, mexc: now + 1000, okx: 0 }); await writeFile(path, before);
    failed(await executeOkxCapacity(raw(), { paths: f.paths, fetch: network, clock: () => now }));
    expect(await readFile(path, 'utf8')).toBe(before); expect(network).not.toHaveBeenCalled();
  });
  it('refuses a missing cooldown and a full archive without resetting either', async () => {
    const f = await setup(), network = fetcher();
    for (let i = 0; i < 20; i++) await writeFile(join(f.paths.archive, `capacity-${i}.json`), 'private', { mode: 0o600 });
    failed(await executeOkxCapacity(raw(), { paths: f.paths, fetch: network, clock: () => now }));
    await rm(join(f.paths.observer, 'cooldowns.json')); failed(await executeOkxCapacity(raw(), { paths: f.paths, fetch: network, clock: () => now }));
    expect(network).not.toHaveBeenCalled(); expect(await captures(f.paths.archive)).toHaveLength(20);
  });
});
