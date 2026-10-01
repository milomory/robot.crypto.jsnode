/** Preparation diagnostics only. This module cannot authorize exchange operations. */
import { z } from 'zod';
import { applyLiveOrderEvent, createLiveOrderState, planLiveOrderRecovery, type LiveOrderState } from './order-lifecycle.js';

const amount = z.string().regex(/^(0|[1-9][0-9]{0,19})(?:\.[0-9]{1,18})?$/);
const positive = amount.refine(value => /[1-9]/.test(value));
const SCALE = 10n ** 18n;
function units(value: string): bigint {
  const [whole, fractional = ''] = value.split('.');
  return BigInt(whole) * SCALE + BigInt(fractional.padEnd(18, '0'));
}

// Exact schema, no defaults: choosing a draft does not approve or activate it.
const policyDraft = z.object({
  schema: z.literal(1), kind: z.literal('live-limits-draft'),
  account: z.literal('main'), symbol: z.literal('BTC/USDT'),
  totalCapitalUsdt: positive,
  capitalByVenueUsdt: z.object({ mexc: positive, okx: positive }).strict(),
  maxOrderDebitUsdt: positive,
  maxCumulativeLossUsdt: positive,
  maxUnhedgedBtc: positive,
  includeEarn: z.literal(false),
  transfersEnabled: z.literal(false), withdrawalsEnabled: z.literal(false),
}).strict();
export type LiveLimitsDraft = z.infer<typeof policyDraft>;
export type DraftValidation = { status: 'missing' | 'invalid' | 'valid-draft'; reasons: string[] };

/** No amounts or supplied text are returned; errors are fixed codes. */
export function validateLiveLimitsDraft(input: unknown): DraftValidation {
  if (input === undefined || input === null) return { status: 'missing', reasons: ['capital-and-loss-limits-not-selected'] };
  const parsed = policyDraft.safeParse(input);
  if (!parsed.success) return { status: 'invalid', reasons: ['invalid-limits-draft'] };
  const value = parsed.data, total = units(value.totalCapitalUsdt), reasons: string[] = [];
  const mexc = units(value.capitalByVenueUsdt.mexc), okx = units(value.capitalByVenueUsdt.okx);
  if (mexc + okx !== total) reasons.push('venue-capital-sum-mismatch');
  if (units(value.maxOrderDebitUsdt) > mexc || units(value.maxOrderDebitUsdt) > okx) reasons.push('order-debit-exceeds-venue-capital');
  if (units(value.maxCumulativeLossUsdt) > total) reasons.push('loss-limit-exceeds-capital');
  return { status: reasons.length ? 'invalid' : 'valid-draft', reasons };
}

/** Always blocked in this release; a passed rehearsal or selected draft is not live evidence. */
export function assessLiveLaunchPreparation(input: LiveOrderState, limitsDraft?: unknown) {
  const draft = validateLiveLimitsDraft(limitsDraft);
  const blockers = [
    ...draft.reasons,
    'exchange-order-transport-not-connected',
    'live-policy-not-bound-to-durable-admission',
    'exchange-execution-and-cash-contracts-unconfirmed',
    'nonzero-live-cash-reconciliation-not-accepted',
    'strategy-after-costs-not-qualified',
    'operator-activation-path-not-implemented',
  ];
  let state: LiveOrderState | null = null;
  try {
    if (!input || input.schema !== 1 || input.kind !== 'live-order-rehearsal' || input.nonExecutable !== true ||
        input.source !== 'local-rehearsal' || input.captureProvenanceVerified !== false ||
        !Array.isArray(input.events) || input.events.length > 2000) throw new Error();
    // Do not trust a caller's edited materialized orders/reserves.
    state = input.events.reduce((current, event) => applyLiveOrderEvent(current, event), createLiveOrderState());
  } catch { blockers.push('invalid-rehearsal-history'); }
  if (state?.orders.length) blockers.push('local-rehearsal-is-not-live-execution-evidence');
  return {
    schema: 1 as const, kind: 'live-launch-preparation' as const,
    executable: false as const, readyToStart: false as const,
    limits: draft, limitsEnforced: false as const,
    earnFundsIncluded: false as const,
    liveAccountingVerified: false as const,
    blockers, rehearsalOrderCount: state?.orders.length ?? null,
    recovery: state ? planLiveOrderRecovery(state) : null,
  };
}
