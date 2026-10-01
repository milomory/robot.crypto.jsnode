import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { ExtendedPublicBookClient, PUBLIC_VENUES } from '../src/lab/extended-public-books.js';
import { comparePublicVenues } from '../src/lab/extended-comparison.js';
import { LabError, type FillAssumptions, type OrderBook, type PublicVenue } from '../src/lab/order-book.js';
import { VENUES } from '../src/lab/public-books.js';

const now = 1_800_000_000_000;
const bid = [['99', '2']], ask = [['101', '2']];
const meta = { type: 'spot', status: 'working', base_currency: 'BTC', quote_currency: 'USDT' };
const payloads = {
  binance: { bids: bid, asks: ask },
  bybit: { retCode: 0, result: { s: 'BTCUSDT', b: bid, a: ask, ts: now } },
  okx: { code: '0', data: [{ bids: bid, asks: ask, ts: String(now) }] },
  mexc: { lastUpdateId: 42, bids: bid, asks: ask },
  hitbtc: { timestamp: new Date(now).toISOString(), bid, ask }
};
const response = (data: unknown) => new Response(JSON.stringify(data));
const costs = Object.fromEntries(PUBLIC_VENUES.map(v => [v, { feeBps: 10, slippageBps: 5 }])) as Record<PublicVenue, FillAssumptions>;
afterEach(() => { vi.useRealTimers(); });

