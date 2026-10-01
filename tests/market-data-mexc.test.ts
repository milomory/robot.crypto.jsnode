import { describe, expect, it } from 'vitest';
import { parsePublicJson, record } from '../src/market-data/exact-json.js';
import { parseMexcFunding, parseMexcInstrument } from '../src/market-data/mexc.js';
import { MarketDataError, publicUrl, type PublicReceipt, type ResearchBase } from '../src/market-data/model.js';

const at = 1_800_000_000_000;
const receipt = (kind: 'instrument' | 'funding', base: ResearchBase = 'BTC'): PublicReceipt => ({
  url: publicUrl('mexc', base, kind), requestedAt: at - 100, receivedAt: at,
});
const decode = (body: unknown) => parsePublicJson(Buffer.from(JSON.stringify(body)));
const instrumentRow = (base: ResearchBase = 'BTC') => ({
  symbol: `${base}_USDT`, baseCoin: base, quoteCoin: 'USDT', settleCoin: 'USDT', futureType: 1, type: 1,
  contractSize: base === 'BTC' ? 0.0001 : 0.01, priceUnit: base === 'BTC' ? 0.1 : 0.01,
  volUnit: 1, minVol: 1, maxVol: 400000, limitMaxVol: 2500000,
  state: 0, apiAllowed: true, preMarket: false, automaticDelivery: 0,
});
const instrument = (patch: Record<string, unknown> = {}, base: ResearchBase = 'BTC') =>
  decode({ success: true, code: 0, data: { ...instrumentRow(base), ...patch } });
const fundingRow = () => ({ symbol: 'BTC_USDT', fundingRate: 0.000049, collectCycle: 8,
  nextSettleTime: at + 3_600_000, timestamp: at - 100, minFundingRate: -0.0018, maxFundingRate: 0.0018 });
const funding = (patch: Record<string, unknown> = {}) => decode({ success: true, code: 0, data: { ...fundingRow(), ...patch } });

