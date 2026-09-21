// Exact, offline BTC/USDT execution. No production configuration or market I/O.
export const SCALE = 100_000_000n;
const BPS = 10_000n;
export const RAW_DENOMINATOR = SCALE;
export const SLIPPAGE_DENOMINATOR = SCALE * BPS;
export const ROUNDING_DENOMINATOR = SCALE * BPS * BPS;

export type Venue = 'binance' | 'bybit' | 'okx';
export interface Book {
  venue: Venue;
  symbol: 'BTC/USDT';
  bids: [string, string][];
  asks: [string, string][];
  requestedAt: number;
  receivedAt: number;
  sourceAt?: number;
}
export interface Instrument {
  venue: Venue;
  symbol: 'BTC/USDT';
  fetchedAt: number;
  trading: boolean;
  minQuantity: string;
  maxQuantity: string;
  quantityStep: string;
  minNotional?: string;
  maxNotional?: string;
}
export interface Costs {
  feeBps: number;
  slippageBps: number;
  feeAsset: 'USDT';
}
export interface ExactFill {
  quantity: bigint;
  gross: bigint;
  fee: bigint;
  cash: bigint;
  /** Quote atoms before slippage = rawQuoteNumerator / RAW_DENOMINATOR. */
  rawQuoteNumerator: bigint;
  /** Adverse quote atoms = slippageNumerator / SLIPPAGE_DENOMINATOR. */
  slippageNumerator: bigint;
  /** Adverse cash rounding atoms = roundingNumerator / ROUNDING_DENOMINATOR. */
  roundingNumerator: bigint;
}

/** Callers must use fixed reason literals; never include input or exception text. */
export class PaperError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'PaperError';
  }
}

/** Unsigned ordinary decimals only: no exponent, whitespace or leading zeroes. */
export function parseAmount(text: string): bigint {
  if (typeof text !== 'string' || text.length > 29 || !/^(0|[1-9][0-9]{0,19})(?:\.[0-9]{1,8})?$/.test(text)) {
    throw new PaperError('invalid-amount');
  }
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(8, '0'));
}

