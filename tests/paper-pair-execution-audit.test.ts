import { describe, expect, it } from 'vitest';
import { projectExecutionRows } from '../src/accounts/execution-records.js';
import {
  auditRecordedOrder, executionOrderKey, reconcileRecordedOrder
} from '../src/paper-pair/execution-audit.js';
import {
  applySettlementEvent, createSettlementState, viewSettlementState,
  type SettlementEvent, type SettlementFunds, type SettlementState
} from '../src/paper-pair/settlement.js';

const T = 1_800_000_000_000;
const funds = (change: Partial<SettlementFunds> = {}): SettlementFunds => ({ BTC: '0', USDT: '0', MX: '0', ...change });
function mexc() {
  const order = { symbol: 'BTCUSDT', orderId: 'order-101', side: 'BUY', type: 'LIMIT', status: 'FILLED',
    origQty: '0.001', executedQty: '0.001', cumulativeQuoteQty: '84', origQuoteOrderQty: '0', time: T, updateTime: T + 20 };
  const trade = { symbol: 'BTCUSDT', orderId: 'order-101', id: 'trade-201', price: '84000', qty: '0.001',
    quoteQty: '84', commission: '0.042', commissionAsset: 'USDT', time: T + 10, isBuyer: true };
  return { schema: 1, kind: 'recorded-order-audit', source: 'synthetic', account: 'main', venue: 'mexc',
    observedAt: T + 30, expected: { orderId: 'order-101', side: 'buy' }, limit: 100,
    orderBefore: { ...order }, orderAfter: { ...order }, fills: [trade] };
}
function okx() {
  const order = { instType: 'SPOT', instId: 'BTC-USDT', tdMode: 'cash', category: 'normal',
    ordId: 'order-101', side: 'buy', ordType: 'limit', state: 'filled', sz: '0.001', tgtCcy: 'base_ccy', tradeQuoteCcy: 'USDT', accFillSz: '0.001',
    avgPx: '84000', fee: '-0.000001', feeCcy: 'BTC', rebate: '0', rebateCcy: '', cTime: String(T), uTime: String(T + 20) };
  const fill = { instType: 'SPOT', instId: 'BTC-USDT', ordId: 'order-101', tradeId: 'trade-201', billId: 'bill-301',
    side: 'buy', subType: '1', execType: 'T', fillSz: '0.001', fillPx: '84000', fee: '-0.000001',
    feeCcy: 'BTC', fillTime: String(T + 10), ts: String(T + 15) };
  return { schema: 1, kind: 'recorded-order-audit', source: 'synthetic', account: 'main', venue: 'okx',
    observedAt: T + 30, expected: { orderId: 'order-101', side: 'buy' }, limit: 100,
    orderBefore: { code: '0', data: [{ ...order }] }, orderAfter: { code: '0', data: [{ ...order }] },
    fills: { code: '0', data: [fill] } };
}
function bothMexc(record: ReturnType<typeof mexc>, change: Partial<ReturnType<typeof mexc>['orderAfter']>) {
  Object.assign(record.orderBefore, change); Object.assign(record.orderAfter, change);
}
function bothOkx(record: ReturnType<typeof okx>, change: Partial<ReturnType<typeof okx>['orderAfter']['data'][number]>) {
  Object.assign(record.orderBefore.data[0], change); Object.assign(record.orderAfter.data[0], change);
}
function paper(venue: 'mexc' | 'okx' = 'mexc', unknown = true, orderId = executionOrderKey(venue, 'order-101')) {
  const plan: SettlementEvent = { type: 'prepare', id: 'prepare', at: T, pairId: 'pair-1',
    buy: { venue, orderId, sizing: { kind: 'base', baseQuantity: '0.001', maxQuoteAmount: '100' },
      feeCaps: funds({ USDT: '0.1', BTC: '0.000002', MX: '0.1' }) },
    sell: { venue: venue === 'mexc' ? 'okx' : 'mexc', orderId: 'other-order', baseQuantity: '0.001', feeCaps: funds() } };
  let state = applySettlementEvent(createSettlementState({ mexc: funds({ BTC: '1', USDT: '1000', MX: '1' }),
    okx: funds({ BTC: '1', USDT: '1000', MX: '1' }) }), plan);
  if (unknown) state = applySettlementEvent(state, { type: 'unknown', id: 'unknown', at: T + 5, pairId: 'pair-1', side: 'buy' });
  return state;
}
function expectAtomicRejection(state: SettlementState, input: unknown, reason: string, pairId = 'pair-1') {
  const snapshot = structuredClone(state);
  expect(() => reconcileRecordedOrder(state, pairId, 'reconcile', input)).toThrow(reason);
  expect(state).toEqual(snapshot);
}

