/** Private archive projection only. Raw identities here must never enter dashboard/log output. */
import { z } from 'zod';
import { AccountError } from './types.js';

const decimal = z.string().regex(/^(?:0|[1-9]\d{0,29})(?:\.\d{1,30})?$/);
const signed = z.string().regex(/^-?(?:0|[1-9]\d{0,29})(?:\.\d{1,30})?$/);
const token = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const currency = z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,31}$/);
const identity = z.union([z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  z.number().int().nonnegative().safe()]).transform(String);
const millis = z.union([z.number().int().nonnegative().safe(), z.string().regex(/^(?:0|[1-9]\d{0,15})$/)
  .refine(value => Number.isSafeInteger(Number(value)))]);
const empty = z.literal('');
const maybeDecimal = z.union([decimal, empty]).optional();
const maybeSigned = z.union([signed, empty]).optional();
const maybeToken = z.union([token, empty]).optional();
const maybeCurrency = z.union([currency, empty]).optional();
const maybeTime = z.union([millis, empty]).optional();
const maybeIdentity = z.union([identity, empty]).optional();

// Missing evidence stays missing. The audit, rather than this private projection,
// decides whether it is sufficient and whether an execution category is supported.
const mexcOrder = z.object({
  symbol: z.literal('BTCUSDT'), orderId: identity,
  side: token.optional(), type: token.optional(), status: token.optional(),
  Qty: decimal.optional(), origQty: decimal.optional(), executedQty: decimal.optional(),
  cumulativeQuoteQty: decimal.optional(), cummulativeQuoteQty: decimal.optional(),
  origQuoteOrderQty: decimal.optional(), time: millis.optional(), updateTime: millis.optional(),
});
const mexcFill = z.object({
  symbol: z.literal('BTCUSDT'), id: identity, orderId: identity,
  price: decimal.optional(), qty: decimal.optional(), quoteQty: decimal.optional(),
  commission: decimal.optional(), commissionAsset: currency.optional(), time: millis.optional(),
  isBuyer: z.boolean().optional(), isMaker: z.boolean().optional(), isSelfTrade: z.boolean().optional(),
});
const okxOrder = z.object({
  instType: token, instId: z.literal('BTC-USDT'), ordId: identity,
  tdMode: maybeToken, category: maybeToken, side: maybeToken, ordType: maybeToken, state: maybeToken,
  sz: maybeDecimal, tgtCcy: maybeToken, tradeQuoteCcy: maybeCurrency,
  accFillSz: maybeDecimal, avgPx: maybeDecimal, fee: maybeSigned, feeCcy: maybeCurrency,
  rebate: maybeSigned, rebateCcy: maybeCurrency, cTime: maybeTime, uTime: maybeTime,
});
const okxFill = z.object({
  instType: token, instId: z.literal('BTC-USDT'), ordId: identity, tradeId: identity, billId: identity,
  side: maybeToken, subType: maybeToken, execType: maybeToken,
  fillSz: maybeDecimal, fillPx: maybeDecimal, fee: maybeSigned, feeCcy: maybeCurrency, tradeQuoteCcy: maybeCurrency,
  // Historical reported rate, never replaced by today's account tariff or used to reconstruct the fee.
  feeRate: maybeSigned,
  fillTime: maybeTime, ts: maybeTime,
});
const okxBill = z.object({
  instType: token, instId: z.literal('BTC-USDT'), billId: identity,
  ordId: maybeIdentity, tradeId: maybeIdentity, type: maybeToken, subType: maybeToken,
  mgnMode: maybeToken, ccy: maybeCurrency, sz: maybeSigned, balChg: maybeSigned,
  bal: maybeSigned, fee: maybeSigned, ts: maybeTime, fillTime: maybeTime, execType: maybeToken,
});

export type ExecutionVenue = 'mexc' | 'okx';
export type ProjectedExecutionOrder = z.infer<typeof mexcOrder> | z.infer<typeof okxOrder>;
export type ProjectedExecutionRow = z.infer<typeof mexcFill> | z.infer<typeof okxFill> | z.infer<typeof okxBill>;
function invalid(): never { throw new AccountError('account-invalid-response'); }
function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  return result.success ? result.data : invalid();
}

/** OKX callers already checked code and extracted data; a one-row data array is accepted. */
export function projectExecutionOrder(venue: ExecutionVenue, input: unknown): ProjectedExecutionOrder {
  if (venue === 'mexc') return parse(mexcOrder, input);
  if (venue !== 'okx') return invalid();
  return parse(okxOrder, Array.isArray(input) ? parse(z.array(z.unknown()).length(1), input)[0] : input);
}

/** One bounded page; keep duplicates for the downstream audit to detect conflicts. */
export function projectExecutionRows(venue: ExecutionVenue, kind: 'fills' | 'bills', input: unknown): ProjectedExecutionRow[] {
  if (venue === 'mexc' && kind === 'fills') return parse(z.array(mexcFill).max(1000), input);
  if (venue === 'okx' && kind === 'fills') return parse(z.array(okxFill).max(100), input);
  if (venue === 'okx' && kind === 'bills') return parse(z.array(okxBill).max(100), input);
  return invalid();
}
