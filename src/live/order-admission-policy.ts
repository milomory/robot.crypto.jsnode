/** Exact, conservative admission for a declared synthetic journal only. No account valuation or execution authority. */
import { z } from 'zod';
import { applyLiveOrderEvent, parseLiveOrderEvent, planLiveOrderRecovery, type LiveOrderEvent, type LiveOrderFunds,
  type LiveOrderIntent, type LiveOrderRecord, type LiveOrderState } from './order-lifecycle.js';
import { validateLiveLimitsDraft } from './launch-readiness.js';

const amount = z.string().regex(/^(0|[1-9][0-9]{0,19})(?:\.[0-9]{1,18})?$/).transform(normalize);
const positive = amount.refine(value => value !== '0');
const funds = z.object({ BTC: amount, USDT: amount, MX: amount }).strict();
const limits = z.object({ schema: z.literal(1), kind: z.literal('live-limits-draft'), account: z.literal('main'), symbol: z.literal('BTC/USDT'),
  totalCapitalUsdt: positive, capitalByVenueUsdt: z.object({ mexc: positive, okx: positive }).strict(),
  maxOrderDebitUsdt: positive, maxCumulativeLossUsdt: positive, maxUnhedgedBtc: positive,
  includeEarn: z.literal(false), transfersEnabled: z.literal(false), withdrawalsEnabled: z.literal(false) }).strict();
const policySchema = z.object({ schema: z.literal(1), kind: z.literal('live-order-admission-policy'), source: z.literal('declared-synthetic'),
  limits, initialBalances: z.object({ mexc: funds, okx: funds }).strict() }).strict();
