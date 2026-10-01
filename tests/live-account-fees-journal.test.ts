import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, readdir, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createFeeBoundAccountFundsJournal, importFeeBoundAccountFundsJournalEvidence, stageFeeBoundAccountFundsJournalIntent,
  releaseFeeBoundAccountFundsJournalIntent, readFeeBoundAccountFundsJournal, createAccountFundsJournal,
  importAccountFundsJournalEvidence, stageAccountFundsJournalIntent, releaseAccountFundsJournalIntent, readAccountFundsJournal,
  type AccountFundsJournalCheckpoint } from '../src/live/account-funds-journal.js';
import { canonicalLiveOrderJson } from '../src/live/order-lifecycle.js';
import { accountFeesFixture } from './helpers/account-fees-fixture.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const id = (index: number) => `91000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const limits = () => ({ schema: 1, kind: 'live-limits-draft', account: 'main', symbol: 'BTC/USDT', totalCapitalUsdt: '200',
  capitalByVenueUsdt: { mexc: '100', okx: '100' }, maxOrderDebitUsdt: '100', maxCumulativeLossUsdt: '200', maxUnhedgedBtc: '1',
  includeEarn: false, transfersEnabled: false, withdrawalsEnabled: false });
const proposed = (index = 1) => ({ orderIntentId: id(index), venue: 'okx', account: 'main', symbol: 'BTC/USDT', side: 'buy', orderType: 'limit',
  baseQuantity: '0.0001', limitPrice: '100000', maxQuoteAmount: '10', feeCaps: { BTC: '0', USDT: '0.01', MX: '0' } });
function paired(f: ReturnType<typeof accountFeesFixture>) {
  const funds = f.fundsInput(), fees = f.input();
  return { funds: { archiveBytes: funds.archiveBytes, receipt: funds.receipt }, fees: { archiveBytes: fees.archiveBytes, receipt: fees.receipt },
    pinBytes: f.pinBytes, bindingKey: f.bindingKey };
}
async function setup(options: Parameters<typeof accountFeesFixture>[0] = {}, selectedLimits: unknown = limits()) {
  const root = await mkdtemp(join(tmpdir(), 'fees-journal-test-')); roots.push(root);
  const directory = join(root, 'journal'), f = accountFeesFixture({ okxUSDT: '20', ...options });
  const initial = await createFeeBoundAccountFundsJournal(directory, { pinBytes: f.pinBytes, bindingKey: f.bindingKey,
    collectorSourceHash: f.collectorSourceHash, limits: selectedLimits }, f.now - 1);
  return { root, directory, f, initial };
}
async function imported(options: Parameters<typeof accountFeesFixture>[0] = {}, selectedLimits: unknown = limits()) {
  const s = await setup(options, selectedLimits);
  const current = await importFeeBoundAccountFundsJournalEvidence(s.directory, paired(s.f), s.initial.checkpoint, s.f.now);
  return { ...s, current };
}
const stage = (s: Awaited<ReturnType<typeof imported>>, index = 1, checkpoint = s.current.checkpoint, now = s.f.now + 1) =>
  stageFeeBoundAccountFundsJournalIntent(s.directory, { intent: proposed(index), bindingKey: s.f.bindingKey }, checkpoint, now);
async function mutateRecord(directory: string, filename: string, mutate: (value: Record<string, any>) => void) {
  const path = join(directory, filename), value = JSON.parse(await readFile(path, 'utf8')) as Record<string, any>;
  mutate(value); const { hash: _hash, ...body } = value;
  value.hash = createHash('sha256').update(canonicalLiveOrderJson(body)).digest('hex');
  await writeFile(path, canonicalLiveOrderJson(value) + '\n', { mode: 0o600 });
}

