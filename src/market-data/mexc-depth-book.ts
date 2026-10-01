/** Pure bounded reconstruction. A verified top 50 is never the entire exchange book. */
import { isDeepStrictEqual } from 'node:util';
import { decimal, multiply, numberText, record, timestamp, units } from './exact-json.js';
import { freeze, market, reject, type InstrumentSpec, type PublicReceipt, type ResearchBase, type ResearchMarket } from './model.js';
import { assertBoundSpec, assertUncrossed, integerText, observationUrl, sourceTime, type BookLevel, type SourceTime } from './observation-model.js';
import { MexcDepthStreamEvidence, MEXC_DEPTH_STREAM_LIMITS, STREAM_FAILURES, type MexcDepthStreamDelta } from './mexc-depth-stream.js';

export const MEXC_DEPTH_BOOK_LIMITS = Object.freeze({ bootstrapLevels: 1000, verifiedLevels: 50,
  maximumKnownLevelsPerSide: 10_000, metadataAgeMs: 1_200_000 });
export const DEPTH_BOOK_FAILURES: readonly string[] = Object.freeze([...new Set([...STREAM_FAILURES,
  'unsupported-market', 'invalid-public-response', 'unsupported-public-contract', 'invalid-public-timing',
  'invalid-observation-receipt', 'observation-spec-mismatch', 'public-product-precision', 'crossed-public-book',
  'invalid-depth-bootstrap', 'invalid-depth-bootstrap-receipt', 'depth-book-already-rejected',
  'depth-book-version-discontinuity', 'depth-book-invalid-delta', 'depth-book-source-time-unverified',
  'depth-book-source-time-regression', 'depth-book-invalid-evaluation', 'depth-book-no-update',
  'depth-book-range-exhausted', 'depth-book-capacity-exceeded', 'depth-book-stale-metadata',
])]);

