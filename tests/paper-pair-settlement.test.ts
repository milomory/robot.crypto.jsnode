import { describe, expect, it } from 'vitest';
import {
  applySettlementEvent, createSettlementState, replaySettlementJournal, viewSettlementState,
  type SettlementBalances, type SettlementEvent, type SettlementFill, type SettlementFunds, type SettlementState
} from '../src/paper-pair/settlement.js';

type Prepare = Extract<SettlementEvent, { type: 'prepare' }>;
type Side = 'buy' | 'sell';
const T = 1_800_000_000_000;
const funds = (change: Partial<SettlementFunds> = {}): SettlementFunds => ({ BTC: '0', USDT: '0', MX: '0', ...change });
const opening: SettlementBalances = {
  mexc: { BTC: '1', USDT: '100', MX: '5' },
  okx: { BTC: '1', USDT: '100', MX: '5' }
};
function prepare(change: Partial<Prepare> = {}): Prepare {
  return { type: 'prepare', id: 'prepare-1', at: T, pairId: 'pair-1',
    buy: { venue: 'okx', orderId: 'buy-1', sizing: { kind: 'base', baseQuantity: '0.1', maxQuoteAmount: '20' }, feeCaps: funds() },
    sell: { venue: 'mexc', orderId: 'sell-1', baseQuantity: '0.1', feeCaps: funds() }, ...change };
}
function fill(fillId: string, baseQuantity = '0.1', quoteQuantity = '10', fees = funds(), executedAt = T + 1): SettlementFill {
  return { fillId, executedAt, baseQuantity, quoteQuantity, fees };
}
function fillEvent(side: Side, value: SettlementFill, id = value.fillId, at = T + 1): SettlementEvent {
  return { type: 'fill', id, at, pairId: 'pair-1', side, fill: value };
}
function totals(baseQuantity = '0.1', quoteQuantity = '10', fees = funds()) { return { baseQuantity, quoteQuantity, fees }; }
function terminal(side: Side, sum = totals(), outcome: 'filled' | 'cancelled' | 'rejected' = 'filled', at = T + 2): SettlementEvent {
  return { type: 'settle', id: `settle-${side}`, at, pairId: 'pair-1', side, outcome, totals: sum };
}
function prepared(plan = prepare(), balances = opening): SettlementState {
  return applySettlementEvent(createSettlementState(balances), plan);
}
function unchangedOnError(state: SettlementState, event: unknown, reason: string): void {
  const before = structuredClone(state);
  expect(() => applySettlementEvent(state, event as SettlementEvent)).toThrow(reason);
  expect(state).toEqual(before);
}
function balanced(): SettlementState {
  return replaySettlementJournal(opening, [prepare(), fillEvent('buy', fill('buy-fill')),
    fillEvent('sell', fill('sell-fill', '0.1', '11')), terminal('buy'), terminal('sell', totals('0.1', '11'))]);
}

