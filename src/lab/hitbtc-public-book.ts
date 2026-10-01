import { z } from 'zod';
import { LabError, validateBook, type OrderBook } from './order-book.js';

// https://api.hitbtc.com/#get-symbol and #get-order-book-by-symbol (API v3).
// USD is deliberately never treated as USDT, even when an exchange aliases IDs.
const symbols = { 'BTC/USDT': 'BTCUSDT', 'ETH/USDT': 'ETHUSDT', 'SOL/USDT': 'SOLUSDT' } as const;
declare const verifiedHitbtcSymbol: unique symbol;
export type HitbtcSymbol = string & { readonly [verifiedHitbtcSymbol]: true };

function symbolId(symbol: string): string {
  if (!Object.hasOwn(symbols, symbol)) throw new LabError('unsupported-market');
  return symbols[symbol as keyof typeof symbols];
}

export function hitbtcSymbolUrl(symbol: string): string {
  return `https://api.hitbtc.com/api/3/public/symbol/${symbolId(symbol)}`;
}

const metadata = z.object({
  type: z.literal('spot'), base_currency: z.string(),
  quote_currency: z.literal('USDT'), status: z.literal('working')
});

// The single-symbol response has no ID field. The caller must obtain it from
// hitbtcSymbolUrl(symbol); it cannot establish identity from an arbitrary body.
export function parseHitbtcSymbol(symbol: string, payload: unknown): HitbtcSymbol {
  const id = symbolId(symbol);
  try {
    const parsed = metadata.parse(payload);
    if (parsed.base_currency !== symbol.split('/')[0]) throw new Error();
    return id as HitbtcSymbol;
  } catch {
    throw new LabError('invalid-hitbtc-symbol');
  }
}

export function hitbtcBookUrl(id: HitbtcSymbol): string {
  if (!Object.values(symbols).some(candidate => candidate === id)) {
    throw new LabError('unsupported-market');
  }
  return `https://api.hitbtc.com/api/3/public/orderbook/${id}?depth=50`;
}

const decimal = z.string().max(128).regex(/^\d+(?:\.\d+)?$/).transform(Number)
  .refine(value => Number.isFinite(value) && value > 0);
const levels = z.array(z.tuple([decimal, decimal])).min(1).max(50);
const milliseconds = z.union([z.number(), z.string().max(16).regex(/^\d+$/)])
  .transform(Number).refine(value => Number.isSafeInteger(value) && value > 0);
const isoTimestamp = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/)
  .refine(value => {
    const time = Date.parse(value);
    // Date.parse accepts some invalid dates by rolling into the next month.
    return Number.isSafeInteger(time) && time > 0 &&
      new Date(time).toISOString().slice(0, 19) === value.slice(0, 19);
  })
  .transform(value => Date.parse(value));
const snapshot = z.object({ timestamp: z.union([milliseconds, isoTimestamp]), bid: levels, ask: levels });

export function parseHitbtcBook(symbol: string, payload: unknown,
  requestedAt: number, receivedAt: number): OrderBook<'hitbtc'> {
  symbolId(symbol);
  let book: OrderBook<'hitbtc'>;
  try {
    const parsed = snapshot.parse(payload);
    book = { venue: 'hitbtc', symbol, bids: parsed.bid, asks: parsed.ask,
      sourceAt: parsed.timestamp, requestedAt, receivedAt };
  } catch {
    // Upstream bodies and schema errors may contain private or reflected text.
    throw new LabError('invalid-public-book');
  }
  validateBook(book, receivedAt);
  return book;
}
