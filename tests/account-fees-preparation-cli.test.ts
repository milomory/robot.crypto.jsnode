import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { accountFeesFixture } from './helpers/account-fees-fixture.js';
import type { AccountFundsJournalCheckpoint } from '../src/live/account-funds-journal.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const limits = () => ({ schema: 1, kind: 'live-limits-draft', account: 'main', symbol: 'BTC/USDT', totalCapitalUsdt: '40',
  capitalByVenueUsdt: { mexc: '20', okx: '20' }, maxOrderDebitUsdt: '20', maxCumulativeLossUsdt: '40', maxUnhedgedBtc: '0.001',
  includeEarn: false, transfersEnabled: false, withdrawalsEnabled: false });
const order = (index = 1) => ({ orderIntentId: `92000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  venue: 'okx', account: 'main', symbol: 'BTC/USDT', side: 'buy', orderType: 'limit', baseQuantity: '0.0001',
  limitPrice: '100000', maxQuoteAmount: '10', feeCaps: { BTC: '0', USDT: '0.01', MX: '0' } });
async function json(path: string, value: unknown) { await writeFile(path, JSON.stringify(value) + '\n', { mode: 0o600 }); }
async function cli(args: string[], guard: string) {
  return await new Promise<{ code: number; output: string; error: string }>(done => {
    execFile(process.execPath, ['--import', 'tsx', '--import', guard, 'src/scripts/account-funds-preparation.ts', ...args],
      { cwd: process.cwd(), timeout: 15_000, maxBuffer: 16 * 1024, env: { ...process.env, TRADING_MODE: 'live', LIVE_TRADING_LOCKED: 'false' } },
      (error, output, stderr) => done({ code: error ? 1 : 0, output, error: stderr }));
  });
}
async function setup(offset = 5_000) {
  const root = await mkdtemp(join(tmpdir(), 'account-fees-cli-')); roots.push(root);
  const paths = { journal: join(root, 'journal'), key: join(root, 'key.bin'), pin: join(root, 'pin.json'), funds: join(root, 'funds.json'),
    fundsReceipt: join(root, 'funds-receipt.json'), fees: join(root, 'fees.json'), feesReceipt: join(root, 'fees-receipt.json'),
    limits: join(root, 'limits.json'), collector: join(root, 'collector.json'), checkpoint: join(root, 'checkpoint.json'),
    intent: join(root, 'intent.json'), secondIntent: join(root, 'intent2.json'), release: join(root, 'release.json'), guard: join(root, 'guard.mjs') };
  const f = accountFeesFixture({ now: Date.now() - offset, mexcUid: 'PRIVATE_CLI_FEE_UID', okxUSDT: '20' });
  const funds = f.fundsInput(), fees = f.input();
  await Promise.all([writeFile(paths.key, f.bindingKey, { mode: 0o600 }), writeFile(paths.pin, f.pinBytes, { mode: 0o600 }),
    writeFile(paths.funds, funds.archiveBytes, { mode: 0o600 }), json(paths.fundsReceipt, funds.receipt),
    writeFile(paths.fees, fees.archiveBytes, { mode: 0o600 }), json(paths.feesReceipt, fees.receipt), json(paths.limits, limits()),
    json(paths.collector, { collectorSourceHash: f.collectorSourceHash }), json(paths.intent, order()), json(paths.secondIntent, order(2)),
    json(paths.release, { intentId: order().orderIntentId, reason: 'operator-released' }),
    writeFile(paths.guard, "globalThis.fetch=()=>{throw Error('PRIVATE_NETWORK_MUST_NEVER_RUN')};\n", { mode: 0o600 })]);
  return { root, f, ...paths };
}
function privateOutput(text: string) {
  expect(text).not.toMatch(/PRIVATE_|SYNTHETIC_|orderIntentId|baseQuantity|limitPrice|pinHash|bundleVersion|archiveHash|makerRate|takerRate|collectorSourceHash|9876543212345678901/);
}
function success(response: Awaited<ReturnType<typeof cli>>, command: string, verified: boolean) {
  expect(response.code).toBe(0); expect(response.error).toBe(''); privateOutput(response.output);
  const value = JSON.parse(response.output) as { checkpoint: AccountFundsJournalCheckpoint; preparedCount: number; feeProvenanceVerified: boolean };
  expect(value).toMatchObject({ schema: 1, kind: 'offline-account-funds-preparation-result', status: 'succeeded', command,
    checkpoint: { schema: 2 }, executable: false, liveAllowed: false, feeProvenanceVerified: verified, accountGlobalOwnershipVerified: false });
  return value;
}
function failure(response: Awaited<ReturnType<typeof cli>>, reason?: string) {
  expect(response.code).toBe(1); expect(response.output).toBe(''); privateOutput(response.error);
  const value = JSON.parse(response.error);
  expect(value).toMatchObject({ schema: 1, kind: 'offline-account-funds-preparation-result', status: 'failed', executable: false, liveAllowed: false });
  if (reason) expect(value.reason).toBe(reason);
  expect(Object.keys(value).sort()).toEqual(['schema', 'kind', 'status', 'reason', 'executable', 'liveAllowed'].sort());
}
async function initialized(s: Awaited<ReturnType<typeof setup>>) {
  const result = success(await cli(['init-bound', s.journal, s.key, s.pin, s.limits, s.collector], s.guard), 'init-bound', false);
  await json(s.checkpoint, result.checkpoint); return result;
}
async function imported(s: Awaited<ReturnType<typeof setup>>) {
  await initialized(s);
  const result = success(await cli(['import-bound', s.journal, s.key, s.funds, s.fundsReceipt, s.fees, s.feesReceipt, s.pin, s.checkpoint], s.guard), 'import-bound', true);
  await json(s.checkpoint, result.checkpoint); return result;
}

describe('offline CLI for account-bound fees', () => {
  it('finishes init/import/stage/inspect/release using private files and public status only', async () => {
    const s = await setup(); await imported(s);
    const saved = success(await cli(['stage-bound', s.journal, s.key, s.intent, s.checkpoint], s.guard), 'stage-bound', true);
    expect(saved.preparedCount).toBe(1); await json(s.checkpoint, saved.checkpoint);
    expect(success(await cli(['inspect-bound', s.journal, s.key, s.checkpoint], s.guard), 'inspect-bound', true).preparedCount).toBe(1);
    const released = success(await cli(['release-bound', s.journal, s.key, s.release, s.checkpoint], s.guard), 'release-bound', true);
    expect(released.preparedCount).toBe(0);
    expect(success(await cli(['inspect-bound', s.journal, s.key], s.guard), 'inspect-bound', true).preparedCount).toBe(0);
  }, 30_000);
  it('uses the same head CAS across independent CLI processes', async () => {
    const s = await setup(); await imported(s);
    const responses = await Promise.all([cli(['stage-bound', s.journal, s.key, s.intent, s.checkpoint], s.guard),
      cli(['stage-bound', s.journal, s.key, s.secondIntent, s.checkpoint], s.guard)]);
    expect(responses.filter(row => row.code === 0)).toHaveLength(1);
    failure(responses.find(row => row.code !== 0)!, 'journal-head-conflict');
    expect(success(await cli(['inspect-bound', s.journal, s.key], s.guard), 'inspect-bound', true).preparedCount).toBe(1);
  }, 30_000);
  it('does not allow a caller fee declaration as an extra stage argument', async () => {
    const s = await setup(); await imported(s);
    failure(await cli(['stage-bound', s.journal, s.key, s.intent, s.fees, s.checkpoint], s.guard), 'invalid-input');
    failure(await cli(['stage', s.journal, s.key, s.intent, s.fees, s.checkpoint], s.guard), 'journal-invalid');
    expect(success(await cli(['inspect-bound', s.journal, s.key], s.guard), 'inspect-bound', true).preparedCount).toBe(0);
  }, 30_000);
  it.each(['collector', 'fees', 'feesReceipt'] as const)('rejects a nonprivate %s file', async field => {
    const s = await setup(); if (field !== 'collector') await initialized(s);
    await chmod(s[field], 0o644);
    const args = field === 'collector' ? ['init-bound', s.journal, s.key, s.pin, s.limits, s.collector]
      : ['import-bound', s.journal, s.key, s.funds, s.fundsReceipt, s.fees, s.feesReceipt, s.pin, s.checkpoint];
    failure(await cli(args, s.guard), 'invalid-input');
  }, 15_000);
  it('requires an explicit collector manifest hash and hides malformed metadata', async () => {
    const s = await setup(); await json(s.collector, { collectorSourceHash: 'PRIVATE_INVALID_HASH' });
    failure(await cli(['init-bound', s.journal, s.key, s.pin, s.limits, s.collector], s.guard), 'invalid-input');
    expect(await readdir(s.root)).not.toContain('journal');
  });
  it('rejects old observations without contacting any exchange', async () => {
    const s = await setup(70_000); await initialized(s);
    failure(await cli(['import-bound', s.journal, s.key, s.funds, s.fundsReceipt, s.fees, s.feesReceipt, s.pin, s.checkpoint], s.guard), 'journal-evidence-invalid');
    expect((await readdir(s.journal)).sort()).toEqual(['manifest.json']);
  }, 20_000);
});
