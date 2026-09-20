// Deliberately independent of the production journal, credentials and order routes.
export type Venue = 'binance' | 'bybit' | 'okx';
export type Level = readonly [price: number, quantity: number];
export interface OrderBook {
  venue: Venue;
  symbol: string;
  bids: Level[];
  asks: Level[];
  requestedAt: number;
  receivedAt: number;
  sourceAt?: number;
}

export class LabError extends Error {}
export const positive = (value: number): boolean => Number.isFinite(value) && value > 0;

export function validateBook(book: OrderBook, now: number, maxAgeMs = 5_000): void {
  if (!positive(now) || !positive(maxAgeMs) || !positive(book.requestedAt) ||
      !positive(book.receivedAt) || book.receivedAt < book.requestedAt ||
      book.receivedAt > now || now - book.requestedAt > maxAgeMs) {
    throw new LabError('stale-or-invalid-receipt-time');
  }
  if (book.sourceAt !== undefined && (!positive(book.sourceAt) ||
      book.sourceAt > now + 1_000 || now - book.sourceAt > maxAgeMs)) {
    throw new LabError('stale-or-invalid-source-time');
  }
  for (const [side, levels] of [['bids', book.bids], ['asks', book.asks]] as const) {
    if (!levels.length || levels.length > 50) throw new LabError('invalid-depth');
    levels.forEach(([price, quantity], i) => {
      if (!positive(price) || !positive(quantity)) throw new LabError('invalid-level');
      if (i && (side === 'bids' ? price >= levels[i - 1][0] : price <= levels[i - 1][0])) {
        throw new LabError('unsorted-or-duplicate-level');
      }
    });
  }
  if (book.bids[0][0] >= book.asks[0][0]) throw new LabError('crossed-or-locked-book');
}

export interface FillAssumptions { feeBps: number; slippageBps: number }
export interface SimulatedFill {
  model: 'depth-v2';
  side: 'buy' | 'sell';
  quantity: number;
  averagePrice: number;
  quoteBeforeSlippage: number;
  slippageQuote: number;
  feeQuote: number;
  cashQuote: number;
}

// Fees are assumed paid in quote currency; slippage is an adverse additional buffer.
export function simulateFill(book: OrderBook, side: 'buy' | 'sell', quantity: number,
  assumptions: FillAssumptions, now: number): SimulatedFill {
  validateBook(book, now);
  if (!positive(quantity) || !['buy', 'sell'].includes(side)) throw new LabError('invalid-order');
  for (const value of [assumptions.feeBps, assumptions.slippageBps]) {
    if (!Number.isFinite(value) || value < 0 || value >= 10_000) throw new LabError('invalid-cost');
  }
  let remaining = quantity;
  let quote = 0;
  for (const [price, available] of side === 'buy' ? book.asks : book.bids) {
    const taken = Math.min(remaining, available);
    quote += taken * price;
    remaining -= taken;
    if (remaining <= 0) break;
  }
  if (remaining > quantity * 1e-12) throw new LabError('insufficient-depth');
  const slippageQuote = quote * assumptions.slippageBps / 10_000;
  const gross = quote + (side === 'buy' ? slippageQuote : -slippageQuote);
  const feeQuote = gross * assumptions.feeBps / 10_000;
  const cashQuote = gross + (side === 'buy' ? feeQuote : -feeQuote);
  if (![quote, gross, cashQuote].every(positive)) throw new LabError('invalid-fill-arithmetic');
  return { model: 'depth-v2', side, quantity, averagePrice: gross / quantity,
    quoteBeforeSlippage: quote, slippageQuote, feeQuote, cashQuote };
}

export function compareVenues(buy: OrderBook, sell: OrderBook, quantity: number,
  costs: Record<Venue, FillAssumptions>, now: number) {
  if (buy.venue === sell.venue || buy.symbol !== sell.symbol) throw new LabError('incompatible-books');
  validateBook(buy, now);
  validateBook(sell, now);
  const earliest = Math.min(buy.sourceAt ?? buy.requestedAt, sell.sourceAt ?? sell.requestedAt);
  const latest = Math.max(buy.receivedAt, sell.receivedAt);
  if (latest - earliest > 2_000) throw new LabError('unsynchronised-books');
  const purchase = simulateFill(buy, 'buy', quantity, costs[buy.venue], now);
  const sale = simulateFill(sell, 'sell', quantity, costs[sell.venue], now);
  const netQuote = sale.cashQuote - purchase.cashQuote;
  return { model: 'depth-v2', symbol: buy.symbol, buyVenue: buy.venue, sellVenue: sell.venue,
    quantity, purchase, sale, netQuote, netBps: netQuote / purchase.cashQuote * 10_000,
    indicativeOnly: true, sourceTimeVerified: buy.sourceAt !== undefined && sell.sourceAt !== undefined };
}