describe('explicit synthetic settlement with per-fill fee assets', () => {
  it('reserves capital and external fee currency on each venue before either fill', () => {
    const plan = prepare();
    plan.buy.feeCaps = funds({ USDT: '0.2', MX: '0.3', BTC: '0.01' });
    plan.sell.feeCaps = funds({ BTC: '0.01', USDT: '0.3', MX: '0.4' });
    const view = viewSettlementState(prepared(plan));
    expect(view).toMatchObject({ kind: 'explicit-fill-paper-settlement', executable: false, funding: 'synthetic' });
    expect(view.reserved).toEqual({ okx: funds({ USDT: '20.2', MX: '0.3' }), mexc: funds({ BTC: '0.11', MX: '0.4' }) });
    expect(view.available).toEqual({ okx: { BTC: '1', USDT: '79.8', MX: '4.7' }, mexc: { BTC: '0.89', USDT: '100', MX: '4.6' } });
  });

  it('deducts a BTC buy fee from the received quantity and blocks equal-gross residual exposure', () => {
    const plan = prepare(); plan.buy.feeCaps.BTC = '0.001';
    const state = replaySettlementJournal(opening, [plan,
      fillEvent('buy', fill('buy-fill', '0.1', '10', funds({ BTC: '0.001' }))),
      fillEvent('sell', fill('sell-fill', '0.1', '11')),
      terminal('buy', totals('0.1', '10', funds({ BTC: '0.001' }))), terminal('sell', totals('0.1', '11'))]);
    const view = viewSettlementState(state);
    expect(view.balances.okx.BTC).toBe('1.099');
    expect(view.positions[0]).toMatchObject({ residualBtc: '-0.001', cashDeltaUsdt: '1',
      feesByAsset: funds({ BTC: '0.001' }), settlement: 'residual-exposure' });
    unchangedOnError(state, prepare({ id: 'next', pairId: 'next', at: T + 3 }), 'unresolved-exposure');
  });

  it('balances a separately specified gross buy only after explicit BTC fee subtraction', () => {
    const plan = prepare();
    plan.buy.sizing = { kind: 'base', baseQuantity: '0.101', maxQuoteAmount: '20' };
    plan.buy.feeCaps.BTC = '0.001';
    const state = replaySettlementJournal(opening, [plan,
      fillEvent('buy', fill('buy-fill', '0.101', '10.1', funds({ BTC: '0.001' }))),
      fillEvent('sell', fill('sell-fill', '0.1', '11')),
      terminal('buy', totals('0.101', '10.1', funds({ BTC: '0.001' }))), terminal('sell', totals('0.1', '11'))]);
    expect(viewSettlementState(state).positions[0]).toMatchObject({ residualBtc: '0', cashDeltaUsdt: '0.9', settlement: 'balanced' });
    const next = prepare({ id: 'next', pairId: 'next', at: T + 3 });
    next.buy.orderId = 'buy-2'; next.sell.orderId = 'sell-2';
    expect(viewSettlementState(applySettlementEvent(state, next)).positions).toHaveLength(2);
  });

  it('adds explicit USDT and MX fees over partial fills at 18-decimal precision', () => {
    const plan = prepare(); plan.buy.feeCaps = funds({ USDT: '0.1', MX: '1' });
    let state = prepared(plan);
    state = applySettlementEvent(state, fillEvent('buy', fill('first', '0.03', '3.000000000000000001',
      funds({ USDT: '0.000000000000000001', MX: '0.123456789012345678' }))));
    state = applySettlementEvent(state, fillEvent('buy', fill('second', '0.07', '6.999999999999999999',
      funds({ USDT: '0.000000000000000002', MX: '0.000000000000000009' }))));
    const sum = totals('0.1', '10', funds({ USDT: '0.000000000000000003', MX: '0.123456789012345687' }));
    expect(viewSettlementState(state).positions[0].legs.buy).toMatchObject({ status: 'partial', fills: 2, ...sum });
    expect(viewSettlementState(state).balances.okx).toEqual({ BTC: '1.1', USDT: '89.999999999999999997', MX: '4.876543210987654313' });
    state = applySettlementEvent(state, terminal('buy', sum));
    expect(viewSettlementState(state).reserved.okx).toEqual(funds());
  });

  it('accounts separately for sell-side BTC, quote and MX fee amounts', () => {
    const plan = prepare(); plan.sell.feeCaps = funds({ BTC: '0.001', USDT: '0.03', MX: '0.2' });
    const fees = funds({ BTC: '0.001', USDT: '0.03', MX: '0.2' });
    const state = applySettlementEvent(prepared(plan), fillEvent('sell', fill('sell-fill', '0.1', '11', fees)));
    expect(viewSettlementState(state).balances.mexc).toEqual({ BTC: '0.899', USDT: '110.97', MX: '4.8' });
    expect(viewSettlementState(state).positions[0]).toMatchObject({ residualBtc: '-0.101', feesByAsset: fees });
  });

  it('keeps a quote budget separate from the additional USDT fee reserve and releases only on terminal proof', () => {
    const plan = prepare(); plan.buy.sizing = { kind: 'quote-budget', quoteAmount: '10' };
    plan.buy.feeCaps.USDT = '0.2';
    let state = prepared(plan);
    expect(viewSettlementState(state).reserved.okx.USDT).toBe('10.2');
    state = applySettlementEvent(state, fillEvent('buy', fill('budget-fill', '0.1', '9.9', funds({ USDT: '0.099' }))));
    expect(viewSettlementState(state).reserved.okx.USDT).toBe('0.201');
    unchangedOnError(state, terminal('buy', totals('0.1', '9.9')), 'incomplete-or-conflicting-fill-totals');
    state = applySettlementEvent(state, terminal('buy', totals('0.1', '9.9', funds({ USDT: '0.099' }))));
    const view = viewSettlementState(state);
    expect(view.reserved.okx.USDT).toBe('0');
    expect(view.available.okx.USDT).toBe('90.001');
    expect(view.positions[0].legs.buy.status).toBe('filled');
  });

  it('does not treat reaching the base quantity as terminal or release unused fee reserves', () => {
    const plan = prepare(); plan.buy.feeCaps = funds({ USDT: '1', MX: '1' });
    const state = applySettlementEvent(prepared(plan), fillEvent('buy', fill('full-size')));
    expect(viewSettlementState(state).positions[0].legs.buy.status).toBe('partial');
    expect(viewSettlementState(state).reserved.okx).toEqual(funds({ USDT: '11', MX: '1' }));
  });

  it('releases unspent capital after a cancelled partial order while preserving actual fills and exposure', () => {
    let state = prepared();
    state = applySettlementEvent(state, fillEvent('buy', fill('part', '0.03', '3')));
    state = applySettlementEvent(state, terminal('buy', totals('0.03', '3'), 'cancelled'));
    expect(viewSettlementState(state).reserved.okx).toEqual(funds());
    expect(viewSettlementState(state).balances.okx).toEqual({ BTC: '1.03', USDT: '97', MX: '5' });
    expect(viewSettlementState(state).positions[0]).toMatchObject({ residualBtc: '0.03', settlement: 'pending' });
  });
});