export type LiveOrderAdmissionPolicy = z.infer<typeof policySchema>;
export class LiveOrderAdmissionPolicyError extends Error {
  readonly code = 'invalid-admission-policy';
  constructor() { super('invalid-admission-policy'); this.name = 'LiveOrderAdmissionPolicyError'; }
}
const SCALE = 10n ** 18n;
const ASSETS = ['BTC', 'USDT', 'MX'] as const;
const VENUES = ['mexc', 'okx'] as const;
type Venue = typeof VENUES[number];
type Funds = Record<typeof ASSETS[number], bigint>;
type VenueFunds = Record<Venue, Funds>;
export interface LiveOrderAdmissionDiagnostics {
  lossBoundMethod: 'lifetime-gross-usdt-outflow-upper-bound';
  realizedPnlComputed: false;
  capitalValuationPerformed: false;
  knownGrossUsdtOutflow: string;
  reservedAndProposedUsdt: string;
  grossUsdtOutflowUpperBound: string;
  proposedOrderDebitUsdt: string;
  venueCapitalCommitmentUsdt: Record<Venue, string>;
  totalCapitalCommitmentUsdt: string;
  /** Potential opposite pending legs do not cancel: each extremum assumes only the risk-increasing fills. */
  unhedgedBtcInterval: { lower: string; upper: string; largestAbsolute: string };
  walletByVenue: Record<Venue, LiveOrderFunds>;
  reservationsIncludingProposedByVenue: Record<Venue, LiveOrderFunds>;
  availableAfterReservationsByVenue: Record<Venue, LiveOrderFunds>;
  insufficientFunds: readonly { venue: Venue; asset: typeof ASSETS[number] }[];
}
export interface LiveOrderAdmissionAssessment {
  schema: 1;
  kind: 'live-order-admission-assessment';
  source: 'local-rehearsal';
  nonExecutable: true;
  captureProvenanceVerified: false;
  realBalancesVerified: false;
  productionLimitsEnforced: false;
  allowedForRehearsal: boolean;
  reasons: readonly string[];
  diagnostics: LiveOrderAdmissionDiagnostics | null;
}
function normalize(value: string): string {
  const [whole, fraction = ''] = value.split('.'), tail = fraction.replace(/0+$/, ''); return tail ? `${whole}.${tail}` : whole;
}
function units(value: string): bigint {
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const parsed = BigInt(whole) * SCALE + BigInt(fraction.padEnd(18, '0')); return negative ? -parsed : parsed;
}
function display(value: bigint): string {
  const absolute = value < 0n ? -value : value, tail = (absolute % SCALE).toString().padStart(18, '0').replace(/0+$/, '');
  return `${value < 0n ? '-' : ''}${absolute / SCALE}${tail ? '.' + tail : ''}`;
}
function absolute(value: bigint): bigint { return value < 0n ? -value : value; }
function maximum(a: bigint, b: bigint): bigint { return a > b ? a : b; }
function zero(): Funds { return { BTC: 0n, USDT: 0n, MX: 0n }; }
function venueZero(): VenueFunds { return { mexc: zero(), okx: zero() }; }
function showFunds(value: Funds): LiveOrderFunds { return { BTC: display(value.BTC), USDT: display(value.USDT), MX: display(value.MX) }; }
function showVenues(value: VenueFunds): Record<Venue, LiveOrderFunds> { return { mexc: showFunds(value.mexc), okx: showFunds(value.okx) }; }
function freeze<T>(value: T): T { if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function result(reasons: string[], diagnostics: LiveOrderAdmissionDiagnostics | null = null): LiveOrderAdmissionAssessment {
  return freeze({ schema: 1, kind: 'live-order-admission-assessment', source: 'local-rehearsal', nonExecutable: true,
    captureProvenanceVerified: false, realBalancesVerified: false, productionLimitsEnforced: false,
    allowedForRehearsal: reasons.length === 0, reasons: [...new Set(reasons)], diagnostics });
}
/** Exact shape and no defaults. Initial balances are declarations, never authenticated account facts. */
export function parseLiveOrderAdmissionPolicy(input: unknown): LiveOrderAdmissionPolicy {
  const parsed = policySchema.safeParse(input);
  if (!parsed.success || validateLiveLimitsDraft(parsed.data.limits).status !== 'valid-draft') throw new LiveOrderAdmissionPolicyError();
  return freeze(parsed.data);
}
function reservation(intent: LiveOrderIntent): Funds {
  return { BTC: units(intent.feeCaps.BTC) + (intent.side === 'sell' ? units(intent.baseQuantity) : 0n),
    USDT: units(intent.feeCaps.USDT) + (intent.side === 'buy' ? units(intent.maxQuoteAmount) : 0n), MX: units(intent.feeCaps.MX) };
}
function evaluate(state: LiveOrderState, intent: LiveOrderIntent, policy: LiveOrderAdmissionPolicy, ownPreparedIntentId?: string): LiveOrderAdmissionAssessment {
  const reasons: string[] = [], wallet = venueZero(), cash = venueZero(), reserved = venueZero();
  const insufficientFunds: { venue: Venue; asset: typeof ASSETS[number] }[] = [];
  let knownGross = 0n, pendingBuyBase = 0n, pendingSellBase = 0n, pendingBtcFees = 0n;
  for (const v of VENUES) for (const a of ASSETS) wallet[v][a] = units(policy.initialBalances[v][a]);
  // A price-free full-loss ceiling cannot assign cost to coins present before this isolated history.
  if (VENUES.some(v => units(policy.initialBalances[v].BTC) > 0n)) reasons.push('opening-btc-cost-basis-unproven');
  const pending: LiveOrderIntent[] = [];
  for (const order of state.orders) {
    const v = order.intent.venue;
    for (const a of ASSETS) { cash[v][a] += units(order.cashDelta[a]); wallet[v][a] += units(order.cashDelta[a]); }
    // Never net sale proceeds or profitable outcomes against this lifetime safety ceiling.
    for (const fill of order.fills) knownGross += units(fill.fees.USDT) + (order.intent.side === 'buy' ? units(fill.quoteQuantity) : 0n);
    if (order.accountingAnomalies.length > 0 || order.phase === 'quarantined') reasons.push('accounting-anomaly-unresolved');
    if (order.phase === 'unknown') reasons.push('unknown-order-outcome');
    if (order.fills.some(fill => units(fill.fees.MX) > 0n)) reasons.push('mx-fee-valuation-unproven');
    if (order.intent.orderIntentId === ownPreparedIntentId) continue;
    if (order.phase !== 'reconciled') {
      for (const a of ASSETS) reserved[v][a] += units(order.reserved[a]);
      pending.push(order.intent);
    }
  }
  const proposed = reservation(intent);
  for (const a of ASSETS) reserved[intent.venue][a] += proposed[a];
  pending.push(intent);
  for (const item of pending) {
    if (item.side === 'buy') pendingBuyBase += units(item.baseQuantity); else pendingSellBase += units(item.baseQuantity);
    pendingBtcFees += units(item.feeCaps.BTC);
    if (units(item.feeCaps.MX) > 0n) reasons.push('mx-fee-valuation-unproven');
  }
  const available = venueZero(), commitments: Record<Venue, bigint> = { mexc: 0n, okx: 0n };
  for (const v of VENUES) {
    for (const a of ASSETS) {
      available[v][a] = wallet[v][a] - reserved[v][a];
      if (wallet[v][a] < 0n) reasons.push('negative-declared-wallet');
      if (available[v][a] < 0n) insufficientFunds.push({ venue: v, asset: a });
    }
    // Cash returned by completed sales can reduce capital occupancy, but never enlarge the original allocation.
    commitments[v] = maximum(0n, -cash[v].USDT) + reserved[v].USDT;
    if (commitments[v] > units(policy.limits.capitalByVenueUsdt[v])) reasons.push('venue-capital-limit');
  }
  if (insufficientFunds.length > 0) reasons.push('insufficient-wallet-funds');
  const totalCommitment = commitments.mexc + commitments.okx;
  if (totalCommitment > units(policy.limits.totalCapitalUsdt)) reasons.push('total-capital-limit');
  if (proposed.USDT > units(policy.limits.maxOrderDebitUsdt)) reasons.push('per-order-usdt-debit-limit');
  const reservedUsdt = reserved.mexc.USDT + reserved.okx.USDT, lossCeiling = knownGross + reservedUsdt;
  if (lossCeiling > units(policy.limits.maxCumulativeLossUsdt)) reasons.push('gross-usdt-outflow-limit');
  const currentBtc = wallet.mexc.BTC + wallet.okx.BTC;
  const lower = currentBtc - pendingSellBase - pendingBtcFees, upper = currentBtc + pendingBuyBase;
  const largestAbsolute = maximum(absolute(lower), absolute(upper));
  if (largestAbsolute > units(policy.limits.maxUnhedgedBtc)) reasons.push('unhedged-btc-limit');
  return result(reasons, { lossBoundMethod: 'lifetime-gross-usdt-outflow-upper-bound', realizedPnlComputed: false,
    capitalValuationPerformed: false, knownGrossUsdtOutflow: display(knownGross), reservedAndProposedUsdt: display(reservedUsdt),
    grossUsdtOutflowUpperBound: display(lossCeiling), proposedOrderDebitUsdt: display(proposed.USDT),
    venueCapitalCommitmentUsdt: { mexc: display(commitments.mexc), okx: display(commitments.okx) }, totalCapitalCommitmentUsdt: display(totalCommitment),
    unhedgedBtcInterval: { lower: display(lower), upper: display(upper), largestAbsolute: display(largestAbsolute) },
    walletByVenue: showVenues(wallet), reservationsIncludingProposedByVenue: showVenues(reserved), availableAfterReservationsByVenue: showVenues(available), insufficientFunds });
}
function validated(state: LiveOrderState, eventInput: unknown, policyInput: unknown, expectedType: 'intent-created' | 'dispatch-marked'):
  { policy: LiveOrderAdmissionPolicy; event: LiveOrderEvent } | LiveOrderAdmissionAssessment {
  let policy: LiveOrderAdmissionPolicy;
  try { policy = parseLiveOrderAdmissionPolicy(policyInput); } catch { return result(['invalid-admission-policy']); }
  try { planLiveOrderRecovery(state); } catch { return result(['invalid-rehearsal-state']); }
  let event: LiveOrderEvent;
  try { event = parseLiveOrderEvent(eventInput); } catch { return result([expectedType === 'intent-created' ? 'invalid-intent-event' : 'invalid-dispatch-event']); }
  if (event.type !== expectedType) return result([expectedType === 'intent-created' ? 'invalid-intent-event' : 'invalid-dispatch-event']);
  try { applyLiveOrderEvent(state, event); } catch { return result(['lifecycle-event-rejected']); }
  return { policy, event };
}
/** Admission affects only the proposed intent. Actual observations and costs must always use the lifecycle, regardless of risk breaches. */
export function assessLiveOrderAdmission(state: LiveOrderState, eventInput: unknown, policyInput: unknown): LiveOrderAdmissionAssessment {
  const checked = validated(state, eventInput, policyInput, 'intent-created');
  if ('allowedForRehearsal' in checked) return checked;
  if (checked.event.type !== 'intent-created') return result(['invalid-intent-event']);
  const event = checked.event;
  if (state.orders.some(o => o.intent.orderIntentId === event.intent.orderIntentId)) return result(['invalid-intent-event']);
  return evaluate(state, event.intent, checked.policy);
}
/** Recheck immediately before persisting a dispatch marker; the intent's own existing reserve is counted once, never waived. */
export function assessLiveOrderDispatch(state: LiveOrderState, eventInput: unknown, policyInput: unknown): LiveOrderAdmissionAssessment {
  const checked = validated(state, eventInput, policyInput, 'dispatch-marked');
  if ('allowedForRehearsal' in checked) return checked;
  if (checked.event.type !== 'dispatch-marked') return result(['invalid-dispatch-event']);
  const event = checked.event;
  const order: LiveOrderRecord | undefined = state.orders.find(o => o.intent.orderIntentId === event.orderIntentId);
  if (!order || order.phase !== 'prepared' || order.dispatchEventId !== null) return result(['invalid-dispatch-event']);
  return evaluate(state, order.intent, checked.policy, order.intent.orderIntentId);
}
