import { describe, expect, it } from 'vitest';
import { assessUsdLimit, feeScenarios, sampledPersistence, selectedFeeScenario } from '../src/paper-pair/study-analysis.js';
import type { SampledDirection } from '../src/paper-pair/study-analysis.js';
import type { PairBook, PairCosts, PairVenue } from '../src/paper-pair/engine.js';
import { parsePairInstrument } from '../src/paper-pair/public.js';
import type { PairUsdIndex } from '../src/paper-pair/public.js';
import { T, rawInstrument } from './helpers/pair-fixtures.js';

function book(venue: PairVenue, bid: string, ask: string): PairBook {
  return { venue, symbol: 'BTC/USDT', bids: [[bid, '10']], asks: [[ask, '10']],
    requestedAt: T - 20, receivedAt: T - 10 };
}
function input(quantity = '1', okxFeeBps = '100', mexcFeeBps = '100') {
  const costs: Record<PairVenue, PairCosts> = {
    okx: { feeBps: okxFeeBps, slippageBps: '0', feeAsset: 'USDT' },
    mexc: { feeBps: mexcFeeBps, slippageBps: '0', feeAsset: 'USDT' }
  };
  return { buy: book('okx', '99', '100'), sell: book('mexc', '102', '103'), quantity, costs, now: T };
}
function usdRule(cap = '101') {
  const raw = rawInstrument('okx'); raw.data[0].maxMktAmt = cap;
  return parsePairInstrument('okx', raw, T - 200, T - 100);
}
function usdIndex(price = '1000'): PairUsdIndex {
  return { venue: 'okx', instrument: 'BTC-USD', requestedAt: T - 20, receivedAt: T - 10,
    sourceAt: T - 10, usdPerBtc: price };
}
function direction(sequence: number, netUsdt: string, buyVenue: PairVenue = 'mexc', at = T + sequence * 5_000): SampledDirection {
  return { sequence, at, netUsdt, buyVenue, sellVenue: buyVenue === 'mexc' ? 'okx' : 'mexc' };
}

describe('study fee-currency sensitivities', () => {
  it('separates quote-paid fees from BTC deducted on an OKX buy and exposes the same-gross inventory shortage', () => {
    const result = feeScenarios(input());
    // 1 BTC sold at 102 with 1% quote fee yields 100.98 USDT. Quote-paid buy costs 101.
    expect(result.quote).toEqual({ netUsdt: '-0.02', requiredBuyQuantityBtc: '1', receivedBtc: '1', residualBtc: '0' });
    // The smallest 8-decimal gross whose rounded-up 1% BTC fee leaves 1 BTC is 1.01010102.
    expect(result.okxReceivedBase).toEqual({
      netUsdt: '-0.030102', requiredBuyQuantityBtc: '1.01010102', receivedBtc: '1', residualBtc: '0',
      buyFeeBtc: '0.01010102', equalGrossResidualBtc: '-0.01', equalGrossCashDeltaUsdt: '0.98'
    });
    expect(result.baseFeeDecimals).toBe(8);
  });
  it('charges a grossed-up BTC purchase through actual depth instead of reusing the top ask', () => {
    const value = input('1', '100', '0');
    value.buy.asks = [['100', '1'], ['200', '1']];
    const result = feeScenarios(value);
    expect(result.quote.netUsdt).toBe('1');
    expect(result.okxReceivedBase.requiredBuyQuantityBtc).toBe('1.01010102');
    expect(result.okxReceivedBase.netUsdt).toBe('-0.020204');
    expect(result.okxReceivedBase.equalGrossCashDeltaUsdt).toBe('2');
    value.buy.asks = [['100', '1']];
    expect(() => feeScenarios(value)).toThrow('insufficient-depth');
  });
  it('preserves fractional basis points and conservatively rounds a nonzero BTC fee to one satoshi', () => {
    const value = input('0.0001', '0.125', '0');
    value.buy = book('okx', '49999', '50000'); value.sell = book('mexc', '51000', '51001');
    const result = feeScenarios(value);
    expect(result.quote.netUsdt).toBe('0.0999375');
    expect(result.okxReceivedBase).toMatchObject({ requiredBuyQuantityBtc: '0.00010001',
      receivedBtc: '0.0001', buyFeeBtc: '0.00000001', residualBtc: '0', netUsdt: '0.0995',
      equalGrossResidualBtc: '-0.00000001', equalGrossCashDeltaUsdt: '0.1' });
  });
  it('does not round an 18-decimal fee rate to zero or hide its inventory effect on a one-satoshi target', () => {
    const result = feeScenarios(input('0.00000001', '0.000000000000000001', '0'));
    expect(result.quote.netUsdt).toBe('0.00000001');
    expect(result.okxReceivedBase).toMatchObject({ requiredBuyQuantityBtc: '0.00000002', receivedBtc: '0.00000001',
      buyFeeBtc: '0.00000001', residualBtc: '0', equalGrossResidualBtc: '-0.00000001',
      netUsdt: '-0.00000098' });
    expect(() => feeScenarios(input('0.00000001', '0.0000000000000000001', '0'))).toThrow('invalid-decimal');
    expect(() => feeScenarios(input('0.000000001', '1', '0'))).toThrow('unsupported-study-fee');
  });
  it('does not invent a BTC fee for a MEXC buy or for a zero-rate OKX buy', () => {
    const reverse = input(); reverse.buy.venue = 'mexc'; reverse.sell.venue = 'okx';
    const result = feeScenarios(reverse);
    expect(result.okxReceivedBase).toMatchObject({ ...result.quote, buyFeeBtc: '0',
      equalGrossResidualBtc: '0', equalGrossCashDeltaUsdt: result.quote.netUsdt });
    const free = feeScenarios(input('1', '0', '0'));
    expect(free.okxReceivedBase).toMatchObject({ ...free.quote, buyFeeBtc: '0', equalGrossResidualBtc: '0' });
  });
});

