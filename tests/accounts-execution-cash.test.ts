import { describe, expect, it, vi } from 'vitest';
import { collectExecutionHistory } from '../src/accounts/execution-history.js';
import { type HistoryRead, type HistoryWindow } from '../src/accounts/execution-reader.js';

const now = 1_800_000_000_000, created = now - 1000, filled = now - 500;
const mr = (ord = '100', fields: Record<string, unknown> = {}) => ({ symbol: 'BTCUSDT', orderId: ord,
  side: 'BUY', type: 'LIMIT', status: 'FILLED', Qty: '0.001', executedQty: '0.001', cumulativeQuoteQty: '70',
  origQuoteOrderQty: '0', time: created, updateTime: filled, ...fields });
const mf = (ord = '100', fields: Record<string, unknown> = {}) => ({ symbol: 'BTCUSDT', orderId: ord, id: '101',
  price: '70000', qty: '0.001', quoteQty: '70', commission: '0.035', commissionAsset: 'USDT',
  time: filled, isBuyer: true, isMaker: false, isSelfTrade: false, ...fields });
const or = (ord = '100', fields: Record<string, unknown> = {}) => ({ instType: 'SPOT', instId: 'BTC-USDT', ordId: ord,
  tdMode: 'cash', category: 'normal', side: 'buy', ordType: 'limit', state: 'filled', sz: '0.001', tgtCcy: 'base_ccy',
  tradeQuoteCcy: 'USDT', accFillSz: '0.001', avgPx: '70000', fee: '-0.000001', feeCcy: 'BTC', rebate: '', rebateCcy: '',
  cTime: String(created), uTime: String(filled), ...fields });
const of = (ord = '100', fields: Record<string, unknown> = {}) => ({ instType: 'SPOT', instId: 'BTC-USDT', ordId: ord,
  tradeId: '102', billId: '103', side: 'buy', subType: '1', execType: 'T', fillSz: '0.001', fillPx: '70000',
  fee: '-0.000001', feeCcy: 'BTC', fillTime: String(filled), ts: String(filled), ...fields });
const ob = (ord = '100', fields: Record<string, unknown> = {}) => ({ instType: 'SPOT', instId: 'BTC-USDT', ordId: ord,
  tradeId: '102', billId: '103', type: '2', subType: '1', mgnMode: 'cash', ccy: 'USDT', sz: '-70',
  balChg: '-70', bal: '30', fee: '0', ts: String(filled), fillTime: String(filled), execType: 'T', ...fields });
const goodBills = () => [ob(), ob('100', { billId: '104', ccy: 'BTC', balChg: '0.000999', sz: '0.001', fee: '-0.000001' })];
const funds = (BTC = '0', USDT = '0', MX = '0') => ({ BTC, USDT, MX });
function receipt(kind: HistoryRead['kind'], data: unknown, fields: Partial<HistoryRead> = {}): HistoryRead {
  return { kind, requestedAt: now, receivedAt: now, query: {}, data, ...fields };
}
function stubs(mexcRows: unknown[] = [], okxRows: unknown[] = []) {
  const mexc = { getFills: vi.fn(async (_range: HistoryWindow, selected?: string, _after?: string) =>
    receipt('fills', selected === undefined ? mexcRows : [mf(selected)])),
  getOrder: vi.fn(async (id: string) => receipt('order', mr(id))),
  getBills: vi.fn(async (_range: HistoryWindow, _after?: string) => receipt('bills', [])) };
  const okx = { getFills: vi.fn(async (_range: HistoryWindow, selected?: string, _after?: string) =>
    receipt('fills', selected === undefined ? okxRows : [of(selected)])),
  getOrder: vi.fn(async (id: string) => receipt('order', or(id))),
  getBills: vi.fn(async (_range: HistoryWindow, _after?: string) => receipt('bills', goodBills())) };
  return { mexc, okx };
}
const options = { clock: () => now };
type CashResult = { executable: false; settlementReady: boolean; orderAudit: { blockers: string[] };
  cash: { expectedNet: unknown; reportedNet: unknown; difference: unknown; comparison: string; blockers: string[];
    checks: Record<string, boolean | null>; grossQuoteProven: boolean; billRows: number; uniqueBills: number; duplicateBills: number } };
