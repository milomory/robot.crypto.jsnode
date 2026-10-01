/** Offline order lifecycle preparation. No transport, credentials, execution authority or real P&L. */
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const LIVE_ORDER_LIMITS = Object.freeze({ events: 2000, orders: 200, fills: 2000,
  eventBytes: 128 * 1024, journalBytes: 1024 * 1024 });
const uuid = z.string().uuid().transform(value => value.toLowerCase());
const time = z.string().datetime({ precision: 3, offset: false }).refine(value =>
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const amount = z.string().regex(/^(0|[1-9][0-9]{0,19})(?:\.[0-9]{1,18})?$/).transform(normalizeAmount);
const venue = z.enum(['mexc', 'okx']);
const upstreamId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const clientId = z.string().regex(/^[A-Za-z0-9]{32}$/);
const source = z.enum(['synthetic', 'declared-recorded']);
const funds = z.object({ BTC: amount, USDT: amount, MX: amount }).strict();
const intentSchema = z.object({ orderIntentId: uuid, venue, account: z.literal('main'),
  symbol: z.literal('BTC/USDT'), side: z.enum(['buy', 'sell']), orderType: z.literal('limit'),
  baseQuantity: amount, limitPrice: amount, maxQuoteAmount: amount, feeCaps: funds }).strict();
const identitySchema = z.object({ venue, account: z.literal('main'), symbol: z.literal('BTC/USDT'),
  side: z.enum(['buy', 'sell']), clientOrderId: clientId, exchangeOrderId: upstreamId }).strict();
const observationSchema = z.object({ identity: identitySchema, source,
  status: z.enum(['new', 'partially-filled', 'filled', 'canceled', 'rejected']),
  cumulativeBaseQuantity: amount, cumulativeQuoteQuantity: amount,
  quoteAmountSource: z.enum(['reported', 'derived']),
  sourceCreatedAt: time.optional(), sourceUpdatedAt: time.optional(),
}).strict().refine(row => (row.sourceCreatedAt === undefined) === (row.sourceUpdatedAt === undefined) &&
  (row.sourceCreatedAt === undefined || row.sourceCreatedAt <= row.sourceUpdatedAt!))
  .transform(row => {
    if (row.sourceCreatedAt === undefined) { delete row.sourceCreatedAt; delete row.sourceUpdatedAt; }
    return row;
  });
const fillSchema = z.object({ fillId: upstreamId, executedAt: time, baseQuantity: amount,
  quoteQuantity: amount, quoteAmountSource: z.literal('reported'), fees: funds }).strict();
const common = { eventId: uuid, at: time };
const selected = { ...common, orderIntentId: uuid };
const eventSchema = z.discriminatedUnion('type', [
  z.object({ ...common, type: z.literal('intent-created'), intent: intentSchema }).strict(),
  z.object({ ...selected, type: z.literal('dispatch-marked'), clientOrderId: clientId }).strict(),
  z.object({ ...selected, type: z.literal('dispatch-uncertain'),
    reason: z.enum(['timeout', 'connection-lost', 'process-recovery']) }).strict(),
  z.object({ ...selected, type: z.literal('lookup-not-found'), venue, account: z.literal('main'), clientOrderId: clientId, source }).strict(),
  z.object({ ...selected, type: z.literal('order-observed'), observation: observationSchema }).strict(),
  z.object({ ...selected, type: z.literal('fill-recorded'), identity: identitySchema, source, fill: fillSchema }).strict(),
  z.object({ ...selected, type: z.literal('fill-quarantined'), identity: identitySchema, source, fill: fillSchema }).strict(),
  z.object({ ...selected, type: z.literal('cancel-requested') }).strict(),
  z.object({ ...selected, type: z.literal('cancel-acknowledged') }).strict(),
  z.object({ ...selected, type: z.literal('terminal-reconciled'), observationEventId: uuid }).strict(),
]);
export type LiveOrderVenue = z.infer<typeof venue>;
export type LiveOrderFunds = z.infer<typeof funds>;
export type LiveOrderIntent = z.infer<typeof intentSchema>;
export type LiveOrderEvent = z.infer<typeof eventSchema>;
export type LiveOrderFill = z.infer<typeof fillSchema>;
export type LiveOrderObservation = z.infer<typeof observationSchema>;
export type LiveOrderPhase = 'prepared' | 'unknown' | 'open' | 'partially-filled' | 'terminal-unreconciled' | 'quarantined' | 'reconciled';
export interface LiveOrderRecord {
  readonly intent: LiveOrderIntent;
  readonly createdAt: string;
  readonly clientOrderId: string;
  readonly phase: LiveOrderPhase;
  readonly exchangeOrderId: string | null;
  readonly dispatchEventId: string | null;
  readonly dispatchAt: string | null;
  readonly cancelRequested: boolean;
  readonly cancelAcknowledged: boolean;
  readonly latestObservation: (LiveOrderObservation & { eventId: string }) | null;
  readonly fills: readonly LiveOrderFill[];
  /** Full conservative local reservation survives uncertainty and terminal acknowledgement. */
  readonly reserved: LiveOrderFunds;
  /** Exact movements of supplied rehearsal fills; not an account balance or profit. */
  readonly cashDelta: LiveOrderFunds;
  /** Sticky incident codes; this rehearsal has no authority to waive or clear them. */
  readonly accountingAnomalies: readonly LiveOrderAccountingAnomaly[];
}
export type LiveOrderAccountingAnomaly = 'fill-outside-limit' | 'fee-exceeds-received-asset' | 'fill-cap-exceeded' |
  'fee-cap-exceeded' | 'fill-exceeds-terminal-totals';
export interface LiveOrderState {
  readonly schema: 1;
  readonly kind: 'live-order-rehearsal';
  readonly source: 'local-rehearsal';
  readonly nonExecutable: true;
  readonly captureProvenanceVerified: false;
  readonly events: readonly LiveOrderEvent[];
  readonly orders: readonly LiveOrderRecord[];
}
export class LiveOrderLifecycleError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'LiveOrderLifecycleError'; }
}
const ASSETS = ['BTC', 'USDT', 'MX'] as const;
const SCALE = 10n ** 18n;
const createdStates = new WeakSet<LiveOrderState>();
function fail(code: string): never { throw new LiveOrderLifecycleError(code); }
function normalizeAmount(value: string): string {
  const [whole, fractional] = value.split('.');
  const tail = fractional?.replace(/0+$/, '');
  return tail ? `${whole}.${tail}` : whole;
}
function units(value: string): bigint {
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const valueUnits = BigInt(whole) * SCALE + BigInt(fraction.padEnd(18, '0'));
  return negative ? -valueUnits : valueUnits;
}
function decimal(value: bigint): string {
  const absolute = value < 0n ? -value : value;
  const fraction = (absolute % SCALE).toString().padStart(18, '0').replace(/0+$/, '');
  return `${value < 0n ? '-' : ''}${absolute / SCALE}${fraction ? `.${fraction}` : ''}`;
}
function zero(): LiveOrderFunds { return { BTC: '0', USDT: '0', MX: '0' }; }
export function canonicalLiveOrderJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalLiveOrderJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalLiveOrderJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  const text = JSON.stringify(value);
  if (text === undefined) fail('invalid-canonical-value');
  return text;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) freeze(entry);
    Object.freeze(value);
  }
  return value;
}
function register(state: LiveOrderState): LiveOrderState { freeze(state); createdStates.add(state); return state; }
export function createLiveOrderState(): LiveOrderState {
  return register({ schema: 1, kind: 'live-order-rehearsal', source: 'local-rehearsal', nonExecutable: true,
    captureProvenanceVerified: false, events: [], orders: [] });
}
/** IDs are never recycled within a journal, including after a terminal order. */
export function deriveLiveClientOrderId(venueInput: LiveOrderVenue, orderIntentId: string): string {
  const selectedVenue = venue.safeParse(venueInput), intentId = uuid.safeParse(orderIntentId);
  if (!selectedVenue.success || !intentId.success) fail('invalid-order-identity');
  const hash = createHash('sha256').update(`crypto-live-order-v1\0${selectedVenue.data}\0main\0BTC/USDT\0${intentId.data}`).digest('hex');
  return `CR${selectedVenue.data === 'mexc' ? 'M' : 'O'}${hash.slice(0, 29)}`;
}
export function parseLiveOrderEvent(input: unknown): LiveOrderEvent {
  // JSON must remain bounded even before schema validation. Callers of file APIs also bound raw bytes.
  let size: number;
  try { size = Buffer.byteLength(JSON.stringify(input), 'utf8'); } catch { return fail('invalid-event'); }
  if (size > LIVE_ORDER_LIMITS.eventBytes) fail('event-size-limit');
  const parsed = eventSchema.safeParse(input);
  if (!parsed.success) fail('invalid-event');
  return parsed.data;
}
function terminal(status: LiveOrderObservation['status']): boolean {
  return status === 'filled' || status === 'canceled' || status === 'rejected';
}
function totals(fills: readonly LiveOrderFill[]): { base: bigint; quote: bigint; fees: Record<keyof LiveOrderFunds, bigint> } {
  const result = { base: 0n, quote: 0n, fees: { BTC: 0n, USDT: 0n, MX: 0n } };
  for (const fill of fills) {
    result.base += units(fill.baseQuantity); result.quote += units(fill.quoteQuantity);
    for (const asset of ASSETS) result.fees[asset] += units(fill.fees[asset]);
  }
  return result;
}
function reserve(intent: LiveOrderIntent): LiveOrderFunds {
  return { BTC: decimal(units(intent.feeCaps.BTC) + (intent.side === 'sell' ? units(intent.baseQuantity) : 0n)),
    USDT: decimal(units(intent.feeCaps.USDT) + (intent.side === 'buy' ? units(intent.maxQuoteAmount) : 0n)), MX: intent.feeCaps.MX };
}
function assertIntent(intent: LiveOrderIntent): void {
  if (units(intent.baseQuantity) <= 0n || units(intent.limitPrice) <= 0n || units(intent.maxQuoteAmount) <= 0n) fail('non-positive-intent');
  if (intent.side === 'buy' && units(intent.maxQuoteAmount) * SCALE < units(intent.baseQuantity) * units(intent.limitPrice)) fail('quote-cap-below-limit-notional');
  if (intent.venue === 'okx' && units(intent.feeCaps.MX) !== 0n) fail('unsupported-fee-asset');
}
function assertIdentity(order: LiveOrderRecord, identity: z.infer<typeof identitySchema>, state: LiveOrderState): void {
  if (identity.venue !== order.intent.venue || identity.account !== order.intent.account || identity.symbol !== order.intent.symbol ||
      identity.side !== order.intent.side || identity.clientOrderId !== order.clientOrderId ||
      (order.exchangeOrderId !== null && identity.exchangeOrderId !== order.exchangeOrderId)) fail('order-identity-mismatch');
  if (state.orders.some(other => other.intent.orderIntentId !== order.intent.orderIntentId &&
      other.intent.venue === identity.venue && other.exchangeOrderId === identity.exchangeOrderId)) fail('exchange-order-id-reused');
}
function assertObservation(order: LiveOrderRecord, observation: LiveOrderObservation): void {
  const base = units(observation.cumulativeBaseQuantity), quote = units(observation.cumulativeQuoteQuantity),
    maximum = units(order.intent.baseQuantity), known = totals(order.fills), previous = order.latestObservation;
  if (previous?.sourceCreatedAt !== undefined && (observation.sourceCreatedAt !== previous.sourceCreatedAt ||
      observation.sourceUpdatedAt === undefined || observation.sourceUpdatedAt < previous.sourceUpdatedAt!)) fail('source-time-regression');
  if ((base === 0n) !== (quote === 0n) || base > maximum || base < known.base || quote < known.quote) fail('invalid-cumulative-totals');
  if (order.intent.side === 'buy' && quote > units(order.intent.maxQuoteAmount)) fail('quote-cap-exceeded');
  if (previous && (base < units(previous.cumulativeBaseQuantity) || quote < units(previous.cumulativeQuoteQuantity))) fail('cumulative-regression');
  if (previous && terminal(previous.status) && (observation.status !== previous.status ||
      base !== units(previous.cumulativeBaseQuantity) || quote !== units(previous.cumulativeQuoteQuantity))) fail('terminal-observation-conflict');
  if (previous?.status === 'partially-filled' && observation.status === 'new') fail('status-regression');
  if ((observation.status === 'new' || observation.status === 'rejected') && base !== 0n) fail('unfilled-status-has-execution');
  if (observation.status === 'partially-filled' && (base === 0n || base >= maximum)) fail('invalid-partial-status');
  if (observation.status === 'filled' && base !== maximum) fail('filled-quantity-mismatch');
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
/** Only reducer-created immutable states are accepted; restore by replaying events, never by trusting cached totals. */
export function applyLiveOrderEvent(state: LiveOrderState, input: unknown): LiveOrderState {
  if (!createdStates.has(state)) fail('invalid-state');
  const event = parseLiveOrderEvent(input);
  const existing = state.events.find(prior => prior.eventId === event.eventId);
  if (existing) {
    if (canonicalLiveOrderJson(existing) !== canonicalLiveOrderJson(event)) fail('event-id-conflict');
    return state;
  }
  if (state.events.length >= LIVE_ORDER_LIMITS.events) fail('event-count-limit');
  if (Buffer.byteLength(canonicalLiveOrderJson([...state.events, event]), 'utf8') > LIVE_ORDER_LIMITS.journalBytes) fail('journal-size-limit');
  if (state.events.length && event.at < state.events[state.events.length - 1].at) fail('event-time-regression');
  const orders = structuredClone(state.orders) as Mutable<LiveOrderRecord>[];
  if (event.type === 'intent-created') {
    if (orders.length >= LIVE_ORDER_LIMITS.orders) fail('order-count-limit');
    assertIntent(event.intent);
    const clientOrderId = deriveLiveClientOrderId(event.intent.venue, event.intent.orderIntentId);
    if (orders.some(order => order.intent.orderIntentId === event.intent.orderIntentId || order.clientOrderId === clientOrderId)) fail('intent-id-reused');
    orders.push({ intent: event.intent, createdAt: event.at, clientOrderId, phase: 'prepared', exchangeOrderId: null,
      dispatchEventId: null, dispatchAt: null, cancelRequested: false, cancelAcknowledged: false,
      latestObservation: null, fills: [], reserved: reserve(event.intent), cashDelta: zero(), accountingAnomalies: [] });
  } else {
    const order = orders.find(item => item.intent.orderIntentId === event.orderIntentId);
    if (!order) fail('unknown-intent');
    if (order.phase === 'reconciled') fail('order-already-reconciled');
    if (event.type === 'dispatch-marked') {
      if (order.dispatchEventId !== null) fail('dispatch-already-marked');
      if (event.clientOrderId !== order.clientOrderId) fail('order-identity-mismatch');
      // A durable marker authorizes no action here. Recovery must assume the remote side may have executed.
      order.dispatchEventId = event.eventId; order.dispatchAt = event.at; order.phase = 'unknown';
    } else {
      if (order.dispatchEventId === null) fail('dispatch-not-marked');
      if (event.type === 'dispatch-uncertain') {
        if (!order.latestObservation || !terminal(order.latestObservation.status)) order.phase = 'unknown';
      } else if (event.type === 'lookup-not-found') {
        if (event.venue !== order.intent.venue || event.account !== order.intent.account || event.clientOrderId !== order.clientOrderId) fail('order-identity-mismatch');
        if (!order.latestObservation || !terminal(order.latestObservation.status)) order.phase = 'unknown';
      } else if (event.type === 'cancel-requested') {
        if (order.cancelRequested) fail('cancel-already-requested');
        if (order.latestObservation && terminal(order.latestObservation.status)) fail('terminal-order-cancel');
        order.cancelRequested = true;
      } else if (event.type === 'cancel-acknowledged') {
        if (!order.cancelRequested) fail('cancel-not-requested');
        if (order.cancelAcknowledged) fail('cancel-already-acknowledged');
        order.cancelAcknowledged = true;
      } else if (event.type === 'order-observed') {
        assertIdentity(order, event.observation.identity, { ...state, orders });
        assertObservation(order, event.observation);
        order.exchangeOrderId = event.observation.identity.exchangeOrderId;
        order.latestObservation = { ...event.observation, eventId: event.eventId };
        order.phase = terminal(event.observation.status) ? 'terminal-unreconciled' : event.observation.status === 'new' ? 'open' : 'partially-filled';
      } else if (event.type === 'fill-recorded' || event.type === 'fill-quarantined') {
        assertIdentity(order, event.identity, { ...state, orders });
        const previousFill = order.fills.find(fill => fill.fillId === event.fill.fillId);
        if (previousFill) {
          if (canonicalLiveOrderJson(previousFill) !== canonicalLiveOrderJson(event.fill)) fail('fill-id-conflict');
        } else {
          if (orders.reduce((count, item) => count + item.fills.length, 0) >= LIVE_ORDER_LIMITS.fills) fail('fill-count-limit');
          if (orders.some(other => other.intent.orderIntentId !== order.intent.orderIntentId && other.intent.venue === order.intent.venue &&
              other.fills.some(fill => fill.fillId === event.fill.fillId))) fail('fill-id-reused');
          const fill = event.fill, base = units(fill.baseQuantity), quote = units(fill.quoteQuantity);
          if (fill.executedAt < order.dispatchAt! || fill.executedAt > event.at || base <= 0n || quote <= 0n) fail('invalid-fill');
          const anomalies: LiveOrderAccountingAnomaly[] = [];
          if ((order.intent.side === 'buy' && quote * SCALE > base * units(order.intent.limitPrice)) ||
              (order.intent.side === 'sell' && quote * SCALE < base * units(order.intent.limitPrice))) anomalies.push('fill-outside-limit');
          if ((order.intent.side === 'buy' && units(fill.fees.BTC) > base) ||
              (order.intent.side === 'sell' && units(fill.fees.USDT) > quote)) anomalies.push('fee-exceeds-received-asset');
          const combined = [...order.fills, fill], sum = totals(combined);
          if (sum.base > units(order.intent.baseQuantity) || (order.intent.side === 'buy' && sum.quote > units(order.intent.maxQuoteAmount))) anomalies.push('fill-cap-exceeded');
          if (ASSETS.some(asset => sum.fees[asset] > units(order.intent.feeCaps[asset]))) anomalies.push('fee-cap-exceeded');
          if (order.latestObservation && terminal(order.latestObservation.status) &&
              (sum.base > units(order.latestObservation.cumulativeBaseQuantity) || sum.quote > units(order.latestObservation.cumulativeQuoteQuantity))) anomalies.push('fill-exceeds-terminal-totals');
          if (event.type === 'fill-quarantined' && anomalies.length === 0) fail('accounting-anomaly-required');
          if (event.type === 'fill-recorded' && anomalies.length > 0 && order.accountingAnomalies.length === 0) fail(anomalies[0]);
          order.exchangeOrderId = event.identity.exchangeOrderId;
          order.fills = combined;
          order.accountingAnomalies = [...new Set([...order.accountingAnomalies, ...anomalies])].sort();
          order.cashDelta = { BTC: decimal((order.intent.side === 'buy' ? sum.base : -sum.base) - sum.fees.BTC),
            USDT: decimal((order.intent.side === 'buy' ? -sum.quote : sum.quote) - sum.fees.USDT), MX: decimal(-sum.fees.MX) };
        }
      } else {
        if (order.accountingAnomalies.length > 0) fail('accounting-anomaly-unresolved');
        const observation = order.latestObservation, sum = totals(order.fills);
        if (!observation || !terminal(observation.status) || observation.eventId !== event.observationEventId) fail('terminal-observation-required');
        if (sum.base !== units(observation.cumulativeBaseQuantity) || sum.quote !== units(observation.cumulativeQuoteQuantity)) fail('incomplete-fill-reconciliation');
        if (sum.base > 0n && observation.quoteAmountSource !== 'reported') fail('reported-quote-required');
        order.phase = 'reconciled'; order.reserved = zero();
      }
    }
    if (order.accountingAnomalies.length > 0) order.phase = 'quarantined';
  }
  return register({ ...state, orders, events: [...state.events, event] });
}
export function replayLiveOrderEvents(events: readonly unknown[]): LiveOrderState {
  if (!Array.isArray(events) || events.length > LIVE_ORDER_LIMITS.events) fail('event-count-limit');
  return events.reduce<LiveOrderState>((state, event) => applyLiveOrderEvent(state, event), createLiveOrderState());
}
export interface LiveOrderRecoveryAction {
  readonly orderIntentId: string;
  readonly venue: LiveOrderVenue;
  readonly clientOrderId: string;
  readonly exchangeOrderId: string | null;
  readonly action: 'review-unsubmitted-intent' | 'lookup-by-client-id' | 'reconcile-terminal-fills' | 'inspect-accounting-anomaly' | 'none';
  readonly automaticResubmitAllowed: false;
  readonly reservationRetained: boolean;
}
/** A review plan only: neither a retry callback nor a permission to submit/cancel exists. */
export function planLiveOrderRecovery(state: LiveOrderState): {
  nonExecutable: true; captureProvenanceVerified: false; actions: readonly LiveOrderRecoveryAction[];
} {
  if (!createdStates.has(state)) fail('invalid-state');
  return freeze({ nonExecutable: true, captureProvenanceVerified: false, actions: state.orders.map(order => ({
    orderIntentId: order.intent.orderIntentId, venue: order.intent.venue, clientOrderId: order.clientOrderId,
    exchangeOrderId: order.exchangeOrderId, action: order.phase === 'quarantined' ? 'inspect-accounting-anomaly' : order.phase === 'reconciled' ? 'none' :
      order.phase === 'prepared' ? 'review-unsubmitted-intent' : order.phase === 'terminal-unreconciled' ?
        'reconcile-terminal-fills' : 'lookup-by-client-id',
    automaticResubmitAllowed: false, reservationRetained: order.phase !== 'reconciled',
  })) });
}
