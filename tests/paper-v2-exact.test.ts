import { describe, expect, it } from 'vitest';
import { executeFill, formatAmount, parseAmount, PaperError, RAW_DENOMINATOR,
  ROUNDING_DENOMINATOR, SCALE, SLIPPAGE_DENOMINATOR } from '../src/paper-v2/exact.js';
import type { Book, Costs, Instrument } from '../src/paper-v2/exact.js';

const now = 10_000_000;
const costs: Costs = { feeBps: 10, slippageBps: 5, feeAsset: 'USDT' };
const free: Costs = { feeBps: 0, slippageBps: 0, feeAsset: 'USDT' };
function book(): Book {
  return { venue: 'binance', symbol: 'BTC/USDT', requestedAt: now - 50, receivedAt: now,
    bids: [['100', '1']], asks: [['101', '1']] };
}
function instrument(): Instrument {
  return { venue: 'binance', symbol: 'BTC/USDT', fetchedAt: now, trading: true,
    minQuantity: '0.00000001', maxQuantity: '100', quantityStep: '0.00000001' };
}
function fill(b: Book = book(), i: Instrument = instrument(), side: 'buy' | 'sell' = 'buy',
  quantity = '0.25', c: Costs = costs, at = now) {
  return executeFill(b, i, side, quantity, c, at);
}

describe('exact paper-v2 amounts', () => {
  it('parses fixed decimal strings including values beyond Number precision', () => {
    expect(parseAmount('0')).toBe(0n);
    expect(parseAmount('0.00000001')).toBe(1n);
    expect(parseAmount('12.34')).toBe(1_234_000_000n);
    expect(parseAmount('99999999999999999999.99999999')).toBe(9_999_999_999_999_999_999_999_999_999n);
    expect(formatAmount(0n)).toBe('0.00000000');
    expect(formatAmount(-1n)).toBe('-0.00000001');
    expect(formatAmount(parseAmount('99999999999999999999.99999999'))).toBe('99999999999999999999.99999999');
  });
  it('rejects coercion, noncanonical inputs and excessive precision without exposing input', () => {
    for (const value of ['', ' 1', '1 ', '01', '+1', '-1', '-0', '.1', '1.', '1e8',
      '1.000000001', '100000000000000000000', 'Infinity', 'secret=never-echo', 1, null, {}, ['1']]) {
      expect(() => parseAmount(value as string)).toThrowError(new PaperError('invalid-amount'));
    }
    expect(() => formatAmount(1 as unknown as bigint)).toThrowError(new PaperError('invalid-amount'));
  });
});

