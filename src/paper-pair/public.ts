import { z } from 'zod';
import { canonical } from '../paper-v2/ledger.js';

export type PairVenue = 'mexc' | 'okx';
export interface PairBook {
  venue: PairVenue; symbol: 'BTC/USDT'; requestedAt: number; receivedAt: number;
  sourceAt: number | null; sourceTime: 'absent' | 'exchange'; sequence: string | null;
  bids: [string, string][]; asks: [string, string][];
}
export interface PairUsdIndex {
  venue: 'okx'; instrument: 'BTC-USD'; requestedAt: number; receivedAt: number; sourceAt: number; usdPerBtc: string;
}
const decimal = z.string().regex(/^(0|[1-9]\d{0,19})(?:\.\d{1,18})?$/);
const time = z.number().int().positive().safe();
const positive = decimal.refine(value => units(value) > 0n);
const integer = z.string().regex(/^(0|[1-9]\d{0,19})$/);
const mexcEvidence = z.object({ venue: z.literal('mexc'), status: z.string().max(16),
  baseAssetPrecision: z.number().int().min(0).max(18), quoteAssetPrecision: z.number().int().min(0).max(18),
  baseSizePrecision: positive, quoteAmountPrecisionMarket: positive, maxQuoteAmountMarket: positive,
  tradeSideType: z.number().int(), isSpotTradingAllowed: z.boolean(), marketOrders: z.boolean(),
  percentPriceFilterPresent: z.boolean() }).strict();
const okxEvidence = z.object({ venue: z.literal('okx'), state: z.string().max(32), lotSz: positive,
  minSz: positive, maxMktSz: positive, maxMktAmt: z.union([z.literal(''), positive]), tickSz: positive,
  upcomingChanges: z.boolean() }).strict();
