import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { canonical } from '../src/paper-v2/ledger.js';
import { formatAmount, parseAmount } from '../src/paper-v2/exact.js';
import { replayScenario } from '../src/paper-v2/replay.js';
import { scenarioSchema, type Scenario } from '../src/paper-v2/schema.js';
import { runStudy, STUDY_POLICY } from '../src/paper-v2/study.js';

const START = 1_700_000_000_000;
type Synthetic = Extract<Scenario, { schema: 1 }>;
type Observed = Extract<Scenario, { schema: 2 }>;
const trend = ['100000', '100100', '100200', '100300', '100400', '100500', '100600',
  '99000', '98000', '97000', '96000', '95000', '94000'];
function fixture(prices: string[] = trend): Synthetic {
  return { schema: 1, model: 'paper-v2-exact-1', synthetic: true, scenarioId: 'causal-study-fixture',
    venue: 'bybit', symbol: 'BTC/USDT', opening: { USDT: '1000', BTC: '0' },
    costs: { feeBps: 10, slippageBps: 5, feeAsset: 'USDT' },
    instrument: { venue: 'bybit', symbol: 'BTC/USDT', fetchedAt: START - 1000, trading: true,
      minQuantity: '0.000001', maxQuantity: '10', quantityStep: '0.000001', minNotional: '0.01' },
    benchmark: { buyQuantityBTC: '0.001' },
    steps: prices.map((price, index) => {
      const at = START + index * 30000;
      return { id: `sample-${index}`, at, book: { venue: 'bybit', symbol: 'BTC/USDT',
        requestedAt: at - 20, receivedAt: at - 10, sourceAt: at - 15,
        bids: [[formatAmount(parseAmount(price) - 1n), '1']],
        asks: [[formatAmount(parseAmount(price) + 1n), '1']] } };
    }) };
}
// These are schema-contract fixtures only, not actual observed market evidence.
function observed(policy: Observed['marketData']['policy'] = 'fixed-study-30m-v1'): Observed {
  const { schema, synthetic, ...base } = fixture(policy === 'fixed-study-30m-v1'
    ? Array.from({ length: 60 }, (_, i) => String(100000 + i * 100)) : trend.slice(0, 6));
  return { ...base, schema: 2, funding: 'synthetic', marketData: {
    kind: 'public-decimal-observations', schema: 1, captureId: '0f47b8aa-4a89-4414-b4ee-3f2bb63ddd3d',
    datasetHash: 'a'.repeat(64), policy } };
}
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