describe('exact paper-v2 full fills', () => {
  it('charges adverse slippage and quote fees with explicit fractional rounding', () => {
    const purchase = fill();
    expect(purchase).toEqual({ quantity: 25_000_000n, rawQuoteNumerator: 252_500_000_000_000_000n,
      slippageNumerator: 1_262_500_000_000_000_000n, gross: 2_526_262_500n,
      fee: 2_526_263n, cash: 2_528_788_763n, roundingNumerator: ROUNDING_DENOMINATOR / 2n });
    expect(formatAmount(purchase.cash)).toBe('25.28788763');
    const sale = fill(book(), instrument(), 'sell');
    expect(sale.gross).toBe(2_498_750_000n);
    expect(sale.fee).toBe(2_498_750n);
    expect(sale.cash).toBe(2_496_251_250n);
    expect(sale.roundingNumerator).toBe(0n);
  });
  it('calculates fees on the exact slippage-adjusted value, not rounded gross', () => {
    const b = book(); b.bids = [['0.00000001', '1']]; b.asks = [['0.00000002', '1']];
    const result = fill(b, instrument(), 'buy', '0.50005', { ...free, feeBps: 9999 });
    // Exact gross = 1.0001 quote atoms; exact fee = 0.99999999 atoms.
    expect(result.gross).toBe(2n);
    expect(result.fee).toBe(1n);
    expect(result.cash).toBe(3n);
    expect(result.roundingNumerator).toBe(9_999_000_100_000_000n);
  });
  it('rounds buys upwards and sales downwards at sub-atom quote boundaries', () => {
    const b = book(); b.bids = [['100.00000001', '1']]; b.asks = [['100.00000002', '1']];
    const buy = fill(b, instrument(), 'buy', '0.00000001', free);
    const sell = fill(b, instrument(), 'sell', '0.00000001', free);
    expect(buy.cash).toBe(101n);
    expect(sell.cash).toBe(100n);
    expect(buy.roundingNumerator).toBe(9_999_999_800_000_000n);
    expect(sell.roundingNumerator).toBe(100_000_000n);
  });
  it('walks each depth level exactly and preserves the source objects', () => {
    const b = book(); b.asks = [['101', '0.1'], ['102', '0.2'], ['103', '1']];
    b.bids = [['100', '0.1'], ['99', '0.2'], ['98', '1']];
    const before = JSON.stringify(b);
    expect(fill(b, instrument(), 'buy', '0.4', free).cash).toBe(parseAmount('40.8'));
    expect(fill(b, instrument(), 'sell', '0.4', free).cash).toBe(parseAmount('39.6'));
    expect(JSON.stringify(b)).toBe(before);
    expect(() => fill(b, instrument(), 'buy', '1.30000001', free)).toThrow('insufficient-depth');
  });
  it('does all price-times-quantity arithmetic beyond safe integer precision', () => {
    const b = book(); b.bids = [['99999999999999999999.99999998', '1']];
    b.asks = [['99999999999999999999.99999999', '1']];
    expect(fill(b, instrument(), 'buy', '1', free).cash).toBe(9_999_999_999_999_999_999_999_999_999n);
    expect(fill(b, instrument(), 'sell', '1', free).cash).toBe(9_999_999_999_999_999_999_999_999_998n);
  });
  it('enforces exact size increments without rounding orders into valid sizes', () => {
    const i = { ...instrument(), minQuantity: '0.00000003', maxQuantity: '0.3', quantityStep: '0.00000003' };
    expect(fill(book(), i, 'buy', '0.3', free).quantity).toBe(30_000_000n);
    expect(() => fill(book(), i, 'buy', '0.10000000', free)).toThrow('quantity-step-mismatch');
    expect(() => fill(book(), i, 'buy', '0.00000001', free)).toThrow('quantity-out-of-range');
    expect(() => fill(book(), i, 'buy', '0.30000001', free)).toThrow('quantity-out-of-range');
    expect(() => fill(book(), i, 'buy', '0', free)).toThrow('non-positive-amount');
  });
  it('compares minimum and maximum notional to exact raw value before cash rounding', () => {
    const b = book(); b.bids = [['100.00000001', '1']]; b.asks = [['100.00000002', '1']];
    // Raw notional is 0.0000010000000002 USDT; buy cash rounds to 0.00000101.
    expect(() => fill(b, { ...instrument(), minNotional: '0.00000101' }, 'buy', '0.00000001', free))
      .toThrow('notional-out-of-range');
    expect(() => fill(b, { ...instrument(), maxNotional: '0.00000100' }, 'buy', '0.00000001', free))
      .toThrow('notional-out-of-range');
    expect(fill(book(), { ...instrument(), minNotional: '25.25', maxNotional: '25.25' }, 'buy', '0.25', free).cash)
      .toBe(parseAmount('25.25'));
  });
  it('reconciles the exact cash, slippage and rounding numerators for both directions', () => {
    const b = book(); b.bids = [['10.98765432', '1']]; b.asks = [['11.12345678', '1']];
    for (const side of ['buy', 'sell'] as const) {
      for (const c of [free, costs, { ...costs, feeBps: 123, slippageBps: 456 }]) {
        const result = fill(b, instrument(), side, '0.12345678', c);
        const rawScaled = result.rawQuoteNumerator * (ROUNDING_DENOMINATOR / RAW_DENOMINATOR);
        const slipScaled = result.slippageNumerator * (ROUNDING_DENOMINATOR / SLIPPAGE_DENOMINATOR);
        const adjusted = side === 'buy' ? rawScaled + slipScaled : rawScaled - slipScaled;
        const idealCash = adjusted * BigInt(side === 'buy' ? 10_000 + c.feeBps : 10_000 - c.feeBps) / 10_000n;
        expect(result.cash * ROUNDING_DENOMINATOR).toBe(side === 'buy'
          ? idealCash + result.roundingNumerator : idealCash - result.roundingNumerator);
        expect(result.roundingNumerator).toBeGreaterThanOrEqual(0n);
        expect(result.roundingNumerator).toBeLessThan(2n * ROUNDING_DENOMINATOR);
        expect(result.quantity).toBe(12_345_678n);
      }
    }
    expect(RAW_DENOMINATOR).toBe(SCALE);
  });
});

