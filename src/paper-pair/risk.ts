/** Synthetic admission checks only. No order transport, live policy or automatic reset. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonical } from '../paper-v2/ledger.js';
import { applySettlementEvent, createSettlementState, SettlementError, viewSettlementState } from './settlement.js';
import type { SettlementBalances, SettlementEvent, SettlementFunds, SettlementState } from './settlement.js';

const decimal = z.string().regex(/^(0|[1-9][0-9]{0,19})(?:\.[0-9]{1,18})?$/);
const positive = decimal.refine(value => /[1-9]/.test(value));
const funds = z.object({ BTC: decimal, USDT: decimal, MX: decimal }).strict();
export const paperRiskPolicySchema = z.object({
  schema: z.literal(1), kind: z.literal('synthetic-pair-risk-policy'),
  policyId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  maxBuyDebitUsdt: positive, maxSingleLegBtc: positive, maxSessionCashLossUsdt: positive,
  maxSessionFees: funds,
  minFreeAfterReserve: z.object({ mexc: funds, okx: funds }).strict()
}).strict();
export type PaperRiskPolicy = z.infer<typeof paperRiskPolicySchema>;
export interface PaperRiskState { readonly policy: PaperRiskPolicy; readonly settlement: SettlementState }
const ASSETS = ['BTC', 'USDT', 'MX'] as const;
const VENUES = ['mexc', 'okx'] as const;
const SCALE = 10n ** 18n;
// All inputs are validated policy decimals or values emitted by the exact ledger.
function amount(value: string): bigint {
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const result = BigInt(whole) * SCALE + BigInt(fraction.padEnd(18, '0'));
  return negative ? -result : result;
}
function text(value: bigint): string {
  const absolute = value < 0n ? -value : value;
  const fraction = (absolute % SCALE).toString().padStart(18, '0').replace(/0+$/, '');
  return `${value < 0n ? '-' : ''}${absolute / SCALE}${fraction ? '.' + fraction : ''}`;
}
export class PaperRiskError extends Error {
  constructor(readonly reasons: string[]) { super(reasons.join(',')); this.name = 'PaperRiskError'; }
}
function frozenPolicy(input: PaperRiskPolicy): PaperRiskPolicy {
  const parsed = paperRiskPolicySchema.safeParse(input);
  if (!parsed.success) throw new PaperRiskError(['invalid-risk-policy']);
  const policy = parsed.data;
  Object.freeze(policy.maxSessionFees);
  Object.freeze(policy.minFreeAfterReserve.mexc); Object.freeze(policy.minFreeAfterReserve.okx);
  Object.freeze(policy.minFreeAfterReserve);
  return Object.freeze(policy);
}
export function createPaperRiskState(initialBalances: SettlementBalances, policy: PaperRiskPolicy): PaperRiskState {
  return { policy: frozenPolicy(policy), settlement: createSettlementState(initialBalances) };
}
function sessionUsage(state: SettlementState) {
  const view = viewSettlementState(state);
  let cashLoss = 0n;
  const fees = { BTC: 0n, USDT: 0n, MX: 0n };
  for (const position of view.positions) {
    const delta = amount(position.cashDeltaUsdt);
    if (position.settlement === 'balanced' && delta < 0n) cashLoss -= delta;
    for (const asset of ASSETS) fees[asset] += amount(position.feesByAsset[asset]);
  }
  return { closedCashLossUsdt: text(cashLoss), fees: {
    BTC: text(fees.BTC), USDT: text(fees.USDT), MX: text(fees.MX)
  } };
}
export interface PaperRiskDecision {
  schema: 1; kind: 'paper-pair-risk-decision'; executable: false; funding: 'synthetic';
  paperAllowed: boolean; duplicate: boolean; reasons: string[];
  metrics: null | {
    buyDebitUsdt: string; maxSingleLegBtc: string | null;
    sessionCashLossUsdt: string; sessionCashLossWithBuyDebitUsdt: string;
    sessionFees: SettlementFunds; sessionFeesWithCaps: SettlementFunds;
  };
  projectedAvailable: SettlementBalances | null;
}
/** A diagnostic about the supplied trusted state, never a durable/live authorization. */
export function assessPaperPairRisk(state: PaperRiskState, input: SettlementEvent): PaperRiskDecision {
  const decision: PaperRiskDecision = { schema: 1, kind: 'paper-pair-risk-decision', executable: false,
    funding: 'synthetic', paperAllowed: false, duplicate: false, reasons: [], metrics: null, projectedAvailable: null };
  if (input?.type !== 'prepare') return { ...decision, reasons: ['prepare-required'] };
  let next: SettlementState;
  try { next = applySettlementEvent(state.settlement, input); }
  catch (error) {
    return { ...decision, reasons: [error instanceof SettlementError ? 'settlement:' + error.reason : 'invalid-settlement-state'] };
  }
  decision.projectedAvailable = viewSettlementState(next).available;
  if (next === state.settlement) return { ...decision, paperAllowed: true, duplicate: true };
  const plan = next.positions.at(-1)!; // Validated and cloned by the settlement engine.
  const policy = state.policy, usage = sessionUsage(state.settlement);
  const buyDebit = amount(plan.buy.sizing.kind === 'base' ? plan.buy.sizing.maxQuoteAmount : plan.buy.sizing.quoteAmount)
    + amount(plan.buy.feeCaps.USDT);
  const sellDebitBtc = amount(plan.sell.baseQuantity) + amount(plan.sell.feeCaps.BTC);
  const buyBase = plan.buy.sizing.kind === 'base' ? amount(plan.buy.sizing.baseQuantity) : null;
  const exposure = buyBase === null ? null : (buyBase > sellDebitBtc ? buyBase : sellDebitBtc);
  const lossWithDebit = amount(usage.closedCashLossUsdt) + buyDebit;
  const feesWithCaps = { BTC: '0', USDT: '0', MX: '0' };
  for (const asset of ASSETS) {
    feesWithCaps[asset] = text(amount(usage.fees[asset]) + amount(plan.buy.feeCaps[asset]) + amount(plan.sell.feeCaps[asset]));
  }
  decision.metrics = { buyDebitUsdt: text(buyDebit), maxSingleLegBtc: exposure === null ? null : text(exposure),
    sessionCashLossUsdt: usage.closedCashLossUsdt, sessionCashLossWithBuyDebitUsdt: text(lossWithDebit),
    sessionFees: usage.fees, sessionFeesWithCaps: feesWithCaps };
  if (exposure === null) decision.reasons.push('quote-budget-unbounded-base-exposure');
  if (buyDebit > amount(policy.maxBuyDebitUsdt)) decision.reasons.push('buy-debit-limit');
  if (exposure !== null && exposure > amount(policy.maxSingleLegBtc)) decision.reasons.push('single-leg-exposure-limit');
  // Reserve the entire new BUY debit against the cash-loss allowance. No expected
  // SELL proceeds or unrealized marks replenish it. This is not a total P/L bound.
  if (lossWithDebit > amount(policy.maxSessionCashLossUsdt)) decision.reasons.push('session-cash-loss-limit');
  for (const asset of ASSETS) if (amount(feesWithCaps[asset]) > amount(policy.maxSessionFees[asset])) {
    decision.reasons.push('session-fee-limit:' + asset);
  }
  for (const venue of VENUES) for (const asset of ASSETS) {
    if (amount(decision.projectedAvailable[venue][asset]) < amount(policy.minFreeAfterReserve[venue][asset])) {
      decision.reasons.push(`wallet-floor:${venue}:${asset}`);
    }
  }
  decision.paperAllowed = decision.reasons.length === 0;
  return decision;
}
/** Risk gates only new preparations. Already observed fills/outcomes must still be recorded. */
export function applyPaperRiskEvent(state: PaperRiskState, event: SettlementEvent): PaperRiskState {
  if (event?.type === 'prepare') {
    const decision = assessPaperPairRisk(state, event);
    if (!decision.paperAllowed) throw new PaperRiskError(decision.reasons);
    if (decision.duplicate) return state;
  }
  const next = applySettlementEvent(state.settlement, event);
  return next === state.settlement ? state : { policy: state.policy, settlement: next };
}
/** Replay the entire session under one policy; no day boundary or profit resets. */
export function replayPaperRiskJournal(initialBalances: SettlementBalances, policy: PaperRiskPolicy,
  events: readonly SettlementEvent[]): PaperRiskState {
  if (!Array.isArray(events) || events.length > 2000) throw new PaperRiskError(['risk-journal-limit']);
  return events.reduce((state, event) => applyPaperRiskEvent(state, event), createPaperRiskState(initialBalances, policy));
}
export function viewPaperRiskState(state: PaperRiskState) {
  return { schema: 1, kind: 'synthetic-pair-risk-state', executable: false, funding: 'synthetic',
    policy: state.policy, policyHash: createHash('sha256').update(canonical(state.policy)).digest('hex'),
    sessionScope: 'whole-supplied-journal-no-automatic-reset',
    lossMetric: 'sum-negative-closed-balanced-cash-deltas-usdt-not-total-pnl',
    sessionUsage: sessionUsage(state.settlement), settlement: viewSettlementState(state.settlement) };
}