describe('opt-in public transport', () => {
  it.each(PUBLIC_VENUES)('reads %s only through fixed public GETs', async venue => {
    const request = vi.fn<typeof fetch>().mockImplementation(async url =>
      response(String(url).includes('/symbol/') ? meta : payloads[venue]));
    const book = await new ExtendedPublicBookClient(request, () => now).getBook(venue, 'BTC/USDT');
    expect(book.venue).toBe(venue);
    expect(book.bids).toEqual([[99, 2]]);
    const urls = {
      binance: 'https://data-api.binance.vision/api/v3/depth?symbol=BTCUSDT&limit=50',
      bybit: 'https://api.bybit.com/v5/market/orderbook?category=spot&symbol=BTCUSDT&limit=50',
      okx: 'https://www.okx.com/api/v5/market/books?instId=BTC-USDT&sz=50',
      mexc: 'https://api.mexc.com/api/v3/depth?symbol=BTCUSDT&limit=50',
      hitbtc: 'https://api.hitbtc.com/api/3/public/orderbook/BTCUSDT?depth=50'
    };
    expect(request.mock.calls.at(-1)?.[0]).toBe(urls[venue]);
    expect(request).toHaveBeenCalledTimes(venue === 'hitbtc' ? 2 : 1);
    for (const [, options] of request.mock.calls) {
      expect(options).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store' });
      expect(options?.headers).toBeUndefined();
      expect(options?.body).toBeUndefined();
    }
  });
  it('rejects unknown venue and symbols before a network call', async () => {
    const request = vi.fn<typeof fetch>();
    const client = new ExtendedPublicBookClient(request, () => now);
    await expect(client.getBook('private' as PublicVenue, 'BTC/USDT')).rejects.toThrow('unsupported-market');
    await expect(client.getBook('mexc', 'BTCUSDT&signature=PRIVATE')).rejects.toThrow('unsupported-market');
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    { ...meta, quote_currency: 'USD' }, { ...meta, base_currency: 'ETH' },
    { ...meta, status: 'suspended' }, { ...meta, type: 'futures' }, {}
  ])('never requests a HitBTC book after rejected metadata', async data => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response(data));
    await expect(new ExtendedPublicBookClient(request, () => now).getBook('hitbtc', 'BTC/USDT'))
      .rejects.toThrow('invalid-hitbtc-symbol');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('binds receipt timestamps to the depth request after metadata', async () => {
    let time = now;
    const request = vi.fn<typeof fetch>().mockImplementation(async url => {
      time += 100;
      return response(String(url).includes('/symbol/') ? meta : payloads.hitbtc);
    });
    const book = await new ExtendedPublicBookClient(request, () => time).getBook('hitbtc', 'BTC/USDT');
    expect(book.requestedAt).toBe(now + 100);
    expect(book.receivedAt).toBe(now + 200);
  });
  it.each(['metadata', 'book'])('shares HitBTC throttling at %s and never retries', async stage => {
    let time = now;
    const request = vi.fn<typeof fetch>().mockImplementation(async url => {
      if (stage === 'book' && String(url).includes('/symbol/')) return response(meta);
      return new Response('PRIVATE_SENTINEL', { status: 429, headers: { 'Retry-After': '120' } });
    });
    const client = new ExtendedPublicBookClient(request, () => time);
    await expect(client.getBook('hitbtc', 'BTC/USDT')).rejects.toThrow(/^public-http-429$/);
    time += 60_000;
    await expect(client.getBook('hitbtc', 'ETH/USDT')).rejects.toThrow('rate-limit-cooldown');
    expect(request).toHaveBeenCalledTimes(stage === 'metadata' ? 1 : 2);
  });
  it('honors HTTP-date cooldown and does not shorten long Retry-After', async () => {
    let time = now;
    const request = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', {
      status: 418, headers: { 'Retry-After': new Date(now + 2 * 86_400_000).toUTCString() }
    }));
    const client = new ExtendedPublicBookClient(request, () => time);
    await expect(client.getBook('mexc', 'BTC/USDT')).rejects.toThrow('public-http-418');
    time += 86_400_001;
    await expect(client.getBook('mexc', 'ETH/USDT')).rejects.toThrow('rate-limit-cooldown');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each(['network', 'json', 'http'])('redacts %s errors', async kind => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => {
      if (kind === 'network') throw new Error('PRIVATE_SENTINEL');
      return new Response('PRIVATE_SENTINEL', { status: kind === 'http' ? 503 : 200 });
    });
    await expect(new ExtendedPublicBookClient(request, () => now).getBook('mexc', 'BTC/USDT'))
      .rejects.toThrow(kind === 'http' ? /^public-http-503$/ : /^public-request-failed$/);
  });
  it.each(['header', 'stream'])('bounds response size using %s', async kind => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(256 * 1024 + 1)); }, cancel
    });
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(body,
      kind === 'header' ? { headers: { 'Content-Length': '999999' } } : undefined));
    await expect(new ExtendedPublicBookClient(request, () => now).getBook('mexc', 'BTC/USDT'))
      .rejects.toThrow(/^public-response-too-large$/);
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('times out stalled response bodies, cancels the stream and releases busy state', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(new ReadableStream({ cancel })))
      .mockResolvedValueOnce(response(payloads.mexc));
    const client = new ExtendedPublicBookClient(request, () => now);
    const pending = expect(client.getBook('mexc', 'BTC/USDT')).rejects.toThrow('public-request-timeout');
    await expect(client.getBook('mexc', 'ETH/USDT')).rejects.toThrow('public-venue-busy');
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
    expect(cancel).toHaveBeenCalledOnce();
    expect((await client.getBook('mexc', 'BTC/USDT')).venue).toBe('mexc');
  });
  it('discards late throttle responses without poisoning cooldown', async () => {
    vi.useFakeTimers();
    let finish!: (value: Response) => void;
    const request = vi.fn<typeof fetch>()
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValueOnce(response(payloads.mexc));
    const client = new ExtendedPublicBookClient(request, () => now);
    const pending = expect(client.getBook('mexc', 'BTC/USDT')).rejects.toThrow('public-request-timeout');
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
    finish(new Response('PRIVATE_SENTINEL', { status: 429 }));
    await vi.advanceTimersByTimeAsync(0);
    expect((await client.getBook('mexc', 'BTC/USDT')).venue).toBe('mexc');
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe('extended comparison isolated from old campaigns', () => {
  const getBook = async (venue: PublicVenue): Promise<OrderBook<PublicVenue>> => ({
    venue, symbol: 'BTC/USDT', requestedAt: now - 100, receivedAt: now,
    sourceAt: ['mexc', 'binance'].includes(venue) ? undefined : now,
    bids: [[99, 2]], asks: [[101, 2]]
  });
  it('compares all20 directions with costs and honest source-time flags', async () => {
    const report = await comparePublicVenues({ getBook }, 'BTC/USDT', 1, costs, () => now);
    expect(VENUES).toEqual(['binance', 'bybit', 'okx']);
    expect(report.sources).toHaveLength(5);
    expect(report.comparisons).toHaveLength(20);
    for (const row of report.comparisons) {
      expect(row).toHaveProperty('indicativeOnly', true);
      if (!('netQuote' in row)) throw new Error('unexpected rejection');
      expect(row.netQuote).toBeCloseTo(99 * .9995 * .999 - 101 * 1.0005 * 1.001);
      expect(row.sourceTimeVerified).toBe(![row.buyVenue, row.sellVenue].some(v => ['mexc', 'binance'].includes(v)));
    }
  });
  it('keeps source failure separate from pair rejections', async () => {
    const client = { getBook: async (venue: PublicVenue) => {
      if (venue === 'hitbtc') throw new LabError('PRIVATE_SENTINEL');
      const book = await getBook(venue);
      return venue === 'bybit' ? { ...book, sourceAt: now - 2_001 } : book;
    } };
    const report = await comparePublicVenues(client, 'BTC/USDT', 1, costs, () => now);
    expect(report.comparisons).toHaveLength(12);
    expect(report.comparisons.filter(row => 'rejected' in row)).toHaveLength(6);
    expect(report.sources.at(-1)).toMatchObject({ available: false, reason: 'public-request-failed' });
    expect(JSON.stringify(report)).not.toContain('PRIVATE_SENTINEL');
  });
  it('rejects books attributed to the wrong venue or asset', async () => {
    const report = await comparePublicVenues({ getBook: async venue => {
      const book = await getBook(venue);
      return venue === 'mexc' ? { ...book, venue: 'bybit' } : venue === 'hitbtc' ? { ...book, symbol: 'ETH/USDT' } : book;
    } }, 'BTC/USDT', 1, costs, () => now);
    expect(report.sources.filter(s => !s.available)).toEqual([
      { venue: 'mexc', available: false, reason: 'public-book-identity-mismatch' },
      { venue: 'hitbtc', available: false, reason: 'public-book-identity-mismatch' }
    ]);
    expect(report.comparisons).toHaveLength(6);
  });
  it('rejects invalid clocks with a fixed error', async () => {
    await expect(comparePublicVenues({ getBook }, 'BTC/USDT', 1, costs, () => NaN))
      .rejects.toThrow('invalid-public-clock');
  });
  it('rejects incomplete fees before requests', async () => {
    const client = { getBook: vi.fn(getBook) };
    await expect(comparePublicVenues(client, 'BTC/USDT', 1, {} as typeof costs, () => now)).rejects.toThrow('invalid-cost');
    expect(client.getBook).not.toHaveBeenCalled();
  });
  it('imports no account, secret, DB, Auth or order modules transitively', async () => {
    const queue = [resolve('src/scripts/market-venues.ts')], seen = new Set<string>();
    while (queue.length) {
      const path = queue.pop()!;
      if (seen.has(path)) continue;
      seen.add(path);
      expect(path === resolve('src/scripts/market-venues.ts') || path.startsWith(resolve('src/lab') + '/')).toBe(true);
      const source = await readFile(path, 'utf8');
      expect(source).not.toMatch(/process\.env|dotenv|node:fs|node:child_process/);
      for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        if (match[1].startsWith('.')) queue.push(resolve(dirname(path), match[1].replace(/\.js$/, '.ts')));
        else expect(match[1]).toBe('zod');
      }
    }
    expect(seen.size).toBeGreaterThanOrEqual(7);
  });
});
