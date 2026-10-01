/** Bounded MEXC public observations; none grants account or execution authority. */
import { decimal, multiply, numberText, record, timestamp } from './exact-json.js';
import { freeze, market, reject, type InstrumentSpec, type PublicReceipt, type ResearchBase } from './model.js';
import {
  assertBoundSpec, assertHistoryOrder, assertUncrossed, bookLevels, historyCount, integerText, signedRate, sourceTime,
  type FundingHistory, type MarketMetrics, type PerpetualBook,
} from './observation-model.js';

function envelope(raw: unknown): Record<string, unknown> {
  const root = record(raw);
  if (root.success !== true || numberText(root.code) !== '0') return reject('invalid-public-response');
  return record(root.data);
}
function binding(base: ResearchBase, receipt: PublicReceipt, spec: InstrumentSpec) {
  return { schema: 1 as const, market: market('mexc', base), receipt: { ...receipt },
    metadataReceivedAt: spec.receipt.receivedAt, executable: false as const };
}

export function parseMexcBook(raw: unknown, base: ResearchBase, receipt: PublicReceipt, spec: InstrumentSpec): PerpetualBook {
  assertBoundSpec(spec, { exchange: 'mexc', base, kind: 'book' }, receipt);
  const row = envelope(raw), m = market('mexc', base);
  if (row.symbol !== undefined && row.symbol !== m.instrumentId) return reject('unsupported-public-contract');
  const bids = bookLevels(row.bids, 'bids', 3, spec), asks = bookLevels(row.asks, 'asks', 3, spec);
  assertUncrossed(bids, asks);
  // REST documents system time, not book-generation time. WS cts semantics do not transfer to REST.
  const time = sourceTime(row.timestamp, 'exchange-system', receipt, 5000);
  return freeze({ ...binding(base, receipt, spec), kind: 'public-perpetual-book',
    identityBinding: row.symbol === undefined ? 'request' : 'request-and-response',
    bids, asks, sequence: integerText(row.version), sourceTime: time,
    auxiliaryTimestamp: row.cts === undefined || row.cts === null ? null : timestamp(row.cts),
    auxiliaryTimestampVerified: false, sourceFreshnessVerified: false });
}

export function parseMexcTicker(raw: unknown, base: ResearchBase, receipt: PublicReceipt, spec: InstrumentSpec): MarketMetrics {
  assertBoundSpec(spec, { exchange: 'mexc', base, kind: 'ticker' }, receipt);
  const row = envelope(raw);
  if (row.symbol !== market('mexc', base).instrumentId) return reject('unsupported-public-contract');
  const openInterestContracts = decimal(row.holdVol);
  return freeze({ ...binding(base, receipt, spec), kind: 'public-market-metrics', component: 'ticker',
    identityBinding: 'request-and-response', markPrice: decimal(row.fairPrice, false, true),
    indexPrice: decimal(row.indexPrice, false, true), openInterestContracts,
    openInterestBase: multiply(openInterestContracts, spec.basePerContract), reportedOpenInterestBase: null,
    openInterestBaseConsistency: 'not-reported', openInterestUsd: null,
    // Ticker time is documented as trade time. It does not establish when all metrics updated.
    sourceTime: sourceTime(row.timestamp, 'trade', receipt, 120_000), sourceFreshnessVerified: false });
}

export function parseMexcHistory(raw: unknown, base: ResearchBase, receipt: PublicReceipt, spec: InstrumentSpec): FundingHistory {
  assertBoundSpec(spec, { exchange: 'mexc', base, kind: 'history' }, receipt);
  const row = envelope(raw), m = market('mexc', base);
  const pageSize = historyCount(row.pageSize), totalRecords = historyCount(row.totalCount);
  const totalPages = historyCount(row.totalPage), currentPage = historyCount(row.currentPage);
  if (pageSize !== 20 || currentPage !== 1 || totalPages !== Math.ceil(totalRecords / pageSize) ||
      !Array.isArray(row.resultList) || row.resultList.length !== Math.min(totalRecords, pageSize)) return reject('invalid-history-count');
  const events = row.resultList.map(value => {
    const event = record(value);
    if (event.symbol !== m.instrumentId) return reject('unsupported-public-contract');
    const cycle = historyCount(event.collectCycle);
    if (cycle < 1 || cycle > 24) return reject('unsupported-funding-cycle');
    return { settlementAt: timestamp(event.settleTime), forecastRate: null, settledRate: signedRate(event.fundingRate),
      rateMeaning: 'reported-settlement-rate' as const, reportedIntervalMs: cycle * 3_600_000, method: null, formula: null };
  });
  assertHistoryOrder(events, receipt);
  return freeze({ ...binding(base, receipt, spec), kind: 'public-funding-history',
    identityBinding: events.length === 0 ? 'request' : 'request-and-response', events, limit: 20,
    totalRecords, totalPages, hasMore: totalPages > 1, historyComplete: false, continuityVerified: false,
    realizedAccountIncome: null });
}