const evidenceSchema = z.discriminatedUnion('venue', [mexcEvidence, okxEvidence]);
type Evidence = z.infer<typeof evidenceSchema>;
export interface PairInstrument {
  venue: PairVenue; symbol: 'BTC/USDT'; requestedAt: number; receivedAt: number;
  status: 'supported' | 'unsupported';
  reason: 'quantity-step-unconfirmed' | 'market-not-trading' | 'usd-limit-unconverted' | 'upcoming-rule-change' | null;
  quantityStep: string | null; minQuantity: string; maxQuantity: null;
  minNotionalUsdt: string | null; maxNotionalUsdt: string; priceTick: string | null;
  evidence: Evidence;
}
export class PairPublicError extends Error {
  constructor(readonly reason: string) { super(reason); this.name = 'PairPublicError'; }
}
function invalid(): never { throw new PairPublicError('invalid-public-data'); }
function units(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
}
function receipt(requestedAt: number, receivedAt: number) {
  time.parse(requestedAt); time.parse(receivedAt);
  if (requestedAt > receivedAt || receivedAt - requestedAt > 5_000) invalid();
}
function sequence(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid();
  return String(value);
}
function levels(raw: unknown, side: 'bids' | 'asks', okx = false): [string, string][] {
  const rows = z.array(z.array(z.unknown())).min(1).max(50).parse(raw);
  const result: [string, string][] = [];
  for (const row of rows) {
    if (row.length !== (okx ? 4 : 2)) invalid();
    if (okx && (row[2] !== '0' || !integer.safeParse(row[3]).success)) invalid();
    const p = positive.parse(row[0]), q = positive.parse(row[1]);
    const previous = result.at(-1);
    if (previous && (side === 'bids' ? units(p) >= units(previous[0]) : units(p) <= units(previous[0]))) invalid();
    result.push([p, q]);
  }
  return result;
}
export function parsePairBook(venue: PairVenue, raw: unknown, requestedAt: number, receivedAt: number): PairBook {
  try {
    receipt(requestedAt, receivedAt);
    let bids: [string, string][], asks: [string, string][], sourceAt: number | null = null, seq: string | null;
    if (venue === 'mexc') {
      const p = z.object({ lastUpdateId: z.unknown(), bids: z.unknown(), asks: z.unknown(), code: z.never().optional() }).parse(raw);
      seq = sequence(p.lastUpdateId); if (seq === null) invalid();
      bids = levels(p.bids, 'bids'); asks = levels(p.asks, 'asks');
    } else if (venue === 'okx') {
      const p = z.object({ code: z.literal('0'), data: z.array(z.object({ ts: integer,
        seqId: z.unknown().optional(), bids: z.unknown(), asks: z.unknown() })).length(1) }).parse(raw).data[0];
      sourceAt = Number(p.ts); time.parse(sourceAt);
      if (receivedAt - sourceAt > 5_000 || sourceAt - receivedAt > 1_000) invalid();
      seq = sequence(p.seqId); bids = levels(p.bids, 'bids', true); asks = levels(p.asks, 'asks', true);
    } else invalid();
    if (units(bids[0][0]) >= units(asks[0][0])) invalid();
    return { venue, symbol: 'BTC/USDT', requestedAt, receivedAt, sourceAt,
      sourceTime: venue === 'mexc' ? 'absent' : 'exchange', sequence: seq, bids, asks };
  } catch { throw new PairPublicError('invalid-public-book'); }
}
function instrument(e: Evidence, requestedAt: number, receivedAt: number): PairInstrument {
  receipt(requestedAt, receivedAt);
  if (e.venue === 'mexc') {
    if (units(e.quoteAmountPrecisionMarket) > units(e.maxQuoteAmountMarket)) invalid();
    return { venue: 'mexc', symbol: 'BTC/USDT', requestedAt, receivedAt, status: 'unsupported',
      reason: e.status === '1' && e.tradeSideType === 1 && e.isSpotTradingAllowed && e.marketOrders ?
        'quantity-step-unconfirmed' : 'market-not-trading',
      quantityStep: null, minQuantity: e.baseSizePrecision, maxQuantity: null,
      minNotionalUsdt: e.quoteAmountPrecisionMarket, maxNotionalUsdt: e.maxQuoteAmountMarket,
      priceTick: null, evidence: e };
  }
  // maxMktSz for spot is explicitly USDT, NOT BTC. maxMktAmt is USD, not interchangeable.
  const reason = e.state !== 'live' ? 'market-not-trading' : e.upcomingChanges ? 'upcoming-rule-change' :
    e.maxMktAmt !== '' ? 'usd-limit-unconverted' : null;
  return { venue: 'okx', symbol: 'BTC/USDT', requestedAt, receivedAt, status: reason ? 'unsupported' : 'supported',
    reason, quantityStep: e.lotSz, minQuantity: e.minSz, maxQuantity: null,
    minNotionalUsdt: null, maxNotionalUsdt: e.maxMktSz, priceTick: e.tickSz, evidence: e };
}
export function parsePairInstrument(venue: PairVenue, raw: unknown, requestedAt: number, receivedAt: number): PairInstrument {
  try {
    let evidence: Evidence;
    if (venue === 'mexc') {
      const p = z.object({ symbols: z.array(z.object({ symbol: z.literal('BTCUSDT'), baseAsset: z.literal('BTC'),
        quoteAsset: z.literal('USDT'), status: z.string(), baseAssetPrecision: z.number(), quoteAssetPrecision: z.number(),
        baseSizePrecision: positive, quoteAmountPrecisionMarket: positive, maxQuoteAmountMarket: positive,
        tradeSideType: z.number(), isSpotTradingAllowed: z.boolean(), orderTypes: z.array(z.string()).max(20),
        filters: z.array(z.object({ filterType: z.string() })).max(20) })).length(1) }).parse(raw).symbols[0];
      evidence = mexcEvidence.parse({ venue, status: p.status, baseAssetPrecision: p.baseAssetPrecision,
        quoteAssetPrecision: p.quoteAssetPrecision, baseSizePrecision: p.baseSizePrecision,
        quoteAmountPrecisionMarket: p.quoteAmountPrecisionMarket, maxQuoteAmountMarket: p.maxQuoteAmountMarket,
        tradeSideType: p.tradeSideType, isSpotTradingAllowed: p.isSpotTradingAllowed,
        marketOrders: p.orderTypes.includes('MARKET'), percentPriceFilterPresent: p.filters.some(f => f.filterType === 'PERCENT_PRICE_BY_SIDE') });
    } else if (venue === 'okx') {
      const p = z.object({ code: z.literal('0'), data: z.array(z.object({ instType: z.literal('SPOT'),
        instId: z.literal('BTC-USDT'), baseCcy: z.literal('BTC'), quoteCcy: z.literal('USDT'), state: z.string(),
        lotSz: positive, minSz: positive, maxMktSz: positive, maxMktAmt: z.union([z.literal(''), positive]),
        tickSz: positive, upcChg: z.array(z.unknown()).max(100).optional() })).length(1) }).parse(raw).data[0];
      evidence = okxEvidence.parse({ venue, state: p.state, lotSz: p.lotSz, minSz: p.minSz, maxMktSz: p.maxMktSz,
        maxMktAmt: p.maxMktAmt, tickSz: p.tickSz, upcomingChanges: (p.upcChg?.length ?? 0) > 0 });
    } else invalid();
    return instrument(evidence, requestedAt, receivedAt);
  } catch { throw new PairPublicError('invalid-public-instrument'); }
}
const bookSchema = z.object({ venue: z.enum(['mexc', 'okx']), symbol: z.literal('BTC/USDT'), requestedAt: time, receivedAt: time,
  sourceAt: time.nullable(), sourceTime: z.enum(['absent', 'exchange']), sequence: integer.nullable(),
  bids: z.array(z.tuple([positive, positive])).min(1).max(50), asks: z.array(z.tuple([positive, positive])).min(1).max(50) }).strict();
