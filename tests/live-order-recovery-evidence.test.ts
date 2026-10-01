import { describe, expect, it } from 'vitest';
import { applyLiveOrderEvent, createLiveOrderState, type LiveOrderEvent, type LiveOrderState } from '../src/live/order-lifecycle.js';
import { buildLiveOrderRecoveryEvidence, LIVE_RECOVERY_EVIDENCE_LIMITS, parseLiveRecoveryEvidencePolicy } from '../src/live/order-recovery-evidence.js';
const start = Date.UTC(2026, 8, 28, 12), at = (n: number) => new Date(start + n).toISOString();
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const intentId = uuid(100);
function state(venue: 'mexc' | 'okx' = 'mexc') {
  let result = applyLiveOrderEvent(createLiveOrderState(), { eventId: uuid(1), at: at(0), type: 'intent-created',
    intent: { orderIntentId: intentId, venue, account: 'main', symbol: 'BTC/USDT', side: 'buy', orderType: 'limit',
      baseQuantity: '0.001', limitPrice: '100000', maxQuoteAmount: '100', feeCaps: { BTC: '0.00001', USDT: '1', MX: venue === 'mexc' ? '1' : '0' } } });
  result = applyLiveOrderEvent(result, { eventId: uuid(2), at: at(1000), type: 'dispatch-marked', orderIntentId: intentId, clientOrderId: result.orders[0].clientOrderId });
  return result;
}
const policy = () => ({ now: start + 10_000, maxCaptureDurationMs: 30_000, maxCaptureAgeMs: 60_000, maxClockSkewMs: 2000 });
function capture(s: LiveOrderState, selectedStatus = 'FILLED') {
  const order = s.orders[0], venue = order.intent.venue, client = order.clientOrderId, mexc = venue === 'mexc';
  const raw = mexc ? { symbol: 'BTCUSDT', orderId: 'exchange-1', clientOrderId: client, side: 'BUY', type: 'LIMIT', price: '100000',
    Qty: '0.001', executedQty: '0.001', cumulativeQuoteQty: '99', status: selectedStatus, time: start + 1100,
    updateTime: start + 4000, timeInForce: 'GTC', origQuoteOrderQty: '0' } : {
      instType: 'SPOT', instId: 'BTC-USDT', ordId: 'exchange-1', clOrdId: client, tdMode: 'cash', category: 'normal', side: 'buy', ordType: 'limit',
      state: selectedStatus === 'FILLED' ? 'filled' : selectedStatus, sz: '0.001', px: '100000', accFillSz: '0.001', avgPx: '99000',
      cTime: start + 1100, uTime: start + 4000, tgtCcy: 'base_ccy', tradeQuoteCcy: 'USDT', fee: '-0.1', feeCcy: 'USDT', rebate: '0', rebateCcy: '' };
  const fills = mexc ? [{ symbol: 'BTCUSDT', orderId: 'exchange-1', id: 'fill-1', clientOrderId: null, price: '99000', qty: '0.001', quoteQty: '99',
    commission: '0.1', commissionAsset: 'USDT', time: start + 3000, isBuyer: true }] : [{ instType: 'SPOT', instId: 'BTC-USDT', ordId: 'exchange-1',
      tradeId: 'fill-1', billId: 'bill-1', side: 'buy', subType: '1', execType: 'T', fillSz: '0.001', fillPx: '99000', fee: '-0.1', feeCcy: 'USDT',
      fillTime: start + 3000, ts: start + 3100, tradeQuoteCcy: 'USDT' }];
  return { schema: 1, kind: 'live-order-recovery-capture', venue, account: 'main', clientOrderId: client, requestedAt: start + 5000, receivedAt: start + 8000,
    orderBefore: { kind: 'order', venue, requestedAt: start + 5000, receivedAt: start + 5500, query: mexc
      ? { symbol: 'BTCUSDT', origClientOrderId: client } : { instId: 'BTC-USDT', clOrdId: client }, data: structuredClone(raw) },
    fills: { kind: 'fills', venue, requestedAt: start + 6000, receivedAt: start + 6500, query: mexc ? { symbol: 'BTCUSDT', orderId: 'exchange-1', limit: '1000' }
      : { instType: 'SPOT', instId: 'BTC-USDT', ordId: 'exchange-1', limit: '100', begin: String(start - 1000), end: String(start + 6000) }, data: fills },
    orderAfter: { kind: 'order', venue, requestedAt: start + 7000, receivedAt: start + 8000, query: mexc
      ? { symbol: 'BTCUSDT', orderId: 'exchange-1' } : { instId: 'BTC-USDT', ordId: 'exchange-1' }, data: structuredClone(raw) } } as any;
}
function run(s: LiveOrderState, c: unknown, p = policy()) { return buildLiveOrderRecoveryEvidence(s, intentId, c, p); }
function applied(s: LiveOrderState, events: readonly LiveOrderEvent[]) { return events.reduce((a, event) => applyLiveOrderEvent(a, event), s); }
function both(c: any, values: Record<string, unknown>) { Object.assign(c.orderBefore.data, values); Object.assign(c.orderAfter.data, values); }

