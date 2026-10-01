import { describe, expect, it } from 'vitest';
import { applyLiveOrderEvent, createLiveOrderState, type LiveOrderEvent, type LiveOrderIntent, type LiveOrderState } from '../src/live/order-lifecycle.js';
import { assessLiveOrderAdmission, assessLiveOrderDispatch, parseLiveOrderAdmissionPolicy } from '../src/live/order-admission-policy.js';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (n: number) => new Date(Date.UTC(2026, 8, 28, 12) + n * 1000).toISOString();
function policy() {
  return { schema: 1, kind: 'live-order-admission-policy', source: 'declared-synthetic', limits: { schema: 1, kind: 'live-limits-draft', account: 'main', symbol: 'BTC/USDT',
    totalCapitalUsdt: '400', capitalByVenueUsdt: { mexc: '200', okx: '200' }, maxOrderDebitUsdt: '150', maxCumulativeLossUsdt: '400', maxUnhedgedBtc: '1',
    includeEarn: false, transfersEnabled: false, withdrawalsEnabled: false }, initialBalances: {
      mexc: { BTC: '0', USDT: '1000', MX: '1' }, okx: { BTC: '0', USDT: '1000', MX: '0' } } };
}
function intent(n = 100, override: Partial<LiveOrderIntent> = {}): LiveOrderIntent {
  return { orderIntentId: uuid(n), venue: 'mexc', account: 'main', symbol: 'BTC/USDT', side: 'buy', orderType: 'limit', baseQuantity: '0.001',
    limitPrice: '100000', maxQuoteAmount: '100', feeCaps: { BTC: '0', USDT: '1', MX: '0' }, ...override };
}
function createEvent(s: LiveOrderState, order = intent()): LiveOrderEvent {
  return { eventId: uuid(s.events.length + 1), at: at(s.events.length + 1), type: 'intent-created', intent: order };
}
function dispatchEvent(s: LiveOrderState, orderIntentId = s.orders.at(-1)!.intent.orderIntentId): LiveOrderEvent {
  return { eventId: uuid(s.events.length + 1), at: at(s.events.length + 1), type: 'dispatch-marked', orderIntentId,
    clientOrderId: s.orders.find(o => o.intent.orderIntentId === orderIntentId)!.clientOrderId };
}
function filled(s: LiveOrderState, order: LiveOrderIntent, quote: string, fee = '1') {
  s = applyLiveOrderEvent(s, createEvent(s, order)); s = applyLiveOrderEvent(s, dispatchEvent(s));
  const row = s.orders.at(-1)!, identity = { venue: order.venue, account: 'main' as const, symbol: 'BTC/USDT' as const, side: order.side,
    clientOrderId: row.clientOrderId, exchangeOrderId: 'exchange-' + order.orderIntentId };
  const next = () => ({ eventId: uuid(s.events.length + 1), at: at(s.events.length + 1), orderIntentId: order.orderIntentId });
  s = applyLiveOrderEvent(s, { ...next(), type: 'order-observed', observation: { identity, source: 'synthetic', status: 'filled',
    cumulativeBaseQuantity: order.baseQuantity, cumulativeQuoteQuantity: quote, quoteAmountSource: 'reported' } });
  s = applyLiveOrderEvent(s, { ...next(), type: 'fill-recorded', identity, source: 'synthetic', fill: { fillId: 'fill-' + order.orderIntentId,
    executedAt: row.dispatchAt!, baseQuantity: order.baseQuantity, quoteQuantity: quote, quoteAmountSource: 'reported', fees: { BTC: '0', USDT: fee, MX: '0' } } });
  s = applyLiveOrderEvent(s, { ...next(), type: 'terminal-reconciled', observationEventId: s.orders.at(-1)!.latestObservation!.eventId });
  return s;
}
const assess = (s: LiveOrderState, p = policy(), i = intent(500)) => assessLiveOrderAdmission(s, createEvent(s, i), p);

