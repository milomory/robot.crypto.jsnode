import { createHash } from 'node:crypto';
import { z } from 'zod';
import { dashboardOperationSchema, type DashboardOperation } from './dashboard-contract.js';
import { AccountError } from './types.js';

const decimal = z.string().regex(/^(?:0|[1-9]\d{0,29})(?:\.\d{1,30})?$/);
const signed = z.string().regex(/^-?(?:0|[1-9]\d{0,29})(?:\.\d{1,30})?$/);
const currency = z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,31}$/);
const identity = z.union([z.string().min(1).max(256), z.number().int().nonnegative().safe()]);
const millis = z.union([z.number(), z.string().regex(/^[1-9]\d{0,15}$/).transform(Number)])
  .pipe(z.number().int().positive().safe());
export type OperationFeed = { items: DashboardOperation[]; truncated: boolean };
function invalid(): never { throw new AccountError('account-invalid-response'); }
function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input); return parsed.success ? parsed.data : invalid();
}
function rows<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T>[] {
  return parse(z.array(schema).max(1000), input);
}
function id(venue: string, type: string, fields: unknown[]) {
  return `${venue}:${type}:${createHash('sha256').update(JSON.stringify(fields)).digest('hex').slice(0,32)}`;
}
function multiply(a: string, b: string) {
  const [ai, af = ''] = a.split('.'), [bi, bf = ''] = b.split('.');
  const scale = af.length + bf.length;
  const digits = (BigInt(ai + af) * BigInt(bi + bf)).toString().padStart(scale + 1, '0');
  return scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, '') : digits;
}
const zero = (value: string) => /^0(?:\.0+)?$/.test(value);
function inverseFee(value: string) { return zero(value.replace(/^-/, '')) ? '0' : value.startsWith('-') ? value.slice(1) : `-${value}`; }
function feed(items: DashboardOperation[], now: number, capped = true): OperationFeed {
  if (items.some(row => row.at > now)) return invalid();
  const validated = items.map(row => parse(dashboardOperationSchema, row));
  if (new Set(validated.map(row => row.id)).size !== validated.length) return invalid();
  return { items: validated, truncated: capped && items.length >= 100 };
}
const empty = { symbol: null, side: null, quoteAmount: null, fee: null, feeAsset: null, isOpen: false } as const;

