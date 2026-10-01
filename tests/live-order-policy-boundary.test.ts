/** Independent adverse cases: durable policy, exact monetary boundaries and cross-process replay. */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { appendLiveOrderJournal, createPolicyBoundLiveOrderJournal, readLiveOrderJournal,
  type LiveOrderJournalSnapshot } from '../src/live/order-journal.js';
import { assessLiveOrderAdmission } from '../src/live/order-admission-policy.js';
import { canonicalLiveOrderJson, deriveLiveClientOrderId } from '../src/live/order-lifecycle.js';

const roots: string[] = [], run = promisify(execFile);
const id = (n: number) => `90000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (n: number) => new Date(Date.UTC(2026, 8, 28, 12, 0, n)).toISOString();
const intent = (n: number, venue: 'mexc' | 'okx' = 'mexc') => ({ type: 'intent-created' as const, eventId: id(n), at: at(n),
  intent: { orderIntentId: id(n + 1000), venue, account: 'main', symbol: 'BTC/USDT', side: 'buy', orderType: 'limit',
    baseQuantity: '0.0001', limitPrice: '100000', maxQuoteAmount: '10', feeCaps: { BTC: '0', USDT: '0.1', MX: '0' } } });
const policy = () => ({ schema: 1, kind: 'live-order-admission-policy', source: 'declared-synthetic',
  limits: { schema: 1, kind: 'live-limits-draft', account: 'main', symbol: 'BTC/USDT',
    totalCapitalUsdt: '40', capitalByVenueUsdt: { mexc: '20', okx: '20' }, maxOrderDebitUsdt: '15',
    maxCumulativeLossUsdt: '30', maxUnhedgedBtc: '0.001', includeEarn: false, transfersEnabled: false, withdrawalsEnabled: false },
  initialBalances: { mexc: { BTC: '0', USDT: '100', MX: '0' }, okx: { BTC: '0', USDT: '100', MX: '0' } } });
async function fresh(input = policy()) {
  const root = await mkdtemp(join(tmpdir(), 'live-policy-independent-')); roots.push(root);
  const directory = join(root, 'journal');
  return { root, directory, snapshot: await createPolicyBoundLiveOrderJournal(directory, input), input };
}
function identity(n: number, venue: 'mexc' | 'okx' = 'mexc') {
  return { venue, account: 'main', symbol: 'BTC/USDT', side: 'buy', clientOrderId: deriveLiveClientOrderId(venue, id(n + 1000)), exchangeOrderId: `order-${n}` };
}
function dispatch(n: number, time: number, venue: 'mexc' | 'okx' = 'mexc') {
  return { type: 'dispatch-marked', eventId: id(100 + time), at: at(time), orderIntentId: id(n + 1000), clientOrderId: identity(n, venue).clientOrderId };
}
async function settledBuy(directory: string, original: LiveOrderJournalSnapshot, partial = false) {
  let snapshot = await appendLiveOrderJournal(directory, intent(1), original.checkpoint);
  snapshot = await appendLiveOrderJournal(directory, dispatch(1, 2), snapshot.checkpoint);
  const quantity = partial ? '0.00005' : '0.0001', quote = partial ? '5' : '10', fee = partial ? '0.05' : '0.1';
  snapshot = await appendLiveOrderJournal(directory, { type: 'fill-recorded', eventId: id(103), at: at(3), orderIntentId: id(1001),
    identity: identity(1), source: 'synthetic', fill: { fillId: 'fill-1', executedAt: at(3), baseQuantity: quantity, quoteQuantity: quote,
      quoteAmountSource: 'reported', fees: { BTC: '0', USDT: fee, MX: '0' } } }, snapshot.checkpoint);
  snapshot = await appendLiveOrderJournal(directory, { type: 'order-observed', eventId: id(104), at: at(4), orderIntentId: id(1001),
    observation: { identity: identity(1), source: 'synthetic', status: partial ? 'canceled' : 'filled', cumulativeBaseQuantity: quantity,
      cumulativeQuoteQuantity: quote, quoteAmountSource: 'reported' } }, snapshot.checkpoint);
  return appendLiveOrderJournal(directory, { type: 'terminal-reconciled', eventId: id(105), at: at(5),
    orderIntentId: id(1001), observationEventId: id(104) }, snapshot.checkpoint);
}
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('independent policy journal boundaries', () => {
  it('keeps earlier valid admissions readable after a later quarantined expense and blocks a saved second dispatch', async () => {
    const { directory, snapshot } = await fresh();
    let current = await appendLiveOrderJournal(directory, intent(1), snapshot.checkpoint);
    current = await appendLiveOrderJournal(directory, intent(2, 'okx'), current.checkpoint);
    current = await appendLiveOrderJournal(directory, dispatch(1, 3), current.checkpoint);
    const expense = { type: 'fill-quarantined', eventId: id(104), at: at(4), orderIntentId: id(1001), identity: identity(1),
      source: 'synthetic', fill: { fillId: 'fill-1', executedAt: at(4), baseQuantity: '0.0001', quoteQuantity: '10',
        quoteAmountSource: 'reported', fees: { BTC: '0', USDT: '0.2', MX: '0' } } };
    current = await appendLiveOrderJournal(directory, expense, current.checkpoint);
    const reloaded = await readLiveOrderJournal(directory, current.checkpoint);
    expect(reloaded.state.orders.map(row => row.phase)).toEqual(['quarantined', 'prepared']);
    expect(reloaded.state.orders[0].cashDelta.USDT).toBe('-10.2');
    await expect(appendLiveOrderJournal(directory, dispatch(2, 5, 'okx'), current.checkpoint)).rejects.toThrow('journal-policy-blocked');
    expect((await appendLiveOrderJournal(directory, intent(1), snapshot.checkpoint)).appended).toBe(false);
    expect((await appendLiveOrderJournal(directory, expense, snapshot.checkpoint)).appended).toBe(false);
    expect((await readLiveOrderJournal(directory)).revision).toBe(4);
  });

  it('retains exact lifetime outflow after partial cancellation and rejects a one-attounit excess', async () => {
    const input = policy(); input.limits.maxCumulativeLossUsdt = '15.15';
    const { directory, snapshot } = await fresh(input), settled = await settledBuy(directory, snapshot, true);
    const exact = intent(6), above = intent(7); above.intent.feeCaps.USDT = '0.100000000000000001';
    const accepted = assessLiveOrderAdmission(settled.state, exact, input), denied = assessLiveOrderAdmission(settled.state, above, input);
    expect(accepted.allowedForRehearsal).toBe(true);
    expect(accepted.diagnostics).toMatchObject({ knownGrossUsdtOutflow: '5.05', reservedAndProposedUsdt: '10.1', grossUsdtOutflowUpperBound: '15.15' });
    expect(denied.reasons).toContain('gross-usdt-outflow-limit');
    expect(denied.diagnostics?.grossUsdtOutflowUpperBound).toBe('15.150000000000000001');
    await expect(appendLiveOrderJournal(directory, above, settled.checkpoint)).rejects.toThrow('journal-policy-blocked');
    const admitted = await appendLiveOrderJournal(directory, exact, settled.checkpoint);
    expect((await readLiveOrderJournal(directory, admitted.checkpoint)).state.orders[0].reserved.USDT).toBe('0');
  });

  it('does not lend another venue acquired BTC and does not net opposite pending legs out of exposure', async () => {
    const input = policy(); input.limits.maxUnhedgedBtc = '0.0001';
    const { directory, snapshot } = await fresh(input), settled = await settledBuy(directory, snapshot);
    const foreignSell = intent(6, 'okx'); foreignSell.intent.side = 'sell';
    const foreign = assessLiveOrderAdmission(settled.state, foreignSell, input);
    expect(foreign.reasons).toContain('insufficient-wallet-funds');
    expect(foreign.diagnostics?.insufficientFunds).toContainEqual({ venue: 'okx', asset: 'BTC' });
    const ownSell = intent(6); ownSell.intent.side = 'sell';
    const selling = await appendLiveOrderJournal(directory, ownSell, settled.checkpoint);
    const buy = assessLiveOrderAdmission(selling.state, intent(7, 'okx'), input);
    expect(buy.reasons).toContain('unhedged-btc-limit');
    expect(buy.diagnostics?.unhedgedBtcInterval).toEqual({ lower: '0', upper: '0.0002', largestAbsolute: '0.0002' });
  });

  it('rechecks a previously prepared intent after another dispatched order became unknown', async () => {
    const { directory, snapshot } = await fresh();
    let current = await appendLiveOrderJournal(directory, intent(1), snapshot.checkpoint);
    current = await appendLiveOrderJournal(directory, intent(2, 'okx'), current.checkpoint);
    current = await appendLiveOrderJournal(directory, dispatch(1, 3), current.checkpoint);
    await expect(appendLiveOrderJournal(directory, dispatch(2, 4, 'okx'), current.checkpoint)).rejects.toThrow('journal-policy-blocked');
    const restart = await readLiveOrderJournal(directory, current.checkpoint);
    expect(restart.state.orders[1].dispatchEventId).toBeNull();
    expect(restart.state.orders[1].reserved.USDT).toBe('10.1');
  });

  it('permits only one separate process to consume a shared admission checkpoint', async () => {
    const { directory, snapshot } = await fresh();
    const source = `const {appendLiveOrderJournal}=await import('./src/live/order-journal.ts');try{const v=await appendLiveOrderJournal(process.argv[1],JSON.parse(process.argv[2]),JSON.parse(process.argv[3]));console.log(JSON.stringify({ok:true,appended:v.appended}));}catch(e){console.log(JSON.stringify({ok:false,reason:e.reason}));}`;
    const calls = [intent(1), intent(2)].map(event => run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source,
      directory, JSON.stringify(event), JSON.stringify(snapshot.checkpoint)]));
    const results = await Promise.all(calls);
    expect(results.every(row => row.stderr === '')).toBe(true);
    const statuses = results.map(row => JSON.parse(row.stdout));
    expect(statuses.filter(row => row.ok)).toHaveLength(1);
    expect(statuses.filter(row => !row.ok)).toEqual([{ ok: false, reason: 'journal-head-conflict' }]);
    const current = await readLiveOrderJournal(directory);
    expect(current.revision).toBe(1);
    const other = current.state.orders[0].intent.orderIntentId === id(1001) ? intent(2) : intent(1);
    // Make its timestamp monotonic so the test specifically exercises policy, not event ordering.
    other.at = at(3);
    await expect(appendLiveOrderJournal(directory, other, current.checkpoint)).rejects.toThrow('journal-policy-blocked');
  });

  it('rejects a correctly rehashed mixed-version event and a foreign checkpoint schema', async () => {
    const { directory, snapshot } = await fresh();
    await expect(appendLiveOrderJournal(directory, intent(1), { ...snapshot.checkpoint, schema: 1 })).rejects.toThrow('journal-head-conflict');
    const body = { schema: 1, kind: 'live-order-rehearsal-event', journalId: snapshot.journalId, sequence: 1,
      previousHash: snapshot.headHash, event: intent(1) };
    await writeFile(join(directory, '000001.json'), JSON.stringify({ ...body,
      hash: createHash('sha256').update(canonicalLiveOrderJson(body)).digest('hex') }), { mode: 0o600 });
    await expect(readLiveOrderJournal(directory, snapshot.checkpoint)).rejects.toThrow('journal-invalid');
  });

  it('normalizes the bound policy once and rejects a later noncanonical policy even with a rebuilt manifest hash', async () => {
    const input = policy(); input.limits.maxCumulativeLossUsdt = '30.0000';
    const { directory, snapshot } = await fresh(input);
    expect(snapshot.admissionPolicy?.limits.maxCumulativeLossUsdt).toBe('30');
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    manifest.admissionPolicy.limits.maxCumulativeLossUsdt = '30.0000';
    const { hash: _, ...body } = manifest;
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ ...body,
      hash: createHash('sha256').update(canonicalLiveOrderJson(body)).digest('hex') }));
    await expect(readLiveOrderJournal(directory)).rejects.toThrow('journal-policy-invalid');
  });
});