describe('MEXC exact public instrument specification', () => {
  it.each(['BTC', 'ETH'] as const)('converts %s contract quantities to base units without granting execution or fee authority', base => {
    const spec = parseMexcInstrument(instrument({}, base), base, receipt('instrument', base));
    const size = base === 'BTC' ? '0.0001' : '0.01';
    expect(spec).toMatchObject({
      kind: 'public-linear-contract', market: { exchange: 'mexc', base, type: 'perpetual', settlement: 'USDT' },
      quantityUnit: 'contracts', basePerContract: size, baseQuantityStep: size, baseMinimumQuantity: size,
      publicListingUsable: true, sourceUpdatedAt: null, exchangeApiAllowed: true,
      accountEligibilityVerified: false, personalFeesVerified: false, executable: false,
    });
  });
  it('retains exact numeric JSON lexemes beyond Number precision', () => {
    const text = JSON.stringify({ success: true, code: 0, data: instrumentRow() })
      .replace('"contractSize":0.0001', '"contractSize":0.123456789012345678901234567891')
      .replace('"maxVol":400000', '"maxVol":9007199254740993');
    const spec = parseMexcInstrument(parsePublicJson(Buffer.from(text)), 'BTC', receipt('instrument'));
    expect(spec.basePerContract).toBe('0.123456789012345678901234567891');
    expect(spec.baseMinimumQuantity).toBe(spec.basePerContract);
    expect(spec.maximumContractsReported).toBe('9007199254740993');
  });
  it('uses exact reported fractional quantity steps, without rounding to contracts or base precision', () => {
    const spec = parseMexcInstrument(instrument({ contractSize: '0.0001', volUnit: '0.125', minVol: '0.375' }), 'BTC', receipt('instrument'));
    expect(spec.baseQuantityStep).toBe('0.0000125');
    expect(spec.baseMinimumQuantity).toBe('0.0000375');
  });
  it('retains two differently scoped maxima without silently choosing an executable limit', () => {
    const spec = parseMexcInstrument(instrument(), 'BTC', receipt('instrument'));
    expect(spec.maximumContractsReported).toBe('400000');
    expect(spec.limitMaximumContractsReported).toBe('2500000');
    expect(spec).not.toHaveProperty('maxExecutableNotional');
  });
  it('keeps absent optional maxima unknown', () => {
    const spec = parseMexcInstrument(instrument({ maxVol: undefined, limitMaxVol: undefined }), 'BTC', receipt('instrument'));
    expect(spec.maximumContractsReported).toBeNull(); expect(spec.limitMaximumContractsReported).toBeNull();
  });
  it('does not promote public fee fields or metadata createTime into personal fees or freshness', () => {
    const spec = parseMexcInstrument(instrument({ makerFeeRate: 0, takerFeeRate: 0.0002, createTime: at }), 'BTC', receipt('instrument'));
    expect(spec).not.toHaveProperty('makerFeeRate'); expect(spec).not.toHaveProperty('takerFeeRate');
    expect(spec.personalFeesVerified).toBe(false); expect(spec.sourceUpdatedAt).toBeNull();
  });
  it.each([{ state: 1 }, { state: 2 }, { state: 3 }, { state: 4 }, { apiAllowed: false }, { preMarket: true }, { automaticDelivery: 1 }])(
    'retains a recognized restricted listing as unusable: %j', patch => {
      expect(parseMexcInstrument(instrument(patch), 'BTC', receipt('instrument')).publicListingUsable).toBe(false);
    });
  it.each([
    { symbol: 'ETH_USDT' }, { baseCoin: 'ETH' }, { quoteCoin: 'USD' }, { settleCoin: 'BTC' },
    { futureType: 2 }, { type: 2 }, { futureType: '1.0' }, { state: 9 }, { automaticDelivery: 2 },
    { apiAllowed: 'true' }, { preMarket: 0 }, { contractSize: '0' }, { contractSize: '-0.1' },
    { volUnit: '0' }, { minVol: '0.5', volUnit: '1' }, { priceUnit: '0' }, { maxVol: '0.5' },
    { limitMaxVol: null }, { priceUnit: '' }, { contractSize: '1e-31' },
  ])('rejects wrong scope, unknown state or impossible units: %j', patch => {
    expect(() => parseMexcInstrument(instrument(patch), 'BTC', receipt('instrument'))).toThrow(MarketDataError);
  });
  it.each(['symbol', 'baseCoin', 'quoteCoin', 'settleCoin', 'futureType', 'type', 'state', 'apiAllowed', 'preMarket',
    'automaticDelivery', 'contractSize', 'volUnit', 'minVol', 'priceUnit'])('rejects absent critical field %s', field => {
    expect(() => parseMexcInstrument(instrument({ [field]: undefined }), 'BTC', receipt('instrument'))).toThrow(MarketDataError);
  });
  it('rejects a native Number replacing an exact JSON token', () => {
    const raw = record(instrument()); record(raw.data).contractSize = 0.0001;
    expect(() => parseMexcInstrument(raw, 'BTC', receipt('instrument'))).toThrow('invalid-public-number');
  });
  it('rejects derived quantity requiring more than thirty decimal places', () => {
    expect(() => parseMexcInstrument(instrument({ contractSize: '1e-30', volUnit: '0.1', minVol: '0.1' }), 'BTC', receipt('instrument')))
      .toThrow('public-product-precision');
  });
  it('deep freezes its output and copies the receipt', () => {
    const r = receipt('instrument'), spec = parseMexcInstrument(instrument(), 'BTC', r);
    expect(Object.isFrozen(spec)).toBe(true); expect(Object.isFrozen(spec.market)).toBe(true); expect(Object.isFrozen(spec.receipt)).toBe(true);
    r.receivedAt += 1; expect(spec.receipt.receivedAt).toBe(at);
  });
});