export function mexcTrades(input: unknown, symbol: string, now: number): OperationFeed {
  const data = rows(z.object({ symbol: z.literal(symbol), id: identity, price: decimal, qty: decimal,
    quoteQty: decimal, commission: decimal, commissionAsset: currency, time: millis, isBuyer: z.boolean() }), input);
  return feed(data.map(row => ({ ...empty, id: id('mexc','trade',[symbol,row.id]), venue: 'mexc', type: 'trade',
    symbol: symbol.slice(0,-4) + '/USDT', asset: symbol.slice(0,-4), side: row.isBuyer ? 'buy' : 'sell',
    amount: row.qty, quoteAmount: row.quoteQty, fee: row.commission, feeAsset: row.commissionAsset,
    status: 'completed', at: row.time })), now);
}
export function mexcOrders(input: unknown, now: number): OperationFeed {
  const data = rows(z.object({ symbol: z.string().regex(/^[A-Z0-9]{3,64}$/), orderId: identity,
    origQty: decimal, executedQty: decimal, side: z.enum(['BUY','SELL']),
    status: z.enum(['NEW','PARTIALLY_FILLED']), time: millis }), input);
  // All spot orders are requested. An unrecognized quote makes this feed
  // unavailable; never invent a base currency or silently omit a current order.
  return feed(data.map(row => {
    const quote = ['USDT','USDC','BTC','ETH'].find(value => row.symbol.endsWith(value) && row.symbol.length > value.length);
    if (!quote) return invalid();
    const base = row.symbol.slice(0, -quote.length);
    return { ...empty, id: id('mexc','order',[row.symbol,row.orderId]), venue: 'mexc', type: 'order',
      symbol: `${base}/${quote}`, asset: base, side: row.side === 'BUY' ? 'buy' : 'sell',
      amount: row.origQty, status: row.status === 'PARTIALLY_FILLED' ? 'partial' : 'pending', at: row.time, isOpen: true };
  }), now, data.length >= 1000);
}
export function mexcTransfers(input: unknown, type: 'deposit'|'withdrawal', now: number): OperationFeed {
  const data = rows(z.object({ coin: currency, amount: decimal, status: z.number().int(),
    id: identity.optional(), txId: z.string().max(512).nullable().optional(), insertTime: millis.optional(),
    applyTime: millis.optional(), transactionFee: decimal.optional() }), input);
  return feed(data.map(row => {
    const at = type === 'deposit' ? row.insertTime : row.applyTime;
    if (at === undefined || (type === 'withdrawal' && row.id === undefined) ||
      (type === 'deposit' && !row.txId && row.id === undefined)) return invalid();
    let status: DashboardOperation['status'] = 'unknown';
    if (type === 'deposit') {
      if ([5,12].includes(row.status)) status = 'completed';
      else if ([7,8,10].includes(row.status)) status = 'failed';
      else if ([1,2,3,4,6,9,11].includes(row.status)) status = 'pending';
    } else {
      if (row.status === 7) status = 'completed';
      else if (row.status === 8) status = 'failed';
      else if (row.status === 9) status = 'cancelled';
      else if ([1,2,3,4,5,6,10].includes(row.status)) status = 'pending';
    }
    return { ...empty, id: id('mexc', type, [row.id ?? row.txId, row.coin, at, row.amount]),
      venue: 'mexc', type, asset: row.coin, amount: row.amount, status, at,
      fee: type === 'withdrawal' ? row.transactionFee ?? null : null,
      feeAsset: type === 'withdrawal' && row.transactionFee !== undefined ? row.coin : null,
      isOpen: status === 'pending' };
  }), now);
}
const instrument = z.string().regex(/^[A-Z0-9._]{1,32}-[A-Z0-9._]{1,32}$/);
export function okxTrades(input: unknown, now: number): OperationFeed {
  const data = rows(z.object({ instType: z.literal('SPOT'), instId: instrument, billId: identity,
    fillSz: decimal, fillPx: decimal, fee: signed, feeCcy: currency, fillTime: millis, side: z.enum(['buy','sell']) }), input);
  return feed(data.map(row => ({ ...empty, id: id('okx','trade',[row.billId]), venue: 'okx', type: 'trade',
    symbol: row.instId.replace('-', '/'), asset: row.instId.split('-')[0], side: row.side,
    amount: row.fillSz, quoteAmount: multiply(row.fillSz,row.fillPx), fee: inverseFee(row.fee), feeAsset: row.feeCcy,
    status: 'completed', at: row.fillTime })), now);
}
export function okxOrders(input: unknown, now: number): OperationFeed {
  const data = rows(z.object({ instType: z.literal('SPOT'), instId: instrument, ordId: identity,
    sz: decimal, side: z.enum(['buy','sell']), state: z.enum(['live','partially_filled']), cTime: millis,
    ordType: z.string().min(1).max(32), tgtCcy: z.string().max(32).optional() }), input);
  return feed(data.map(row => ({ ...empty, id: id('okx','order',[row.instId,row.ordId]), venue: 'okx', type: 'order',
    symbol: row.instId.replace('-', '/'), asset: row.instId.split('-')[row.ordType === 'market' &&
      (row.tgtCcy === 'quote_ccy' || (!row.tgtCcy && row.side === 'buy')) ? 1 : 0],
    side: row.side, amount: row.sz, status: row.state === 'partially_filled' ? 'partial' : 'pending',
    at: row.cTime, isOpen: true })), now);
}
export function okxTransfers(input: unknown, type: 'deposit'|'withdrawal', now: number): OperationFeed {
  const data = rows(z.object({ ccy: currency, amt: decimal, ts: millis, state: z.string().regex(/^-?\d{1,3}$/),
    depId: identity.optional(), wdId: identity.optional(), fee: decimal.optional(), feeCcy: currency.optional() }), input);
  return feed(data.map(row => {
    const upstreamId = type === 'deposit' ? row.depId : row.wdId;
    if (upstreamId === undefined) return invalid();
    let status: DashboardOperation['status'] = 'unknown';
    if (type === 'deposit') {
      if (row.state === '2') status = 'completed';
      else if (['0','1','8','11','12','13','14','17'].includes(row.state)) status = 'pending';
    } else {
      if (row.state === '2') status = 'completed';
      else if (row.state === '-1') status = 'failed';
      else if (row.state === '-2') status = 'cancelled';
      else if (['-3','0','1','3','4','5','6','7','8','9','10','11','12','15','16','17'].includes(row.state)) status = 'pending';
    }
    return { ...empty, id: id('okx',type,[upstreamId]), venue: 'okx', type, asset: row.ccy, amount: row.amt,
      status, at: row.ts, fee: type === 'withdrawal' ? row.fee ?? null : null,
      feeAsset: type === 'withdrawal' && row.fee !== undefined ? row.feeCcy ?? row.ccy : null, isOpen: status === 'pending' };
  }), now);
}
