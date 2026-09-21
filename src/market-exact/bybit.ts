import { PaperError } from '../paper-v2/exact.js';
import type { Book, Instrument } from '../paper-v2/exact.js';

// Public BTC/USDT spot only. Monetary values stay strings through the archive.
export interface RawBook {
  venue: 'bybit'; symbol: 'BTC/USDT'; requestedAt: number; receivedAt: number;
  systemAt: number; matchingAt?: number; bids: [string, string][]; asks: [string, string][];
}
export interface RawInstrument {
  venue: 'bybit'; symbol: 'BTC/USDT'; requestedAt: number; receivedAt: number; status: 'Trading';
  basePrecision: string; quotePrecision: string; minOrderAmt: string; maxMarketOrderQty: string; tickSize: string;
}
const RAW_SCALE = 1_000_000_000_000_000_000n;
const MAX_RESPONSE_BYTES = 128 * 1024;
const BOOK_URL = 'https://api.bybit.com/v5/market/orderbook?category=spot&symbol=BTCUSDT&limit=50';
const INSTRUMENT_URL = 'https://api.bybit.com/v5/market/instruments-info?category=spot&symbol=BTCUSDT';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function receipt(requestedAt: number, receivedAt: number): void {
  if (!timestamp(requestedAt) || !timestamp(receivedAt) || requestedAt > receivedAt || receivedAt - requestedAt > 5_000) {
    throw new PaperError('exact-market-invalid-receipt-time');
  }
}
function decimal(value: unknown): string {
  if (typeof value !== 'string' || value.length > 39 || !/^(0|[1-9][0-9]{0,19})(?:\.[0-9]{1,18})?$/.test(value)) {
    throw new PaperError('exact-market-invalid-decimal');
  }
  const [whole, fraction = ''] = value.split('.');
  if (BigInt(whole) * RAW_SCALE + BigInt(fraction.padEnd(18, '0')) <= 0n) {
    throw new PaperError('exact-market-invalid-decimal');
  }
  return value;
}
function scaled(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * RAW_SCALE + BigInt(fraction.padEnd(18, '0'));
}
function envelope(raw: unknown): Record<string, unknown> {
  if (!object(raw) || raw.retCode !== 0 || !object(raw.result)) throw new PaperError('exact-market-invalid-response');
  return raw.result;
}
function levels(raw: unknown, side: 'bids' | 'asks'): [string, string][] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 50) throw new PaperError('exact-market-invalid-depth');
  const result: [string, string][] = [];
  let previous: bigint | undefined;
  for (const level of raw) {
    if (!Array.isArray(level) || level.length !== 2) throw new PaperError('exact-market-invalid-level');
    const price = decimal(level[0]), quantity = decimal(level[1]);
    const numeric = scaled(price);
    if (previous !== undefined && (side === 'bids' ? numeric >= previous : numeric <= previous)) {
      throw new PaperError('exact-market-unsorted-book');
    }
    previous = numeric;
    result.push([price, quantity]);
  }
  return result;
}

export function parseRawBook(raw: unknown, requestedAt: number, receivedAt: number): RawBook {
  receipt(requestedAt, receivedAt);
  const result = envelope(raw);
  // Bybit orderbook has no required category field; the client URL fixes spot.
  if (result.s !== 'BTCUSDT' || (result.category !== undefined && result.category !== 'spot')) {
    throw new PaperError('exact-market-wrong-market');
  }
  if (!timestamp(result.ts) || (result.cts !== undefined && !timestamp(result.cts))) {
    throw new PaperError('exact-market-invalid-source-time');
  }
  const sourceAt = result.cts ?? result.ts;
  if (typeof sourceAt !== 'number' || receivedAt - sourceAt > 5_000 || sourceAt - receivedAt > 1_000) {
    throw new PaperError('exact-market-invalid-source-time');
  }
  const bids = levels(result.b, 'bids'), asks = levels(result.a, 'asks');
  if (scaled(bids[0][0]) >= scaled(asks[0][0])) throw new PaperError('exact-market-crossed-book');
  return { venue: 'bybit', symbol: 'BTC/USDT', requestedAt, receivedAt, systemAt: result.ts,
    ...(result.cts === undefined ? {} : { matchingAt: result.cts as number }), bids, asks };
}

