/**
 * Offline, explicitly priced four-execution hedge arithmetic. This is neither a
 * funding forecast nor an admission/position/margin model. Every leg buys/sells
 * the SAME base quantity; the caller must supply independent exit books and all
 * costs (explicit "0" is allowed, null is unknown). No basis convergence is
 * inferred from an entry spread. Book identities/freshness and account tariffs
 * are not verified here.
 *
 * Rounding contract (30 decimal places, integer arithmetic throughout):
 * - sum exact price * filled-base products before rounding each whole leg;
 * - round BUY quote outflows up, SELL quote inflows down;
 * - round fees up from the UNROUNDED walked quote, independently of cash rounding;
 * - report slippage as walked quote minus the same-direction rounded top-price
 *   quote (reversed for SELL). It is already in quote and is NOT deducted again;
 * - explicit signed funding and nonnegative extra quote costs are exact;
 * - floor signed net bps, using long-entry quote as one-leg notional denominator.
 * This bps denominator is not committed capital, margin or portfolio ROI. Exact
 * inputs follow exact-json's <=30 whole/fraction digits; derived whole-number
 * outputs may be wider because a product of two valid inputs can be wider.
 */
import { decimal, units } from './exact-json.js';
import { freeze, reject } from './model.js';

const SCALE = 10n ** 30n;
const BPS = 10_000n;
const MAX_LEVELS = 50;
export const JOINT_SCENARIO_LEGS = ['longEntry', 'shortEntry', 'longExit', 'shortExit'] as const;
export type JointScenarioLegName = typeof JOINT_SCENARIO_LEGS[number];
export type JointScenarioSide = 'BUY' | 'SELL';
export interface JointScenarioLevel { price: string; quantityBase: string }
export interface JointScenarioLegInput {
  /** BUY asks ascending, SELL bids descending. Null means unavailable. */
  levels: readonly JointScenarioLevel[] | null;
  /** Nonnegative caller-declared bps, not an account-verified tariff. */
  feeBps: string | null;
}
export interface JointCostScenarioInput {
  quantityBase: string;
  longEntry: JointScenarioLegInput | null;
  shortEntry: JointScenarioLegInput | null;
  longExit: JointScenarioLegInput | null;
  shortExit: JointScenarioLegInput | null;
  /** Signed total funding over the specified scenario; no inferred rate income. */
  fundingQuote: string | null;
  borrowQuote: string | null;
  rebalanceQuote: string | null;
  safetyQuote: string | null;
}
export type JointScenarioReason =
  | `${JointScenarioLegName}:book-missing`
  | `${JointScenarioLegName}:fee-missing`
  | `${JointScenarioLegName}:insufficient-depth`
  | 'fundingQuote:missing' | 'borrowQuote:missing' | 'rebalanceQuote:missing' | 'safetyQuote:missing';
export interface JointScenarioLegResult {
  side: JointScenarioSide;
  quantityBase: string;
  filledQuantityBase: string;
  unfilledQuantityBase: string;
  depthComplete: boolean;
  levelsUsed: number;
  /** Full requested-quantity notional; null on missing/insufficient book depth. */
  quote: string | null;
  topOfBookQuote: string | null;
  slippageQuote: string | null;
  feeBps: string | null;
  feeQuote: string | null;
}
export interface JointCostScenarioResult {
  schema: 1;
  kind: 'offline-four-leg-cost-scenario';
  status: 'complete' | 'blocked';
  quantityBase: string;
  legs: Record<JointScenarioLegName, JointScenarioLegResult>;
  fundingQuote: string | null;
  borrowQuote: string | null;
  rebalanceQuote: string | null;
  safetyQuote: string | null;
  totalFeesQuote: string | null;
  /** Four walked quotes before fees/funding/extra costs, never entry spread alone. */
  grossPricePnl: string | null;
  netQuote: string | null;
  netEdgeBps: string | null;
  netEdgeDenominator: 'long-entry-quote';
  netEdgeDenominatorQuote: string | null;
  reasons: JointScenarioReason[];
  rounding: '30dp-buy-ceil-sell-floor-fees-ceil-net-bps-floor';
  scenarioOnly: true;
  accountFeesVerified: false;
  bookFreshnessVerified: false;
  marketIdentityVerified: false;
  executable: false;
}

function shape(value: unknown, keys: readonly string[], code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) return reject(code);
  return value as Record<string, unknown>;
}
function amount(value: unknown, signed = false, positive = false): string {
  // Refuse native Number even when integral: arithmetic must never inherit a
  // rounded numeric JSON value from a caller. Exponent strings stay exact.
  if (typeof value !== 'string' || value.length > 80) return reject('invalid-joint-scenario-number');
  try { return decimal(value, signed, positive); }
  catch { return reject('invalid-joint-scenario-number'); }
}
function text(value: bigint): string {
  const negative = value < 0n, magnitude = negative ? -value : value;
  const fraction = (magnitude % SCALE).toString().padStart(30, '0').replace(/0+$/, '');
  return (negative ? '-' : '') + String(magnitude / SCALE) + (fraction ? '.' + fraction : '');
}
function floor(numerator: bigint, denominator: bigint): bigint {
  const truncated = numerator / denominator;
  return numerator < 0n && numerator % denominator !== 0n ? truncated - 1n : truncated;
}
const ceilNonnegative = (numerator: bigint, denominator: bigint) => (numerator + denominator - 1n) / denominator;
const sideOf = (name: JointScenarioLegName): JointScenarioSide => name === 'longEntry' || name === 'shortExit' ? 'BUY' : 'SELL';

