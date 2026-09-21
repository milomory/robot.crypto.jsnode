import { createHash } from 'node:crypto';
import { accountSchema, stepSchema, type Scenario, type Step } from './schema.js';
import { executeFill, formatAmount, parseAmount, PaperError, ROUNDING_DENOMINATOR,
  RAW_DENOMINATOR, SLIPPAGE_DENOMINATOR, type Book, type ExactFill } from './exact.js';

export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const text = JSON.stringify(value);
    if (text === undefined) throw new PaperError('invalid-canonical-value');
    return text;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}
export const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export type AccountConfig = Pick<Scenario, 'venue' | 'symbol' | 'opening' | 'costs' | 'instrument'>;
interface Lot { id: string; quantity: bigint; cost: bigint }
interface State { cash: bigint; base: bigint; lots: Lot[]; realised: bigint; fees: bigint; rounding: bigint;
  quotePostings: bigint; basePostings: bigint; acquiredCost: bigint; releasedCost: bigint }
const totalCost = (state: State) => state.lots.reduce((sum, lot) => sum + lot.cost, 0n);
export type AccountSnapshot = ReturnType<PaperAccount['snapshot']>;
export interface LedgerEvent {
  id: string; at: number; inputHash: string; action: 'buy' | 'sell' | 'mark';
  status: 'filled' | 'rejected' | 'marked'; reason?: string;
  postings: { venue: AccountConfig['venue']; BTC: string; USDT: string };
  feeUSDT: string; releasedCostUSDT: string; realisedPnLUSDT: string;
  fill?: { quantityBTC: string; grossUSDT: string; cashUSDT: string;
    rawQuote: { numerator: string; denominator: string; unit: 'USDT-atom' };
    slippage: { numerator: string; denominator: string; unit: 'USDT-atom' };
    adverseRounding: { numerator: string; denominator: string; unit: 'USDT-atom' } };
  account: AccountSnapshot;
}
export type Valuation = { available: true; at: number; equityUSDT: string; liquidationUSDT: string;
  unrealisedPnLUSDT: string; sourceTimePresent: boolean | null } |
  { available: false; at: number; reason: string };

// One independently funded venue. All state changes are prepared, reconciled,
// then committed together; rejection cannot consume cash or FIFO lots.
export class PaperAccount {
  private readonly config: AccountConfig;
  private readonly openingCash: bigint;
  private readonly openingBase: bigint;
  private readonly openingCost: bigint;
  private state: State;
  private lastAt = 0;
  private readonly seen = new Map<string, { hash: string; event: LedgerEvent }>();
  private readonly journal: LedgerEvent[] = [];

  constructor(input: AccountConfig) {
    const parsed = accountSchema.safeParse(input);
    if (!parsed.success) throw new PaperError('invalid-account-config');
    this.config = parsed.data;
    if (this.config.instrument.venue !== this.config.venue || this.config.instrument.symbol !== this.config.symbol) {
      throw new PaperError('instrument-account-mismatch');
    }
    this.openingCash = parseAmount(this.config.opening.USDT);
    this.openingBase = parseAmount(this.config.opening.BTC);
    if (this.openingBase > 0n && this.config.opening.costBasisUSDT === undefined) throw new PaperError('missing-opening-cost');
    this.openingCost = parseAmount(this.config.opening.costBasisUSDT ?? '0');
    if (this.openingBase === 0n && this.openingCost !== 0n) throw new PaperError('orphan-opening-cost');
    this.state = { cash: this.openingCash, base: this.openingBase,
      lots: this.openingBase ? [{ id: 'opening', quantity: this.openingBase, cost: this.openingCost }] : [],
      realised: 0n, fees: 0n, rounding: 0n, quotePostings: 0n, basePostings: 0n, acquiredCost: 0n, releasedCost: 0n };
    this.reconcile(this.state);
  }

  private reconcile(state: State) {
    const cost = totalCost(state);
    if (state.cash < 0n || state.base < 0n || state.fees < 0n || state.rounding < 0n ||
        state.lots.some(lot => lot.quantity <= 0n || lot.cost < 0n) ||
        state.lots.reduce((sum, lot) => sum + lot.quantity, 0n) !== state.base ||
        state.cash !== this.openingCash + state.quotePostings ||
        state.base !== this.openingBase + state.basePostings ||
        cost !== this.openingCost + state.acquiredCost - state.releasedCost ||
        state.cash + cost !== this.openingCash + this.openingCost + state.realised) {
      throw new PaperError('account-reconciliation-failed');
    }
  }

  private describe(state: State) {
    return { venue: this.config.venue,
      balances: { [this.config.venue]: { BTC: formatAmount(state.base), USDT: formatAmount(state.cash) } },
      costBasisUSDT: formatAmount(totalCost(state)), realisedPnLUSDT: formatAmount(state.realised),
      feesUSDT: formatAmount(state.fees),
      adverseRounding: { numerator: String(state.rounding), denominator: String(ROUNDING_DENOMINATOR), unit: 'USDT-atom' as const },
      lots: state.lots.map(lot => ({ id: lot.id, quantityBTC: formatAmount(lot.quantity), costUSDT: formatAmount(lot.cost) })),
      reconciled: true as const };
  }
  snapshot() { return this.describe(this.state); }
  events() { return structuredClone(this.journal); }

