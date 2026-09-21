import { scenarioSchema, type Scenario, type Step } from './schema.js';
import { canonical, digest, PaperAccount, type Valuation } from './ledger.js';
import { formatAmount, parseAmount, PaperError } from './exact.js';

// Internal formatted results can exceed the per-input decimal bound after multiplication.
const signed = (text: string) => {
  if (!/^-?\d+\.\d{8}$/.test(text)) throw new PaperError('invalid-internal-amount');
  return BigInt(text.replace('.', ''));
};
// Percentages are displayed to six decimals by integer truncation; money stays exact.
function percent(numerator: bigint, denominator: bigint): string | null {
  if (denominator <= 0n) return null;
  const value = numerator * 100_000_000n / denominator;
  const abs = value < 0n ? -value : value;
  return `${value < 0n ? '-' : ''}${abs / 1_000_000n}.${String(abs % 1_000_000n).padStart(6, '0')}`;
}
interface Point { eventId: string | null; phase: 'opening' | 'after-event'; valuation: Valuation }
function performance(points: Point[]) {
  const available = points.filter((p): p is Point & { valuation: Extract<Valuation, { available: true }> } => p.valuation.available);
  const complete = available.length === points.length;
  if (!complete) return { complete: false as const, availablePoints: available.length, expectedPoints: points.length,
    startingEquityUSDT: points[0].valuation.available ? points[0].valuation.equityUSDT : null,
    finalEquityUSDT: points.at(-1)!.valuation.available ?
      (points.at(-1)!.valuation as Extract<Valuation, { available: true }>).equityUSDT : null,
    equityChangeUSDT: null, returnPercent: null, maxDrawdownUSDT: null, maxDrawdownPercent: null };
  const values = available.map(p => signed(p.valuation.equityUSDT));
  const opening = values[0], final = values.at(-1)!;
  let peak = opening, maxDrawdown = 0n, ratioNumerator = 0n, ratioDenominator = 1n;
  for (const value of values) {
    if (value > peak) peak = value;
    const dd = peak - value;
    if (dd > maxDrawdown) maxDrawdown = dd;
    if (peak > 0n && dd * ratioDenominator > ratioNumerator * peak) {
      ratioNumerator = dd; ratioDenominator = peak;
    }
  }
  return { complete: true as const, availablePoints: available.length, expectedPoints: points.length,
    startingEquityUSDT: formatAmount(opening), finalEquityUSDT: formatAmount(final),
    equityChangeUSDT: formatAmount(final - opening), returnPercent: percent(final - opening, opening),
    maxDrawdownUSDT: formatAmount(maxDrawdown),
    maxDrawdownPercent: opening === 0n ? null : percent(ratioNumerator, ratioDenominator) };
}

function runPath(scenario: Scenario, steps: Step[], mode: 'scenario' | 'hold-opening' | 'buy-and-hold') {
  const { venue, symbol, opening: openingFunds, costs, instrument } = scenario;
  const account = new PaperAccount({ venue, symbol, opening: openingFunds, costs, instrument });
  const opening = account.value(steps[0].book, steps[0].at);
  const points: Point[] = [{ eventId: null, phase: 'opening', valuation: opening }];
  for (const [index, original] of steps.entries()) {
    const step: Step = mode === 'scenario' ? original : {
      id: original.id, at: original.at, ...(original.book ? { book: original.book } : {}),
      ...(mode === 'buy-and-hold' && index === 0 ? { intent: { side: 'buy' as const, quantity: scenario.benchmark.buyQuantityBTC } } : {})
    };
    const event = account.apply(step);
    const valuation = account.value(step.book, step.at);
    if (opening.available && valuation.available &&
        signed(valuation.equityUSDT) - signed(opening.equityUSDT) !==
        signed(event.account.realisedPnLUSDT) + signed(valuation.unrealisedPnLUSDT) - signed(opening.unrealisedPnLUSDT)) {
      throw new PaperError('equity-reconciliation-failed');
    }
    points.push({ eventId: step.id, phase: 'after-event', valuation });
  }
  const events = account.events();
  return { policy: mode, entryAccepted: mode === 'buy-and-hold' ? events[0].status === 'filled' : null,
    events, valuationSeries: points, finalAccount: account.snapshot(), performance: performance(points),
    counts: { filled: events.filter(e => e.status === 'filled').length,
      rejected: events.filter(e => e.status === 'rejected').length, marked: events.filter(e => e.status === 'marked').length } };
}

export function replayScenario(input: unknown) {
  const parsed = scenarioSchema.safeParse(input);
  if (!parsed.success) throw new PaperError('invalid-scenario');
  const scenario = parsed.data;
  const unique: Step[] = [];
  const seen = new Map<string, string>();
  for (const step of scenario.steps) {
    const signature = canonical(step), prior = seen.get(step.id);
    if (prior !== undefined) {
      if (prior !== signature) throw new PaperError('event-id-conflict');
      continue;
    }
    if (unique.length && step.at <= unique.at(-1)!.at) throw new PaperError('out-of-order-event');
    seen.set(step.id, signature); unique.push(step);
  }
  const strategy = runPath(scenario, unique, 'scenario');
  const baseline = runPath(scenario, unique, 'hold-opening');
  const buyAndHold = runPath(scenario, unique, 'buy-and-hold');
  const comparable = strategy.performance.complete && baseline.performance.complete &&
    buyAndHold.performance.complete && buyAndHold.entryAccepted === true;
  const inputHash = digest(scenario);
  return { schema: scenario.schema, model: 'paper-v2-exact-1' as const, scenarioId: scenario.scenarioId,
    runId: `pv2-${inputHash}`, ledgerSchema: 1 as const, costModel: 'quote-fee-exact-gross-v1' as const,
    ...(scenario.schema === 1 ? { synthetic: true as const } : { funding: scenario.funding, marketData: scenario.marketData,
      ...(scenario.executionPolicy ? { executionPolicy: scenario.executionPolicy } : {}) }), inputHash,
    units: { BTC: '8 decimal places', USDT: '8 decimal places', price: '8 decimal places',
      roundingFractions: 'fractions of one 0.00000001 USDT atom', percentDisplay: 'six decimals, truncated' },
    assumptions: { venue: scenario.venue, symbol: scenario.symbol, opening: scenario.opening, costs: scenario.costs,
      instrument: scenario.instrument, benchmarkBuyQuantityBTC: scenario.benchmark.buyQuantityBTC,
      costBasis: 'FIFO; partial cost allocation floors to quote atom and retains residual',
      valuation: 'full liquidation at valid bids after assumed exit costs; unavailable for stale or unfillable positions' },
    period: { from: unique[0].at, to: unique.at(-1)!.at, inputSteps: scenario.steps.length, uniqueSteps: unique.length },
    strategy, benchmarks: { baseline: { label: parseAmount(scenario.opening.BTC) === 0n ? 'cash' : 'hold-opening-assets', ...baseline }, buyAndHold },
    comparison: { comparable, sameStartingBalances: true, sameValuationSchedule: true,
      reason: comparable ? 'complete-common-window' : 'incomplete-valuation-or-benchmark-entry',
      interpretation: scenario.schema === 1
        ? 'Synthetic fixture results only; no strategy-performance or live execution claim.'
        : scenario.marketData.policy === 'fixed-study-30m-v1'
          ? 'Observed public prices with synthetic funding and a declared fixed comparison; not actual trades, statistical evidence or a profit forecast.'
          : 'Observed public prices with synthetic funding and fixed probe intents; not actual trades or strategy performance.' } };
}
