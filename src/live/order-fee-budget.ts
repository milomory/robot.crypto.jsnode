/** Pure declared fee arithmetic. A claimed account observation does not authenticate its provenance. */
import { z } from 'zod';
import { applyLiveOrderEvent, createLiveOrderState, type LiveOrderFunds, type LiveOrderIntent } from './order-lifecycle.js';

const SCALE = 10n ** 18n;
export const ORDER_FEE_EVIDENCE_MAX_AGE_MS = 60_000;
const MAX_INPUT_BYTES = 16 * 1024;
const amount = z.string().regex(/^(0|[1-9][0-9]{0,19})(?:\.[0-9]{1,18})?$/).transform(normalize);
const rate = amount.refine(value => units(value) <= SCALE);
const timestamp = z.number().int().positive().safe().max(8_640_000_000_000_000);
const bindingSchema = z.object({ bundleVersion: z.string().uuid(), pinHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const feeSchema = z.object({ schema: z.literal(1), kind: z.literal('declared-order-fee-evidence'),
  source: z.enum(['declared-synthetic', 'account-observation']), venue: z.enum(['mexc', 'okx']),
  account: z.literal('main'), symbol: z.literal('BTC/USDT'), ...bindingSchema.shape,
  observedAt: timestamp, expiresAt: timestamp, makerRate: rate, takerRate: rate,
  feeAsset: z.enum(['BTC', 'USDT', 'MX']), provenanceVerified: z.literal(false) }).strict();
const inputSchema = z.object({ intent: z.unknown(), feeEvidence: feeSchema, binding: bindingSchema,
  checkedAt: timestamp, previousCheckedAt: timestamp.optional() }).strict();
export type OrderFeeEvidence = z.infer<typeof feeSchema>;
export interface OrderFeeBudgetInput {
  intent: LiveOrderIntent;
  feeEvidence: OrderFeeEvidence;
  binding: z.infer<typeof bindingSchema>;
  checkedAt: number;
  previousCheckedAt?: number;
}
export type OrderFeeBudgetReason = 'invalid-fee-budget-input' | 'invalid-fee-intent' | 'fee-scope-mismatch' |
  'fee-binding-mismatch' | 'fee-evidence-window-invalid' | 'fee-clock-regression' | 'fee-evidence-stale' |
  'mx-fee-valuation-unproven' | 'sell-quote-fee-bound-unproven' | 'fee-cap-insufficient';
export interface OrderFeeBudgetAssessment {
  readonly schema: 1;
  readonly kind: 'order-fee-budget-assessment';
  readonly calculationPassed: boolean;
  readonly feeCapsSufficient: boolean;
  readonly evidenceDeclared: true;
  readonly feeProvenanceVerified: false;
  readonly feeCurrencyVerified: false;
  readonly liveAllowed: false;
  readonly executable: false;
  readonly reasons: readonly OrderFeeBudgetReason[];
  readonly diagnostics: Readonly<{
    /** An ordinary limit order can execute as maker or taker. */
    rateBasis: 'maximum-declared-maker-taker';
    worstRate: string;
    feeAsset: 'BTC' | 'USDT' | 'MX';
    rounding: 'ceil-to-18-decimals-model-only';
    /** Null means a native fee bound could not be established; it does not mean zero. */
    requiredFees: LiveOrderFunds | null;
    feeCapShortfall: LiveOrderFunds | null;
    /** Matches lifecycle reservation: full supplied caps plus the principal, never only the estimate. */
    requiredNativeReserve: LiveOrderFunds;
  }> | null;
}
function normalize(value: string): string {
  const [whole, fraction = ''] = value.split('.'), tail = fraction.replace(/0+$/, '');
  return tail ? `${whole}.${tail}` : whole;
}
function units(value: string): bigint {
  const [whole, fraction = ''] = value.split('.'); return BigInt(whole) * SCALE + BigInt(fraction.padEnd(18, '0'));
}
function display(value: bigint): string {
  const tail = (value % SCALE).toString().padStart(18, '0').replace(/0+$/, '');
  return `${value / SCALE}${tail ? '.' + tail : ''}`;
}
function ceilProduct(a: bigint, b: bigint): bigint { return (a * b + SCALE - 1n) / SCALE; }
function zero(): LiveOrderFunds { return { BTC: '0', USDT: '0', MX: '0' }; }
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function result(reasons: OrderFeeBudgetReason[], diagnostics: OrderFeeBudgetAssessment['diagnostics'] = null): OrderFeeBudgetAssessment {
  const unique = [...new Set(reasons)], passed = unique.length === 0;
  return freeze({ schema: 1, kind: 'order-fee-budget-assessment', calculationPassed: passed,
    feeCapsSufficient: passed, evidenceDeclared: true, feeProvenanceVerified: false, feeCurrencyVerified: false,
    liveAllowed: false, executable: false, reasons: unique, diagnostics });
}
/**
 * The binding and source fields are declarations, not authority. Only a future trusted fee collector
 * can verify them. No defaults, price conversion, fee discounts, external I/O, or account admission.
 */
export function assessOrderFeeBudget(value: unknown): OrderFeeBudgetAssessment {
  let input: z.infer<typeof inputSchema>;
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > MAX_INPUT_BYTES) return result(['invalid-fee-budget-input']);
    input = inputSchema.parse(value);
  } catch { return result(['invalid-fee-budget-input']); }
  let intent: LiveOrderIntent;
  try {
    // Reuse lifecycle validation, including positive quantities, the buy notional cap and OKX's MX exclusion.
    const state = applyLiveOrderEvent(createLiveOrderState(), { eventId: '00000000-0000-4000-8000-000000000001',
      at: '2000-01-01T00:00:00.000Z', type: 'intent-created', intent: input.intent });
    intent = state.orders[0].intent;
  } catch { return result(['invalid-fee-intent']); }
  const fee = input.feeEvidence, reasons: OrderFeeBudgetReason[] = [];
  if (fee.venue !== intent.venue || fee.account !== intent.account || fee.symbol !== intent.symbol) reasons.push('fee-scope-mismatch');
  if (fee.bundleVersion !== input.binding.bundleVersion || fee.pinHash !== input.binding.pinHash) reasons.push('fee-binding-mismatch');
  if (fee.expiresAt <= fee.observedAt || fee.expiresAt - fee.observedAt > ORDER_FEE_EVIDENCE_MAX_AGE_MS) reasons.push('fee-evidence-window-invalid');
  if (input.checkedAt < fee.observedAt || (input.previousCheckedAt !== undefined && input.checkedAt < input.previousCheckedAt)) reasons.push('fee-clock-regression');
  if (input.checkedAt > fee.expiresAt || input.checkedAt - fee.observedAt > ORDER_FEE_EVIDENCE_MAX_AGE_MS) reasons.push('fee-evidence-stale');
  const maker = units(fee.makerRate), taker = units(fee.takerRate), worst = maker > taker ? maker : taker;
  const requiredNativeReserve: LiveOrderFunds = {
    BTC: display(units(intent.feeCaps.BTC) + (intent.side === 'sell' ? units(intent.baseQuantity) : 0n)),
    USDT: display(units(intent.feeCaps.USDT) + (intent.side === 'buy' ? units(intent.maxQuoteAmount) : 0n)), MX: intent.feeCaps.MX,
  };
  let requiredFees: LiveOrderFunds | null = zero(), feeCapShortfall: LiveOrderFunds | null = zero();
  if (fee.feeAsset === 'MX' || units(intent.feeCaps.MX) > 0n) {
    reasons.push('mx-fee-valuation-unproven'); requiredFees = null; feeCapShortfall = null;
  } else if (fee.feeAsset === 'USDT' && intent.side === 'sell' && worst > 0n) {
    // A sell limit supplies a minimum execution price; maxQuoteAmount is not a cap on sale proceeds.
    reasons.push('sell-quote-fee-bound-unproven'); requiredFees = null; feeCapShortfall = null;
  } else {
    const basis = fee.feeAsset === 'BTC' ? units(intent.baseQuantity) : units(intent.maxQuoteAmount);
    const feeUnits = ceilProduct(basis, worst), cap = units(intent.feeCaps[fee.feeAsset]);
    requiredFees[fee.feeAsset] = display(feeUnits);
    feeCapShortfall[fee.feeAsset] = display(feeUnits > cap ? feeUnits - cap : 0n);
    if (feeUnits > cap) reasons.push('fee-cap-insufficient');
  }
  return result(reasons, { rateBasis: 'maximum-declared-maker-taker', worstRate: display(worst), feeAsset: fee.feeAsset,
    rounding: 'ceil-to-18-decimals-model-only', requiredFees, feeCapShortfall, requiredNativeReserve });
}
