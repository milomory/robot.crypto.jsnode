import { describe, expect, it, vi } from 'vitest';
import { summarizeRecordedFees } from '../src/accounts/recorded-fees.js';
const at = 1_800_000_000_000;
const mexc = (patch: Record<string, unknown> = {}) => ({ symbol: 'BTCUSDT', orderId: 'PRIVATE_ORDER_1', id: 'PRIVATE_FILL_1',
  price: '70000', qty: '0.001', quoteQty: '70', commission: '0.035', commissionAsset: 'USDT',
  time: at, isBuyer: true, isMaker: false, ...patch });
const okx = (patch: Record<string, unknown> = {}) => ({ instType: 'SPOT', instId: 'BTC-USDT', ordId: 'PRIVATE_ORDER_1',
  tradeId: 'PRIVATE_FILL_1', billId: 'PRIVATE_BILL_1', side: 'buy', subType: '1', execType: 'T',
  fillSz: '0.001', fillPx: '70000', fee: '-0.000001', feeCcy: 'BTC', fillTime: String(at), ts: String(at + 1), ...patch });
const summary = (venue: 'mexc' | 'okx', rows: unknown[]) => summarizeRecordedFees({ venue, rows });

describe('observed fill fee arithmetic', () => {
  it('reports only observed MEXC expenses without wallet or future execution claims', () => {
    const result = summary('mexc', [mexc()]);
    expect(result).toMatchObject({ kind: 'recorded-fee-summary', venue: 'mexc', symbol: 'BTC/USDT', scope: 'observed-fills-only',
      status: 'observed', inputRows: 1, uniqueFills: 1, duplicateRows: 0, roles: { maker: 0, taker: 1, unknown: 0 }, zeroFeeFills: 0,
      totals: [{ currency: 'USDT', charges: '0.035', rebates: '0', nonzeroChargeFills: 1, nonzeroRebateFills: 0 }], reasons: [],
      wholeAccountHistoryProven: false, captureProvenanceVerified: false, futureFeeCurrencyVerified: false, roundingVerified: false, executable: false });
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.roles)).toBe(true); expect(Object.isFrozen(result.totals?.[0])).toBe(true);
  });
  it('retains all 30 decimal places with no Number rounding', () => {
    const result = summary('mexc', [mexc({ commission: '0.123456789012345678901234567890' }),
      mexc({ id: 'fill2', commission: '0.000000000000000000000000000001' })]);
    expect(result.totals?.[0].charges).toBe('0.123456789012345678901234567891');
  });
  it('preserves totals far above the Number integer precision limit', () => {
    const result = summary('mexc', [mexc({ commission: '9007199254740993.000000000000000000000000000001' }),
      mexc({ id: 'fill2', commission: '0.000000000000000000000000000001' })]);
    expect(result.totals?.[0].charges).toBe('9007199254740993.000000000000000000000000000002');
  });
  it('keeps OKX expenses and rebates separate without netting them', () => {
    const result = summary('okx', [okx({ fee: '-0.001' }), okx({ tradeId: 'fill2', billId: 'bill2', fee: '0.002', execType: 'M' })]);
    expect(result.totals).toEqual([{ currency: 'BTC', charges: '0.001', rebates: '0.002', nonzeroChargeFills: 1, nonzeroRebateFills: 1 }]);
    expect(result.roles).toEqual({ maker: 1, taker: 1, unknown: 0 });
  });
  it('reports each actual fee asset independently without FX conversion', () => {
    const result = summary('okx', [okx(), okx({ tradeId: 'fill2', billId: 'bill2', feeCcy: 'USDT', fee: '-0.07' }),
      okx({ tradeId: 'fill3', billId: 'bill3', feeCcy: 'MX', fee: '-0.1' }),
      okx({ tradeId: 'fill4', billId: 'bill4', feeCcy: 'OTHER_ASSET', fee: '0.02' })]);
    expect(result.status).toBe('observed');
    expect(result.totals).toEqual([
      { currency: 'BTC', charges: '0.000001', rebates: '0', nonzeroChargeFills: 1, nonzeroRebateFills: 0 },
      { currency: 'MX', charges: '0.1', rebates: '0', nonzeroChargeFills: 1, nonzeroRebateFills: 0 },
      { currency: 'OTHER_ASSET', charges: '0', rebates: '0.02', nonzeroChargeFills: 0, nonzeroRebateFills: 1 },
      { currency: 'USDT', charges: '0.07', rebates: '0', nonzeroChargeFills: 1, nonzeroRebateFills: 0 },
    ]);
  });
  it.each(['0', '-0', '0.000000000000000000000000000000'])('does not treat zero fee %s as proof of debit currency', fee => {
    const result = summary('okx', [okx({ fee })]);
    expect(result).toMatchObject({ status: 'observed', zeroFeeFills: 1, totals: [], futureFeeCurrencyVerified: false });
  });
  it('does not include a zero-only currency in nonzero fee totals', () => {
    const result = summary('mexc', [mexc(), mexc({ id: 'fill2', commission: '0', commissionAsset: 'MX' })]);
    expect(result.zeroFeeFills).toBe(1); expect(result.totals?.map(item => item.currency)).toEqual(['USDT']);
  });
  it('uses reported fees rather than deriving them from price, quantity or current tariff', () => {
    const result = summary('mexc', [mexc({ commission: '0.03456789', price: '1', qty: '99', quoteQty: '123' })]);
    expect(result.status).toBe('observed'); expect(result.totals?.[0].charges).toBe('0.03456789');
  });
  it('does not require trade notional to summarize complete reported fees', () => {
    const result = summary('mexc', [{ symbol: 'BTCUSDT', id: 'fill', orderId: 'order', commission: '0.123', commissionAsset: 'MX', time: at, isBuyer: true }]);
    expect(result).toMatchObject({ status: 'observed', roles: { unknown: 1 }, totals: [{ currency: 'MX', charges: '0.123' }] });
  });
  it('does not recalculate an OKX fee from optional historical feeRate', () => {
    const result = summary('okx', [okx({ fee: '-0.123', feeRate: '-0.0001' })]);
    expect(result.status).toBe('observed'); expect(result.totals?.[0].charges).toBe('0.123');
  });
  it.each(['mexc', 'okx'] as const)('counts explicit maker/taker/unknown for %s without assuming LIMIT is maker', venue => {
    const rows = venue === 'mexc' ? [mexc({ isMaker: true }), mexc({ id: 'fill2', isMaker: false }),
      mexc({ id: 'fill3', isMaker: undefined, type: 'LIMIT' })] : [okx({ execType: 'M' }),
      okx({ tradeId: 'fill2', billId: 'bill2', execType: 'T' }), okx({ tradeId: 'fill3', billId: 'bill3', execType: '', ordType: 'limit' })];
    expect(summary(venue, rows)).toMatchObject({ status: 'observed', roles: { maker: 1, taker: 1, unknown: 1 } });
  });
  it('retains unknown bounded execution role as unknown', () => {
    expect(summary('okx', [okx({ execType: 'NEW_ROLE' })])).toMatchObject({ status: 'observed', roles: { unknown: 1 } });
  });
  it('distinguishes an empty observation from zero total fee', () => {
    expect(summary('mexc', [])).toMatchObject({ status: 'no-observations', inputRows: 0, uniqueFills: 0, totals: null });
    expect(summary('mexc', [mexc({ commission: '0' })])).toMatchObject({ status: 'observed', totals: [] });
  });
});