describe('MEXC recorded execution audit', () => {
  it('preserves exact reported quote and fees without substituting price times quantity', () => {
    const input = mexc(); input.fills[0].price = '83999.99';
    const snapshot = structuredClone(input);
    const result = auditRecordedOrder(input);
    expect(result).toMatchObject({ source: 'synthetic', executable: false, wholeAccountHistoryProven: false,
      uniqueFills: 1, duplicateRows: 0, quoteSource: 'reported-fill-quote', settlementReady: true,
      blockers: [], outcome: 'filled', totals: { baseQuantity: '0.001', quoteQuantity: '84', fees: funds({ USDT: '0.042' }) } });
    expect(result.checks).toEqual({ stableOrder: true, terminal: true, uncappedResponse: true,
      baseTotalMatches: true, quoteTotalMatches: true, feeTotalMatches: null });
    expect(input).toEqual(snapshot);
    expect(result.orderKey).toBe(executionOrderKey('mexc', 'order-101'));
    expect(JSON.stringify(result)).not.toContain('order-101');
    expect(JSON.stringify(result)).not.toContain('trade-201');
  });

  it('supports documented order field aliases and compares their exact numeric values', () => {
    const input = mexc();
    const aliased = { ...input.orderAfter, Qty: '0.0010', cummulativeQuoteQty: '84.000' };
    expect(auditRecordedOrder({ ...input, orderBefore: aliased, orderAfter: aliased }).settlementReady).toBe(true);
    const { origQty: _origQty, cumulativeQuoteQty: _quote, ...alternative } = aliased;
    expect(auditRecordedOrder({ ...input, orderBefore: alternative, orderAfter: alternative }).settlementReady).toBe(true);
    expect(() => auditRecordedOrder({ ...input, orderAfter: { ...aliased, Qty: '0.002' } })).toThrow('conflicting-field-aliases');
    expect(() => auditRecordedOrder({ ...input, orderAfter: { ...aliased, cummulativeQuoteQty: '85' } })).toThrow('conflicting-field-aliases');
    const { Qty: _qty, ...missingQty } = alternative;
    expect(() => auditRecordedOrder({ ...input, orderAfter: missingQty })).toThrow('missing-order-total');
  });

  it.each(['CANCELED', 'PARTIALLY_CANCELED'])('accepts exact partially executed %s and keeps actual fees', status => {
    const input = mexc(); bothMexc(input, { status, origQty: '0.002' });
    expect(auditRecordedOrder(input)).toMatchObject({ settlementReady: true, outcome: 'cancelled',
      totals: { baseQuantity: '0.001', quoteQuantity: '84', fees: funds({ USDT: '0.042' }) } });
  });

  it('allows a proven zero-fill cancellation but never settles a live order from an empty page', () => {
    const input = mexc(); input.fills = [];
    bothMexc(input, { status: 'CANCELED', executedQty: '0', cumulativeQuoteQty: '0' });
    expect(auditRecordedOrder(input)).toMatchObject({ settlementReady: true, uniqueFills: 0, totals: { baseQuantity: '0', quoteQuantity: '0', fees: funds() } });
    bothMexc(input, { status: 'NEW' });
    expect(auditRecordedOrder(input).blockers).toEqual(['order-not-terminal']);
  });

  it('rejects an apparently complete page while the order is still partial', () => {
    const input = mexc(); bothMexc(input, { status: 'PARTIALLY_FILLED', origQty: '0.002' });
    expect(auditRecordedOrder(input)).toMatchObject({ settlementReady: false, blockers: ['order-not-terminal'] });
  });

  it('does not infer missing executions or fee amounts from order aggregates', () => {
    const input = mexc(); input.fills = [];
    expect(auditRecordedOrder(input)).toMatchObject({ settlementReady: false,
      blockers: ['base-total-mismatch', 'quote-total-mismatch'], totals: { baseQuantity: '0', quoteQuantity: '0', fees: funds() } });
  });

  it('requires stable order snapshots even when the final totals match every fill', () => {
    const input = mexc(); input.orderBefore.status = 'PARTIALLY_FILLED'; input.orderBefore.updateTime = T + 15;
    expect(auditRecordedOrder(input)).toMatchObject({ settlementReady: false, blockers: ['order-changed-during-observation'] });
  });

  it('treats a page at its requested limit as possibly truncated, including repeated rows', () => {
    const input = mexc(); input.limit = 2; input.fills.push({ ...input.fills[0] });
    expect(auditRecordedOrder(input)).toMatchObject({ uniqueFills: 1, duplicateRows: 1,
      settlementReady: false, blockers: ['response-at-limit'], totals: { quoteQuantity: '84', fees: funds({ USDT: '0.042' }) } });
    input.limit = 1;
    expect(() => auditRecordedOrder(input)).toThrow('response-exceeds-limit');
  });

  it('deduplicates retransmitted fills but rejects fee or amount changes under the same trade id', () => {
    const input = mexc(); input.fills.push({ ...input.fills[0], qty: '0.0010', commission: '0.0420' });
    expect(auditRecordedOrder(input)).toMatchObject({ uniqueFills: 1, duplicateRows: 1, settlementReady: true });
    input.fills[1].commission = '0.043';
    expect(() => auditRecordedOrder(input)).toThrow('fill-id-conflict');
    input.fills[1].commission = '0.042'; input.fills[1].quoteQty = '85';
    expect(() => auditRecordedOrder(input)).toThrow('fill-id-conflict');
    input.fills[1].quoteQty = '84'; input.fills[1].price = '84001';
    expect(() => auditRecordedOrder(input)).toThrow('fill-id-conflict');
  });

  it.each([
    { origQty: '0' }, { origQty: '0.0009' }, { origQty: '0.002' },
    { origQty: '0.0009', type: 'MARKET', side: 'SELL' }
  ])('rejects impossible base-target order quantities %j', change => {
    const input = mexc(); bothMexc(input, change);
    expect(() => auditRecordedOrder(input)).toThrow('order-size-mismatch');
  });

  it('sums different fee assets over distinct fills at exact 18-place precision', () => {
    const input = mexc();
    input.fills[0] = { ...input.fills[0], qty: '0.0004', quoteQty: '33.6', commission: '0.000000000000000001' };
    input.fills.push({ ...input.fills[0], id: 'trade-202', qty: '0.0006', quoteQty: '50.4',
      commission: '0.123456789012345678', commissionAsset: 'MX', time: T + 11 });
    expect(auditRecordedOrder(input)).toMatchObject({ settlementReady: true, uniqueFills: 2,
      totals: { baseQuantity: '0.001', quoteQuantity: '84', fees: funds({ USDT: '0.000000000000000001', MX: '0.123456789012345678' }) } });
    input.fills.reverse();
    expect(auditRecordedOrder(input).fills.map(fill => fill.executedAt)).toEqual([T + 10, T + 11]);
  });

  it.each([
    ['order id', (r: ReturnType<typeof mexc>) => { r.orderAfter.orderId = 'other'; }, 'order-binding-mismatch'],
    ['order side', (r: ReturnType<typeof mexc>) => { r.orderAfter.side = 'SELL'; }, 'order-binding-mismatch'],
    ['fill order', (r: ReturnType<typeof mexc>) => { r.fills[0].orderId = 'other'; }, 'fill-binding-mismatch'],
    ['fill side', (r: ReturnType<typeof mexc>) => { r.fills[0].isBuyer = false; }, 'fill-binding-mismatch'],
    ['future order', (r: ReturnType<typeof mexc>) => { r.orderAfter.updateTime = T + 31; }, 'invalid-order-time'],
    ['reversed order time', (r: ReturnType<typeof mexc>) => { r.orderAfter.time = T + 21; }, 'invalid-order-time'],
    ['pre-order fill', (r: ReturnType<typeof mexc>) => { r.fills[0].time = T - 1; }, 'invalid-fill-time'],
    ['future fill', (r: ReturnType<typeof mexc>) => { r.fills[0].time = T + 21; }, 'invalid-fill-time'],
    ['zero quote', (r: ReturnType<typeof mexc>) => { r.fills[0].quoteQty = '0'; }, 'non-positive-fill'],
    ['zero price', (r: ReturnType<typeof mexc>) => { r.fills[0].price = '0'; }, 'non-positive-fill'],
    ['zero size', (r: ReturnType<typeof mexc>) => { r.fills[0].qty = '0'; }, 'non-positive-fill'],
    ['new order with executions', (r: ReturnType<typeof mexc>) => { bothMexc(r, { status: 'NEW' }); }, 'inconsistent-order-status'],
    ['filled without executions', (r: ReturnType<typeof mexc>) => { bothMexc(r, { executedQty: '0' }); }, 'order-size-mismatch']
  ])('rejects %s', (_name, mutate, reason) => {
    const input = mexc(); mutate(input); expect(() => auditRecordedOrder(input)).toThrow(reason);
  });

  it.each([
    { commissionAsset: 'BNB' }, { qty: 0.001 }, { commission: '-0.1' }, { qty: '1e-3' },
    { qty: '0.0000000000000000001' }, { id: Number.MAX_SAFE_INTEGER + 1 }, { id: 'unsafe/id' }, { isSelfTrade: true }
  ])('fails closed for unsupported or unsafe fill facts %j', change => {
    const input = mexc(); expect(() => auditRecordedOrder({ ...input, fills: [{ ...input.fills[0], ...change }] })).toThrow();
  });

  it('keeps source/account/input boundaries explicit', () => {
    const input = mexc();
    expect(auditRecordedOrder({ ...input, source: 'recorded' }).source).toBe('recorded');
    for (const patch of [{ account: 'subaccount' }, { source: 'live' }, { authorization: 'not-a-secret' }, { schema: 2 }]) {
      expect(() => auditRecordedOrder({ ...input, ...patch })).toThrow('invalid-execution-record');
    }
  });
});

