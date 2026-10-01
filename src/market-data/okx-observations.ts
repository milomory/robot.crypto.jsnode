/** Bounded OKX public observations; fixtures prove schemas, not live API availability. */
import { decimal, multiply, record, timestamp } from './exact-json.js';
import { freeze, market, reject, type InstrumentSpec, type PublicReceipt, type ResearchBase } from './model.js';
import {
  assertBoundSpec, assertHistoryOrder, assertUncrossed, bookLevels, integerText, signedRate, sourceFresh, sourceTime,
  type FundingEvent, type FundingHistory, type MarketMetrics, type PerpetualBook,
} from './observation-model.js';

function rows(raw: unknown): unknown[] {
  const envelope = record(raw);
  if (envelope.code !== '0' || !Array.isArray(envelope.data)) return reject('invalid-okx-observation-envelope');
  return envelope.data;
}
function item(raw: unknown): Record<string, unknown> {
  const data = rows(raw);
  if (data.length !== 1) return reject('invalid-okx-observation-envelope');
  return record(data[0]);
}
function contractIdentity(row: Record<string, unknown>, base: ResearchBase): void {
  if (row.instId !== market('okx', base).instrumentId || row.instType !== 'SWAP') reject('unexpected-okx-observation-instrument');
}
function optionalRate(value: unknown): string | null {
  return value === undefined || value === null || value === '' ? null : signedRate(value);
}

export function parseOkxBook(raw: unknown, base: ResearchBase, receipt: PublicReceipt, spec: InstrumentSpec): PerpetualBook {
  assertBoundSpec(spec, {exchange:'okx',base,kind:'book'}, receipt);
  const row = item(raw), expected = market('okx', base);
  // REST books documents no instrument echo. A contradictory optional echo must still fail.
  if (row.instId !== undefined && row.instId !== expected.instrumentId || row.instType !== undefined && row.instType !== 'SWAP') {
    return reject('unexpected-okx-observation-instrument');
  }
  const bids = bookLevels(row.bids, 'bids', 4, spec), asks = bookLevels(row.asks, 'asks', 4, spec);
  assertUncrossed(bids, asks);
  const time = sourceTime(row.ts, 'book-generation', receipt, 5000);
  return freeze({schema:1,kind:'public-perpetual-book',market:expected,receipt:{...receipt},
    metadataReceivedAt:spec.receipt.receivedAt,identityBinding:'request',bids,asks,
    sequence:integerText(row.seqId),sourceTime:time,auxiliaryTimestamp:null,auxiliaryTimestampVerified:false,
    sourceFreshnessVerified:sourceFresh(time),executable:false});
}

export function parseOkxMetrics(raw: unknown, base: ResearchBase, receipt: PublicReceipt, spec: InstrumentSpec,
  component: 'mark' | 'index' | 'open-interest'): MarketMetrics {
  if (!['mark','index','open-interest'].includes(component)) return reject('unsupported-okx-metric');
  assertBoundSpec(spec, {exchange:'okx',base,kind:component}, receipt);
  const row = item(raw);
  if (component === 'index') {
    if (row.instId !== `${base}-USDT`) return reject('unexpected-okx-observation-instrument');
  } else contractIdentity(row, base);
  const time = sourceTime(row.ts, component === 'index' ? 'price-update' : 'response-time', receipt, 120000);
  const openInterestContracts = component === 'open-interest' ? decimal(row.oi) : null;
  const openInterestBase = openInterestContracts === null ? null : multiply(openInterestContracts, spec.basePerContract);
  const reportedOpenInterestBase = component === 'open-interest' ? decimal(row.oiCcy) : null;
  // Public docs identify units but promise no rounding equivalence for oiCcy. Preserve both values.
  // oiUsd is reported USD, deliberately not renamed or converted to USDT.
  return freeze({schema:1,kind:'public-market-metrics',component,market:market('okx',base),receipt:{...receipt},
    metadataReceivedAt:spec.receipt.receivedAt,identityBinding:'request-and-response',
    markPrice:component === 'mark' ? decimal(row.markPx,false,true) : null,
    indexPrice:component === 'index' ? decimal(row.idxPx,false,true) : null,
    openInterestContracts,openInterestBase,reportedOpenInterestBase,
    openInterestBaseConsistency:component === 'open-interest' ? openInterestBase === reportedOpenInterestBase ? 'matches' : 'differs' : null,
    openInterestUsd:component === 'open-interest' ? decimal(row.oiUsd) : null,
    sourceTime:time,sourceFreshnessVerified:sourceFresh(time),executable:false});
}

export function parseOkxHistory(raw: unknown, base: ResearchBase, receipt: PublicReceipt, spec: InstrumentSpec): FundingHistory {
  assertBoundSpec(spec, {exchange:'okx',base,kind:'history'}, receipt);
  const data = rows(raw);
  if (data.length > 20) return reject('invalid-history-count');
  const events: FundingEvent[] = data.map(value => {
    const row = record(value); contractIdentity(row, base);
    if (row.method !== 'current_period' && row.method !== 'next_period' || row.formulaType !== 'noRate' && row.formulaType !== 'withRate') {
      return reject('unsupported-okx-history-mechanism');
    }
    const settledRate = optionalRate(row.realizedRate);
    return {settlementAt:timestamp(row.fundingTime),forecastRate:optionalRate(row.fundingRate),settledRate,
      rateMeaning:settledRate === null ? 'unavailable' : 'exchange-realized-rate',reportedIntervalMs:null,
      method:row.method,formula:row.formulaType};
  });
  assertHistoryOrder(events, receipt);
  return freeze({schema:1,kind:'public-funding-history',market:market('okx',base),receipt:{...receipt},
    metadataReceivedAt:spec.receipt.receivedAt,identityBinding:'request-and-response',events,limit:20,
    // A short or full page proves neither an older-page cursor nor complete historical coverage.
    totalRecords:null,totalPages:null,hasMore:null,historyComplete:false,continuityVerified:false,
    realizedAccountIncome:null,executable:false});
}