export function formatAmount(amount: bigint): string {
  if (typeof amount !== 'bigint') throw new PaperError('invalid-amount');
  const absolute = amount < 0n ? -amount : amount;
  return `${amount < 0n ? '-' : ''}${absolute / SCALE}.${(absolute % SCALE).toString().padStart(8, '0')}`;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function venue(value: unknown): value is Venue {
  return value === 'binance' || value === 'bybit' || value === 'okx';
}
function time(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function positive(text: string): bigint {
  const value = parseAmount(text);
  if (value <= 0n) throw new PaperError('non-positive-amount');
  return value;
}
function ceiling(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function levels(input: unknown, side: 'bids' | 'asks'): [bigint, bigint][] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 50) throw new PaperError('invalid-depth');
  const result: [bigint, bigint][] = [];
  for (const level of input) {
    if (!Array.isArray(level) || level.length !== 2) throw new PaperError('invalid-level');
    const price = positive(level[0]);
    const quantity = positive(level[1]);
    const previous = result.at(-1);
    if (previous && (side === 'bids' ? price >= previous[0] : price <= previous[0])) {
      throw new PaperError('unsorted-or-duplicate-level');
    }
    result.push([price, quantity]);
  }
  return result;
}

export function executeFill(book: Book, instrument: Instrument, side: 'buy' | 'sell',
  quantity: string, costs: Costs, now: number): ExactFill {
  if (!record(book) || !record(instrument) || !record(costs)) throw new PaperError('invalid-input');
  if (!venue(book.venue) || !venue(instrument.venue) || book.venue !== instrument.venue) {
    throw new PaperError('incompatible-venue');
  }
  if (book.symbol !== 'BTC/USDT' || instrument.symbol !== 'BTC/USDT') throw new PaperError('unsupported-symbol');
  if (side !== 'buy' && side !== 'sell') throw new PaperError('invalid-side');
  if (!time(now) || !time(book.requestedAt) || !time(book.receivedAt) ||
      book.requestedAt > book.receivedAt || book.receivedAt > now ||
      now - book.receivedAt > 5_000 || now - book.requestedAt > 5_000) {
    throw new PaperError('stale-or-invalid-receipt-time');
  }
  if (book.sourceAt !== undefined && (!time(book.sourceAt) ||
      book.sourceAt - now > 1_000 || now - book.sourceAt > 5_000)) {
    throw new PaperError('stale-or-invalid-source-time');
  }
  if (!time(instrument.fetchedAt) || instrument.fetchedAt > now || now - instrument.fetchedAt > 3_600_000) {
    throw new PaperError('stale-or-invalid-instrument-time');
  }
  if (instrument.trading !== true) throw new PaperError('instrument-not-trading');
  if (costs.feeAsset !== 'USDT') throw new PaperError('unsupported-fee-asset');
  for (const value of [costs.feeBps, costs.slippageBps]) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= 10_000) {
      throw new PaperError('invalid-cost');
    }
  }
  const minQuantity = positive(instrument.minQuantity);
  const maxQuantity = positive(instrument.maxQuantity);
  const step = positive(instrument.quantityStep);
  const minNotional = instrument.minNotional === undefined ? undefined : positive(instrument.minNotional);
  const maxNotional = instrument.maxNotional === undefined ? undefined : positive(instrument.maxNotional);
  if (minQuantity > maxQuantity || step > maxQuantity ||
      (minNotional !== undefined && maxNotional !== undefined && minNotional > maxNotional)) {
    throw new PaperError('invalid-instrument-limits');
  }
  const amount = positive(quantity);
  if (amount < minQuantity || amount > maxQuantity) throw new PaperError('quantity-out-of-range');
  if (amount % step !== 0n) throw new PaperError('quantity-step-mismatch');
  const bids = levels(book.bids, 'bids');
  const asks = levels(book.asks, 'asks');
  if (bids[0][0] >= asks[0][0]) throw new PaperError('crossed-or-locked-book');
  let remaining = amount;
  let rawQuoteNumerator = 0n;
  for (const [price, available] of side === 'buy' ? asks : bids) {
    const taken = remaining < available ? remaining : available;
    rawQuoteNumerator += price * taken;
    remaining -= taken;
    if (remaining === 0n) break;
  }
  if (remaining !== 0n) throw new PaperError('insufficient-depth');
  if ((minNotional !== undefined && rawQuoteNumerator < minNotional * RAW_DENOMINATOR) ||
      (maxNotional !== undefined && rawQuoteNumerator > maxNotional * RAW_DENOMINATOR)) {
    throw new PaperError('notional-out-of-range');
  }
  const slippageBps = BigInt(costs.slippageBps);
  const feeBps = BigInt(costs.feeBps);
  const adjustedNumerator = rawQuoteNumerator * (side === 'buy' ? BPS + slippageBps : BPS - slippageBps);
  const gross = side === 'buy' ? ceiling(adjustedNumerator, SLIPPAGE_DENOMINATOR) : adjustedNumerator / SLIPPAGE_DENOMINATOR;
  // Charge on exact adjusted value, before gross rounding, so rounding is not charged twice.
  const fee = ceiling(adjustedNumerator * feeBps, ROUNDING_DENOMINATOR);
  const cash = side === 'buy' ? gross + fee : gross - fee;
  if (cash <= 0n) throw new PaperError('non-positive-cash');
  const idealCashNumerator = adjustedNumerator * (side === 'buy' ? BPS + feeBps : BPS - feeBps);
  const roundingNumerator = side === 'buy'
    ? cash * ROUNDING_DENOMINATOR - idealCashNumerator
    : idealCashNumerator - cash * ROUNDING_DENOMINATOR;
  return { quantity: amount, gross, fee, cash, rawQuoteNumerator,
    slippageNumerator: rawQuoteNumerator * slippageBps, roundingNumerator };
}