describe('OKX execution audit keeps derived quote out of exact settlement', () => {
  it('inverts fee signs but blocks nonzero execution even when price multiplication happens to be exact', () => {
    const result = auditRecordedOrder(okx());
    expect(result).toMatchObject({ settlementReady: false, blockers: ['quote-amount-not-reported'],
      quoteSource: 'derived-price-times-size', totals: { baseQuantity: '0.001', quoteQuantity: '84', fees: funds({ BTC: '0.000001' }) },
      checks: { baseTotalMatches: true, quoteTotalMatches: null, feeTotalMatches: true } });
  });

  it.each([
    { side: 'buy', feeCcy: 'BTC', fee: '-0.000001', expected: funds({ BTC: '0.000001' }) },
    { side: 'buy', feeCcy: 'USDT', fee: '-0.084', expected: funds({ USDT: '0.084' }) },
    { side: 'sell', feeCcy: 'USDT', fee: '-0.084', expected: funds({ USDT: '0.084' }) }
  ])('accepts ordinary taker $side fees in $feeCcy while keeping quote blocked', ({ side, feeCcy, fee, expected }) => {
    const input = okx(); input.expected.side = side;
    bothOkx(input, { side, feeCcy, fee });
    Object.assign(input.fills.data[0], { side, subType: side === 'buy' ? '1' : '2', feeCcy, fee });
    expect(auditRecordedOrder(input)).toMatchObject({ settlementReady: false,
      blockers: ['quote-amount-not-reported'], totals: { fees: expected }, checks: { feeTotalMatches: true } });
  });

  it.each([
    { side: 'buy', unsupported: 'MX' },
    { side: 'sell', unsupported: 'MX' },
    { side: 'sell', unsupported: 'BTC' }
  ].flatMap(example => ['before', 'after', 'fill', 'all'].map(location => ({ ...example, location }))))(
    'rejects nonzero $side $unsupported fee from $location even if aggregate totals could agree', ({ side, unsupported, location }) => {
      const input = okx(); input.expected.side = side;
      bothOkx(input, { side, fee: '-0.084', feeCcy: 'USDT' });
      Object.assign(input.fills.data[0], { side, subType: side === 'buy' ? '1' : '2', fee: '-0.084', feeCcy: 'USDT' });
      if (location === 'before' || location === 'all') input.orderBefore.data[0].feeCcy = unsupported;
      if (location === 'after' || location === 'all') input.orderAfter.data[0].feeCcy = unsupported;
      if (location === 'fill' || location === 'all') input.fills.data[0].feeCcy = unsupported;
      expect(() => auditRecordedOrder(input)).toThrow('unsupported-okx-fee-currency');
    });

  it.each([
    { side: 'buy', feeCcy: 'MX' }, { side: 'sell', feeCcy: 'BTC' }, { side: 'sell', feeCcy: 'MX' }
  ].flatMap(example => ['0', '-0.000'].map(fee => ({ ...example, fee }))))(
    'does not invent a currency restriction from a zero $side fee $fee in $feeCcy', ({ side, feeCcy, fee }) => {
      const input = okx(); input.expected.side = side;
      bothOkx(input, { side, feeCcy, fee });
      Object.assign(input.fills.data[0], { side, subType: side === 'buy' ? '1' : '2', feeCcy, fee });
      expect(auditRecordedOrder(input)).toMatchObject({ blockers: ['quote-amount-not-reported'],
        totals: { fees: funds() }, checks: { feeTotalMatches: true } });
    });

  it('retains independent aggregate fee currency reconciliation for supported currencies', () => {
    const input = okx(); bothOkx(input, { feeCcy: 'USDT' });
    expect(auditRecordedOrder(input)).toMatchObject({ settlementReady: false,
      blockers: ['fee-total-mismatch', 'quote-amount-not-reported'], checks: { feeTotalMatches: false } });
  });

  it('accepts explicit USDT fill quote currency and preserves absent-field compatibility', () => {
    const input = okx(), before = auditRecordedOrder(input);
    Object.assign(input.fills.data[0], { tradeQuoteCcy: 'USDT' });
    expect(auditRecordedOrder(input)).toEqual(before);
  });

  it.each(['USDC', 'BTC', '', null])('rejects explicit unsupported fill quote currency %j', tradeQuoteCcy => {
    const input = okx(); Object.assign(input.fills.data[0], { tradeQuoteCcy });
    expect(() => auditRecordedOrder(input)).toThrow('invalid-execution-record');
  });

  it('cannot lose a conflicting quote currency through private projection before audit', () => {
    const input = okx();
    const projected = projectExecutionRows('okx', 'fills', [{ ...input.fills.data[0], tradeQuoteCcy: 'USDC' }]);
    expect(() => auditRecordedOrder({ ...input, fills: { code: '0', data: projected } })).toThrow('invalid-execution-record');
  });

  it('retains 36-place price times size without pretending it is a reported quote amount', () => {
    const input = okx(); bothOkx(input, { accFillSz: '0.000000000000000001', avgPx: '0.000000000000000001', fee: '0' });
    Object.assign(input.fills.data[0], { fillSz: '0.000000000000000001', fillPx: '0.000000000000000001', fee: '0' });
    const result = auditRecordedOrder(input);
    expect(result.totals.quoteQuantity).toBe('0.000000000000000000000000000000000001');
    expect(result.blockers).toEqual(['quote-amount-not-reported']);
  });

  it('allows a stable zero-execution cancellation with no derived monetary facts', () => {
    const input = okx(); bothOkx(input, { state: 'canceled', accFillSz: '0', avgPx: '', fee: '0' }); input.fills.data = [];
    expect(auditRecordedOrder(input)).toMatchObject({ settlementReady: true, outcome: 'cancelled',
      quoteSource: 'zero-execution', totals: { baseQuantity: '0', quoteQuantity: '0', fees: funds() } });
  });

  it.each([{ sz: '0.002' }, { tgtCcy: 'quote_ccy' }])('blocks a zero-fill cancellation if the order sizing changed %j', change => {
    const input = okx(); bothOkx(input, { state: 'canceled', accFillSz: '0', avgPx: '', fee: '0' }); input.fills.data = [];
    Object.assign(input.orderAfter.data[0], change);
    expect(auditRecordedOrder(input)).toMatchObject({ settlementReady: false, blockers: ['order-changed-during-observation'] });
  });

  it('accepts the documented empty no-rebate field without guessing a missing fee', () => {
    const input = okx(); bothOkx(input, { rebate: '' });
    expect(auditRecordedOrder(input).blockers).toEqual(['quote-amount-not-reported']);
    bothOkx(input, { fee: '' });
    expect(() => auditRecordedOrder(input)).toThrow('invalid-execution-record');
  });

  it('detects independently mismatched order base and aggregate fee totals', () => {
    const input = okx(); bothOkx(input, { accFillSz: '0.002', fee: '-0.000002' });
    expect(auditRecordedOrder(input).blockers).toEqual(['base-total-mismatch', 'fee-total-mismatch', 'quote-amount-not-reported']);
  });

  it.each(['order-positive', 'fill-positive', 'rebate'])('rejects %s instead of interpreting it as a fee', field => {
    const input = okx();
    if (field === 'order-positive') bothOkx(input, { fee: '0.000001' });
    else if (field === 'fill-positive') input.fills.data[0].fee = '0.000001';
    else bothOkx(input, { rebate: '0.1' });
    expect(() => auditRecordedOrder(input)).toThrow('unsupported-fee-rebate');
  });

  it('deduplicates a repeated trade and bill without posting the fee again', () => {
    const input = okx(); input.fills.data.push({ ...input.fills.data[0] });
    expect(auditRecordedOrder(input)).toMatchObject({ uniqueFills: 1, duplicateRows: 1,
      totals: { fees: funds({ BTC: '0.000001' }) }, checks: { feeTotalMatches: true } });
  });

  it('rejects a repeated fill whose quote-currency evidence changes from missing to provided', () => {
    const input = okx();
    input.fills.data.push(Object.assign({ ...input.fills.data[0] }, { tradeQuoteCcy: 'USDT' }));
    expect(() => auditRecordedOrder(input)).toThrow('fill-id-conflict');
    input.fills.data.reverse();
    expect(() => auditRecordedOrder(input)).toThrow('fill-id-conflict');
  });

  it('deduplicates repeated fills when both explicitly report USDT quote currency', () => {
    const input = okx(); Object.assign(input.fills.data[0], { tradeQuoteCcy: 'USDT' });
    input.fills.data.push({ ...input.fills.data[0] });
    expect(auditRecordedOrder(input)).toMatchObject({ uniqueFills: 1, duplicateRows: 1,
      totals: { fees: funds({ BTC: '0.000001' }) }, checks: { feeTotalMatches: true },
      blockers: ['quote-amount-not-reported'] });
  });

  it('rejects a new bill for an existing trade and a reused bill for a different trade', () => {
    const input = okx(); input.fills.data.push({ ...input.fills.data[0], billId: 'bill-302' });
    expect(() => auditRecordedOrder(input)).toThrow('fill-id-conflict');
    input.fills.data[1] = { ...input.fills.data[0], tradeId: 'trade-202' };
    expect(() => auditRecordedOrder(input)).toThrow('bill-id-conflict');
  });

  it('rejects changed trade payloads even when the bill id is unchanged', () => {
    const input = okx(); input.fills.data.push({ ...input.fills.data[0], fee: '-0.000002' });
    expect(() => auditRecordedOrder(input)).toThrow('fill-id-conflict');
  });

  it.each([
    ['margin', (r: ReturnType<typeof okx>) => { r.orderAfter.data[0].tdMode = 'cross'; }, 'invalid-execution-record'],
    ['maker', (r: ReturnType<typeof okx>) => { r.fills.data[0].execType = 'M'; }, 'invalid-execution-record'],
    ['wrong subtype', (r: ReturnType<typeof okx>) => { r.fills.data[0].subType = '2'; }, 'fill-side-subtype-mismatch'],
    ['future fill report', (r: ReturnType<typeof okx>) => { r.fills.data[0].ts = String(T + 31); }, 'invalid-fill-time'],
    ['fill after report', (r: ReturnType<typeof okx>) => { r.fills.data[0].ts = String(T + 9); }, 'invalid-fill-time'],
    ['API error envelope', (r: ReturnType<typeof okx>) => { r.fills.code = '50000'; }, 'invalid-execution-record'],
    ['missing average', (r: ReturnType<typeof okx>) => { r.orderAfter.data[0].avgPx = ''; }, 'missing-order-average-price'],
    ['oversized limit', (r: ReturnType<typeof okx>) => { r.limit = 101; }, 'invalid-response-limit']
  ])('rejects %s outside the supported narrow contract', (_name, mutate, reason) => {
    const input = okx(); mutate(input); expect(() => auditRecordedOrder(input)).toThrow(reason);
  });

  it('requires full success envelopes and exactly one matched order', () => {
    const input = okx();
    expect(() => auditRecordedOrder({ ...input, fills: input.fills.data })).toThrow('invalid-execution-record');
    expect(() => auditRecordedOrder({ ...input, orderBefore: { code: '0', data: [] } })).toThrow('invalid-execution-record');
    input.orderBefore.data.push({ ...input.orderBefore.data[0] });
    expect(() => auditRecordedOrder(input)).toThrow('invalid-execution-record');
  });
});