export interface MexcDepthBootstrap {
  schema: 1; kind: 'mexc-depth-bootstrap'; market: ResearchMarket; receipt: PublicReceipt;
  metadataReceivedAt: number; identityBinding: 'request' | 'request-and-response';
  bids: readonly BookLevel[]; asks: readonly BookLevel[]; version: string;
  knownRange: { bidFloor: string; askCeiling: string };
  sourceTime: SourceTime; auxiliaryTimestamp: number | null; auxiliaryTimestampVerified: false;
  sourceFreshnessVerified: false; bookReconstructed: false; executable: false;
}
export interface MexcReconstructedBook {
  schema: 1; kind: 'mexc-reconstructed-top50'; market: ResearchMarket;
  bootstrapReceipt: PublicReceipt; metadataReceivedAt: number; evaluatedAt: number; receivedAt: number;
  bootstrapVersion: string; version: string; appliedUpdates: number;
  bids: readonly BookLevel[]; asks: readonly BookLevel[];
  knownRange: { bidFloor: string; askCeiling: string }; knownLevels: { bids: number; asks: number };
  sourceTime: { at: number; meaning: 'matching-engine-book-production'; ageMs: number; representsUpdate: true };
  verifiedDepth: 50; entireBookKnown: false; bookReconstructed: true; bookFreshnessVerified: true;
  sourceFreshnessVerified: true; executable: false;
}
export function mexcDepthBootstrapUrl(base: ResearchBase): string {
  return `https://api.mexc.com/api/v1/contract/depth/${market('mexc', base).instrumentId}?limit=1000`;
}
function boundSpec(spec: InstrumentSpec, base: ResearchBase, receipt: PublicReceipt): void {
  if (!receipt || Object.keys(receipt).sort().join(',') !== 'receivedAt,requestedAt,url' ||
      receipt.url !== mexcDepthBootstrapUrl(base)) return reject('invalid-depth-bootstrap-receipt');
  // Reuse the same market/grid/age/timing checks; only this fixed bootstrap URL differs.
  assertBoundSpec(spec, { exchange: 'mexc', base, kind: 'book' },
    { ...receipt, url: observationUrl('mexc', base, 'book') });
  for (const name of ['basePerContract', 'quantityStepContracts', 'minimumContracts', 'priceTick'] as const) {
    if (decimal(spec[name], false, true) !== spec[name]) return reject('observation-spec-mismatch');
  }
}
function levels(rows: unknown, side: 'bids' | 'asks', spec: InstrumentSpec): readonly BookLevel[] {
  if (!Array.isArray(rows) || rows.length < 50 || rows.length > 1000) return reject('invalid-depth-bootstrap');
  let previous: bigint | null = null;
  return rows.map(row => {
    if (!Array.isArray(row) || row.length !== 3) return reject('invalid-depth-bootstrap');
    const price = decimal(row[0], false, true), quantityContracts = decimal(row[1], false, true), p = units(price);
    if (p % units(spec.priceTick) || units(quantityContracts) % units(spec.quantityStepContracts) ||
        previous !== null && (side === 'bids' ? p >= previous : p <= previous)) return reject('invalid-depth-bootstrap');
    previous = p;
    return { price, quantityContracts, quantityBase: multiply(quantityContracts, spec.basePerContract), orderCount: integerText(row[2]) };
  });
}
/** raw must come from parsePublicJson; native Number amounts are deliberately rejected. */
export function parseMexcDepthBootstrap(raw: unknown, base: ResearchBase, receipt: PublicReceipt, spec: InstrumentSpec): MexcDepthBootstrap {
  boundSpec(spec, base, receipt);
  const root = record(raw);
  if (root.success !== true || numberText(root.code) !== '0') return reject('invalid-public-response');
  const row = record(root.data), m = market('mexc', base);
  if (row.symbol !== undefined && row.symbol !== m.instrumentId) return reject('unsupported-public-contract');
  const bids = levels(row.bids, 'bids', spec), asks = levels(row.asks, 'asks', spec);
  assertUncrossed(bids, asks);
  return freeze({ schema: 1, kind: 'mexc-depth-bootstrap', market: m, receipt: { ...receipt },
    metadataReceivedAt: spec.receipt.receivedAt, identityBinding: row.symbol === undefined ? 'request' : 'request-and-response',
    bids, asks, version: integerText(row.version), knownRange: { bidFloor: bids[bids.length - 1].price, askCeiling: asks[asks.length - 1].price },
    sourceTime: sourceTime(row.timestamp, 'exchange-system', receipt, 5000),
    auxiliaryTimestamp: row.cts === undefined || row.cts === null ? null : timestamp(row.cts), auxiliaryTimestampVerified: false,
    sourceFreshnessVerified: false, bookReconstructed: false, executable: false });
}
function validTime(at: number): boolean { return Number.isSafeInteger(at) && at > 0 && at <= 8_640_000_000_000_000; }
function sorted(rows: Map<string, BookLevel>, side: 'bids' | 'asks'): BookLevel[] {
  return [...rows.values()].sort((a, b) => units(a.price) === units(b.price) ? 0 :
    (units(a.price) < units(b.price) ? -1 : 1) * (side === 'bids' ? -1 : 1));
}

/** Any invalid input/evaluation permanently rejects this instance; no implicit rebootstrap. */
export class MexcDepthBook {
  readonly #spec: InstrumentSpec;
  readonly #bootstrap: MexcDepthBootstrap;
  readonly #bids: Map<string, BookLevel>;
  readonly #asks: Map<string, BookLevel>;
  #version: string;
  #updates = 0;
  #lastObservedVersion: string | null = null;
  #lastReceivedAt: number | null = null;
  #lastSourceAt: number | null = null;
  #lastEvaluationAt: number | null = null;
  #rejected = false;

