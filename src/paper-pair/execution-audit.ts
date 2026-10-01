/** Offline decoding of one order's recorded API responses. No network or order submission. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonical } from '../paper-v2/ledger.js';
import { applySettlementEvent, type SettlementFill, type SettlementFunds, type SettlementState } from './settlement.js';

const dec = z.string().regex(/^(0|[1-9][0-9]{0,19})(?:\.[0-9]{1,30})?$/);
const signed = z.string().regex(/^-?(0|[1-9][0-9]{0,19})(?:\.[0-9]{1,30})?$/);
const identity = z.union([z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), z.number().int().nonnegative().safe()]).transform(String);
const time = z.union([z.number(), z.string().regex(/^[1-9][0-9]{0,15}$/).transform(Number)]).pipe(z.number().int().positive().safe());
const asset = z.enum(['BTC', 'USDT', 'MX']);
const envelope = z.object({ schema: z.literal(1), kind: z.literal('recorded-order-audit'),
  source: z.enum(['synthetic', 'recorded']), account: z.literal('main'), venue: z.enum(['mexc', 'okx']),
  observedAt: time, expected: z.object({ orderId: identity, side: z.enum(['buy', 'sell']) }).strict(),
  limit: z.number().int().min(1).max(1000), orderBefore: z.unknown(), orderAfter: z.unknown(), fills: z.unknown() }).strict();
const mexcOrder = z.object({ symbol: z.literal('BTCUSDT'), orderId: identity, side: z.enum(['BUY', 'SELL']),
  type: z.enum(['LIMIT', 'MARKET']), status: z.enum(['NEW', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'PARTIALLY_CANCELED']),
  Qty: dec.optional(), origQty: dec.optional(), executedQty: dec, cumulativeQuoteQty: dec.optional(),
  cummulativeQuoteQty: dec.optional(), origQuoteOrderQty: dec, time, updateTime: time });
const mexcFill = z.object({ symbol: z.literal('BTCUSDT'), orderId: identity, id: identity, price: dec, qty: dec,
  quoteQty: dec, commission: dec, commissionAsset: asset, time, isBuyer: z.boolean(), isSelfTrade: z.boolean().optional() });
const okxOrder = z.object({ instType: z.literal('SPOT'), instId: z.literal('BTC-USDT'), tdMode: z.literal('cash'),
  category: z.literal('normal'), ordId: identity, side: z.enum(['buy', 'sell']), ordType: z.enum(['limit', 'market']),
  state: z.enum(['live', 'partially_filled', 'filled', 'canceled']), sz: dec,
  tgtCcy: z.enum(['base_ccy', 'quote_ccy', '']), tradeQuoteCcy: z.literal('USDT').optional(), accFillSz: dec,
  avgPx: z.union([dec, z.literal('')]), fee: signed, feeCcy: asset, rebate: z.union([dec, z.literal('')]), rebateCcy: z.string().max(32),
  cTime: time, uTime: time });
const okxFill = z.object({ instType: z.literal('SPOT'), instId: z.literal('BTC-USDT'), ordId: identity,
  tradeId: identity, billId: identity, side: z.enum(['buy', 'sell']), subType: z.enum(['1', '2']),
  execType: z.literal('T'), fillSz: dec, fillPx: dec, fee: signed, feeCcy: asset,
  tradeQuoteCcy: z.literal('USDT').optional(), fillTime: time, ts: time });
const ASSETS = ['BTC', 'USDT', 'MX'] as const;
const SCALE = 10n ** 18n;
type Money = Record<typeof ASSETS[number], bigint>;
export class ExecutionAuditError extends Error {
  constructor(readonly reason: string) { super(reason); this.name = 'ExecutionAuditError'; }
}
function fail(reason: string): never { throw new ExecutionAuditError(reason); }
function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const p = schema.safeParse(input); if (!p.success) fail('invalid-execution-record'); return p.data;
}
function number(value: string): bigint {
  const [a, b = ''] = value.split('.');
  if (b.length > 18) fail('unsupported-decimal-precision');
  return BigInt(a) * SCALE + BigInt(b.padEnd(18, '0'));
}
function text(value: bigint, places = 18): string {
  const scale = 10n ** BigInt(places), fraction = (value % scale).toString().padStart(places, '0').replace(/0+$/, '');
  return `${value / scale}${fraction ? '.' + fraction : ''}`;
}
function zero(): Money { return { BTC: 0n, USDT: 0n, MX: 0n }; }
function display(m: Money): SettlementFunds { return { BTC: text(m.BTC), USDT: text(m.USDT), MX: text(m.MX) }; }
function fees(currency: typeof ASSETS[number], value: string): SettlementFunds {
  const result = zero(); result[currency] = number(value); return display(result);
}
function okxFee(value: string, currency: typeof ASSETS[number], side: 'buy' | 'sell'): string {
  const positive = value.startsWith('-') ? value.slice(1) : value;
  const n = number(positive);
  if (!value.startsWith('-') && n !== 0n) fail('unsupported-fee-rebate');
  // Ordinary cash taker buys pay in received BTC or spent USDT; sells pay
  // in received USDT. Zero fees do not prove a fee currency and keep no cost.
  if (n !== 0n && currency !== 'USDT' && !(side === 'buy' && currency === 'BTC')) fail('unsupported-okx-fee-currency');
  return text(n);
}
function alias(a: string | undefined, b: string | undefined): bigint {
  if (a === undefined && b === undefined) fail('missing-order-total');
  if (a !== undefined && b !== undefined && number(a) !== number(b)) fail('conflicting-field-aliases');
  return number(a ?? b!);
}
export function executionOrderKey(venue: 'mexc' | 'okx', orderId: string): string {
  const id = parse(identity, orderId);
  return `${venue}_${createHash('sha256').update(canonical(['main', 'BTC/USDT', id])).digest('hex')}`;
}
function fillKey(venue: string, orderId: string, fillId: string): string {
  return createHash('sha256').update(canonical([venue, 'main', 'BTC/USDT', orderId, fillId])).digest('hex');
}
interface Order {
  id: string; side: 'buy' | 'sell'; status: string; outcome: 'filled' | 'cancelled' | 'open';
  createdAt: number; updatedAt: number; base: bigint; quote: bigint | null; fees: Money | null;
  fingerprint: string;
}
export type ExecutionAudit = ReturnType<typeof auditRecordedOrder>;

/** Amounts remain exact; OKX price*size is labelled derived and cannot authorize settlement. */
export function auditRecordedOrder(input: unknown) {
  const e = parse(envelope, input);
  if (e.venue === 'okx' && e.limit > 100) fail('invalid-response-limit');
  const decodeOrder = (raw: unknown): Order => {
    if (e.venue === 'mexc') {
      const r = parse(mexcOrder, raw), base = number(r.executedQty), quote = alias(r.cumulativeQuoteQty, r.cummulativeQuoteQty);
      const original = alias(r.Qty, r.origQty), budget = number(r.origQuoteOrderQty);
      const side = r.side === 'BUY' ? 'buy' : 'sell';
      // Query-order Qty is a base target for LIMIT and MARKET SELL. MARKET BUY
      // budget semantics remain separate; do not derive its base target.
      if ((r.type === 'LIMIT' || side === 'sell') &&
          (original === 0n || base > original || (r.status === 'FILLED' && base !== original))) fail('order-size-mismatch');
      const outcome = r.status === 'FILLED' ? 'filled' : ['CANCELED', 'PARTIALLY_CANCELED'].includes(r.status) ? 'cancelled' : 'open';
      if ((r.status === 'NEW' && base !== 0n) || (['PARTIALLY_FILLED', 'FILLED', 'PARTIALLY_CANCELED'].includes(r.status) && base === 0n)) fail('inconsistent-order-status');
      return { id: r.orderId, side, status: r.status, outcome, createdAt: r.time, updatedAt: r.updateTime, base, quote, fees: null,
        fingerprint: canonical([r.orderId, side, r.type, r.status, text(original), text(budget), text(base), text(quote), r.time, r.updateTime]) };
    }
    const rows = parse(z.object({ code: z.literal('0'), data: z.array(okxOrder).length(1) }), raw).data;
    const r = rows[0], base = number(r.accFillSz), fee = okxFee(r.fee, r.feeCcy, r.side);
    if (r.rebate !== '' && number(r.rebate) !== 0n) fail('unsupported-fee-rebate');
    if ((r.state === 'live' && base !== 0n) || (['partially_filled', 'filled'].includes(r.state) && base === 0n)) fail('inconsistent-order-status');
    if (base > 0n && (r.avgPx === '' || number(r.avgPx) === 0n)) fail('missing-order-average-price');
    const feeTotals = zero(); feeTotals[r.feeCcy] = number(fee);
    return { id: r.ordId, side: r.side, status: r.state, outcome: r.state === 'filled' ? 'filled' : r.state === 'canceled' ? 'cancelled' : 'open',
      createdAt: r.cTime, updatedAt: r.uTime, base, quote: base === 0n ? 0n : null, fees: feeTotals,
      fingerprint: canonical([r.ordId, r.side, r.ordType, text(number(r.sz)), r.tgtCcy, r.tradeQuoteCcy ?? null, r.state, text(base), r.avgPx === '' ? '' : text(number(r.avgPx)), fee, r.feeCcy, r.cTime, r.uTime]) };
  };
  const before = decodeOrder(e.orderBefore), after = decodeOrder(e.orderAfter);
  for (const order of [before, after]) {
    if (order.id !== e.expected.orderId || order.side !== e.expected.side) fail('order-binding-mismatch');
    if (order.createdAt > order.updatedAt || order.updatedAt > e.observedAt) fail('invalid-order-time');
  }
  const rows = e.venue === 'mexc' ? parse(z.array(mexcFill).max(1000), e.fills)
    : parse(z.object({ code: z.literal('0'), data: z.array(okxFill).max(100) }), e.fills).data;
  if (rows.length > e.limit) fail('response-exceeds-limit');
  const unique = new Map<string, { fill: SettlementFill; quote36: bigint; fingerprint: string }>();
  const bills = new Map<string, string>();
  let duplicates = 0;
  for (const row of rows) {
    let id: string, orderId: string, side: 'buy' | 'sell', at: number, base: bigint, quote36: bigint, fee: SettlementFunds;
    let bill: string | undefined, detail: unknown;
    if ('qty' in row) {
      id = row.id; orderId = row.orderId; side = row.isBuyer ? 'buy' : 'sell'; at = row.time;
      if (row.isSelfTrade === true) fail('unsupported-self-trade');
      base = number(row.qty); quote36 = number(row.quoteQty) * SCALE;
      if (number(row.price) === 0n) fail('non-positive-fill');
      fee = fees(row.commissionAsset, row.commission);
      detail = [text(number(row.price)), row.isSelfTrade ?? null];
    } else {
      id = row.tradeId; bill = row.billId; orderId = row.ordId; side = row.side; at = row.fillTime;
      if (row.subType !== (side === 'buy' ? '1' : '2')) fail('fill-side-subtype-mismatch');
      if (at > row.ts || row.ts > e.observedAt) fail('invalid-fill-time');
      base = number(row.fillSz); quote36 = base * number(row.fillPx); fee = fees(row.feeCcy, okxFee(row.fee, row.feeCcy, row.side));
      detail = [text(number(row.fillPx)), row.ts, row.billId, row.tradeQuoteCcy ?? null];
    }
    if (orderId !== e.expected.orderId || side !== e.expected.side) fail('fill-binding-mismatch');
    if (at < after.createdAt || at > after.updatedAt || at > e.observedAt) fail('invalid-fill-time');
    if (base === 0n || quote36 === 0n) fail('non-positive-fill');
    const fill = { fillId: fillKey(e.venue, orderId, id), executedAt: at, baseQuantity: text(base), quoteQuantity: text(quote36, 36), fees: fee };
    const previous = unique.get(id), fingerprint = canonical([fill, detail]);
    if (previous && previous.fingerprint !== fingerprint) fail('fill-id-conflict');
    // One execution must not gain a second fee-bearing bill in this narrow contract.
    if (bill !== undefined) {
      const previousTrade = bills.get(bill);
      if (previousTrade !== undefined && previousTrade !== id) fail('bill-id-conflict');
      if (previous && ![...bills].some(([b, t]) => b === bill && t === id)) fail('trade-bill-conflict');
      bills.set(bill, id);
    }
    if (previous) duplicates++;
    else unique.set(id, { fill, quote36, fingerprint });
  }
  const fills = [...unique.values()].map(r => r.fill).sort((a, b) => a.executedAt - b.executedAt || a.fillId.localeCompare(b.fillId));
  let base = 0n, quote36 = 0n; const feeTotals = zero();
  for (const r of unique.values()) {
    base += number(r.fill.baseQuantity); quote36 += r.quote36;
    for (const a of ASSETS) feeTotals[a] += number(r.fill.fees[a]);
  }
  const checks = { stableOrder: before.fingerprint === after.fingerprint, terminal: after.outcome !== 'open',
    uncappedResponse: rows.length < e.limit, baseTotalMatches: base === after.base,
    quoteTotalMatches: after.quote === null ? null : quote36 === after.quote * SCALE,
    feeTotalMatches: after.fees === null ? null : ASSETS.every(a => feeTotals[a] === after.fees![a]) };
  const blockers: string[] = [];
  if (!checks.stableOrder) blockers.push('order-changed-during-observation');
  if (!checks.terminal) blockers.push('order-not-terminal');
  if (!checks.uncappedResponse) blockers.push('response-at-limit');
  if (!checks.baseTotalMatches) blockers.push('base-total-mismatch');
  if (checks.quoteTotalMatches === false) blockers.push('quote-total-mismatch');
  if (checks.feeTotalMatches === false) blockers.push('fee-total-mismatch');
  if (e.venue === 'okx' && after.base !== 0n) blockers.push('quote-amount-not-reported');
  const totals = { baseQuantity: text(base), quoteQuantity: text(quote36, 36), fees: display(feeTotals) };
  return { schema: 1, kind: 'recorded-order-audit-result', source: e.source, account: e.account, venue: e.venue,
    symbol: 'BTC/USDT', side: e.expected.side, orderKey: executionOrderKey(e.venue, e.expected.orderId), observedAt: e.observedAt,
    orderStatus: after.status, outcome: after.outcome, executable: false, wholeAccountHistoryProven: false,
    quoteSource: e.venue === 'mexc' ? 'reported-fill-quote' : after.base === 0n ? 'zero-execution' : 'derived-price-times-size',
    uniqueFills: fills.length, duplicateRows: duplicates, checks, blockers, settlementReady: blockers.length === 0,
    totals, fills };
}

/** Explicitly selected paper leg only. A history record never creates or submits an order. */
export function reconcileRecordedOrder(state: SettlementState, pairId: string, eventId: string, input: unknown) {
  const audit = auditRecordedOrder(input);
  if (!audit.settlementReady || audit.outcome === 'open') fail('execution-audit-blocked');
  const position = state.positions.find(p => p.pairId === pairId);
  if (!position || position[audit.side].venue !== audit.venue || position[audit.side].orderId !== audit.orderKey) fail('paper-leg-binding-mismatch');
  if (audit.fills.length > 200) fail('reconciliation-fill-limit');
  return { audit, state: applySettlementEvent(state, { type: 'reconcile', id: eventId, at: audit.observedAt,
    pairId, side: audit.side, outcome: audit.outcome, fills: audit.fills, totals: audit.totals }) };
}