  apply(input: Step): LedgerEvent {
    const parsed = stepSchema.safeParse(input);
    if (!parsed.success) throw new PaperError('invalid-event');
    const step = parsed.data;
    const hash = digest(step);
    const previous = this.seen.get(step.id);
    if (previous) {
      if (previous.hash !== hash) throw new PaperError('event-id-conflict');
      return structuredClone(previous.event);
    }
    if (step.at <= this.lastAt) throw new PaperError('out-of-order-event');
    const next: State = { ...this.state, lots: this.state.lots.map(lot => ({ ...lot })) };
    let status: LedgerEvent['status'] = 'marked', reason: string | undefined;
    let fill: ExactFill | undefined;
    let cashDelta = 0n, baseDelta = 0n, released = 0n, realised = 0n;
    if (step.intent) {
      try {
        if (!step.book) throw new PaperError('missing-book');
        if (step.book.venue !== this.config.venue || step.book.symbol !== this.config.symbol) throw new PaperError('book-account-mismatch');
        fill = executeFill(step.book, this.config.instrument, step.intent.side, step.intent.quantity, this.config.costs, step.at);
        if (step.intent.side === 'buy' && fill.cash > next.cash) throw new PaperError('insufficient-cash');
        if (step.intent.side === 'sell' && fill.quantity > next.base) throw new PaperError('insufficient-base');
      } catch (error) {
        if (!(error instanceof PaperError)) throw error;
        status = 'rejected'; reason = error.message; fill = undefined;
      }
      if (fill) {
        status = 'filled';
        if (step.intent.side === 'buy') {
          cashDelta = -fill.cash; baseDelta = fill.quantity;
          next.lots.push({ id: `fill:${step.id}`, quantity: fill.quantity, cost: fill.cash });
          next.acquiredCost += fill.cash;
        } else {
          cashDelta = fill.cash; baseDelta = -fill.quantity;
          let remaining = fill.quantity;
          while (remaining > 0n) {
            const lot = next.lots[0];
            const take = remaining < lot.quantity ? remaining : lot.quantity;
            // Floor partial allocation and carry the residual; full close releases it exactly.
            const cost = lot.cost * take / lot.quantity;
            released += cost; lot.cost -= cost; lot.quantity -= take; remaining -= take;
            if (lot.quantity === 0n) next.lots.shift();
          }
          next.releasedCost += released;
          realised = fill.cash - released; next.realised += realised;
        }
        next.cash += cashDelta; next.base += baseDelta;
        next.quotePostings += cashDelta; next.basePostings += baseDelta;
        next.fees += fill.fee; next.rounding += fill.roundingNumerator;
      }
    }
    this.reconcile(next);
    const event: LedgerEvent = { id: step.id, at: step.at, inputHash: hash, action: step.intent?.side ?? 'mark', status,
      ...(reason ? { reason } : {}), postings: { venue: this.config.venue, BTC: formatAmount(baseDelta), USDT: formatAmount(cashDelta) },
      feeUSDT: formatAmount(fill?.fee ?? 0n), releasedCostUSDT: formatAmount(released), realisedPnLUSDT: formatAmount(realised),
      ...(fill ? { fill: { quantityBTC: formatAmount(fill.quantity), grossUSDT: formatAmount(fill.gross), cashUSDT: formatAmount(fill.cash),
        rawQuote: { numerator: String(fill.rawQuoteNumerator), denominator: String(RAW_DENOMINATOR), unit: 'USDT-atom' as const },
        slippage: { numerator: String(fill.slippageNumerator), denominator: String(SLIPPAGE_DENOMINATOR), unit: 'USDT-atom' as const },
        adverseRounding: { numerator: String(fill.roundingNumerator), denominator: String(ROUNDING_DENOMINATOR), unit: 'USDT-atom' as const } } } : {}),
      account: this.describe(next) };
    this.state = next; this.lastAt = step.at;
    this.seen.set(step.id, { hash, event }); this.journal.push(event);
    return structuredClone(event);
  }

  value(book: Book | undefined, at: number): Valuation {
    if (!Number.isSafeInteger(at) || at <= 0 || at < this.lastAt) throw new PaperError('invalid-valuation-time');
    if (this.state.base === 0n) return { available: true, at, equityUSDT: formatAmount(this.state.cash),
      liquidationUSDT: formatAmount(0n), unrealisedPnLUSDT: formatAmount(0n), sourceTimePresent: null };
    try {
      if (!book) throw new PaperError('missing-book');
      if (book.venue !== this.config.venue || book.symbol !== this.config.symbol) throw new PaperError('book-account-mismatch');
      const fill = executeFill(book, this.config.instrument, 'sell', formatAmount(this.state.base), this.config.costs, at);
      return { available: true, at, equityUSDT: formatAmount(this.state.cash + fill.cash),
        liquidationUSDT: formatAmount(fill.cash), unrealisedPnLUSDT: formatAmount(fill.cash - totalCost(this.state)),
        sourceTimePresent: book.sourceAt !== undefined };
    } catch (error) {
      if (!(error instanceof PaperError)) throw error;
      return { available: false, at, reason: error.message };
    }
  }
}
