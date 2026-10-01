/** Derives rates only from verified account capture; does not authenticate future fills or permit execution. */
import { isVerifiedAccountFeeEvidence, type VerifiedAccountFeeEvidence } from './account-fee-evidence.js';
import { isVerifiedFundsEvidence, type VerifiedFundsEvidence } from './funds-evidence.js';
import { assessOrderFeeBudget, type OrderFeeBudgetAssessment } from './order-fee-budget.js';
import { applyLiveOrderEvent, createLiveOrderState, type LiveOrderIntent } from './order-lifecycle.js';
export interface VerifiedAccountFeeBudget {
  readonly schema: 1;
  readonly kind: 'verified-account-fee-budget';
  readonly calculationPassed: boolean;
  readonly feeCapsSufficient: boolean;
  readonly evidenceDeclared: false;
  /** Rates are verified relative to the accepted private collector/receipt boundary. */
  readonly feeProvenanceVerified: boolean;
  readonly rateProvenanceVerified: boolean;
  readonly feeCurrencyPolicyVerified: boolean;
  /** The policy does not prove the actual debit currency or rounding of a future fill. */
  readonly feeCurrencyVerified: false;
  readonly fillRoundingVerified: false;
  readonly liveAllowed: false;
  readonly executable: false;
  readonly reasons: readonly string[];
  readonly diagnostics: (Omit<NonNullable<OrderFeeBudgetAssessment['diagnostics']>, 'rateBasis'> & {
    rateBasis: 'maximum-observed-maker-taker';
  }) | null;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function result(reasons: readonly string[], verified = false, currency = false,
  diagnostics: VerifiedAccountFeeBudget['diagnostics'] = null): VerifiedAccountFeeBudget {
  const unique = [...new Set(reasons)];
  return freeze({ schema: 1, kind: 'verified-account-fee-budget', calculationPassed: unique.length === 0, feeCapsSufficient: unique.length === 0,
    evidenceDeclared: false, feeProvenanceVerified: verified, rateProvenanceVerified: verified, feeCurrencyPolicyVerified: currency,
    feeCurrencyVerified: false, fillRoundingVerified: false, liveAllowed: false, executable: false, reasons: unique, diagnostics });
}
export function assessVerifiedAccountFeeBudget(input: { intent: unknown; feeEvidence: VerifiedAccountFeeEvidence;
  fundsEvidence: VerifiedFundsEvidence; now: number; previousCheckedAt?: number }): VerifiedAccountFeeBudget {
  if (!input || Object.keys(input).some(key => !['intent','feeEvidence','fundsEvidence','now','previousCheckedAt'].includes(key))) return result(['invalid-verified-fee-input']);
  if (!isVerifiedAccountFeeEvidence(input.feeEvidence) || !isVerifiedFundsEvidence(input.fundsEvidence)) return result(['account-fee-evidence-not-verified']);
  const fees = input.feeEvidence, funds = input.fundsEvidence;
  if (fees.pinHash !== funds.pinHash || fees.bundleVersion !== funds.bundleVersion || fees.sourceHash !== funds.sourceHash ||
    (['mexc','okx'] as const).some(venue => fees.identities[venue].uid !== funds.identities[venue].uid ||
      fees.identities[venue].mainUid !== funds.identities[venue].mainUid || fees.identities[venue].accountType !== funds.identities[venue].accountType)) {
    return result(['fee-funds-binding-mismatch']);
  }
  if (!Number.isSafeInteger(input.now) || input.now <= 0 || input.now > 8_640_000_000_000_000 ||
    (input.previousCheckedAt !== undefined && (!Number.isSafeInteger(input.previousCheckedAt) || input.previousCheckedAt <= 0))) return result(['invalid-fee-check-time']);
  if (input.now < fees.checkedAt || input.now < funds.checkedAt || (input.previousCheckedAt !== undefined && input.now < input.previousCheckedAt)) return result(['fee-clock-regression']);
  if (input.now - fees.startedAt > 60_000 || input.now - funds.startedAt > 60_000) return result(['fee-or-funds-evidence-stale']);
  let intent: LiveOrderIntent;
  try { intent = applyLiveOrderEvent(createLiveOrderState(), { eventId: '00000000-0000-4000-8000-000000000001',
    type: 'intent-created', at: '2000-01-01T00:00:00.000Z', intent: input.intent }).orders[0].intent; }
  catch { return result(['invalid-fee-intent'], true); }
  const snapshot = fees.snapshots[intent.venue], mode = snapshot.configuration.feeCurrencyMode;
  if (mode === 'unknown') return result(snapshot.blockers.length ? snapshot.blockers : ['fee-currency-unconfirmed'], true);
  const currency = mode === 'quote' || intent.side === 'sell' ? 'USDT' : 'BTC';
  const assessed = assessOrderFeeBudget({ intent, binding: { bundleVersion: fees.bundleVersion, pinHash: fees.pinHash },
    feeEvidence: { schema: 1, kind: 'declared-order-fee-evidence', source: 'account-observation', venue: intent.venue,
      account: 'main', symbol: 'BTC/USDT', bundleVersion: fees.bundleVersion, pinHash: fees.pinHash,
      observedAt: fees.startedAt, expiresAt: fees.startedAt + 60_000, makerRate: snapshot.fees.makerCostRate,
      takerRate: snapshot.fees.takerCostRate, feeAsset: currency, provenanceVerified: false }, checkedAt: input.now,
    ...(input.previousCheckedAt === undefined ? {} : { previousCheckedAt: input.previousCheckedAt }) });
  return result([...snapshot.blockers, ...assessed.reasons], true, true,
    assessed.diagnostics === null ? null : { ...assessed.diagnostics, rateBasis: 'maximum-observed-maker-taker' });
}