describe('MEXC funding estimate semantics and timing', () => {
  it.each(['0.000049', '-0.000074', '0'])('retains the signed rate %s as an unsettled estimate, not account income', rate => {
    const result = parseMexcFunding(funding({ fundingRate: rate }), 'BTC', receipt('funding'));
    expect(result).toMatchObject({ kind: 'public-funding-estimate', rate, rateMeaning: 'estimate-not-settled',
      sourceUpdatedAt: at - 100, upcomingSettlementAt: at + 3_600_000, followingSettlementAt: null,
      intervalMs: 28_800_000, intervalBasis: 'reported-cycle', realizedAccountIncome: null, executable: false });
  });
  it('supports ETH without rewriting an instrument identifier', () => {
    expect(parseMexcFunding(funding({ symbol: 'ETH_USDT' }), 'ETH', receipt('funding', 'ETH')).market.base).toBe('ETH');
  });
  it('preserves a signed numeric funding JSON token exactly', () => {
    const text = JSON.stringify({ success: true, code: 0, data: fundingRow() })
      .replace('"fundingRate":0.000049', '"fundingRate":-0.000123456789012345678901234567');
    expect(parseMexcFunding(parsePublicJson(Buffer.from(text)), 'BTC', receipt('funding')).rate)
      .toBe('-0.000123456789012345678901234567');
  });
  it.each([1, 2, 4, 8, 24])('uses reported %sh cycle instead of assuming eight hours', collectCycle => {
    expect(parseMexcFunding(funding({ collectCycle }), 'BTC', receipt('funding')).intervalMs).toBe(collectCycle * 3_600_000);
  });
  it('does not manufacture an absent source timestamp or a following settlement', () => {
    const result = parseMexcFunding(funding({ timestamp: undefined }), 'BTC', receipt('funding'));
    expect(result.sourceUpdatedAt).toBeNull(); expect(result.followingSettlementAt).toBeNull();
  });
  it.each([
    { symbol: 'ETH_USDT' }, { collectCycle: undefined }, { collectCycle: 0 }, { collectCycle: 25 }, { collectCycle: 0.5 },
    { collectCycle: '08' }, { nextSettleTime: at }, { nextSettleTime: at - 1 }, { nextSettleTime: at + 28_805_001 },
    { nextSettleTime: '9007199254740993' }, { timestamp: at - 60_001 }, { timestamp: at + 5001 }, { timestamp: null },
    { timestamp: at + 3000, nextSettleTime: at + 2000 },
    { fundingRate: undefined }, { fundingRate: 'NaN' }, { fundingRate: 'Infinity' }, { fundingRate: 0.002 },
    { minFundingRate: 0.01, maxFundingRate: -0.01 }, { minFundingRate: undefined },
  ])('rejects malformed, stale or inconsistent funding: %j', patch => {
    expect(() => parseMexcFunding(funding(patch), 'BTC', receipt('funding'))).toThrow(MarketDataError);
  });
  it.each([at - 60_000, at + 5000])('accepts the explicit freshness boundary %s', timestamp => {
    expect(parseMexcFunding(funding({ timestamp }), 'BTC', receipt('funding')).sourceUpdatedAt).toBe(timestamp);
  });
  it('does not mistake malformed future source time for acceptable receipt-only freshness', () => {
    const raw = record(funding()); record(raw.data).timestamp = at;
    expect(() => parseMexcFunding(raw, 'BTC', receipt('funding'))).toThrow('invalid-public-number');
  });
  it('rejects wrong endpoint receipts and receipt time reversal before data parsing', () => {
    expect(() => parseMexcFunding(funding(), 'BTC', receipt('instrument'))).toThrow('invalid-public-timing');
    expect(() => parseMexcFunding(funding(), 'BTC', { ...receipt('funding'), requestedAt: at + 1 })).toThrow('invalid-public-timing');
    expect(() => parseMexcFunding(funding(), 'BTC', { ...receipt('funding'), requestedAt: at - 5001 })).toThrow('invalid-public-timing');
  });
  it.each([{ success: false, code: 0 }, { success: true, code: 403 }, { success: true, code: 0, data: [] }])(
    'does not normalize unsuccessful or wrong-shaped envelopes: %j', root => {
      expect(() => parseMexcFunding(decode({ data: fundingRow(), ...root }), 'BTC', receipt('funding'))).toThrow(MarketDataError);
    });
  it('never reflects arbitrary server error text', () => {
    try { parseMexcFunding(decode({ success: false, code: 403, message: 'UNTRUSTED_DETAILS' }), 'BTC', receipt('funding')); }
    catch (error) { expect(error).toBeInstanceOf(MarketDataError); expect(String(error)).not.toContain('UNTRUSTED_DETAILS'); }
  });
});