describe('separate USD-denominated OKX cap diagnostic', () => {
  it('uses BTC times USD/BTC plus 1% and never treats maxMktSz or a USDT quote as the USD cap', () => {
    const rule = usdRule('101');
    rule.maxNotionalUsdt = '1';
    if (rule.evidence.venue === 'okx') rule.evidence.maxMktSz = '1';
    expect(assessUsdLimit(usdIndex(), rule, '0.1', T)).toEqual({
      basis: 'okx-btc-usd-index-proxy-1pct-buffer', exchangeAdmissionProven: false, quantityBtc: '0.1',
      bufferBps: '100', status: 'within-model-cap', maximumUsd: '101', bufferedNotionalUsd: '101', indexSourceAt: T - 10
    });
    expect(assessUsdLimit(usdIndex(), usdRule('100'), '0.1', T)).toMatchObject({
      status: 'above-model-cap', maximumUsd: '100', bufferedNotionalUsd: '101', exchangeAdmissionProven: false
    });
    // Public parsing still retains the unresolved admission rule; the proxy must not upgrade it.
    expect(rule.reason).toBe('usd-limit-unconverted');
    expect(rule.status).toBe('unsupported');
  });
  it('does not lose an 18-decimal excess at the exact USD cap boundary', () => {
    const result = assessUsdLimit(usdIndex('1000.000000000000000001'), usdRule('101'), '0.1', T);
    expect(result).toMatchObject({ status: 'above-model-cap', bufferedNotionalUsd: '101.000000000000000001' });
  });
  it('reports absent caps explicitly and fails closed for missing or wrong-venue rules', () => {
    expect(assessUsdLimit(null, usdRule(''), '0.1', T)).toMatchObject({ status: 'not-published', exchangeAdmissionProven: false });
    expect(assessUsdLimit(usdIndex(), null, '0.1', T)).toMatchObject({ status: 'unavailable', reason: 'missing-instrument' });
    const mexc = parsePairInstrument('mexc', rawInstrument('mexc'), T - 200, T - 100);
    expect(assessUsdLimit(usdIndex(), mexc, '0.1', T)).toMatchObject({ status: 'unavailable', reason: 'missing-instrument' });
  });
  it('enforces five-second request/source freshness, no future receipt, and one-hour metadata age', () => {
    const boundary = { ...usdIndex(), requestedAt: T - 5_000, receivedAt: T - 1, sourceAt: T - 5_000 };
    expect(assessUsdLimit(boundary, usdRule(), '0.1', T).status).toBe('within-model-cap');
    for (const index of [
      null,
      { ...boundary, requestedAt: T - 5_001 },
      { ...boundary, sourceAt: T - 5_001 },
      { ...usdIndex(), receivedAt: T + 1 },
      { ...usdIndex(), instrument: 'USDT-USD' as 'BTC-USD' },
      { ...usdIndex(), usdPerBtc: '1e3' }
    ]) expect(assessUsdLimit(index, usdRule(), '0.1', T)).toMatchObject({
      status: 'unavailable', reason: 'missing-stale-or-invalid-index', exchangeAdmissionProven: false
    });
    expect(assessUsdLimit(usdIndex(), { ...usdRule(), receivedAt: T - 3_600_000 }, '0.1', T).status).toBe('within-model-cap');
    for (const receivedAt of [T - 3_600_001, T + 1]) {
      expect(assessUsdLimit(usdIndex(), { ...usdRule(), receivedAt }, '0.1', T).status).toBe('unavailable');
    }
    for (const quantity of ['0', '1e-1', '-0.1']) {
      expect(assessUsdLimit(usdIndex(), usdRule(), quantity, T).status).toBe('unavailable');
    }
  });
});

