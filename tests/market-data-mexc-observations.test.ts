import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parsePublicJson, record } from '../src/market-data/exact-json.js';
import { parseMexcInstrument } from '../src/market-data/mexc.js';
import { parseMexcBook, parseMexcHistory, parseMexcTicker } from '../src/market-data/mexc-observations.js';
import { MarketDataError, publicUrl, type InstrumentSpec, type PublicReceipt, type ResearchBase } from '../src/market-data/model.js';
import { observationUrl, type ObservationRoute } from '../src/market-data/observation-model.js';

const at = 1_800_000_000_000;
const decode = (body: unknown) => parsePublicJson(Buffer.from(JSON.stringify(body)));
const wrap = (data: unknown) => decode({ success: true, code: 0, data });
const receipt = (kind: ObservationRoute, base: ResearchBase = 'BTC', now = at): PublicReceipt => ({
  url: observationUrl('mexc', base, kind), requestedAt: now - 100, receivedAt: now,
});
const spec = (base: ResearchBase = 'BTC', now = at): InstrumentSpec => parseMexcInstrument(wrap({
  symbol: `${base}_USDT`, baseCoin: base, quoteCoin: 'USDT', settleCoin: 'USDT', futureType: 1, type: 1,
  contractSize: base === 'BTC' ? '0.0001' : '0.01', priceUnit: base === 'BTC' ? '0.1' : '0.01',
  volUnit: 1, minVol: 1, state: 0, apiAllowed: true, preMarket: false, automaticDelivery: 0,
}), base, { url: publicUrl('mexc', base, 'instrument'), requestedAt: now - 1100, receivedAt: now - 1000 });
const bookData = () => ({ bids: [[100, 3, 2], [99.9, 4, 1]], asks: [[100.1, 5, 1], [100.2, 6, 3]],
  timestamp: at - 150, version: '9007199254740993', cts: null });
const tickerData = (base: ResearchBase = 'BTC') => ({ symbol: `${base}_USDT`, fairPrice: 100.1,
  indexPrice: 100.2, holdVol: '9007199254740993', timestamp: at - 150 });
const event = (patch: Record<string, unknown> = {}) => ({ symbol: 'BTC_USDT', fundingRate: '0.000049',
  settleTime: at - 1000, collectCycle: 8, ...patch });
const historyData = (patch: Record<string, unknown> = {}) => ({ pageSize: 20, currentPage: 1,
  totalCount: 2, totalPage: 1, resultList: [event(), event({ settleTime: at - 3_601_000, fundingRate: '-0.00001', collectCycle: 1 })], ...patch });

