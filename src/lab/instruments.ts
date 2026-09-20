import { z } from 'zod';
import { LabError, type Venue } from './order-book.js';
import { LAB_SYMBOLS, VENUES } from './public-books.js';

const decimal = z.string().regex(/^\d{1,20}(?:\.\d{1,18})?$/);
const positive = decimal.refine(v => Number(v) > 0);
const lot = z.object({ min: decimal, max: positive, step: decimal }).strict();
export const instrumentSchema = z.object({
  venue: z.enum(['binance', 'bybit', 'okx']), symbol: z.enum(LAB_SYMBOLS),
  fetchedAt: z.number().int().positive().safe(), trading: z.boolean(),
  lots: z.array(lot).min(1).max(2), minQuote: decimal.optional(), maxQuote: positive.optional(),
  notionalReference: z.enum(['snapshot-estimate', 'not-published'])
}).strict();
export type Instrument = z.infer<typeof instrumentSchema>;
export const instrumentResultSchema = z.discriminatedUnion('available', [
  z.object({ available: z.literal(true), instrument: instrumentSchema }).strict(),
  z.object({ available: z.literal(false), reason: z.literal('instrument-unavailable') }).strict()
]);
export const instrumentsSchema = z.object({ binance: instrumentResultSchema,
  bybit: instrumentResultSchema, okx: instrumentResultSchema }).strict();
export type Instruments = z.infer<typeof instrumentsSchema>;

export function parseInstrument(venue: Venue, symbol: string, raw: unknown, fetchedAt: number): Instrument {
  try {
    const compact = symbol.replace('/', '');
    let data: unknown;
    if (venue === 'binance') {
      const p = z.object({ symbols: z.array(z.object({ symbol: z.string(), status: z.string(),
        filters: z.array(z.record(z.unknown())) })) }).parse(raw);
      if (p.symbols.length !== 1 || p.symbols[0].symbol !== compact) throw new Error();
      const item = p.symbols[0];
      const get = (type: string) => item.filters.find(f => f.filterType === type);
      if (!get('LOT_SIZE')) throw new Error();
      const min = get('MIN_NOTIONAL'), notional = get('NOTIONAL');
      // Do not guess market applicability from missing or malformed flags.
      if (min && typeof min.applyToMarket !== 'boolean') throw new Error();
      if (notional && (typeof notional.applyMinToMarket !== 'boolean' || typeof notional.applyMaxToMarket !== 'boolean')) throw new Error();
      const minimums = [min?.applyToMarket ? decimal.parse(min.minNotional) : '0',
        notional?.applyMinToMarket ? decimal.parse(notional.minNotional) : '0'];
      const minQuote = minimums.sort((a, b) => Number(b) - Number(a))[0];
      data = { venue, symbol, fetchedAt, trading: item.status === 'TRADING',
        lots: [get('LOT_SIZE'), get('MARKET_LOT_SIZE')].filter(Boolean).map(f => ({ min: f!.minQty, max: f!.maxQty, step: f!.stepSize })),
        minQuote, maxQuote: notional?.applyMaxToMarket ? notional.maxNotional : undefined,
        notionalReference: 'snapshot-estimate' };
    } else if (venue === 'bybit') {
      const p = z.object({ retCode: z.literal(0), result: z.object({ list: z.array(z.object({
        symbol: z.string(), status: z.string(), lotSizeFilter: z.object({ basePrecision: positive,
          minOrderQty: decimal, maxMarketOrderQty: positive, minOrderAmt: decimal })
      })).length(1) }) }).parse(raw);
      const item = p.result.list[0]; if (item.symbol !== compact) throw new Error();
      data = { venue, symbol, fetchedAt, trading: item.status === 'Trading', lots: [{
        min: item.lotSizeFilter.minOrderQty, max: item.lotSizeFilter.maxMarketOrderQty, step: item.lotSizeFilter.basePrecision }],
        minQuote: item.lotSizeFilter.minOrderAmt, notionalReference: 'snapshot-estimate' };
    } else {
      const p = z.object({ code: z.literal('0'), data: z.array(z.object({ instId: z.string(),
        state: z.string(), lotSz: positive, minSz: positive, maxMktSz: positive })).length(1) }).parse(raw);
      const item = p.data[0]; if (item.instId !== symbol.replace('/', '-')) throw new Error();
      data = { venue, symbol, fetchedAt, trading: item.state === 'live',
        lots: [{ min: item.minSz, max: item.maxMktSz, step: item.lotSz }], notionalReference: 'not-published' };
    }
    const result = instrumentSchema.parse(data);
    if (result.lots.some(l => Number(l.min) > Number(l.max))) throw new Error();
    return result;
  } catch { throw new LabError('invalid-instrument'); }
}