const cashOf = (record: Record<string, unknown>) => record.cashAudit as CashResult;

// All records are invented. These tests neither authenticate nor call any exchange.
describe('protected capture wires exact cash evidence without widening collection', () => {
  it('attaches MEXC net amounts from reported execution quote with no bill request', async () => {
    const readers = stubs([mf()]), result = await collectExecutionHistory(readers, options), record = result.venues.mexc.orders[0];
    expect(record.billEvidence).toBeNull(); expect(record.cashCaptureBlockers).toEqual([]);
    expect(cashOf(record)).toMatchObject({ source: 'recorded', executable: false, captureProvenanceVerified: false,
      wholeAccountHistoryProven: false, settlementReady: true,
      cash: { expectedNet: funds('0.001', '-70.035'), expectedSource: 'reported-fill-amounts',
        reportedNet: null, difference: null, comparison: 'not-requested', grossQuoteProven: true } });
    expect(readers.mexc.getBills).not.toHaveBeenCalled();
    expect(readers.mexc.getFills).toHaveBeenCalledTimes(2); expect(readers.mexc.getOrder).toHaveBeenCalledTimes(2);
    expect(result.venues.mexc.meta).toEqual({ requests: 4, successfulRequests: 4, discoveredOrders: 1,
      capturedOrders: 1, fillRows: 2, billRows: 0, errors: 0, truncated: false });
  });

  it('compares a single short OKX source page but retains both contract and gross-quote gates', async () => {
    const readers = stubs([], [of()]), result = await collectExecutionHistory(readers, options), record = result.venues.okx.orders[0];
    expect(record.billEvidence).toEqual({ window: result.window, pageLengths: [2], drained: true,
      sourceRows: 2, selectedRows: 2, candidateRows: 2 });
    expect(record.cashCaptureBlockers).toEqual([]); expect(record.billsAreSettlementEvidence).toBe(false);
    expect(cashOf(record)).toMatchObject({ source: 'recorded', executable: false, settlementReady: false,
      cash: { expectedNet: funds('0.000999', '-70'), reportedNet: funds('0.000999', '-70'), difference: funds(),
        comparison: 'matches-model', grossQuoteProven: false,
        checks: { uncappedResponse: true, windowCoversOrder: true, tradeCoverage: true, currencyCoverage: true } } });
    expect(cashOf(record).orderAudit.blockers).toContain('quote-amount-not-reported');
    expect(cashOf(record).cash.blockers).toEqual(expect.arrayContaining(['cash-bill-contract-unconfirmed', 'bill-fee-currency-unconfirmed']));
    expect(readers.okx.getFills).toHaveBeenCalledTimes(2); expect(readers.okx.getOrder).toHaveBeenCalledTimes(2);
    expect(readers.okx.getBills).toHaveBeenCalledExactlyOnceWith(result.window, undefined);
    expect(result.venues.okx.meta).toEqual({ requests: 5, successfulRequests: 5, discoveredOrders: 1,
      capturedOrders: 1, fillRows: 2, billRows: 2, errors: 0, truncated: false });
  });

  it('keeps actual signed differences in the private cash result', async () => {
    const readers = stubs([], [of()]); readers.okx.getBills.mockResolvedValue(receipt('bills',
      [ob('100', { balChg: '-70.000000000000000001' }), goodBills()[1]]));
    const record = (await collectExecutionHistory(readers, options)).venues.okx.orders[0];
    expect(cashOf(record).cash).toMatchObject({ comparison: 'differs-from-model',
      difference: funds('0', '-0.000000000000000001'), grossQuoteProven: false });
    expect(cashOf(record).cash.blockers).toContain('cash-movement-differs');
    expect(cashOf(record).executable).toBe(false);
  });

  it.each([{ rows: [] }, { rows: [ob()] }])('keeps absent currency evidence incomplete instead of assuming zero: %j', async ({ rows }) => {
    const readers = stubs([], [of()]); readers.okx.getBills.mockResolvedValue(receipt('bills', rows));
    const record = (await collectExecutionHistory(readers, options)).venues.okx.orders[0];
    expect(record.cashCaptureBlockers).toEqual([]);
    expect(cashOf(record).cash).toMatchObject({ reportedNet: null, difference: null, comparison: 'incomplete',
      checks: { currencyCoverage: false } });
    expect(cashOf(record).cash.blockers).toContain('bill-currency-coverage-incomplete');
  });

  it('uses original 100-row page plus empty drain as a boundary even if only two rows match', async () => {
    const readers = stubs([], [of()]);
    const unrelated = Array.from({ length: 98 }, (_, i) => ob('900', { billId: String(1000 + i), tradeId: '901' }));
    readers.okx.getBills.mockResolvedValueOnce(receipt('bills', [...goodBills(), ...unrelated])).mockResolvedValueOnce(receipt('bills', []));
    const result = await collectExecutionHistory(readers, options), record = result.venues.okx.orders[0];
    expect(record.billEvidence).toEqual({ window: result.window, pageLengths: [100, 0], drained: true,
      sourceRows: 100, selectedRows: 2, candidateRows: 2 });
    expect(record.cashCaptureBlockers).toEqual(['cash-bill-page-boundary']);
    expect(cashOf(record).cash).toMatchObject({ comparison: 'incomplete', reportedNet: null, difference: null, billRows: 0 });
    expect(cashOf(record).cash.blockers).toContain('bills-not-supplied');
    expect(readers.okx.getBills).toHaveBeenCalledTimes(2); expect(result.venues.okx.meta.requests).toBe(6);
  });

  it('marks three full bill pages incomplete and never compares their selected subset', async () => {
    const readers = stubs([], [of()]); let page = 0;
    readers.okx.getBills.mockImplementation(async () => {
      const source = Array.from({ length: 100 }, (_, i) => ob('900', { billId: String(1000 - page * 100 - i), tradeId: '901' }));
      if (page === 0) { source[0] = ob('100', { billId: '1000' }); source[1] = ob('100', { billId: '999', ccy: 'BTC', balChg: '0.000999' }); }
      page++; return receipt('bills', source);
    });
    const result = await collectExecutionHistory(readers, options), record = result.venues.okx.orders[0];
    expect(record.billEvidence).toEqual({ window: result.window, pageLengths: [100, 100, 100], drained: false,
      sourceRows: 300, selectedRows: 2, candidateRows: 2 });
    expect(record.cashCaptureBlockers).toEqual(['incomplete-bill-capture']);
    expect(cashOf(record).cash).toMatchObject({ comparison: 'incomplete', reportedNet: null, difference: null, billRows: 0 });
    expect(result.venues.okx.meta).toMatchObject({ requests: 7, billRows: 300, truncated: true });
  });

  it('does not expand the frozen bill window to make later order executions comparable', async () => {
    let wall = now; const readers = stubs([], [of()]), later = now + 100;
    readers.okx.getOrder.mockImplementation(async id => {
      wall = now + 200; return receipt('order', or(id, { uTime: String(later) }), { requestedAt: wall, receivedAt: wall });
    });
    readers.okx.getFills.mockImplementation(async (_range, selected) => receipt('fills',
      [of(selected, selected === undefined ? {} : { fillTime: String(later), ts: String(later) })],
      { requestedAt: wall, receivedAt: wall }));
    // The frozen-page rows are real for the older observation; no synthetic later bills are created.
    readers.okx.getBills.mockResolvedValue(receipt('bills', []));
    const result = await collectExecutionHistory(readers, { clock: () => wall }), record = result.venues.okx.orders[0];
    expect(result.window.to).toBe(now); expect(record.billEvidence).toMatchObject({ window: result.window, pageLengths: [0] });
    expect(readers.okx.getBills).toHaveBeenCalledExactlyOnceWith(result.window, undefined);
    expect(readers.okx.getFills).toHaveBeenNthCalledWith(2, { from: created, to: now + 200 }, '100', undefined);
    expect(cashOf(record).cash).toMatchObject({ comparison: 'incomplete', reportedNet: null, difference: null,
      checks: { windowCoversOrder: false } });
    expect(cashOf(record).cash.blockers).toContain('bill-window-incomplete');
  });

  it('preserves execution quote disagreements instead of emitting expected cash', async () => {
    const readers = stubs([mf()]); readers.mexc.getOrder.mockResolvedValue(receipt('order', mr('100', { cumulativeQuoteQty: '71' })));
    const record = (await collectExecutionHistory(readers, options)).venues.mexc.orders[0];
    expect(record.cashCaptureBlockers).toEqual([]);
    expect(cashOf(record)).toMatchObject({ settlementReady: false, cash: { expectedNet: null, grossQuoteProven: false } });
    expect(cashOf(record).orderAudit.blockers).toContain('quote-total-mismatch');
    expect(cashOf(record).cash.blockers).toContain('order-evidence-incomplete');
  });

  it('quarantines an unsupported fee asset without exposing parser details', async () => {
    const readers = stubs([mf()]); readers.mexc.getFills.mockResolvedValue(receipt('fills', [mf('100', { commissionAsset: 'UNSUPPORTED_PRIVATE_ASSET' })]));
    const record = (await collectExecutionHistory(readers, options)).venues.mexc.orders[0];
    expect(record.cashAudit).toBeNull(); expect(record.cashCaptureBlockers).toEqual(['unsupported-or-conflicting-records']);
  });

  it.each(['fills', 'after'] as const)('leaves cash null if the %s read fails during order capture', async failed => {
    const readers = stubs([mf()]);
    if (failed === 'fills') readers.mexc.getFills.mockResolvedValueOnce(receipt('fills', [mf()])).mockRejectedValueOnce(new Error('private-error'));
    else readers.mexc.getOrder.mockResolvedValueOnce(receipt('order', mr())).mockRejectedValueOnce(new Error('private-error'));
    const record = (await collectExecutionHistory(readers, options)).venues.mexc.orders[0];
    expect(record.cashAudit).toBeNull(); expect(record.cashCaptureBlockers).toEqual(['incomplete-order-capture']);
    expect(JSON.stringify(record.cashCaptureBlockers)).not.toContain('private-error');
  });

  it('keeps a drained multi-page fill capture outside the single-page cash audit', async () => {
    const readers = stubs([], [of()]);
    readers.okx.getFills.mockResolvedValueOnce(receipt('fills', [of()]))
      .mockResolvedValueOnce(receipt('fills', Array.from({ length: 100 }, (_, i) => of('100', { billId: String(1000 - i), tradeId: String(2000 - i) }))))
      .mockResolvedValueOnce(receipt('fills', []));
    const record = (await collectExecutionHistory(readers, options)).venues.okx.orders[0];
    expect(record.cashAudit).toBeNull(); expect(record.cashCaptureBlockers).toEqual(['audit-page-boundary']);
    expect(record.fills).toMatchObject({ pageLengths: [100, 0], drained: true });
    expect(readers.okx.getFills).toHaveBeenCalledTimes(3);
  });

  it('quarantines conflicting duplicate bill identities rather than producing a partial comparison', async () => {
    const readers = stubs([], [of()]); readers.okx.getBills.mockResolvedValue(receipt('bills',
      [...goodBills(), ob('100', { balChg: '-69' })]));
    const record = (await collectExecutionHistory(readers, options)).venues.okx.orders[0];
    expect(record.cashAudit).toBeNull(); expect(record.cashCaptureBlockers).toEqual(['unsupported-or-conflicting-cash-records']);
    expect(record.audit).toMatchObject({ blockers: ['quote-amount-not-reported'] });
  });

  it('deduplicates identical bills only after preserving original source page cardinality', async () => {
    const readers = stubs([], [of()]); readers.okx.getBills.mockResolvedValue(receipt('bills', [...goodBills(), ob()]));
    const record = (await collectExecutionHistory(readers, options)).venues.okx.orders[0];
    expect(record.billEvidence).toMatchObject({ pageLengths: [3], sourceRows: 3, selectedRows: 3, candidateRows: 3 });
    expect(cashOf(record).cash).toMatchObject({ comparison: 'matches-model', reportedNet: funds('0.000999', '-70'),
      billRows: 3, uniqueBills: 2, duplicateBills: 1 });
  });

  it.each([
    ['wrong order for known trade', { ordId: '900', billId: '105' }],
    ['empty order for known trade', { ordId: '', billId: '105' }],
    ['missing order for known trade', { ordId: undefined, billId: '105' }],
    ['known bill with other order and trade', { ordId: '900', tradeId: '901' }],
    ['unsupported currency', { ccy: 'EUR', billId: '105' }],
    ['missing currency', { ccy: undefined, billId: '105' }],
    ['margin mode', { mgnMode: 'cross', billId: '105' }],
    ['non-trade bill type', { type: '1', billId: '105' }]
  ])('does not discard related conflicting evidence: %s', async (_label, fields) => {
    const readers = stubs([], [of()]); readers.okx.getBills.mockResolvedValue(receipt('bills', [...goodBills(), ob('100', fields)]));
    const record = (await collectExecutionHistory(readers, options)).venues.okx.orders[0];
    expect(record.billEvidence).toMatchObject({ sourceRows: 3, candidateRows: 3 });
    expect(record.cashAudit).toBeNull(); expect(record.cashCaptureBlockers).toEqual(['unsupported-or-conflicting-cash-records']);
  });

  it('ignores genuinely unrelated bills while retaining their original source page count', async () => {
    const readers = stubs([], [of()]); const unrelated = ob('900', { tradeId: '901', billId: '902', ccy: 'EUR', mgnMode: 'cross' });
    readers.okx.getBills.mockResolvedValue(receipt('bills', [...goodBills(), unrelated]));
    const record = (await collectExecutionHistory(readers, options)).venues.okx.orders[0];
    expect(record.billEvidence).toMatchObject({ pageLengths: [3], sourceRows: 3, selectedRows: 2, candidateRows: 2 });
    expect(record.linkedBills).toEqual(goodBills()); expect(record.cashCaptureBlockers).toEqual([]);
    expect(cashOf(record).cash).toMatchObject({ comparison: 'matches-model', billRows: 2 });
  });

  it('keeps conflicting aliases of a linked bill even when neither alternate order nor trade matches', async () => {
    const readers = stubs([], [of()]);
    const related = [ob('100', { billId: '500' }), goodBills()[1]];
    const hiddenConflict = ob('900', { billId: '500', tradeId: '901', balChg: '-999' });
    readers.okx.getBills.mockResolvedValue(receipt('bills', [...related, hiddenConflict]));
    const record = (await collectExecutionHistory(readers, options)).venues.okx.orders[0];
    expect(record.billEvidence).toMatchObject({ pageLengths: [3], sourceRows: 3, selectedRows: 2, candidateRows: 3 });
    expect(record.linkedBills).toEqual(related);
    expect(record.cashAudit).toBeNull(); expect(record.cashCaptureBlockers).toEqual(['unsupported-or-conflicting-cash-records']);
  });

});


