import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fundsEvidenceFixture } from './helpers/funds-evidence-fixture.js';
import type { AccountFundsJournalCheckpoint } from '../src/live/account-funds-journal.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function cli(args: string[], guard?: string) {
  return await new Promise<{ code: number; output: string; error: string }>(done => {
    execFile(process.execPath, ['--import', 'tsx', ...(guard ? ['--import', guard] : []), 'src/scripts/account-funds-preparation.ts', ...args],
      { cwd: process.cwd(), timeout: 15_000, maxBuffer: 16 * 1024, env: { ...process.env, TRADING_MODE: 'live', LIVE_TRADING_LOCKED: 'false' } },
      (error, output, stderr) => done({ code: error ? 1 : 0, output, error: stderr }));
  });
}
async function json(path: string, value: unknown) { await writeFile(path, JSON.stringify(value) + '\n', { mode: 0o600 }); }
const limits = () => ({ schema: 1, kind: 'live-limits-draft', account: 'main', symbol: 'BTC/USDT', totalCapitalUsdt: '40',
  capitalByVenueUsdt: { mexc: '20', okx: '20' }, maxOrderDebitUsdt: '20', maxCumulativeLossUsdt: '40', maxUnhedgedBtc: '0.001',
  includeEarn: false, transfersEnabled: false, withdrawalsEnabled: false });
const order = () => ({ orderIntentId: '00000000-0000-4000-8000-000000000002', venue: 'okx', account: 'main', symbol: 'BTC/USDT',
  side: 'buy', orderType: 'limit', baseQuantity: '0.0001', limitPrice: '100000', maxQuoteAmount: '10', feeCaps: { BTC: '0', USDT: '0.01', MX: '0' } });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'account-funds-cli-')); roots.push(root);
  const paths = { root, journal: join(root, 'journal'), key: join(root, 'key.bin'), pin: join(root, 'pin.json'),
    archive: join(root, 'archive.json'), receipt: join(root, 'receipt.json'), limits: join(root, 'limits.json'),
    checkpoint: join(root, 'checkpoint.json'), intent: join(root, 'intent.json'), fee: join(root, 'fee.json'), release: join(root, 'release.json'), guard: join(root, 'guard.mjs') };
  const observedAt = Date.now() - 2_000, fixture = fundsEvidenceFixture({ now: observedAt, mexcUid: 'PRIVATE_CLI_UID_CANARY' });
  fixture.archive.mexc.funds.balances[0].free = '0'; fixture.archive.mexc.funds.balances[0].available = '0';
  fixture.archive.okx.funds.balances[0].cashBal = '0'; fixture.archive.okx.funds.balances[0].availBal = '0';
  const input = fixture.input(), fee = { schema: 1, kind: 'declared-order-fee-evidence', source: 'declared-synthetic', venue: 'okx', account: 'main', symbol: 'BTC/USDT',
    bundleVersion: fixture.pin.bundleVersion, pinHash: fixture.archive.pinHash, observedAt, expiresAt: observedAt + 60_000,
    makerRate: '0.001', takerRate: '0.001', feeAsset: 'USDT', provenanceVerified: false };
  await Promise.all([writeFile(paths.key, input.bindingKey, { mode: 0o600 }), writeFile(paths.pin, input.pinBytes, { mode: 0o600 }),
    writeFile(paths.archive, input.archiveBytes, { mode: 0o600 }), json(paths.receipt, input.receipt), json(paths.limits, limits()), json(paths.intent, order()),
    json(paths.fee, fee), json(paths.release, { intentId: order().orderIntentId, reason: 'operator-released' }),
    writeFile(paths.guard, "globalThis.fetch=()=>{throw Error('NETWORK_FORBIDDEN_PRIVATE_CANARY')};\n", { mode: 0o600 })]);
  return { ...paths, fixture, feeDeclaration: fee };
}
function privateOutput(text: string) {
  expect(text).not.toMatch(/PRIVATE_|SYNTHETIC_|orderIntentId|baseQuantity|limitPrice|cashBal|candidateAmount|ownedAmount|pinHash|bundleVersion|archiveHash|feeEvidence|99\.999999999999999999|9876543212345678901|0707070707070707070707070707070707070707070707070707070707070707/);
}
function success(response: Awaited<ReturnType<typeof cli>>, command: string) {
  expect(response.code).toBe(0); expect(response.error).toBe(''); privateOutput(response.output);
  const value = JSON.parse(response.output) as { checkpoint: AccountFundsJournalCheckpoint; preparedCount: number; hasEvidence: boolean; limitsDraftPresent: boolean };
  expect(value).toMatchObject({ schema: 1, kind: 'offline-account-funds-preparation-result', status: 'succeeded', command,
    executable: false, liveAllowed: false, feeProvenanceVerified: false, accountGlobalOwnershipVerified: false });
  expect(Object.keys(value).sort()).toEqual(['schema', 'kind', 'status', 'command', 'checkpoint', 'preparedCount', 'hasEvidence',
    'limitsDraftPresent', 'executable', 'liveAllowed', 'feeProvenanceVerified', 'accountGlobalOwnershipVerified'].sort());
  expect(Object.keys(value.checkpoint).sort()).toEqual(['schema', 'kind', 'journalId', 'revision', 'headHash'].sort());
  return value;
}
function failure(response: Awaited<ReturnType<typeof cli>>, reason?: string) {
  expect(response.code).toBe(1); expect(response.output).toBe(''); privateOutput(response.error);
  const value = JSON.parse(response.error);
  expect(value).toMatchObject({ schema: 1, kind: 'offline-account-funds-preparation-result', status: 'failed', executable: false, liveAllowed: false });
  expect(Object.keys(value).sort()).toEqual(['schema', 'kind', 'status', 'reason', 'executable', 'liveAllowed'].sort());
  if (reason) expect(value.reason).toBe(reason);
  expect(response.error).not.toContain('Error:');
}
async function initialized(f: Awaited<ReturnType<typeof setup>>) {
  const result = success(await cli(['init', f.journal, f.key, f.pin, f.limits], f.guard), 'init');
  await json(f.checkpoint, result.checkpoint); return result;
}
async function imported(f: Awaited<ReturnType<typeof setup>>) {
  await initialized(f);
  const result = success(await cli(['import', f.journal, f.key, f.archive, f.receipt, f.pin, f.checkpoint], f.guard), 'import');
  await json(f.checkpoint, result.checkpoint); return result;
}