describe('explicit paper reconciliation of recorded orders', () => {
  it('uses deterministic venue-scoped hashed identifiers and rejects unsafe input ids', () => {
    expect(executionOrderKey('mexc', 'order-101')).toMatch(/^mexc_[a-f0-9]{64}$/);
    expect(executionOrderKey('mexc', 'order-101')).toBe(executionOrderKey('mexc', 'order-101'));
    expect(executionOrderKey('mexc', 'order-101')).not.toBe(executionOrderKey('okx', 'order-101'));
    expect(executionOrderKey('mexc', 'order-101')).not.toBe(executionOrderKey('mexc', 'order-102'));
    expect(() => executionOrderKey('mexc', '../private')).toThrow('invalid-execution-record');
  });

  it('reconciles only a matching prepared unknown leg and releases its unused reserves', () => {
    const state = paper(), snapshot = structuredClone(state);
    const result = reconcileRecordedOrder(state, 'pair-1', 'reconcile', mexc());
    expect(state).toEqual(snapshot);
    const view = viewSettlementState(result.state);
    expect(view.balances.mexc).toEqual(funds({ BTC: '1.001', USDT: '915.958', MX: '1' }));
    expect(view.reserved.mexc).toEqual(funds());
    expect(view.reserved.okx.BTC).toBe('0.001');
    expect(view.positions[0]).toMatchObject({ settlement: 'pending', residualBtc: '0.001',
      legs: { buy: { status: 'filled', fills: 1 }, sell: { status: 'open', fills: 0 } } });
    expect(reconcileRecordedOrder(result.state, 'pair-1', 'reconcile', mexc()).state).toEqual(result.state);
  });

  it('does not repost an already recorded exact fill during recovery', () => {
    const input = mexc(), audit = auditRecordedOrder(input);
    let state = paper('mexc', false);
    state = applySettlementEvent(state, { type: 'fill', id: 'delivered', at: T + 11, pairId: 'pair-1', side: 'buy', fill: audit.fills[0] });
    state = applySettlementEvent(state, { type: 'unknown', id: 'unknown', at: T + 12, pairId: 'pair-1', side: 'buy' });
    const result = reconcileRecordedOrder(state, 'pair-1', 'reconcile', input);
    expect(viewSettlementState(result.state).balances).toEqual(viewSettlementState(state).balances);
    expect(viewSettlementState(result.state).positions[0].legs.buy).toMatchObject({ status: 'filled', fills: 1 });
  });

  it('leaves unknown state and reserves untouched when observation is incomplete or changing', () => {
    const input = mexc(); input.fills = [];
    expectAtomicRejection(paper(), input, 'execution-audit-blocked');
    const changed = mexc(); changed.orderBefore.updateTime = T + 19;
    expectAtomicRejection(paper(), changed, 'execution-audit-blocked');
  });

  it('cannot attach an otherwise valid audit to an absent pair, another venue or an unbound order', () => {
    expectAtomicRejection(paper(), mexc(), 'paper-leg-binding-mismatch', 'missing');
    expectAtomicRejection(paper('okx'), mexc(), 'paper-leg-binding-mismatch');
    expectAtomicRejection(paper('mexc', true, 'unrelated-order'), mexc(), 'paper-leg-binding-mismatch');
  });

  it('requires explicit unknown status before applying a historical recovery', () => {
    expectAtomicRejection(paper('mexc', false), mexc(), 'reconciliation-not-required');
  });

  it('never reconciles a nonzero OKX quote inferred by multiplication', () => {
    expectAtomicRejection(paper('okx'), okx(), 'execution-audit-blocked');
  });

  it('can release a zero-fill OKX cancellation without spending funds', () => {
    const input = okx(); bothOkx(input, { state: 'canceled', accFillSz: '0', avgPx: '', fee: '0' }); input.fills.data = [];
    const state = paper('okx'), result = reconcileRecordedOrder(state, 'pair-1', 'reconcile', input);
    expect(viewSettlementState(result.state).balances).toEqual(viewSettlementState(state).balances);
    expect(viewSettlementState(result.state).positions[0].legs.buy.status).toBe('cancelled');
    expect(viewSettlementState(result.state).reserved.okx).toEqual(funds());
  });

  it('binds and reconciles an explicit sell leg without reversing its wallet movements', () => {
    const input = mexc(); bothMexc(input, { side: 'SELL' }); input.expected.side = 'sell'; input.fills[0].isBuyer = false;
    const initial = paper('okx', false);
    const plan = structuredClone(initial.journal[0]) as Extract<SettlementEvent, { type: 'prepare' }>;
    plan.sell.orderId = executionOrderKey('mexc', 'order-101'); plan.sell.feeCaps = funds({ USDT: '0.1' });
    let state = applySettlementEvent(createSettlementState(initial.initialBalances), plan);
    state = applySettlementEvent(state, { type: 'unknown', id: 'unknown-sell', at: T + 5, pairId: 'pair-1', side: 'sell' });
    const result = reconcileRecordedOrder(state, 'pair-1', 'reconcile', input);
    expect(viewSettlementState(result.state).balances.mexc).toEqual(funds({ BTC: '0.999', USDT: '1083.958', MX: '1' }));
    expect(viewSettlementState(result.state).positions[0].legs).toMatchObject({ buy: { status: 'open' }, sell: { status: 'filled' } });
  });

  it('accepts exactly 200 distinct recovery fills but atomically rejects 201', () => {
    const record = (count: number) => {
      const input = mexc();
      bothMexc(input, { status: 'PARTIALLY_CANCELED', executedQty: count === 200 ? '0.0002' : '0.000201',
        cumulativeQuoteQty: count === 200 ? '16.8' : '16.884' });
      input.fills = Array.from({ length: count }, (_, i) => ({ ...input.fills[0], id: `trade-${i}`,
        qty: '0.000001', quoteQty: '0.084', commission: '0' }));
      input.limit = 1000;
      return input;
    };
    const accepted = reconcileRecordedOrder(paper(), 'pair-1', 'reconcile', record(200));
    expect(viewSettlementState(accepted.state).positions[0].legs.buy).toMatchObject({ status: 'cancelled', fills: 200 });
    expect(auditRecordedOrder({ ...record(201), limit: 1000 }).settlementReady).toBe(true);
    expectAtomicRejection(paper(), { ...record(201), limit: 1000 }, 'reconciliation-fill-limit');
  });

  it('preserves state atomically when exact recovered fees exceed the pre-reserved cap', () => {
    const input = mexc(); input.fills[0].commission = '0.2';
    expect(auditRecordedOrder(input).settlementReady).toBe(true);
    expectAtomicRejection(paper(), input, 'fee-cap-exceeded');
  });
});
