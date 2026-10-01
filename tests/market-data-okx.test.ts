import { describe, expect, it } from 'vitest';
import { parsePublicJson } from '../src/market-data/exact-json.js';
import { parseOkxFunding, parseOkxInstrument } from '../src/market-data/okx.js';
import { publicUrl } from '../src/market-data/model.js';
import type { PublicReceipt, ResearchBase } from '../src/market-data/model.js';

const now = 1_790_839_953_441;
const receipt = (kind: 'instrument' | 'funding', base: ResearchBase = 'BTC'): PublicReceipt => ({
  url: publicUrl('okx', base, kind), requestedAt: now, receivedAt: now + 300,
});
const wire = (row: Record<string, unknown>, envelope: Record<string, unknown> = {}) =>
  parsePublicJson(Buffer.from(JSON.stringify({ code: '0', data: [row], msg: '', ...envelope })));
const instrument = (patch: Record<string, unknown> = {}, base: ResearchBase = 'BTC') => ({
  instId: `${base}-USDT-SWAP`, instType: 'SWAP', instFamily: `${base}-USDT`, uly: `${base}-USDT`,
  ctVal: base === 'BTC' ? '0.01' : '0.1', ctMult: '1', ctType: 'linear', ctValCcy: base,
  baseCcy: '', quoteCcy: '', settleCcy: 'USDT', lotSz: '0.01', minSz: '0.01', tickSz: base === 'BTC' ? '0.1' : '0.01',
  maxMktSz: '20000', maxLmtSz: '1000000', state: 'live', listTime: '1573557408000', expTime: '',
  groupId: '4', upcChg: [], tradeQuoteCcyList: [], ruleType: 'normal', ...patch,
});
const funding = (patch: Record<string, unknown> = {}, base: ResearchBase = 'BTC') => ({
  instType: 'SWAP', instId: `${base}-USDT-SWAP`, fundingRate: '0.0000265671219988',
  fundingTime: String(now + 1_000_000), nextFundingTime: String(now + 1_000_000 + 28_800_000),
  ts: String(now - 10000), method: 'current_period', formulaType: 'withRate',
  nextFundingRate: '', settFundingRate: '0.001', settState: 'settled', ...patch,
});
const parseInstrument = (patch: Record<string, unknown> = {}) => parseOkxInstrument(wire(instrument(patch)), 'BTC', receipt('instrument'));
const parseFunding = (patch: Record<string, unknown> = {}) => parseOkxFunding(wire(funding(patch)), 'BTC', receipt('funding'));