describe('MEXC perpetual book observations', () => {
  it.each(['BTC', 'ETH'] as const)('keeps %s contracts and exact base amounts separate', base => {
    const result = parseMexcBook(wrap(bookData()), base, receipt('book', base), spec(base));
    expect(result).toMatchObject({ kind: 'public-perpetual-book', identityBinding: 'request', sequence: '9007199254740993',
      metadataReceivedAt: at - 1000, executable: false, sourceFreshnessVerified: false,
      auxiliaryTimestamp: null, auxiliaryTimestampVerified: false,
      sourceTime: { meaning: 'exchange-system', at: at - 150, ageMs: 150, ageStatus: 'within-window', representsUpdate: false } });
    expect(result.bids[0]).toEqual({ price: '100', quantityContracts: '3', quantityBase: base === 'BTC' ? '0.0003' : '0.03', orderCount: '2' });
  });
  it('verifies an optional response symbol and otherwise keeps request-only identity', () => {
    expect(parseMexcBook(wrap({ ...bookData(), symbol: 'BTC_USDT' }), 'BTC', receipt('book'), spec()).identityBinding).toBe('request-and-response');
    expect(() => parseMexcBook(wrap({ ...bookData(), symbol: 'ETH_USDT' }), 'BTC', receipt('book'), spec())).toThrow('unsupported-public-contract');
  });
  it('preserves large numeric JSON token quantities and versions exactly', () => {
    const raw = JSON.stringify({ success: true, code: 0, data: bookData() })
      .replace('"9007199254740993"', '9007199254740993').replace('[100,3,2]', '[100,9007199254740993,2]');
    const result = parseMexcBook(parsePublicJson(Buffer.from(raw)), 'BTC', receipt('book'), spec());
    expect(result.sequence).toBe('9007199254740993'); expect(result.bids[0].quantityBase).toBe('900719925474.0993');
  });
  it.each([
    { timestamp: undefined, status: 'missing' }, { timestamp: null, status: 'missing' }, { timestamp: '', status: 'missing' },
    { timestamp: at - 5000, status: 'within-window' }, { timestamp: at - 5001, status: 'stale' },
    { timestamp: at + 5000, status: 'within-window' }, { timestamp: at + 5001, status: 'future' },
  ])('retains $status timing as diagnostic evidence without granting freshness', ({ timestamp, status }) => {
    const result = parseMexcBook(wrap({ ...bookData(), timestamp }), 'BTC', receipt('book'), spec());
    expect(result.sourceTime.ageStatus).toBe(status); expect(result.sourceFreshnessVerified).toBe(false); expect(result.executable).toBe(false);
  });
  it.each([undefined, null, at - 200])('never promotes auxiliary REST cts into a verified update time: %s', cts => {
    const result = parseMexcBook(wrap({ ...bookData(), cts }), 'BTC', receipt('book'), spec());
    expect(result.auxiliaryTimestamp).toBe(cts ?? null); expect(result.auxiliaryTimestampVerified).toBe(false);
    expect(result.sourceTime.meaning).toBe('exchange-system');
  });
  it.each([
    { bids: [] }, { asks: [] }, { bids: null }, { asks: {} }, { bids: [[100, 0, 1]] }, { asks: [[100.1, -1, 1]] },
    { bids: [[100, 1.5, 1]] }, { bids: [[100.01, 1, 1]] }, { asks: [[100.1, 1, 1.5]] }, { bids: [[100, 1, -1]] },
    { bids: [[100, 1]] }, { bids: [[100, 1, 0, 1]] }, { bids: [[100, 1, 1], [100, 2, 1]] },
    { bids: [[99.9, 1, 1], [100, 2, 1]] }, { asks: [[100.2, 1, 1], [100.1, 2, 1]] },
    { asks: [[100, 1, 1]] }, { asks: [[99.9, 1, 1]] }, { version: undefined }, { version: '-1' }, { version: '1e3' },
    { version: '1.5' }, { version: '01' }, { cts: '' }, { cts: 'invalid' }, { timestamp: -1 }, { timestamp: 'NaN' },
    { symbol: null }, { bids: Array.from({ length: 51 }, (_, n) => [100 - n, 1, 1]) },
  ])('rejects malformed levels, chronology or version: %j', patch => {
    expect(() => parseMexcBook(wrap({ ...bookData(), ...patch }), 'BTC', receipt('book'), spec())).toThrow(MarketDataError);
  });
  it('accepts exactly 50 levels without silently truncating them', () => {
    const bids = Array.from({ length: 50 }, (_, n) => [100 - n, 1, 1]);
    expect(parseMexcBook(wrap({ ...bookData(), bids }), 'BTC', receipt('book'), spec()).bids).toHaveLength(50);
  });
  it('rejects native Number quantities that bypass exact JSON decoding', () => {
    const raw = wrap(bookData()); (record(record(raw).data).bids as unknown[][])[0][1] = 3;
    expect(() => parseMexcBook(raw, 'BTC', receipt('book'), spec())).toThrow('invalid-public-number');
  });
  it('copies receipts and deeply freezes levels, market and source timing', () => {
    const r = receipt('book'); const result = parseMexcBook(wrap(bookData()), 'BTC', r, spec());
    r.receivedAt += 1;
    expect(result.receipt.receivedAt).toBe(at);
    for (const value of [result, result.receipt, result.market, result.bids, result.bids[0], result.sourceTime]) expect(Object.isFrozen(value)).toBe(true);
  });
});

