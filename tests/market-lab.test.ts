import { describe, expect, it, vi } from 'vitest';
import { compareVenues, simulateFill, validateBook, type OrderBook } from '../src/lab/order-book.js';
import { parseBook, PublicBookClient } from '../src/lab/public-books.js';

const now = 1_800_000_000_000;
const book = (overrides: Partial<OrderBook> = {}): OrderBook => ({
  venue: 'bybit', symbol: 'BTC/USDT', bids: [[99, 1], [98, 2]], asks: [[101, 1], [102, 2]],
  requestedAt: now - 100, receivedAt: now, sourceAt: now - 50, ...overrides
});
const costs = { binance: { feeBps: 10, slippageBps: 5 }, bybit: { feeBps: 10, slippageBps: 5 },
  okx: { feeBps: 10, slippageBps: 5 } };

describe('independent depth-v2 simulation', () => {
  it('walks asks for buys and bids for sells, charging fees and adverse slippage on each', () => {
    const buy = simulateFill(book(), 'buy', 2, costs.bybit, now);
    const sell = simulateFill(book(), 'sell', 2, costs.bybit, now);
    expect(buy.quoteBeforeSlippage).toBe(203);
    expect(buy.cashQuote).toBeCloseTo(203 * 1.0005 * 1.001, 10);
    expect(sell.quoteBeforeSlippage).toBe(197);
    expect(sell.cashQuote).toBeCloseTo(197 * 0.9995 * 0.999, 10);
    expect(buy.averagePrice).toBeCloseTo(101.5 * 1.0005, 10);
  });
  it('does not invent liquidity or silently return a partial fill', () => {
    expect(() => simulateFill(book(), 'buy', 4, costs.bybit, now)).toThrow('insufficient-depth');
  });
  it.each([0, -1, NaN, Infinity])('rejects invalid quantity %s', quantity => {
    expect(() => simulateFill(book(), 'buy', quantity, costs.bybit, now)).toThrow('invalid-order');
  });
  it.each([-1, NaN, Infinity, 10_000])('rejects invalid costs %s', feeBps => {
    expect(() => simulateFill(book(), 'buy', 1, { feeBps, slippageBps: 0 }, now)).toThrow('invalid-cost');
  });
  it.each([
    { requestedAt: now - 5_001 }, { receivedAt: now + 1 }, { sourceAt: now - 5_001 },
    { sourceAt: now + 1_001 }, { bids: [] }, { bids: [[102, 1]] },
    { asks: [[101, 0]] }, { asks: [[NaN, 1]] }, { bids: [[98, 1], [99, 1]] },
    { asks: [[101, 1], [101, 1]] }
  ] as Partial<OrderBook>[])('rejects bad or stale books %j', overrides => {
    expect(() => validateBook(book(overrides), now)).toThrow();
  });
  it('can turn a positive raw spread negative after both fees', () => {
    const result = compareVenues(book(), book({ venue: 'okx', bids: [[101.1, 1]], asks: [[102, 1]] }), 1, costs, now);
    expect(result.netQuote).toBeLessThan(0);
    expect(result.indicativeOnly).toBe(true);
    expect(result.sourceTimeVerified).toBe(true);
  });
  it('reports a larger spread after costs without labeling it executable', () => {
    const result = compareVenues(book(), book({ venue: 'okx', bids: [[105, 2]], asks: [[106, 2]] }), 1, costs, now);
    expect(result.netQuote).toBeCloseTo(105 * .9995 * .999 - 101 * 1.0005 * 1.001);
  });
  it('rejects different assets, same venue and asynchronous snapshots', () => {
    expect(() => compareVenues(book(), book(), 1, costs, now)).toThrow('incompatible');
    expect(() => compareVenues(book(), book({ venue: 'okx', symbol: 'ETH/USDT' }), 1, costs, now)).toThrow('incompatible');
    expect(() => compareVenues(book(), book({ venue: 'okx', sourceAt: now - 2_001 }), 1, costs, now)).toThrow('unsynchronised');
  });
  it('explicitly distinguishes Binance receipt time from verified source time', () => {
    expect(compareVenues(book({ venue: 'binance', sourceAt: undefined }), book(), 1, costs, now)
      .sourceTimeVerified).toBe(false);
  });
});

describe('public spot adapters', () => {
  const bids = [['99', '2']], asks = [['101', '2']];
  const payloads = {
    binance: { lastUpdateId: 10, bids, asks },
    bybit: { retCode: 0, result: { s: 'BTCUSDT', b: bids, a: asks, ts: now } },
    okx: { code: '0', data: [{ bids: [['99', '2', '0', '1']], asks, ts: String(now) }] }
  };
  it.each(['binance', 'bybit', 'okx'] as const)('normalizes %s', venue => {
    const result = parseBook(venue, 'BTC/USDT', payloads[venue], now - 100, now);
    expect(result.bids).toEqual([[99, 2]]);
    expect(result.asks).toEqual([[101, 2]]);
    expect(result.sourceAt).toBe(venue === 'binance' ? undefined : now);
  });
  it('rejects wrong symbol, failed envelopes and private error text without echo', () => {
    for (const [venue, payload] of [
      ['bybit', { ...payloads.bybit, result: { ...payloads.bybit.result, s: 'ETHUSDT' } }],
      ['okx', { code: '500', msg: 'PRIVATE_SENTINEL' }],
      ['binance', { bids: [['PRIVATE_SENTINEL', '1']], asks }]
    ] as const) {
      expect(() => parseBook(venue, 'BTC/USDT', payload, now, now)).toThrow(/^invalid-public-book$/);
    }
  });
  it('only requests fixed public GET endpoints without credentials or redirects', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(payloads.binance)));
    const client = new PublicBookClient(request, () => now);
    await client.getBook('binance', 'BTC/USDT');
    expect(request.mock.calls[0][0]).toBe('https://data-api.binance.vision/api/v3/depth?symbol=BTCUSDT&limit=50');
    expect(request.mock.calls[0][1]).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error' });
    expect(request.mock.calls[0][1]?.headers).toBeUndefined();
    await expect(client.getBook('bybit', '../../private')).rejects.toThrow('unsupported-market');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('does not retry and shares a per-venue cooldown after throttling', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('PRIVATE_SENTINEL', {
      status: 429, headers: { 'Retry-After': '120' }
    }));
    let time = now;
    const client = new PublicBookClient(request, () => time);
    await expect(client.getBook('okx', 'BTC/USDT')).rejects.toThrow(/^public-http-429$/);
    time += 60_000;
    await expect(client.getBook('okx', 'ETH/USDT')).rejects.toThrow('rate-limit-cooldown');
    expect(request).toHaveBeenCalledTimes(1);
    time += 61_000;
    await expect(client.getBook('okx', 'BTC/USDT')).rejects.toThrow(/^public-http-429$/);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('redacts transport and JSON parse errors', async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error('PRIVATE_SENTINEL'));
    await expect(new PublicBookClient(request, () => now).getBook('bybit', 'BTC/USDT'))
      .rejects.toThrow(/^public-request-failed$/);
    request.mockResolvedValue(new Response('PRIVATE_SENTINEL'));
    await expect(new PublicBookClient(request, () => now).getBook('bybit', 'BTC/USDT'))
      .rejects.toThrow(/^public-request-failed$/);
  });
});