describe('fee-bound private account preparation journal', () => {
  it('imports paired captures, calculates from captured rates, replays and releases reservations', async () => {
    const s = await imported(); const saved = await stage(s);
    expect(saved).toMatchObject({ schema: 2, kind: 'fee-bound-account-funds-preparation-journal', feeProvenanceVerified: true,
      executable: false, liveAllowed: false, accountGlobalOwnershipVerified: false, checkpoint: { schema: 2, revision: 2 } });
    expect(saved.preparedIntents).toEqual([proposed()]);
    expect(await readFeeBoundAccountFundsJournal(s.directory, s.f.bindingKey, saved.checkpoint)).toEqual(saved);
    const released = await releaseFeeBoundAccountFundsJournalIntent(s.directory,
      { intentId: id(1), reason: 'operator-released', bindingKey: s.f.bindingKey }, saved.checkpoint, s.f.now + 2);
    expect(released.preparedIntents).toEqual([]);
    expect((await stage(s, 2, released.checkpoint, s.f.now + 3)).preparedIntents).toHaveLength(1);
    const record = JSON.parse(await readFile(join(s.directory, '000002.json'), 'utf8'));
    expect(record.event.type).toBe('fee-bound-intent-staged'); expect(record.event).not.toHaveProperty('feeEvidence');
  });
  it('does not imply tariff provenance before a paired import', async () => {
    const s = await setup(); expect(s.initial.feeProvenanceVerified).toBe(false); expect(s.initial.latestFeeEvidenceReceipt).toBeNull();
    await expect(stageFeeBoundAccountFundsJournalIntent(s.directory, { intent: proposed(), bindingKey: s.f.bindingKey },
      s.initial.checkpoint, s.f.now)).rejects.toThrow('journal-policy-blocked');
  });
  it('uses captured taker cost instead of zero declared fees or an insufficient cap', async () => {
    const s = await imported(); const order = proposed(); order.feeCaps.USDT = '0.009999999999999999';
    await expect(stageFeeBoundAccountFundsJournalIntent(s.directory, { intent: order, bindingKey: s.f.bindingKey },
      s.current.checkpoint, s.f.now + 1)).rejects.toThrow('journal-policy-blocked');
    await expect(stageFeeBoundAccountFundsJournalIntent(s.directory, { intent: proposed(), bindingKey: s.f.bindingKey,
      feeEvidence: { makerRate: '0', takerRate: '0' } } as never, s.current.checkpoint, s.f.now + 1)).rejects.toThrow('journal-event-invalid');
    expect((await readFeeBoundAccountFundsJournal(s.directory, s.f.bindingKey)).checkpoint).toEqual(s.current.checkpoint);
  });
  it.each(['stage', 'import', 'release', 'read'])('rejects legacy %s entrypoint on a bound journal', async operation => {
    const s = await imported();
    const action = operation === 'stage' ? stageAccountFundsJournalIntent(s.directory,
      { intent: proposed(), feeEvidence: {}, bindingKey: s.f.bindingKey }, s.current.checkpoint, s.f.now + 1)
      : operation === 'import' ? importAccountFundsJournalEvidence(s.directory, s.f.fundsInput(), s.current.checkpoint, s.f.now + 1)
        : operation === 'release' ? releaseAccountFundsJournalIntent(s.directory,
          { intentId: id(1), reason: 'operator-released', bindingKey: s.f.bindingKey }, s.current.checkpoint, s.f.now + 1)
          : readAccountFundsJournal(s.directory, s.f.bindingKey);
    await expect(action).rejects.toThrow('journal-invalid');
    expect((await readdir(s.directory)).sort()).toEqual(['000001.json', 'manifest.json']);
  });
  it('rejects bound APIs on a legacy manifest', async () => {
    const s = await setup(), path = join(s.root, 'legacy');
    const initial = await createAccountFundsJournal(path, { pinBytes: s.f.pinBytes, bindingKey: s.f.bindingKey, limits: limits() }, s.f.now - 1);
    await expect(importFeeBoundAccountFundsJournalEvidence(path, paired(s.f), initial.checkpoint, s.f.now)).rejects.toThrow('journal-invalid');
    await expect(readFeeBoundAccountFundsJournal(path, s.f.bindingKey)).rejects.toThrow('journal-invalid');
    expect((await readAccountFundsJournal(path, s.f.bindingKey)).checkpoint.revision).toBe(0);
  });
  it('preserves prior reserves when both newer captures are imported', async () => {
    const s = await imported(), saved = await stage(s);
    const next = accountFeesFixture({ now: s.f.funds.archive.startedAt + 3000, okxUSDT: '20' });
    next.funds.archive.archiveId = id(20); next.archive.archiveId = id(21);
    const updated = await importFeeBoundAccountFundsJournalEvidence(s.directory, paired(next), saved.checkpoint, next.now);
    expect(updated.preparedIntents).toHaveLength(1);
    await expect(stageFeeBoundAccountFundsJournalIntent(s.directory, { intent: proposed(2), bindingKey: next.bindingKey },
      updated.checkpoint, next.now + 1)).rejects.toThrow('journal-policy-blocked');
  });
  it('keeps prior reservations but blocks staging if a newly observed tariff exceeds their fee caps', async () => {
    const s = await imported({ okxUSDT: '100' }), saved = await stage(s);
    const next = accountFeesFixture({ now: s.f.funds.archive.startedAt + 3000, okxUSDT: '100' });
    next.funds.archive.archiveId = id(22); next.archive.archiveId = id(23);
    next.archive.okx.fees.takerRateRaw = '-0.01'; next.archive.okx.fees.takerCostRate = '0.01';
    const updated = await importFeeBoundAccountFundsJournalEvidence(s.directory, paired(next), saved.checkpoint, next.now);
    const proposedWithNewCap = proposed(2); proposedWithNewCap.feeCaps.USDT = '0.1';
    await expect(stageFeeBoundAccountFundsJournalIntent(s.directory, { intent: proposedWithNewCap, bindingKey: next.bindingKey },
      updated.checkpoint, next.now + 1)).rejects.toThrow('journal-policy-blocked');
    expect((await readFeeBoundAccountFundsJournal(s.directory, next.bindingKey)).preparedIntents).toEqual([proposed()]);
    const released = await releaseFeeBoundAccountFundsJournalIntent(s.directory,
      { intentId: id(1), reason: 'operator-released', bindingKey: next.bindingKey }, updated.checkpoint, next.now + 2);
    const accepted = await stageFeeBoundAccountFundsJournalIntent(s.directory, { intent: proposedWithNewCap, bindingKey: next.bindingKey },
      released.checkpoint, next.now + 3);
    expect(accepted.preparedIntents).toEqual([proposedWithNewCap]);
  });
  it('serializes concurrent reservations under one head and retains the accepted reserve', async () => {
    const s = await imported(); const responses = await Promise.allSettled([stage(s, 1), stage(s, 2)]);
    expect(responses.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    const rejected = responses.find(row => row.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason.code).toBe('journal-head-conflict');
    const read = await readFeeBoundAccountFundsJournal(s.directory, s.f.bindingKey);
    expect(read.preparedIntents).toHaveLength(1);
    await expect(stage(s, 3, read.checkpoint, s.f.now + 2)).rejects.toThrow('journal-policy-blocked');
  });
  it('rejects expired funds even when the tariff snapshot is still fresh', async () => {
    const s = await imported();
    await expect(stage(s, 1, s.current.checkpoint, s.f.funds.archive.startedAt + 60_001)).rejects.toThrow('journal-evidence-invalid');
  });
  it('rejects expired tariffs even when the funds snapshot is still fresh', async () => {
    const s = await setup(), f = s.f;
    const newerFunds = accountFeesFixture({ now: f.funds.archive.startedAt + 2_000 });
    // Same authenticated pin for both observations, with a later funds response sequence.
    const nextFunds = newerFunds.funds.archive;
    nextFunds.pinHash = f.funds.archive.pinHash; nextFunds.selectionReceipt = f.funds.archive.selectionReceipt;
    const raw = Buffer.from(JSON.stringify(nextFunds) + '\n'), pair = paired(f);
    pair.funds = { archiveBytes: raw, receipt: { schema: 1, kind: 'account-funds-observation-receipt',
      archiveId: nextFunds.archiveId, archiveHash: createHash('sha256').update(raw).digest('hex') } };
    const current = await importFeeBoundAccountFundsJournalEvidence(s.directory, pair, s.initial.checkpoint, f.now + 3000);
    await expect(stageFeeBoundAccountFundsJournalIntent(s.directory, { intent: proposed(), bindingKey: f.bindingKey },
      current.checkpoint, f.archive.startedAt + 60_001)).rejects.toThrow('journal-evidence-invalid');
  });
  it.each(['collector', 'uid', 'bundle', 'pin', 'hash', 'declared', 'oversize'])('rejects invalid %s tariff input without partial import', async kind => {
    const s = await setup(), f = s.f;
    if (kind === 'collector') f.archive.collectorSourceHash = 'd'.repeat(64);
    if (kind === 'uid') f.archive.okx.identity.uid = '123';
    if (kind === 'bundle') f.archive.bundleVersion = id(31);
    if (kind === 'pin') f.archive.pinHash = 'd'.repeat(64);
    const value = paired(f);
    if (kind === 'hash') value.fees.receipt.archiveHash = 'd'.repeat(64);
    if (kind === 'declared') value.fees.archiveBytes = Buffer.from('{"kind":"declared-order-fee-evidence"}\n');
    if (kind === 'oversize') value.fees.archiveBytes = Buffer.alloc(128 * 1024 + 1);
    await expect(importFeeBoundAccountFundsJournalEvidence(s.directory, value, s.initial.checkpoint, f.now)).rejects.toThrow('journal-evidence-invalid');
    expect((await readdir(s.directory)).sort()).toEqual(['manifest.json']);
  });
  it.each(['declared-event', 'record-schema', 'extra-fee'])('rejects replay downgrade through %s even with a recomputed record hash', async kind => {
    const s = await imported(); await stage(s);
    await mutateRecord(s.directory, '000002.json', record => {
      if (kind === 'declared-event') record.event = { ...record.event, type: 'intent-staged', feeEvidence: {} };
      if (kind === 'record-schema') record.schema = 1;
      if (kind === 'extra-fee') record.event.feeEvidence = { makerRate: '0', takerRate: '0' };
    });
    await expect(readFeeBoundAccountFundsJournal(s.directory, s.f.bindingKey)).rejects.toThrow(/journal-(invalid|event-invalid)/);
  });
  it('requires the correct schema on an otherwise matching checkpoint', async () => {
    const s = await imported(); const forged = { ...s.current.checkpoint, schema: 1 as const };
    await expect(stage(s, 1, forged)).rejects.toThrow('journal-head-conflict');
  });
  it('rejects a reused capture and an older fee observation', async () => {
    const s = await imported();
    await expect(importFeeBoundAccountFundsJournalEvidence(s.directory, paired(s.f), s.current.checkpoint, s.f.now + 1)).rejects.toThrow('journal-evidence-invalid');
    const next = accountFeesFixture({ now: s.f.funds.archive.startedAt - 1 });
    next.funds.archive.archiveId = id(41); next.archive.archiveId = id(42);
    await expect(importFeeBoundAccountFundsJournalEvidence(s.directory, paired(next), s.current.checkpoint, s.f.now + 1)).rejects.toThrow('journal-evidence-invalid');
  });
  it('preserves private-file permissions and fixed errors', async () => {
    const s = await imported(); await chmod(join(s.directory, '000001.json'), 0o644);
    await expect(readFeeBoundAccountFundsJournal(s.directory, s.f.bindingKey)).rejects.toThrow('journal-invalid');
  });
  it('does not expose raw account identifiers, tariff records, archive bytes or keys in a private snapshot', async () => {
    const s = await imported(), output = JSON.stringify(await stage(s));
    expect(output).not.toMatch(/PRIVATE_MEXC_UID|9876543212345678901|SYNTHETIC_|makerRate|takerRate|pinHash|bundleVersion|bindingKey|archiveBytes/);
    // Snapshot exposes prepared intents privately by design; the CLI below produces the safe public receipt.
  });
  it('does not create defaults when user limits have not been chosen', async () => {
    const s = await imported({}, null); await expect(stage(s)).rejects.toThrow('journal-policy-blocked');
  });
});
