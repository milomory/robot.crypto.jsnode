/** Offline, synthetic MEXC/OKX ledger. It contains no network, credentials or execution transport. */
export type PairVenue = 'mexc' | 'okx';
export type PairSide = 'buy' | 'sell';
export interface PairBook {
  venue: PairVenue; symbol: 'BTC/USDT'; bids: [string, string][]; asks: [string, string][];
  requestedAt: number; receivedAt: number; sourceAt?: number;
}
/** All limits are for BTC base quantity or USDT quote notional. Omission means no documented limit. */
export interface PairInstrument {
  venue: PairVenue; symbol: 'BTC/USDT'; fetchedAt: number; trading: boolean;
  minQuantity: string; quantityStep: string; maxQuantity?: string; minNotional?: string; maxNotional?: string;
}
/** Charging the fee in USDT is a simulation assumption, not a statement of exchange fee currency. */
export interface PairCosts { feeBps: string; slippageBps: string; feeAsset: 'USDT' }
export interface PairLegMarket { book: PairBook; instrument: PairInstrument; costs: PairCosts }
export interface PairMarketInput { buy: PairLegMarket; sell: PairLegMarket; quantity: string; now: number }
export interface PairBalances { mexc: { btc: string; usdt: string }; okx: { btc: string; usdt: string } }
export interface PairPlanInput extends PairMarketInput { balances: PairBalances }
export interface PairQuote { quantity: string; rawNotionalUsdt: string; grossUsdt: string; feeUsdt: string; cashUsdt: string }
export interface PairComparison { buy: PairQuote; sell: PairQuote; netUsdt: string }
export type PairEvent =
  | { type: 'prepare'; id: string; at: number; pairId: string; market: Omit<PairMarketInput, 'now'> }
  | { type: 'leg'; id: string; at: number; pairId: string; side: PairSide; cumulativeQuantity: string; status: 'partial' | 'filled' | 'rejected' | 'unknown' }
  | { type: 'reconcile'; id: string; at: number; pairId: string; side: PairSide; cumulativeQuantity: string; status: 'partial' | 'filled' | 'rejected' };

