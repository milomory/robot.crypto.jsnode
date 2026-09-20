import { z } from 'zod';
import { LabError, validateBook, type Level, type OrderBook, type Venue } from './order-book.js';

const decimal = z.string().regex(/^\d+(?:\.\d+)?$/).transform(Number)
  .refine(value => Number.isFinite(value) && value > 0);
const level = z.tuple([decimal, decimal]).rest(z.unknown());
const levels = z.array(level).min(1).max(50);
const timestamp = z.union([z.number(), z.string().regex(/^\d+$/)]).transform(Number)
  .refine(value => Number.isSafeInteger(value) && value > 0);
const binance = z.object({ bids: levels, asks: levels });
const bybit = z.object({ retCode: z.literal(0), result: z.object({
  s: z.string(), b: levels, a: levels, ts: timestamp
}) });
const okx = z.object({ code: z.literal('0'), data: z.array(z.object({
  bids: levels, asks: levels, ts: timestamp
})).length(1) });

export const LAB_SYMBOLS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'] as const;
export const VENUES: Venue[] = ['binance', 'bybit', 'okx'];

export function parseBook(venue: Venue, symbol: string, payload: unknown,
  requestedAt: number, receivedAt: number): OrderBook {
  let bids: Level[], asks: Level[], sourceAt: number | undefined;
  try {
    if (venue === 'binance') {
      const parsed = binance.parse(payload);
      bids = parsed.bids.map(row => [row[0], row[1]]);
      asks = parsed.asks.map(row => [row[0], row[1]]);
    } else if (venue === 'bybit') {
      const { result } = bybit.parse(payload);
      if (result.s !== symbol.replace('/', '')) throw new LabError('symbol-mismatch');
      bids = result.b.map(row => [row[0], row[1]]);
      asks = result.a.map(row => [row[0], row[1]]);
      sourceAt = result.ts;
    } else if (venue === 'okx') {
      const [result] = okx.parse(payload).data;
      bids = result.bids.map(row => [row[0], row[1]]);
      asks = result.asks.map(row => [row[0], row[1]]);
      sourceAt = result.ts;
    } else throw new LabError('unknown-venue');
  } catch {
    // Never echo upstream response bodies or parser errors containing their contents.
    throw new LabError('invalid-public-book');
  }
  const book = { venue, symbol, bids, asks, sourceAt, requestedAt, receivedAt };
  validateBook(book, receivedAt);
  return book;
}

export class PublicBookClient {
  private readonly cooldown = new Map<Venue, number>();
  constructor(private readonly request: typeof fetch = fetch, private readonly clock = Date.now) {}

  async getBook(venue: Venue, symbol: string): Promise<OrderBook> {
    if (!VENUES.includes(venue) || !LAB_SYMBOLS.some(allowed => allowed === symbol)) {
      throw new LabError('unsupported-market');
    }
    const requestedAt = this.clock();
    if ((this.cooldown.get(venue) ?? 0) > requestedAt) throw new LabError('rate-limit-cooldown');
    const compact = symbol.replace('/', '');
    const urls: Record<Venue, string> = {
      binance: `https://data-api.binance.vision/api/v3/depth?symbol=${compact}&limit=50`,
      bybit: `https://api.bybit.com/v5/market/orderbook?category=spot&symbol=${compact}&limit=50`,
      okx: `https://www.okx.com/api/v5/market/books?instId=${symbol.replace('/', '-')}&sz=50`
    };
    try {
      const response = await this.request(urls[venue], {
        method: 'GET', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(5_000)
      });
      if ([418, 429].includes(response.status)) {
        const raw = response.headers.get('retry-after');
        const seconds = raw && /^\d+$/.test(raw) ? Number(raw) : 60;
        this.cooldown.set(venue, this.clock() + Math.max(60, Math.min(seconds, 86_400)) * 1_000);
      }
      if (!response.ok) throw new LabError(`public-http-${response.status}`);
      const payload: unknown = await response.json();
      return parseBook(venue, symbol, payload, requestedAt, this.clock());
    } catch (error) {
      if (error instanceof LabError) throw error;
      throw new LabError('public-request-failed');
    }
  }
}