describe('OKX public perpetual instrument units', () => {
  it.each([['BTC', '0.01', '0.0001', '0.1'], ['ETH', '0.1', '0.001', '0.01']] as const)(
    'normalizes %s contracts to base quantity without USD notional assumptions', (base, perContract, minBase, tick) => {
      const result = parseOkxInstrument(wire(instrument({}, base)), base, receipt('instrument', base));
      expect(result).toMatchObject({ schema: 1, kind: 'public-linear-contract',
        market: { exchange: 'okx', type: 'perpetual', base, quote: 'USDT', settlement: 'USDT', instrumentId: `${base}-USDT-SWAP` },
        sourceUpdatedAt: null, quantityUnit: 'contracts', basePerContract: perContract,
        quantityStepContracts: '0.01', minimumContracts: '0.01', baseQuantityStep: minBase, baseMinimumQuantity: minBase,
        priceTick: tick, maximumContractsReported: '20000', limitMaximumContractsReported: '1000000',
        publicListingUsable: true, upcomingChange: false, exchangeApiAllowed: null,
        accountEligibilityVerified: false, personalFeesVerified: false, executable: false });
    });
  it('retains market and limit maxima separately and treats neither as account capacity', () => {
    expect(parseInstrument({ maxMktSz: '9007199254740993.1', maxLmtSz: '9007199254740993.2' }))
      .toMatchObject({ maximumContractsReported: '9007199254740993.1', limitMaximumContractsReported: '9007199254740993.2', accountEligibilityVerified: false });
  });
  it.each([undefined, null, ''])('leaves unavailable maxima unknown: %s', value => {
    expect(parseInstrument({ maxMktSz: value, maxLmtSz: value })).toMatchObject({ maximumContractsReported: null, limitMaximumContractsReported: null });
  });
  it('does not round numeric wire tokens through JavaScript Number', () => {
    const text = JSON.stringify({ code: '0', data: [instrument({ maxMktSz: 'WIRE_EXACT' })] }).replace('"WIRE_EXACT"', '9007199254740993.000000000000000000000000000001');
    const result = parseOkxInstrument(parsePublicJson(Buffer.from(text)), 'BTC', receipt('instrument'));
    expect(result.maximumContractsReported).toBe('9007199254740993.000000000000000000000000000001');
  });
  it('normalizes exactly representable exponent values', () => {
    expect(parseInstrument({ ctVal: '1e-2', lotSz: '1e-2', minSz: '1e-2' })).toMatchObject({ baseQuantityStep: '0.0001', baseMinimumQuantity: '0.0001' });
  });
  it('rejects a base conversion that cannot fit the exact decimal scale', () => {
    expect(() => parseInstrument({ ctVal: '1e-30', lotSz: '0.1', minSz: '0.1' })).toThrow('public-product-precision');
  });
  it.each([
    { instId: 'ETH-USDT-SWAP' }, { instType: 'SPOT' }, { instFamily: 'BTC-USD' }, { uly: 'BTC-USD' },
    { ctValCcy: 'USD' }, { ctValCcy: 'ETH' }, { ctType: 'inverse' }, { ctMult: '10' },
    { settleCcy: 'BTC' }, { baseCcy: 'BTC' }, { quoteCcy: 'USDT' }, { tradeQuoteCcyList: ['USDT'] },
  ])('rejects mismatched contract identity/units: %j', patch => { expect(() => parseInstrument(patch)).toThrow(); });
  it.each([
    { ctVal: '0' }, { minSz: '-1' }, { lotSz: '0' }, { tickSz: 'NaN' }, { minSz: '0.015' },
    { maxMktSz: '0.001' }, { maxLmtSz: '-1' }, { ctVal: '1e-31' }, { ctVal: '1e100' },
  ])('rejects invalid precision or quantity constraints: %j', patch => { expect(() => parseInstrument(patch)).toThrow(); });
  it.each(['suspend', 'preopen', 'post_only', 'new_future_state'])('reports %s without permitting a public listing', state => {
    expect(parseInstrument({ state })).toMatchObject({ publicState: state, publicListingUsable: false, executable: false });
  });
  it.each([
    { expTime: String(now + 10000) }, { expTime: String(now - 10000) },
    { upcChg: [{ param: 'tickSz', newValue: '0.01', effTime: String(now + 1000) }] },
  ])('preserves a changing/delisting contract as unusable: %j', patch => {
    expect(parseInstrument(patch)).toMatchObject({ upcomingChange: true, publicListingUsable: false, executable: false });
  });
  it.each([{ listTime: String(now + 1) }, { ruleType: 'pre_market' }, { ruleType: undefined }])('does not accept premature/unclear listing %j', patch => {
    expect(parseInstrument(patch)).toMatchObject({ publicListingUsable: false });
  });
  it.each([{ upcChg: null }, { expTime: 'tomorrow' }, { upcChg: [{}] }, { state: 'unsupported label' }])('rejects malformed listing data %j', patch => {
    expect(() => parseInstrument(patch)).toThrow();
  });
  it('retains an opaque fee group without importing spot fees', () => {
    expect(parseInstrument({ groupId: '12' })).toMatchObject({ feeGroupId: '12', personalFeesVerified: false });
  });
  it('freezes its projection without freezing caller-owned receipt objects', () => {
    const inputReceipt = receipt('instrument'), result = parseOkxInstrument(wire(instrument()), 'BTC', inputReceipt);
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.market)).toBe(true); expect(Object.isFrozen(result.receipt)).toBe(true);
    expect(Object.isFrozen(inputReceipt)).toBe(false); inputReceipt.receivedAt += 1;
    expect(result.receipt.receivedAt).toBe(now + 300);
  });
});