describe('fixed causal offline study', () => {
  it('waits for six prior observations, trades at next book and preserves every valuation point', () => {
    const input = fixture();
    const report = runStudy(input);
    expect(report.decisions.slice(0, 6).every(d => d.signal === 'warmup' && d.action === 'mark')).toBe(true);
    expect(report.decisions[6]).toMatchObject({ executionSequence: 6, observedThrough: 5,
      observedThroughId: 'sample-5', signal: 'above-band', action: 'buy', status: 'filled',
      beforeBTC: '0.00000000', afterBTC: '0.00100000' });
    expect(report.decisions[8]).toMatchObject({ observedThrough: 7, signal: 'below-band', action: 'sell', status: 'filled' });
    expect(report.result.strategy.counts).toEqual({ filled: 2, rejected: 0, marked: trend.length - 2 });
    expect(report.scenario.steps.map(s => s.at)).toEqual(input.steps.map(s => s.at));
    expect(report.result.strategy.valuationSeries).toHaveLength(trend.length + 1);
    expect(report.result.strategy.finalAccount.reconciled).toBe(true);
    expect(report.decisions.every(d => d.observedThrough === null || d.observedThrough < d.executionSequence)).toBe(true);
  });

  it('produces identical prior decisions, fills and balances when only future books change', () => {
    const input = fixture();
    const changed = structuredClone(input);
    for (let i = 8; i < changed.steps.length; i++) {
      changed.steps[i].book!.bids[0][0] = '500000';
      changed.steps[i].book!.asks[0][0] = '500001';
    }
    const originalReport = runStudy(input), changedReport = runStudy(changed);
    expect(changedReport.decisions.slice(0, 8)).toEqual(originalReport.decisions.slice(0, 8));
    expect(changedReport.result.strategy.events.slice(0, 8)).toEqual(originalReport.result.strategy.events.slice(0, 8));
    const prefixReport = runStudy({ ...input, steps: input.steps.slice(0, 8) });
    expect(prefixReport.decisions).toEqual(originalReport.decisions.slice(0, 8));
    expect(prefixReport.result.strategy.events).toEqual(originalReport.result.strategy.events.slice(0, 8));
  });

  it('does not consume the current execution price in its signal', () => {
    const first = fixture(), second = fixture();
    second.steps[6].book!.bids[0][0] = '200000'; second.steps[6].book!.asks[0][0] = '200001';
    const a = runStudy(first), b = runStudy(second);
    for (const key of ['signal', 'action', 'fastSumTwiceMidAtoms', 'slowSumTwiceMidAtoms', 'observedThrough'] as const) {
      expect(b.decisions[6][key]).toEqual(a.decisions[6][key]);
    }
    expect(b.result.strategy.events[6].postings.USDT).not.toEqual(a.result.strategy.events[6].postings.USDT);
  });

  it('uses strict exact hysteresis boundaries without rounding an average', () => {
    const equal = runStudy(fixture(['999', '999', '999', '1001', '1001', '1001', '1000']));
    expect(equal.decisions[6].signal).toBe('neutral');
    const above = runStudy(fixture(['999', '999', '999', '1001', '1001', '1001.00000001', '1000']));
    expect(above.decisions[6].signal).toBe('above-band');
    const belowEqual = runStudy(fixture(['1001', '1001', '1001', '999', '999', '999', '1000']));
    expect(belowEqual.decisions[6].signal).toBe('neutral');
    const below = runStudy(fixture(['1001', '1001', '1001', '999', '999', '998.99999999', '1000']));
    expect(below.decisions[6].signal).toBe('below-band');
  });

  it('preserves subatom midpoints and decimal values beyond binary integer precision', () => {
    const input = fixture(Array(7).fill('9007199254740992.00000001'));
    input.steps[5].book!.asks[0][0] = '9007199254740992.00000003';
    const decision = runStudy(input).decisions[6];
    expect(decision.fastSumTwiceMidAtoms).toBe(String(parseAmount('9007199254740992.00000001') * 6n + 1n));
    expect(decision.slowSumTwiceMidAtoms).toBe(String(parseAmount('9007199254740992.00000001') * 12n + 1n));
    expect(decision.signal).toBe('neutral');
  });

  it('keeps a failed buy flat and can retry only from the next causal signal', () => {
    const input = fixture();
    input.steps[6].book!.asks[0][1] = '0.0001';
    const report = runStudy(input);
    expect(report.decisions[6]).toMatchObject({ action: 'buy', status: 'rejected', reason: 'insufficient-depth',
      beforeBTC: '0.00000000', afterBTC: '0.00000000' });
    expect(report.decisions[7]).toMatchObject({ action: 'buy', status: 'filled', afterBTC: '0.00100000' });
    expect(report.result.strategy.finalAccount.reconciled).toBe(true);
  });

  it('keeps a failed sell invested and can sell on a later signal without inventing a position', () => {
    const input = fixture(); input.steps[8].book!.bids[0][1] = '0.0001';
    const report = runStudy(input);
    expect(report.decisions[8]).toMatchObject({ action: 'sell', status: 'rejected', reason: 'insufficient-depth',
      beforeBTC: '0.00100000', afterBTC: '0.00100000' });
    expect(report.decisions[9]).toMatchObject({ action: 'sell', status: 'filled', afterBTC: '0.00000000' });
    expect(report.result.strategy.performance.complete).toBe(false);
    expect(report.result.comparison.comparable).toBe(false);
  });

  it('does not pyramid or liquidate merely because the window ends', () => {
    const report = runStudy(fixture(Array.from({ length: 12 }, (_, i) => String(100000 + i * 100))));
    expect(report.result.strategy.counts.filled).toBe(1);
    expect(report.result.strategy.finalAccount.balances.bybit.BTC).toBe('0.00100000');
    expect(report.decisions.at(-1)!.action).toBe('mark');
    expect(report.assumptions.endLiquidation).toBe(false);
  });

  it('discards every supplied intent and never mutates the source', () => {
    const input = fixture();
    for (const step of input.steps) step.intent = { side: 'sell', quantity: '10' };
    const before = canonical(input);
    const report = runStudy(input);
    expect(canonical(input)).toBe(before);
    expect(report).toEqual(runStudy(fixture()));
    expect(report.result).toEqual(replayScenario(report.scenario));
  });

  it('shares fixed funds, costs, entire window and benchmarks with independent replay', () => {
    const report = runStudy(fixture());
    const independent = replayScenario(report.scenario);
    expect(report.result.benchmarks).toEqual(independent.benchmarks);
    expect(report.result.comparison).toMatchObject({ sameStartingBalances: true, sameValuationSchedule: true });
    expect(report.result.benchmarks.baseline.label).toBe('cash');
    expect(report.result.benchmarks.buyAndHold.counts.filled).toBe(1);
    expect(report.result.strategy.finalAccount.feesUSDT).not.toBe('0.00000000');
    expect(report.funding).toBe('synthetic');
    expect(report.eligibility).toEqual({ eligible: false, reason: 'synthetic-fixture-only' });
  });

  it('keeps declared scenario provenance unverified and labels the legacy six-snapshot smoke test', () => {
    const study = runStudy(observed());
    expect(study.eligibility).toEqual({ eligible: false, reason: 'unverified-declared-protocol' });
    expect(study.scenario).toMatchObject({ schema: 2, executionPolicy: STUDY_POLICY });
    expect(study.result).toMatchObject({ schema: 2, funding: 'synthetic', executionPolicy: STUDY_POLICY });
    expect(study.result).not.toHaveProperty('synthetic');
    const smoke = runStudy(observed('fixed-probe-v1'));
    expect(smoke.eligibility).toEqual({ eligible: false, reason: 'legacy-probe-smoke-only' });
    expect(smoke.result.strategy.counts).toEqual({ filled: 0, rejected: 0, marked: 6 });
    expect(smoke.scenario).not.toHaveProperty('executionPolicy');
    expect(study.interpretation).toContain('not statistical adequacy');
  });

  it('cannot promote 60 arbitrary fresh observations into a validated collection protocol', () => {
    const input = observed();
    for (const [index, step] of input.steps.entries()) {
      step.at = START + index;
      step.book!.requestedAt = step.at;
      step.book!.receivedAt = step.at;
      step.book!.sourceAt = step.at;
    }
    expect(runStudy(input).eligibility).toEqual({ eligible: false, reason: 'unverified-declared-protocol' });
  });

  it('refuses to call a truncated declared long protocol eligible', () => {
    const input = observed(); input.steps.pop();
    expect(() => runStudy(input)).toThrow('invalid-study-period');
  });

  it.each([
    ['duplicate id', (s: Synthetic) => { s.steps[1].id = s.steps[0].id; }],
    ['out of order', (s: Synthetic) => { s.steps[1].at = s.steps[0].at; }],
    ['missing book', (s: Synthetic) => { delete s.steps[0].book; }],
    ['stale receipt', (s: Synthetic) => { s.steps[0].book!.receivedAt -= 10000; }],
    ['stale source', (s: Synthetic) => { s.steps[0].book!.sourceAt! -= 10000; }],
    ['future source', (s: Synthetic) => { s.steps[0].book!.sourceAt! += 10000; }],
    ['future metadata', (s: Synthetic) => { s.instrument.fetchedAt = s.steps[0].at + 1; }],
    ['old metadata', (s: Synthetic) => { s.instrument.fetchedAt = s.steps[0].at - 3600001; }],
    ['wrong venue', (s: Synthetic) => { s.steps[0].book!.venue = 'okx'; }],
    ['crossed prices', (s: Synthetic) => { s.steps[0].book!.bids[0][0] = '200000'; }],
    ['zero quantity deep in book', (s: Synthetic) => { s.steps[0].book!.bids.push(['99999', '0']); }],
    ['duplicate level deep in book', (s: Synthetic) => { s.steps[0].book!.asks.push([...s.steps[0].book!.asks[0]]); }],
    ['overlapping observations', (s: Synthetic) => { s.steps[1].at = s.steps[0].at + 1; s.steps[1].book = structuredClone(s.steps[0].book); }]
  ])('rejects the whole period for %s before signal generation', (_label, mutate) => {
    const input = fixture(); mutate(input);
    expect(() => runStudy(input)).toThrow();
  });

  it.each([
    ['opening cash', (s: Observed) => { s.opening.USDT = '2000'; }],
    ['opening BTC', (s: Observed) => { s.opening.BTC = '0.001'; s.opening.costBasisUSDT = '100'; }],
    ['opening basis', (s: Observed) => { s.opening.costBasisUSDT = '1'; }],
    ['quantity', (s: Observed) => { s.benchmark.buyQuantityBTC = '0.002'; }],
    ['fees', (s: Observed) => { s.costs.feeBps = 0; }],
    ['slippage', (s: Observed) => { s.costs.slippageBps = 0; }]
  ])('rejects altered declared %s', (_label, mutate) => {
    const input = observed(); mutate(input);
    expect(() => runStudy(input)).toThrow('invalid-study-assumptions');
  });

  it('makes executionPolicy strict and scoped to the new observed protocol', () => {
    expect(scenarioSchema.safeParse({ ...observed(), executionPolicy: STUDY_POLICY }).success).toBe(true);
    expect(scenarioSchema.safeParse({ ...observed('fixed-probe-v1'), executionPolicy: STUDY_POLICY }).success).toBe(false);
    expect(scenarioSchema.safeParse({ ...fixture(), executionPolicy: STUDY_POLICY }).success).toBe(false);
    expect(scenarioSchema.safeParse({ ...observed(), executionPolicy: 'tuned-policy' }).success).toBe(false);
  });

  it('is deterministic and offline', () => {
    const fetch = vi.fn(() => { throw new Error('NETWORK_SENTINEL'); });
    vi.stubGlobal('fetch', fetch);
    try {
      expect(canonical(runStudy(fixture()))).toBe(canonical(runStudy(fixture())));
      expect(fetch).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it('preserves the original schema1 artifact byte hash', async () => {
    const bytes = await readFile(new URL('../fixtures/paper-v2/basic.json', import.meta.url));
    const result = replayScenario(JSON.parse(bytes.toString('utf8')));
    const artifact = canonical({ ...result, provenance: { inputHash: result.inputHash, sourceFileSha256: sha256(bytes) } }) + '\n';
    expect(sha256(artifact)).toBe('28353f8f8e32e90f7ee76121c97de68e99a17571226ab06933c6295a05ffa47f');
  });
});