  constructor(spec: InstrumentSpec, snapshot: MexcDepthBootstrap) {
    if (!snapshot || !snapshot.market || !Array.isArray(snapshot.bids) || !Array.isArray(snapshot.asks)) reject('invalid-depth-bootstrap');
    // Revalidate the normalized boundary, including its flags and derived quantities.
    const canonical = parseMexcDepthBootstrap({ success: true, code: '0', data: {
      ...(snapshot.identityBinding === 'request-and-response' ? { symbol: snapshot.market.instrumentId } : {}),
      bids: snapshot.bids.map(x => { const row = record(x); return [row.price, row.quantityContracts, row.orderCount]; }),
      asks: snapshot.asks.map(x => { const row = record(x); return [row.price, row.quantityContracts, row.orderCount]; }), version: snapshot.version,
      timestamp: snapshot.sourceTime?.at === null ? null : String(snapshot.sourceTime?.at),
      cts: snapshot.auxiliaryTimestamp === null ? null : String(snapshot.auxiliaryTimestamp),
    } }, snapshot.market.base, snapshot.receipt, spec);
    if (!isDeepStrictEqual(canonical, snapshot)) reject('invalid-depth-bootstrap');
    this.#spec = freeze(structuredClone(spec)); this.#bootstrap = canonical;
    this.#bids = new Map(canonical.bids.map(x => [x.price, x])); this.#asks = new Map(canonical.asks.map(x => [x.price, x]));
    this.#version = canonical.version;
  }