describe('MEXC ticker mark/index/open interest', () => {
  it.each(['BTC', 'ETH'] as const)('decodes %s OI contracts exactly without inventing dollar notional', base => {
    const result = parseMexcTicker(wrap(tickerData(base)), base, receipt('ticker', base), spec(base));
    expect(result).toMatchObject({ identityBinding: 'request-and-response', component: 'ticker', markPrice: '100.1', indexPrice: '100.2',
      openInterestContracts: '9007199254740993', openInterestBase: base === 'BTC' ? '900719925474.0993' : '90071992547409.93',
      reportedOpenInterestBase: null, openInterestBaseConsistency: 'not-reported', openInterestUsd: null, executable: false, sourceFreshnessVerified: false,
      sourceTime: { meaning: 'trade', ageMs: 150, ageStatus: 'within-window', representsUpdate: false } });
  });
  it('distinguishes reported zero open interest from absent data', () => {
    const result = parseMexcTicker(wrap({ ...tickerData(), holdVol: 0 }), 'BTC', receipt('ticker'), spec());
    expect(result.openInterestContracts).toBe('0'); expect(result.openInterestBase).toBe('0');
  });
  it('accepts a fractional reported OI without rounding contracts to a lot', () => {
    const result = parseMexcTicker(wrap({ ...tickerData(), holdVol: '0.12345678901234567890123456' }), 'BTC', receipt('ticker'), spec());
    expect(result.openInterestBase).toBe('0.000012345678901234567890123456');
  });
  it.each([
    { timestamp: undefined, status: 'missing' }, { timestamp: null, status: 'missing' },
    { timestamp: at - 120000, status: 'within-window' }, { timestamp: at - 120001, status: 'stale' },
    { timestamp: at + 5001, status: 'future' },
  ])('marks ticker trade time $status without claiming metric update freshness', ({ timestamp, status }) => {
    const result = parseMexcTicker(wrap({ ...tickerData(), timestamp }), 'BTC', receipt('ticker'), spec());
    expect(result.sourceTime.ageStatus).toBe(status); expect(result.sourceFreshnessVerified).toBe(false);
  });
  it.each([
    { symbol: undefined }, { symbol: 'ETH_USDT' }, { holdVol: undefined }, { holdVol: '-1' }, { holdVol: 'NaN' },
    { holdVol: '1e-30' }, { fairPrice: undefined }, { fairPrice: 0 }, { fairPrice: '-1' },
    { indexPrice: undefined }, { indexPrice: 0 }, { indexPrice: 'Infinity' }, { timestamp: '0' },
  ])('rejects missing identity, price or exact OI fields: %j', patch => {
    expect(() => parseMexcTicker(wrap({ ...tickerData(), ...patch }), 'BTC', receipt('ticker'), spec())).toThrow(MarketDataError);
  });
  it('does not read ticker funding or fee-like fields as account income or fees', () => {
    const result = parseMexcTicker(wrap({ ...tickerData(), fundingRate: 1, makerFeeRate: 0 }), 'BTC', receipt('ticker'), spec());
    expect(result).not.toHaveProperty('fundingRate'); expect(result).not.toHaveProperty('makerFeeRate');
  });
});

