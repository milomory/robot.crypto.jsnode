/** Private single-order recovery evidence. GET-only; never a sender or account-identity attestation. */
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { AccountTransport } from './transport.js';
import { AccountError, type AccountOptions } from './types.js';

export type RecoveryVenue = 'mexc' | 'okx';
export type RecoveryWindow = { from: number; to: number };
export type RecoveryOrderSelector = { clientOrderId: string; exchangeOrderId?: never } |
  { exchangeOrderId: string; clientOrderId?: never };
const decimal = z.string().regex(/^(?:0|[1-9]\d{0,29})(?:\.\d{1,30})?$/);
const signed = z.string().regex(/^-?(?:0|[1-9]\d{0,29})(?:\.\d{1,30})?$/);
const token = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const currency = z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,31}$/);
const upstreamId = z.union([z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), z.number().int().nonnegative().safe()]).transform(String);
const clientId = z.string().regex(/^[A-Za-z0-9]{32}$/);
const millis = z.union([z.number().int().positive().safe(), z.string().regex(/^[1-9]\d{0,15}$/)])
  .transform(Number).refine(value => Number.isSafeInteger(value) && value <= 8_640_000_000_000_000);
const empty = z.literal('');
const optionalDecimal = z.union([decimal, empty]).optional();
const optionalSigned = z.union([signed, empty]).optional();
const optionalCurrency = z.union([currency, empty]).optional();
const optionalToken = z.union([token, empty]).optional();
function normalize(value: string) {
  const [whole, fraction] = value.split('.'), tail = fraction?.replace(/0+$/, '');
  return tail ? `${whole}.${tail}` : whole;
}
// Unknown upstream fields are stripped, while every field required for binding is validated.
const mexcOrder = z.object({
  symbol: z.literal('BTCUSDT'), orderId: upstreamId, clientOrderId: clientId,
  origClientOrderId: clientId.optional(), price: decimal, Qty: decimal.optional(), origQty: decimal.optional(),
  executedQty: decimal, cumulativeQuoteQty: decimal.optional(), cummulativeQuoteQty: decimal.optional(),
  status: token, type: token, side: token, time: millis, updateTime: millis,
  timeInForce: token.optional(), origQuoteOrderQty: decimal.optional(),
}).refine(row => (row.Qty !== undefined || row.origQty !== undefined) &&
  (row.Qty === undefined || row.origQty === undefined || normalize(row.Qty) === normalize(row.origQty)) &&
  (row.cumulativeQuoteQty !== undefined || row.cummulativeQuoteQty !== undefined) &&
  (row.cumulativeQuoteQty === undefined || row.cummulativeQuoteQty === undefined || normalize(row.cumulativeQuoteQty) === normalize(row.cummulativeQuoteQty)) &&
  (row.origClientOrderId === undefined || row.origClientOrderId === row.clientOrderId));
const okxOrder = z.object({
  instType: z.literal('SPOT'), instId: z.literal('BTC-USDT'), ordId: upstreamId, clOrdId: clientId,
  tdMode: token, category: optionalToken, side: token, ordType: token, state: token,
  sz: decimal, px: decimal, accFillSz: decimal, avgPx: z.union([decimal, empty]),
  fee: optionalSigned, feeCcy: optionalCurrency, rebate: optionalSigned, rebateCcy: optionalCurrency,
  cTime: millis, uTime: millis, tgtCcy: optionalToken, tradeQuoteCcy: optionalCurrency,
});
const mexcFill = z.object({
  symbol: z.literal('BTCUSDT'), id: upstreamId, orderId: upstreamId,
  clientOrderId: clientId.nullable().optional(), price: decimal, qty: decimal, quoteQty: decimal,
  commission: decimal, commissionAsset: currency, time: millis,
  isBuyer: z.boolean(), isMaker: z.boolean().optional(), isSelfTrade: z.boolean().optional(),
});
const okxFill = z.object({
  instType: z.literal('SPOT'), instId: z.literal('BTC-USDT'), ordId: upstreamId, tradeId: upstreamId, billId: upstreamId,
  clOrdId: z.union([clientId, empty]).optional(), side: token, subType: optionalToken, execType: optionalToken,
  fillSz: decimal, fillPx: decimal, fee: signed, feeCcy: currency, fillTime: millis, ts: millis,
  tradeQuoteCcy: optionalCurrency,
});
export type RecoveryMexcOrder = z.infer<typeof mexcOrder>;
export type RecoveryOkxOrder = z.infer<typeof okxOrder>;
export type RecoveryMexcFill = z.infer<typeof mexcFill>;
export type RecoveryOkxFill = z.infer<typeof okxFill>;
type ReadMetadata = { readonly requestedAt: number; readonly receivedAt: number; readonly query: Readonly<Record<string, string>> };
export type RecoveryOrderRead = ReadMetadata & { readonly kind: 'order' } & (
  { readonly venue: 'mexc'; readonly data: Readonly<RecoveryMexcOrder> } |
  { readonly venue: 'okx'; readonly data: Readonly<RecoveryOkxOrder> });
