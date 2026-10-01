import { describe, expect, it } from 'vitest';
import { applyLiveOrderEvent, canonicalLiveOrderJson, createLiveOrderState, deriveLiveClientOrderId,
  LIVE_ORDER_LIMITS, parseLiveOrderEvent, planLiveOrderRecovery, replayLiveOrderEvents,
  type LiveOrderEvent, type LiveOrderIntent, type LiveOrderObservation, type LiveOrderState } from '../src/live/order-lifecycle.js';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const at = (n: number) => new Date(Date.UTC(2026, 8, 28, 12) + n * 1000).toISOString();
const intent = (overrides: Partial<LiveOrderIntent> = {}): LiveOrderIntent => ({ orderIntentId: id(10000), venue: 'mexc', account: 'main',
  symbol: 'BTC/USDT', side: 'buy', orderType: 'limit', baseQuantity: '0.001', limitPrice: '100000', maxQuoteAmount: '100',
  feeCaps: { BTC: '0.00001', USDT: '1', MX: '1' }, ...overrides });
function prepared(overrides: Partial<LiveOrderIntent> = {}): LiveOrderState {
  return applyLiveOrderEvent(createLiveOrderState(), { eventId: id(1), at: at(1), type: 'intent-created', intent: intent(overrides) });
}
function common(state: LiveOrderState, orderIntentId = state.orders[0].intent.orderIntentId) {
  return { eventId: id(state.events.length + 1), at: at(state.events.length + 1), orderIntentId };
}
function marked(overrides: Partial<LiveOrderIntent> = {}): LiveOrderState {
  const state = prepared(overrides);
  return applyLiveOrderEvent(state, { ...common(state), type: 'dispatch-marked', clientOrderId: state.orders[0].clientOrderId });
}
function identity(state: LiveOrderState) {
  const order = state.orders[0];
  return { venue: order.intent.venue, account: 'main' as const, symbol: 'BTC/USDT' as const, side: order.intent.side,
    clientOrderId: order.clientOrderId, exchangeOrderId: 'order-1' };
}
function observe(state: LiveOrderState, overrides: Partial<LiveOrderObservation> = {}): LiveOrderState {
  return applyLiveOrderEvent(state, { ...common(state), type: 'order-observed', observation: {
    identity: identity(state), source: 'synthetic', status: 'new', cumulativeBaseQuantity: '0', cumulativeQuoteQuantity: '0',
    quoteAmountSource: 'reported', ...overrides } });
}
function fillEvent(state: LiveOrderState, overrides: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return { ...common(state), type: 'fill-recorded', identity: identity(state), source: 'synthetic', fill: {
    fillId: 'fill-1', executedAt: at(2), baseQuantity: '0.0004', quoteQuantity: '40', quoteAmountSource: 'reported',
    fees: { BTC: '0', USDT: '0.02', MX: '0' }, ...overrides }, ...extra };
}
function reconcile(state: LiveOrderState): LiveOrderState {
  return applyLiveOrderEvent(state, { ...common(state), type: 'terminal-reconciled', observationEventId: state.orders[0].latestObservation!.eventId });
}
function notFound(state: LiveOrderState): LiveOrderState {
  return applyLiveOrderEvent(state, { ...common(state), type: 'lookup-not-found', venue: state.orders[0].intent.venue,
    account: 'main', clientOrderId: state.orders[0].clientOrderId, source: 'synthetic' });
}

