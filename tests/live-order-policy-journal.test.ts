import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendLiveOrderJournal, createPolicyBoundLiveOrderJournal, readLiveOrderJournal } from '../src/live/order-journal.js';
import { canonicalLiveOrderJson as canonical, deriveLiveClientOrderId } from '../src/live/order-lifecycle.js';

const run = promisify(execFile), roots: string[] = [];
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const at = (value: number) => new Date(Date.UTC(2026, 8, 28, 12, 0, value)).toISOString();
const intent = (value = 1, venue = 'mexc') => ({ eventId: id(value), at: at(value), type: 'intent-created',
  intent: { orderIntentId: id(value + 100), venue, account: 'main', symbol: 'BTC/USDT', side: 'buy',
    orderType: 'limit', baseQuantity: '0.0001', limitPrice: '100000', maxQuoteAmount: '10',
    feeCaps: { BTC: '0', USDT: '0.1', MX: '0' } } });
const dispatch = (value = 1) => ({ eventId: id(value + 20), at: at(value + 20), type: 'dispatch-marked', orderIntentId: id(value + 100),
  clientOrderId: deriveLiveClientOrderId('mexc', id(value + 100)) });
const policy = () => ({ schema: 1, kind: 'live-order-admission-policy', source: 'declared-synthetic',
  limits: { schema: 1, kind: 'live-limits-draft', account: 'main', symbol: 'BTC/USDT',
    totalCapitalUsdt: '40', capitalByVenueUsdt: { mexc: '20', okx: '20' },
    maxOrderDebitUsdt: '15', maxCumulativeLossUsdt: '30', maxUnhedgedBtc: '0.001',
    includeEarn: false, transfersEnabled: false, withdrawalsEnabled: false },
  initialBalances: { mexc: { BTC: '0', USDT: '100', MX: '0' }, okx: { BTC: '0', USDT: '100', MX: '0' } } });
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fresh() {
  const root = await mkdtemp(join(tmpdir(), 'live-policy-journal-')); roots.push(root);
  const directory = join(root, 'journal'), input = policy();
  const snapshot = await createPolicyBoundLiveOrderJournal(directory, input);
  return { root, directory, input, snapshot };
}

