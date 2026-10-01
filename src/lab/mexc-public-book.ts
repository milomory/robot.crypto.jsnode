import { z } from 'zod';
import { LabError, validateBook, type OrderBook } from './order-book.js';

const symbols = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'] as const;
const decimal = z.string().regex(/^\d+(?:\.\d+)?$/).transform(Number)
  .refine(value => Number.isFinite(value) && value > 0);
const levels = z.array(z.tuple([decimal, decimal])).min(1).max(50);
const snapshot = z.object({
  lastUpdateId: z.number().int().nonnegative().safe(),
  bids: levels,
  asks: levels,
  code: z.never().optional()
});

function compactSymbol(symbol: string): string {
  if (!symbols.some(allowed => allowed === symbol)) throw new LabError('unsupported-market');
  return symbol.replace('/', '');
}

// Public Spot V3 endpoint only; no caller-provided host, path, limit or credentials.
export function mexcPublicBookUrl(symbol: string): string {
  return `https://api.mexc.com/api/v3/depth?symbol=${compactSymbol(symbol)}&limit=50`;
}

export function parseMexcBook(symbol: string, payload: unknown,
  requestedAt: number, receivedAt: number): OrderBook<'mexc'> {
  compactSymbol(symbol);
  let parsed: z.infer<typeof snapshot>;
  try {
    parsed = snapshot.parse(payload);
  } catch {
    // Never expose upstream bodies, schema error values or remote error messages.
    throw new LabError('invalid-public-book');
  }
  // REST depth documents lastUpdateId as a sequence, not a snapshot timestamp.
  // Ignore undocumented timestamp-shaped fields; freshness is receipt-only.
  // https://www.mexc.com/api-docs/spot-v3/market-data-endpoints/order-book
  const book: OrderBook<'mexc'> = {
    venue: 'mexc', symbol, bids: parsed.bids, asks: parsed.asks, requestedAt, receivedAt
  };
  validateBook(book, receivedAt);
  return book;
}
