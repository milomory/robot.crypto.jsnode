/** Private preparation against a verified capture. Never a live order authorization. */
import { assessVerifiedAccountFeeBudget, type VerifiedAccountFeeBudget } from './account-fee-budget.js';
import type { VerifiedAccountFeeEvidence } from './account-fee-evidence.js';
import { isVerifiedFundsEvidence, type VerifiedFundsEvidence } from './funds-evidence.js';
import { assessOrderFeeBudget, type OrderFeeBudgetAssessment } from './order-fee-budget.js';
import { applyLiveOrderEvent, createLiveOrderState, type LiveOrderFunds, type LiveOrderIntent } from './order-lifecycle.js';
import { validateLiveLimitsDraft, type LiveLimitsDraft } from './launch-readiness.js';

const ASSETS = ['BTC', 'USDT', 'MX'] as const;
const VENUES = ['mexc', 'okx'] as const;
const SCALE = 10n ** 18n;
type Asset = typeof ASSETS[number];
type Venue = typeof VENUES[number];
type ExactFunds = Record<Asset, bigint>;
export interface AccountFundsAdmissionInput {
  intent: unknown;
  preparedIntents: readonly unknown[];
  evidence: VerifiedFundsEvidence;
  feeEvidence: unknown;
  limits: unknown | null;
  now: number;
  previousCheckedAt?: number;
}
export interface AccountFundsAdmissionAssessment {
  readonly schema: 1;
  readonly kind: 'account-funds-preparation-assessment';
  readonly allowedForPreparation: boolean;
  readonly executable: false;
  readonly liveAllowed: false;
  readonly accountGlobalOwnershipVerified: false;
  readonly feeProvenanceVerified: boolean;
  readonly userLimitsApproved: false;
  readonly reasons: readonly string[];
  readonly liveBlockers: readonly string[];
  /** Private amounts. Only fixed status/blocker codes belong in public receipts. */
  readonly diagnostics: Readonly<{
    balanceBasis: 'fresh-candidate-minus-local-prepared-reserves';
    cashDeltasAdded: false;
    exchangeHoldsSubtractedAgain: false;
    reservationIncludesFullFeeCaps: true;
    candidateByVenue: Record<Venue, Record<Asset, string | null>>;
    reservedIncludingProposedByVenue: Record<Venue, LiveOrderFunds>;
    remainingByVenue: Record<Venue, Record<Asset, string | null>>;
    insufficientFunds: readonly { venue: Venue; asset: Asset }[];
    totalReservedUsdt: string;
    grossUsdtOutflowUpperBound: string;
    lossBoundMethod: 'prepared-usdt-reserves-no-execution';
    inventoryBasis: 'observed-trading-wallet-owned-btc-including-holds';
    unhedgedBtcInterval: { lower: string; upper: string; largestAbsolute: string } | null;
    feeBudget: OrderFeeBudgetAssessment | VerifiedAccountFeeBudget;
  }> | null;
}
const PRODUCTION_BLOCKERS = Object.freeze([
  'fee-capture-and-currency-unverified',
  'current-credential-binding-not-checked',
  'user-limits-not-approved',
  'account-global-deployment-not-accepted',
  'execution-and-cash-contracts-unconfirmed',
  'strategy-after-costs-not-qualified',
  'operator-activation-path-not-implemented',
]);
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function result(reasons: string[], diagnostics: AccountFundsAdmissionAssessment['diagnostics'] = null): AccountFundsAdmissionAssessment {
  const unique = [...new Set(reasons)];
  const verified = diagnostics?.feeBudget.feeProvenanceVerified === true;
  const production = verified ? PRODUCTION_BLOCKERS.filter(reason => reason !== 'fee-capture-and-currency-unverified').concat('fill-currency-and-rounding-unaccepted') : PRODUCTION_BLOCKERS;
  return freeze({ schema: 1, kind: 'account-funds-preparation-assessment', allowedForPreparation: unique.length === 0,
    executable: false, liveAllowed: false, accountGlobalOwnershipVerified: false, feeProvenanceVerified: verified,
    userLimitsApproved: false, reasons: unique, liveBlockers: [...unique, ...production], diagnostics });
}
function units(value: string): bigint {
  const [whole, fraction = ''] = value.split('.'); return BigInt(whole) * SCALE + BigInt(fraction.padEnd(18, '0'));
}
function display(value: bigint): string {
  const absolute = value < 0n ? -value : value;
  const fraction = (absolute % SCALE).toString().padStart(18, '0').replace(/0+$/, '');
  return `${value < 0n ? '-' : ''}${absolute / SCALE}${fraction ? '.' + fraction : ''}`;
}
function zero(): ExactFunds { return { BTC: 0n, USDT: 0n, MX: 0n }; }
function show(value: ExactFunds): LiveOrderFunds { return { BTC: display(value.BTC), USDT: display(value.USDT), MX: display(value.MX) }; }
function maximum(a: bigint, b: bigint): bigint { return a > b ? a : b; }
function absolute(value: bigint): bigint { return value < 0n ? -value : value; }
function reserve(intent: LiveOrderIntent): ExactFunds {
  return { BTC: units(intent.feeCaps.BTC) + (intent.side === 'sell' ? units(intent.baseQuantity) : 0n),
    USDT: units(intent.feeCaps.USDT) + (intent.side === 'buy' ? units(intent.maxQuoteAmount) : 0n), MX: units(intent.feeCaps.MX) };
}
function validTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000_000;
}
function parseIntent(value: unknown): LiveOrderIntent {
  return applyLiveOrderEvent(createLiveOrderState(), { eventId: '00000000-0000-4000-8000-000000000001',
    at: '2000-01-01T00:00:00.000Z', type: 'intent-created', intent: value }).orders[0].intent;
}
/**
 * All supplied intents are LOCAL, unsubmitted reservations. There is deliberately no dispatch input.
 * The owning journal must replay its chain and publish the decision under the same head CAS.
 * Do not pass old lifecycle cash movements, exchange holds, or a cached copy of the evidence projection.
 */
