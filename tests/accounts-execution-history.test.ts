import { describe, expect, it, vi } from 'vitest';
import { collectExecutionHistory, HISTORY_POLICY } from '../src/accounts/execution-history.js';
import { type HistoryRead, type HistoryWindow } from '../src/accounts/execution-reader.js';
import { AccountError } from '../src/accounts/types.js';

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
  getBills: vi.fn(async (_range: HistoryWindow, _after?: string) => receipt('bills', [])) };
  return { mexc, okx };
}
const options = { clock: () => now };
const auditOf = (order: Record<string, unknown>) => order.audit as Record<string, unknown>;

// No network, credentials, exchange mutations or account-backed fixtures are used.
describe('bounded private execution history collection', () => {
  it('keeps empty history empty and never invents an order or settlement', async () => {
    const readers = stubs(), result = await collectExecutionHistory(readers, options);
    expect(result).toMatchObject({ executable: false, wholeAccountHistoryProven: false,
      orderDiscovery: 'recent-executions-only', account: 'main', symbol: 'BTC/USDT',
      window: { from: now - 6 * 86400_000, to: now }, policy: { durationMs: 35000 } });
    expect(result.venues.mexc.orders).toEqual([]); expect(result.venues.okx.orders).toEqual([]);
    expect(result.venues.mexc.meta).toMatchObject({ requests: 1, discoveredOrders: 0, truncated: false });
    expect(result.venues.okx.meta).toMatchObject({ requests: 2, discoveredOrders: 0, truncated: false });
    expect(readers.mexc.getOrder).not.toHaveBeenCalled(); expect(readers.okx.getOrder).not.toHaveBeenCalled();
    expect(readers.mexc.getBills).not.toHaveBeenCalled();
  });
  it('brackets an explicitly selected MEXC order with before/fills/after and uses a fresh order window', async () => {
    const readers = stubs([mf()]), sequence: string[] = [];
    readers.mexc.getOrder.mockImplementation(async id => { sequence.push('order:' + id); return receipt('order', mr(id)); });
    readers.mexc.getFills.mockImplementation(async (_range, selected) => {
      sequence.push('fills:' + (selected ?? 'discovery')); return receipt('fills', [mf(selected)]);
    });
    const result = await collectExecutionHistory(readers, options), venue = result.venues.mexc;
    expect(sequence).toEqual(['fills:discovery', 'order:100', 'fills:100', 'order:100']);
    expect(readers.mexc.getFills).toHaveBeenNthCalledWith(2, { from: created, to: now }, '100', undefined);
    expect(venue.meta).toMatchObject({ requests: 4, capturedOrders: 1, errors: 0 });
    expect(auditOf(venue.orders[0])).toMatchObject({ settlementReady: true, blockers: [],
      quoteSource: 'reported-fill-quote', totals: { baseQuantity: '0.001', quoteQuantity: '70', fees: { USDT: '0.035' } } });
  });
  it('archives linked OKX bills without promoting them into a reported quote or settlement approval', async () => {
    const readers = stubs([], [of()]);
    readers.okx.getBills.mockResolvedValue(receipt('bills', [ob(), ob('200', { billId: '104' })]));
    const result = await collectExecutionHistory(readers, options), record = result.venues.okx.orders[0];
    expect(record.linkedBills).toEqual([ob()]);
    expect(record.billsAreSettlementEvidence).toBe(false);
    expect(auditOf(record)).toMatchObject({ settlementReady: false, blockers: ['quote-amount-not-reported'],
      quoteSource: 'derived-price-times-size', totals: { quoteQuantity: '70' } });
    expect(result.wholeAccountHistoryProven).toBe(false);
  });
  it('preserves order changes during collection as a blocked audit', async () => {
    const readers = stubs([mf()]);
    readers.mexc.getOrder.mockResolvedValueOnce(receipt('order', mr())).mockResolvedValueOnce(receipt('order', mr('100', { updateTime: filled + 1 })));
    const result = await collectExecutionHistory(readers, options);
    expect(auditOf(result.venues.mexc.orders[0])).toMatchObject({ settlementReady: false, blockers: ['order-changed-during-observation'] });
  });
  it('does not audit mismatched after-order identity as the selected order', async () => {
    const readers = stubs([mf()]);
    readers.mexc.getOrder.mockResolvedValueOnce(receipt('order', mr())).mockResolvedValueOnce(receipt('order', mr('999')));
    const result = await collectExecutionHistory(readers, options);
    expect(auditOf(result.venues.mexc.orders[0])).toEqual({ blocked: 'unsupported-or-conflicting-records' });
  });
  it('limits order selection to two discovered identities, with explicit incompleteness', async () => {
    const readers = stubs([mf('100'), mf('200'), mf('300')]), result = await collectExecutionHistory(readers, options);
    expect(result.venues.mexc.meta).toMatchObject({ discoveredOrders: 3, capturedOrders: 2, requests: 7, truncated: true });
    expect(result.venues.mexc.errors).toContainEqual({ stage: 'selection', reason: 'order-budget' });
    expect(readers.mexc.getOrder.mock.calls.map(([id]) => id)).toEqual(['100', '100', '200', '200']);
  });
  it('deduplicates discovery identities without discarding the evidence rows', async () => {
    const readers = stubs([mf(), mf()]), result = await collectExecutionHistory(readers, options);
    expect(result.venues.mexc.meta.discoveredOrders).toBe(1);
    expect(result.venues.mexc.reads[0].data).toHaveLength(2);
    expect(readers.mexc.getOrder).toHaveBeenCalledTimes(2);
  });
  it('paginates OKX bills using the minimum previous billId and stops on a short page', async () => {
    const readers = stubs();
    const first = Array.from({ length: 100 }, (_, i) => ob('100', { billId: String(1000 - i) }));
    readers.okx.getBills.mockResolvedValueOnce(receipt('bills', first)).mockResolvedValueOnce(receipt('bills', [ob('100', { billId: '900' })]));
    const result = await collectExecutionHistory(readers, options), venue = result.venues.okx;
    expect(readers.okx.getBills).toHaveBeenNthCalledWith(1, result.window, undefined);
    expect(readers.okx.getBills).toHaveBeenNthCalledWith(2, result.window, '901');
    expect(venue).toMatchObject({ billsDrained: true, meta: { billRows: 101, truncated: false } });
  });
  it.each(['901', '999', '1001'])('rejects repeated or regressing OKX bill cursor %s and makes no third request', async billId => {
    const readers = stubs();
    readers.okx.getBills.mockResolvedValueOnce(receipt('bills', Array.from({ length: 100 }, (_, i) => ob('100', { billId: String(1000 - i) }))))
      .mockResolvedValueOnce(receipt('bills', [ob('100', { billId })]));
    const result = await collectExecutionHistory(readers, options), venue = result.venues.okx;
    expect(venue.billsDrained).toBe(false);
    expect(venue.errors).toContainEqual({ stage: 'bills', reason: 'page-scope-or-cursor' });
    expect(venue.meta.billRows).toBe(100); expect(readers.okx.getBills).toHaveBeenCalledTimes(2);
  });
  it('stops full OKX pages at three and marks the archive incomplete rather than drained', async () => {
    const readers = stubs(); let page = 0;
    readers.okx.getBills.mockImplementation(async () => receipt('bills', Array.from({ length: 100 }, (_, i) => ob('100', { billId: String(1000 - page * 100 - i) })), { query: { after: String(page++ * 100) } }));
    const result = await collectExecutionHistory(readers, options), venue = result.venues.okx;
    expect(readers.okx.getBills).toHaveBeenCalledTimes(3);
    expect(venue).toMatchObject({ billsDrained: false, meta: { billRows: 300, truncated: true } });
    expect(venue.errors).toContainEqual({ stage: 'bills', reason: 'page-budget' });
  });
  it('caps MEXC at one 1000-row page and never silently claims pagination', async () => {
    const readers = stubs(Array.from({ length: 1000 }, (_, i) => mf('100', { id: String(i + 1) })));
    const result = await collectExecutionHistory(readers, options);
    expect(result.venues.mexc.discoveryDrained).toBe(false);
    expect(result.venues.mexc.errors).toContainEqual({ stage: 'discovery', reason: 'page-budget' });
    expect(readers.mexc.getFills.mock.calls.every(call => call[2] === undefined)).toBe(true);
  });
  it('enforces the global twelve-request venue budget even across three-page order histories', async () => {
    const readers = stubs();
    readers.okx.getFills.mockImplementation(async (_range, selected, after) => {
      const top = after === undefined ? 100000 : Number(after) - 1;
      return receipt('fills', Array.from({ length: 100 }, (_, i) => of(selected ?? (i % 2 ? '100' : '200'), { billId: String(top - i), tradeId: String(top - i) })));
    });
    readers.okx.getBills.mockImplementation(async (_range, after) => {
      const top = after === undefined ? 100000 : Number(after) - 1;
      return receipt('bills', Array.from({ length: 100 }, (_, i) => ob('100', { billId: String(top - i) })));
    });
    const result = await collectExecutionHistory(readers, options), venue = result.venues.okx;
    expect(venue.meta.requests).toBe(HISTORY_POLICY.maxRequestsPerVenue);
    expect(readers.okx.getFills.mock.calls.length + readers.okx.getBills.mock.calls.length + readers.okx.getOrder.mock.calls.length).toBe(12);
    expect(venue.meta.truncated).toBe(true);
    expect(venue.errors.some(e => e.reason === 'request-budget-or-clock')).toBe(true);
  });
  it('rate limits stop the affected venue immediately, persist cooldown once, and never retry', async () => {
    const readers = stubs(), onRateLimit = vi.fn(async () => {});
    readers.okx.getFills.mockRejectedValue(new AccountError('account-rate-limited'));
    const result = await collectExecutionHistory(readers, { ...options, onRateLimit });
    expect(readers.okx.getFills).toHaveBeenCalledTimes(1); expect(readers.okx.getBills).not.toHaveBeenCalled();
    expect(onRateLimit).toHaveBeenCalledExactlyOnceWith('okx');
    expect(result.venues.okx.errors).toEqual([{ stage: 'discovery', reason: 'rate-limited' }]);
    expect(result.venues.mexc.meta.truncated).toBe(false);
  });
  it('does not retry authentication/network failures or echo upstream error messages', async () => {
    const readers = stubs(), onRateLimit = vi.fn(async () => {});
    readers.mexc.getFills.mockRejectedValue(new Error('PRIVATE_UPSTREAM_TOKEN'));
    const result = await collectExecutionHistory(readers, { ...options, onRateLimit });
    expect(readers.mexc.getFills).toHaveBeenCalledTimes(1); expect(onRateLimit).not.toHaveBeenCalled();
    expect(result.venues.mexc.errors).toEqual([{ stage: 'discovery', reason: 'read-failed' }]);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_UPSTREAM_TOKEN');
  });
  it('reserves five seconds before the deadline and stops starting more requests', async () => {
    let wall = now; const readers = stubs([mf()]);
    readers.mexc.getFills.mockImplementation(async () => { const requestedAt = wall; wall += 31000; return receipt('fills', [mf()], { requestedAt, receivedAt: wall }); });
    readers.okx.getFills.mockImplementation(async () => receipt('fills', [], { requestedAt: wall, receivedAt: wall }));
    const result = await collectExecutionHistory(readers, { clock: () => wall });
    expect(result.venues.mexc.meta.requests).toBe(1); expect(readers.mexc.getOrder).not.toHaveBeenCalled();
    expect(result.venues.mexc.errors.some(e => e.reason === 'request-budget-or-clock')).toBe(true);
  });
  it('rejects a response that arrives after the deadline rather than archiving it as successful', async () => {
    let wall = now; const readers = stubs();
    readers.mexc.getFills.mockImplementation(async () => { wall += 35001; return receipt('fills', [], { receivedAt: wall }); });
    const result = await collectExecutionHistory(readers, { clock: () => wall });
    expect(result.venues.mexc.meta).toMatchObject({ requests: 1, successfulRequests: 0, truncated: true });
    expect(result.venues.mexc.reads).toEqual([]);
  });
  it('rejects selected fills for another order without passing them to the audit', async () => {
    const readers = stubs([mf()]); readers.mexc.getFills.mockResolvedValueOnce(receipt('fills', [mf()])).mockResolvedValueOnce(receipt('fills', [mf('999')]));
    const result = await collectExecutionHistory(readers, options), venue = result.venues.mexc;
    expect(venue.errors).toContainEqual({ stage: 'order-fills', reason: 'page-scope-or-cursor' });
    expect(venue.meta.capturedOrders).toBe(0); expect(venue.orders[0].audit).toBeNull();
    expect(readers.mexc.getOrder).toHaveBeenCalledTimes(1);
  });
  it.each([now + 1, now - 6 * 86400_000 - 1])('rejects discovery timestamps outside the requested window: %s', async time => {
    const readers = stubs([mf('100', { time })]), result = await collectExecutionHistory(readers, options);
    expect(result.venues.mexc.errors).toContainEqual({ stage: 'discovery', reason: 'page-scope-or-cursor' });
    expect(readers.mexc.getOrder).not.toHaveBeenCalled();
  });
  it('rejects an order created outside retention even if a recent execution discovered it', async () => {
    const readers = stubs([mf()]); readers.mexc.getOrder.mockResolvedValue(receipt('order', mr('100', { time: now - 6 * 86400_000 - 1 })));
    const result = await collectExecutionHistory(readers, options);
    expect(result.venues.mexc.errors).toContainEqual({ stage: 'order-before', reason: 'order-scope-or-retention' });
    expect(readers.mexc.getFills).toHaveBeenCalledTimes(1); expect(result.venues.mexc.orders).toEqual([]);
  });
  it.each(['abc', '0', '-1', '1.2', '1e6', '9'.repeat(41)])('rejects malformed OKX paging identity %s', async billId => {
    const readers = stubs([], [of('100', { billId })]), result = await collectExecutionHistory(readers, options);
    expect(result.venues.okx.errors).toContainEqual({ stage: 'discovery', reason: 'page-scope-or-cursor' });
    expect(readers.okx.getOrder).not.toHaveBeenCalled();
  });
  it('rejects margin records rather than treating them as ordinary SPOT executions', async () => {
    const readers = stubs([], [of('100', { instType: 'MARGIN' })]), result = await collectExecutionHistory(readers, options);
    expect(result.venues.okx.errors).toContainEqual({ stage: 'discovery', reason: 'page-scope-or-cursor' });
  });
  it.each([NaN, Infinity, now + 0.5])('does not accept invalid receipt timestamp %s', async requestedAt => {
    const readers = stubs(); readers.mexc.getFills.mockResolvedValue(receipt('fills', [], { requestedAt }));
    const result = await collectExecutionHistory(readers, options);
    expect(result.venues.mexc.meta.successfulRequests).toBe(0);
    expect(result.venues.mexc.errors).toContainEqual({ stage: 'discovery', reason: 'read-failed' });
  });
  it('quarantines invalid discovery identities instead of rejecting the entire two-venue capture', async () => {
    const readers = stubs([mf('bad id with spaces')]);
    const result = await collectExecutionHistory(readers, options);
    expect(result.venues.mexc.meta.truncated).toBe(true); expect(result.venues.mexc.orders).toEqual([]);
    expect(result.venues.okx.meta.successfulRequests).toBe(2);
  });
  it.each(['mexc', 'okx'] as const)('rejects wrong %s instrument scope at the collector boundary', async venue => {
    const readers = venue === 'mexc' ? stubs([mf('100', { symbol: 'ETHUSDT' })]) : stubs([], [of('100', { instId: 'ETH-USDT' })]);
    const result = await collectExecutionHistory(readers, options);
    expect(result.venues[venue].meta.truncated).toBe(true); expect(result.venues[venue].orders).toEqual([]);
    expect(readers[venue].getOrder).not.toHaveBeenCalled();
  });
  it.each([NaN, Infinity, now, now - 1, now + 0.5])('rejects invalid explicit deadline %s before I/O', async deadline => {
    const readers = stubs();
    await expect(collectExecutionHistory(readers, { ...options, deadline })).rejects.toThrow('history-invalid-deadline');
    expect(readers.mexc.getFills).not.toHaveBeenCalled(); expect(readers.okx.getFills).not.toHaveBeenCalled();
  });
  it('honors a shorter caller deadline and starts no request without its five-second reserve', async () => {
    const readers = stubs(), result = await collectExecutionHistory(readers, { ...options, deadline: now + 4999 });
    expect(readers.mexc.getFills).not.toHaveBeenCalled(); expect(readers.okx.getFills).not.toHaveBeenCalled();
    expect(result.venues.mexc.meta.truncated).toBe(true); expect(result.venues.okx.meta.truncated).toBe(true);
  });
  it('stops before I/O if the clock moves backwards after capture start', async () => {
    let first = true; const readers = stubs();
    const result = await collectExecutionHistory(readers, { clock: () => { if (first) { first = false; return now; } return now - 1; } });
    expect(readers.mexc.getFills).not.toHaveBeenCalled(); expect(readers.okx.getFills).not.toHaveBeenCalled();
    expect(result.venues.mexc.errors).toContainEqual({ stage: 'discovery', reason: 'request-budget-or-clock' });
  });
  it.each([NaN, Infinity, now + 0.5, now - 1, now + 1])('does not accept invalid response receipt time %s', async receivedAt => {
    const readers = stubs(); readers.mexc.getFills.mockResolvedValue(receipt('fills', [], { receivedAt }));
    const result = await collectExecutionHistory(readers, options);
    expect(result.venues.mexc.meta.successfulRequests).toBe(0);
    expect(result.venues.mexc.errors).toContainEqual({ stage: 'discovery', reason: 'read-failed' });
  });
  it('retains a drained multipage order archive without bypassing the single-page audit contract', async () => {
    const readers = stubs([], [of()]);
    readers.okx.getFills.mockImplementation(async (_range, selected, after) => receipt('fills',
      selected === undefined ? [of()] : after !== undefined ? [] : Array.from({ length: 100 }, (_, i) => of('100', {
        billId: String(1000 - i), tradeId: String(1000 - i) }))));
    const result = await collectExecutionHistory(readers, options), record = result.venues.okx.orders[0];
    expect(record.fills).toMatchObject({ drained: true });
    expect(auditOf(record)).toEqual({ blocked: 'audit-page-boundary' });
    expect(readers.okx.getFills).toHaveBeenCalledTimes(3);
  });

});
