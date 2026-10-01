import { describe, expect, it } from 'vitest';
import {
  applyPaperRiskEvent, assessPaperPairRisk, createPaperRiskState, PaperRiskError,
  replayPaperRiskJournal, viewPaperRiskState
} from '../src/paper-pair/risk.js';
import { viewSettlementState, type SettlementBalances, type SettlementEvent, type SettlementFunds } from '../src/paper-pair/settlement.js';

type Prepare = Extract<SettlementEvent, { type: 'prepare' }>;
type Policy = Parameters<typeof createPaperRiskState>[1];
type RiskState = ReturnType<typeof createPaperRiskState>;
const T = 1_800_000_000_000;
const funds = (value: Partial<SettlementFunds> = {}): SettlementFunds => ({ BTC: '0', USDT: '0', MX: '0', ...value });
const opening: SettlementBalances = {
  mexc: { BTC: '1', USDT: '100', MX: '5' },
  okx: { BTC: '1', USDT: '100', MX: '5' }
};
function policy(changes: Partial<Policy> = {}): Policy {
  return {
    schema: 1, kind: 'synthetic-pair-risk-policy', policyId: 'test-policy',
    maxBuyDebitUsdt: '20', maxSingleLegBtc: '0.1', maxSessionCashLossUsdt: '100',
    maxSessionFees: funds({ BTC: '1', USDT: '10', MX: '10' }),
    minFreeAfterReserve: { mexc: funds(), okx: funds() }, ...changes
  };
}
function prepare(number = 1, changes: Partial<Prepare> = {}): Prepare {
  return {
    type: 'prepare', id: `prepare-${number}`, pairId: `pair-${number}`, at: T + number * 10,
    buy: { venue: 'okx', orderId: `buy-${number}`, sizing: { kind: 'base', baseQuantity: '0.1', maxQuoteAmount: '20' }, feeCaps: funds() },
    sell: { venue: 'mexc', orderId: `sell-${number}`, baseQuantity: '0.1', feeCaps: funds() }, ...changes
  };
}
function state(rules = policy(), balances = opening): RiskState { return createPaperRiskState(balances, rules); }
function reasons(state: RiskState, plan: Prepare): string[] { return assessPaperPairRisk(state, plan).reasons; }
function completedEvents(plan: Prepare, options: {
  buyBase?: string; sellBase?: string; buyQuote?: string; sellQuote?: string;
  buyFees?: SettlementFunds; sellFees?: SettlementFunds
} = {}): SettlementEvent[] {
  const buyTotals = { baseQuantity: options.buyBase ?? (plan.buy.sizing.kind === 'base' ? plan.buy.sizing.baseQuantity : '0.1'),
    quoteQuantity: options.buyQuote ?? '10', fees: options.buyFees ?? funds() };
  const sellTotals = { baseQuantity: options.sellBase ?? plan.sell.baseQuantity,
    quoteQuantity: options.sellQuote ?? '11', fees: options.sellFees ?? funds() };
  return [plan,
    { type: 'fill', id: `${plan.pairId}-buy-fill-event`, at: plan.at + 1, pairId: plan.pairId, side: 'buy',
      fill: { fillId: `${plan.pairId}-buy-fill`, executedAt: plan.at + 1, ...buyTotals } },
    { type: 'fill', id: `${plan.pairId}-sell-fill-event`, at: plan.at + 2, pairId: plan.pairId, side: 'sell',
      fill: { fillId: `${plan.pairId}-sell-fill`, executedAt: plan.at + 2, ...sellTotals } },
    { type: 'settle', id: `${plan.pairId}-buy-terminal`, at: plan.at + 3, pairId: plan.pairId, side: 'buy', outcome: 'filled', totals: buyTotals },
    { type: 'settle', id: `${plan.pairId}-sell-terminal`, at: plan.at + 4, pairId: plan.pairId, side: 'sell', outcome: 'filled', totals: sellTotals }
  ];
}
function applyAll(state: RiskState, events: readonly SettlementEvent[]): RiskState {
  return events.reduce(applyPaperRiskEvent, state);
}
function expectRiskRejection(before: RiskState, plan: Prepare, reason: string): void {
  const unchanged = structuredClone(before);
  expect(reasons(before, plan)).toContain(reason);
  let error: unknown;
  try { applyPaperRiskEvent(before, plan); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(PaperRiskError);
  expect((error as PaperRiskError).reasons).toContain(reason);
  expect(before).toEqual(unchanged);
}

describe('synthetic pair admission and exact policy boundaries', () => {
  it('assesses without posting or mutating any input, with explicit non-execution markers', () => {
    const rules = policy(), initial = structuredClone(opening), plan = prepare();
    const before = createPaperRiskState(initial, rules);
    const copies = structuredClone({ before, rules, initial, plan });
    const decision = assessPaperPairRisk(before, plan);
    expect(decision).toMatchObject({ schema: 1, kind: 'paper-pair-risk-decision', executable: false,
      funding: 'synthetic', paperAllowed: true, duplicate: false, reasons: [],
      metrics: { buyDebitUsdt: '20', maxSingleLegBtc: '0.1', sessionCashLossUsdt: '0',
        sessionCashLossWithBuyDebitUsdt: '20', sessionFees: funds(), sessionFeesWithCaps: funds() } });
    expect(decision.projectedAvailable).toEqual({ mexc: { BTC: '0.9', USDT: '100', MX: '5' }, okx: { BTC: '1', USDT: '80', MX: '5' } });
    expect({ before, rules, initial, plan }).toEqual(copies);
    expect(before.settlement.journal).toHaveLength(0);
  });

  it('admits an exact debit cap and denies an extra 18-decimal unit including the buy fee', () => {
    const plan = prepare(); plan.buy.feeCaps.USDT = '0.000000000000000001';
    const decision = assessPaperPairRisk(state(), plan);
    expect(decision.metrics?.buyDebitUsdt).toBe('20.000000000000000001');
    expectRiskRejection(state(), plan, 'buy-debit-limit');
    expect(assessPaperPairRisk(state(policy({ maxBuyDebitUsdt: '20.000000000000000001' })), plan).paperAllowed).toBe(true);
  });

  it('counts the sell-side BTC fee in potential short exposure', () => {
    const plan = prepare(); plan.sell.feeCaps.BTC = '0.000000000000000001';
    const decision = assessPaperPairRisk(state(), plan);
    expect(decision.metrics?.maxSingleLegBtc).toBe('0.100000000000000001');
    expectRiskRejection(state(), plan, 'single-leg-exposure-limit');
    expect(assessPaperPairRisk(state(policy({ maxSingleLegBtc: '0.100000000000000001' })), plan).paperAllowed).toBe(true);
  });

  it('uses the gross buy upper bound rather than subtracting a fee cap that may not be charged', () => {
    const plan = prepare();
    plan.buy.sizing = { kind: 'base', baseQuantity: '0.100000000000000001', maxQuoteAmount: '20' };
    plan.buy.feeCaps.BTC = '0.000000000000000001';
    expect(assessPaperPairRisk(state(), plan).metrics?.maxSingleLegBtc).toBe('0.100000000000000001');
    expectRiskRejection(state(), plan, 'single-leg-exposure-limit');
  });

  it('takes the maximum possible one-sided quantity rather than adding both opposing legs', () => {
    expect(assessPaperPairRisk(state(), prepare()).metrics?.maxSingleLegBtc).toBe('0.1');
    expect(assessPaperPairRisk(state(), prepare()).paperAllowed).toBe(true);
  });

  it('refuses to infer a maximum bought BTC quantity from a quote budget', () => {
    const plan = prepare(); plan.buy.sizing = { kind: 'quote-budget', quoteAmount: '10' };
    expectRiskRejection(state(), plan, 'quote-budget-unbounded-base-exposure');
  });

  it.each(['maxBuyDebitUsdt', 'maxSingleLegBtc', 'maxSessionCashLossUsdt'] as const)('requires an explicit positive %s', key => {
    for (const value of ['0', '-1', 'NaN', '1e3', '01', '0.0000000000000000001']) {
      expect(() => state(policy({ [key]: value }))).toThrow();
    }
    const missing = policy() as unknown as Record<string, unknown>; delete missing[key];
    expect(() => state(missing as Policy)).toThrow();
  });

  it('rejects malformed nested limits and unknown policy fields instead of silently defaulting', () => {
    expect(() => state({ ...policy(), live: true } as Policy)).toThrow();
    const badFee = policy(); badFee.maxSessionFees.MX = '-1'; expect(() => state(badFee)).toThrow();
    const badFloor = policy(); badFloor.minFreeAfterReserve.okx.BTC = '1e-8'; expect(() => state(badFloor)).toThrow();
    const missing = policy() as unknown as Record<string, unknown>; delete missing.maxSessionFees;
    expect(() => state(missing as Policy)).toThrow();
  });

  it('copies the policy and provides a deterministic hash sensitive to a limit change', () => {
    const input = policy(), before = state(input), first = viewPaperRiskState(before);
    expect(first.policyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(viewPaperRiskState(state(policy())).policyHash).toBe(first.policyHash);
    input.maxBuyDebitUsdt = '19'; input.maxSessionFees.MX = '0';
    expect(before.policy.maxBuyDebitUsdt).toBe('20');
    expect(before.policy.maxSessionFees.MX).toBe('10');
    expect(viewPaperRiskState(state(policy({ maxBuyDebitUsdt: '19' }))).policyHash).not.toBe(first.policyHash);
  });
});

describe('prefunded venue depletion and fee-asset budgets', () => {
  it('checks exact per-venue funds through the settlement engine despite a rich opposite venue', () => {
    const balances = structuredClone(opening); balances.okx.USDT = '0'; balances.mexc.USDT = '1000000';
    expectRiskRejection(state(policy(), balances), prepare(), 'settlement:insufficient-funds-or-reservation');
  });

  it('keeps an exact minimum free balance after reserving and denies one extra unit', () => {
    const rules = policy(); rules.minFreeAfterReserve.okx.USDT = '80';
    expect(assessPaperPairRisk(state(rules), prepare()).paperAllowed).toBe(true);
    rules.minFreeAfterReserve.okx.USDT = '80.000000000000000001';
    expectRiskRejection(state(rules), prepare(), 'wallet-floor:okx:USDT');
  });

  it('stops repeated cash-positive pairs when the buy venue falls below its floor', () => {
    const balances = structuredClone(opening); balances.okx.USDT = '31';
    const rules = policy(); rules.minFreeAfterReserve.okx.USDT = '5';
    const after = applyAll(state(rules, balances), completedEvents(prepare()));
    expect(viewSettlementState(after.settlement).positions[0].cashDeltaUsdt).toBe('1');
    expect(viewSettlementState(after.settlement).balances.okx.USDT).toBe('21');
    expect(viewSettlementState(after.settlement).balances.mexc.USDT).toBe('111');
    expectRiskRejection(after, prepare(2), 'wallet-floor:okx:USDT');
  });

  it('stops the selling venue inventory from draining despite growth on the buying venue', () => {
    const balances = structuredClone(opening); balances.mexc.BTC = '0.25';
    const rules = policy(); rules.minFreeAfterReserve.mexc.BTC = '0.1';
    const after = applyAll(state(rules, balances), completedEvents(prepare()));
    expect(viewSettlementState(after.settlement).balances.mexc.BTC).toBe('0.15');
    expect(viewSettlementState(after.settlement).balances.okx.BTC).toBe('1.1');
    expectRiskRejection(after, prepare(2), 'wallet-floor:mexc:BTC');
  });

  it('applies native fee-currency floors to the exact wallet', () => {
    const plan = prepare(); plan.buy.feeCaps.MX = '0.3';
    const rules = policy(); rules.minFreeAfterReserve.okx.MX = '4.7';
    expect(assessPaperPairRisk(state(rules), plan).paperAllowed).toBe(true);
    rules.minFreeAfterReserve.okx.MX = '4.700000000000000001';
    expectRiskRejection(state(rules), plan, 'wallet-floor:okx:MX');
  });

  it.each(['BTC', 'USDT', 'MX'] as const)('reserves both legs within the independent %s fee budget', asset => {
    const rules = policy({ maxSingleLegBtc: '1' }); rules.maxSessionFees[asset] = '0.3';
    const plan = prepare(); plan.buy.feeCaps[asset] = '0.1'; plan.sell.feeCaps[asset] = '0.2';
    if (asset === 'USDT') rules.maxBuyDebitUsdt = '20.1';
    expect(assessPaperPairRisk(state(rules), plan).paperAllowed).toBe(true);
    plan.sell.feeCaps[asset] = '0.200000000000000001';
    expectRiskRejection(state(rules), plan, `session-fee-limit:${asset}`);
  });

  it('charges actual historical fees, releases unused caps, and reserves future caps once', () => {
    const rules = policy(); rules.maxSessionFees.MX = '0.7';
    const first = prepare(); first.buy.feeCaps.MX = '0.5';
    const after = applyAll(state(rules), completedEvents(first, { buyFees: funds({ MX: '0.1' }) }));
    const second = prepare(2); second.buy.feeCaps.MX = '0.3'; second.sell.feeCaps.MX = '0.3';
    const assessment = assessPaperPairRisk(after, second);
    expect(assessment.paperAllowed).toBe(true);
    expect(assessment.metrics?.sessionFees.MX).toBe('0.1');
    expect(assessment.metrics?.sessionFeesWithCaps.MX).toBe('0.7');
    second.sell.feeCaps.MX = '0.300000000000000001';
    expectRiskRejection(after, second, 'session-fee-limit:MX');
  });

  it('permits a separately sized gross buy that compensates explicit BTC fees', () => {
    const rules = policy({ maxSingleLegBtc: '0.101' });
    const plan = prepare(); plan.buy.sizing = { kind: 'base', baseQuantity: '0.101', maxQuoteAmount: '20' };
    plan.buy.feeCaps.BTC = '0.001';
    const after = applyAll(state(rules), completedEvents(plan, { buyFees: funds({ BTC: '0.001' }), buyQuote: '10.1' }));
    expect(viewSettlementState(after.settlement).positions[0]).toMatchObject({ settlement: 'balanced', residualBtc: '0', cashDeltaUsdt: '0.9' });
    expect(viewPaperRiskState(after).sessionUsage.fees.BTC).toBe('0.001');
    expect(assessPaperPairRisk(after, prepare(2)).paperAllowed).toBe(true);
  });
});

describe('conservative cash-loss allowance and observed-event accounting', () => {
  it('admits exactly the remaining allowance and reserves the entire new buy debit', () => {
    const rules = policy({ maxSessionCashLossUsdt: '20' });
    expect(assessPaperPairRisk(state(rules), prepare()).paperAllowed).toBe(true);
    const after = applyAll(state(rules), completedEvents(prepare(), { sellQuote: '9' }));
    const decision = assessPaperPairRisk(after, prepare(2));
    expect(decision.metrics).toMatchObject({ sessionCashLossUsdt: '1', sessionCashLossWithBuyDebitUsdt: '21' });
    expectRiskRejection(after, prepare(2), 'session-cash-loss-limit');
    const smaller = prepare(2); smaller.buy.sizing = { kind: 'base', baseQuantity: '0.1', maxQuoteAmount: '19' };
    expect(assessPaperPairRisk(after, smaller).paperAllowed).toBe(true);
  });

  it('does not use earlier gains to replenish the gross loss allowance', () => {
    const rules = policy({ maxSessionCashLossUsdt: '20' });
    let after = applyAll(state(rules), completedEvents(prepare(), { sellQuote: '11' }));
    after = applyAll(after, completedEvents(prepare(2), { sellQuote: '9' }));
    expect(viewPaperRiskState(after).sessionUsage.closedCashLossUsdt).toBe('1');
    const values = viewSettlementState(after.settlement).positions.map(position => position.cashDeltaUsdt);
    expect(values).toEqual(['1', '-1']);
    expectRiskRejection(after, prepare(3), 'session-cash-loss-limit');
  });

  it('does not replenish prior losses after a later gain or reset them at UTC midnight', () => {
    const rules = policy({ maxBuyDebitUsdt: '21', maxSessionCashLossUsdt: '21' });
    const nextMidnight = (Math.floor(T / 86_400_000) + 1) * 86_400_000;
    const losing = prepare(1, { at: nextMidnight - 10 });
    const gaining = prepare(2, { at: nextMidnight + 10 });
    const history = [...completedEvents(losing, { sellQuote: '9' }), ...completedEvents(gaining, { sellQuote: '12' })];
    const beforeMidnight = applyAll(state(rules), history.slice(0, 5));
    expect(viewPaperRiskState(beforeMidnight).sessionUsage.closedCashLossUsdt).toBe('1');
    const afterMidnight = applyAll(beforeMidnight, history.slice(5));
    expect(viewPaperRiskState(afterMidnight).sessionUsage.closedCashLossUsdt).toBe('1');
    expect(viewSettlementState(afterMidnight.settlement).positions.map(position => position.cashDeltaUsdt)).toEqual(['-1', '2']);
    const next = prepare(3, { at: nextMidnight + 20 });
    expect(assessPaperPairRisk(afterMidnight, next).metrics?.sessionCashLossWithBuyDebitUsdt).toBe('21');
    next.buy.sizing = { kind: 'base', baseQuantity: '0.1', maxQuoteAmount: '20.000000000000000001' };
    expectRiskRejection(afterMidnight, next, 'session-cash-loss-limit');
    const restored = replayPaperRiskJournal(opening, rules, history);
    expect(viewPaperRiskState(restored).sessionUsage).toEqual(viewPaperRiskState(afterMidnight).sessionUsage);
    expect(assessPaperPairRisk(restored, next)).toEqual(assessPaperPairRisk(afterMidnight, next));
  });

  it('keeps 18-decimal realized cash losses and rejects even a one-unit overshoot', () => {
    const rules = policy({ maxSessionCashLossUsdt: '20' });
    const first = prepare(); first.buy.feeCaps.USDT = '0.000000000000000001';
    first.buy.sizing = { kind: 'base', baseQuantity: '0.1', maxQuoteAmount: '19' };
    const after = applyAll(state(rules), completedEvents(first, { sellQuote: '10', buyFees: funds({ USDT: '0.000000000000000001' }) }));
    expect(viewPaperRiskState(after).sessionUsage.closedCashLossUsdt).toBe('0.000000000000000001');
    expectRiskRejection(after, prepare(2), 'session-cash-loss-limit');
  });

  it('does not claim that MX fees are valued inside a positive USDT cash delta', () => {
    const plan = prepare(); plan.buy.feeCaps.MX = '0.25';
    const after = applyAll(state(), completedEvents(plan, { buyFees: funds({ MX: '0.25' }) }));
    expect(viewPaperRiskState(after).sessionUsage).toMatchObject({ closedCashLossUsdt: '0', fees: funds({ MX: '0.25' }) });
    expect(viewSettlementState(after.settlement).positions[0].cashDeltaUsdt).toBe('1');
  });

  it('counts no loss for two rejected legs with no execution', () => {
    const plan = prepare();
    const events: SettlementEvent[] = [plan, ...(['buy', 'sell'] as const).map((side, i) => ({
      type: 'settle' as const, id: `${side}-reject`, at: plan.at + i + 1, pairId: plan.pairId,
      side, outcome: 'rejected' as const, totals: { baseQuantity: '0', quoteQuantity: '0', fees: funds() }
    }))];
    const after = applyAll(state(), events);
    expect(viewPaperRiskState(after).sessionUsage.closedCashLossUsdt).toBe('0');
    expect(assessPaperPairRisk(after, prepare(2)).paperAllowed).toBe(true);
  });

  it('records every supplied fill and terminal fact even while the pending cash delta is negative', () => {
    const rules = policy({ maxSessionCashLossUsdt: '20' });
    const events = completedEvents(prepare(), { buyQuote: '20', sellQuote: '1' });
    let after = applyAll(state(rules), events.slice(0, 2));
    expect(viewSettlementState(after.settlement).positions[0].cashDeltaUsdt).toBe('-20');
    expect(viewPaperRiskState(after).sessionUsage.closedCashLossUsdt).toBe('0');
    after = applyAll(after, events.slice(2));
    expect(viewPaperRiskState(after).sessionUsage.closedCashLossUsdt).toBe('19');
    expect(after.settlement.journal).toHaveLength(5);
    expectRiskRejection(after, prepare(2), 'session-cash-loss-limit');
  });
});

describe('reconciliation, idempotency, durable replay and engine constraints', () => {
  it('retains the native unresolved-exposure guard instead of treating exposure allowance as overlap permission', () => {
    const after = applyPaperRiskEvent(state(), prepare());
    expectRiskRejection(after, prepare(2), 'settlement:unresolved-exposure');
  });

  it('keeps a residual shortage blocked even when a cash-gain pair is terminal', () => {
    const plan = prepare(); plan.buy.feeCaps.BTC = '0.001';
    const after = applyAll(state(), completedEvents(plan, { buyFees: funds({ BTC: '0.001' }) }));
    expect(viewSettlementState(after.settlement).positions[0]).toMatchObject({ settlement: 'residual-exposure', residualBtc: '-0.001', cashDeltaUsdt: '1' });
    expectRiskRejection(after, prepare(2), 'settlement:unresolved-exposure');
  });

  it('allows complete unknown reconciliation and restores the same decision after replay', () => {
    const rules = policy({ maxSessionCashLossUsdt: '20' });
    const plan = prepare(), full = completedEvents(plan, { sellQuote: '9' });
    const buy = full[1] as Extract<SettlementEvent, { type: 'fill' }>;
    const events: SettlementEvent[] = [plan,
      { type: 'unknown', id: 'timeout', at: plan.at + 1, pairId: plan.pairId, side: 'buy' },
      { type: 'reconcile', id: 'reconciled', at: plan.at + 2, pairId: plan.pairId, side: 'buy', outcome: 'filled',
        fills: [buy.fill], totals: { baseQuantity: buy.fill.baseQuantity, quoteQuantity: buy.fill.quoteQuantity, fees: buy.fill.fees } },
      full[2], full[4]];
    const after = applyAll(state(rules), events);
    const restored = replayPaperRiskJournal(opening, rules, JSON.parse(JSON.stringify(events)));
    expect(viewPaperRiskState(restored)).toEqual(viewPaperRiskState(after));
    expect(assessPaperPairRisk(restored, prepare(2))).toEqual(assessPaperPairRisk(after, prepare(2)));
    expectRiskRejection(restored, prepare(2), 'session-cash-loss-limit');
  });

  it('exact prepare retries are no-ops even after the session budget is consumed', () => {
    const rules = policy({ maxSessionCashLossUsdt: '20' }), plan = prepare();
    const after = applyAll(state(rules), completedEvents(plan, { sellQuote: '9' }));
    expect(assessPaperPairRisk(after, structuredClone(plan))).toMatchObject({ paperAllowed: true, duplicate: true, reasons: [] });
    const retried = applyPaperRiskEvent(after, structuredClone(plan));
    expect(retried.settlement.journal).toHaveLength(after.settlement.journal.length);
    expect(viewPaperRiskState(retried)).toEqual(viewPaperRiskState(after));
    expectRiskRejection(after, { ...plan, at: plan.at + 1 }, 'settlement:event-id-conflict');
  });

  it('economic fill duplicates preserve historical cash losses and native fees exactly', () => {
    const rules = policy({ maxSessionCashLossUsdt: '20' });
    const plan = prepare(); plan.buy.feeCaps.MX = '0.1';
    const events = completedEvents(plan, { sellQuote: '9', buyFees: funds({ MX: '0.1' }) });
    const after = applyAll(state(rules), events);
    const original = events[1] as Extract<SettlementEvent, { type: 'fill' }>;
    const redelivered = applyPaperRiskEvent(after, { ...original, id: 'redelivery', at: plan.at + 5 });
    expect(redelivered.settlement.journal).toHaveLength(after.settlement.journal.length + 1);
    expect(viewPaperRiskState(redelivered).sessionUsage).toEqual(viewPaperRiskState(after).sessionUsage);
    expect(viewSettlementState(redelivered.settlement).balances).toEqual(viewSettlementState(after.settlement).balances);
  });

  it('does not accept a historical journal containing a preparation disallowed by its policy', () => {
    const events = completedEvents(prepare());
    expect(() => replayPaperRiskJournal(opening, policy({ maxBuyDebitUsdt: '19' }), events)).toThrow(PaperRiskError);
  });

  it('continues to enforce malformed plans and observations through the existing engine', () => {
    const sameVenue = prepare(); sameVenue.sell.venue = sameVenue.buy.venue;
    expectRiskRejection(state(), sameVenue, 'settlement:same-venue');
    const after = applyPaperRiskEvent(state(), prepare());
    const invalid: SettlementEvent = { type: 'fill', id: 'overfill', at: T + 11, pairId: 'pair-1', side: 'buy',
      fill: { fillId: 'too-large', executedAt: T + 11, baseQuantity: '0.2', quoteQuantity: '1', fees: funds() } };
    expect(() => applyPaperRiskEvent(after, invalid)).toThrow();
    expect(after.settlement.journal).toHaveLength(1);
  });
});