describe('sampled persistence and observed payment modes', () => {
  it('breaks streaks across missing slots and zero/negative results, keeps venue directions separate, and proves no continuous window', () => {
    const rows = [
      direction(0, '1'), direction(1, '0.000000000000000001'), direction(3, '1'), direction(4, '0'),
      direction(5, '-0.1'), direction(6, '1'), direction(7, '1'),
      direction(0, '-1', 'okx'), direction(1, '1', 'okx'), direction(2, '1', 'okx')
    ].reverse();
    const before = rows.map(row => row.sequence);
    expect(sampledPersistence(rows, 8)).toEqual([
      { buyVenue: 'mexc', sellVenue: 'okx', evaluatedSamples: 7, scheduledSamples: 8, positiveSamples: 5,
        longestConsecutivePositiveSamples: 2, longestSampledSpanMs: 5_000, continuousWindowProven: false },
      { buyVenue: 'okx', sellVenue: 'mexc', evaluatedSamples: 3, scheduledSamples: 8, positiveSamples: 2,
        longestConsecutivePositiveSamples: 2, longestSampledSpanMs: 5_000, continuousWindowProven: false }
    ]);
    expect(rows.map(row => row.sequence)).toEqual(before);
    expect(sampledPersistence([], 360).every(row => row.evaluatedSamples === 0 &&
      row.longestConsecutivePositiveSamples === 0 && row.longestSampledSpanMs === 0 && !row.continuousWindowProven)).toBe(true);
  });
  it('rejects duplicate/out-of-window/fractional samples and malformed signed values or chronology', () => {
    for (const rows of [
      [direction(0, '1'), direction(0, '1')],
      [direction(-1, '1')],
      [direction(2, '1')],
      [direction(0.5, '1')],
      [direction(0, '-private-text')],
      [direction(0, '1'), direction(1, '1', 'mexc', T - 1)],
      [{ ...direction(0, '1'), at: Number.NaN }],
      [{ ...direction(0, '1'), sellVenue: 'mexc' as const }]
    ]) expect(() => sampledPersistence(rows, 2)).toThrow();
  });
  it('selects a fee model only for an explicitly observed supported payment configuration', () => {
    expect(selectedFeeScenario({ observedAt: T, mexcMxDeduct: false, okxFeeType: '0' })).toBe('okx-received-base');
    expect(selectedFeeScenario({ observedAt: T, mexcMxDeduct: false, okxFeeType: '1' })).toBe('quote');
    expect(selectedFeeScenario()).toBe(null);
    for (const mexcMxDeduct of [true, null]) {
      for (const okxFeeType of ['0', '1', null] as const) {
        expect(selectedFeeScenario({ observedAt: T, mexcMxDeduct, okxFeeType })).toBe(null);
      }
    }
    expect(selectedFeeScenario({ observedAt: T, mexcMxDeduct: false, okxFeeType: null })).toBe(null);
  });
});