export function parseRawInstrument(raw: unknown, requestedAt: number, receivedAt: number): RawInstrument {
  receipt(requestedAt, receivedAt);
  const result = envelope(raw);
  if (result.category !== 'spot' || !Array.isArray(result.list) || result.list.length !== 1 || !object(result.list[0])) {
    throw new PaperError('exact-market-wrong-market');
  }
  const item = result.list[0];
  if (item.symbol !== 'BTCUSDT' || item.baseCoin !== 'BTC' || item.quoteCoin !== 'USDT' || item.status !== 'Trading') {
    throw new PaperError('exact-market-wrong-market');
  }
  if (!object(item.lotSizeFilter) || !object(item.priceFilter)) throw new PaperError('exact-market-invalid-instrument');
  const lots = item.lotSizeFilter;
  const basePrecision = decimal(lots.basePrecision), quotePrecision = decimal(lots.quotePrecision);
  const minOrderAmt = decimal(lots.minOrderAmt), maxMarketOrderQty = decimal(lots.maxMarketOrderQty);
  const tickSize = decimal(item.priceFilter.tickSize);
  if (scaled(basePrecision) > scaled(maxMarketOrderQty)) throw new PaperError('exact-market-invalid-instrument');
  // Deprecated minOrderQty/maxOrderQty/maxOrderAmt are deliberately not read.
  return { venue: 'bybit', symbol: 'BTC/USDT', requestedAt, receivedAt, status: 'Trading',
    basePrecision, quotePrecision, minOrderAmt, maxMarketOrderQty, tickSize };
}

function paperAmount(value: string): string {
  const checked = decimal(value);
  const trimmed = checked.includes('.') ? checked.replace(/0+$/, '').replace(/\.$/, '') : checked;
  if ((trimmed.split('.')[1]?.length ?? 0) > 8) throw new PaperError('unsupported-paper-precision');
  return trimmed;
}
export function toPaperBook(raw: RawBook): Book {
  if (!object(raw) || raw.venue !== 'bybit' || raw.symbol !== 'BTC/USDT') throw new PaperError('exact-market-wrong-market');
  const checked = parseRawBook({ retCode: 0, result: { s: 'BTCUSDT', b: raw.bids, a: raw.asks,
    ts: raw.systemAt, cts: raw.matchingAt } }, raw.requestedAt, raw.receivedAt);
  return { venue: 'bybit', symbol: 'BTC/USDT', requestedAt: checked.requestedAt, receivedAt: checked.receivedAt,
    sourceAt: checked.matchingAt ?? checked.systemAt,
    bids: checked.bids.map(([price, quantity]) => [paperAmount(price), paperAmount(quantity)]),
    asks: checked.asks.map(([price, quantity]) => [paperAmount(price), paperAmount(quantity)]) };
}
export function toPaperInstrument(raw: RawInstrument): Instrument {
  if (!object(raw) || raw.venue !== 'bybit' || raw.symbol !== 'BTC/USDT') throw new PaperError('exact-market-wrong-market');
  const checked = parseRawInstrument({ retCode: 0, result: { category: 'spot', list: [{ symbol: 'BTCUSDT',
    baseCoin: 'BTC', quoteCoin: 'USDT', status: raw.status, lotSizeFilter: { basePrecision: raw.basePrecision,
      quotePrecision: raw.quotePrecision, minOrderAmt: raw.minOrderAmt, maxMarketOrderQty: raw.maxMarketOrderQty },
    priceFilter: { tickSize: raw.tickSize } }] } }, raw.requestedAt, raw.receivedAt);
  // quotePrecision/tickSize remain archive evidence; paper-v2 uses its declared 8-digit cash precision.
  return { venue: 'bybit', symbol: 'BTC/USDT', fetchedAt: checked.receivedAt, trading: true,
    minQuantity: paperAmount(checked.basePrecision), quantityStep: paperAmount(checked.basePrecision),
    maxQuantity: paperAmount(checked.maxMarketOrderQty), minNotional: paperAmount(checked.minOrderAmt) };
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && (!/^[0-9]+$/.test(declaredLength) || BigInt(declaredLength) > BigInt(MAX_RESPONSE_BYTES))) {
    void response.body?.cancel().catch(() => undefined);
    throw new PaperError('exact-market-response-too-large');
  }
  if (!response.body) throw new PaperError('exact-market-invalid-response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new PaperError('exact-market-response-too-large');
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
  catch { throw new PaperError('exact-market-invalid-response'); }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener('abort', aborted);
      reject(new PaperError('exact-market-aborted'));
    };
    // Both handlers stay attached to consume a late settlement after abort.
    promise.then(value => { signal.removeEventListener('abort', aborted); resolve(value); },
      error => { signal.removeEventListener('abort', aborted); reject(error); });
    if (signal.aborted) { aborted(); return; }
    signal.addEventListener('abort', aborted, { once: true });
  });
}