type LegStatus = 'pending' | 'partial' | 'filled' | 'rejected' | 'unknown';
interface LegState { quantity: bigint; cash: bigint; fee: bigint; status: LegStatus }
interface Position { input: PairMarketInput; comparison: PairComparison; buy: LegState; sell: LegState }
interface Amounts { btc: bigint; usdt: bigint }
export interface PairState {
  readonly initialBalances: PairBalances;
  readonly balances: Record<PairVenue, Amounts>;
  readonly positions: Readonly<Record<string, Position>>;
  readonly journal: readonly PairEvent[];
}
const SCALE = 10n ** 18n;
const CASH = 10n ** 8n;
const BPS = 10_000n * SCALE;
const VENUES = ['mexc', 'okx'] as const;
const MAX_JOURNAL = 2_000;
export class PairPaperError extends Error {
  constructor(readonly reason: string) { super(reason); this.name = 'PairPaperError'; }
}
function fail(reason: string): never { throw new PairPaperError(reason); }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function isVenue(value: unknown): value is PairVenue { return value === 'mexc' || value === 'okx'; }
function time(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function amount(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})(?:\.[0-9]{1,18})?$/.test(value)) fail('invalid-decimal');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(18, '0'));
}
function positive(value: unknown): bigint { const result = amount(value); if (result === 0n) fail('non-positive-amount'); return result; }
function cashAmount(value: unknown): bigint {
  const result = amount(value); if (result % (SCALE / CASH) !== 0n) fail('unsupported-cash-precision');
  return result / (SCALE / CASH);
}
function format(value: bigint, places = 18): string {
  const divisor = 10n ** BigInt(places); const n = value < 0n ? -value : value;
  const fraction = (n % divisor).toString().padStart(places, '0').replace(/0+$/, '');
  return `${value < 0n ? '-' : ''}${n / divisor}${fraction ? `.${fraction}` : ''}`;
}
function ceil(n: bigint, d: bigint): bigint { return (n + d - 1n) / d; }
function depth(input: unknown, side: 'bids' | 'asks'): [bigint, bigint][] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 100) fail('invalid-depth');
  const result: [bigint, bigint][] = [];
  for (const row of input) {
    if (!Array.isArray(row) || row.length !== 2) fail('invalid-depth-level');
    const pair: [bigint, bigint] = [positive(row[0]), positive(row[1])];
    const previous = result.at(-1);
    if (previous && (side === 'bids' ? previous[0] <= pair[0] : previous[0] >= pair[0])) fail('unsorted-depth');
    result.push(pair);
  }
  return result;
}
function validateLeg(leg: PairLegMarket, now: number) {
  if (!object(leg) || !object(leg.book) || !object(leg.instrument) || !object(leg.costs)) fail('invalid-market');
  const { book, instrument, costs } = leg;
  if (!isVenue(book.venue) || book.venue !== instrument.venue || book.symbol !== 'BTC/USDT' || instrument.symbol !== 'BTC/USDT') fail('incompatible-market');
  if (!time(now) || !time(book.requestedAt) || !time(book.receivedAt) || book.requestedAt > book.receivedAt || book.receivedAt > now || now - book.requestedAt > 5_000) fail('stale-or-invalid-book-time');
  if (book.sourceAt !== undefined && (!time(book.sourceAt) || book.sourceAt > book.receivedAt + 1_000 || now - book.sourceAt > 5_000)) fail('stale-or-invalid-source-time');
  if (!time(instrument.fetchedAt) || instrument.fetchedAt > now || now - instrument.fetchedAt > 3_600_000) fail('stale-or-invalid-instrument-time');
  if (instrument.trading !== true) fail('instrument-not-trading');
  if (costs.feeAsset !== 'USDT') fail('unsupported-fee-asset');
  const fee = amount(costs.feeBps); const slippage = amount(costs.slippageBps);
  if (fee >= BPS || slippage >= BPS) fail('invalid-cost');
  const minimum = positive(instrument.minQuantity); const step = positive(instrument.quantityStep);
  const maximum = instrument.maxQuantity === undefined ? undefined : positive(instrument.maxQuantity);
  const minNotional = instrument.minNotional === undefined ? undefined : positive(instrument.minNotional);
  const maxNotional = instrument.maxNotional === undefined ? undefined : positive(instrument.maxNotional);
  if ((maximum !== undefined && (minimum > maximum || step > maximum)) || (minNotional !== undefined && maxNotional !== undefined && minNotional > maxNotional)) fail('invalid-instrument-rules');
  const bids = depth(book.bids, 'bids'); const asks = depth(book.asks, 'asks');
  if (bids[0][0] >= asks[0][0]) fail('crossed-book');
  return { fee, slippage, minimum, maximum, step, minNotional, maxNotional, bids, asks };
}
/** Quotes cumulative fills from the original archived depth curve; no matching or queue model. */
function quote(leg: PairLegMarket, side: PairSide, quantity: bigint, now: number, checkOrderRules: boolean): PairQuote {
  const rules = validateLeg(leg, now);
  if (checkOrderRules) {
    if (quantity < rules.minimum || (rules.maximum !== undefined && quantity > rules.maximum)) fail('quantity-out-of-range');
    if (quantity % rules.step !== 0n) fail('quantity-step-mismatch');
  }
  let remaining = quantity; let raw = 0n;
  for (const [price, available] of side === 'buy' ? rules.asks : rules.bids) {
    const take = remaining < available ? remaining : available;
    raw += price * take; remaining -= take; if (remaining === 0n) break;
  }
  if (remaining !== 0n) fail('insufficient-depth');
  if (checkOrderRules && ((rules.minNotional !== undefined && raw < rules.minNotional * SCALE) || (rules.maxNotional !== undefined && raw > rules.maxNotional * SCALE))) fail('notional-out-of-range');
  const adjusted = raw * (side === 'buy' ? BPS + rules.slippage : BPS - rules.slippage);
  const denominator = SCALE * SCALE * BPS;
  const gross = side === 'buy' ? ceil(adjusted * CASH, denominator) : adjusted * CASH / denominator;
  const fee = ceil(adjusted * rules.fee * CASH, denominator * BPS);
  const cash = side === 'buy' ? gross + fee : gross - fee;
  if (quantity > 0n && cash <= 0n) fail('non-positive-cash');
  return { quantity: format(quantity), rawNotionalUsdt: format(raw, 36), grossUsdt: format(gross, 8), feeUsdt: format(fee, 8), cashUsdt: format(cash, 8) };
}
/** Price-only estimate: validates observation/costs/depth, but deliberately proves no instrument eligibility. */
export function quoteBook(book: PairBook, side: PairSide, quantity: string, costs: PairCosts, now: number): PairQuote {
  if (side !== 'buy' && side !== 'sell') fail('invalid-side');
  if (!object(book)) fail('invalid-market');
  // Internal arithmetic sentinel only; checkOrderRules=false bypasses these dummy limits.
  return quote({ book, costs, instrument: { venue: book.venue, symbol: book.symbol,
    fetchedAt: now, trading: true, minQuantity: '0.000000000000000001', quantityStep: '0.000000000000000001' }
  }, side, positive(quantity), now, false);
}
/** Comparison is useful even when net is negative. USDT fees and slippage remain explicit assumptions. */
export function quotePair(input: PairMarketInput): PairComparison {
  if (!object(input) || !object(input.buy) || !object(input.sell)) fail('invalid-market');
  const quantity = positive(input.quantity);
  const buy = quote(input.buy, 'buy', quantity, input.now, true);
  const sell = quote(input.sell, 'sell', quantity, input.now, true);
  if (input.buy.book.venue === input.sell.book.venue) fail('same-venue');
  if (Math.abs(input.buy.book.receivedAt - input.sell.book.receivedAt) > 1_000) fail('receipt-skew');
  return { buy, sell, netUsdt: format(cashAmount(sell.cashUsdt) - cashAmount(buy.cashUsdt), 8) };
}
function parseBalances(input: PairBalances): Record<PairVenue, Amounts> {
  if (!object(input) || !object(input.mexc) || !object(input.okx)) fail('invalid-balances');
  return { mexc: { btc: amount(input.mexc.btc), usdt: cashAmount(input.mexc.usdt) }, okx: { btc: amount(input.okx.btc), usdt: cashAmount(input.okx.usdt) } };
}
function assertOpportunity(input: PairMarketInput, comparison: PairComparison, balances: Record<PairVenue, Amounts>) {
  if (cashAmount(comparison.sell.cashUsdt) <= cashAmount(comparison.buy.cashUsdt)) fail('non-positive-net');
  if (balances[input.buy.book.venue].usdt < cashAmount(comparison.buy.cashUsdt) || balances[input.sell.book.venue].btc < positive(input.quantity)) fail('insufficient-inventory');
}
export function evaluatePair(input: PairPlanInput): PairComparison {
  const result = quotePair(input); assertOpportunity(input, result, parseBalances(input.balances)); return result;
}
function clone<T>(value: T): T { return structuredClone(value); }
export function createPairState(initialBalances: PairBalances): PairState {
  return { initialBalances: clone(initialBalances), balances: parseBalances(initialBalances), positions: Object.create(null), journal: [] };
}
function pending(leg: LegState) { return leg.status !== 'filled' && leg.status !== 'rejected'; }
function reservations(state: PairState): Record<PairVenue, Amounts> {
  const result: Record<PairVenue, Amounts> = { mexc: { btc: 0n, usdt: 0n }, okx: { btc: 0n, usdt: 0n } };
  for (const position of Object.values(state.positions)) {
    if (pending(position.buy)) result[position.input.buy.book.venue].usdt += cashAmount(position.comparison.buy.cashUsdt) - position.buy.cash;
    if (pending(position.sell)) result[position.input.sell.book.venue].btc += amount(position.input.quantity) - position.sell.quantity;
  }
  return result;
}
function availableBalances(state: PairState): Record<PairVenue, Amounts> {
  const reserved = reservations(state);
  return { mexc: { btc: state.balances.mexc.btc - reserved.mexc.btc, usdt: state.balances.mexc.usdt - reserved.mexc.usdt }, okx: { btc: state.balances.okx.btc - reserved.okx.btc, usdt: state.balances.okx.usdt - reserved.okx.usdt } };
}
function validateEvent(event: PairEvent) {
  if (!object(event) || !['prepare', 'leg', 'reconcile'].includes(event.type) || typeof event.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(event.id) || typeof event.pairId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(event.pairId) || !time(event.at)) fail('invalid-event');
  const keys = event.type === 'prepare' ? ['type', 'id', 'at', 'pairId', 'market'] : ['type', 'id', 'at', 'pairId', 'side', 'cumulativeQuantity', 'status'];
  if (Object.keys(event).some((key) => !keys.includes(key))) fail('invalid-event');
  if (event.type !== 'prepare' && (!['buy', 'sell'].includes(event.side) || !['partial', 'filled', 'rejected', 'unknown'].includes(event.status) || (event.type === 'reconcile' && (event.status as string) === 'unknown'))) fail('invalid-event');
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
/** Returns new state. Failed events leave prior state intact. Replay is the only recovery/checkpoint protocol. */
export function applyPairEvent(state: PairState, event: PairEvent): PairState {
  validateEvent(event);
  const previous = state.journal.find((item) => item.id === event.id);
  if (previous) { if (canonical(previous) !== canonical(event)) fail('event-id-conflict'); return state; }
  if (state.journal.length >= MAX_JOURNAL) fail('journal-limit');
  if (state.journal.length && event.at < state.journal[state.journal.length - 1].at) fail('out-of-order-event');
  const next = clone(state) as { initialBalances: PairBalances; balances: Record<PairVenue, Amounts>; positions: Record<string, Position>; journal: PairEvent[] };
  if (event.type === 'prepare') {
    if (Object.hasOwn(state.positions, event.pairId)) fail('pair-id-conflict');
    if (Object.values(state.positions).some((position) => pending(position.buy) || pending(position.sell) || position.buy.quantity !== position.sell.quantity)) fail('unresolved-exposure');
    if (!object(event.market) || Object.keys(event.market).some((key) => !['buy', 'sell', 'quantity'].includes(key))) fail('invalid-market');
    const input: PairMarketInput = { ...clone(event.market), now: event.at };
    const comparison = quotePair(input); assertOpportunity(input, comparison, availableBalances(state));
    const empty = (): LegState => ({ quantity: 0n, cash: 0n, fee: 0n, status: 'pending' });
    Object.defineProperty(next.positions, event.pairId, { value: { input, comparison, buy: empty(), sell: empty() }, enumerable: true, writable: true, configurable: true });
  } else {
    if (!Object.hasOwn(next.positions, event.pairId)) fail('unknown-pair');
    const position = next.positions[event.pairId]; const leg = position[event.side];
    if (!pending(leg)) fail('terminal-leg');
    if (event.type === 'reconcile' && leg.status !== 'unknown') fail('reconciliation-not-required');
    if (event.type === 'leg' && leg.status === 'unknown') fail('reconciliation-required');
    const cumulative = amount(event.cumulativeQuantity); const planned = positive(position.input.quantity);
    if (cumulative < leg.quantity || cumulative > planned) fail('invalid-cumulative-fill');
    if ((event.status === 'filled' && cumulative !== planned) || (event.status === 'partial' && (cumulative === 0n || cumulative === planned))) fail('invalid-fill-status');
    // Ordinary new fills must occur while the original observation is fresh.
    // Reconciliation only records an already occurred outcome on that archived curve; it is not a new execution.
    const pricingAt = event.type === 'leg' && cumulative > leg.quantity ? event.at : position.input.now;
    const result = quote(position.input[event.side], event.side, cumulative, pricingAt, false);
    const cash = cashAmount(result.cashUsdt); const fee = cashAmount(result.feeUsdt);
    const deltaCash = cash - leg.cash; const deltaQuantity = cumulative - leg.quantity;
    const account = next.balances[position.input[event.side].book.venue];
    account.btc += event.side === 'buy' ? deltaQuantity : -deltaQuantity;
    account.usdt += event.side === 'buy' ? -deltaCash : deltaCash;
    if (account.btc < 0n || account.usdt < 0n) fail('negative-balance');
    position[event.side] = { quantity: cumulative, cash, fee, status: event.status };
  }
  next.journal.push(clone(event));
  const available = availableBalances(next);
  for (const venue of VENUES) if (available[venue].btc < 0n || available[venue].usdt < 0n) fail('reservation-invariant');
  return next;
}
export function replayPairJournal(initialBalances: PairBalances, journal: readonly PairEvent[]): PairState {
  if (!Array.isArray(journal) || journal.length > MAX_JOURNAL) fail('journal-limit');
  return journal.reduce((state, event) => applyPairEvent(state, event), createPairState(initialBalances));
}
export function viewPairState(state: PairState) {
  const reserved = reservations(state); const available = availableBalances(state);
  const display = (balances: Record<PairVenue, Amounts>): PairBalances => ({
    mexc: { btc: format(balances.mexc.btc), usdt: format(balances.mexc.usdt, 8) },
    okx: { btc: format(balances.okx.btc), usdt: format(balances.okx.usdt, 8) }
  });
  return {
    schemaVersion: 1, mode: 'paper' as const, executable: false, funding: 'synthetic' as const,
    balances: display(state.balances), reserved: display(reserved), available: display(available), journalEvents: state.journal.length,
    positions: Object.entries(state.positions).map(([pairId, position]) => ({
      pairId, buyVenue: position.input.buy.book.venue, sellVenue: position.input.sell.book.venue,
      plannedQuantity: position.input.quantity, projectedNetUsdt: position.comparison.netUsdt,
      residualBtc: format(position.buy.quantity - position.sell.quantity),
      cashDeltaUsdt: format(position.sell.cash - position.buy.cash, 8),
      settlement: pending(position.buy) || pending(position.sell) ? 'pending' : position.buy.quantity !== position.sell.quantity ? 'residual-exposure' : 'balanced',
      legs: Object.fromEntries((['buy', 'sell'] as const).map((side) => [side, { status: position[side].status, filledQuantity: format(position[side].quantity), cashUsdt: format(position[side].cash, 8), feeUsdt: format(position[side].fee, 8) }]))
    }))
  };
}
