/**
 * Pure bounded initial-snapshot bridge using MEXC's documented depth_commits.
 * https://www.mexc.com/api-docs/futures/websocket-api/incremental-order-book-maintenance-mechanism
 * https://www.mexc.com/api-docs/futures/market-endpoints/get-the-last-n-depth-snapshots
 * The maintenance text says ascending; the endpoint example is descending. Both
 * strictly monotonic orders normalize to ascending. Mixed/duplicate versions fail.
 * Commits have no verified matching-engine timestamp. They only move a known
 * initial state to targetVersion; a later continuous WS delta must establish cts.
 */
import { isDeepStrictEqual } from 'node:util';
import { decimal, multiply, numberText, record, units } from './exact-json.js';
import { DEPTH_BOOK_FAILURES, MEXC_DEPTH_BOOK_LIMITS, MexcDepthBook, parseMexcDepthBootstrap,
  type MexcDepthBootstrap } from './mexc-depth-book.js';
import { type MexcDepthDeltaLevel } from './mexc-depth-stream.js';
import { freeze, market, reject, type InstrumentSpec, type PublicReceipt, type ResearchBase, type ResearchMarket } from './model.js';
import { assertBoundSpec, integerText, observationUrl, type BookLevel } from './observation-model.js';

export const MEXC_DEPTH_RECOVERY_LIMITS = Object.freeze({ maximumCommits: 1000, maximumUpdatesPerSide: 2000,
  requestTimeoutMs: 3000, metadataAgeMs: 1_200_000, maximumBridgeVersions: 1000, maximumKnownLevelsPerSide: 10_000 });