describe('MEXC funding history remains public, bounded and incomplete', () => {
  it('keeps per-event dynamic cycles and signed historical rates, not forecast or account income', () => {
    const result = parseMexcHistory(wrap(historyData()), 'BTC', receipt('history'), spec());
    expect(result).toMatchObject({ identityBinding: 'request-and-response', limit: 20, totalRecords: 2, totalPages: 1,
      hasMore: false, historyComplete: false, continuityVerified: false, realizedAccountIncome: null, executable: false });
    expect(result.events).toEqual([
      { settlementAt: at - 1000, forecastRate: null, settledRate: '0.000049', rateMeaning: 'reported-settlement-rate', reportedIntervalMs: 28_800_000, method: null, formula: null },
      { settlementAt: at - 3_601_000, forecastRate: null, settledRate: '-0.00001', rateMeaning: 'reported-settlement-rate', reportedIntervalMs: 3_600_000, method: null, formula: null },
    ]);
  });
  it('supports a matching ETH history', () => {
    const data = historyData({ totalCount: 1, resultList: [event({ symbol: 'ETH_USDT' })] });
    expect(parseMexcHistory(wrap(data), 'ETH', receipt('history', 'ETH'), spec('ETH')).market.base).toBe('ETH');
  });
  it('preserves exact numeric funding-rate JSON lexemes', () => {
    const body = JSON.stringify({ success: true, code: 0, data: historyData() })
      .replace('"0.000049"', '-0.000123456789012345678901234567');
    expect(parseMexcHistory(parsePublicJson(Buffer.from(body)), 'BTC', receipt('history'), spec()).events[0].settledRate)
      .toBe('-0.000123456789012345678901234567');
  });
  it('records exactly one bounded page and never declares full history even if totalCount <= 20', () => {
    const rows = Array.from({ length: 20 }, (_, i) => event({ settleTime: at - 1000 - i * 3_600_000 }));
    const result = parseMexcHistory(wrap(historyData({ totalCount: 21, totalPage: 2, resultList: rows })), 'BTC', receipt('history'), spec());
    expect(result.events).toHaveLength(20); expect(result.hasMore).toBe(true); expect(result.historyComplete).toBe(false);
  });
  it('distinguishes an empty first page from zero rates or proven complete history', () => {
    const result = parseMexcHistory(wrap(historyData({ totalCount: 0, totalPage: 0, resultList: [] })), 'BTC', receipt('history'), spec());
    expect(result.events).toEqual([]); expect(result.identityBinding).toBe('request'); expect(result.hasMore).toBe(false);
    expect(result.historyComplete).toBe(false); expect(result.realizedAccountIncome).toBeNull();
  });
  it.each([1, 2, 4, 8, 24])('keeps the explicitly reported %sh event interval', collectCycle => {
    const result = parseMexcHistory(wrap(historyData({ totalCount: 1, resultList: [event({ collectCycle })] })), 'BTC', receipt('history'), spec());
    expect(result.events[0].reportedIntervalMs).toBe(collectCycle * 3_600_000);
  });
  it.each(['-1', '0', '1'])('preserves boundary funding rates: %s', fundingRate => {
    const result = parseMexcHistory(wrap(historyData({ totalCount: 1, resultList: [event({ fundingRate })] })), 'BTC', receipt('history'), spec());
    expect(result.events[0].settledRate).toBe(fundingRate);
  });
  it.each([
    { pageSize: 19 }, { pageSize: 21 }, { pageSize: undefined }, { currentPage: 0 }, { currentPage: 2 },
    { totalCount: -1 }, { totalCount: '9007199254740993' }, { totalCount: 0 }, { totalCount: 3 },
    { totalPage: 2 }, { totalPage: 0 }, { totalPage: undefined }, { resultList: undefined }, { resultList: null },
    { resultList: [event(), event()] },
    { resultList: [event(), event({ fundingRate: '-0.1' })] },
    { resultList: [event({ settleTime: at - 5000 }), event({ settleTime: at - 1000 })] },
    { totalCount: 21, totalPage: 2, resultList: Array.from({ length: 21 }, (_, n) => event({ settleTime: at - 1000 - n })) },
  ])('rejects inconsistent page counts, excessive rows, duplicates and conflicting settlements: %j', patch => {
    expect(() => parseMexcHistory(wrap(historyData(patch)), 'BTC', receipt('history'), spec())).toThrow(MarketDataError);
  });
  it.each([
    { symbol: 'ETH_USDT' }, { symbol: undefined }, { settleTime: at }, { settleTime: at - 100 },
    { settleTime: at + 1 }, { settleTime: null }, { fundingRate: undefined }, { fundingRate: '1.00000001' },
    { fundingRate: '-1.00000001' }, { fundingRate: 'NaN' }, { collectCycle: undefined }, { collectCycle: 0 },
    { collectCycle: 25 }, { collectCycle: 1.5 }, { collectCycle: '01' },
  ])('rejects an invalid event instead of omitting or replacing it: %j', patch => {
    expect(() => parseMexcHistory(wrap(historyData({ totalCount: 1, resultList: [event(patch)] })), 'BTC', receipt('history'), spec()))
      .toThrow(MarketDataError);
  });
  it('deep freezes event records and copies receipt', () => {
    const r = receipt('history'); const result = parseMexcHistory(wrap(historyData()), 'BTC', r, spec());
    r.receivedAt += 1; expect(result.receipt.receivedAt).toBe(at);
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.events)).toBe(true); expect(Object.isFrozen(result.events[0])).toBe(true);
  });
});