export function assessAccountFundsAdmission(input: AccountFundsAdmissionInput): AccountFundsAdmissionAssessment {
  return evaluate(input, false);
}
export function assessVerifiedAccountFundsAdmission(input: Omit<AccountFundsAdmissionInput, 'feeEvidence'> & {
  feeEvidence: VerifiedAccountFeeEvidence;
}): AccountFundsAdmissionAssessment { return evaluate(input, true); }
function evaluate(input: AccountFundsAdmissionInput, verifiedFees: boolean): AccountFundsAdmissionAssessment {
  if (!input || typeof input !== 'object' || Object.keys(input).some(key => ![
    'intent', 'preparedIntents', 'evidence', 'feeEvidence', 'limits', 'now', 'previousCheckedAt',
  ].includes(key))) return result(['invalid-preparation-input']);
  if (!isVerifiedFundsEvidence(input.evidence)) return result(['funds-evidence-not-verified']);
  const evidence = input.evidence;
  if (!validTime(input.now) || (input.previousCheckedAt !== undefined && !validTime(input.previousCheckedAt))) return result(['invalid-check-time']);
  if (input.now < evidence.checkedAt || (input.previousCheckedAt !== undefined && input.now < input.previousCheckedAt)) return result(['funds-clock-regression']);
  if (input.now - evidence.startedAt > 60_000) return result(['funds-evidence-stale']);
  let intent: LiveOrderIntent, existing: LiveOrderIntent[], limits: LiveLimitsDraft | null;
  try {
    if (!Array.isArray(input.preparedIntents) || input.preparedIntents.length >= 200) return result(['prepared-intent-limit']);
    intent = parseIntent(input.intent);
    existing = input.preparedIntents.map(parseIntent);
    if (new Set([...existing, intent].map(item => item.orderIntentId)).size !== existing.length + 1) return result(['prepared-intent-id-reused']);
    // Detach the caller's object before schema checking. No initial balances or implicit user defaults.
    const rawLimits = JSON.stringify(input.limits);
    if (rawLimits === undefined || Buffer.byteLength(rawLimits) > 4_096) return result(['invalid-limits-draft']);
    limits = JSON.parse(rawLimits) as LiveLimitsDraft | null;
  } catch { return result(['invalid-prepared-intent-or-limits']); }
  const validation = validateLiveLimitsDraft(limits);
  if (validation.status !== 'valid-draft' || limits === null) return result(validation.reasons);
  const feeBudget = verifiedFees ? assessVerifiedAccountFeeBudget({ intent,
    feeEvidence: input.feeEvidence as VerifiedAccountFeeEvidence, fundsEvidence: evidence, now: input.now,
    ...(input.previousCheckedAt === undefined ? {} : { previousCheckedAt: input.previousCheckedAt }) }) : assessOrderFeeBudget({ intent, feeEvidence: input.feeEvidence,
    binding: { bundleVersion: evidence.bundleVersion, pinHash: evidence.pinHash }, checkedAt: input.now,
    ...(input.previousCheckedAt === undefined ? {} : { previousCheckedAt: input.previousCheckedAt }) });
  const reasons: string[] = [...feeBudget.reasons];
  // A fresh tariff may invalidate an older local cap. Retain its reservation but do
  // not admit another intent until the insufficient prepared intent is released.
  if (verifiedFees) for (const prepared of existing) {
    const rechecked = assessVerifiedAccountFeeBudget({ intent: prepared,
      feeEvidence: input.feeEvidence as VerifiedAccountFeeEvidence, fundsEvidence: evidence, now: input.now,
      ...(input.previousCheckedAt === undefined ? {} : { previousCheckedAt: input.previousCheckedAt }) });
    if (!rechecked.calculationPassed) reasons.push('prepared-fee-budget-invalid', ...rechecked.reasons);
  }
  const reserved = { mexc: zero(), okx: zero() }, pending = [...existing, intent];
  let pendingBuys = 0n, pendingSells = 0n, pendingBtcFees = 0n;
  for (const item of pending) {
    const amount = reserve(item);
    for (const asset of ASSETS) reserved[item.venue][asset] += amount[asset];
    if (item.side === 'buy') pendingBuys += units(item.baseQuantity); else pendingSells += units(item.baseQuantity);
    pendingBtcFees += units(item.feeCaps.BTC);
    if (units(item.feeCaps.MX) > 0n) reasons.push('mx-fee-valuation-unproven');
  }
  const candidateByVenue = { mexc: { BTC: null, USDT: null, MX: null }, okx: { BTC: null, USDT: null, MX: null } } as
    Record<Venue, Record<Asset, string | null>>;
  const remainingByVenue = structuredClone(candidateByVenue);
  const insufficientFunds: { venue: Venue; asset: Asset }[] = [];
  for (const venue of VENUES) {
    // Updating evidence must not silently invalidate an earlier reservation on the other venue.
    if (pending.some(item => item.venue === venue)) reasons.push(...evidence.venues[venue].blockers);
    for (const asset of ASSETS) {
      const observed = evidence.venues[venue].assets[asset];
      candidateByVenue[venue][asset] = observed.candidateAmount;
      if (observed.candidateAmount !== null) {
        const remaining = units(observed.candidateAmount) - reserved[venue][asset];
        remainingByVenue[venue][asset] = display(remaining);
        if (remaining < 0n) insufficientFunds.push({ venue, asset });
      }
      // An absent unneeded MX balance is not an instruction to buy MX or assume it exists.
      if (reserved[venue][asset] > 0n && (observed.candidateAmount === null || observed.blockers.length > 0)) {
        reasons.push('required-funds-unavailable', ...observed.blockers);
      }
    }
    if (reserved[venue].USDT > units(limits.capitalByVenueUsdt[venue])) reasons.push('venue-capital-limit');
  }
  if (insufficientFunds.length) reasons.push('insufficient-available-funds');
  const totalUsdt = reserved.mexc.USDT + reserved.okx.USDT;
  if (totalUsdt > units(limits.totalCapitalUsdt)) reasons.push('total-capital-limit');
  if (reserve(intent).USDT > units(limits.maxOrderDebitUsdt)) reasons.push('per-order-usdt-debit-limit');
  // This journal cannot dispatch. The ceiling is therefore all local USDT commitments, not P&L.
  if (totalUsdt > units(limits.maxCumulativeLossUsdt)) reasons.push('gross-usdt-outflow-limit');
  let exposure: NonNullable<AccountFundsAdmissionAssessment['diagnostics']>['unhedgedBtcInterval'] = null;
  if (VENUES.some(venue => evidence.venues[venue].assets.BTC.ownedAmount === null || evidence.venues[venue].assets.BTC.blockers.length)) {
    reasons.push('btc-exposure-unavailable');
  } else {
    const btc = units(evidence.venues.mexc.assets.BTC.ownedAmount!) + units(evidence.venues.okx.assets.BTC.ownedAmount!);
    if (btc > 0n) reasons.push('opening-btc-cost-basis-unproven');
    const lower = btc - pendingSells - pendingBtcFees, upper = btc + pendingBuys;
    const largest = maximum(absolute(lower), absolute(upper));
    exposure = { lower: display(lower), upper: display(upper), largestAbsolute: display(largest) };
    if (largest > units(limits.maxUnhedgedBtc)) reasons.push('unhedged-btc-limit');
  }
  return result(reasons, { balanceBasis: 'fresh-candidate-minus-local-prepared-reserves', cashDeltasAdded: false,
    exchangeHoldsSubtractedAgain: false, reservationIncludesFullFeeCaps: true, candidateByVenue,
    reservedIncludingProposedByVenue: { mexc: show(reserved.mexc), okx: show(reserved.okx) }, remainingByVenue,
    insufficientFunds, totalReservedUsdt: display(totalUsdt), grossUsdtOutflowUpperBound: display(totalUsdt),
    lossBoundMethod: 'prepared-usdt-reserves-no-execution', inventoryBasis: 'observed-trading-wallet-owned-btc-including-holds', unhedgedBtcInterval: exposure, feeBudget });
}