export type RecoveryFillsRead = ReadMetadata & { readonly kind: 'fills' } & (
  { readonly venue: 'mexc'; readonly data: readonly Readonly<RecoveryMexcFill>[] } |
  { readonly venue: 'okx'; readonly data: readonly Readonly<RecoveryOkxFill>[] });
function invalid(): never { throw new AccountError('account-invalid-response'); }
function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value); return parsed.success ? parsed.data : invalid();
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const member of Object.values(value)) freeze(member);
    Object.freeze(value);
  }
  return value;
}
/** Dedicated projections never change the pre-existing historical archive contract. */
export function projectRecoveryOrder(venue: RecoveryVenue, value: unknown): RecoveryMexcOrder | RecoveryOkxOrder {
  if (venue === 'mexc') return freeze(parse(mexcOrder, value));
  if (venue !== 'okx') return invalid();
  return freeze(parse(okxOrder, Array.isArray(value) ? parse(z.array(z.unknown()).length(1), value)[0] : value));
}
export function projectRecoveryFills(venue: RecoveryVenue, value: unknown): RecoveryMexcFill[] | RecoveryOkxFill[] {
  if (venue === 'mexc') return freeze(parse(z.array(mexcFill).max(1000), value));
  if (venue === 'okx') return freeze(parse(z.array(okxFill).max(100), value));
  return invalid();
}
function selector(value: RecoveryOrderSelector): RecoveryOrderSelector {
  const schema = z.union([z.object({ clientOrderId: clientId }).strict(),
    z.object({ exchangeOrderId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }).strict()]);
  const result = schema.safeParse(value);
  if (!result.success) throw new AccountError('account-invalid-order-selector');
  return result.data;
}
function orderId(value: string) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new AccountError('account-invalid-order-id');
  return value;
}
function window(value: RecoveryWindow) {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 2 ||
      !Number.isSafeInteger(value.from) || !Number.isSafeInteger(value.to) || value.from <= 0 ||
      value.to < value.from || value.to - value.from > 7 * 86400_000 || value.to > 8_640_000_000_000_000) {
    throw new AccountError('account-invalid-history-window');
  }
  return value;
}