describe('fee fill deduplication and conflicts', () => {
  it.each(['mexc', 'okx'] as const)('deduplicates identical %s rows without duplicating fees or roles', venue => {
    const row = venue === 'mexc' ? mexc() : okx(), result = summary(venue, [row, row, { ...row }]);
    expect(result).toMatchObject({ status: 'observed', inputRows: 3, uniqueFills: 1, duplicateRows: 2, roles: { taker: 1 } });
    expect(result.totals?.[0].nonzeroChargeFills).toBe(1);
  });
  it('deduplicates numerically identical fee/time/identity representations exactly', () => {
    const result = summary('mexc', [mexc({ id: 101, orderId: 100, commission: '0.035000', time: String(at) }),
      mexc({ id: '101', orderId: '100', commission: '0.035', time: at })]);
    expect(result).toMatchObject({ status: 'observed', uniqueFills: 1, duplicateRows: 1 });
  });
  it.each([
    { orderId: 'different-order' }, { commission: '0.036' }, { commissionAsset: 'BTC' }, { isBuyer: false },
    { isMaker: true }, { time: at + 1 }, { price: '70001' }, { qty: '0.002' }, { quoteQty: '71' }, { isSelfTrade: true },
  ])('rejects MEXC fill-id conflict %j', patch => {
    const result = summary('mexc', [mexc(), mexc(patch)]);
    expect(result).toMatchObject({ status: 'invalid', totals: null }); expect(result.reasons).toContain('fill-identity-conflict');
  });
  it.each([
    { ordId: 'different-order' }, { billId: 'different-bill' }, { fee: '-0.002' }, { feeCcy: 'USDT' }, { side: 'sell' },
    { execType: 'M' }, { fillTime: String(at - 1) }, { ts: String(at + 2) }, { feeRate: '-0.003' },
  ])('rejects OKX trade-id conflict %j', patch => {
    const result = summary('okx', [okx(), okx(patch)]);
    expect(result).toMatchObject({ status: 'invalid', totals: null }); expect(result.reasons).toContain('fill-identity-conflict');
  });
  it('rejects changed historical feeRate even when recorded fee amount is unchanged', () => {
    const result = summary('okx', [okx({ feeRate: '-0.001' }), okx({ feeRate: '-0.002' })]);
    expect(result).toMatchObject({ status: 'invalid', totals: null }); expect(result.reasons).toContain('fill-identity-conflict');
  });
  it('rejects one bill assigned to two different OKX trades', () => {
    const result = summary('okx', [okx(), okx({ tradeId: 'other-trade' })]);
    expect(result).toMatchObject({ status: 'invalid', totals: null }); expect(result.reasons).toContain('bill-identity-conflict');
  });
  it('never replaces an incomplete row with a complete duplicate silently', () => {
    const result = summary('mexc', [mexc({ commission: undefined }), mexc()]);
    expect(result).toMatchObject({ status: 'invalid', totals: null });
    expect(result.reasons).toContain('fee-missing'); expect(result.reasons).toContain('fill-identity-conflict');
  });
  it('also rejects complete followed by incomplete duplicate', () => {
    const result = summary('okx', [okx(), okx({ fee: '' })]);
    expect(result).toMatchObject({ status: 'invalid', totals: null }); expect(result.reasons).toContain('fill-identity-conflict');
  });
  it('tolerates irrelevant private metadata differences without exposing them', () => {
    const result = summary('mexc', [mexc({ notes: 'PRIVATE_NOTE', credentials: 'PRIVATE_SECRET' }), mexc({ notes: 'DIFFERENT_PRIVATE_NOTE' })]);
    expect(result).toMatchObject({ status: 'observed', duplicateRows: 1 });
    const output = JSON.stringify(result); expect(output).not.toContain('PRIVATE_');
  });
});

