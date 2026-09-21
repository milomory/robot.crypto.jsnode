import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { replayScenario } from '../src/paper-v2/replay.js';
import { canonical } from '../src/paper-v2/ledger.js';
import type { Scenario } from '../src/paper-v2/schema.js';

const fixture = JSON.parse(await readFile(new URL('../fixtures/paper-v2/basic.json', import.meta.url), 'utf8')) as Scenario;
const fresh = () => structuredClone(fixture);

describe('offline exact replay and period comparisons', () => {
  it('reconciles a hand-calculated buy, partial sale and open-position drawdown', () => {
    const r = replayScenario(fixture);
    expect(r.runId).toBe(`pv2-${r.inputHash}`);
    expect(replayScenario({ ...fixture, costs: { ...fixture.costs, feeBps: 11 } }).runId).not.toBe(r.runId);
    expect(r.strategy.counts).toEqual({ filled: 2, rejected: 1, marked: 1 });
    expect(r.strategy.events[2].reason).toBe('insufficient-base');
    expect(r.strategy.finalAccount.balances.bybit).toEqual({ USDT: '940.18937020', BTC: '0.00060000' });
    expect(r.strategy.finalAccount).toMatchObject({ costBasisUSDT: '60.09003000',
      realisedPnLUSDT: '0.27940020', feesUSDT: '0.14042980', reconciled: true });
    expect(r.strategy.performance).toMatchObject({ complete: true, expectedPoints: 5,
      startingEquityUSDT: '1000.00000000', finalEquityUSDT: '998.90119960',
      equityChangeUSDT: '-1.09880040', maxDrawdownUSDT: '1.79730090', returnPercent: '-0.109880' });
    expect(r.strategy.valuationSeries.at(-1)?.valuation).toMatchObject({ unrealisedPnLUSDT: '-1.37820060' });
    expect(r.benchmarks.baseline.label).toBe('cash');
    expect(r.benchmarks.baseline.performance.finalEquityUSDT).toBe('1000.00000000');
    expect(r.benchmarks.buyAndHold.performance.finalEquityUSDT).toBe('997.70299900');
    expect(r.comparison.comparable).toBe(true);
  });

  it('gives byte-identical output independent of wall-clock time and input object key order', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1);
    try {
      const first = canonical(replayScenario(fixture));
      clock.mockReturnValue(9_000_000_000_000);
      expect(canonical(replayScenario(Object.fromEntries(Object.entries(fixture).reverse())))).toBe(first);
    } finally { clock.mockRestore(); }
  });

  it('does not label incomplete valuations as a complete-period return or drawdown', () => {
    const input = fresh();
    input.steps[2].book!.receivedAt = input.steps[2].at - 6_000;
    input.steps[2].book!.requestedAt = input.steps[2].at - 6_100;
    const r = replayScenario(input);
    expect(r.strategy.performance).toMatchObject({ complete: false, availablePoints: 4, expectedPoints: 5,
      equityChangeUSDT: null, returnPercent: null, maxDrawdownUSDT: null, maxDrawdownPercent: null });
    expect(r.strategy.valuationSeries[3].valuation).toMatchObject({ available: false });
    expect(r.benchmarks.baseline.performance.complete).toBe(true);
    expect(r.comparison.comparable).toBe(false);
  });

  it('makes failed benchmark entry explicit, with no implicit retry at a later snapshot', () => {
    const input = fresh(); delete input.steps[0].book;
    const r = replayScenario(input);
    expect(r.benchmarks.buyAndHold.entryAccepted).toBe(false);
    expect(r.benchmarks.buyAndHold.counts).toEqual({ filled: 0, rejected: 1, marked: 3 });
    expect(r.comparison.comparable).toBe(false);
  });

  it('deduplicates identical events but refuses ID conflicts and chronology changes', () => {
    const input = fresh(); input.steps.push(structuredClone(input.steps[0]));
    const r = replayScenario(input);
    expect(r.strategy).toEqual(replayScenario(fixture).strategy);
    expect(r.period).toMatchObject({ inputSteps: 5, uniqueSteps: 4 });
    input.steps.at(-1)!.intent!.quantity = '0.002';
    expect(() => replayScenario(input)).toThrow('event-id-conflict');
    const wrongOrder = fresh(); [wrongOrder.steps[0], wrongOrder.steps[1]] = [wrongOrder.steps[1], wrongOrder.steps[0]];
    expect(() => replayScenario(wrongOrder)).toThrow('out-of-order-event');
  });

  it('labels an opening BTC baseline accurately and includes its opening unrealised P/L', () => {
    const input = fresh(); input.opening = { USDT: '900', BTC: '0.001', costBasisUSDT: '90' };
    input.steps = input.steps.map(({ intent, ...step }) => step);
    const r = replayScenario(input);
    expect(r.benchmarks.baseline.label).toBe('hold-opening-assets');
    expect(r.strategy.finalAccount.costBasisUSDT).toBe('90.00000000');
    expect(r.strategy.performance.complete).toBe(true);
    expect(r.strategy.performance.startingEquityUSDT).toBe('999.84006499');
    expect(r.strategy.performance.finalEquityUSDT).toBe('997.85304900');
    expect(r.strategy.performance.equityChangeUSDT).toBe('-1.98701599');
    expect(r.strategy.finalAccount.realisedPnLUSDT).toBe('0.00000000');
  });

  it('never divides by zero or invents percentage returns for an empty account', () => {
    const input = fresh(); input.opening.USDT = '0';
    const r = replayScenario(input);
    expect(r.strategy.performance).toMatchObject({ complete: true, finalEquityUSDT: '0.00000000',
      returnPercent: null, maxDrawdownPercent: null, maxDrawdownUSDT: '0.00000000' });
    expect(r.strategy.counts.filled).toBe(0);
  });

  it('keeps valuation products beyond the input decimal bound exact', () => {
    const input = fresh();
    input.opening = { USDT: '0', BTC: '10000000000000000000', costBasisUSDT: '0' };
    input.costs = { feeBps: 0, slippageBps: 0, feeAsset: 'USDT' };
    input.instrument.maxQuantity = '10000000000000000000';
    input.steps = [{ ...input.steps[0], intent: undefined }];
    input.steps[0].book!.bids = [['10000000000000000000', '10000000000000000000']];
    input.steps[0].book!.asks = [['10000000000000000001', '10000000000000000000']];
    const r = replayScenario(input);
    expect(r.strategy.performance).toMatchObject({ complete: true,
      startingEquityUSDT: '100000000000000000000000000000000000000.00000000',
      equityChangeUSDT: '0.00000000' });
  });

  it('refuses numeric monetary inputs, unsupported fee assets, unbounded or non-fixture inputs', () => {
    for (const mutate of [
      (s: any) => { s.opening.USDT = 1000; },
      (s: any) => { s.costs.feeAsset = 'BTC'; },
      (s: any) => { s.steps = Array(1001).fill(s.steps[0]); },
      (s: any) => { s.synthetic = false; },
      (s: any) => { s.credential = 'PRIVATE_SENTINEL'; }
    ]) {
      const input = fresh(); mutate(input);
      expect(() => replayScenario(input)).toThrow('invalid-scenario');
    }
  });
});
