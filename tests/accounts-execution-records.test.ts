import { describe, expect, it } from 'vitest';
import { projectExecutionOrder, projectExecutionRows } from '../src/accounts/execution-records.js';
import { AccountError } from '../src/accounts/types.js';

const at = 1_800_000_000_000;
const mexcOrder = (fields: Record<string, unknown> = {}) => ({ symbol: 'BTCUSDT', orderId: 'order-100',
  side: 'BUY', type: 'MARKET', status: 'FILLED', Qty: '0.001', executedQty: '0.001', cumulativeQuoteQty: '70.005',
  origQuoteOrderQty: '71', time: at - 1000, updateTime: at, ...fields });
const mexcFill = (fields: Record<string, unknown> = {}) => ({ symbol: 'BTCUSDT', orderId: 'order-100', id: 'trade-101',
  price: '70005', qty: '0.001', quoteQty: '70.005', commission: '0.0350025', commissionAsset: 'USDT',
  time: at, isBuyer: true, isMaker: false, isSelfTrade: false, ...fields });
const okxOrder = (fields: Record<string, unknown> = {}) => ({ instType: 'SPOT', instId: 'BTC-USDT', ordId: '100',
  tdMode: 'cash', category: 'normal', side: 'buy', ordType: 'limit', state: 'filled', sz: '0.001', tgtCcy: 'base_ccy',
  tradeQuoteCcy: 'USDT', accFillSz: '0.001', avgPx: '70000', fee: '-0.000001', feeCcy: 'BTC', rebate: '', rebateCcy: '',
  cTime: String(at - 1000), uTime: String(at), ...fields });
const okxFill = (fields: Record<string, unknown> = {}) => ({ instType: 'SPOT', instId: 'BTC-USDT', ordId: '100',
  tradeId: '102', billId: '103', side: 'buy', subType: '1', execType: 'T', fillSz: '0.001', fillPx: '70000',
  fee: '-0.000001', feeCcy: 'BTC', fillTime: String(at), ts: String(at + 1), ...fields });
const okxBill = (fields: Record<string, unknown> = {}) => ({ instType: 'SPOT', instId: 'BTC-USDT', ordId: '100',
  tradeId: '102', billId: '103', type: '2', subType: '1', mgnMode: 'cash', ccy: 'USDT', sz: '-70',
  balChg: '-70', bal: '30', fee: '0', ts: String(at + 1), fillTime: String(at), execType: 'T', ...fields });
const privateExtras = { apiKey: 'PRIVATE_KEY', signature: 'PRIVATE_SIG', clOrdId: 'PRIVATE_USER_ORDER',
  tag: 'PRIVATE_TAG', clientOrderId: 'PRIVATE_CLIENT_ORDER', address: 'PRIVATE_ADDRESS', notes: 'PRIVATE_NOTES',
  nested: { token: 'PRIVATE_TOKEN' }, msg: 'PRIVATE_ERROR' };
function rejects(run: () => unknown) {
  try { run(); expect.fail('expected rejection'); }
  catch (error) { expect(error).toBeInstanceOf(AccountError); expect((error as Error).message).toBe('account-invalid-response'); }
}