describe('policy-bound order journal', () => {
  it('persists a private versioned policy, copies input before awaits, and replays it in another process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'live-policy-journal-')); roots.push(root);
    const directory = join(root, 'journal'), input = policy();
    const creation = createPolicyBoundLiveOrderJournal(directory, input);
    input.limits.maxOrderDebitUsdt = '999';
    const snapshot = await creation;
    expect(snapshot).toMatchObject({ schema: 2, nonExecutable: true, captureProvenanceVerified: false,
      admissionPolicy: { limits: { maxOrderDebitUsdt: '15' } }, checkpoint: { schema: 2 } });
    expect(Object.isFrozen(snapshot.admissionPolicy?.limits)).toBe(true);
    expect((await stat(join(directory, 'manifest.json'))).mode & 0o777).toBe(0o600);
    const saved = await appendLiveOrderJournal(directory, intent(), snapshot.checkpoint);
    const script = `globalThis.fetch=()=>{throw Error('forbidden')};const {readLiveOrderJournal}=await import('./src/live/order-journal.ts');const s=await readLiveOrderJournal(process.argv[1]);console.log(JSON.stringify({schema:s.schema,revision:s.revision,policy:s.admissionPolicy,nonExecutable:s.nonExecutable}));`;
    const result = await run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, directory]);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ schema: 2, revision: 1, nonExecutable: true,
      policy: { limits: { maxOrderDebitUsdt: '15' } } });
    expect((await readLiveOrderJournal(directory, saved.checkpoint)).state.orders[0].reserved.USDT).toBe('10.1');
  });

  it('rejects malformed policy before directory creation and does not expose supplied values', async () => {
    const { root } = await fresh();
    const directory = join(root, 'invalid');
    await expect(createPolicyBoundLiveOrderJournal(directory, { ...policy(), secret: 'PRIVATE_VALUE' }))
      .rejects.toThrow('journal-policy-invalid');
    expect(await readdir(root)).toEqual(['journal']);
  });

  it('enforces limits through the existing append API and never overwrites a bound policy', async () => {
    const { directory, snapshot } = await fresh();
    const manifest = await readFile(join(directory, 'manifest.json'), 'utf8');
    const first = await appendLiveOrderJournal(directory, intent(), snapshot.checkpoint);
    await expect(appendLiveOrderJournal(directory, intent(2), first.checkpoint)).rejects.toThrow('journal-policy-blocked');
    expect((await readLiveOrderJournal(directory)).revision).toBe(1);
    expect((await appendLiveOrderJournal(directory, intent(), snapshot.checkpoint)).appended).toBe(false);
    await expect(createPolicyBoundLiveOrderJournal(directory, policy())).rejects.toThrow('journal-write-failed');
    expect(await readFile(join(directory, 'manifest.json'), 'utf8')).toBe(manifest);
  });

  it('checks policy and reservation against the exact head competing writers publish', async () => {
    const { directory, snapshot } = await fresh();
    const results = await Promise.allSettled([appendLiveOrderJournal(directory, intent(), snapshot.checkpoint),
      appendLiveOrderJournal(directory, intent(2), snapshot.checkpoint)]);
    expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    const current = await readLiveOrderJournal(directory);
    expect(current.revision).toBe(1);
    const loser = current.state.orders[0].intent.orderIntentId === id(101) ? intent(2) : intent();
    await expect(appendLiveOrderJournal(directory, loser, current.checkpoint)).rejects.toThrow('journal-policy-blocked');
  });

  it('rechecks dispatch and retains observed expenses after admission must stop', async () => {
    const { directory, snapshot } = await fresh();
    let current = await appendLiveOrderJournal(directory, intent(), snapshot.checkpoint);
    current = await appendLiveOrderJournal(directory, dispatch(), current.checkpoint);
    await expect(appendLiveOrderJournal(directory, intent(22, 'okx'), current.checkpoint)).rejects.toThrow('journal-policy-blocked');
    const identity = { venue: 'mexc', account: 'main', symbol: 'BTC/USDT', side: 'buy',
      clientOrderId: deriveLiveClientOrderId('mexc', id(101)), exchangeOrderId: 'synthetic-order' };
    current = await appendLiveOrderJournal(directory, { eventId: id(23), at: at(23), type: 'fill-quarantined',
      orderIntentId: id(101), identity, source: 'synthetic', fill: { fillId: 'synthetic-fill', executedAt: at(21),
        baseQuantity: '0.0001', quoteQuantity: '10', quoteAmountSource: 'reported', fees: { BTC: '0', USDT: '0.2', MX: '0' } } }, current.checkpoint);
    expect(current.state.orders[0].cashDelta.USDT).toBe('-10.2');
    expect(current.state.orders[0].phase).toBe('quarantined');
    expect((await readLiveOrderJournal(directory, current.checkpoint)).state.orders[0].cashDelta.USDT).toBe('-10.2');
    await expect(appendLiveOrderJournal(directory, intent(24, 'okx'), current.checkpoint)).rejects.toThrow('journal-policy-blocked');
  });

  it('detects schema downgrade against the trusted checkpoint', async () => {
    const { directory, snapshot } = await fresh();
    await expect(readLiveOrderJournal(directory, { ...snapshot.checkpoint, schema: 1 })).rejects.toThrow('journal-head-conflict');
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    const body = { ...manifest }; delete body.hash; delete body.admissionPolicy; body.schema = 1;
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ ...body, hash: digest(body) }));
    await expect(readLiveOrderJournal(directory, snapshot.checkpoint)).rejects.toThrow('journal-head-conflict');
  });

  it('revalidates policy on replay even if an over-budget event has a correct chain hash', async () => {
    const { directory, snapshot } = await fresh();
    const oversized = intent(); oversized.intent.baseQuantity = '0.001'; oversized.intent.maxQuoteAmount = '100';
    const body = { schema: 2, kind: 'live-order-rehearsal-event', journalId: snapshot.journalId, sequence: 1,
      previousHash: snapshot.headHash, event: oversized };
    await writeFile(join(directory, '000001.json'), JSON.stringify({ ...body, hash: digest(body) }), { mode: 0o600 });
    await expect(readLiveOrderJournal(directory)).rejects.toThrow('journal-policy-blocked');
  });

  it('offers a runnable offline init-policy command and never accepts a report policy override', async () => {
    const { root, directory, snapshot } = await fresh();
    const file = join(root, 'policy.json'), cp = join(root, 'checkpoint.json');
    await writeFile(file, JSON.stringify(policy())); await writeFile(cp, JSON.stringify(snapshot.checkpoint));
    const initialized = await run(process.execPath, ['--import', 'tsx', 'src/scripts/live-order-rehearsal.ts',
      'init-policy', file, join(root, 'cli-journal')]);
    expect(JSON.parse(initialized.stdout)).toMatchObject({ checkpoint: { schema: 2 }, executable: false, rehearsalPolicyEnforced: true });
    const report = join(root, 'report');
    await run(process.execPath, ['--import', 'tsx', 'src/scripts/live-order-rehearsal.ts', 'inspect', directory, report, cp]);
    expect(JSON.parse(await readFile(join(report, 'report.json'), 'utf8'))).toMatchObject({ rehearsalPolicyEnforced: true,
      preparation: { readyToStart: false, limitsEnforced: false }, admissionPolicy: { source: 'declared-synthetic' } });
    await expect(run(process.execPath, ['--import', 'tsx', 'src/scripts/live-order-rehearsal.ts',
      'inspect', directory, join(root, 'override'), cp, file])).rejects.toThrow();
    expect(await readdir(root)).not.toContain('override');
  });
});