describe('isolated live-order lifecycle rehearsal', () => {
  it('creates permanently non-executable immutable preparation independent of paper accounts', () => {
    const state = prepared();
    expect(state).toMatchObject({ schema: 1, kind: 'live-order-rehearsal', source: 'local-rehearsal', nonExecutable: true,
      captureProvenanceVerified: false });
    expect(state.orders[0]).toMatchObject({ phase: 'prepared', cashDelta: { BTC: '0', USDT: '0', MX: '0' },
      reserved: { BTC: '0.00001', USDT: '101', MX: '1' } });
    expect(Object.isFrozen(state.orders[0].intent.feeCaps)).toBe(true);
    expect(() => { (state.orders[0].intent.feeCaps as { USDT: string }).USDT = '0'; }).toThrow();
    expect(() => { (state.events as LiveOrderEvent[]).pop(); }).toThrow();
    expect(planLiveOrderRecovery(state).actions[0]).toMatchObject({ action: 'review-unsubmitted-intent', automaticResubmitAllowed: false });
  });
  it('requires restoring events instead of trusting copied or fabricated state summaries', () => {
    const state = marked();
    const forged = structuredClone(state);
    expect(() => applyLiveOrderEvent(forged, state.events[0])).toThrow('invalid-state');
    expect(() => planLiveOrderRecovery(forged)).toThrow('invalid-state');
    expect(replayLiveOrderEvents(JSON.parse(JSON.stringify(state.events)))).toEqual(state);
  });
  it('binds stable 32-character client identifiers to venue and permanent intent UUID', () => {
    const mexc = deriveLiveClientOrderId('mexc', id(1)), okx = deriveLiveClientOrderId('okx', id(1));
    expect(mexc).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(okx).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(mexc).not.toBe(okx);
    expect(mexc).toBe(deriveLiveClientOrderId('mexc', id(1).toUpperCase()));
    expect(mexc).not.toBe(deriveLiveClientOrderId('mexc', id(2)));
    expect(() => deriveLiveClientOrderId('mexc', 'untrusted private value')).toThrow('invalid-order-identity');
  });
  it('normalizes exact equivalent decimals before idempotence and freezes an independent copy', () => {
    const event = { eventId: id(1), at: at(1), type: 'intent-created', intent: intent({ baseQuantity: '0.001000', maxQuoteAmount: '100.0' }) };
    const state = applyLiveOrderEvent(createLiveOrderState(), event);
    expect(state.orders[0].intent.baseQuantity).toBe('0.001');
    expect(applyLiveOrderEvent(state, { ...event, intent: intent() })).toBe(state);
    event.intent.maxQuoteAmount = '200';
    expect(state.orders[0].intent.maxQuoteAmount).toBe('100');
    expect(() => applyLiveOrderEvent(state, event)).toThrow('event-id-conflict');
  });
  it.each([
    { baseQuantity: '0' }, { limitPrice: '0' }, { maxQuoteAmount: '0' }, { maxQuoteAmount: '99.99' },
  ])('rejects nonpositive or underfunded buy intent %j', changed => {
    expect(() => prepared(changed)).toThrow();
  });
  it.each([
    { baseQuantity: 0.001 }, { baseQuantity: '0.0000000000000000001' }, { maxQuoteAmount: '1e2' },
    { limitPrice: '-1' }, { extraPrivateText: 'do-not-echo' }, { account: 'subaccount' }, { symbol: 'ETH/USDT' }, { orderType: 'market' },
  ])('rejects unsupported or non-exact intent field %j', changed => {
    expect(() => applyLiveOrderEvent(createLiveOrderState(), { eventId: id(1), at: at(1), type: 'intent-created', intent: { ...intent(), ...changed } }))
      .toThrow('invalid-event');
  });
  it('does not accept caller-supplied verified provenance or live authorization flags', () => {
    const state = marked();
    const event = { ...common(state), type: 'lookup-not-found', venue: 'mexc', account: 'main',
      clientOrderId: state.orders[0].clientOrderId, source: 'declared-recorded' };
    expect(() => applyLiveOrderEvent(state, { ...event, captureProvenanceVerified: true })).toThrow('invalid-event');
    expect(applyLiveOrderEvent(state, event)).toMatchObject({ nonExecutable: true, captureProvenanceVerified: false });
  });
  it('requires intent before dispatch and treats a durable marker as possibly submitted', () => {
    const state = marked();
    expect(state.orders[0].phase).toBe('unknown');
    expect(planLiveOrderRecovery(state).actions[0]).toMatchObject({ action: 'lookup-by-client-id', reservationRetained: true,
      automaticResubmitAllowed: false });
    expect(() => applyLiveOrderEvent(createLiveOrderState(), { ...common(state), type: 'dispatch-marked', clientOrderId: state.orders[0].clientOrderId }))
      .toThrow('unknown-intent');
    expect(() => observe(prepared())).toThrow('dispatch-not-marked');
  });
  it('does not mark dispatch twice, even under a new event ID', () => {
    const state = marked();
    expect(applyLiveOrderEvent(state, state.events[1])).toBe(state);
    expect(() => applyLiveOrderEvent(state, { ...state.events[1], ...common(state) })).toThrow('dispatch-already-marked');
    const pending = prepared();
    expect(() => applyLiveOrderEvent(pending, { ...common(pending), type: 'dispatch-marked', clientOrderId: 'a'.repeat(32) }))
      .toThrow('order-identity-mismatch');
  });
  it.each(['timeout', 'connection-lost', 'process-recovery'])('retains unknown reservation after %s and a negative lookup', reason => {
    let state = marked();
    const reservation = state.orders[0].reserved;
    state = applyLiveOrderEvent(state, { ...common(state), type: 'dispatch-uncertain', reason });
    state = notFound(state);
    state = replayLiveOrderEvents(state.events);
    expect(state.orders[0]).toMatchObject({ phase: 'unknown', reserved: reservation });
    expect(planLiveOrderRecovery(state).actions[0].automaticResubmitAllowed).toBe(false);
  });
  it('requires exact lookup identity and never interprets not-found as rejection', () => {
    const state = marked();
    const event = { ...common(state), type: 'lookup-not-found', venue: 'okx', account: 'main',
      clientOrderId: state.orders[0].clientOrderId, source: 'synthetic' };
    expect(() => applyLiveOrderEvent(state, event)).toThrow('order-identity-mismatch');
    expect(notFound(state).orders[0].phase).toBe('unknown');
  });
  it('does not treat a cancellation acknowledgement as terminal, including a subsequent fill race', () => {
    let state = observe(marked());
    const reserve = state.orders[0].reserved;
    expect(() => applyLiveOrderEvent(state, { ...common(state), type: 'cancel-acknowledged' })).toThrow('cancel-not-requested');
    state = applyLiveOrderEvent(state, { ...common(state), type: 'cancel-requested' });
    state = applyLiveOrderEvent(state, { ...common(state), type: 'cancel-acknowledged' });
    state = applyLiveOrderEvent(state, fillEvent(state));
    expect(state.orders[0]).toMatchObject({ cancelRequested: true, cancelAcknowledged: true, reserved: reserve });
    expect(state.orders[0].phase).not.toBe('reconciled');
    expect(() => applyLiveOrderEvent(state, { ...common(state), type: 'terminal-reconciled', observationEventId: id(3) }))
      .toThrow('terminal-observation-required');
    state = observe(state, { status: 'canceled', cumulativeBaseQuantity: '0.0004', cumulativeQuoteQuantity: '40' });
    expect(state.orders[0].reserved).toEqual(reserve);
    state = reconcile(state);
    expect(state.orders[0]).toMatchObject({ phase: 'reconciled', reserved: { BTC: '0', USDT: '0', MX: '0' },
      cashDelta: { BTC: '0.0004', USDT: '-40.02', MX: '0' } });
  });
  it('reconciles exact multiple fills and asset-specific fees without floating point or fake P&L', () => {
    let state = marked();
    state = applyLiveOrderEvent(state, fillEvent(state, { fees: { BTC: '0.000001', USDT: '0.02', MX: '0.1' } }));
    state = observe(state, { status: 'partially-filled', cumulativeBaseQuantity: '0.0004', cumulativeQuoteQuantity: '40' });
    state = applyLiveOrderEvent(state, fillEvent(state, { fillId: 'fill-2', baseQuantity: '0.0006', quoteQuantity: '60',
      fees: { BTC: '0.000002', USDT: '0.03', MX: '0.2' } }));
    state = observe(state, { status: 'filled', cumulativeBaseQuantity: '0.001', cumulativeQuoteQuantity: '100' });
    expect(state.orders[0].phase).toBe('terminal-unreconciled');
    state = reconcile(state);
    expect(state.orders[0].cashDelta).toEqual({ BTC: '0.000997', USDT: '-100.05', MX: '-0.3' });
    expect(state).not.toHaveProperty('profit');
    expect(state).not.toHaveProperty('balances');
    expect(planLiveOrderRecovery(state).actions[0]).toMatchObject({ action: 'none', reservationRetained: false, automaticResubmitAllowed: false });
    expect(state.nonExecutable).toBe(true);
  });
  it('keeps exact 18-place amounts without rounding', () => {
    let state = marked({ baseQuantity: '0.000000000000000003', limitPrice: '1', maxQuoteAmount: '0.000000000000000003',
      feeCaps: { BTC: '0', USDT: '0.000000000000000001', MX: '0' } });
    state = applyLiveOrderEvent(state, fillEvent(state, { baseQuantity: '0.000000000000000003', quoteQuantity: '0.000000000000000003',
      fees: { BTC: '0', USDT: '0.000000000000000001', MX: '0' } }));
    state = observe(state, { status: 'filled', cumulativeBaseQuantity: '0.000000000000000003', cumulativeQuoteQuantity: '0.000000000000000003' });
    expect(reconcile(state).orders[0].cashDelta.USDT).toBe('-0.000000000000000004');
  });
  it('preserves sell base reservations and fee-adjusted cash movements', () => {
    let state = marked({ side: 'sell' });
    expect(state.orders[0].reserved).toEqual({ BTC: '0.00101', USDT: '1', MX: '1' });
    state = applyLiveOrderEvent(state, fillEvent(state, { quoteQuantity: '40.1', fees: { BTC: '0.000001', USDT: '0.02', MX: '0.3' } }));
    state = observe(state, { status: 'canceled', cumulativeBaseQuantity: '0.0004', cumulativeQuoteQuantity: '40.1' });
    expect(reconcile(state).orders[0].cashDelta).toEqual({ BTC: '-0.000401', USDT: '40.08', MX: '-0.3' });
  });
  it('requires complete matching terminal fills before releasing any reservation', () => {
    let state = observe(marked(), { status: 'filled', cumulativeBaseQuantity: '0.001', cumulativeQuoteQuantity: '100' });
    const reservation = state.orders[0].reserved;
    expect(() => reconcile(state)).toThrow('incomplete-fill-reconciliation');
    state = applyLiveOrderEvent(state, fillEvent(state));
    expect(() => reconcile(state)).toThrow('incomplete-fill-reconciliation');
    expect(state.orders[0].reserved).toEqual(reservation);
  });
  it('does not use a derived quote snapshot to release nonzero terminal execution', () => {
    let state = marked({ venue: 'okx', feeCaps: { BTC: '0.00001', USDT: '1', MX: '0' } });
    state = applyLiveOrderEvent(state, fillEvent(state));
    state = observe(state, { status: 'canceled', cumulativeBaseQuantity: '0.0004', cumulativeQuoteQuantity: '40', quoteAmountSource: 'derived' });
    expect(() => reconcile(state)).toThrow('reported-quote-required');
    const event = fillEvent(marked(), { quoteAmountSource: 'derived' });
    expect(() => parseLiveOrderEvent(event)).toThrow('invalid-event');
  });
  it.each(['canceled', 'rejected'] as const)('releases a zero-execution %s only after explicit reconciliation', status => {
    let state = observe(marked(), { status, quoteAmountSource: 'derived' });
    expect(state.orders[0].reserved.USDT).toBe('101');
    state = reconcile(state);
    expect(state.orders[0].reserved.USDT).toBe('0');
    expect(state.orders[0].cashDelta.USDT).toBe('0');
  });
  it('binds reconciliation to the latest terminal observation event', () => {
    let state = observe(marked(), { status: 'canceled' });
    const obsolete = state.orders[0].latestObservation!.eventId;
    state = observe(state, { status: 'canceled' });
    expect(() => applyLiveOrderEvent(state, { ...common(state), type: 'terminal-reconciled', observationEventId: obsolete }))
      .toThrow('terminal-observation-required');
  });
  it('preserves terminal evidence through a later timeout or expired lookup without resubmission', () => {
    let state = observe(marked(), { status: 'canceled' });
    state = notFound(state);
    state = applyLiveOrderEvent(state, { ...common(state), type: 'dispatch-uncertain', reason: 'timeout' });
    expect(state.orders[0].phase).toBe('terminal-unreconciled');
    expect(planLiveOrderRecovery(state).actions[0].action).toBe('reconcile-terminal-fills');
    expect(reconcile(state).orders[0].phase).toBe('reconciled');
  });
  it('deduplicates equal economic fills under new events but rejects changed payloads', () => {
    let state = marked();
    const first = fillEvent(state);
    state = applyLiveOrderEvent(state, first);
    const second = { ...first, ...common(state) };
    const deduplicated = applyLiveOrderEvent(state, second);
    expect(deduplicated.orders[0].fills).toHaveLength(1);
    expect(deduplicated.orders[0].cashDelta).toEqual(state.orders[0].cashDelta);
    expect(() => applyLiveOrderEvent(deduplicated, { ...first, ...common(deduplicated), fill: { ...first.fill, quoteQuantity: '39.9' } }))
      .toThrow('fill-id-conflict');
  });
  it.each([
    { identity: { exchangeOrderId: 'order-2' } }, { identity: { side: 'sell' } },
    { identity: { venue: 'okx' } }, { identity: { clientOrderId: 'a'.repeat(32) } },
  ])('rejects mismatched order/fill identity %j', changed => {
    const state = observe(marked());
    expect(() => applyLiveOrderEvent(state, fillEvent(state, {}, { identity: { ...identity(state), ...changed.identity } })))
      .toThrow('order-identity-mismatch');
  });
  it('never reassigns an exchange order ID to another intent in the same venue', () => {
    let state = observe(marked());
    const second = intent({ orderIntentId: id(10001) });
    state = applyLiveOrderEvent(state, { eventId: id(state.events.length + 1), at: at(state.events.length + 1), type: 'intent-created', intent: second });
    state = applyLiveOrderEvent(state, { ...common(state, second.orderIntentId), type: 'dispatch-marked', clientOrderId: state.orders[1].clientOrderId });
    expect(() => applyLiveOrderEvent(state, { ...common(state, second.orderIntentId), type: 'order-observed', observation: {
      identity: { ...identity(state), clientOrderId: state.orders[1].clientOrderId }, source: 'synthetic', status: 'new',
      cumulativeBaseQuantity: '0', cumulativeQuoteQuantity: '0', quoteAmountSource: 'reported' } })).toThrow('exchange-order-id-reused');
  });
  it('never reuses a terminal intent ID and never modifies a reconciled order', () => {
    const state = reconcile(observe(marked(), { status: 'canceled' }));
    const create = { eventId: id(99), at: at(99), type: 'intent-created', intent: intent() };
    expect(() => applyLiveOrderEvent(state, create)).toThrow('intent-id-reused');
    expect(() => notFound(state)).toThrow('order-already-reconciled');
    expect(applyLiveOrderEvent(state, state.events[state.events.length - 1])).toBe(state);
  });
  it('rejects stale cumulative totals, impossible statuses and terminal corrections', () => {
    const state = observe(marked(), { status: 'partially-filled', cumulativeBaseQuantity: '0.0004', cumulativeQuoteQuantity: '40' });
    expect(() => observe(state, { status: 'partially-filled', cumulativeBaseQuantity: '0.0003', cumulativeQuoteQuantity: '30' }))
      .toThrow('cumulative-regression');
    expect(() => observe(state, { status: 'new', cumulativeBaseQuantity: '0.0004', cumulativeQuoteQuantity: '40' })).toThrow('status-regression');
    expect(() => observe(marked(), { status: 'filled', cumulativeBaseQuantity: '0.0004', cumulativeQuoteQuantity: '40' })).toThrow('filled-quantity-mismatch');
    const terminal = observe(state, { status: 'canceled', cumulativeBaseQuantity: '0.0004', cumulativeQuoteQuantity: '40' });
    expect(() => observe(terminal, { status: 'filled', cumulativeBaseQuantity: '0.001', cumulativeQuoteQuantity: '100' }))
      .toThrow('terminal-observation-conflict');
  });
  it.each([
    { baseQuantity: '0' }, { quoteQuantity: '0' }, { quoteQuantity: '41' }, { baseQuantity: '0.002', quoteQuantity: '200' },
    { fees: { BTC: '0', USDT: '1.01', MX: '0' } }, { executedAt: at(1) }, { executedAt: at(99) },
  ])('rejects invalid fill and keeps prior state unchanged %j', changed => {
    const state = marked(), before = canonicalLiveOrderJson(state);
    expect(() => applyLiveOrderEvent(state, fillEvent(state, changed))).toThrow();
    expect(canonicalLiveOrderJson(state)).toBe(before);
  });
  it('rejects fills beyond terminal totals and aggregate fees beyond their cap', () => {
    const terminal = observe(marked(), { status: 'canceled' });
    expect(() => applyLiveOrderEvent(terminal, fillEvent(terminal))).toThrow('fill-exceeds-terminal-totals');
    let state = marked({ feeCaps: { BTC: '0', USDT: '0.03', MX: '0' } });
    state = applyLiveOrderEvent(state, fillEvent(state));
    expect(() => applyLiveOrderEvent(state, fillEvent(state, { fillId: 'fill-2' }))).toThrow('fee-cap-exceeded');
  });
  it('retains an explicit over-cap economic fact exactly once and quarantines recovery permanently', () => {
    let state = marked({ feeCaps: { BTC: '0', USDT: '0.01', MX: '0' } });
    const reserve = state.orders[0].reserved;
    const event = { ...fillEvent(state), type: 'fill-quarantined' };
    state = applyLiveOrderEvent(state, event);
    expect(state.orders[0]).toMatchObject({ phase: 'quarantined', accountingAnomalies: ['fee-cap-exceeded'],
      cashDelta: { BTC: '0.0004', USDT: '-40.02', MX: '0' }, reserved: reserve });
    expect(applyLiveOrderEvent(state, event)).toBe(state);
    state = applyLiveOrderEvent(state, { ...event, ...common(state) });
    state = applyLiveOrderEvent(state, { ...event, ...common(state), type: 'fill-recorded' });
    expect(state.orders[0].fills).toHaveLength(1);
    expect(state.orders[0].cashDelta.USDT).toBe('-40.02');
    state = observe(state, { status: 'canceled', cumulativeBaseQuantity: '0.0004', cumulativeQuoteQuantity: '40' });
    state = notFound(state);
    state = applyLiveOrderEvent(state, { ...common(state), type: 'dispatch-uncertain', reason: 'process-recovery' });
    state = replayLiveOrderEvents(state.events);
    expect(state.orders[0].phase).toBe('quarantined');
    expect(state.orders[0].reserved).toEqual(reserve);
    expect(() => reconcile(state)).toThrow('accounting-anomaly-unresolved');
    expect(planLiveOrderRecovery(state).actions[0]).toMatchObject({ action: 'inspect-accounting-anomaly',
      automaticResubmitAllowed: false, reservationRetained: true });
  });
  it('allows later economic facts after quarantine while keeping costs and the block', () => {
    let state = marked({ feeCaps: { BTC: '0', USDT: '0.01', MX: '0' } });
    state = applyLiveOrderEvent(state, { ...fillEvent(state), type: 'fill-quarantined' });
    state = applyLiveOrderEvent(state, fillEvent(state, { fillId: 'fill-2', baseQuantity: '0.0006', quoteQuantity: '60',
      fees: { BTC: '0', USDT: '0', MX: '0' } }));
    expect(state.orders[0]).toMatchObject({ phase: 'quarantined', cashDelta: { BTC: '0.001', USDT: '-100.02', MX: '0' } });
    expect(state.orders[0].fills).toHaveLength(2);
    expect(() => reconcile(observe(state, { status: 'filled', cumulativeBaseQuantity: '0.001', cumulativeQuoteQuantity: '100' })))
      .toThrow('accounting-anomaly-unresolved');
  });
  it.each([
    [{ baseQuantity: '0.002', quoteQuantity: '200' }, 'fill-cap-exceeded'],
    [{ quoteQuantity: '41' }, 'fill-outside-limit'],
    [{ fees: { BTC: '0.001', USDT: '0', MX: '0' } }, 'fee-exceeds-received-asset'],
  ] as const)('retains unexpected execution amounts instead of discarding their costs %j', (changed, expectedCode) => {
    const state = marked();
    const after = applyLiveOrderEvent(state, { ...fillEvent(state, changed), type: 'fill-quarantined' });
    expect(after.orders[0].accountingAnomalies).toContain(expectedCode);
    expect(after.orders[0].phase).toBe('quarantined');
    expect(after.orders[0].reserved).toEqual(state.orders[0].reserved);
    expect(after.orders[0].fills).toHaveLength(1);
  });
  it('requires a computed anomaly and never lets quarantine bypass strict identity or exact amount validation', () => {
    const state = marked();
    expect(() => applyLiveOrderEvent(state, { ...fillEvent(state), type: 'fill-quarantined' })).toThrow('accounting-anomaly-required');
    expect(() => applyLiveOrderEvent(state, { ...fillEvent(state, { quoteQuantity: 'NaN' }), type: 'fill-quarantined' })).toThrow('invalid-event');
    expect(() => applyLiveOrderEvent(state, { ...fillEvent(state, { quoteQuantity: '41' },
      { identity: { ...identity(state), clientOrderId: 'z'.repeat(32) } }), type: 'fill-quarantined' })).toThrow('order-identity-mismatch');
  });
  it('rejects invalid timestamps and event time regression while allowing old exact replay', () => {
    const state = marked();
    expect(() => applyLiveOrderEvent(state, { ...common(state), at: at(0), type: 'dispatch-uncertain', reason: 'timeout' })).toThrow('event-time-regression');
    expect(() => applyLiveOrderEvent(state, { ...common(state), at: '2026-09-28T12:00:02+00:00', type: 'dispatch-uncertain', reason: 'timeout' }))
      .toThrow('invalid-event');
    expect(applyLiveOrderEvent(state, state.events[0])).toBe(state);
  });
  it('keeps parser errors bounded and never echoes unknown private fields', () => {
    const secret = 'private-value-must-not-appear';
    try { parseLiveOrderEvent({ secret }); } catch (error) { expect(String(error)).not.toContain(secret); }
    expect(() => parseLiveOrderEvent({ huge: 'x'.repeat(LIVE_ORDER_LIMITS.eventBytes + 1) })).toThrow('event-size-limit');
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(() => parseLiveOrderEvent(cyclic)).toThrow('invalid-event');
    expect(() => parseLiveOrderEvent(undefined)).toThrow('invalid-event');
  });
  it('bounds lifetime intent count without freeing identifiers after terminal states', () => {
    let state = createLiveOrderState();
    for (let i = 0; i < LIVE_ORDER_LIMITS.orders; i++) state = applyLiveOrderEvent(state,
      { eventId: id(i + 1), at: at(i + 1), type: 'intent-created', intent: intent({ orderIntentId: id(10000 + i) }) });
    expect(() => applyLiveOrderEvent(state, { eventId: id(9999), at: at(9999), type: 'intent-created', intent: intent({ orderIntentId: id(99999) }) }))
      .toThrow('order-count-limit');
  });
  it('bounds event count while allowing an already committed exact duplicate', () => {
    let state = marked();
    while (state.events.length < LIVE_ORDER_LIMITS.events) state = notFound(state);
    expect(() => notFound(state)).toThrow('event-count-limit');
    expect(applyLiveOrderEvent(state, state.events[0])).toBe(state);
  }, 30_000);
});