describe('persisted-intent recovery response binding', () => {
  it('records exact reported MEXC fills, observation, and terminal reconciliation as permanently local rehearsal', () => {
    const s = state(), result = run(s, capture(s));
    expect(result.blockers).toEqual([]); expect(result.terminalReconciliationEligible).toBe(true);
    expect(result.events.map(e => e.type)).toEqual(['fill-recorded', 'order-observed', 'terminal-reconciled']);
    expect(result).toMatchObject({ source: 'local-rehearsal', nonExecutable: true, captureProvenanceVerified: false, accountIdentityVerified: false });
    expect(applied(s, result.events).orders[0]).toMatchObject({ phase: 'reconciled', cashDelta: { BTC: '0.001', USDT: '-99.1', MX: '0' }, reserved: { BTC: '0', USDT: '0', MX: '0' } });
    expect(Object.isFrozen(result.events)).toBe(true); expect(Object.isFrozen(result.events[0])).toBe(true);
  });
  it('binds partial fills while retaining reservation and open outcome', () => {
    const s = state(), c = capture(s, 'PARTIALLY_FILLED'); both(c, { executedQty: '0.0004', cumulativeQuoteQty: '39.6' });
    Object.assign(c.fills.data[0], { qty: '0.0004', quoteQty: '39.6' });
    const result = run(s, c); expect(result.blockers).toEqual(['order-not-terminal']);
    expect(applied(s, result.events).orders[0]).toMatchObject({ phase: 'partially-filled', reserved: { USDT: '101' }, cashDelta: { BTC: '0.0004', USDT: '-39.7' } });
  });
  it('supports NEW with zero fills without inventing execution', () => {
    const s = state(), c = capture(s, 'NEW'); both(c, { executedQty: '0', cumulativeQuoteQty: '0' }); c.fills.data = [];
    const result = run(s, c); expect(result.events.map(e => e.type)).toEqual(['order-observed']);
    expect(applied(s, result.events).orders[0].phase).toBe('open');
  });
  it('reconciles a partially cancelled exact MEXC order without counting unexecuted amount', () => {
    const s = state(), c = capture(s, 'PARTIALLY_CANCELED'); both(c, { executedQty: '0.0004', cumulativeQuoteQty: '39.6' });
    Object.assign(c.fills.data[0], { qty: '0.0004', quoteQty: '39.6' });
    const result = run(s, c); expect(result.blockers).toEqual([]); expect(applied(s, result.events).orders[0].cashDelta.USDT).toBe('-39.7');
  });
  it('keeps nonzero OKX quote derived, without any cash fill or release', () => {
    const s = state('okx'), result = run(s, capture(s));
    expect(result.blockers).toEqual(['quote-amount-not-reported']); expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ type: 'order-observed', observation: { quoteAmountSource: 'derived', cumulativeQuoteQuantity: '99' } });
    expect(applied(s, result.events).orders[0]).toMatchObject({ phase: 'terminal-unreconciled', cashDelta: { BTC: '0', USDT: '0', MX: '0' }, reserved: { USDT: '101' } });
  });
  it('observes a still-open OKX partial order', () => {
    const s = state('okx'), c = capture(s, 'partially_filled'); both(c, { accFillSz: '0.0004' }); c.fills.data[0].fillSz = '0.0004';
    const result = run(s, c); expect(result.events).toHaveLength(1); expect(result.blockers).toEqual(['quote-amount-not-reported', 'order-not-terminal']);
  });
  it('allows zero-execution OKX cancellation only with empty complete fills', () => {
    const s = state('okx'), c = capture(s, 'canceled'); both(c, { accFillSz: '0', avgPx: '', fee: '0' }); c.fills.data = [];
    const result = run(s, c); expect(result.blockers).toEqual([]); expect(result.terminalReconciliationEligible).toBe(true);
  });
  it('derives event ids from normalized evidence and intent rather than current evaluation time', () => {
    const s = state(), c = capture(s), first = run(s, c), second = run(s, c, { ...policy(), now: policy().now + 100 });
    expect(first).toEqual(second);
    both(c, { price: '100000.000', Qty: '0.001000', cumulativeQuoteQty: '99.0' });
    Object.assign(c.fills.data[0], { qty: '0.001000', quoteQty: '99.000', commission: '0.1000' });
    expect(run(s, c)).toEqual(first);
    const next = applied(s, first.events); expect(applied(next, first.events)).toEqual(next);
  });
  it('accepts legacy MEXC aliases with matching values and rejects conflicts', () => {
    const s = state(), c = capture(s); both(c, { origQty: '0.0010', cummulativeQuoteQty: '99.00' });
    expect(run(s, c).blockers).toEqual([]); both(c, { origQty: '0.002' }); expect(run(s, c).blockers).toEqual(['conflicting-order-aliases']);
  });
  it('deduplicates identical fills and rejects altered duplicate fees', () => {
    const s = state(), c = capture(s); c.fills.data.push(structuredClone(c.fills.data[0]));
    expect(run(s, c).events.filter(e => e.type === 'fill-recorded')).toHaveLength(1);
    c.fills.data[1].commission = '0.2'; expect(run(s, c).blockers).toEqual(['fill-id-conflict']);
  });
  it.each([
    ['wrong client', (c: any) => both(c, { clientOrderId: 'A'.repeat(32) })],
    ['wrong venue', (c: any) => { c.venue = 'okx'; }],
    ['wrong account', (c: any) => { c.account = 'sub'; }],
    ['wrong instrument', (c: any) => both(c, { symbol: 'ETHUSDT' })],
    ['wrong side', (c: any) => both(c, { side: 'SELL' })],
    ['wrong order type', (c: any) => both(c, { type: 'MARKET' })],
    ['wrong size', (c: any) => both(c, { Qty: '0.002' })],
    ['wrong limit', (c: any) => both(c, { price: '100001' })],
    ['missing client', (c: any) => { delete c.orderAfter.data.clientOrderId; }],
    ['wrong fill order', (c: any) => { c.fills.data[0].orderId = 'unrelated-order'; }],
    ['wrong fill side', (c: any) => { c.fills.data[0].isBuyer = false; }],
    ['wrong fill client', (c: any) => { c.fills.data[0].clientOrderId = 'A'.repeat(32); }],
    ['missing fee', (c: any) => { delete c.fills.data[0].commission; }],
    ['self trade', (c: any) => { c.fills.data[0].isSelfTrade = true; }],
    ['foreign query', (c: any) => { c.orderBefore.query.origClientOrderId = 'A'.repeat(32); }],
    ['signed query extras', (c: any) => { c.orderBefore.query.signature = 'private-signature'; }],
    ['changed snapshot', (c: any) => { c.orderAfter.data.updateTime++; }],
  ])('rejects %s without admitting any event', (_label, mutate) => {
    const s = state(), c = capture(s); mutate(c); const result = run(s, c);
    expect(result.events).toEqual([]); expect(result.blockers.length).toBeGreaterThan(0); expect(result.terminalReconciliationEligible).toBe(false);
    expect(JSON.stringify(result)).not.toContain('private-signature');
  });
  it.each([
    ['stale capture', (c: any) => undefined, { ...policy(), now: start + 80_000 }],
    ['future local receipt', (c: any) => { c.receivedAt = start + 20_000; }, policy()],
    ['overlapping reads', (c: any) => { c.fills.requestedAt = start + 5400; }, policy()],
    ['before dispatch', (c: any) => { c.requestedAt = start; c.orderBefore.requestedAt = start; }, policy()],
    ['prior unrelated order creation', (c: any) => both(c, { time: start - 2000 }), policy()],
    ['too-future upstream', (c: any) => both(c, { updateTime: start + 50_000 }), policy()],
    ['precreation fill', (c: any) => { c.fills.data[0].time = start + 1050; }, policy()],
    ['pre-dispatch fill within skew', (c: any) => { both(c, { time: start + 500 }); c.fills.data[0].time = start + 900; }, policy()],
  ])('rejects %s', (_label, mutate, p) => {
    const s = state(), c = capture(s); mutate(c); expect(run(s, c, p).events).toEqual([]); expect(run(s, c, p).blockers.length).toBeGreaterThan(0);
  });
  it('does not infer failure or release from missing order rows or empty fills', () => {
    const s = state(), c = capture(s); c.orderBefore.data = [];
    expect(run(s, c).events).toEqual([]); c.orderBefore.data = structuredClone(c.orderAfter.data); c.fills.data = [];
    const result = run(s, c); expect(result.blockers).toContain('fill-base-total-mismatch');
    expect(applied(s, result.events).orders[0].reserved.USDT).toBe('101');
  });
  it('requires known exchange-id lookup after one is persisted', () => {
    const s = state(), c = capture(s, 'NEW'); both(c, { executedQty: '0', cumulativeQuoteQty: '0' }); c.fills.data = [];
    const known = applied(s, run(s, c).events); const next = capture(known, 'NEW'); both(next, { executedQty: '0', cumulativeQuoteQty: '0' }); next.fills.data = [];
    expect(run(known, next).blockers).toEqual(['known-order-id-query-required']);
    next.orderBefore.query = { symbol: 'BTCUSDT', orderId: 'exchange-1' }; expect(run(known, next).blockers).toEqual(['order-not-terminal']);
  });
  it('rejects over-retention MEXC captures even if the result claims the old id', () => {
    const s = state(), c = capture(s), delta = 7 * 86_400_000;
    c.requestedAt += delta; c.receivedAt += delta;
    for (const read of [c.orderBefore, c.fills, c.orderAfter]) { read.requestedAt += delta; read.receivedAt += delta; }
    expect(run(s, c, { ...policy(), now: policy().now + delta }).blockers).toEqual(['mexc-order-retention-exceeded']);
  });
  it('preserves unexpected reported fees in quarantine and refuses release', () => {
    const s = state(), c = capture(s); c.fills.data[0].commission = '2';
    const result = run(s, c); expect(result.events[0].type).toBe('fill-quarantined'); expect(result.blockers).toEqual(['accounting-anomaly-unresolved']);
    expect(applied(s, result.events).orders[0]).toMatchObject({ phase: 'quarantined', cashDelta: { USDT: '-101' }, reserved: { USDT: '101' } });
  });
  it('keeps exact fill costs when order quote is beyond cap', () => {
    const s = state(), c = capture(s); both(c, { cumulativeQuoteQty: '101' }); c.fills.data[0].quoteQty = '101'; c.fills.data[0].price = '101000';
    const result = run(s, c); expect(result.events[0].type).toBe('fill-quarantined'); expect(result.blockers).toContain('lifecycle-observation-rejected');
    expect(applied(s, result.events).orders[0].cashDelta.USDT).toBe('-101.1');
  });
  it('never outputs unknown upstream fields or arbitrary source errors', () => {
    const s = state(), c = capture(s); both(c, { privateUnknown: 'secret-marker' }); c.fills.data[0].headers = { cookie: 'secret-marker' };
    expect(JSON.stringify(run(s, c))).not.toContain('secret-marker'); expect(run(s, c).blockers).toEqual([]);
    expect(run(s, { privateError: 'secret-marker' }).blockers).toEqual(['invalid-recovery-capture']);
  });
  it('rejects forged state, extra authority flags and unbounded policy', () => {
    const s = state(), c = capture(s); expect(run(structuredClone(s), c).events).toEqual([]);
    c.captureProvenanceVerified = true; expect(run(s, c).blockers).toEqual(['invalid-recovery-capture']);
    expect(() => parseLiveRecoveryEvidencePolicy({ ...policy(), maxClockSkewMs: Infinity })).toThrow('invalid-recovery-policy');
    expect(run(s, capture(s), { ...policy(), maxCaptureAgeMs: 60_001 }).blockers).toEqual(['invalid-recovery-policy']);
  });
  it('bounds capture bytes and rejects precision requiring rounding', () => {
    const s = state(), c = capture(s); c.orderBefore.data.unknown = 'x'.repeat(LIVE_RECOVERY_EVIDENCE_LIMITS.captureBytes);
    expect(run(s, c).blockers).toEqual(['recovery-capture-too-large']);
    const okx = state('okx'), o = capture(okx); both(o, { avgPx: '99000.000000000000000001' });
    expect(run(okx, o).blockers).toEqual(['unsupported-derived-precision']);
  });
  it('rejects OKX fee rebates or incomplete/cross-page windows without invented zero costs', () => {
    const s = state('okx'), c = capture(s); c.fills.data[0].fee = '0.1'; expect(run(s, c).blockers).toEqual(['unsupported-fee-rebate']);
    c.fills.data[0].fee = '-0.1'; c.fills.query.begin = String(start + 2000); expect(run(s, c).blockers).toEqual(['fills-window-incomplete']);
  });
  it('persists upstream creation/update time and rejects older later-retrieved snapshots', () => {
    const s = state(), c = capture(s, 'NEW'); both(c, { executedQty: '0', cumulativeQuoteQty: '0' }); c.fills.data = [];
    const first = run(s, c); expect(first.events[0]).toMatchObject({ observation: { sourceCreatedAt: at(1100), sourceUpdatedAt: at(4000) } });
    const known = applied(s, first.events), next = structuredClone(c); next.orderBefore.query = { symbol: 'BTCUSDT', orderId: 'exchange-1' };
    next.requestedAt += 10_000; next.receivedAt += 10_000;
    for (const read of [next.orderBefore, next.fills, next.orderAfter]) { read.requestedAt += 10_000; read.receivedAt += 10_000; }
    both(next, { updateTime: start + 3900 });
    const rejected = run(known, next, { ...policy(), now: policy().now + 10_000 });
    expect(rejected.blockers).toEqual(['lifecycle-evidence-rejected']); expect(rejected.events).toEqual([]);
  });
  it('accepts enclosing capture timestamps with ordinary independent millisecond clock differences', () => {
    const s = state(), c = capture(s); c.requestedAt--; c.receivedAt++;
    expect(run(s, c).blockers).toEqual([]);
  });
  it('does not accept a newly reused client id created long after the dispatch marker', () => {
    const s = state(), c = capture(s), delta = 100_000;
    c.requestedAt += delta; c.receivedAt += delta;
    for (const read of [c.orderBefore, c.fills, c.orderAfter]) { read.requestedAt += delta; read.receivedAt += delta; }
    both(c, { time: start + delta, updateTime: start + delta + 1000 });
    expect(run(s, c, { ...policy(), now: policy().now + delta }).blockers).toEqual(['order-time-binding-mismatch']);
  });
  it('rejects contradictory known MEXC client identity fields even in a direct offline capture', () => {
    const s = state(), c = capture(s); both(c, { origClientOrderId: 'A'.repeat(32) });
    expect(run(s, c).blockers).toEqual(['order-binding-mismatch']);
  });
  it('accepts an empty optional OKX fill client id while requiring the verified exchange id', () => {
    const s = state('okx'), c = capture(s); c.fills.data[0].clOrdId = '';
    expect(run(s, c).blockers).toEqual(['quote-amount-not-reported']);
    c.fills.data[0].ordId = 'other'; expect(run(s, c).events).toEqual([]);
  });
  it('does not discard a nonzero order fee on zero-execution OKX cancellation', () => {
    const s = state('okx'), c = capture(s, 'canceled'); both(c, { accFillSz: '0', avgPx: '', fee: '-1' }); c.fills.data = [];
    expect(run(s, c).blockers).toEqual(['zero-execution-has-cost']); expect(run(s, c).events).toEqual([]);
  });
  it('rejects contradictory explicit fill price outside the limit even when quote/base conceals it', () => {
    const s = state(), c = capture(s); c.fills.data[0].price = '100001';
    expect(run(s, c).blockers).toEqual(['fill-price-evidence-conflict']); expect(run(s, c).events).toEqual([]);
  });
  it('keeps the raw page count in digest and refuses a capped OKX page even with duplicate records', () => {
    const s = state('okx'), c = capture(s), first = run(s, c); c.fills.data = Array.from({ length: 100 }, () => structuredClone(c.fills.data[0]));
    const capped = run(s, c); expect(capped.blockers).toContain('fills-response-at-limit'); expect(capped.captureDigest).not.toBe(first.captureDigest);
    expect(capped.events).toHaveLength(1); expect(capped.terminalReconciliationEligible).toBe(false);
  });

});