describe('private execution history projections', () => {
  it.each(['mexc', 'okx'] as const)('keeps %s identities only in the explicit private projection and removes other metadata', venue => {
    const make = venue === 'mexc' ? mexcOrder : okxOrder;
    const result = projectExecutionOrder(venue, make(privateExtras));
    expect(result).toEqual(make());
    expect(JSON.stringify(result)).not.toContain('PRIVATE_');
    const fill = projectExecutionRows(venue, 'fills', [(venue === 'mexc' ? mexcFill : okxFill)(privateExtras)]);
    expect(fill).toEqual([(venue === 'mexc' ? mexcFill : okxFill)()]);
    expect(JSON.stringify(fill)).not.toContain('PRIVATE_');
  });
  it('does not mutate or retain input references', () => {
    const input = mexcOrder(), result = projectExecutionOrder('mexc', input);
    input.executedQty = '999'; expect(result).toHaveProperty('executedQty', '0.001');
  });
  it('accepts OKX data row or exactly one data array, without accepting unchecked envelopes', () => {
    expect(projectExecutionOrder('okx', [okxOrder()])).toEqual(projectExecutionOrder('okx', okxOrder()));
    for (const input of [[], [okxOrder(), okxOrder()], { code: '0', data: [okxOrder()] }])
      rejects(() => projectExecutionOrder('okx', input));
  });
  it('retains both MEXC aliases even when they conflict, leaving economic decisions to the audit', () => {
    const input = mexcOrder({ origQty: '0.002', cummulativeQuoteQty: '69' });
    expect(projectExecutionOrder('mexc', input)).toEqual(input);
  });
  it('retains unknown bounded status, category and fee currency without asserting supported execution', () => {
    expect(projectExecutionOrder('mexc', mexcOrder({ status: 'FUTURE_STATE' }))).toHaveProperty('status', 'FUTURE_STATE');
    expect(projectExecutionOrder('okx', okxOrder({ state: 'future_state', category: 'future_category' })))
      .toMatchObject({ state: 'future_state', category: 'future_category' });
    expect(projectExecutionRows('okx', 'fills', [okxFill({ feeCcy: 'UNSUPPORTED_COIN', execType: 'M', subType: '204' })])[0])
      .toMatchObject({ feeCcy: 'UNSUPPORTED_COIN', execType: 'M', subType: '204' });
  });
  it.each(['USDT', 'USDC', ''])('retains reported fill quote currency %j for the downstream audit', tradeQuoteCcy => {
    const row = okxFill({ tradeQuoteCcy });
    expect(projectExecutionRows('okx', 'fills', [row])[0]).toHaveProperty('tradeQuoteCcy', tradeQuoteCcy);
  });
  it('keeps absent fill quote currency absent instead of inventing USDT', () => {
    expect(projectExecutionRows('okx', 'fills', [okxFill()])[0]).not.toHaveProperty('tradeQuoteCcy');
  });
  it.each(['-0.0005', '0.0001', '0', '', '-0.123456789012345678901234567890'])('preserves reported historical feeRate %j exactly', feeRate => {
    expect(projectExecutionRows('okx', 'fills', [okxFill({ feeRate })])[0]).toHaveProperty('feeRate', feeRate);
  });
  it('does not invent a historical fee rate when absent', () => {
    expect(projectExecutionRows('okx', 'fills', [okxFill()])[0]).not.toHaveProperty('feeRate');
  });
  it.each([0.001, null, '1e-3', 'PRIVATE_RATE', '0.' + '1'.repeat(31)])('rejects malformed historical feeRate %j', feeRate => {
    rejects(() => projectExecutionRows('okx', 'fills', [okxFill({ feeRate })]));
  });
  it.each([12, null, 'PRIVATE QUOTE'])('rejects malformed fill quote currency %j without echo', tradeQuoteCcy => {
    rejects(() => projectExecutionRows('okx', 'fills', [okxFill({ tradeQuoteCcy })]));
  });
  it('does not invent missing order economics', () => {
    expect(projectExecutionOrder('mexc', { symbol: 'BTCUSDT', orderId: 'id' })).toEqual({ symbol: 'BTCUSDT', orderId: 'id' });
    expect(projectExecutionOrder('okx', { instType: 'SPOT', instId: 'BTC-USDT', ordId: 'id' }))
      .toEqual({ instType: 'SPOT', instId: 'BTC-USDT', ordId: 'id' });
  });
  it('does not invent missing fill amounts or normalize an empty OKX value to zero', () => {
    expect(projectExecutionRows('mexc', 'fills', [{ symbol: 'BTCUSDT', orderId: 'id', id: 'fill' }]))
      .toEqual([{ symbol: 'BTCUSDT', orderId: 'id', id: 'fill' }]);
    expect(projectExecutionOrder('okx', okxOrder({ avgPx: '', fee: '', feeCcy: '' })))
      .toMatchObject({ avgPx: '', fee: '', feeCcy: '' });
  });
  it('preserves 30 fractional decimal digits and signed fees/rebates exactly', () => {
    const amount = '0.123456789012345678901234567890';
    expect(projectExecutionRows('mexc', 'fills', [mexcFill({ commission: amount })])[0]).toHaveProperty('commission', amount);
    expect(projectExecutionRows('okx', 'fills', [okxFill({ fee: '-' + amount }), okxFill({ fee: amount })]))
      .toMatchObject([{ fee: '-' + amount }, { fee: amount }]);
  });
  it('converts safe integer identities to strings without converting monetary strings', () => {
    expect(projectExecutionOrder('mexc', mexcOrder({ orderId: Number.MAX_SAFE_INTEGER })))
      .toHaveProperty('orderId', String(Number.MAX_SAFE_INTEGER));
    expect(projectExecutionRows('okx', 'fills', [okxFill({ ordId: 100, tradeId: 101, billId: 102 })])[0])
      .toMatchObject({ ordId: '100', tradeId: '101', billId: '102' });
  });
  it.each([Number.MAX_SAFE_INTEGER + 1, -1, 1.1, NaN, Infinity, {}, '', 'id with spaces', 'x'.repeat(129)])(
    'rejects unsafe primary identity %s with a fixed error', id => rejects(() => projectExecutionOrder('mexc', mexcOrder({ orderId: id }))));
  it.each([1, -1, NaN, '1e-8', '-1', '.1', '01', '0.' + '1'.repeat(31), '1'.repeat(31), 'PRIVATE_AMOUNT'])
    ('rejects malformed unsigned monetary input %s without echo', qty => rejects(() => projectExecutionRows('mexc', 'fills', [mexcFill({ qty })])));
  it.each(['PRIVATE ERROR', 'x'.repeat(41), 'state\nsecret', '<script>'])('rejects freeform status %s', status =>
    rejects(() => projectExecutionOrder('mexc', mexcOrder({ status }))));
  it('rejects wrong symbols across orders/fills/bills instead of silently filtering', () => {
    rejects(() => projectExecutionOrder('mexc', mexcOrder({ symbol: 'ETHUSDT' })));
    rejects(() => projectExecutionOrder('okx', okxOrder({ instId: 'BTC-USDC' })));
    rejects(() => projectExecutionRows('mexc', 'fills', [mexcFill({ symbol: 'ETHUSDT' })]));
    rejects(() => projectExecutionRows('okx', 'fills', [okxFill({ instId: 'BTC-USDT-SWAP' })]));
    rejects(() => projectExecutionRows('okx', 'bills', [okxBill({ instId: 'ETH-USDT' })]));
  });
  it('retains duplicate/conflicting rows for the audit, rather than hiding history conflicts', () => {
    const rows = [mexcFill(), mexcFill(), mexcFill({ quoteQty: '99' })];
    expect(projectExecutionRows('mexc', 'fills', rows)).toEqual(rows);
  });
  it('enforces page caps and array shape, while preserving an empty successful page', () => {
    expect(projectExecutionRows('mexc', 'fills', [])).toEqual([]);
    expect(projectExecutionRows('okx', 'bills', [])).toEqual([]);
    expect(projectExecutionRows('mexc', 'fills', Array.from({ length: 1000 }, () => mexcFill()))).toHaveLength(1000);
    expect(projectExecutionRows('okx', 'fills', Array.from({ length: 100 }, () => okxFill()))).toHaveLength(100);
    rejects(() => projectExecutionRows('mexc', 'fills', Array.from({ length: 1001 }, () => mexcFill())));
    rejects(() => projectExecutionRows('okx', 'fills', Array.from({ length: 101 }, () => okxFill())));
    rejects(() => projectExecutionRows('okx', 'bills', Array.from({ length: 101 }, () => okxBill())));
    rejects(() => projectExecutionRows('mexc', 'fills', mexcFill()));
    rejects(() => projectExecutionRows('okx', 'fills', { code: '0', data: [] }));
    rejects(() => projectExecutionRows('mexc', 'bills', []));
  });
  it.each([Number.MAX_SAFE_INTEGER + 1, '9999999999999999', -1, 1.5, '1e12', 'PRIVATE_TIME'])
    ('rejects malformed timestamp %s', time => rejects(() => projectExecutionOrder('mexc', mexcOrder({ time }))));
  it('preserves cash and margin bill facts without deriving a quote debit or asserting fee semantics', () => {
    const rows = [okxBill(privateExtras), okxBill({ billId: '104', instType: 'MARGIN', mgnMode: 'isolated',
      ccy: 'BTC', sz: '0.001', balChg: '0.000999', fee: '-0.000001' })];
    const result = projectExecutionRows('okx', 'bills', rows);
    expect(result).toEqual([okxBill(), rows[1]]);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_');
    for (const row of result) { expect(row).not.toHaveProperty('quoteQuantity'); expect(row).not.toHaveProperty('settlementReady'); }
  });
  it('keeps documented empty bill order link and optional fields empty or absent', () => {
    const row = { instType: 'SPOT', instId: 'BTC-USDT', billId: '105', ordId: '', tradeId: '', mgnMode: '',
      fillTime: '', fee: '', execType: '' };
    expect(projectExecutionRows('okx', 'bills', [row])).toEqual([row]);
    expect(projectExecutionRows('okx', 'bills', [{ instType: 'SPOT', instId: 'BTC-USDT', billId: '106' }]))
      .toEqual([{ instType: 'SPOT', instId: 'BTC-USDT', billId: '106' }]);
  });
});
