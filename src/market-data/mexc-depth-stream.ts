/** Public BTC incremental evidence only: no connection, snapshot, ledger or execution. */
import { decimal, parsePublicJson, record, timestamp } from './exact-json.js';
import { freeze, reject } from './model.js';
import { integerText } from './observation-model.js';

export const MEXC_DEPTH_STREAM_URL = 'wss://contract.mexc.com/edge';
export const MEXC_DEPTH_STREAM_SUBSCRIPTION = Object.freeze({ method: 'sub.depth',
  param: Object.freeze({ symbol: 'BTC_USDT', compress: false }), gzip: false });
export const MEXC_DEPTH_STREAM_LIMITS = Object.freeze({ maximumFrameBytes: 512 * 1024,
  maximumLevelsPerSide: 2000, maximumAgeMs: 5000, maximumFutureMs: 5000 });

/** Fixed parser codes only. Transport failures must be explicitly allowlisted by its caller. */
export const STREAM_FAILURES: readonly string[] = Object.freeze([
  'invalid-public-json', 'invalid-public-data', 'invalid-public-number', 'invalid-public-time',
  'invalid-observation-integer', 'public-response-too-large', 'invalid-stream-levels',
  'duplicate-stream-price', 'stream-already-rejected', 'unsupported-stream-frame',
  'invalid-stream-timing', 'stream-server-error', 'unexpected-stream-channel',
  'unsupported-stream-symbol', 'invalid-stream-ack', 'stream-version-discontinuity',
  'stream-source-time-regression',
]);

interface StreamEvidence {
  receivedAt: number;
  exchangeTimestamp: number | null;
  exchangeTimestampVerified: false;
  executable: false;
}
export interface MexcDepthStreamAck extends StreamEvidence {
  kind: 'ack'; channel: 'rs.sub.depth';
}
export interface MexcDepthStreamPong extends StreamEvidence {
  kind: 'pong'; channel: 'pong'; serverTime: number; serverTimeVerified: false;
}
export interface MexcDepthDeltaLevel {
  price: string; quantityContracts: string; orderCount: string; action: 'set' | 'delete';
}
export interface MexcDepthStreamDelta extends StreamEvidence {
  kind: 'delta'; channel: 'push.depth'; symbol: 'BTC_USDT';
  version: string; previousVersion: string | null;
  bids: readonly MexcDepthDeltaLevel[]; asks: readonly MexcDepthDeltaLevel[];
  sourceTime: { at: number | null; meaning: 'matching-engine-book-production'; ageMs: number | null;
    ageStatus: 'missing' | 'future' | 'stale' | 'within-window' };
  sourceTimeFresh: boolean;
  bookReconstructed: false; bookFreshnessVerified: false;
}
export type MexcDepthStreamMessage = MexcDepthStreamAck | MexcDepthStreamPong | MexcDepthStreamDelta;

function optionalTime(value: unknown): number | null {
  return value === undefined || value === null ? null : timestamp(value);
}
function levels(value: unknown): readonly MexcDepthDeltaLevel[] {
  if (!Array.isArray(value) || value.length > MEXC_DEPTH_STREAM_LIMITS.maximumLevelsPerSide) {
    return reject('invalid-stream-levels');
  }
  const prices = new Set<string>();
  return value.map(row => {
    if (!Array.isArray(row) || row.length !== 3) return reject('invalid-stream-levels');
    const price = decimal(row[0], false, true), quantityContracts = decimal(row[1]);
    if (prices.has(price)) return reject('duplicate-stream-price');
    prices.add(price);
    // Deltas contain absolute quantities; zero deletes the price. No ordering guarantee.
    return { price, quantityContracts, orderCount: integerText(row[2]),
      action: quantityContracts === '0' ? 'delete' : 'set' };
  });
}

