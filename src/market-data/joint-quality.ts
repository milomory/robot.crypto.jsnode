/** Joint historical timing/grid qualification. Raw provenance and WS continuity are checked by replay. */
import { decimal, multiply, units } from './exact-json.js';
import { freeze, market, publicUrl, reject, type InstrumentSpec, type PublicReceipt, type ResearchBase, type ResearchExchange } from './model.js';
import { mexcDepthBootstrapUrl, type MexcReconstructedBook } from './mexc-depth-book.js';
import { observationUrl, type PerpetualBook } from './observation-model.js';
import { spotUrl, type SpotBook, type SpotInstrument } from './spot-observations.js';

export type JointMarketId = 'mexc-perpetual' | 'okx-perpetual' | 'mexc-spot' | 'okx-spot';
export const JOINT_MARKETS: readonly JointMarketId[] = Object.freeze(['mexc-perpetual', 'okx-perpetual', 'mexc-spot', 'okx-spot']);
export const JOINT_QUALITY_LIMITS = Object.freeze({ maximumAgeMs: 5000, maximumFutureMs: 1000, maximumSkewMs: 1000, metadataAgeMs: 1_200_000 });
export interface JointMarketQuality {
  id: JointMarketId; present: boolean; metadataPresent: boolean; bookCount: number; metadataCount: number;
  usable: boolean; sourceAt: number | null; receivedAt: number | null; sourceAgeMs: number | null; reasons: readonly string[];
}
export interface JointPairQuality {
  strategy: 'perp-perp' | 'spot-perp'; longMarket: JointMarketId; shortMarket: JointMarketId;
  receiptSkewMs: number | null; sourceSkewMs: number | null; usableForComparison: boolean; reasons: readonly string[];
}
export interface JointBookQualityReport {
  schema: 1; kind: 'joint-book-quality'; base: ResearchBase; evaluatedAt: number;
  markets: readonly JointMarketQuality[]; pairs: readonly JointPairQuality[]; reasons: readonly string[]; executable: false;
}
export type JointBookQuality = JointBookQualityReport;
type Dict = Record<string, unknown>;
type Meta = { receipt: PublicReceipt; priceTick: string | null; quantityStep: string | null; basePerContract: string | null };
const object = (value: unknown): Dict | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Dict : null;
const time = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000_000;
const add = (reasons: string[], reason: string) => { if (!reasons.includes(reason)) reasons.push(reason); };
function requireValue(condition: unknown): asserts condition { if (!condition) reject('invalid-joint-input'); }
function positive(value: unknown): string { const result = decimal(value, false, true); requireValue(value === result); return result; }
function integer(value: unknown): string { requireValue(typeof value === 'string' && /^(?:0|[1-9]\d{0,29})$/.test(value)); return value; }
function identity(id: JointMarketId, base: ResearchBase) {
  const exchange: ResearchExchange = id.startsWith('mexc') ? 'mexc' : 'okx';
  return id.endsWith('perpetual') ? market(exchange, base) : { exchange, type: 'spot', base, quote: 'USDT', instrumentId: exchange === 'mexc' ? `${base}USDT` : `${base}-USDT` };
}
function marketIdentity(value: unknown, id: JointMarketId, base: ResearchBase): boolean {
  const actual = object(value), expected = identity(id, base);
  return !!actual && Object.keys(actual).sort().join(',') === Object.keys(expected).sort().join(',') &&
    Object.entries(expected).every(([key, val]) => actual[key] === val);
}
function receipt(value: unknown, url: string, timeoutMs: number): PublicReceipt {
  const r = object(value); requireValue(r && Object.keys(r).sort().join(',') === 'receivedAt,requestedAt,url' && r.url === url && time(r.requestedAt) && time(r.receivedAt));
  requireValue(r.receivedAt >= r.requestedAt && r.receivedAt - r.requestedAt <= timeoutMs);
  return { url, requestedAt: r.requestedAt, receivedAt: r.receivedAt };
}
function metadata(value: Dict, id: JointMarketId, base: ResearchBase, evaluatedAt: number, reasons: string[]): Meta | null {
  try {
    const perp = id.endsWith('perpetual'), exchange = id.startsWith('mexc') ? 'mexc' : 'okx';
    requireValue(value.schema === 1 && value.kind === (perp ? 'public-linear-contract' : 'public-spot-instrument') && marketIdentity(value.market, id, base) && value.executable === false);
    const r = receipt(value.receipt, perp ? publicUrl(exchange, base, 'instrument') : spotUrl(exchange, base, 'instrument'), 5000);
    if (evaluatedAt < r.receivedAt || evaluatedAt - r.receivedAt > JOINT_QUALITY_LIMITS.metadataAgeMs) add(reasons, 'metadata-binding-or-age');
    if (value.publicListingUsable !== true || value.publicState !== (exchange === 'mexc' ? perp ? '0' : '1' : 'live')) add(reasons, 'metadata-unusable');
    if (perp) {
      requireValue(value.quantityUnit === 'contracts' && value.contractMultiplier === '1');
      const basePerContract = positive(value.basePerContract), quantityStep = positive(value.quantityStepContracts), minimum = positive(value.minimumContracts), priceTick = positive(value.priceTick);
      requireValue(value.baseQuantityStep === multiply(basePerContract, quantityStep) && value.baseMinimumQuantity === multiply(basePerContract, minimum) && units(minimum) % units(quantityStep) === 0n);
      for (const key of ['maximumContractsReported', 'limitMaximumContractsReported']) if (value[key] !== null) requireValue(units(positive(value[key])) >= units(minimum));
      requireValue(typeof value.upcomingChange === 'boolean' && (exchange === 'mexc' ? typeof value.exchangeApiAllowed === 'boolean' : value.exchangeApiAllowed === null));
      if (value.upcomingChange || exchange === 'mexc' && !value.exchangeApiAllowed) add(reasons, 'metadata-unusable');
      return { receipt: r, priceTick, quantityStep, basePerContract };
    }
    const priceTick = value.priceTick === null ? null : positive(value.priceTick), quantityStep = value.quantityStep === null ? null : positive(value.quantityStep);
    positive(value.minimumQuantity); if (value.minimumNotional !== null) positive(value.minimumNotional);
    requireValue(exchange === 'mexc' ? priceTick === null && quantityStep === null && value.minimumNotional !== null : priceTick !== null && quantityStep !== null && value.minimumNotional === null);
    if (priceTick === null) add(reasons, 'price-tick-unconfirmed');
    if (quantityStep === null) add(reasons, 'quantity-step-unconfirmed');
    if (quantityStep !== null) requireValue(units(positive(value.minimumQuantity)) % units(quantityStep) === 0n);
    return { receipt: r, priceTick, quantityStep, basePerContract: null };
  } catch { add(reasons, 'metadata-invalid'); return null; }
}
function validateLevels(value: Dict, meta: Meta | null, perp: boolean, reconstructed: boolean): void {
  let bestBid = 0n, bestAsk = 0n;
  for (const side of ['bids', 'asks'] as const) {
    const rows = value[side]; requireValue(Array.isArray(rows) && rows.length >= (reconstructed ? 50 : 1) && rows.length <= 50);
    let previous: bigint | null = null;
    for (const raw of rows) {
      const row = object(raw); requireValue(row);
      requireValue(Object.keys(row).sort().join(',') === (perp ? 'orderCount,price,quantityBase,quantityContracts' : 'price,quantityBase'));
      const p = units(positive(row.price)), baseQuantity = positive(row.quantityBase);
      requireValue(previous === null || (side === 'bids' ? p < previous : p > previous));
      if (previous === null) { if (side === 'bids') bestBid = p; else bestAsk = p; } previous = p;
      if (meta?.priceTick !== null && meta?.priceTick !== undefined) requireValue(p % units(meta.priceTick) === 0n);
      if (perp) {
        const contracts = positive(row.quantityContracts); integer(row.orderCount);
        if (meta?.basePerContract) requireValue(baseQuantity === multiply(contracts, meta.basePerContract));
        if (meta?.quantityStep) requireValue(units(contracts) % units(meta.quantityStep) === 0n);
      } else if (meta?.quantityStep) requireValue(units(baseQuantity) % units(meta.quantityStep) === 0n);
    }
  }
  requireValue(bestBid < bestAsk);
  if (reconstructed) {
    const range = object(value.knownRange), known = object(value.knownLevels); requireValue(range && known);
    requireValue(Number.isSafeInteger(known.bids) && Number.isSafeInteger(known.asks) && (known.bids as number) >= 50 && (known.bids as number) <= 10_000 && (known.asks as number) >= 50 && (known.asks as number) <= 10_000);
    const floor = units(positive(range.bidFloor)), ceiling = units(positive(range.askCeiling));
    requireValue(units(positive(object((value.bids as unknown[])[49])!.price)) >= floor && units(positive(object((value.asks as unknown[])[49])!.price)) <= ceiling);
  }
}
function qualifyMarket(id: JointMarketId, base: ResearchBase, evaluatedAt: number, specs: readonly Dict[], books: readonly Dict[], globalReasons: readonly string[]): JointMarketQuality {
  const reasons = [...globalReasons];
  if (specs.length !== 1) add(reasons, specs.length ? 'metadata-duplicate' : 'metadata-missing');
  if (books.length !== 1) add(reasons, books.length ? 'book-duplicate' : 'book-missing');
  const meta = specs.length === 1 ? metadata(specs[0], id, base, evaluatedAt, reasons) : null;
  let sourceAt: number | null = null, receivedAt: number | null = null;
  if (books.length === 1) {
    const book = books[0], reconstructed = id === 'mexc-perpetual', perp = id.endsWith('perpetual'), exchange = id.startsWith('mexc') ? 'mexc' : 'okx';
    try {
      requireValue(book.schema === 1 && marketIdentity(book.market, id, base) && book.executable === false &&
        book.kind === (reconstructed ? 'mexc-reconstructed-top50' : perp ? 'public-perpetual-book' : 'public-spot-book'));
      const r = receipt(reconstructed ? book.bootstrapReceipt : book.receipt, reconstructed ? mexcDepthBootstrapUrl(base) : perp ? observationUrl(exchange, base, 'book') : spotUrl(exchange, base, 'book'), 3000);
      receivedAt = reconstructed ? time(book.receivedAt) ? book.receivedAt : null : r.receivedAt;
      requireValue(receivedAt !== null);
      if (reconstructed) {
        requireValue(time(book.evaluatedAt) && book.evaluatedAt >= Math.max(receivedAt, r.receivedAt) && book.evaluatedAt <= evaluatedAt);
        requireValue(book.verifiedDepth === 50 && book.entireBookKnown === false && Number.isSafeInteger(book.appliedUpdates) && (book.appliedUpdates as number) > 0);
        requireValue(BigInt(integer(book.version)) - BigInt(integer(book.bootstrapVersion)) === BigInt(book.appliedUpdates as number));
      } else { requireValue(book.identityBinding === 'request'); if (book.sequence !== null || exchange === 'okx') integer(book.sequence); }
      if (Math.max(receivedAt, r.receivedAt) > evaluatedAt) add(reasons, 'book-receipt-after-evaluation');
      if (!meta || book.metadataReceivedAt !== meta.receipt.receivedAt || r.requestedAt < meta.receipt.receivedAt || evaluatedAt - meta.receipt.receivedAt > JOINT_QUALITY_LIMITS.metadataAgeMs) add(reasons, 'metadata-binding-or-age');
      try { validateLevels(book, meta, perp, reconstructed); } catch { add(reasons, 'book-grid-or-units-invalid'); }
      const source = object(book.sourceTime); requireValue(source);
      const meaning = reconstructed ? 'matching-engine-book-production' : 'book-generation';
      if (id === 'mexc-spot' || source.meaning !== meaning) add(reasons, 'book-update-time-unverified');
      if (source.at === null) add(reasons, 'book-time-missing');
      else {
        requireValue(time(source.at)); sourceAt = source.at;
        if (evaluatedAt - sourceAt > JOINT_QUALITY_LIMITS.maximumAgeMs) add(reasons, 'book-stale');
        if (sourceAt - evaluatedAt > JOINT_QUALITY_LIMITS.maximumFutureMs || sourceAt - receivedAt > JOINT_QUALITY_LIMITS.maximumFutureMs) add(reasons, 'book-time-future');
      }
    } catch { add(reasons, 'book-invalid'); }
  }
  return { id, present: books.length > 0, metadataPresent: specs.length > 0, bookCount: books.length, metadataCount: specs.length,
    usable: reasons.length === 0, sourceAt, receivedAt, sourceAgeMs: sourceAt === null ? null : evaluatedAt - sourceAt, reasons };
}
export function qualifyJointBooks(base: ResearchBase, evaluatedAt: number, specs: readonly (InstrumentSpec | SpotInstrument)[], books: readonly (MexcReconstructedBook | PerpetualBook | SpotBook)[]): JointBookQualityReport {
  market('mexc', base); if (!time(evaluatedAt) || !Array.isArray(specs) || !Array.isArray(books)) reject('invalid-joint-evaluation');
  const byId = (values: readonly unknown[]) => {
    const groups = new Map<JointMarketId, Dict[]>(JOINT_MARKETS.map(id => [id, []])); let unidentified = false;
    for (const value of values) {
      const row = object(value), m = object(row?.market), id = m && `${m.exchange}-${m.type}`;
      if (!row || !JOINT_MARKETS.includes(id as JointMarketId)) unidentified = true;
      else groups.get(id as JointMarketId)!.push(row);
    }
    return { groups, unidentified };
  };
  const s = byId(specs), b = byId(books), reasons = s.unidentified || b.unidentified ? ['unidentified-input'] : [];
  const markets = JOINT_MARKETS.map(id => qualifyMarket(id, base, evaluatedAt, s.groups.get(id)!, b.groups.get(id)!, reasons));
  const directions: [JointMarketId, JointMarketId][] = [['mexc-perpetual', 'okx-perpetual'], ['okx-perpetual', 'mexc-perpetual'],
    ['mexc-spot', 'mexc-perpetual'], ['mexc-spot', 'okx-perpetual'], ['okx-spot', 'mexc-perpetual'], ['okx-spot', 'okx-perpetual']];
  const pairs: JointPairQuality[] = directions.map(([longMarket, shortMarket]) => {
    const long = markets.find(m => m.id === longMarket)!, short = markets.find(m => m.id === shortMarket)!;
    const pairReasons = [...long.reasons.map(r => `${longMarket}:${r}`), ...short.reasons.map(r => `${shortMarket}:${r}`)];
    const receiptSkewMs = long.receivedAt === null || short.receivedAt === null ? null : Math.abs(long.receivedAt - short.receivedAt);
    const sourceSkewMs = long.sourceAt === null || short.sourceAt === null ? null : Math.abs(long.sourceAt - short.sourceAt);
    if (receiptSkewMs !== null && receiptSkewMs > JOINT_QUALITY_LIMITS.maximumSkewMs) pairReasons.push('book-receipt-skew');
    if (sourceSkewMs !== null && sourceSkewMs > JOINT_QUALITY_LIMITS.maximumSkewMs) pairReasons.push('book-source-skew');
    return { strategy: longMarket.endsWith('spot') ? 'spot-perp' : 'perp-perp', longMarket, shortMarket, receiptSkewMs, sourceSkewMs,
      usableForComparison: pairReasons.length === 0, reasons: pairReasons };
  });
  return freeze({ schema: 1, kind: 'joint-book-quality', base, evaluatedAt, markets, pairs, reasons, executable: false });
}