describe('incomplete and malformed observations close totals', () => {
  it.each([
    [{ commission: undefined }, 'fee-missing'], [{ commissionAsset: undefined }, 'fee-currency-missing'],
    [{ time: undefined }, 'fill-time-missing'], [{ isBuyer: undefined }, 'side-missing'],
  ] as const)('marks MEXC missing evidence %j incomplete', (patch, reason) => {
    const result = summary('mexc', [mexc(), mexc({ id: 'fill2', ...patch })]);
    expect(result).toMatchObject({ status: 'incomplete', totals: null }); expect(result.reasons).toContain(reason);
  });
  it.each([
    [{ fee: undefined }, 'fee-missing'], [{ fee: '' }, 'fee-missing'], [{ feeCcy: '' }, 'fee-currency-missing'],
    [{ fillTime: '' }, 'fill-time-missing'], [{ side: '' }, 'side-missing'],
  ] as const)('marks OKX missing evidence %j incomplete', (patch, reason) => {
    const result = summary('okx', [okx(), okx({ tradeId: 'fill2', billId: 'bill2', ...patch })]);
    expect(result).toMatchObject({ status: 'incomplete', totals: null }); expect(result.reasons).toContain(reason);
  });
  it('requires a reported currency even for zero fee instead of silently filling USDT', () => {
    expect(summary('mexc', [mexc({ commission: '0', commissionAsset: undefined })])).toMatchObject({ status: 'incomplete', totals: null });
  });
  it.each(['MARGIN', 'SWAP', 'OPTION'])('refuses OKX %s despite matching BTC-USDT and valid fees', instType => {
    const result = summary('okx', [okx({ instType })]);
    expect(result).toMatchObject({ status: 'invalid', totals: null }); expect(result.reasons).toContain('unsupported-execution-category');
  });
  it.each(['mexc', 'okx'] as const)('refuses wrong %s pair rather than excluding its fee silently', venue => {
    expect(summary(venue, [venue === 'mexc' ? mexc({ symbol: 'ETHUSDT' }) : okx({ instId: 'ETH-USDT' })]))
      .toMatchObject({ status: 'invalid', totals: null });
  });
  it.each([0, -1, Number.MAX_SAFE_INTEGER, '8640000000000001'])('rejects invalid fill time %s', time => {
    expect(summary('mexc', [mexc({ time })])).toMatchObject({ status: 'invalid', totals: null });
  });
  it('rejects OKX fillTime after response record time', () => {
    const result = summary('okx', [okx({ ts: String(at - 1) })]);
    expect(result).toMatchObject({ status: 'invalid', totals: null }); expect(result.reasons).toContain('fill-time-conflict');
  });
  it('does not substitute ts for a missing actual fillTime', () => {
    const result = summary('okx', [okx({ fillTime: undefined })]);
    expect(result).toMatchObject({ status: 'incomplete', totals: null }); expect(result.reasons).toContain('fill-time-missing');
  });
  it('rejects an explicit side/subType contradiction', () => {
    expect(summary('okx', [okx({ subType: '2' })])).toMatchObject({ status: 'invalid', totals: null, reasons: ['side-subtype-conflict'] });
  });
  it.each(['-0.001', '1e-8', 'NaN', '0.' + '1'.repeat(31), 0.001, null])('rejects unsupported MEXC fee %j', commission => {
    expect(summary('mexc', [mexc({ commission })])).toMatchObject({ status: 'invalid', totals: null });
  });
  it.each([undefined, null, {}, [], { venue: 'bybit', rows: [] }, { venue: 'mexc', rows: 'PRIVATE_ERROR' },
    { venue: 'mexc', rows: [], currentTariff: '0' }])('rejects invalid enlarged input without echo', value => {
    const result = summarizeRecordedFees(value);
    expect(result).toMatchObject({ status: 'invalid', totals: null, reasons: ['invalid-input'] });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_ERROR');
  });
  it('accepts exactly 3000 observed rows and rejects 3001', () => {
    const rows = Array.from({ length: 3000 }, (_, index) => mexc({ id: 'fill' + index, commission: '0.000000000000000000000000000001' }));
    const result = summary('mexc', rows);
    expect(result).toMatchObject({ status: 'observed', uniqueFills: 3000 }); expect(result.totals?.[0].charges).toBe('0.000000000000000000000000003');
    expect(summary('mexc', [...rows, mexc()])).toMatchObject({ status: 'invalid', totals: null, reasons: ['too-many-rows'] });
  });
  it('does not mutate caller rows or keep their references', () => {
    const row = mexc(), before = JSON.stringify(row), result = summary('mexc', [row]);
    expect(JSON.stringify(row)).toBe(before); row.commission = '999';
    expect(result.totals?.[0].charges).toBe('0.035');
  });
  it('needs no network and emits no raw identifiers, private metadata or upstream error', () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('PRIVATE_SECRET'));
    try {
      const result = summary('okx', [okx({ apiKey: 'PRIVATE_KEY', msg: 'PRIVATE_ERROR' })]);
      expect(result.status).toBe('observed'); expect(JSON.stringify(result)).not.toContain('PRIVATE_'); expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });
});