/** The instance is single-use after rejection; a caller cannot hide a gap then resume. */
export class MexcDepthStreamEvidence {
  #lastReceivedAt: number | null = null;
  #lastVersion: string | null = null;
  #lastSourceTime: number | null = null;
  #acknowledged = false;
  #rejected = false;

  accept(raw: string, receivedAt: number): MexcDepthStreamMessage {
    if (this.#rejected) return reject('stream-already-rejected');
    try {
      const result = this.#parse(raw, receivedAt);
      this.#lastReceivedAt = receivedAt;
      if (result.kind === 'ack') this.#acknowledged = true;
      if (result.kind === 'delta') {
        this.#lastVersion = result.version;
        if (result.sourceTime.at !== null) this.#lastSourceTime = result.sourceTime.at;
      }
      return freeze(result);
    } catch (error) {
      this.#rejected = true;
      throw error;
    }
  }

  #parse(raw: string, receivedAt: number): MexcDepthStreamMessage {
    if (typeof raw !== 'string') return reject('unsupported-stream-frame');
    if (raw.length > MEXC_DEPTH_STREAM_LIMITS.maximumFrameBytes ||
        Buffer.byteLength(raw, 'utf8') > MEXC_DEPTH_STREAM_LIMITS.maximumFrameBytes) {
      return reject('public-response-too-large');
    }
    if (!Number.isSafeInteger(receivedAt) || receivedAt <= 0 || receivedAt > 8_640_000_000_000_000 ||
        (this.#lastReceivedAt !== null && receivedAt < this.#lastReceivedAt)) {
      return reject('invalid-stream-timing');
    }
    // No Number-based JSON decoding before the shared exact numeric-token parser.
    const row = record(parsePublicJson(Buffer.from(raw, 'utf8')));
    if (row.channel === 'rs.error') return reject('stream-server-error');
    if (!['rs.sub.depth', 'pong', 'push.depth'].includes(row.channel as string)) {
      return reject('unexpected-stream-channel');
    }
    if (row.symbol !== undefined && row.symbol !== 'BTC_USDT') return reject('unsupported-stream-symbol');
    const common = { receivedAt, exchangeTimestamp: optionalTime(row.ts),
      exchangeTimestampVerified: false as const, executable: false as const };
    if (row.channel === 'rs.sub.depth') {
      if (this.#acknowledged || row.data !== 'success') return reject('invalid-stream-ack');
      return { ...common, kind: 'ack', channel: 'rs.sub.depth' };
    }
    if (row.channel === 'pong') {
      return { ...common, kind: 'pong', channel: 'pong', serverTime: timestamp(row.data), serverTimeVerified: false };
    }
    if (row.symbol !== 'BTC_USDT') return reject('unsupported-stream-symbol');
    const data = record(row.data);
    if (data.symbol !== undefined && data.symbol !== 'BTC_USDT') return reject('unsupported-stream-symbol');
    const version = integerText(data.version);
    if (this.#lastVersion !== null && BigInt(version) !== BigInt(this.#lastVersion) + 1n) {
      return reject('stream-version-discontinuity');
    }
    const at = optionalTime(data.cts);
    if (at !== null && this.#lastSourceTime !== null && at < this.#lastSourceTime) {
      return reject('stream-source-time-regression');
    }
    const ageMs = at === null ? null : receivedAt - at;
    const ageStatus = ageMs === null ? 'missing' : ageMs < -MEXC_DEPTH_STREAM_LIMITS.maximumFutureMs ? 'future' :
      ageMs > MEXC_DEPTH_STREAM_LIMITS.maximumAgeMs ? 'stale' : 'within-window';
    return { ...common, kind: 'delta', channel: 'push.depth', symbol: 'BTC_USDT', version,
      previousVersion: this.#lastVersion, bids: levels(data.bids), asks: levels(data.asks),
      sourceTime: { at, meaning: 'matching-engine-book-production', ageMs, ageStatus },
      sourceTimeFresh: ageStatus === 'within-window', bookReconstructed: false, bookFreshnessVerified: false };
  }
}