function leg(
  input: JointScenarioLegInput | null, name: JointScenarioLegName,
  quantity: bigint, quantityBase: string, reasons: JointScenarioReason[],
): JointScenarioLegResult {
  if (input !== null) shape(input, ['levels', 'feeBps'], 'invalid-joint-scenario-leg');
  const side = sideOf(name);
  const feeBps = input === null || input.feeBps === null ? null : amount(input.feeBps);
  if (feeBps !== null && units(feeBps) > BPS * SCALE) return reject('invalid-joint-scenario-fee');
  if (feeBps === null) reasons.push(`${name}:fee-missing`);
  const result: JointScenarioLegResult = { side, quantityBase, filledQuantityBase: '0', unfilledQuantityBase: quantityBase,
    depthComplete: false, levelsUsed: 0, quote: null, topOfBookQuote: null, slippageQuote: null, feeBps, feeQuote: null };
  const levels = input === null ? null : input.levels;
  if (levels === null) { reasons.push(`${name}:book-missing`); return result; }
  if (!Array.isArray(levels) || levels.length > MAX_LEVELS) return reject('invalid-joint-scenario-book');
  let previous: bigint | null = null;
  // Validate EVERY row, including levels beyond the requested fill. Never sort,
  // merge duplicates, truncate or silently accept a malformed unused tail.
  const parsed = Array.from(levels, row => {
    shape(row, ['price', 'quantityBase'], 'invalid-joint-scenario-book');
    const price = units(amount(row.price, false, true));
    const available = units(amount(row.quantityBase, false, true));
    if (previous !== null && (side === 'BUY' ? price <= previous : price >= previous)) return reject('invalid-joint-scenario-book');
    previous = price;
    return { price, available };
  });
  let remaining = quantity, products = 0n;
  for (const row of parsed) {
    if (remaining === 0n) break;
    const fill = remaining < row.available ? remaining : row.available;
    products += row.price * fill;
    remaining -= fill;
    result.levelsUsed++;
  }
  result.filledQuantityBase = text(quantity - remaining);
  result.unfilledQuantityBase = text(remaining);
  if (remaining !== 0n) { reasons.push(`${name}:insufficient-depth`); return result; }
  const roundedQuote = (numerator: bigint) => side === 'BUY' ? ceilNonnegative(numerator, SCALE) : numerator / SCALE;
  const quote = roundedQuote(products), topQuote = roundedQuote(parsed[0].price * quantity);
  result.depthComplete = true;
  result.quote = text(quote);
  result.topOfBookQuote = text(topQuote);
  result.slippageQuote = text(side === 'BUY' ? quote - topQuote : topQuote - quote);
  if (feeBps !== null) result.feeQuote = text(ceilNonnegative(products * units(feeBps), SCALE * SCALE * BPS));
  return result;
}

/** Pure and deterministic. Missing evidence blocks net; malformed evidence throws. */
export function calculateJointCostScenario(input: JointCostScenarioInput): JointCostScenarioResult {
  shape(input, ['quantityBase', ...JOINT_SCENARIO_LEGS, 'fundingQuote', 'borrowQuote', 'rebalanceQuote', 'safetyQuote'],
    'invalid-joint-cost-scenario');
  const quantityBase = amount(input.quantityBase, false, true), quantity = units(quantityBase);
  const reasons: JointScenarioReason[] = [];
  const legs = Object.fromEntries(JOINT_SCENARIO_LEGS.map(name => [name, leg(input[name], name, quantity, quantityBase, reasons)])) as
    Record<JointScenarioLegName, JointScenarioLegResult>;
  const extras = {} as Pick<JointCostScenarioResult, 'fundingQuote' | 'borrowQuote' | 'rebalanceQuote' | 'safetyQuote'>;
  for (const name of ['fundingQuote', 'borrowQuote', 'rebalanceQuote', 'safetyQuote'] as const) {
    extras[name] = input[name] === null ? null : amount(input[name], name === 'fundingQuote');
    if (extras[name] === null) reasons.push(`${name}:missing`);
  }
  const fullDepth = JOINT_SCENARIO_LEGS.every(name => legs[name].depthComplete);
  const grossPricePnl = fullDepth ? text(units(legs.longExit.quote!) + units(legs.shortEntry.quote!)
    - units(legs.longEntry.quote!) - units(legs.shortExit.quote!)) : null;
  const totalFeesQuote = JOINT_SCENARIO_LEGS.every(name => legs[name].feeQuote !== null)
    ? text(JOINT_SCENARIO_LEGS.reduce((sum, name) => sum + units(legs[name].feeQuote!), 0n)) : null;
  const complete = reasons.length === 0;
  const net = complete ? units(grossPricePnl!) + units(extras.fundingQuote!) - units(totalFeesQuote!)
    - units(extras.borrowQuote!) - units(extras.rebalanceQuote!) - units(extras.safetyQuote!) : null;
  return freeze({ schema: 1, kind: 'offline-four-leg-cost-scenario', status: complete ? 'complete' : 'blocked', quantityBase, legs,
    ...extras, totalFeesQuote, grossPricePnl, netQuote: net === null ? null : text(net),
    netEdgeBps: net === null ? null : text(floor(net * BPS * SCALE, units(legs.longEntry.quote!))),
    netEdgeDenominator: 'long-entry-quote', netEdgeDenominatorQuote: legs.longEntry.quote, reasons,
    rounding: '30dp-buy-ceil-sell-floor-fees-ceil-net-bps-floor', scenarioOnly: true, accountFeesVerified: false,
    bookFreshnessVerified: false, marketIdentityVerified: false, executable: false });
}