export function validatePairBook(value: unknown): PairBook {
  try {
    const p = bookSchema.parse(value); receipt(p.requestedAt, p.receivedAt);
    const bids = levels(p.bids, 'bids'), asks = levels(p.asks, 'asks');
    if (units(bids[0][0]) >= units(asks[0][0])) invalid();
    if (p.venue === 'mexc') { if (p.sourceTime !== 'absent' || p.sourceAt !== null || p.sequence === null) invalid(); }
    else if (p.sourceTime !== 'exchange' || p.sourceAt === null || p.receivedAt - p.sourceAt > 5_000 || p.sourceAt - p.receivedAt > 1_000) invalid();
    return p;
  } catch { throw new PairPublicError('invalid-public-book'); }
}
export function validatePairInstrument(value: unknown): PairInstrument {
  try {
    const p = z.object({ evidence: evidenceSchema, requestedAt: time, receivedAt: time }).passthrough().parse(value);
    const checked = instrument(p.evidence, p.requestedAt, p.receivedAt);
    if (canonical(checked) !== canonical(value)) invalid();
    return checked;
  } catch { throw new PairPublicError('invalid-public-instrument'); }
}
const usdIndexSchema = z.object({ venue: z.literal('okx'), instrument: z.literal('BTC-USD'),
  requestedAt: time, receivedAt: time, sourceAt: time, usdPerBtc: positive }).strict();