describe('OKX public funding is a changing estimate, not account income', () => {
  it('binds the current rate to fundingTime and uses the following time only for an observed interval', () => {
    expect(parseFunding({ nextFundingRate: '0.2', settFundingRate: '0.3' })).toMatchObject({
      kind: 'public-funding-estimate', rate: '0.0000265671219988', rateMeaning: 'estimate-not-settled',
      upcomingSettlementAt: now + 1_000_000, followingSettlementAt: now + 1_000_000 + 28_800_000,
      intervalMs: 28_800_000, intervalBasis: 'next-times-difference', sourceUpdatedAt: now - 10000,
      realizedAccountIncome: null, executable: false,
    });
  });
  it('does not mistake the next shorter interval for the current rate period', () => {
    const result=parseFunding({fundingTime:String(now+6*3_600_000),nextFundingTime:String(now+7*3_600_000)});
    expect(result).toMatchObject({upcomingSettlementAt:now+6*3_600_000,followingSettlementAt:now+7*3_600_000,
      intervalMs:3_600_000,intervalBasis:'next-times-difference',rate:'0.0000265671219988',realizedAccountIncome:null,executable:false});
  });
  it('binds ETH separately', () => {
    expect(parseOkxFunding(wire(funding({}, 'ETH')), 'ETH', receipt('funding', 'ETH')).market.base).toBe('ETH');
  });
  it.each([1, 2, 4, 6, 8, 24])('allows an observed %s-hour schedule without hardcoding an 8-hour interval', hours => {
    expect(parseFunding({ nextFundingTime: String(now + 1_000_000 + hours * 3_600_000) }).intervalMs).toBe(hours * 3_600_000);
  });
  it.each(['0', '-0.000012345678901234567890123456', '0.000000000000000000000000000001'])('retains exact signed rate %s', rate => {
    expect(parseFunding({ fundingRate: rate }).rate).toBe(rate);
  });
  it('keeps processing settlement separate from the forecast rather than inventing realized income', () => {
    expect(parseFunding({ settState: 'processing', settFundingRate: '0.5' })).toMatchObject({ rate: '0.0000265671219988', realizedAccountIncome: null });
  });
  it.each([
    { ts: String(now + 5301) }, { ts: String(now - 59701) }, { fundingTime: String(now + 300) },
    { fundingTime: String(now + 86_400_001 + 300), nextFundingTime: String(now + 172_800_001 + 300) },
    { nextFundingTime: String(now + 1_000_000) }, { nextFundingTime: String(now + 1_000_000 + 86_400_001) },
    { nextFundingTime: '' }, { ts: null }, { ts: '9007199254740993' },
  ])('rejects stale, future, expired or incoherent timing: %j', patch => { expect(() => parseFunding(patch)).toThrow(); });
  it('accepts the precise freshness and future-skew boundaries', () => {
    expect(parseFunding({ ts: String(now + 300 - 60000) }).sourceUpdatedAt).toBe(now + 300 - 60000);
    expect(parseFunding({ ts: String(now + 300 + 5000) }).sourceUpdatedAt).toBe(now + 300 + 5000);
  });
  it.each([{ fundingRate: 'NaN' }, { fundingRate: '1.0001' }, { fundingRate: '-1.0001' }, { fundingRate: '1e-31' },
    { method: 'next_period' }, { instType: 'FUTURES' }, { instId: 'BTC-USD-SWAP' }])('rejects unsupported funding contract %j', patch => {
    expect(() => parseFunding(patch)).toThrow();
  });
});

describe('OKX public receipt and envelope binding', () => {
  it.each([{ code: '50011' }, { code: 0 }, { data: [] }, { data: [instrument(), instrument()] }, { data: {} }, { data: [null] }])(
    'rejects API errors, missing, duplicate or malformed records: %j', envelope => {
      expect(() => parseOkxInstrument(wire(instrument(), envelope), 'BTC', receipt('instrument'))).toThrow();
    });
  it.each([
    { url: 'https://www.okx.com/api/v5/account/instruments?instType=SWAP&instId=BTC-USDT-SWAP' },
    { url: publicUrl('okx', 'ETH', 'instrument') }, { url: publicUrl('okx', 'BTC', 'funding') },
    { receivedAt: now - 1 }, { receivedAt: now + 5001 }, { requestedAt: 0 }, { requestedAt: now + 0.5 },
    { extra: true },
  ])('rejects route mismatch or invalid local observation timing: %j', patch => {
    expect(() => parseOkxInstrument(wire(instrument()), 'BTC', { ...receipt('instrument'), ...patch })).toThrow();
  });
  it('uses the same receipt binding for funding', () => {
    expect(() => parseOkxFunding(wire(funding()), 'BTC', receipt('instrument'))).toThrow('invalid-public-timing');
  });
});
