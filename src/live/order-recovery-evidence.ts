/** Pure, bounded response binding for a local rehearsal. This grants no network or execution authority. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { applyLiveOrderEvent, canonicalLiveOrderJson as canonical, LiveOrderLifecycleError, planLiveOrderRecovery,
  type LiveOrderEvent, type LiveOrderFill, type LiveOrderFunds, type LiveOrderObservation,
  type LiveOrderRecord, type LiveOrderState } from './order-lifecycle.js';

export const LIVE_RECOVERY_EVIDENCE_LIMITS = Object.freeze({ captureBytes: 128 * 1024,
  maxCaptureDurationMs: 30_000, maxCaptureAgeMs: 60_000, maxClockSkewMs: 2_000, maxOrderCreationDelayMs: 30_000,
  mexcRetentionMs: 7 * 86_400_000 });
export interface LiveRecoveryEvidencePolicy { now: number; maxCaptureDurationMs: number; maxCaptureAgeMs: number; maxClockSkewMs: number }
export interface LiveOrderRecoveryEvidencePlan {
  schema: 1; kind: 'live-order-recovery-evidence'; source: 'local-rehearsal'; nonExecutable: true;
  captureProvenanceVerified: false; accountIdentityVerified: false; captureDigest: string | null;
  terminalReconciliationEligible: boolean; events: readonly LiveOrderEvent[]; blockers: readonly string[];
}
const millis = z.number().int().safe().positive().max(8_640_000_000_000_000);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const clientId = z.string().regex(/^[A-Za-z0-9]{32}$/);
const venue = z.enum(['mexc', 'okx']);
const decimal = z.string().regex(/^(0|[1-9][0-9]{0,19})(?:\.[0-9]{1,18})?$/).transform(normalize);
const signed = z.string().regex(/^-?(0|[1-9][0-9]{0,19})(?:\.[0-9]{1,18})?$/).transform(normalizeSigned);
const asset = z.enum(['BTC', 'USDT', 'MX']);
const orderRead = z.object({ kind: z.literal('order'), venue, requestedAt: millis, receivedAt: millis,
  query: z.record(z.string().max(128), z.string().max(128)), data: z.unknown() }).strict();
const fillRead = orderRead.extend({ kind: z.literal('fills') });
const captureSchema = z.object({ schema: z.literal(1), kind: z.literal('live-order-recovery-capture'), venue,
  account: z.literal('main'), clientOrderId: clientId, requestedAt: millis, receivedAt: millis,
  orderBefore: orderRead, fills: fillRead, orderAfter: orderRead }).strict();
const policySchema = z.object({ now: millis,
  maxCaptureDurationMs: z.number().int().min(1).max(LIVE_RECOVERY_EVIDENCE_LIMITS.maxCaptureDurationMs),
  maxCaptureAgeMs: z.number().int().min(0).max(LIVE_RECOVERY_EVIDENCE_LIMITS.maxCaptureAgeMs),
  maxClockSkewMs: z.number().int().min(0).max(LIVE_RECOVERY_EVIDENCE_LIMITS.maxClockSkewMs) }).strict();
const mexcOrderSchema = z.object({ symbol: z.literal('BTCUSDT'), orderId: id, clientOrderId: clientId, origClientOrderId: clientId.optional(),
  side: z.enum(['BUY', 'SELL']), type: z.literal('LIMIT'), price: decimal, Qty: decimal.optional(), origQty: decimal.optional(),
  executedQty: decimal, cumulativeQuoteQty: decimal.optional(), cummulativeQuoteQty: decimal.optional(),
  status: z.enum(['NEW', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'PARTIALLY_CANCELED', 'REJECTED']),
  time: millis, updateTime: millis, timeInForce: z.string().max(16).optional(), origQuoteOrderQty: decimal.optional() });
const okxOrderSchema = z.object({ instType: z.literal('SPOT'), instId: z.literal('BTC-USDT'), ordId: id, clOrdId: clientId,
  tdMode: z.literal('cash'), category: z.literal('normal'), side: z.enum(['buy', 'sell']), ordType: z.literal('limit'),
  state: z.enum(['live', 'partially_filled', 'filled', 'canceled']), sz: decimal, px: decimal,
  accFillSz: decimal, avgPx: z.union([decimal, z.literal('')]), cTime: millis, uTime: millis,
  tgtCcy: z.enum(['base_ccy', '']).optional(), tradeQuoteCcy: z.literal('USDT').optional(),
  fee: signed, feeCcy: asset, rebate: z.union([decimal, z.literal('')]), rebateCcy: z.string().max(32) });
const mexcFillSchema = z.object({ symbol: z.literal('BTCUSDT'), orderId: id, id, clientOrderId: clientId.nullable().optional(),
  price: decimal, qty: decimal, quoteQty: decimal, commission: decimal, commissionAsset: asset, time: millis,
  isBuyer: z.boolean(), isSelfTrade: z.boolean().optional() });
const okxFillSchema = z.object({ instType: z.literal('SPOT'), instId: z.literal('BTC-USDT'), ordId: id,
  clOrdId: z.union([clientId, z.literal('')]).optional(), tradeId: id, billId: id, side: z.enum(['buy', 'sell']), subType: z.enum(['1', '2']),
  execType: z.enum(['T', 'M']), fillSz: decimal, fillPx: decimal, fee: signed, feeCcy: asset,
  fillTime: millis, ts: millis, tradeQuoteCcy: z.literal('USDT').optional() });
const SCALE = 10n ** 18n;
const ASSETS = ['BTC', 'USDT', 'MX'] as const;
class BindingError extends Error { constructor(readonly code: string) { super(code); } }
function fail(code: string): never { throw new BindingError(code); }
function parse<T extends z.ZodTypeAny>(schema: T, input: unknown, code = 'invalid-recovery-capture'): z.infer<T> {
  const parsed = schema.safeParse(input); if (!parsed.success) fail(code); return parsed.data;
}
function normalize(value: string): string { const [whole, fraction] = value.split('.'); const tail = fraction?.replace(/0+$/, ''); return tail ? whole + '.' + tail : whole; }
function normalizeSigned(value: string): string { const n = normalize(value.replace(/^-/, '')); return value.startsWith('-') && n !== '0' ? '-' + n : n; }
function units(value: string): bigint { const [a, b = ''] = value.split('.'); return BigInt(a) * SCALE + BigInt(b.padEnd(18, '0')); }
function amount(value: bigint): string { const tail = (value % SCALE).toString().padStart(18, '0').replace(/0+$/, ''); return `${value / SCALE}${tail ? '.' + tail : ''}`; }
function product(a: string, b: string): string {
  const n = units(a) * units(b); if (n % SCALE !== 0n) fail('unsupported-derived-precision'); return amount(n / SCALE);
}
function alias(a: string | undefined, b: string | undefined): string {
  if (a === undefined && b === undefined) fail('missing-order-amount');
  if (a !== undefined && b !== undefined && a !== b) fail('conflicting-order-aliases'); return a ?? b!;
}
function hash(input: unknown): string { return createHash('sha256').update(canonical(input)).digest('hex'); }
function eventId(input: unknown): string { const h = hash(input); return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; }
function freeze<T>(value: T): T { if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function empty(): LiveOrderRecoveryEvidencePlan { return { schema: 1, kind: 'live-order-recovery-evidence', source: 'local-rehearsal', nonExecutable: true,
  captureProvenanceVerified: false, accountIdentityVerified: false, captureDigest: null, terminalReconciliationEligible: false, events: [], blockers: [] }; }
export function parseLiveRecoveryEvidencePolicy(input: unknown): LiveRecoveryEvidencePolicy {
  const parsed = policySchema.safeParse(input); if (!parsed.success) throw new Error('invalid-recovery-policy'); return freeze(parsed.data);
}
interface BoundOrder { exchangeOrderId: string; clientOrderId: string; side: 'buy' | 'sell'; baseQuantity: string; limitPrice: string;
  createdAt: number; updatedAt: number; status: LiveOrderObservation['status']; cumulativeBaseQuantity: string;
  cumulativeQuoteQuantity: string; quoteAmountSource: 'reported' | 'derived'; fingerprint: string; raw: unknown }
function decodeOrder(selectedVenue: 'mexc' | 'okx', input: unknown): BoundOrder {
  if (selectedVenue === 'mexc') {
    const r = parse(mexcOrderSchema, input), baseQuantity = alias(r.Qty, r.origQty), quote = alias(r.cumulativeQuoteQty, r.cummulativeQuoteQty);
    const status: LiveOrderObservation['status'] = ({ NEW: 'new', PARTIALLY_FILLED: 'partially-filled', FILLED: 'filled',
      CANCELED: 'canceled', PARTIALLY_CANCELED: 'canceled', REJECTED: 'rejected' } as const)[r.status];
    if (r.origClientOrderId !== undefined && r.origClientOrderId !== r.clientOrderId) fail('order-binding-mismatch');
    if (r.status === 'PARTIALLY_CANCELED' && units(r.executedQty) === 0n) fail('order-status-inconsistent');
    if (r.timeInForce !== undefined && r.timeInForce !== 'GTC') fail('unsupported-time-in-force');
    const raw = { ...r, Qty: baseQuantity, origQty: undefined, cumulativeQuoteQty: quote, cummulativeQuoteQty: undefined };
    const stable = { ...raw }; delete stable.origQty; delete stable.cummulativeQuoteQty;
    return { exchangeOrderId: r.orderId, clientOrderId: r.clientOrderId, side: r.side === 'BUY' ? 'buy' : 'sell', baseQuantity,
      limitPrice: r.price, createdAt: r.time, updatedAt: r.updateTime, status, cumulativeBaseQuantity: r.executedQty,
      cumulativeQuoteQuantity: quote, quoteAmountSource: 'reported', fingerprint: canonical(stable), raw: stable };
  }
  const r = parse(okxOrderSchema, input), nonzero = units(r.accFillSz) !== 0n;
  if (nonzero && (r.avgPx === '' || units(r.avgPx) === 0n)) fail('missing-order-average-price');
  if ((r.rebate !== '' && units(r.rebate) !== 0n) || (!r.fee.startsWith('-') && units(r.fee) !== 0n)) fail('unsupported-fee-rebate');
  if (r.feeCcy === 'MX') fail('unsupported-okx-fee-currency');
  if (!nonzero && r.fee !== '0') fail('zero-execution-has-cost');
  return { exchangeOrderId: r.ordId, clientOrderId: r.clOrdId, side: r.side, baseQuantity: r.sz, limitPrice: r.px,
    createdAt: r.cTime, updatedAt: r.uTime, status: ({ live: 'new', partially_filled: 'partially-filled', filled: 'filled', canceled: 'canceled' } as const)[r.state],
    cumulativeBaseQuantity: r.accFillSz, cumulativeQuoteQuantity: nonzero ? product(r.accFillSz, r.avgPx) : '0',
    quoteAmountSource: nonzero ? 'derived' : 'reported', fingerprint: canonical(r), raw: r };
}
function bindOrder(order: LiveOrderRecord, observed: BoundOrder, readReceivedAt: number, policy: LiveRecoveryEvidencePolicy) {
  if (observed.clientOrderId !== order.clientOrderId || observed.side !== order.intent.side ||
      observed.baseQuantity !== order.intent.baseQuantity || observed.limitPrice !== order.intent.limitPrice ||
      (order.exchangeOrderId !== null && observed.exchangeOrderId !== order.exchangeOrderId)) fail('order-binding-mismatch');
  const dispatch = Date.parse(order.dispatchAt!);
  if (observed.createdAt < dispatch - policy.maxClockSkewMs ||
      observed.createdAt > dispatch + LIVE_RECOVERY_EVIDENCE_LIMITS.maxOrderCreationDelayMs + policy.maxClockSkewMs ||
      observed.updatedAt < observed.createdAt || observed.updatedAt > readReceivedAt + policy.maxClockSkewMs) fail('order-time-binding-mismatch');
  const base = units(observed.cumulativeBaseQuantity), quote = units(observed.cumulativeQuoteQuantity), maximum = units(observed.baseQuantity);
  if ((base === 0n) !== (quote === 0n) || (['new', 'rejected'].includes(observed.status) && base !== 0n) ||
      (observed.status === 'partially-filled' && (base === 0n || base >= maximum)) ||
      (observed.status === 'filled' && base !== maximum)) fail('order-status-inconsistent');
}
function assertOrderQuery(read: z.infer<typeof orderRead>, order: LiveOrderRecord, observed: BoundOrder) {
  const q = read.query, isMexc = order.intent.venue === 'mexc';
  const symbolKey = isMexc ? 'symbol' : 'instId', clientKey = isMexc ? 'origClientOrderId' : 'clOrdId', orderKey = isMexc ? 'orderId' : 'ordId';
  if (Object.keys(q).length !== 2 || q[symbolKey] !== (isMexc ? 'BTCUSDT' : 'BTC-USDT') ||
      (q[clientKey] !== order.clientOrderId && q[orderKey] !== observed.exchangeOrderId)) fail('order-query-binding-mismatch');
  if (order.exchangeOrderId !== null && q[orderKey] !== order.exchangeOrderId) fail('known-order-id-query-required');
}
function fillWindow(read: z.infer<typeof fillRead>, selectedVenue: 'mexc' | 'okx', observed: BoundOrder, dispatch: number, skew: number): number {
  const q = read.query, isMexc = selectedVenue === 'mexc';
  if (isMexc) {
    if (canonical(Object.keys(q).sort()) !== canonical(['limit', 'orderId', 'symbol']) || q.symbol !== 'BTCUSDT' ||
        q.orderId !== observed.exchangeOrderId || q.limit !== '1000') fail('fills-query-binding-mismatch');
    return 1000;
  }
  if (canonical(Object.keys(q).sort()) !== canonical(['begin', 'end', 'instId', 'instType', 'limit', 'ordId']) ||
      q.instType !== 'SPOT' || q.instId !== 'BTC-USDT' || q.ordId !== observed.exchangeOrderId || q.limit !== '100' ||
      !/^[1-9][0-9]{0,15}$/.test(q.begin) || !/^[1-9][0-9]{0,15}$/.test(q.end)) fail('fills-query-binding-mismatch');
  const from = Number(q.begin), to = Number(q.end);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from > dispatch - skew || to < observed.updatedAt ||
      from <= 0 || to < from || to > read.receivedAt + skew || to - from > 7 * 86_400_000) fail('fills-window-incomplete');
  return 100;
}
interface FillResult { normalized: unknown[]; fills: LiveOrderFill[]; base: bigint; quote: bigint; duplicates: number; quoteReported: boolean; rawCount: number }
function decodeFills(input: unknown, order: LiveOrderRecord, observed: BoundOrder, receivedAt: number, limit: number, policy: LiveRecoveryEvidencePolicy): FillResult {
  const rows = parse(z.array(z.unknown()).max(limit), input), unique = new Map<string, { raw: unknown; fill: LiveOrderFill | null; base: bigint; quote: bigint }>();
  const bills = new Map<string, string>(); let duplicates = 0;
  for (const inputRow of rows) {
    let raw: unknown, fillId: string, exchangeOrderId: string, client: string | undefined | null, side: string,
      at: number, base: string, quote: string, fees: LiveOrderFunds = { BTC: '0', USDT: '0', MX: '0' };
    if (order.intent.venue === 'mexc') {
      const r = parse(mexcFillSchema, inputRow); raw = r; fillId = r.id; exchangeOrderId = r.orderId; client = r.clientOrderId;
      side = r.isBuyer ? 'buy' : 'sell'; at = r.time; base = r.qty; quote = r.quoteQty; fees[r.commissionAsset] = r.commission;
      if (r.isSelfTrade === true || units(r.price) === 0n) fail('unsupported-fill');
      const priceOutside = order.intent.side === 'buy' ? units(r.price) > units(order.intent.limitPrice) : units(r.price) < units(order.intent.limitPrice);
      const quoteOutside = order.intent.side === 'buy' ? units(r.quoteQty) * SCALE > units(r.qty) * units(order.intent.limitPrice) : units(r.quoteQty) * SCALE < units(r.qty) * units(order.intent.limitPrice);
      if (priceOutside && !quoteOutside) fail('fill-price-evidence-conflict');
    } else {
      const r = parse(okxFillSchema, inputRow); raw = r; fillId = r.tradeId; exchangeOrderId = r.ordId; client = r.clOrdId || undefined;
      side = r.side; at = r.fillTime; base = r.fillSz; quote = product(r.fillPx, r.fillSz);
      if (r.subType !== (side === 'buy' ? '1' : '2') || r.ts < at || r.ts > receivedAt + policy.maxClockSkewMs) fail('fill-time-or-side-mismatch');
      if ((!r.fee.startsWith('-') && units(r.fee) > 0n) || r.feeCcy === 'MX') fail('unsupported-fee-rebate');
      fees[r.feeCcy] = r.fee.replace(/^-/, '');
      const priorTrade = bills.get(r.billId); if (priorTrade !== undefined && priorTrade !== fillId) fail('fill-bill-conflict');
      bills.set(r.billId, fillId);
    }
    if (exchangeOrderId !== observed.exchangeOrderId || side !== order.intent.side || (client != null && client !== order.clientOrderId)) fail('fill-binding-mismatch');
    if (at < observed.createdAt || at > observed.updatedAt || at > receivedAt || at < Date.parse(order.dispatchAt!)) fail('fill-time-binding-mismatch');
    if (units(base) <= 0n || units(quote) <= 0n) fail('non-positive-fill');
    const prior = unique.get(fillId);
    if (prior) { if (canonical(prior.raw) !== canonical(raw)) fail('fill-id-conflict'); duplicates++; continue; }
    const fill: LiveOrderFill | null = order.intent.venue === 'mexc' ? { fillId: hash([order.intent.venue, observed.exchangeOrderId, fillId]),
      executedAt: new Date(at).toISOString(), baseQuantity: base, quoteQuantity: quote, quoteAmountSource: 'reported', fees } : null;
    unique.set(fillId, { raw, fill, base: units(base), quote: units(quote) });
  }
  const entries = [...unique.entries()].sort(([a], [b]) => a.localeCompare(b));
  return { normalized: entries.map(([, r]) => r.raw), fills: entries.flatMap(([, r]) => r.fill ? [r.fill] : [])
    .sort((a, b) => a.executedAt.localeCompare(b.executedAt) || a.fillId.localeCompare(b.fillId)),
    base: entries.reduce((n, [, r]) => n + r.base, 0n), quote: entries.reduce((n, [, r]) => n + r.quote, 0n),
    duplicates, quoteReported: order.intent.venue === 'mexc', rawCount: rows.length };
}
const accountingCodes = new Set(['fill-outside-limit', 'fee-exceeds-received-asset', 'fill-cap-exceeded', 'fee-cap-exceeded', 'fill-exceeds-terminal-totals']);
/** Uses only persisted, reducer-authenticated state. Capture envelopes are declared evidence, never authenticated by this pure function. */
export function buildLiveOrderRecoveryEvidence(state: LiveOrderState, orderIntentId: string, input: unknown,
  policyInput: LiveRecoveryEvidencePolicy): LiveOrderRecoveryEvidencePlan {
  const result = empty();
  try {
    const policy = parseLiveRecoveryEvidencePolicy(policyInput);
    // This call rejects copied/forged cached state and imposes the lifecycle's genuine-state boundary.
    planLiveOrderRecovery(state);
    const order = state.orders.find(row => row.intent.orderIntentId === orderIntentId);
    if (!order || !order.dispatchAt) fail('persisted-dispatch-required');
    if (order.phase === 'reconciled') fail('order-already-reconciled');
    let bytes: number; try { bytes = Buffer.byteLength(JSON.stringify(input)); } catch { fail('invalid-recovery-capture'); }
    if (bytes! > LIVE_RECOVERY_EVIDENCE_LIMITS.captureBytes) fail('recovery-capture-too-large');
    const capture = parse(captureSchema, input);
    if (capture.venue !== order.intent.venue || capture.clientOrderId !== order.clientOrderId) fail('capture-binding-mismatch');
    const reads = [capture.orderBefore, capture.fills, capture.orderAfter];
    if (reads.some(read => read.venue !== capture.venue || read.requestedAt > read.receivedAt) ||
        capture.requestedAt > reads[0].requestedAt || capture.receivedAt < reads[2].receivedAt ||
        reads[0].receivedAt > reads[1].requestedAt || reads[1].receivedAt > reads[2].requestedAt ||
        capture.requestedAt < Date.parse(order.dispatchAt) || capture.receivedAt > policy.now ||
        policy.now - capture.receivedAt > policy.maxCaptureAgeMs || capture.receivedAt - capture.requestedAt > policy.maxCaptureDurationMs) fail('invalid-or-stale-capture-time');
    if (capture.venue === 'mexc' && capture.receivedAt - Date.parse(order.dispatchAt) + policy.maxClockSkewMs > LIVE_RECOVERY_EVIDENCE_LIMITS.mexcRetentionMs) fail('mexc-order-retention-exceeded');
    const before = decodeOrder(capture.venue, capture.orderBefore.data), after = decodeOrder(capture.venue, capture.orderAfter.data);
    bindOrder(order, before, capture.orderBefore.receivedAt, policy); bindOrder(order, after, capture.orderAfter.receivedAt, policy);
    if (before.exchangeOrderId !== after.exchangeOrderId) fail('order-binding-mismatch');
    assertOrderQuery(capture.orderBefore, order, before); assertOrderQuery(capture.orderAfter, order, after);
    const limit = fillWindow(capture.fills, capture.venue, after, Date.parse(order.dispatchAt), policy.maxClockSkewMs);
    const fills = decodeFills(capture.fills.data, order, after, capture.fills.receivedAt, limit, policy);
    const normalizedCapture = { ...capture, orderBefore: { ...capture.orderBefore, data: before.raw },
      orderAfter: { ...capture.orderAfter, data: after.raw }, fills: { ...capture.fills, data: fills.normalized } };
    result.captureDigest = hash({ capture: normalizedCapture, rawFillCount: fills.rawCount });
    if (before.fingerprint !== after.fingerprint) fail('order-changed-during-capture');
    if (fills.rawCount >= limit) (result.blockers as string[]).push('fills-response-at-limit');
    if (fills.base !== units(after.cumulativeBaseQuantity)) (result.blockers as string[]).push('fill-base-total-mismatch');
    if (fills.quoteReported && fills.quote !== units(after.cumulativeQuoteQuantity)) (result.blockers as string[]).push('fill-quote-total-mismatch');
    if (!fills.quoteReported && units(after.cumulativeBaseQuantity) > 0n) (result.blockers as string[]).push('quote-amount-not-reported');
    const at = new Date(capture.receivedAt).toISOString(), identity = { venue: order.intent.venue, account: 'main' as const,
      symbol: 'BTC/USDT' as const, side: order.intent.side, clientOrderId: order.clientOrderId, exchangeOrderId: after.exchangeOrderId };
    const base = { at, orderIntentId }, seed = ['live-order-recovery-v1', order.intent, result.captureDigest];
    let current = state;
    const append = (event: LiveOrderEvent) => { current = applyLiveOrderEvent(current, event); (result.events as LiveOrderEvent[]).push(event); };
    for (const fill of fills.fills) {
      const event: LiveOrderEvent = { ...base, eventId: eventId([...seed, 'fill', fill.fillId]), type: 'fill-recorded', identity,
        source: 'declared-recorded', fill };
      try { append(event); }
      catch (error) {
        if (!(error instanceof LiveOrderLifecycleError) || !accountingCodes.has(error.code)) throw error;
        append({ ...event, type: 'fill-quarantined' });
      }
    }
    const observation: LiveOrderObservation = { identity, source: 'declared-recorded', status: after.status,
      cumulativeBaseQuantity: after.cumulativeBaseQuantity, cumulativeQuoteQuantity: after.cumulativeQuoteQuantity, quoteAmountSource: after.quoteAmountSource,
      sourceCreatedAt: new Date(after.createdAt).toISOString(), sourceUpdatedAt: new Date(after.updatedAt).toISOString() };
    const observationEvent: LiveOrderEvent = { ...base, eventId: eventId([...seed, 'observation']), type: 'order-observed', observation };
    try { append(observationEvent); }
    catch (error) {
      if (!(error instanceof LiveOrderLifecycleError) || !['invalid-cumulative-totals', 'quote-cap-exceeded', 'cumulative-regression', 'terminal-observation-conflict'].includes(error.code)) throw error;
      (result.blockers as string[]).push('lifecycle-observation-rejected');
    }
    const currentOrder = current.orders.find(row => row.intent.orderIntentId === orderIntentId)!;
    if (currentOrder.accountingAnomalies.length) (result.blockers as string[]).push('accounting-anomaly-unresolved');
    const terminal = ['filled', 'canceled', 'rejected'].includes(after.status);
    if (!terminal) (result.blockers as string[]).push('order-not-terminal');
    // OKX nonzero fills intentionally remain unrecorded; no derived money enters the live rehearsal ledger.
    if (terminal && result.blockers.length === 0) {
      append({ ...base, eventId: eventId([...seed, 'terminal']), type: 'terminal-reconciled', observationEventId: observationEvent.eventId });
      result.terminalReconciliationEligible = true;
    }
    return freeze(result);
  } catch (error) {
    const code = error instanceof BindingError ? error.code : error instanceof LiveOrderLifecycleError ? 'lifecycle-evidence-rejected' :
      error instanceof Error && error.message === 'invalid-recovery-policy' ? 'invalid-recovery-policy' : 'invalid-recovery-capture';
    // Rejected input never returns a partially admitted event batch. Quarantine is an explicit successful path above.
    return freeze({ ...empty(), captureDigest: result.captureDigest, blockers: [code] });
  }
}