export function validatePairUsdIndex(value: unknown): PairUsdIndex {
  try {
    const p = usdIndexSchema.parse(value); receipt(p.requestedAt, p.receivedAt);
    if (p.receivedAt - p.sourceAt > 5_000 || p.sourceAt - p.receivedAt > 1_000) invalid();
    return p;
  } catch { throw new PairPublicError('invalid-public-usd-index'); }
}
export function parsePairUsdIndex(raw: unknown, requestedAt: number, receivedAt: number): PairUsdIndex {
  try {
    const p = z.object({ code: z.literal('0'), data: z.array(z.object({ instId: z.literal('BTC-USD'),
      idxPx: positive, ts: integer })).length(1) }).parse(raw).data[0];
    return validatePairUsdIndex({ venue: 'okx', instrument: 'BTC-USD', requestedAt, receivedAt,
      sourceAt: Number(p.ts), usdPerBtc: p.idxPx });
  } catch { throw new PairPublicError('invalid-public-usd-index'); }
}
const USD_INDEX_URL = 'https://www.okx.com/api/v5/market/index-tickers?instId=BTC-USD';
const URLS = {
  mexc: { book: 'https://api.mexc.com/api/v3/depth?symbol=BTCUSDT&limit=50', instrument: 'https://api.mexc.com/api/v3/exchangeInfo?symbol=BTCUSDT' },
  okx: { book: 'https://www.okx.com/api/v5/market/books?instId=BTC-USDT&sz=50', instrument: 'https://www.okx.com/api/v5/public/instruments?instType=SPOT&instId=BTC-USDT' }
} as const;
async function boundedBody(response: Response): Promise<unknown> {
  const limit = 128 * 1024, length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || BigInt(length) > BigInt(limit))) {
    void response.body?.cancel().catch(() => {}); throw new PairPublicError('public-response-too-large');
  }
  if (!response.body) invalid();
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength; if (bytes > limit) throw new PairPublicError('public-response-too-large');
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export class ExactPairPublicClient {
  private readonly busy = new Set<PairVenue>();
  private readonly halted = new Set<PairVenue>();
  constructor(private readonly request: typeof fetch = fetch, private readonly clock: () => number = Date.now) {}
  private async get(venue: PairVenue, kind: 'book' | 'instrument' | 'usd-index', parent?: AbortSignal) {
    if ((venue !== 'mexc' && venue !== 'okx') || (kind === 'usd-index' && venue !== 'okx')) throw new PairPublicError('unsupported-venue');
    if (this.busy.has(venue) || this.halted.has(venue)) throw new PairPublicError('public-venue-unavailable');
    this.busy.add(venue);
    const controller = new AbortController(); const abort = () => controller.abort();
    parent?.addEventListener('abort', abort, { once: true }); if (parent?.aborted) controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const requestedAt = this.clock(); time.parse(requestedAt);
      const operation = async () => {
        const response = await this.request(kind === 'usd-index' ? USD_INDEX_URL : URLS[venue][kind], { method: 'GET', credentials: 'omit', redirect: 'error', signal: controller.signal });
        if (!response.ok) {
          if (response.status === 429 || response.status === 418) this.halted.add(venue);
          void response.body?.cancel().catch(() => {}); throw new PairPublicError('public-http-unavailable');
        }
        const raw = await boundedBody(response); const receivedAt = this.clock();
        const code = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).code : undefined;
        if ((venue === 'okx' && (code === '50011' || code === '50040')) ||
            (venue === 'mexc' && (code === 429 || code === '429'))) {
          this.halted.add(venue); throw new PairPublicError('public-rate-limited');
        }
        if (controller.signal.aborted) throw new PairPublicError('public-timeout');
        if (kind === 'usd-index') return parsePairUsdIndex(raw, requestedAt, receivedAt);
        return kind === 'book' ? parsePairBook(venue, raw, requestedAt, receivedAt) : parsePairInstrument(venue, raw, requestedAt, receivedAt);
      };
      return await Promise.race([operation(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new PairPublicError('public-timeout')); }, 5_000);
      })]);
    } catch (error) {
      if (error instanceof PairPublicError) throw error;
      throw new PairPublicError('public-data-unavailable');
    } finally { clearTimeout(timer); controller.abort(); parent?.removeEventListener('abort', abort); this.busy.delete(venue); }
  }
  async getUsdIndex(signal?: AbortSignal): Promise<PairUsdIndex> { return await this.get('okx', 'usd-index', signal) as PairUsdIndex; }
  async getBook(venue: PairVenue, signal?: AbortSignal): Promise<PairBook> { return await this.get(venue, 'book', signal) as PairBook; }
  async getInstrument(venue: PairVenue, signal?: AbortSignal): Promise<PairInstrument> { return await this.get(venue, 'instrument', signal) as PairInstrument; }
}