// These totals describe API-reported fees in observed fills, not independent cash settlement.
describe('captured fee observations', () => {
  it('counts discovery and per-order copies once without new requests', async () => {
    const readers = stubs([mf()], [of()]);
    const capture = await collectExecutionHistory(readers, options);
    expect(capture.venues.mexc.feeObservation).toMatchObject({ status: 'observed', inputRows: 2,
      uniqueFills: 1, duplicateRows: 1, roles: { maker: 0, taker: 1, unknown: 0 },
      totals: [{ currency: 'USDT', charges: '0.035', rebates: '0' }], captureTruncated: false,
      futureFeeCurrencyVerified: false, roundingVerified: false, executable: false });
    expect(capture.venues.okx.feeObservation).toMatchObject({ status: 'observed', uniqueFills: 1, duplicateRows: 1,
      totals: [{ currency: 'BTC', charges: '0.000001', rebates: '0' }], wholeAccountHistoryProven: false });
    expect(capture.venues.mexc.meta.requests).toBe(4); expect(capture.venues.okx.meta.requests).toBe(5);
    expect(cashOf(capture.venues.okx.orders[0]).settlementReady).toBe(false);
  });
  it('keeps empty history distinct from a reported zero commission', async () => {
    const readers = stubs(); readers.okx.getBills.mockResolvedValue(receipt('bills', []));
    const capture = await collectExecutionHistory(readers, options);
    for (const venue of ['mexc', 'okx'] as const) expect(capture.venues[venue].feeObservation).toMatchObject({
      status: 'no-observations', totals: null, uniqueFills: 0, captureTruncated: false, discoveryDrained: true });
  });
  it('retains a failed discovery marker instead of claiming a clean empty history', async () => {
    const readers = stubs(); readers.mexc.getFills.mockRejectedValue(new Error('PRIVATE UPSTREAM ERROR'));
    const capture = await collectExecutionHistory(readers, options);
    expect(capture.venues.mexc.feeObservation).toMatchObject({ status: 'incomplete', totals: null, captureTruncated: true, discoveryDrained: false });
    expect(JSON.stringify(capture)).not.toContain('PRIVATE UPSTREAM ERROR');
  });
  it('does not include out-of-window pages in fee arithmetic', async () => {
    const readers = stubs([mf('100', { time: now + 100 })]);
    const capture = await collectExecutionHistory(readers, options);
    expect(capture.venues.mexc.feeObservation).toMatchObject({ status: 'incomplete', totals: null, uniqueFills: 0, captureTruncated: true });
  });
  it('refuses a changed fee under the same fill identifier', async () => {
    const readers = stubs([mf('100', { commission: '0.034' })]);
    const capture = await collectExecutionHistory(readers, options);
    expect(capture.venues.mexc.feeObservation).toMatchObject({ status: 'invalid', totals: null });
    expect(readers.mexc.getFills).toHaveBeenCalledTimes(2);
  });
  it('does not use an earlier feeRate when a later observation conflicts', async () => {
    const readers = stubs([], [of('100', { feeRate: '-0.001' })]);
    readers.okx.getFills.mockImplementation(async (_range, selected) => receipt('fills',
      [of('100', { feeRate: selected === undefined ? '-0.001' : '-0.002' })]));
    const capture = await collectExecutionHistory(readers, options);
    expect(capture.venues.okx.feeObservation).toMatchObject({ status: 'invalid', totals: null });
  });
  it('retains invalid fee conflicts even when an order read later fails', async () => {
    const readers = stubs([mf('100', { commission: '0.034' })]);
    readers.mexc.getOrder.mockResolvedValueOnce(receipt('order', mr())).mockRejectedValueOnce(new Error('PRIVATE AFTER ERROR'));
    const capture = await collectExecutionHistory(readers, options);
    expect(capture.venues.mexc.feeObservation).toMatchObject({ status: 'invalid', totals: null,
      captureTruncated: true, captureReasons: ['capture-incomplete'] });
  });
  it('keeps capture truncation explicit when observed fills themselves are valid', async () => {
    const readers = stubs([mf()]); readers.mexc.getOrder.mockRejectedValue(new Error('PRIVATE ORDER ERROR'));
    const capture = await collectExecutionHistory(readers, options);
    expect(capture.venues.mexc.feeObservation).toMatchObject({ status: 'incomplete', totals: null, captureTruncated: true,
      captureReasons: ['capture-incomplete'], wholeAccountHistoryProven: false, executable: false });
  });
});