// Integer arithmetic for step checks: never round an invalid quantity into a valid one.
function units(raw: string): bigint {
  const [whole, fraction = ''] = decimal.parse(raw).split('.');
  return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
}
function quantityText(quantity: number): string {
  if (!Number.isFinite(quantity) || quantity <= 0) throw new LabError('invalid-quantity');
  const raw = String(quantity);
  if (!raw.includes('e')) return raw;
  const [mantissa, power] = raw.split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  const digits = whole + fraction, point = whole.length + Number(power);
  if (Math.abs(Number(power)) > 18) throw new LabError('unsupported-quantity-precision');
  return point <= 0 ? `0.${'0'.repeat(-point)}${digits}` :
    point >= digits.length ? digits + '0'.repeat(point - digits.length) : `${digits.slice(0, point)}.${digits.slice(point)}`;
}
export function checkSize(instrument: Instrument, quantity: number, notional: number, now: number): void {
  instrumentSchema.parse(instrument);
  if (now < instrument.fetchedAt || now - instrument.fetchedAt > 3_600_000) throw new LabError('stale-instrument');
  if (!instrument.trading) throw new LabError('market-not-trading');
  const amount = units(quantityText(quantity));
  for (const rule of instrument.lots) {
    if (amount < units(rule.min)) throw new LabError('below-minimum-quantity');
    if (amount > units(rule.max)) throw new LabError('above-maximum-quantity');
    const step = units(rule.step);
    if (step > 0 && amount % step !== 0n) throw new LabError('quantity-step-mismatch');
  }
  if (!Number.isFinite(notional) || notional <= 0) throw new LabError('invalid-notional');
  if (instrument.minQuote !== undefined && notional < Number(instrument.minQuote)) throw new LabError('below-minimum-notional');
  if (instrument.maxQuote !== undefined && notional > Number(instrument.maxQuote)) throw new LabError('above-maximum-notional');
}

export async function fetchInstruments(symbol: string, request: typeof fetch = fetch): Promise<Instruments> {
  if (!LAB_SYMBOLS.some(s => s === symbol)) throw new LabError('unsupported-market');
  const urls: Record<Venue, string> = {
    binance: `https://data-api.binance.vision/api/v3/exchangeInfo?symbol=${symbol.replace('/', '')}`,
    bybit: `https://api.bybit.com/v5/market/instruments-info?category=spot&symbol=${symbol.replace('/', '')}`,
    okx: `https://www.okx.com/api/v5/public/instruments?instType=SPOT&instId=${symbol.replace('/', '-')}`
  };
  const results = await Promise.all(VENUES.map(async venue => {
    try {
      const r = await request(urls[venue], { method: 'GET', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(5_000) });
      if (!r.ok) throw new Error();
      return [venue, { available: true, instrument: parseInstrument(venue, symbol, await r.json(), Date.now()) }];
    } catch { return [venue, { available: false, reason: 'instrument-unavailable' }]; }
  }));
  return instrumentsSchema.parse(Object.fromEntries(results));
}