describe('offline private account funds preparation CLI', () => {
  it('completes init/import/stage/inspect/release across processes with safe receipts only', async () => {
    const f = await setup(); let current = await imported(f);
    expect(current.preparedCount).toBe(0); expect(current.hasEvidence).toBe(true); expect(current.limitsDraftPresent).toBe(true);
    current = success(await cli(['stage', f.journal, f.key, f.intent, f.fee, f.checkpoint], f.guard), 'stage');
    expect(current.preparedCount).toBe(1); expect(current.checkpoint.revision).toBe(2); await json(f.checkpoint, current.checkpoint);
    expect(success(await cli(['inspect', f.journal, f.key, f.checkpoint], f.guard), 'inspect').preparedCount).toBe(1);
    current = success(await cli(['release', f.journal, f.key, f.release, f.checkpoint], f.guard), 'release');
    expect(current.preparedCount).toBe(0); expect(current.checkpoint.revision).toBe(3);
    expect(success(await cli(['inspect', f.journal, f.key], f.guard), 'inspect').preparedCount).toBe(0);
    expect((await stat(f.journal)).mode & 0o777).toBe(0o700);
    for (const name of await readdir(f.journal)) expect((await stat(join(f.journal, name))).mode & 0o777).toBe(0o600);
    expect(await readFile(f.key)).toEqual(Buffer.alloc(32, 7));
  }, 30_000);
  it('accepts explicit null limits as a missing draft and blocks staging without inventing amounts', async () => {
    const f = await setup(); await json(f.limits, null); const current = await imported(f);
    expect(current.limitsDraftPresent).toBe(false);
    failure(await cli(['stage', f.journal, f.key, f.intent, f.fee, f.checkpoint]), 'journal-policy-blocked');
    expect(success(await cli(['inspect', f.journal, f.key]), 'inspect').checkpoint.revision).toBe(1);
  }, 20_000);
  it('refuses a stale checkpoint without changing the current journal', async () => {
    const f = await setup(), first = await initialized(f);
    const current = success(await cli(['import', f.journal, f.key, f.archive, f.receipt, f.pin, f.checkpoint]), 'import');
    expect(current.checkpoint.revision).toBe(first.checkpoint.revision + 1);
    failure(await cli(['stage', f.journal, f.key, f.intent, f.fee, f.checkpoint]), 'journal-head-conflict');
    expect((await readdir(f.journal)).sort()).toEqual(['000001.json', 'manifest.json']);
  }, 20_000);
  it.each(['short', 'long', 'empty', 'world-readable', 'symlink', 'hardlink', 'directory'])('rejects %s key files before journal creation', async kind => {
    const f = await setup(); let path = f.key;
    if (kind === 'short') await writeFile(f.key, Buffer.alloc(31));
    if (kind === 'long') await writeFile(f.key, Buffer.alloc(33));
    if (kind === 'empty') await writeFile(f.key, Buffer.alloc(0));
    if (kind === 'world-readable') await chmod(f.key, 0o644);
    if (kind === 'symlink') { path = join(f.root, 'symlink-key'); await symlink(f.key, path); }
    if (kind === 'hardlink') { path = join(f.root, 'hardlink-key'); await link(f.key, path); }
    if (kind === 'directory') { path = join(f.root, 'directory-key'); await mkdir(path, { mode: 0o700 }); }
    failure(await cli(['init', f.journal, path, f.pin, f.limits]), 'invalid-input');
    expect(await readdir(f.root)).not.toContain('journal');
  });
  it.each(['pin', 'limits', 'receipt', 'archive', 'checkpoint', 'intent', 'fee', 'release'] as const)('rejects a nonprivate %s input', async field => {
    const f = await setup();
    if (field === 'pin' || field === 'limits') {
      await chmod(f[field], 0o644); failure(await cli(['init', f.journal, f.key, f.pin, f.limits]), 'invalid-input'); return;
    }
    if (field === 'intent' || field === 'fee' || field === 'release') await imported(f); else await initialized(f);
    await chmod(f[field], 0o644);
    const args = field === 'intent' || field === 'fee' ? ['stage', f.journal, f.key, f.intent, f.fee, f.checkpoint]
      : field === 'release' ? ['release', f.journal, f.key, f.release, f.checkpoint]
        : ['import', f.journal, f.key, f.archive, f.receipt, f.pin, f.checkpoint];
    failure(await cli(args), 'invalid-input');
  }, 15_000);
  it.each(['invalid-json', 'invalid-utf8', 'duplicate-key', 'large', 'extra-private-field'])('hides private values in %s metadata failures', async kind => {
    const f = await setup();
    if (kind === 'invalid-json') await writeFile(f.limits, '{PRIVATE_CLI_CANARY');
    if (kind === 'invalid-utf8') await writeFile(f.limits, Buffer.from([255, 254]));
    if (kind === 'duplicate-key') await writeFile(f.limits, JSON.stringify(limits()).replace('"schema":1', '"schema":1,"schema":1'));
    if (kind === 'large') await writeFile(f.limits, 'PRIVATE_CLI_CANARY'.repeat(1000));
    if (kind === 'extra-private-field') await json(f.limits, { ...limits(), private: 'PRIVATE_CLI_CANARY' });
    failure(await cli(['init', f.journal, f.key, f.pin, f.limits]));
    expect(await readdir(f.root)).not.toContain('journal');
  });
  it('does not print paths or a mismatched raw key', async () => {
    const f = await setup(); const path = join(f.root, 'PRIVATE_KEY_PATH_CANARY'); await writeFile(path, Buffer.alloc(32, 9), { mode: 0o600 });
    failure(await cli(['init', f.journal, path, f.pin, f.limits]), 'journal-evidence-invalid');
    failure(await cli(['init', f.journal, join(f.root, 'PRIVATE_MISSING_PATH'), f.pin, f.limits]), 'invalid-input');
  });
  it.each([[], ['start'], ['trade'], ['inspect', 'https://PRIVATE_CLI_CANARY'], ['init', 'secret://PRIVATE_CLI_CANARY'], ['inspect', '--now', '0'],
    ['stage', 'journal', 'key', 'intent', 'fee', 'checkpoint', 'PRIVATE_EXTRA']].map(args => ({ args })))('rejects unsupported arguments without echo $args', async ({ args }) => {
    failure(await cli(args), 'invalid-input');
  });
  it('rejects an otherwise complete URI path without attempting network access', async () => {
    const f = await setup(); failure(await cli(['init', f.journal, 'https://PRIVATE_CLI_CANARY', f.pin, f.limits], f.guard), 'invalid-input');
    expect(await readdir(f.root)).not.toContain('journal');
  });
  it('preserves an existing journal and reports a forged checkpoint safely', async () => {
    const f = await setup(), current = await initialized(f), before = await readFile(join(f.journal, 'manifest.json'));
    failure(await cli(['init', f.journal, f.key, f.pin, f.limits]));
    expect(await readFile(join(f.journal, 'manifest.json'))).toEqual(before);
    await json(f.checkpoint, { ...current.checkpoint, headHash: '0'.repeat(64) });
    failure(await cli(['inspect', f.journal, f.key, f.checkpoint]), 'journal-head-conflict');
  }, 15_000);
});