describe('settlement capital, caps and validation', () => {
  it.each([
    ['buy quote', 'okx', 'USDT', '0'], ['sell inventory', 'mexc', 'BTC', '0']
  ] as const)('cannot fund %s from the other venue', (_label, venue, asset, value) => {
    const balances = structuredClone(opening); balances[venue][asset] = value;
    balances[venue === 'okx' ? 'mexc' : 'okx'][asset] = '999999';
    unchangedOnError(createSettlementState(balances), prepare(), 'insufficient-funds-or-reservation');
  });

  it('requires the external MX fee reserve on the exact venue and cannot pay it from another account', () => {
    const plan = prepare(); plan.buy.feeCaps.MX = '0.1';
    const balances = structuredClone(opening); balances.okx.MX = '0'; balances.mexc.MX = '1000';
    unchangedOnError(createSettlementState(balances), plan, 'insufficient-funds-or-reservation');
  });

  it.each([
    ['quote budget', fill('bad', '0.1', '20.000000000000000001'), 'quote-budget-exceeded'],
    ['buy base cap', fill('bad', '0.100000000000000001', '10'), 'base-cap-exceeded'],
    ['USDT fee cap', fill('bad', '0.1', '10', funds({ USDT: '0.000000000000000001' })), 'fee-cap-exceeded'],
    ['MX fee cap', fill('bad', '0.1', '10', funds({ MX: '0.000000000000000001' })), 'fee-cap-exceeded']
  ])('rejects %s overspending atomically', (_label, value, reason) => {
    unchangedOnError(prepared(), fillEvent('buy', value as SettlementFill), reason as string);
  });

  it('enforces cumulative caps across fills instead of checking each fill in isolation', () => {
    const plan = prepare(); plan.buy.feeCaps.MX = '0.1';
    const state = applySettlementEvent(prepared(plan), fillEvent('buy', fill('part', '0.05', '10', funds({ MX: '0.06' }))));
    unchangedOnError(state, fillEvent('buy', fill('over', '0.05', '10', funds({ MX: '0.05' }))), 'fee-cap-exceeded');
    unchangedOnError(state, fillEvent('buy', fill('over', '0.05', '10.000000000000000001')), 'quote-budget-exceeded');
    unchangedOnError(state, fillEvent('buy', fill('over', '0.050000000000000001', '1')), 'base-cap-exceeded');
  });

  it('cannot sell more than the independent sell cap', () => {
    unchangedOnError(prepared(), fillEvent('sell', fill('bad', '0.100000000000000001', '11')), 'base-cap-exceeded');
  });

  it.each(['buy', 'sell'] as const)('does not use pre-existing funds to hide a %s fee exceeding proceeds', side => {
    const plan = prepare();
    const asset = side === 'buy' ? 'BTC' : 'USDT';
    const fees = side === 'buy' ? funds({ BTC: '0.101' }) : funds({ USDT: '10.01' });
    plan[side].feeCaps[asset] = fees[asset];
    unchangedOnError(prepared(plan), fillEvent(side, fill('bad', '0.1', '10', fees)), 'fee-exceeds-received-asset');
  });

  it.each([
    ['omitted fee object', (value: Record<string, unknown>) => { delete value.fees; }],
    ['omitted fee asset', (value: Record<string, unknown>) => { delete (value.fees as Record<string, string>).MX; }],
    ['unknown fee asset', (value: Record<string, unknown>) => { (value.fees as Record<string, string>).BNB = '1'; }],
    ['negative fee/rebate', (value: Record<string, unknown>) => { (value.fees as Record<string, string>).USDT = '-0.1'; }],
    ['numeric fee', (value: Record<string, unknown>) => { (value.fees as Record<string, unknown>).USDT = 0; }],
    ['19-decimal fee', (value: Record<string, unknown>) => { (value.fees as Record<string, string>).USDT = '0.0000000000000000001'; }]
  ])('rejects %s instead of inferring fee values', (_label, corrupt) => {
    const value = structuredClone(fill('bad')) as unknown as Record<string, unknown>; corrupt(value);
    unchangedOnError(prepared(), { ...fillEvent('buy', fill('bad')), fill: value }, 'invalid-settlement-event');
  });

  it.each(['-1', 'NaN', '1e-8', '00.1', '0.0000000000000000001'])('rejects invalid opening amount %s', value => {
    const balances = structuredClone(opening); balances.okx.USDT = value;
    expect(() => createSettlementState(balances)).toThrow('invalid-opening-balances');
  });

  it('requires positive fill amounts and matching full base totals', () => {
    unchangedOnError(prepared(), fillEvent('buy', fill('zero', '0', '10')), 'non-positive-fill');
    unchangedOnError(prepared(), fillEvent('buy', fill('zero', '0.1', '0')), 'non-positive-fill');
    let state = applySettlementEvent(prepared(), fillEvent('buy', fill('part', '0.05', '5')));
    unchangedOnError(state, terminal('buy', totals('0.05', '5')), 'filled-base-size-mismatch');
    unchangedOnError(state, terminal('buy', totals('0.05', '5'), 'rejected'), 'rejected-order-has-fills');
    state = prepared();
    unchangedOnError(state, terminal('buy', totals('0', '0')), 'filled-order-is-empty');
  });
});