const cases = [
  { kind: 'book', parser: parseMexcBook, data: bookData },
  { kind: 'ticker', parser: parseMexcTicker, data: tickerData },
  { kind: 'history', parser: parseMexcHistory, data: historyData },
] as const;
describe.each(cases)('MEXC $kind endpoint and metadata binding', ({ kind, parser, data }) => {
  it.each([
    { baseQuantityStep: '1' }, { baseMinimumQuantity: '1' }, { priceTick: '0' }, { contractMultiplier: '2' },
    { quantityUnit: 'base' }, { basePerContract: 'NaN' },
  ])('rejects forged or internally inconsistent metadata: %j', patch => {
    expect(() => parser(wrap(data()), 'BTC', receipt(kind), { ...spec(), ...patch } as InstrumentSpec)).toThrow(MarketDataError);
  });
  it('rejects other market metadata or metadata from the future', () => {
    expect(() => parser(wrap(data()), 'BTC', receipt(kind), spec('ETH'))).toThrow('observation-spec-mismatch');
    expect(() => parser(wrap(data()), 'BTC', receipt(kind), spec('BTC', at + 1000))).toThrow('observation-spec-mismatch');
  });
  it('accepts the metadata age boundary and rejects the next millisecond', () => {
    const r = receipt(kind);
    expect(() => parser(wrap(data()), 'BTC', r, spec('BTC', r.requestedAt - 1_200_000 + 1000))).not.toThrow();
    expect(() => parser(wrap(data()), 'BTC', r, spec('BTC', r.requestedAt - 1_200_001 + 1000))).toThrow('observation-spec-mismatch');
  });
  it('rejects wrong origin, query, credentials, receipt extras and latency overflow', () => {
    const r = receipt(kind);
    for (const bad of [
      { ...r, url: r.url.replace('api.mexc.com', 'contract.mexc.com') }, { ...r, url: r.url + '&extra=1' },
      { ...r, url: r.url.replace('https://', 'https://user:pass@') }, { ...r, header: 'extra' },
      { ...r, requestedAt: at + 1 }, { ...r, requestedAt: at - (kind === 'book' ? 3001 : 5001) },
    ]) expect(() => parser(wrap(data()), 'BTC', bad, spec())).toThrow(MarketDataError);
  });
  it.each([{ success: false, code: 0 }, { success: true, code: 403 }, { success: true, code: 0, data: [] }])(
    'does not reflect server text on invalid response envelopes: %j', patch => {
      try { parser(decode({ data: data(), ...patch, message: 'UNTRUSTED_SERVER_MESSAGE' }), 'BTC', receipt(kind), spec()); expect.fail('must reject'); }
      catch (error) { expect(error).toBeInstanceOf(MarketDataError); expect(String(error)).not.toContain('UNTRUSTED_SERVER_MESSAGE'); }
    });
});

describe('MEXC real public response fixture', () => {
  const fixture = JSON.parse(readFileSync(new URL('../fixtures/market-data/mexc-d0b-public-20261001.json', import.meta.url), 'utf8')) as {
    metadataCaptured: boolean; captureAcceptance: boolean; observations: { kind: 'book' | 'ticker' | 'history'; receipt: PublicReceipt; raw: string }[];
  };
  it('replays actual bodies with explicitly synthetic matching metadata; does not call this accepted capture', () => {
    expect(fixture.metadataCaptured).toBe(false); expect(fixture.captureAcceptance).toBe(false);
    for (const observation of fixture.observations) {
      const synthetic = spec('BTC', observation.receipt.receivedAt);
      const raw = parsePublicJson(Buffer.from(observation.raw));
      if (observation.kind === 'book') {
        const result = parseMexcBook(raw, 'BTC', observation.receipt, synthetic);
        expect(result.bids).toHaveLength(50); expect(result.asks).toHaveLength(50); expect(result.sourceFreshnessVerified).toBe(false);
      } else if (observation.kind === 'ticker') {
        const result = parseMexcTicker(raw, 'BTC', observation.receipt, synthetic);
        expect(result.openInterestContracts).toBe('523813146'); expect(result.openInterestBase).toBe('52381.3146');
        expect(result.sourceTime.meaning).toBe('trade'); expect(result.sourceFreshnessVerified).toBe(false);
      } else {
        const result = parseMexcHistory(raw, 'BTC', observation.receipt, synthetic);
        expect(result.events).toHaveLength(20); expect(result.totalRecords).toBe(1620); expect(result.hasMore).toBe(true);
        expect(result.events[0].settledRate).toBe('0.000046'); expect(result.realizedAccountIncome).toBeNull();
      }
    }
  });
  it('rejects genuinely old D0 metadata instead of silently refreshing its receipt to match the new fixture', () => {
    const oldFixture = JSON.parse(readFileSync(new URL('../fixtures/market-data/d0-public-20261001.json', import.meta.url), 'utf8'));
    const oldInstrument = oldFixture.report.observations[0] as { raw: string; receipt: PublicReceipt };
    const oldSpec = parseMexcInstrument(parsePublicJson(Buffer.from(oldInstrument.raw)), 'BTC', oldInstrument.receipt);
    for (const observation of fixture.observations) {
      const parser = observation.kind === 'book' ? parseMexcBook : observation.kind === 'ticker' ? parseMexcTicker : parseMexcHistory;
      expect(() => parser(parsePublicJson(Buffer.from(observation.raw)), 'BTC', observation.receipt, oldSpec)).toThrow('observation-spec-mismatch');
    }
  });
});