/** No environment or secret lookup, pagination, retry, not-found inference, or operation beyond GET. */
export class OrderRecoveryReader {
  readonly #venue: RecoveryVenue;
  get venue(): RecoveryVenue { return this.#venue; }
  readonly #transport: AccountTransport;
  readonly #credentials: AccountOptions['credentials'];
  constructor(venue: RecoveryVenue, options: AccountOptions) {
    if (!['mexc', 'okx'].includes(venue) || !options?.credentials || (venue === 'okx' && !options.credentials.passphrase)) throw new AccountError('account-invalid-config');
    this.#venue = venue;
    this.#transport = new AccountTransport(options, 'order-recovery');
    this.#credentials = { ...options.credentials };
    Object.freeze(this);
  }
  async #get(kind: 'order' | 'fills', path: string, query: Record<string, string>): Promise<RecoveryOrderRead | RecoveryFillsRead> {
    const requestedAt = this.#transport.now();
    if (requestedAt <= 0 || requestedAt > 8_640_000_000_000_000) throw new AccountError('account-invalid-clock');
    let raw: unknown;
    if (this.#venue === 'mexc') {
      const unsigned = new URLSearchParams({ ...query, recvWindow: '5000', timestamp: String(requestedAt) }).toString();
      const signature = createHmac('sha256', this.#credentials.apiSecret).update(unsigned).digest('hex');
      raw = await this.#transport.request(`https://api.mexc.com${path}?${unsigned}&signature=${signature}`, { 'X-MEXC-APIKEY': this.#credentials.apiKey });
      if (raw && !Array.isArray(raw) && typeof raw === 'object' && 'code' in raw && raw.code !== 0) {
        if ([429, 418].includes(raw.code as number)) { this.#transport.cooldown(60_000); throw new AccountError('account-rate-limited'); }
        throw new AccountError('account-api-rejected');
      }
    } else {
      const target = `${path}?${new URLSearchParams(query)}`, stamp = new Date(requestedAt).toISOString();
      const signature = createHmac('sha256', this.#credentials.apiSecret).update(`${stamp}GET${target}`).digest('base64');
      const response = await this.#transport.request('https://www.okx.com' + target, {
        'OK-ACCESS-KEY': this.#credentials.apiKey, 'OK-ACCESS-SIGN': signature, 'OK-ACCESS-TIMESTAMP': stamp,
        'OK-ACCESS-PASSPHRASE': this.#credentials.passphrase!, 'Content-Type': 'application/json' });
      if (!response || typeof response !== 'object' || !('code' in response) || !('data' in response)) return invalid();
      if (['50011', '50013', '50040'].includes(String(response.code))) { this.#transport.cooldown(60_000); throw new AccountError('account-rate-limited'); }
      if (response.code !== '0') throw new AccountError('account-api-rejected');
      if (!Array.isArray(response.data)) return invalid();
      raw = response.data;
    }
    const receivedAt = this.#transport.now();
    if (receivedAt < requestedAt || receivedAt > 8_640_000_000_000_000) throw new AccountError('account-invalid-clock');
    const data = kind === 'order' ? projectRecoveryOrder(this.#venue, raw) : projectRecoveryFills(this.#venue, raw);
    const selectedOrder = query.orderId ?? query.ordId, selectedClient = query.origClientOrderId ?? query.clOrdId;
    for (const row of Array.isArray(data) ? data : [data]) {
      if (selectedOrder !== undefined && ('orderId' in row ? row.orderId : row.ordId) !== selectedOrder) return invalid();
      if (selectedClient !== undefined && ('clientOrderId' in row ? row.clientOrderId : 'clOrdId' in row ? row.clOrdId : undefined) !== selectedClient) return invalid();
    }
    return freeze({ kind, venue: this.#venue, requestedAt, receivedAt, query: { ...query }, data }) as RecoveryOrderRead | RecoveryFillsRead;
  }
  getOrder(input: RecoveryOrderSelector): Promise<RecoveryOrderRead> {
    const selected = selector(input);
    return (this.#venue === 'mexc'
      ? this.#get('order', '/api/v3/order', { symbol: 'BTCUSDT', ...(selected.exchangeOrderId === undefined
        ? { origClientOrderId: selected.clientOrderId } : { orderId: selected.exchangeOrderId }) })
      : this.#get('order', '/api/v5/trade/order', { instId: 'BTC-USDT', ...(selected.exchangeOrderId === undefined
        ? { clOrdId: selected.clientOrderId } : { ordId: selected.exchangeOrderId }) })) as Promise<RecoveryOrderRead>;
  }
  getFills(exchangeOrderId: string, inputRange: RecoveryWindow): Promise<RecoveryFillsRead> {
    const selected = orderId(exchangeOrderId), range = window(inputRange);
    return (this.#venue === 'mexc'
      ? this.#get('fills', '/api/v3/myTrades', { symbol: 'BTCUSDT', orderId: selected, limit: '1000' })
      : this.#get('fills', '/api/v5/trade/fills-history', { instType: 'SPOT', instId: 'BTC-USDT', ordId: selected,
        begin: String(range.from), end: String(range.to), limit: '100' })) as Promise<RecoveryFillsRead>;
  }
  getOrderByClient(clientOrderId: string) { return this.getOrder({ clientOrderId }); }
  getOrderById(exchangeOrderId: string) { return this.getOrder({ exchangeOrderId }); }
  getFillsByOrder(exchangeOrderId: string, range: RecoveryWindow) { return this.getFills(exchangeOrderId, range); }
}