describe('paper-v2 execution validation', () => {
  it('checks receipt, source and metadata time boundaries, allowing absent source timestamps', () => {
    expect(fill()).toBeDefined();
    expect(fill({ ...book(), requestedAt: now - 5_000, receivedAt: now - 5_000, sourceAt: now - 5_000 },
      { ...instrument(), fetchedAt: now - 3_600_000 })).toBeDefined();
    expect(fill({ ...book(), sourceAt: now + 1_000 })).toBeDefined();
    for (const b of [{ ...book(), requestedAt: now - 5_001 }, { ...book(), receivedAt: now + 1 },
      { ...book(), requestedAt: now + 1 }, { ...book(), requestedAt: now - 6_000, receivedAt: now - 5_001 },
      { ...book(), requestedAt: -1 }, { ...book(), receivedAt: 1.5 }]) {
      expect(() => fill(b)).toThrow('stale-or-invalid-receipt-time');
    }
    for (const sourceAt of [now - 5_001, now + 1_001, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, -1, 1.5]) {
      expect(() => fill({ ...book(), sourceAt })).toThrow('stale-or-invalid-source-time');
    }
    for (const fetchedAt of [now - 3_600_001, now + 1, NaN, Infinity, -1, 1.5]) {
      expect(() => fill(book(), { ...instrument(), fetchedAt })).toThrow('stale-or-invalid-instrument-time');
    }
    expect(() => fill(book(), instrument(), 'buy', '1', free, NaN)).toThrow('stale-or-invalid-receipt-time');
  });
  it('rejects malformed, unsorted, duplicate, crossed or oversized books even on the unused side', () => {
    const malformed = [null, {}, 'secret', [], [null], [[]], [['100', '0']], [['0', '1']], [['100', '1', 'secret']], [[100, '1']],
      [['100', '1'], ['100', '1']], [['100', '1'], ['101', '1']], Array.from({ length: 51 }, () => ['100', '1'])];
    for (const bids of malformed) {
      expect(() => fill({ ...book(), bids: bids as [string, string][] })).toThrow(PaperError);
    }
    expect(() => fill({ ...book(), asks: [['102', '1'], ['101', '1']] })).toThrow('unsorted-or-duplicate-level');
    expect(() => fill({ ...book(), asks: [['100', '1']] })).toThrow('crossed-or-locked-book');
    expect(() => fill({ ...book(), asks: [['99', '1']] })).toThrow('crossed-or-locked-book');
  });
  it('rejects unsupported currencies, venues, sides, instruments and fee assumptions', () => {
    expect(() => fill({ ...book(), symbol: 'ETH/USDT' } as unknown as Book)).toThrow('unsupported-symbol');
    expect(() => fill(book(), { ...instrument(), symbol: 'BTC/USD' } as unknown as Instrument)).toThrow('unsupported-symbol');
    expect(() => fill({ ...book(), venue: 'unknown' } as unknown as Book)).toThrow('incompatible-venue');
    expect(() => fill(book(), { ...instrument(), venue: 'okx' })).toThrow('incompatible-venue');
    expect(() => fill(book(), instrument(), 'transfer' as 'buy')).toThrow('invalid-side');
    expect(() => fill(book(), { ...instrument(), trading: false })).toThrow('instrument-not-trading');
    expect(() => fill(book(), instrument(), 'buy', '1', { ...costs, feeAsset: 'BTC' } as unknown as Costs))
      .toThrow('unsupported-fee-asset');
    for (const value of [-1, 0.5, 10_000, Infinity, NaN, '10']) {
      expect(() => fill(book(), instrument(), 'buy', '1', { ...costs, feeBps: value } as Costs)).toThrow('invalid-cost');
      expect(() => fill(book(), instrument(), 'buy', '1', { ...costs, slippageBps: value } as Costs)).toThrow('invalid-cost');
    }
  });
  it('rejects invalid limit metadata and unrepresentable positive sell proceeds', () => {
    for (const i of [{ ...instrument(), minQuantity: '101' }, { ...instrument(), quantityStep: '101' },
      { ...instrument(), minNotional: '10', maxNotional: '9' }]) {
      expect(() => fill(book(), i)).toThrow('invalid-instrument-limits');
    }
    for (const key of ['minQuantity', 'maxQuantity', 'quantityStep', 'minNotional', 'maxNotional']) {
      expect(() => fill(book(), { ...instrument(), [key]: '0' })).toThrow('non-positive-amount');
    }
    const b = book(); b.bids = [['0.00000001', '1']]; b.asks = [['0.00000002', '1']];
    expect(() => fill(b, instrument(), 'sell', '0.1', free)).toThrow('non-positive-cash');
    expect(() => fill(b, instrument(), 'sell', '1', { ...free, feeBps: 9999 })).toThrow('non-positive-cash');
  });
  it('turns missing root inputs into fixed safe errors instead of native exceptions', () => {
    for (const value of [null, undefined, [], 'private-input']) {
      expect(() => executeFill(value as unknown as Book, instrument(), 'buy', '1', free, now))
        .toThrowError(new PaperError('invalid-input'));
      expect(() => executeFill(book(), value as unknown as Instrument, 'buy', '1', free, now))
        .toThrowError(new PaperError('invalid-input'));
      expect(() => executeFill(book(), instrument(), 'buy', '1', value as unknown as Costs, now))
        .toThrowError(new PaperError('invalid-input'));
    }
  });
});