export const DEPTH_RECOVERY_FAILURES: readonly string[] = Object.freeze([...new Set([...DEPTH_BOOK_FAILURES,
  'invalid-depth-commits-receipt', 'invalid-depth-commits', 'invalid-depth-commit-levels',
  'depth-commits-version-order', 'depth-recovery-invalid-target', 'depth-recovery-missing-version',
  'depth-recovery-timing', 'invalid-depth-commits-normalization',
])]);
export interface MexcDepthCommit {
  version: string;
  bids: readonly MexcDepthDeltaLevel[];
  asks: readonly MexcDepthDeltaLevel[];
}
export interface MexcDepthCommits {
  schema: 1; kind: 'mexc-depth-commits'; market: ResearchMarket; receipt: PublicReceipt;
  metadataReceivedAt: number; commits: readonly MexcDepthCommit[];
  sourceFreshnessVerified: false; executable: false;
}
export function mexcDepthCommitsUrl(base: ResearchBase): string {
  return `https://api.mexc.com/api/v1/contract/depth_commits/${market('mexc', base).instrumentId}/1000`;
}
function boundSpec(base: ResearchBase, receipt: PublicReceipt, spec: InstrumentSpec): void {
  if (!receipt || Object.keys(receipt).sort().join(',') !== 'receivedAt,requestedAt,url'
    || receipt.url !== mexcDepthCommitsUrl(base)) return reject('invalid-depth-commits-receipt');
  // Only reuse common metadata/grid/age and three-second public-book checks after
  // validating the actual, fixed commits URL. The saved receipt is never rewritten.
  assertBoundSpec(spec, { exchange: 'mexc', base, kind: 'book' }, { ...receipt, url: observationUrl('mexc', base, 'book') });
  for (const name of ['basePerContract', 'quantityStepContracts', 'minimumContracts', 'priceTick'] as const) {
    if (decimal(spec[name], false, true) !== spec[name]) return reject('observation-spec-mismatch');
  }
}
function updates(raw: unknown, spec: InstrumentSpec): readonly MexcDepthDeltaLevel[] {
  if (!Array.isArray(raw) || raw.length > MEXC_DEPTH_RECOVERY_LIMITS.maximumUpdatesPerSide) return reject('invalid-depth-commit-levels');
  const seen = new Set<string>(), tick = units(spec.priceTick), lot = units(spec.quantityStepContracts);
  return Array.from(raw, value => {
    if (!Array.isArray(value) || value.length !== 3) return reject('invalid-depth-commit-levels');
    const price = decimal(value[0], false, true), quantityContracts = decimal(value[1]);
    if (seen.has(price) || units(price) % tick || units(quantityContracts) % lot) return reject('invalid-depth-commit-levels');
    seen.add(price);
    // Validate representable base conversion even for updates outside the initial
    // known range, so the bridge cannot hide malformed unrelated response data.
    multiply(quantityContracts, spec.basePerContract);
    return { price, quantityContracts, orderCount: integerText(value[2]), action: quantityContracts === '0' ? 'delete' : 'set' };
  });
}
/** raw must come from parsePublicJson; native Number amounts are rejected. */
export function parseMexcDepthCommits(raw: unknown, base: ResearchBase, receipt: PublicReceipt, spec: InstrumentSpec): MexcDepthCommits {
  boundSpec(base, receipt, spec);
  const root = record(raw), expected = market('mexc', base);
  if (root.success !== true || numberText(root.code) !== '0') return reject('invalid-public-response');
  if (root.symbol !== undefined && root.symbol !== expected.instrumentId) return reject('unsupported-public-contract');
  if (!Array.isArray(root.data) || root.data.length === 0 || root.data.length > MEXC_DEPTH_RECOVERY_LIMITS.maximumCommits) return reject('invalid-depth-commits');
  let previous: bigint | null = null, direction = 0;
  const commits = Array.from(root.data, value => {
    const row = record(value);
    if (row.symbol !== undefined && row.symbol !== expected.instrumentId) return reject('unsupported-public-contract');
    const version = integerText(row.version), current = BigInt(version);
    if (previous !== null) {
      const step = current > previous ? 1 : current < previous ? -1 : 0;
      if (step === 0 || direction !== 0 && step !== direction) return reject('depth-commits-version-order');
      direction = step;
    }
    previous = current;
    const bids = updates(row.bids, spec), asks = updates(row.asks, spec);
    if (bids.length + asks.length === 0) return reject('invalid-depth-commits');
    return { version, bids, asks };
  });
  if (direction < 0) commits.reverse();
  return freeze({ schema: 1, kind: 'mexc-depth-commits', market: expected, receipt: { ...receipt },
    metadataReceivedAt: spec.receipt.receivedAt, commits, sourceFreshnessVerified: false, executable: false });
}
function canonicalCommits(value: MexcDepthCommits, base: ResearchBase, spec: InstrumentSpec): MexcDepthCommits {
  if (!value || !Array.isArray(value.commits)) return reject('invalid-depth-commits-normalization');
  const rows = value.commits.map(value => {
    const row = record(value);
    const fields = (side: 'bids' | 'asks') => {
      if (!Array.isArray(row[side])) return reject('invalid-depth-commits-normalization');
      return Array.from(row[side], value => { const level = record(value); return [level.price, level.quantityContracts, level.orderCount]; });
    };
    return { version: row.version, bids: fields('bids'), asks: fields('asks') };
  });
  const parsed = parseMexcDepthCommits({ success: true, code: '0', data: rows }, base, value.receipt, spec);
  if (!isDeepStrictEqual(parsed, value)) return reject('invalid-depth-commits-normalization');
  return parsed;
}
function sorted(map: Map<string, BookLevel>, side: 'bids' | 'asks'): BookLevel[] {
  return [...map.values()].sort((a, b) => (units(a.price) < units(b.price) ? -1 : units(a.price) > units(b.price) ? 1 : 0)
    * (side === 'bids' ? -1 : 1));
}
function assertState(bids: Map<string, BookLevel>, asks: Map<string, BookLevel>): void {
  if (bids.size > MEXC_DEPTH_RECOVERY_LIMITS.maximumKnownLevelsPerSide || asks.size > MEXC_DEPTH_RECOVERY_LIMITS.maximumKnownLevelsPerSide) return reject('depth-book-capacity-exceeded');
  if (bids.size < MEXC_DEPTH_BOOK_LIMITS.verifiedLevels || asks.size < MEXC_DEPTH_BOOK_LIMITS.verifiedLevels) return reject('depth-book-range-exhausted');
  let bid: bigint | null = null, ask: bigint | null = null;
  for (const price of bids.keys()) { const n = units(price); if (bid === null || n > bid) bid = n; }
  for (const price of asks.keys()) { const n = units(price); if (ask === null || n < ask) ask = n; }
  if (bid! >= ask!) return reject('crossed-public-book');
}
/**
 * Apply exactly snapshot.version+1 .. targetVersion (the first buffered WS version
 * minus one). Never fills a missing version, expands the original known range,
 * invents a timestamp or claims that REST commits alone form a fresh WS book.
 */
