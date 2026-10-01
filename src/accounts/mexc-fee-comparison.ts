/** Pure cost sensitivity for MEXC Spot. No credentials, I/O, settings change or execution authority. */
import { z } from 'zod';

const SCALE = 10n ** 18n;
const amount = z.string().regex(/^(0|[1-9][0-9]{0,19})(?:\.[0-9]{1,18})?$/);
// Zod refinements also run when an earlier regex check marked the value dirty.
// Gate decimal conversion again so invalid input cannot escape as a BigInt error
// containing the original string (which a caller may have supplied by mistake).
const positive = amount.refine(value => amount.safeParse(value).success && units(value) > 0n);
const rate = amount.refine(value => amount.safeParse(value).success && units(value) <= SCALE);
const rateModel = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('undiscounted-with-hypothetical-discount'),
    undiscountedRate: rate, discountFraction: rate }).strict(),
  z.object({ kind: z.literal('observed-effective-rates'), withoutMxRate: rate, withMxRate: rate }).strict()
]);
const inputSchema = z.object({
  schema: z.literal(1), venue: z.literal('mexc'), account: z.literal('main'),
  symbol: z.enum(['BTC/USDT', 'ETH/USDT', 'SOL/USDT']), liquidityRole: z.enum(['maker', 'taker']),
  rates: rateModel, applicability: z.enum(['verified', 'unverified']),
  // Sum of executed MEXC notional for one explicitly selected scenario/period.
  turnoverBasis: z.literal('declared-scenario-executed-mexc-notional'),
  overheadAllocation: z.literal('entire-declared-scenario'),
  turnoverUsdt: amount, mxPriceUsdt: positive, availableMx: amount,
  // Incremental spread/commissions/other expense for this whole scenario; NOT MX purchase principal.
  acquisitionOverheadUsdt: amount
}).strict();
export type MexcFeeComparisonInput = z.infer<typeof inputSchema>;
export class MexcFeeComparisonError extends Error {
  readonly code = 'invalid-mexc-fee-comparison';
  constructor() { super('invalid-mexc-fee-comparison'); this.name = 'MexcFeeComparisonError'; }
}

// Existing public paper-v2 helpers use eight decimal places. Keep this isolated
// 18-place model consistent with pair/live amounts, without refactoring those ledgers.
function units(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(18, '0'));
}
function display(value: bigint, places = 18): string {
  const divisor = 10n ** BigInt(places), absolute = value < 0n ? -value : value;
  const fraction = (absolute % divisor).toString().padStart(places, '0').replace(/0+$/, '');
  return `${value < 0n ? '-' : ''}${absolute / divisor}${fraction ? '.' + fraction : ''}`;
}
function ceil(numerator: bigint, denominator: bigint): bigint { return (numerator + denominator - 1n) / denominator; }
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

/**
 * `verified` is a caller declaration, never promoted to authenticated evidence.
 * Both effective rates must describe the same symbol, role and comparable fee basis.
 * No inference is made from the MX toggle alone. The quote price is a declared
 * valuation, not an exchange MX conversion rule or a confirmed acquisition quote.
 */
export function compareMexcFeePayment(input: unknown) {
  const checked = inputSchema.safeParse(input);
  if (!checked.success) throw new MexcFeeComparisonError();
  const value = checked.data, turnover = units(value.turnoverUsdt), price = units(value.mxPriceUsdt);
  const baseline = units(value.rates.kind === 'observed-effective-rates'
    ? value.rates.withoutMxRate : value.rates.undiscountedRate);
  // Denominator SCALE² preserves all discount-product digits; no second discount
  // can enter the observed-effective-rates branch, even as an unknown extra key.
  const candidate = value.rates.kind === 'observed-effective-rates'
    ? units(value.rates.withMxRate) * SCALE
    : baseline * (SCALE - units(value.rates.discountFraction));
  const before = turnover * baseline / SCALE;
  const discounted = ceil(turnover * candidate, SCALE * SCALE);
  const requiredMx = ceil(discounted * SCALE, price);
  const available = units(value.availableMx), shortfall = requiredMx > available ? requiredMx - available : 0n;
  const consumedValue = ceil(requiredMx * price, SCALE);
  const principal = ceil(shortfall * price, SCALE), overhead = units(value.acquisitionOverheadUsdt);
  const grossSaving = before - consumedValue, netSaving = grossSaving - overhead;
  const reasons: string[] = [];
  if (value.applicability === 'unverified') reasons.push('api-discount-applicability-unverified');
  if (value.rates.kind === 'undiscounted-with-hypothetical-discount') reasons.push('discount-rate-assumed');
  if (shortfall > 0n) reasons.push('additional-mx-required-in-model');
  if (netSaving <= 0n) reasons.push('no-positive-net-saving-in-model');
  return freeze({
    schema: 1 as const, kind: 'mexc-fee-payment-comparison' as const,
    venue: value.venue, account: value.account, symbol: value.symbol, liquidityRole: value.liquidityRole,
    hypothetical: true as const, advisoryOnly: true as const, readyToEnable: false as const,
    activationReady: false as const, liveAllowed: false as const,
    savingStatus: 'conditional-model-estimate' as const,
    turnoverBasis: value.turnoverBasis, overheadAllocation: value.overheadAllocation,
    executable: false as const, applicabilityEvidenceVerified: false as const,
    applicabilityDeclared: value.applicability, rateBasis: value.rates.kind,
    turnoverUsdt: display(turnover), withoutMxRate: display(baseline), withMxRate: display(candidate, 36),
    withoutMxFeeUsdt: display(before), withMxFeeEquivalentUsdt: display(discounted),
    requiredMx: display(requiredMx), availableMx: display(available), missingMx: display(shortfall),
    mxPriceUsdt: display(price), consumedMxValueUsdt: display(consumedValue),
    mxAcquisitionPrincipalUsdt: display(principal), acquisitionOverheadUsdt: display(overhead),
    upfrontAcquisitionUsdt: display(principal + overhead),
    grossSavingUsdt: display(grossSaving), netSavingUsdt: display(netSaving),
    positiveNetSavingInModel: netSaving > 0n, coveredByDeclaredMx: shortfall === 0n,
    rounding: 'baseline-down-costs-and-mx-up-at-18-decimals' as const,
    reasons,
    limitations: [
      'caller-inputs-not-authenticated-or-freshness-checked',
      'mx-conversion-price-and-exchange-rounding-unconfirmed',
      'mx-price-risk-and-opportunity-cost-not-modeled',
      'maker-execution-and-second-venue-costs-not-modeled',
      'purchase-principal-is-funding-not-an-extra-expense',
      'not-a-live-admission-or-setting-change'
    ] as const
  });
}