describe('unknown outcomes, immutable reconciliation and event identity', () => {
  it('retains reserves while unknown and reconciles old execution explicitly without resubmission', () => {
    const plan = prepare(); plan.buy.feeCaps.USDT = '0.1';
    let state = prepared(plan);
    state = applySettlementEvent(state, fillEvent('buy', fill('known', '0.03', '3', funds({ USDT: '0.03' }))));
    const reserve = viewSettlementState(state).reserved.okx;
    state = applySettlementEvent(state, { type: 'unknown', id: 'timeout', at: T + 2, pairId: 'pair-1', side: 'buy' });
    expect(viewSettlementState(state).reserved.okx).toEqual(reserve);
    unchangedOnError(state, fillEvent('buy', fill('late', '0.07', '7'), 'late-event', T + 3), 'reconciliation-required');
    unchangedOnError(state, terminal('buy', totals('0.03', '3', funds({ USDT: '0.03' })), 'cancelled', T + 3), 'reconciliation-required');
    state = applySettlementEvent(state, { type: 'reconcile', id: 'reconcile', at: T + 86_400_000, pairId: 'pair-1', side: 'buy', outcome: 'filled',
      fills: [fill('known', '0.03', '3', funds({ USDT: '0.03' })), fill('late', '0.07', '7', funds({ USDT: '0.07' }), T + 2)],
      totals: totals('0.1', '10', funds({ USDT: '0.1' })) });
    expect(viewSettlementState(state).balances.okx.USDT).toBe('89.9');
    expect(viewSettlementState(state).reserved.okx).toEqual(funds());
    expect(viewSettlementState(state).positions[0].legs.buy).toMatchObject({ status: 'filled', fills: 2 });
  });

  it('retains the remaining reserve after an explicit open reconciliation', () => {
    const state = applySettlementEvent(prepared(), { type: 'unknown', id: 'unknown', at: T + 1, pairId: 'pair-1', side: 'buy' });
    const next = applySettlementEvent(state, { type: 'reconcile', id: 'open-proof', at: T + 10, pairId: 'pair-1', side: 'buy', outcome: 'open',
      fills: [fill('known', '0.03', '3')], totals: totals('0.03', '3') });
    expect(viewSettlementState(next).positions[0].legs.buy.status).toBe('partial');
    expect(viewSettlementState(next).reserved.okx.USDT).toBe('17');
  });

  it('rolls back every fill when the second reconciliation fill or aggregate total is invalid', () => {
    const state = applySettlementEvent(prepared(), { type: 'unknown', id: 'unknown', at: T + 1, pairId: 'pair-1', side: 'buy' });
    const base: SettlementEvent = { type: 'reconcile', id: 'proof', at: T + 10, pairId: 'pair-1', side: 'buy', outcome: 'filled',
      fills: [fill('good', '0.05', '5'), fill('bad', '0.06', '6')], totals: totals('0.11', '11') };
    unchangedOnError(state, base, 'base-cap-exceeded');
    unchangedOnError(state, { ...base, fills: [fill('good', '0.05', '5'), fill('good-2', '0.05', '5')], totals: totals('0.1', '11') },
      'incomplete-or-conflicting-fill-totals');
    unchangedOnError(state, { ...base, fills: [fill('good', '0.05', '5')], totals: totals('0.05', '5'), outcome: 'rejected' },
      'rejected-order-has-fills');
  });

  it('requires reconciliation only on a leg with an unknown outcome', () => {
    unchangedOnError(prepared(), { type: 'reconcile', id: 'proof', at: T + 1, pairId: 'pair-1', side: 'buy', outcome: 'rejected',
      fills: [], totals: totals('0', '0') }, 'reconciliation-not-required');
  });

  it('deduplicates event IDs without journal growth and refuses conflicting reuse', () => {
    const event = fillEvent('buy', fill('once'));
    const state = applySettlementEvent(prepared(), event);
    expect(applySettlementEvent(state, structuredClone(event))).toBe(state);
    unchangedOnError(state, { ...event, at: T + 2 }, 'event-id-conflict');
  });

  it('records a new delivery ID after terminal status without posting an economic fill twice', () => {
    const state = balanced();
    const next = applySettlementEvent(state, fillEvent('buy', fill('buy-fill'), 'redelivery', T + 100));
    const before = viewSettlementState(state), after = viewSettlementState(next);
    expect(after.balances).toEqual(before.balances);
    expect(after.positions).toEqual(before.positions);
    expect(after.journalEvents).toBe(before.journalEvents + 1);
    unchangedOnError(next, fillEvent('buy', fill('buy-fill', '0.1', '10.1'), 'conflict', T + 101), 'fill-id-conflict');
    unchangedOnError(next, fillEvent('buy', fill('new-fill', '0.01', '1'), 'new-fill', T + 101), 'terminal-leg');
  });

  it('does not duplicate repeated fill IDs within a reconciliation batch', () => {
    const state = applySettlementEvent(prepared(), { type: 'unknown', id: 'unknown', at: T + 1, pairId: 'pair-1', side: 'buy' });
    const value = fill('same');
    const next = applySettlementEvent(state, { type: 'reconcile', id: 'proof', at: T + 2, pairId: 'pair-1', side: 'buy', outcome: 'filled',
      fills: [value, structuredClone(value)], totals: totals() });
    expect(viewSettlementState(next).balances.okx.BTC).toBe('1.1');
    expect(viewSettlementState(next).positions[0].legs.buy.fills).toBe(1);
    unchangedOnError(state, { type: 'reconcile', id: 'conflict', at: T + 2, pairId: 'pair-1', side: 'buy', outcome: 'filled',
      fills: [value, { ...value, quoteQuantity: '9' }], totals: totals() }, 'fill-id-conflict');
  });

  it('rejects reusing an order ID on its venue even for the opposite side of a new pair', () => {
    const next = prepare({ id: 'prepare-2', pairId: 'pair-2', at: T + 3 });
    next.buy = { ...next.buy, venue: 'mexc', orderId: 'buy-2' };
    next.sell = { ...next.sell, venue: 'okx', orderId: 'buy-1' };
    unchangedOnError(balanced(), next, 'order-id-conflict');
  });

  it('keeps order and fill identities scoped to their venue and order', () => {
    const plan = prepare(); plan.buy.orderId = 'same-order-id'; plan.sell.orderId = 'same-order-id';
    let state = prepared(plan);
    state = applySettlementEvent(state, fillEvent('buy', fill('same-fill-id'), 'buy-event'));
    state = applySettlementEvent(state, fillEvent('sell', fill('same-fill-id'), 'sell-event'));
    expect(viewSettlementState(state).positions[0].legs.buy.fills).toBe(1);
    expect(viewSettlementState(state).positions[0].legs.sell.fills).toBe(1);
  });

  it('rejects unknown pairs, conflicting pair IDs and any overlap while an earlier leg is pending', () => {
    unchangedOnError(prepared(), { ...fillEvent('buy', fill('x')), pairId: 'missing' }, 'unknown-pair');
    unchangedOnError(prepared(), prepare({ id: 'other', at: T + 1 }), 'pair-id-conflict');
    unchangedOnError(prepared(), prepare({ id: 'other', pairId: 'other', at: T + 1 }), 'unresolved-exposure');
  });

  it('rejects event time regression and fill executions before preparation or after observation', () => {
    const state = applySettlementEvent(prepared(), fillEvent('buy', fill('known', '0.03', '3'), 'known', T + 10));
    unchangedOnError(state, fillEvent('buy', fill('old', '0.03', '3'), 'old-event', T + 9), 'out-of-order-event');
    unchangedOnError(state, fillEvent('buy', fill('pre', '0.03', '3', funds(), T - 1), 'pre-event', T + 11), 'invalid-fill-time');
    unchangedOnError(state, fillEvent('buy', fill('future', '0.03', '3', funds(), T + 12), 'future-event', T + 11), 'invalid-fill-time');
  });

  it('replays exactly through a restart, unknown outcome and duplicate delivery with decimal fees', () => {
    const plan = prepare(); plan.buy.feeCaps = funds({ BTC: '0.001', MX: '0.1' });
    const journal: SettlementEvent[] = [plan,
      fillEvent('buy', fill('part', '0.03', '3', funds({ BTC: '0.0003', MX: '0.000000000000000001' }))),
      { type: 'unknown', id: 'unknown', at: T + 2, pairId: 'pair-1', side: 'buy' },
      { type: 'reconcile', id: 'proof', at: T + 100, pairId: 'pair-1', side: 'buy', outcome: 'filled',
        fills: [fill('last', '0.07', '7', funds({ BTC: '0.0007', MX: '0.000000000000000002' }), T + 3)],
        totals: totals('0.1', '10', funds({ BTC: '0.001', MX: '0.000000000000000003' })) },
      fillEvent('buy', fill('part', '0.03', '3', funds({ BTC: '0.0003', MX: '0.000000000000000001' })), 'redelivery', T + 101),
      terminal('sell', totals('0', '0'), 'rejected', T + 102)];
    const all = journal.reduce(applySettlementEvent, createSettlementState(opening));
    const restored = journal.slice(3).reduce(applySettlementEvent, replaySettlementJournal(opening, journal.slice(0, 3)));
    expect(restored).toEqual(all);
    expect(replaySettlementJournal(opening, JSON.parse(JSON.stringify(journal)))).toEqual(all);
    expect(viewSettlementState(all).positions[0]).toMatchObject({ residualBtc: '0.099', settlement: 'residual-exposure',
      feesByAsset: funds({ BTC: '0.001', MX: '0.000000000000000003' }) });
    expect(viewSettlementState(createSettlementState(opening)).balances).toEqual(opening);
  });
});
