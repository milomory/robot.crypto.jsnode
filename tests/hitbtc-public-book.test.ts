import { describe, expect, it } from 'vitest';
import { LabError } from '../src/lab/order-book.js';
import { hitbtcBookUrl, hitbtcSymbolUrl, parseHitbtcBook, parseHitbtcSymbol,
  type HitbtcSymbol } from '../src/lab/hitbtc-public-book.js';

const now = Date.parse('2026-09-22T10:00:00.123Z');
const metadata = (base = 'BTC') => ({ type: 'spot', base_currency: base,
  quote_currency: 'USDT', status: 'working', quantity_increment: '0.00001', tick_size: '0.01' });
const snapshot = () => ({ timestamp: '2026-09-22T10:00:00.123456789Z',
  bid: [['99', '0.5'], ['98', '2']], ask: [['101', '0.25'], ['102', '3']] });

describe('HitBTC exact public spot symbol identity', () => {
  it.each(['BTC', 'ETH', 'SOL'])('proves the exact %s/USDT candidate before building its book URL', base => {
    const symbol = `${base}/USDT`;
    expect(hitbtcSymbolUrl(symbol)).toBe(`https://api.hitbtc.com/api/3/public/symbol/${base}USDT`);
    const id = parseHitbtcSymbol(symbol, metadata(base));
    expect(id).toBe(`${base}USDT`);
    expect(hitbtcBookUrl(id)).toBe(`https://api.hitbtc.com/api/3/public/orderbook/${base}USDT?depth=50`);
  });

  it.each(['BTC/USD', 'btc/USDT', '../../spot/order', 'BTC/USDT?token=PRIVATE_SENTINEL', 'toString'])
  ('rejects an unsupported symbol before constructing a URL: %s', symbol => {
    expect(() => hitbtcSymbolUrl(symbol)).toThrow(/^unsupported-market$/);
    expect(() => parseHitbtcSymbol(symbol, metadata())).toThrow(/^unsupported-market$/);
    expect(() => parseHitbtcBook(symbol, snapshot(), now, now)).toThrow(/^unsupported-market$/);
  });

  it.each([
    { quote_currency: 'USD' }, { quote_currency: 'USDC' }, { base_currency: 'ETH' },
    { base_currency: 'WBTC' }, { base_currency: null }, { base_currency: 'btc' },
    { type: 'futures' }, { status: 'suspended' }, { status: 'clearing' },
    { status: 'PRIVATE_SENTINEL' }, { status: undefined }, { type: undefined }
  ])('rejects mismatched, suspended, incomplete or nonspot metadata: %j', overrides => {
    expect(() => parseHitbtcSymbol('BTC/USDT', { ...metadata(), ...overrides }))
      .toThrow(/^invalid-hitbtc-symbol$/);
  });

  it.each([null, [], {}, { error: { message: 'PRIVATE_SENTINEL' } }, { BTCUSDT: metadata() }])
  ('rejects failed or unexpected metadata envelopes without echoing their contents', payload => {
    expect(() => parseHitbtcSymbol('BTC/USDT', payload)).toThrow(/^invalid-hitbtc-symbol$/);
  });

  it.each(['BTCUSD', 'https://private.example/', 'BTCUSDT?token=PRIVATE_SENTINEL'])
  ('guards the URL even when a caller bypasses the branded ID type', id => {
    expect(() => hitbtcBookUrl(id as HitbtcSymbol)).toThrow(/^unsupported-market$/);
  });
});

describe('HitBTC public order-book parser', () => {
  it('normalizes documented two-element decimal levels and nanosecond ISO publication time', () => {
    expect(parseHitbtcBook('BTC/USDT', snapshot(), now - 100, now)).toEqual({
      venue: 'hitbtc', symbol: 'BTC/USDT', bids: [[99, 0.5], [98, 2]], asks: [[101, 0.25], [102, 3]],
      requestedAt: now - 100, receivedAt: now, sourceAt: now
    });
  });

  it.each([now, String(now), '2026-09-22T10:00:00.123Z', '2026-09-22T10:00:00Z'])
  ('accepts documented milliseconds or UTC ISO timestamp representations: %s', timestamp => {
    const book = parseHitbtcBook('BTC/USDT', { ...snapshot(), timestamp }, now - 100, now);
    expect(book.sourceAt).toBe(typeof timestamp === 'string' && timestamp.includes('T')
      ? Date.parse(timestamp) : now);
  });

  it.each([undefined, null, '', 0, NaN, Infinity, 1.5, '1.5', 'Infinity', '2026-09-22',
    '2026-09-22T10:00:00', '2026-02-30T10:00:00.000Z', '2026-09-22T25:00:00.000Z',
    'PRIVATE_SENTINEL', '9007199254740992'])
  ('rejects missing, impossible or malformed source times without receipt-time fallback: %s', timestamp => {
    expect(() => parseHitbtcBook('BTC/USDT', { ...snapshot(), timestamp }, now, now))
      .toThrow(/^invalid-public-book$/);
  });

  it.each([now - 5_001, now + 1_001])('rejects stale or excessively future publication time: %s', timestamp => {
    expect(() => parseHitbtcBook('BTC/USDT', { ...snapshot(), timestamp }, now - 100, now))
      .toThrow(/^stale-or-invalid-source-time$/);
  });

  it.each([now - 5_001, now + 1, NaN])('rejects invalid request times: %s', requestedAt => {
    expect(() => parseHitbtcBook('BTC/USDT', snapshot(), requestedAt, now))
      .toThrow(/^stale-or-invalid-receipt-time$/);
  });

  it.each([
    [], [['99']], [['99', '1', 'extra']], [['99', '0']], [['99', '-1']],
    [['99', 'NaN']], [['99', 'Infinity']], [['99', '1e2']], [[99, 1]],
    [[' 99', '1']], [['PRIVATE_SENTINEL', '1']], [[`${'9'.repeat(400)}`, '1']],
    Array.from({ length: 51 }, (_, index) => [String(99 - index), '1'])
  ])('rejects malformed or oversized depth without echoing the levels', bid => {
    expect(() => parseHitbtcBook('BTC/USDT', { ...snapshot(), bid }, now, now))
      .toThrow(/^invalid-public-book$/);
  });

  it('rejects duplicate, unsorted, crossed and locked books', () => {
    for (const bid of [[['98', '1'], ['99', '1']], [['99', '1'], ['99', '2']]]) {
      expect(() => parseHitbtcBook('BTC/USDT', { ...snapshot(), bid }, now, now))
        .toThrow(/^unsorted-or-duplicate-level$/);
    }
    for (const price of ['101', '102']) {
      expect(() => parseHitbtcBook('BTC/USDT', { ...snapshot(), bid: [[price, '1']] }, now, now))
        .toThrow(/^crossed-or-locked-book$/);
    }
  });

  it.each([null, [], {}, { error: { code: 503, message: 'PRIVATE_SENTINEL' } }])
  ('rejects failed book responses with a fixed safe LabError', payload => {
    expect(() => parseHitbtcBook('BTC/USDT', payload, now, now)).toThrow(LabError);
    expect(() => parseHitbtcBook('BTC/USDT', payload, now, now)).toThrow(/^invalid-public-book$/);
  });
});
