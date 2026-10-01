/** Exact offline fill accounting. No exchange adapter, price inference or order transport. */
import { z } from 'zod';
import { canonical } from '../paper-v2/ledger.js';

const amountSchema = z.string().regex(/^(0|[1-9][0-9]{0,19})(?:\.[0-9]{1,18})?$/);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const time = z.number().int().nonnegative().safe();
const venue = z.enum(['mexc', 'okx']);
const fundsSchema = z.object({ BTC: amountSchema, USDT: amountSchema, MX: amountSchema }).strict();
const balancesSchema = z.object({ mexc: fundsSchema, okx: fundsSchema }).strict();
const buySchema = z.object({ venue, orderId: id, feeCaps: fundsSchema, sizing: z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('base'), baseQuantity: amountSchema, maxQuoteAmount: amountSchema }).strict(),
  z.object({ kind: z.literal('quote-budget'), quoteAmount: amountSchema }).strict()
]) }).strict();
const sellSchema = z.object({ venue, orderId: id, baseQuantity: amountSchema, feeCaps: fundsSchema }).strict();
const fillSchema = z.object({ fillId: id, executedAt: time, baseQuantity: amountSchema,
  quoteQuantity: amountSchema, fees: fundsSchema }).strict();
const totalsSchema = z.object({ baseQuantity: amountSchema, quoteQuantity: amountSchema, fees: fundsSchema }).strict();
const common = { id, at: time, pairId: id };
const sided = { ...common, side: z.enum(['buy', 'sell']) };
const terminal = z.enum(['filled', 'cancelled', 'rejected']);
const eventSchema = z.discriminatedUnion('type', [
  z.object({ ...common, type: z.literal('prepare'), buy: buySchema, sell: sellSchema }).strict(),
  z.object({ ...sided, type: z.literal('fill'), fill: fillSchema }).strict(),
  z.object({ ...sided, type: z.literal('unknown') }).strict(),
  z.object({ ...sided, type: z.literal('settle'), outcome: terminal, totals: totalsSchema }).strict(),
  z.object({ ...sided, type: z.literal('reconcile'), outcome: z.enum(['open', 'filled', 'cancelled', 'rejected']),
    fills: z.array(fillSchema).max(200), totals: totalsSchema }).strict()
]);
export type SettlementAsset = 'BTC' | 'USDT' | 'MX';
export type SettlementFunds = z.infer<typeof fundsSchema>;
export type SettlementBalances = z.infer<typeof balancesSchema>;
export type SettlementFill = z.infer<typeof fillSchema>;
export type SettlementEvent = z.infer<typeof eventSchema>;
export type SettlementBuyPlan = z.infer<typeof buySchema>;
export type SettlementSellPlan = z.infer<typeof sellSchema>;
type Venue = 'mexc' | 'okx';
type Side = 'buy' | 'sell';
type Money = Record<SettlementAsset, bigint>;
type Wallets = Record<Venue, Money>;
type Status = 'open' | 'partial' | 'unknown' | 'filled' | 'cancelled' | 'rejected';
interface Leg { status: Status; base: bigint; quote: bigint; fees: Money; fills: SettlementFill[] }
interface Position { pairId: string; preparedAt: number; buy: SettlementBuyPlan; sell: SettlementSellPlan;
  legs: Record<Side, Leg> }
