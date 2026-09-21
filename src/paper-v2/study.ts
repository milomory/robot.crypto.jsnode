import { scenarioSchema, type Scenario, type Step } from './schema.js';
import { canonical, PaperAccount, type LedgerEvent } from './ledger.js';
import { parseAmount, PaperError, validateBook } from './exact.js';
import { replayScenario } from './replay.js';

export const STUDY_POLICY = 'lagged-sma-3-6-v1' as const;
const QUANTITY = '0.001';
const QUANTITY_ATOMS = parseAmount(QUANTITY);
type Signal = 'warmup' | 'above-band' | 'below-band' | 'neutral';
export interface StudyDecision {
  executionSequence: number;
  executionId: string;
  observedThrough: number | null;
  observedThroughId: string | null;
  signal: Signal;
  // Each input is twice the midpoint in price atoms. Do not round odd sums.
  fastSumTwiceMidAtoms: string | null;
  slowSumTwiceMidAtoms: string | null;
  action: 'buy' | 'sell' | 'mark';
  quantityBTC: string | null;
  beforeBTC: string;
  afterBTC: string;
  status: LedgerEvent['status'];
  reason: string | null;
}

/**
 * Immutable policy, not a parameter optimiser. At execution i, observe only
 * i-6..i-1. Let p[j]=bid[j]+ask[j] in exact price atoms (twice midpoint),
 * F=sum(p[i-3..i-1]), S=sum(p[i-6..i-1]). The common midpoint factor cancels:
 * enter iff F*6*10000 > S*3*10010; exit iff F*6*10000 < S*3*9990.
 * Equality and the band retain the actual position. Signals never use book i.
 */
export function runStudy(input: unknown) {
  const parsed = scenarioSchema.safeParse(input);
  if (!parsed.success) throw new PaperError('invalid-study-scenario');
  const source = parsed.data;
  if (parseAmount(source.opening.USDT) !== parseAmount('1000') || parseAmount(source.opening.BTC) !== 0n ||
      parseAmount(source.opening.costBasisUSDT ?? '0') !== 0n ||
      parseAmount(source.benchmark.buyQuantityBTC) !== QUANTITY_ATOMS ||
      source.costs.feeBps !== 10 || source.costs.slippageBps !== 5 || source.costs.feeAsset !== 'USDT') {
    throw new PaperError('invalid-study-assumptions');
  }
  const declaredStudy = source.schema === 2 && source.marketData.policy === 'fixed-study-30m-v1';
  if (declaredStudy && source.steps.length !== 60) throw new PaperError('invalid-study-period');
  const seen = new Set<string>();
  const midpoints: bigint[] = [];
  // Reject the entire input rather than filter missing, stale, invalid or repeated
  // observations. Sequence and all valuation points are retained without gaps.
  for (const [index, step] of source.steps.entries()) {
    if (seen.has(step.id)) throw new PaperError('duplicate-study-event');
    if (index > 0 && step.at <= source.steps[index - 1].at) throw new PaperError('out-of-order-study-event');
    if (!step.book) throw new PaperError('missing-study-book');
    if (step.book.venue !== source.venue || step.book.symbol !== source.symbol) throw new PaperError('study-book-account-mismatch');
    if (source.instrument.fetchedAt > step.at || step.at - source.instrument.fetchedAt > 3_600_000) {
      throw new PaperError('stale-or-invalid-study-instrument-time');
    }
    if (index > 0 && step.book.requestedAt <= source.steps[index - 1].book!.receivedAt) {
      throw new PaperError('overlapping-study-observations');
    }
    const { bids, asks } = validateBook(step.book, step.at);
    midpoints.push(bids[0][0] + asks[0][0]);
    seen.add(step.id);
  }
  const { venue, symbol, opening, costs, instrument } = source;
  const account = new PaperAccount({ venue, symbol, opening, costs, instrument });
  const decisions: StudyDecision[] = [];
  const steps: Step[] = [];
  for (const [index, original] of source.steps.entries()) {
    const beforeBTC = account.snapshot().balances[venue].BTC;
    const balance = parseAmount(beforeBTC);
    if (balance !== 0n && balance !== QUANTITY_ATOMS) throw new PaperError('unexpected-study-position');
    let signal: Signal = 'warmup';
    let fast: bigint | null = null, slow: bigint | null = null;
    if (index >= 6) {
      fast = midpoints.slice(index - 3, index).reduce((sum, value) => sum + value, 0n);
      slow = midpoints.slice(index - 6, index).reduce((sum, value) => sum + value, 0n);
      const left = fast * 6n * 10_000n;
      signal = left > slow * 3n * 10_010n ? 'above-band' :
        left < slow * 3n * 9_990n ? 'below-band' : 'neutral';
    }
    const side = signal === 'above-band' && balance === 0n ? 'buy' :
      signal === 'below-band' && balance === QUANTITY_ATOMS ? 'sell' : undefined;
    // The caller's intents are never trusted or copied. Execution is at the next
    // full book and may reject; only the reconciled account controls later size.
    const step: Step = { id: original.id, at: original.at, book: original.book,
      ...(side ? { intent: { side, quantity: QUANTITY } } : {}) };
    const event = account.apply(step);
    steps.push(step);
    decisions.push({ executionSequence: index, executionId: step.id,
      observedThrough: index === 0 ? null : index - 1,
      observedThroughId: index === 0 ? null : source.steps[index - 1].id,
      signal, fastSumTwiceMidAtoms: fast === null ? null : String(fast),
      slowSumTwiceMidAtoms: slow === null ? null : String(slow), action: side ?? 'mark',
      quantityBTC: side ? QUANTITY : null, beforeBTC, afterBTC: event.account.balances[venue].BTC,
      status: event.status, reason: event.reason ?? null });
  }
  const scenario: Scenario = scenarioSchema.parse({ ...source, steps,
    ...(declaredStudy ? { executionPolicy: STUDY_POLICY } : {}) });
  // Independently replay every generated event and compare the complete journal,
  // not just final balances, before publishing any comparison.
  const result = replayScenario(scenario);
  if (canonical(account.events()) !== canonical(result.strategy.events) ||
      canonical(account.snapshot()) !== canonical(result.strategy.finalAccount)) {
    throw new PaperError('study-replay-reconciliation-failed');
  }
  return { schema: 1 as const, policy: STUDY_POLICY, funding: 'synthetic' as const,
    eligibility: { eligible: false,
      reason: declaredStudy ? 'unverified-declared-protocol' :
        source.schema === 1 ? 'synthetic-fixture-only' : 'legacy-probe-smoke-only' },
    assumptions: { fastWindow: 3, slowWindow: 6, hysteresisBps: 10, quantityBTC: QUANTITY,
      executionLagSnapshots: 1, endLiquidation: false, parameterSearch: false,
      equation: 'F=sum(last 3 prior bid+ask atoms), S=sum(last 6 prior bid+ask atoms); enter F*6*10000>S*3*10010; exit F*6*10000<S*3*9990' },
    interpretation: 'Hypothetical funding and fixed causal accounting comparison only. Protocol eligibility is not statistical adequacy, actual trades or a claim of strategy profitability.',
    scenario, decisions, result };
}