export class ExactBybitClient {
  private cooldownUntil = 0;
  constructor(private readonly request: typeof fetch = fetch, private readonly clock: () => number = Date.now) {}
  async getBook(signal?: AbortSignal): Promise<RawBook> {
    const { raw, requestedAt, receivedAt } = await this.get(BOOK_URL, signal);
    return parseRawBook(raw, requestedAt, receivedAt);
  }
  async getInstrument(signal?: AbortSignal): Promise<RawInstrument> {
    const { raw, requestedAt, receivedAt } = await this.get(INSTRUMENT_URL, signal);
    return parseRawInstrument(raw, requestedAt, receivedAt);
  }
  private rateLimited(response: Response): void {
    const now = this.clock();
    if (!timestamp(now)) { this.cooldownUntil = Infinity; return; }
    const retryAfter = response.headers.get('retry-after')?.trim();
    let requestedUntil = now + 60_000;
    if (retryAfter) {
      if (/^[0-9]+(?:\.[0-9]+)?$/.test(retryAfter)) {
        // Numeric conversion applies only to time. Huge waits stay infinite.
        requestedUntil = Math.max(requestedUntil, now + Number(retryAfter) * 1_000);
      } else {
        const date = Date.parse(retryAfter);
        if (Number.isFinite(date)) requestedUntil = Math.max(requestedUntil, date);
      }
    }
    this.cooldownUntil = Math.max(this.cooldownUntil, requestedUntil);
  }
  private async get(url: string, externalSignal?: AbortSignal) {
    const requestedAt = this.clock();
    if (!timestamp(requestedAt)) throw new PaperError('exact-market-invalid-receipt-time');
    if (requestedAt < this.cooldownUntil) throw new PaperError('exact-market-cooldown');
    if (externalSignal?.aborted) throw new PaperError('exact-market-aborted');
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 5_000);
    timer.unref?.();
    const signal = externalSignal ? AbortSignal.any([externalSignal, timeout.signal]) : timeout.signal;
    const knownErrors = new Set(['exact-market-rate-limited', 'exact-market-http-error',
      'exact-market-api-error', 'exact-market-invalid-response', 'exact-market-response-too-large']);
    try {
      const response = await abortable(this.request(url, { method: 'GET', redirect: 'error', credentials: 'omit', signal,
        headers: { accept: 'application/json' } }), signal);
      if (response.status === 418 || response.status === 429) {
        this.rateLimited(response);
        void response.body?.cancel().catch(() => undefined);
        throw new PaperError('exact-market-rate-limited');
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new PaperError('exact-market-http-error');
      }
      const raw = await boundedJson(response, signal);
      if (object(raw) && raw.retCode === 10006) {
        this.rateLimited(response);
        throw new PaperError('exact-market-rate-limited');
      }
      if (!object(raw) || raw.retCode !== 0) throw new PaperError('exact-market-api-error');
      const receivedAt = this.clock();
      receipt(requestedAt, receivedAt);
      return { raw, requestedAt, receivedAt };
    } catch (error) {
      if (externalSignal?.aborted) throw new PaperError('exact-market-aborted');
      if (timeout.signal.aborted) throw new PaperError('exact-market-timeout');
      if (error instanceof PaperError && knownErrors.has(error.reason)) throw error;
      throw new PaperError('exact-market-request-failed');
    } finally { clearTimeout(timer); }
  }
}