  /** Old buffered versions are covered by the bootstrap and skipped only before the first update. */
  apply(delta: MexcDepthStreamDelta): boolean {
    if (this.#rejected) return reject('depth-book-already-rejected');
    try {
      if (!delta || delta.kind !== 'delta' || !Array.isArray(delta.bids) || !Array.isArray(delta.asks)) return reject('depth-book-invalid-delta');
      const parsed = new MexcDepthStreamEvidence(this.#bootstrap.market.base).accept(JSON.stringify({
        channel: delta.channel, symbol: delta.symbol, ts: delta.exchangeTimestamp === null ? null : String(delta.exchangeTimestamp),
        data: { version: delta.version, cts: delta.sourceTime?.at === null ? null : String(delta.sourceTime?.at),
          bids: delta.bids.map(x => { const row = record(x); return [row.price, row.quantityContracts, row.orderCount]; }),
          asks: delta.asks.map(x => { const row = record(x); return [row.price, row.quantityContracts, row.orderCount]; }) },
      }), delta.receivedAt) as MexcDepthStreamDelta;
      if (delta.previousVersion !== null && BigInt(integerText(delta.previousVersion)) + 1n !== BigInt(parsed.version)) return reject('depth-book-version-discontinuity');
      if (!isDeepStrictEqual({ ...parsed, previousVersion: delta.previousVersion }, delta)) return reject('depth-book-invalid-delta');
      if (this.#lastObservedVersion !== null && (BigInt(delta.version) !== BigInt(this.#lastObservedVersion) + 1n ||
          delta.previousVersion !== null && delta.previousVersion !== this.#lastObservedVersion)) return reject('depth-book-version-discontinuity');
      if (this.#lastReceivedAt !== null && delta.receivedAt < this.#lastReceivedAt ||
          this.#lastEvaluationAt !== null && delta.receivedAt < this.#lastEvaluationAt) return reject('depth-book-invalid-delta');
      if (!delta.sourceTimeFresh || delta.sourceTime.at === null) return reject('depth-book-source-time-unverified');
      if (this.#lastSourceAt !== null && delta.sourceTime.at < this.#lastSourceAt) return reject('depth-book-source-time-regression');
      this.#lastReceivedAt = delta.receivedAt; this.#lastSourceAt = delta.sourceTime.at; this.#lastObservedVersion = delta.version;
      if (this.#updates === 0 && BigInt(delta.version) <= BigInt(this.#bootstrap.version)) return false;
      if (BigInt(delta.version) !== BigInt(this.#version) + 1n) return reject('depth-book-version-discontinuity');
      if (delta.receivedAt < this.#spec.receipt.receivedAt || delta.receivedAt - this.#spec.receipt.receivedAt > 1_200_000) return reject('depth-book-stale-metadata');
      // Apply both sides atomically before testing the spread; a frame may move/delete the old best.
      const bids = new Map(this.#bids), asks = new Map(this.#asks);
      for (const side of ['bids', 'asks'] as const) {
        const map = side === 'bids' ? bids : asks;
        for (const row of delta[side]) {
          if (units(row.price) % units(this.#spec.priceTick) || units(row.quantityContracts) % units(this.#spec.quantityStepContracts)) return reject('depth-book-invalid-delta');
          const outside = side === 'bids' ? units(row.price) < units(this.#bootstrap.knownRange.bidFloor) : units(row.price) > units(this.#bootstrap.knownRange.askCeiling);
          if (outside) continue; // Unseen deeper levels are unknown, never inferred absent or used to refill top 50.
          if (row.action === 'delete') map.delete(row.price);
          else map.set(row.price, { price: row.price, quantityContracts: row.quantityContracts,
            quantityBase: multiply(row.quantityContracts, this.#spec.basePerContract), orderCount: row.orderCount });
        }
        if (map.size > MEXC_DEPTH_BOOK_LIMITS.maximumKnownLevelsPerSide) return reject('depth-book-capacity-exceeded');
      }
      this.#assertDepth(bids, asks);
      this.#bids.clear(); bids.forEach((v, k) => this.#bids.set(k, v));
      this.#asks.clear(); asks.forEach((v, k) => this.#asks.set(k, v));
      this.#version = delta.version; this.#updates++;
      return true;
    } catch (error) { this.#rejected = true; throw error; }
  }

  snapshot(at: number): MexcReconstructedBook {
    if (this.#rejected) return reject('depth-book-already-rejected');
    try {
      if (!validTime(at) || at < this.#bootstrap.receipt.receivedAt ||
          this.#lastReceivedAt !== null && at < this.#lastReceivedAt ||
          this.#lastEvaluationAt !== null && at < this.#lastEvaluationAt) return reject('depth-book-invalid-evaluation');
      if (this.#updates === 0 || this.#lastSourceAt === null || this.#lastReceivedAt === null) return reject('depth-book-no-update');
      const ageMs = at - this.#lastSourceAt;
      if (ageMs > MEXC_DEPTH_STREAM_LIMITS.maximumAgeMs || ageMs < -MEXC_DEPTH_STREAM_LIMITS.maximumFutureMs) return reject('depth-book-source-time-unverified');
      if (at - this.#spec.receipt.receivedAt > MEXC_DEPTH_BOOK_LIMITS.metadataAgeMs) return reject('depth-book-stale-metadata');
      const { bids, asks } = this.#assertDepth(this.#bids, this.#asks);
      this.#lastEvaluationAt = at;
      return freeze({ schema: 1, kind: 'mexc-reconstructed-top50', market: this.#bootstrap.market,
        bootstrapReceipt: this.#bootstrap.receipt, metadataReceivedAt: this.#spec.receipt.receivedAt,
        evaluatedAt: at, receivedAt: this.#lastReceivedAt, bootstrapVersion: this.#bootstrap.version,
        version: this.#version, appliedUpdates: this.#updates, bids: bids.slice(0, 50), asks: asks.slice(0, 50),
        knownRange: this.#bootstrap.knownRange, knownLevels: { bids: bids.length, asks: asks.length },
        sourceTime: { at: this.#lastSourceAt, meaning: 'matching-engine-book-production', ageMs, representsUpdate: true },
        verifiedDepth: 50, entireBookKnown: false, bookReconstructed: true, bookFreshnessVerified: true,
        sourceFreshnessVerified: true, executable: false });
    } catch (error) { this.#rejected = true; throw error; }
  }

  #assertDepth(bidMap: Map<string, BookLevel>, askMap: Map<string, BookLevel>) {
    if (bidMap.size < 50 || askMap.size < 50) return reject('depth-book-range-exhausted');
    const bids = sorted(bidMap, 'bids'), asks = sorted(askMap, 'asks');
    assertUncrossed(bids, asks);
    if (units(bids[49].price) < units(this.#bootstrap.knownRange.bidFloor) || units(asks[49].price) > units(this.#bootstrap.knownRange.askCeiling)) return reject('depth-book-range-exhausted');
    return { bids, asks };
  }
}