describe('immutable declared synthetic admission policy', () => {
  it('normalizes and deeply freezes a complete policy without choosing values', () => {
    const raw = policy(); raw.limits.totalCapitalUsdt = '400.00000000'; raw.initialBalances.mexc.USDT = '1000.0';
    const parsed = parseLiveOrderAdmissionPolicy(raw); expect(parsed.limits.totalCapitalUsdt).toBe('400'); expect(parsed.initialBalances.mexc.USDT).toBe('1000');
    expect(Object.isFrozen(parsed.limits.capitalByVenueUsdt)).toBe(true); expect(Object.isFrozen(parsed.initialBalances.mexc)).toBe(true);
    raw.initialBalances.mexc.USDT = '1'; expect(parsed.initialBalances.mexc.USDT).toBe('1000');
    expect(parseLiveOrderAdmissionPolicy(parsed)).toEqual(parsed);
  });
  it.each([
    ['missing funds', (p: any) => { delete p.initialBalances.okx.MX; }],
    ['numeric funds', (p: any) => { p.initialBalances.okx.USDT = 1000; }],
    ['extra authority', (p: any) => { p.captureProvenanceVerified = true; }],
    ['real source', (p: any) => { p.source = 'real'; }],
    ['allocation sum', (p: any) => { p.limits.capitalByVenueUsdt.mexc = '201'; }],
    ['too large order cap', (p: any) => { p.limits.maxOrderDebitUsdt = '201'; }],
    ['too large loss cap', (p: any) => { p.limits.maxCumulativeLossUsdt = '401'; }],
    ['earn funds', (p: any) => { p.limits.includeEarn = true; }],
    ['transfers', (p: any) => { p.limits.transfersEnabled = true; }],
    ['negative funds', (p: any) => { p.initialBalances.mexc.BTC = '-1'; }],
    ['rounding precision', (p: any) => { p.initialBalances.mexc.BTC = '0.0000000000000000001'; }],
  ])('rejects %s with a fixed error', (_label, mutate) => {
    const p = policy(); mutate(p); expect(() => parseLiveOrderAdmissionPolicy(p)).toThrow('invalid-admission-policy');
  });
  it('never claims real balances, realized profit, production limits or trading permission', () => {
    const outcome = assess(createLiveOrderState()); expect(outcome.allowedForRehearsal).toBe(true);
    expect(outcome).toMatchObject({ nonExecutable: true, captureProvenanceVerified: false, realBalancesVerified: false, productionLimitsEnforced: false,
      diagnostics: { realizedPnlComputed: false, capitalValuationPerformed: false, lossBoundMethod: 'lifetime-gross-usdt-outflow-upper-bound' } });
    expect(Object.isFrozen(outcome.diagnostics)).toBe(true);
  });
  it('counts the complete quote reserve and native fees at intent creation', () => {
    const outcome = assess(createLiveOrderState());
    expect(outcome.diagnostics).toMatchObject({ proposedOrderDebitUsdt: '101', grossUsdtOutflowUpperBound: '101',
      reservationsIncludingProposedByVenue: { mexc: { BTC: '0', USDT: '101', MX: '0' } },
      availableAfterReservationsByVenue: { mexc: { USDT: '899' } }, unhedgedBtcInterval: { lower: '0', upper: '0.001', largestAbsolute: '0.001' } });
  });
  it('uses exact eight-decimal fees and fails at one smallest unit beyond the selected debit cap', () => {
    const p = policy(); p.limits.maxOrderDebitUsdt = '100.00000001';
    expect(assess(createLiveOrderState(), p, intent(500, { feeCaps: { BTC: '0', USDT: '0.00000001', MX: '0' } })).allowedForRehearsal).toBe(true);
    expect(assess(createLiveOrderState(), p, intent(500, { feeCaps: { BTC: '0', USDT: '0.00000002', MX: '0' } })).reasons).toContain('per-order-usdt-debit-limit');
  });
  it('handles amounts beyond floating point precision without rounding a boundary', () => {
    const p = policy(); p.limits.totalCapitalUsdt = '18014398509481986'; p.limits.capitalByVenueUsdt = { mexc: '9007199254740993', okx: '9007199254740993' };
    p.limits.maxOrderDebitUsdt = '9007199254740993'; p.limits.maxCumulativeLossUsdt = '18014398509481986';
    p.initialBalances.mexc.USDT = '9007199254740993'; p.initialBalances.okx.USDT = '9007199254740993';
    const i = intent(500, { baseQuantity: '1', limitPrice: '9007199254740992', maxQuoteAmount: '9007199254740992', feeCaps: { BTC: '0', USDT: '1', MX: '0' } });
    expect(assess(createLiveOrderState(), p, i).allowedForRehearsal).toBe(true);
    const over = { ...i, feeCaps: { ...i.feeCaps, USDT: '1.000000000000000001' } };
    expect(assess(createLiveOrderState(), p, over).reasons).toContain('insufficient-wallet-funds');
    expect(assess(createLiveOrderState(), p, over).diagnostics!.proposedOrderDebitUsdt).toBe('9007199254740993.000000000000000001');
  });
  it('does not fund a venue from a different venue wallet', () => {
    const p = policy(); p.initialBalances.mexc.USDT = '100';
    const outcome = assess(createLiveOrderState(), p); expect(outcome.reasons).toContain('insufficient-wallet-funds');
    expect(outcome.diagnostics!.insufficientFunds).toEqual([{ venue: 'mexc', asset: 'USDT' }]);
  });
  it('does not exceed venue allocation even if the declared wallet has more cash', () => {
    let s = createLiveOrderState(); s = applyLiveOrderEvent(s, createEvent(s, intent(100)));
    const outcome = assess(s); expect(outcome.reasons).toContain('venue-capital-limit');
    expect(outcome.diagnostics!.venueCapitalCommitmentUsdt.mexc).toBe('202');
  });
  it('does not convert missing opening BTC cost basis to an invented dollar valuation', () => {
    const p = policy(); p.initialBalances.mexc.BTC = '0.00000001'; expect(() => parseLiveOrderAdmissionPolicy(p)).not.toThrow();
    expect(assess(createLiveOrderState(), p).reasons).toContain('opening-btc-cost-basis-unproven');
  });
  it('blocks any MX fee cap even with enough native MX because its dollar loss basis is absent', () => {
    const outcome = assess(createLiveOrderState(), policy(), intent(500, { feeCaps: { BTC: '0', USDT: '1', MX: '0.00000001' } }));
    expect(outcome.reasons).toContain('mx-fee-valuation-unproven'); expect(outcome.diagnostics!.availableAfterReservationsByVenue.mexc.MX).toBe('0.99999999');
  });
  it('keeps an unknown dispatched order sticky and counts its whole reserve', () => {
    let s = createLiveOrderState(); s = applyLiveOrderEvent(s, createEvent(s, intent(100))); s = applyLiveOrderEvent(s, dispatchEvent(s));
    const outcome = assess(s, policy(), intent(500, { venue: 'okx' }));
    expect(outcome.reasons).toContain('unknown-order-outcome'); expect(outcome.diagnostics!.reservedAndProposedUsdt).toBe('202');
  });
  it('does not release reservations when a not-found result leaves the outcome unknown', () => {
    let s = createLiveOrderState(); s = applyLiveOrderEvent(s, createEvent(s, intent(100))); s = applyLiveOrderEvent(s, dispatchEvent(s));
    const row = s.orders[0]; s = applyLiveOrderEvent(s, { eventId: uuid(3), at: at(3), type: 'lookup-not-found', orderIntentId: row.intent.orderIntentId,
      venue: 'mexc', account: 'main', clientOrderId: row.clientOrderId, source: 'synthetic' });
    expect(assess(s).reasons).toContain('unknown-order-outcome');
  });
  it('counts actual cash debits plus complete unresolved reserves conservatively', () => {
    let s = createLiveOrderState(); const i = intent(100); s = applyLiveOrderEvent(s, createEvent(s, i)); s = applyLiveOrderEvent(s, dispatchEvent(s));
    const row = s.orders[0], identity = { venue: 'mexc', account: 'main', symbol: 'BTC/USDT', side: 'buy', clientOrderId: row.clientOrderId, exchangeOrderId: 'x' };
    s = applyLiveOrderEvent(s, { eventId: uuid(3), at: at(3), type: 'fill-recorded', orderIntentId: i.orderIntentId, identity, source: 'synthetic',
      fill: { fillId: 'partial', executedAt: at(2), baseQuantity: '0.0004', quoteQuantity: '40', quoteAmountSource: 'reported', fees: { BTC: '0', USDT: '0.4', MX: '0' } } });
    const outcome = assess(s, policy(), intent(500, { venue: 'okx' }));
    expect(outcome.diagnostics).toMatchObject({ knownGrossUsdtOutflow: '40.4', grossUsdtOutflowUpperBound: '242.4',
      walletByVenue: { mexc: { BTC: '0.0004', USDT: '959.6' } }, reservationsIncludingProposedByVenue: { mexc: { USDT: '101' } } });
  });
  it('does not offset an opposite prepared sell against the worst-case new buy exposure', () => {
    let s = filled(createLiveOrderState(), intent(100), '100');
    s = applyLiveOrderEvent(s, createEvent(s, intent(200, { side: 'sell' })));
    const p = policy(); p.limits.maxUnhedgedBtc = '0.0015';
    const outcome = assess(s, p, intent(500, { venue: 'okx' }));
    expect(outcome.diagnostics!.unhedgedBtcInterval).toEqual({ lower: '0', upper: '0.002', largestAbsolute: '0.002' });
    expect(outcome.reasons).toContain('unhedged-btc-limit');
  });
  it('counts BTC fee caps on the lower exposure endpoint and requires native funds up front', () => {
    const s = filled(createLiveOrderState(), intent(100), '100');
    const sell = intent(500, { side: 'sell', baseQuantity: '0.0009', feeCaps: { BTC: '0.00000001', USDT: '1', MX: '0' } });
    const outcome = assess(s, policy(), sell); expect(outcome.diagnostics!.unhedgedBtcInterval.lower).toBe('0.00009999');
    expect(outcome.diagnostics!.availableAfterReservationsByVenue.mexc.BTC).toBe('0.00009999');
    expect(outcome.allowedForRehearsal).toBe(true);
    expect(assess(createLiveOrderState(), policy(), intent(500, { feeCaps: { BTC: '0.00000001', USDT: '1', MX: '0' } })).reasons).toContain('insufficient-wallet-funds');
  });
  it('never replenishes the lifetime gross-outflow ceiling from profitable closed trades or midnight', () => {
    let s = filled(createLiveOrderState(), intent(100), '100'); s = filled(s, intent(200, { side: 'sell' }), '110');
    const p = policy(); p.limits.maxCumulativeLossUsdt = '200';
    const e = createEvent(s, intent(500)); e.at = '2026-09-30T00:00:00.000Z';
    const outcome = assessLiveOrderAdmission(s, e, p);
    expect(outcome.diagnostics).toMatchObject({ knownGrossUsdtOutflow: '102', grossUsdtOutflowUpperBound: '203', walletByVenue: { mexc: { USDT: '1008' } } });
    expect(outcome.reasons).toContain('gross-usdt-outflow-limit'); expect(outcome.diagnostics!.realizedPnlComputed).toBe(false);
  });
  it('cannot expand the original capital allocation with sale proceeds', () => {
    let s = filled(createLiveOrderState(), intent(100), '100'); s = filled(s, intent(200, { side: 'sell' }), '110');
    const p = policy(); p.limits.maxOrderDebitUsdt = '200';
    const outcome = assess(s, p, intent(500, { maxQuoteAmount: '200', feeCaps: { BTC: '0', USDT: '1', MX: '0' } }));
    expect(outcome.reasons).toContain('venue-capital-limit'); expect(outcome.diagnostics!.venueCapitalCommitmentUsdt.mexc).toBe('201');
  });
  it('blocks further intents after quarantined costs while leaving actual lifecycle recording available', () => {
    let s = createLiveOrderState(); s = applyLiveOrderEvent(s, createEvent(s, intent(100))); s = applyLiveOrderEvent(s, dispatchEvent(s));
    const row = s.orders[0], identity = { venue: 'mexc', account: 'main', symbol: 'BTC/USDT', side: 'buy', clientOrderId: row.clientOrderId, exchangeOrderId: 'x' };
    s = applyLiveOrderEvent(s, { eventId: uuid(3), at: at(3), type: 'fill-quarantined', orderIntentId: row.intent.orderIntentId, identity, source: 'synthetic',
      fill: { fillId: 'unexpected', executedAt: at(2), baseQuantity: '0.001', quoteQuantity: '100', quoteAmountSource: 'reported', fees: { BTC: '0', USDT: '2', MX: '0' } } });
    expect(assess(s).reasons).toContain('accounting-anomaly-unresolved'); expect(s.orders[0].cashDelta.USDT).toBe('-102');
  });
  it('rechecks a dispatch with its own existing reservation counted exactly once', () => {
    let s = createLiveOrderState(); const before = assess(s); s = applyLiveOrderEvent(s, createEvent(s, intent(500)));
    const after = assessLiveOrderDispatch(s, dispatchEvent(s), policy());
    expect(after.allowedForRehearsal).toBe(true); expect(after.diagnostics).toEqual(before.diagnostics);
  });
  it('cannot dispatch a prepared intent after a different intent becomes unknown', () => {
    let s = createLiveOrderState(); s = applyLiveOrderEvent(s, createEvent(s, intent(100))); s = applyLiveOrderEvent(s, createEvent(s, intent(200, { venue: 'okx' })));
    s = applyLiveOrderEvent(s, dispatchEvent(s, uuid(100)));
    expect(assessLiveOrderDispatch(s, dispatchEvent(s, uuid(200)), policy()).reasons).toContain('unknown-order-outcome');
  });
  it('dispatch recheck observes new reported cash costs from another open order', () => {
    let s = filled(createLiveOrderState(), intent(100), '100'); s = applyLiveOrderEvent(s, createEvent(s, intent(200)));
    const p = policy(); p.initialBalances.mexc.USDT = '150';
    const outcome = assessLiveOrderDispatch(s, dispatchEvent(s), p); expect(outcome.reasons).toContain('insufficient-wallet-funds');
    expect(outcome.diagnostics!.availableAfterReservationsByVenue.mexc.USDT).toBe('-52');
  });
  it('rejects forged state, wrong event kinds and absent policy without sensitive input in reasons', () => {
    const s = createLiveOrderState(), e = createEvent(s);
    expect(assessLiveOrderAdmission(structuredClone(s), e, policy()).reasons).toEqual(['invalid-rehearsal-state']);
    expect(assessLiveOrderAdmission(s, e, { privateSecret: 'never-output' }).reasons).toEqual(['invalid-admission-policy']);
    expect(JSON.stringify(assessLiveOrderAdmission(s, e, { privateSecret: 'never-output' }))).not.toContain('never-output');
    expect(assessLiveOrderDispatch(s, e, policy()).reasons).toEqual(['invalid-dispatch-event']);
  });
});
