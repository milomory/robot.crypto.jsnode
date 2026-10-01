import { describe, expect, it } from 'vitest';
import { LabError, validateBook } from '../src/lab/order-book.js';
import { mexcPublicBookUrl, parseMexcBook } from '../src/lab/mexc-public-book.js';

const now = 1_800_000_000_000;
const snapshot = () => ({
  lastUpdateId: 1112416,
  bids: [['99.50', '2'], ['99', '0.25']],
  asks: [['100', '3'], ['101.10', '0.50']]
});

describe('MEXC public Spot V3 depth', () => {
  it.each(['BTC', 'ETH', 'SOL'])('uses only the fixed public endpoint for %s/USDT', asset => {
    expect(mexcPublicBookUrl(`${asset}/USDT`))
      .toBe(`https://api.mexc.com/api/v3/depth?symbol=${asset}USDT&limit=50`);
    const book = parseMexcBook(`${asset}/USDT`, snapshot(), now - 100, now);
    expect(book).toEqual({ venue: 'mexc', symbol: `${asset}/USDT`,
      bids: [[99.5, 2], [99, 0.25]], asks: [[100, 3], [101.1, 0.5]],
      requestedAt: now - 100, receivedAt: now });
  });

  it.each(['BTCUSDT', 'btc/usdt', 'DOGE/USDT', 'BTC/USDC', '../account',
    'BTC/USDT&limit=5000', 'https://private.invalid', ''])('rejects unsupported symbol %s', symbol => {
    expect(() => mexcPublicBookUrl(symbol)).toThrow(/^unsupported-market$/);
    expect(() => parseMexcBook(symbol, snapshot(), now, now)).toThrow(/^unsupported-market$/);
  });

  it('never derives source time from a version or undocumented timestamp fields', () => {
    const book = parseMexcBook('BTC/USDT', {
      ...snapshot(), lastUpdateId: now, timestamp: now, ts: now, E: now, sourceAt: now
    }, now - 100, now);
    expect(book).not.toHaveProperty('sourceAt');
    expect(book).not.toHaveProperty('lastUpdateId');
    expect(() => validateBook(book, now + 4_901)).toThrow(/^stale-or-invalid-receipt-time$/);
  });

  it.each([null, [], 'PRIVATE_SENTINEL', {}, { bids: [], asks: [] },
    { ...snapshot(), lastUpdateId: -1 }, { ...snapshot(), lastUpdateId: NaN },
    { ...snapshot(), lastUpdateId: Infinity }, { ...snapshot(), lastUpdateId: 1.1 },
    { ...snapshot(), lastUpdateId: Number.MAX_SAFE_INTEGER + 1 },
    { ...snapshot(), lastUpdateId: 'PRIVATE_SENTINEL' },
    { ...snapshot(), code: -1121, msg: 'PRIVATE_SENTINEL' },
    { code: -1121, msg: 'PRIVATE_SENTINEL' },
    { ...snapshot(), bids: [['99', '1', 'PRIVATE_SENTINEL']] },
    { ...snapshot(), asks: [['100']] },
    { ...snapshot(), bids: [[99, '1']] },
    { ...snapshot(), asks: [['100', true]] }
  ])('redacts malformed responses and error envelopes %#', payload => {
    expect(() => parseMexcBook('BTC/USDT', payload, now, now)).toThrow(LabError);
    expect(() => parseMexcBook('BTC/USDT', payload, now, now)).toThrow(/^invalid-public-book$/);
  });

  it.each(['0', '-1', 'Infinity', 'NaN', '1e2', '0x10', ' 1', '1 ', '',
    'PRIVATE_SENTINEL', '9'.repeat(400), `0.${'0'.repeat(400)}1`])
  ('rejects nonpositive, malformed or unrepresentable decimal %s', value => {
    for (const row of [[value, '1'], ['99', value]]) {
      expect(() => parseMexcBook('BTC/USDT', { ...snapshot(), bids: [row] }, now, now))
        .toThrow(/^invalid-public-book$/);
    }
  });

  it('accepts 50 levels and rejects empty or excess depth without truncation', () => {
    const bids = Array.from({ length: 50 }, (_, i) => [String(99 - i), '1']);
    const asks = Array.from({ length: 50 }, (_, i) => [String(100 + i), '1']);
    expect(parseMexcBook('BTC/USDT', { ...snapshot(), bids, asks }, now, now).bids).toHaveLength(50);
    for (const levels of [[], [...asks, ['150', '1']]]) {
      expect(() => parseMexcBook('BTC/USDT', { ...snapshot(), asks: levels }, now, now))
        .toThrow(/^invalid-public-book$/);
    }
  });

  it.each([
    { bids: [['98', '1'], ['99', '1']] }, { bids: [['99', '1'], ['99', '2']] },
    { asks: [['102', '1'], ['101', '1']] }, { asks: [['100', '1'], ['100', '2']] }
  ])('rejects duplicate or unsorted levels %#', override => {
    expect(() => parseMexcBook('BTC/USDT', { ...snapshot(), ...override }, now, now))
      .toThrow(/^unsorted-or-duplicate-level$/);
  });

  it.each(['100', '101'])('rejects locked or crossed books with bid %s', bid => {
    expect(() => parseMexcBook('BTC/USDT', { ...snapshot(), bids: [[bid, '1']] }, now, now))
      .toThrow(/^crossed-or-locked-book$/);
  });

  it.each([[now - 5_001, now], [now, now - 1], [0, now], [NaN, now],
    [now, Infinity], [now, NaN]])('rejects stale or invalid receipt times %#', (requestedAt, receivedAt) => {
    expect(() => parseMexcBook('BTC/USDT', snapshot(), requestedAt, receivedAt))
      .toThrow(/^stale-or-invalid-receipt-time$/);
  });

  it('keeps the existing inclusive 5-second request-to-receipt freshness bound', () => {
    expect(parseMexcBook('BTC/USDT', snapshot(), now - 5_000, now).receivedAt).toBe(now);
  });
});