export interface SettlementState {
  readonly initialBalances: SettlementBalances;
  readonly balances: Wallets;
  readonly positions: readonly Position[];
  readonly journal: readonly SettlementEvent[];
}
const ASSETS = ['BTC', 'USDT', 'MX'] as const;
const VENUES = ['mexc', 'okx'] as const;
const SCALE = 10n ** 18n;
const MAX_EVENTS = 2000;
const MAX_FILLS = 2000;
const MAX_JOURNAL_BYTES = 1024 * 1024;
export class SettlementError extends Error {
  constructor(readonly reason: string) { super(reason); this.name = 'SettlementError'; }
}
function fail(reason: string): never { throw new SettlementError(reason); }
function amount(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(18, '0'));
}
function text(value: bigint): string {
  const n = value < 0n ? -value : value;
  const fraction = (n % SCALE).toString().padStart(18, '0').replace(/0+$/, '');
  return `${value < 0n ? '-' : ''}${n / SCALE}${fraction ? '.' + fraction : ''}`;
}
function money(input: SettlementFunds): Money { return { BTC: amount(input.BTC), USDT: amount(input.USDT), MX: amount(input.MX) }; }
function zero(): Money { return { BTC: 0n, USDT: 0n, MX: 0n }; }
function display(input: Money): SettlementFunds { return { BTC: text(input.BTC), USDT: text(input.USDT), MX: text(input.MX) }; }
function pending(leg: Leg): boolean { return !['filled', 'cancelled', 'rejected'].includes(leg.status); }
function maxQuote(plan: SettlementBuyPlan): bigint {
  return amount(plan.sizing.kind === 'base' ? plan.sizing.maxQuoteAmount : plan.sizing.quoteAmount);
}
function residual(p: Position): bigint {
  return p.legs.buy.base - p.legs.buy.fees.BTC - p.legs.sell.base - p.legs.sell.fees.BTC;
}
function reserves(state: SettlementState): Wallets {
  const total: Wallets = { mexc: zero(), okx: zero() };
  for (const p of state.positions) {
    if (pending(p.legs.buy)) {
      const fees = money(p.buy.feeCaps), leg = p.legs.buy, wallet = total[p.buy.venue];
      wallet.USDT += maxQuote(p.buy) - leg.quote + fees.USDT - leg.fees.USDT;
      wallet.MX += fees.MX - leg.fees.MX;
    }
    if (pending(p.legs.sell)) {
      const fees = money(p.sell.feeCaps), leg = p.legs.sell, wallet = total[p.sell.venue];
      wallet.BTC += amount(p.sell.baseQuantity) - leg.base + fees.BTC - leg.fees.BTC;
      wallet.MX += fees.MX - leg.fees.MX;
    }
  }
  return total;
}
function available(state: SettlementState): Wallets {
  const reserved = reserves(state);
  return Object.fromEntries(VENUES.map(v => [v, Object.fromEntries(ASSETS.map(a => [a, state.balances[v][a] - reserved[v][a]]))])) as Wallets;
}
function assertFunds(state: SettlementState): void {
  const free = available(state), reserved = reserves(state);
  for (const v of VENUES) for (const a of ASSETS) {
    if (state.balances[v][a] < 0n || free[v][a] < 0n || reserved[v][a] < 0n) fail('insufficient-funds-or-reservation');
  }
}
export function createSettlementState(input: SettlementBalances): SettlementState {
  const parsed = balancesSchema.safeParse(input); if (!parsed.success) fail('invalid-opening-balances');
  return { initialBalances: structuredClone(parsed.data), balances: { mexc: money(parsed.data.mexc), okx: money(parsed.data.okx) }, positions: [], journal: [] };
}
function emptyLeg(): Leg { return { status: 'open', base: 0n, quote: 0n, fees: zero(), fills: [] }; }
function validatePlan(buy: SettlementBuyPlan, sell: SettlementSellPlan): void {
  if (buy.venue === sell.venue) fail('same-venue');
  if (maxQuote(buy) <= 0n || amount(sell.baseQuantity) <= 0n ||
      (buy.sizing.kind === 'base' && amount(buy.sizing.baseQuantity) <= 0n)) fail('non-positive-order-cap');
}
/** Each supplied fill contains final exact fee amounts, not a tariff-derived estimate. */
function postFill(state: SettlementState, p: Position, side: Side, fill: SettlementFill, observedAt: number): void {
  const leg = p.legs[side], plan = p[side];
  if (fill.executedAt < p.preparedAt || fill.executedAt > observedAt) fail('invalid-fill-time');
  const existing = leg.fills.find(f => f.fillId === fill.fillId);
  if (existing) {
    if (canonical(existing) !== canonical(fill)) fail('fill-id-conflict');
    return;
  }
  if (state.positions.reduce((count, item) => count + item.legs.buy.fills.length + item.legs.sell.fills.length, 0) >= MAX_FILLS) fail('fill-limit');
  if (amount(fill.baseQuantity) === 0n || amount(fill.quoteQuantity) === 0n) fail('non-positive-fill');
  const base = amount(fill.baseQuantity), quote = amount(fill.quoteQuantity), fees = money(fill.fees);
  const caps = money(plan.feeCaps);
  for (const a of ASSETS) if (leg.fees[a] + fees[a] > caps[a]) fail('fee-cap-exceeded');
  if (side === 'buy') {
    if (leg.quote + quote > maxQuote(p.buy)) fail('quote-budget-exceeded');
    if (p.buy.sizing.kind === 'base' && leg.base + base > amount(p.buy.sizing.baseQuantity)) fail('base-cap-exceeded');
    if (fees.BTC > base) fail('fee-exceeds-received-asset');
  } else {
    if (leg.base + base > amount(p.sell.baseQuantity)) fail('base-cap-exceeded');
    if (fees.USDT > quote) fail('fee-exceeds-received-asset');
  }
  const wallet = state.balances[plan.venue];
  wallet.BTC += (side === 'buy' ? base : -base) - fees.BTC;
  wallet.USDT += (side === 'buy' ? -quote : quote) - fees.USDT;
  wallet.MX -= fees.MX;
  leg.base += base; leg.quote += quote;
  for (const a of ASSETS) leg.fees[a] += fees[a];
  leg.fills.push(structuredClone(fill));
  leg.status = 'partial'; // Filled quantity alone does not prove terminal status or complete fees.
}
function assertTotals(leg: Leg, totals: z.infer<typeof totalsSchema>): void {
  const fees = money(totals.fees);
  if (amount(totals.baseQuantity) !== leg.base || amount(totals.quoteQuantity) !== leg.quote ||
      ASSETS.some(a => fees[a] !== leg.fees[a])) fail('incomplete-or-conflicting-fill-totals');
}
function settle(p: Position, side: Side, outcome: 'open' | 'filled' | 'cancelled' | 'rejected'): void {
  const leg = p.legs[side];
  if (outcome === 'rejected' && leg.fills.length !== 0) fail('rejected-order-has-fills');
  if (outcome === 'filled') {
    if (leg.base === 0n) fail('filled-order-is-empty');
    if ((side === 'sell' && leg.base !== amount(p.sell.baseQuantity)) ||
        (side === 'buy' && p.buy.sizing.kind === 'base' && leg.base !== amount(p.buy.sizing.baseQuantity))) fail('filled-base-size-mismatch');
  }
  leg.status = outcome === 'open' ? (leg.fills.length ? 'partial' : 'open') : outcome;
}
/** Atomic immutable transition. Unknown legs retain reserves until explicit full-total reconciliation. */
export function applySettlementEvent(state: SettlementState, input: SettlementEvent): SettlementState {
  const parsed = eventSchema.safeParse(input); if (!parsed.success) fail('invalid-settlement-event');
  const event = parsed.data;
  const previous = state.journal.find(e => e.id === event.id);
  if (previous) { if (canonical(previous) !== canonical(event)) fail('event-id-conflict'); return state; }
  if (state.journal.length >= MAX_EVENTS) fail('journal-limit');
  if (Buffer.byteLength(canonical([...state.journal, event]), 'utf8') > MAX_JOURNAL_BYTES) fail('journal-size-limit');
  if (state.journal.length && event.at < state.journal[state.journal.length - 1].at) fail('out-of-order-event');
  const next = structuredClone(state) as { initialBalances: SettlementBalances; balances: Wallets; positions: Position[]; journal: SettlementEvent[] };
  if (event.type === 'prepare') {
    if (next.positions.some(p => p.pairId === event.pairId)) fail('pair-id-conflict');
    if (next.positions.some(p => pending(p.legs.buy) || pending(p.legs.sell) || residual(p) !== 0n)) fail('unresolved-exposure');
    validatePlan(event.buy, event.sell);
    for (const p of next.positions) for (const side of ['buy', 'sell'] as const) for (const plan of [event.buy, event.sell]) {
      if (p[side].venue === plan.venue && p[side].orderId === plan.orderId) fail('order-id-conflict');
    }
    next.positions.push({ pairId: event.pairId, preparedAt: event.at, buy: structuredClone(event.buy), sell: structuredClone(event.sell),
      legs: { buy: emptyLeg(), sell: emptyLeg() } });
  } else {
    const p = next.positions.find(p => p.pairId === event.pairId); if (!p) fail('unknown-pair');
    const leg = p.legs[event.side];
    // Economic duplicates may arrive after terminal status. They remain audit events but never post twice.
    const duplicate = event.type === 'fill' && leg.fills.find(f => f.fillId === event.fill.fillId);
    if (duplicate) {
      if (canonical(duplicate) !== canonical(event.fill)) fail('fill-id-conflict');
    } else {
      if (!pending(leg)) fail('terminal-leg');
      if (event.type === 'unknown') leg.status = 'unknown';
      else if (event.type === 'reconcile') {
        if (leg.status !== 'unknown') fail('reconciliation-not-required');
        for (const fill of event.fills) postFill(next, p, event.side, fill, event.at);
        assertTotals(leg, event.totals); settle(p, event.side, event.outcome);
      } else {
        if (leg.status === 'unknown') fail('reconciliation-required');
        if (event.type === 'fill') postFill(next, p, event.side, event.fill, event.at);
        else { assertTotals(leg, event.totals); settle(p, event.side, event.outcome); }
      }
    }
  }
  next.journal.push(structuredClone(event)); assertFunds(next); return next;
}
export function replaySettlementJournal(initialBalances: SettlementBalances, journal: readonly SettlementEvent[]): SettlementState {
  if (!Array.isArray(journal) || journal.length > MAX_EVENTS) fail('journal-limit');
  return journal.reduce((s, e) => applySettlementEvent(s, e), createSettlementState(initialBalances));
}
export function viewSettlementState(state: SettlementState) {
  const reserved = reserves(state), free = available(state);
  const wallets = (value: Wallets) => ({ mexc: display(value.mexc), okx: display(value.okx) });
  return { schemaVersion: 1, kind: 'explicit-fill-paper-settlement', executable: false, funding: 'synthetic',
    feeAccounting: 'explicit-per-fill-asset-amounts', balances: wallets(state.balances), reserved: wallets(reserved),
    available: wallets(free), journalEvents: state.journal.length,
    positions: state.positions.map(p => ({ pairId: p.pairId, buyVenue: p.buy.venue, sellVenue: p.sell.venue,
      residualBtc: text(residual(p)), cashDeltaUsdt: text(p.legs.sell.quote - p.legs.sell.fees.USDT - p.legs.buy.quote - p.legs.buy.fees.USDT),
      feesByAsset: display(Object.fromEntries(ASSETS.map(a => [a, p.legs.buy.fees[a] + p.legs.sell.fees[a]])) as Money),
      settlement: pending(p.legs.buy) || pending(p.legs.sell) ? 'pending' : residual(p) !== 0n ? 'residual-exposure' : 'balanced',
      legs: Object.fromEntries((['buy', 'sell'] as const).map(side => [side, {
        venue: p[side].venue, orderId: p[side].orderId, status: p.legs[side].status, fills: p.legs[side].fills.length,
        baseQuantity: text(p.legs[side].base), quoteQuantity: text(p.legs[side].quote), fees: display(p.legs[side].fees)
      }]))
    })) };
}