export function bridgeMexcBootstrap(snapshot: MexcDepthBootstrap, commits: MexcDepthCommits,
  targetVersion: string, spec: InstrumentSpec): MexcDepthBootstrap {
  // Reuse the independently strict normalized bootstrap boundary, including flags,
  // grids, base amounts, market identity, known ranges and system-time semantics.
  new MexcDepthBook(spec, snapshot);
  const canonical = canonicalCommits(commits, snapshot.market.base, spec);
  if (canonical.receipt.requestedAt < snapshot.receipt.receivedAt) return reject('depth-recovery-timing');
  const target = BigInt(integerText(targetVersion)), start = BigInt(snapshot.version);
  if (target <= start || target > start + BigInt(MEXC_DEPTH_RECOVERY_LIMITS.maximumBridgeVersions)) return reject('depth-recovery-invalid-target');
  const byVersion = new Map(canonical.commits.map(commit => [commit.version, commit]));
  // Establish the complete version bridge before applying any data.
  for (let version = start + 1n; version <= target; version++) {
    if (!byVersion.has(version.toString())) return reject('depth-recovery-missing-version');
  }
  const bids = new Map(snapshot.bids.map(row => [row.price, { ...row }])), asks = new Map(snapshot.asks.map(row => [row.price, { ...row }]));
  const bidFloor = units(snapshot.knownRange.bidFloor), askCeiling = units(snapshot.knownRange.askCeiling);
  for (let version = start + 1n; version <= target; version++) {
    const commit = byVersion.get(version.toString())!;
    // One commit replaces absolute quantities atomically on BOTH sides before
    // crossing/depth checks. An intermediate one-side state is never observed.
    for (const side of ['bids', 'asks'] as const) {
      const map = side === 'bids' ? bids : asks;
      for (const row of commit[side]) {
        const price = units(row.price);
        if (side === 'bids' ? price < bidFloor : price > askCeiling) continue;
        if (row.action === 'delete') map.delete(row.price);
        else map.set(row.price, { price: row.price, quantityContracts: row.quantityContracts,
          quantityBase: multiply(row.quantityContracts, spec.basePerContract), orderCount: row.orderCount });
      }
    }
    assertState(bids, asks);
  }
  const rows = (side: 'bids' | 'asks') => sorted(side === 'bids' ? bids : asks, side)
    .slice(0, MEXC_DEPTH_BOOK_LIMITS.bootstrapLevels).map(row => [row.price, row.quantityContracts, row.orderCount]);
  // Reparsing defines knownRange from the last retained price. Truncation or
  // boundary deletions NARROW the original range; they can never expand it.
  return parseMexcDepthBootstrap({ success: true, code: '0', data: {
    ...(snapshot.identityBinding === 'request-and-response' ? { symbol: snapshot.market.instrumentId } : {}),
    bids: rows('bids'), asks: rows('asks'), version: target.toString(),
    timestamp: snapshot.sourceTime.at === null ? null : String(snapshot.sourceTime.at),
    cts: snapshot.auxiliaryTimestamp === null ? null : String(snapshot.auxiliaryTimestamp),
  } }, snapshot.market.base, snapshot.receipt, spec);
}
