import { describe, expect, it } from 'vitest';
import { market, publicUrl, type InstrumentSpec, type ResearchBase, type ResearchExchange } from '../src/market-data/model.js';
import { observationUrl, type PerpetualBook } from '../src/market-data/observation-model.js';
import { mexcDepthBootstrapUrl, type MexcReconstructedBook } from '../src/market-data/mexc-depth-book.js';
import { spotUrl, type SpotBook, type SpotInstrument } from '../src/market-data/spot-observations.js';
import { qualifyJointBooks, type JointMarketId } from '../src/market-data/joint-quality.js';

const at = 1_800_000_000_000;
type Spec = InstrumentSpec | SpotInstrument;
type Book = MexcReconstructedBook | PerpetualBook | SpotBook;
const contract = (exchange: ResearchExchange, base: ResearchBase): InstrumentSpec => ({ schema: 1, kind: 'public-linear-contract', market: market(exchange, base),
  receipt: { url: publicUrl(exchange, base, 'instrument'), requestedAt: at - 1100, receivedAt: at - 1000 }, sourceUpdatedAt: null,
  quantityUnit: 'contracts', basePerContract: '0.01', contractMultiplier: '1', quantityStepContracts: '1', minimumContracts: '1', priceTick: '0.1',
  baseQuantityStep: '0.01', baseMinimumQuantity: '0.01', maximumContractsReported: null, limitMaximumContractsReported: null,
  publicState: exchange === 'mexc' ? '0' : 'live', exchangeApiAllowed: exchange === 'mexc' ? true : null, publicListingUsable: true,
  upcomingChange: false, feeGroupId: null, accountEligibilityVerified: false, personalFeesVerified: false, executable: false });
function spot(exchange: ResearchExchange, base: ResearchBase): SpotInstrument {
  return { schema: 1, kind: 'public-spot-instrument', market: { exchange, type: 'spot', instrumentId: exchange === 'mexc' ? `${base}USDT` : `${base}-USDT`, base, quote: 'USDT' },
    receipt: { url: spotUrl(exchange, base, 'instrument'), requestedAt: at - 1100, receivedAt: at - 1000 },
    priceTick: exchange === 'mexc' ? null : '0.1', quantityStep: exchange === 'mexc' ? null : '0.01', minimumQuantity: '0.01',
    minimumNotional: exchange === 'mexc' ? '1' : null, publicState: exchange === 'mexc' ? '1' : 'live', publicListingUsable: true, executable: false };
}
function fixture(base: ResearchBase = 'BTC'): { specs: Spec[]; books: Book[] } {
  const specs: Spec[] = [contract('mexc', base), contract('okx', base), spot('mexc', base), spot('okx', base)];
  const levels = (side: 'bids' | 'asks') => Array.from({ length: 50 }, (_, i) => ({ price: String(side === 'bids' ? 2000 - i : 2001 + i), quantityContracts: '3', quantityBase: '0.03', orderCount: '1' }));
  const mexc: MexcReconstructedBook = { schema: 1, kind: 'mexc-reconstructed-top50', market: market('mexc', base),
    bootstrapReceipt: { url: mexcDepthBootstrapUrl(base), requestedAt: at - 300, receivedAt: at - 200 }, metadataReceivedAt: at - 1000,
    evaluatedAt: at - 50, receivedAt: at - 100, bootstrapVersion: '9007199254740993', version: '9007199254741003', appliedUpdates: 10,
    bids: levels('bids'), asks: levels('asks'), knownRange: { bidFloor: '1951', askCeiling: '2050' }, knownLevels: { bids: 50, asks: 50 },
    sourceTime: { at: at - 200, meaning: 'matching-engine-book-production', ageMs: 150, representsUpdate: true }, verifiedDepth: 50,
    entireBookKnown: false, bookReconstructed: true, bookFreshnessVerified: true, sourceFreshnessVerified: true, executable: false };
  const okx: PerpetualBook = { schema: 1, kind: 'public-perpetual-book', market: market('okx', base),
    receipt: { url: observationUrl('okx', base, 'book'), requestedAt: at - 200, receivedAt: at - 100 }, metadataReceivedAt: at - 1000,
    identityBinding: 'request', bids: levels('bids'), asks: levels('asks'), sequence: '9007199254740993',
    sourceTime: { at: at - 200, meaning: 'book-generation', ageMs: 100, ageStatus: 'within-window', representsUpdate: true },
    auxiliaryTimestamp: null, auxiliaryTimestampVerified: false, sourceFreshnessVerified: true, executable: false };
  const spotBook = (exchange: ResearchExchange): SpotBook => ({ schema: 1, kind: 'public-spot-book', market: (specs[exchange === 'mexc' ? 2 : 3] as SpotInstrument).market,
    receipt: { url: spotUrl(exchange, base, 'book'), requestedAt: at - 200, receivedAt: at - 100 }, metadataReceivedAt: at - 1000,
    identityBinding: 'request', bids: levels('bids').map(({ price, quantityBase }) => ({ price, quantityBase })),
    asks: levels('asks').map(({ price, quantityBase }) => ({ price, quantityBase })), sequence: '9007199254740993',
    sourceTime: { at: exchange === 'mexc' ? null : at - 200, meaning: 'book-generation', ageMs: exchange === 'mexc' ? null : 100,
      ageStatus: exchange === 'mexc' ? 'missing' : 'within-window', representsUpdate: true }, sourceFreshnessVerified: exchange === 'okx', executable: false });
  return structuredClone({ specs, books: [mexc, okx, spotBook('mexc'), spotBook('okx')] });
}
function run(f = fixture(), evaluatedAt = at) { return qualifyJointBooks('BTC', evaluatedAt, f.specs, f.books); }
const get = (f: ReturnType<typeof fixture>, id: JointMarketId = 'okx-perpetual', evaluatedAt = at) => run(f, evaluatedAt).markets.find(m => m.id === id)!;
const mutate = (f: ReturnType<typeof fixture>, type: 'specs' | 'books', index: number): Record<string, any> => f[type][index] as unknown as Record<string, any>;

describe('joint per-market quality at a shared historical time', () => {
  it.each(['BTC', 'ETH'] as const)('qualifies %s verified markets and only the four supported directions', base => {
    const f = fixture(base), report = qualifyJointBooks(base, at, f.specs, f.books);
    expect(report).toMatchObject({ schema: 1, kind: 'joint-book-quality', base, evaluatedAt: at, reasons: [], executable: false });
    expect(report.markets.filter(m => m.usable).map(m => m.id)).toEqual(['mexc-perpetual', 'okx-perpetual', 'okx-spot']);
    expect(report.pairs).toHaveLength(6); expect(report.pairs.filter(p => p.usableForComparison)).toHaveLength(4);
    expect(report.pairs.map(p => [p.longMarket, p.shortMarket])).toEqual([
      ['mexc-perpetual', 'okx-perpetual'], ['okx-perpetual', 'mexc-perpetual'], ['mexc-spot', 'mexc-perpetual'],
      ['mexc-spot', 'okx-perpetual'], ['okx-spot', 'mexc-perpetual'], ['okx-spot', 'okx-perpetual'],
    ]);
    expect(report.markets[2].reasons).toEqual(['price-tick-unconfirmed', 'quantity-step-unconfirmed', 'book-update-time-unverified', 'book-time-missing']);
  });
  it('recomputes source ages instead of trusting derived age/quality flags', () => {
    const f = fixture();
    for (const i of [0, 1, 3]) { const b = mutate(f, 'books', i); b.sourceTime.ageMs = 999_999; b.sourceTime.ageStatus = 'stale'; b.sourceTime.representsUpdate = false; b.sourceFreshnessVerified = false; }
    expect(run(f).markets.filter(m => m.usable)).toHaveLength(3);
    expect(run(f).markets[0].sourceAgeMs).toBe(200);
  });
  it('never adopts even forged fresh MEXC Spot source time/grid as verified', () => {
    const f = fixture(), s = mutate(f, 'specs', 2), b = mutate(f, 'books', 2);
    s.priceTick = '0.1'; s.quantityStep = '0.01'; b.sourceTime.at = at - 200; b.sourceFreshnessVerified = true;
    expect(get(f, 'mexc-spot').usable).toBe(false); expect(get(f, 'mexc-spot').reasons).toContain('book-update-time-unverified');
    expect(run(f).pairs.filter(p => p.usableForComparison)).toHaveLength(4);
  });
  it.each([5000, 5001])('checks inclusive common source age boundary %i ms', age => {
    const f = fixture(); mutate(f, 'books', 1).sourceTime.at = at - age;
    expect(get(f).usable).toBe(age === 5000); expect(get(f).sourceAgeMs).toBe(age);
  });
  it('does not reuse freshness from the earlier MEXC-only evaluation', () => {
    const f = fixture(); expect(get(f, 'mexc-perpetual', at + 4801).reasons).toContain('book-stale');
  });
  it.each([1000, 1001])('checks future tolerance at receipt: %i ms', future => {
    const f = fixture(); mutate(f, 'books', 1).sourceTime.at = at - 100 + future;
    expect(get(f).usable).toBe(future === 1000);
  });
  it('does not heal an originally future source by evaluating later', () => {
    const f = fixture(); mutate(f, 'books', 1).sourceTime.at = at + 1001;
    expect(get(f, 'okx-perpetual', at + 2000).reasons).toContain('book-time-future');
  });
  it.each(['response-time', 'exchange-system', 'trade', 'matching-engine-book-production', null])('does not relabel OKX source meaning %s', meaning => {
    const f = fixture(); mutate(f, 'books', 1).sourceTime.meaning = meaning;
    expect(get(f).reasons).toContain('book-update-time-unverified');
  });
  it.each([null, undefined, NaN, -1, 1.5, String(at)])('blocks a missing/malformed source timestamp %s', sourceAt => {
    const f = fixture(); mutate(f, 'books', 1).sourceTime.at = sourceAt; expect(get(f).usable).toBe(false);
  });
  it('checks book receipts against evaluation rather than just their internal chronology', () => {
    const f = fixture(); mutate(f, 'books', 1).receipt.receivedAt = at + 1;
    expect(get(f).reasons).toContain('book-receipt-after-evaluation');
  });
  it('does not mutate or freeze its inputs and freezes the complete report', () => {
    const f = fixture(), before = structuredClone(f), report = run(f);
    expect(f).toEqual(before); expect(Object.isFrozen(f.books[0])).toBe(false);
    for (const value of [report, report.markets, report.markets[0], report.markets[0].reasons, report.pairs, report.pairs[0], report.pairs[0].reasons]) expect(Object.isFrozen(value)).toBe(true);
  });
});

describe('strict identity and metadata binding without hiding missing markets', () => {
  it.each(['specs', 'books'] as const)('reports duplicate %s instead of choosing the first', type => {
    const f = fixture(); (f[type] as unknown[]).push(structuredClone(f[type][1]));
    expect(get(f).reasons).toContain(type === 'specs' ? 'metadata-duplicate' : 'book-duplicate');
    expect(get(f, 'mexc-perpetual').usable).toBe(true); expect(get(f, 'okx-spot').usable).toBe(true);
  });
  it.each(['specs', 'books'] as const)('reports missing %s without blocking independent pairs', type => {
    const f = fixture(); f[type].splice(2, 1);
    expect(get(f, 'mexc-spot').reasons).toContain(type === 'specs' ? 'metadata-missing' : 'book-missing');
    expect(run(f).pairs.filter(p => p.usableForComparison)).toHaveLength(4);
  });
  it.each(['specs', 'books'] as const)('wrong base in %s only blocks its identified market', type => {
    const f = fixture(); mutate(f, type, 1).market.base = 'ETH';
    expect(get(f).usable).toBe(false); expect(get(f, 'mexc-perpetual').usable).toBe(true);
  });
  it.each(['specs', 'books'] as const)('does not ignore unidentifiable %s input', type => {
    const f = fixture(); (f[type] as unknown[]).push(null);
    expect(run(f).reasons).toContain('unidentified-input'); expect(run(f).pairs.every(p => !p.usableForComparison)).toBe(true);
  });
  it.each([
    { instrumentId: 'BTC-USD-SWAP' }, { quote: 'USD' }, { settlement: 'BTC' }, { unrelated: true },
  ])('requires exact market identity %j', patch => {
    const f = fixture(); Object.assign(mutate(f, 'books', 1).market, patch); expect(get(f).reasons).toContain('book-invalid');
  });
  it.each([
    { quantityUnit: 'base' }, { contractMultiplier: '10' }, { basePerContract: '0' }, { priceTick: '0' },
    { baseQuantityStep: '1' }, { baseMinimumQuantity: '1' }, { quantityStepContracts: '1.0' },
    { minimumContracts: '1.1' }, { maximumContractsReported: '0.1' }, { limitMaximumContractsReported: '0.1' },
  ])('rejects inconsistent contract units/grid %j', patch => {
    const f = fixture(); Object.assign(mutate(f, 'specs', 1), patch); expect(get(f).reasons).toContain('metadata-invalid');
  });
  it.each([{ publicListingUsable: false }, { publicState: 'suspend' }, { upcomingChange: true }])('retains listing restriction %j', patch => {
    const f = fixture(); Object.assign(mutate(f, 'specs', 1), patch); expect(get(f).reasons).toContain('metadata-unusable');
  });
  it('does not let a forged listing flag override known MEXC API disallow', () => {
    const f = fixture(); mutate(f, 'specs', 0).exchangeApiAllowed = false; expect(get(f, 'mexc-perpetual').reasons).toContain('metadata-unusable');
  });
  it.each([1_200_000, 1_200_001])('checks metadata age at common evaluation: %i ms', age => {
    const f = fixture(), s = mutate(f, 'specs', 1), b = mutate(f, 'books', 1);
    s.receipt.receivedAt = at - age; s.receipt.requestedAt = at - age - 100; b.metadataReceivedAt = at - age;
    expect(get(f).usable).toBe(age === 1_200_000);
  });
  it.each([
    (f: ReturnType<typeof fixture>) => { mutate(f, 'books', 1).metadataReceivedAt--; },
    (f: ReturnType<typeof fixture>) => { mutate(f, 'books', 1).receipt.requestedAt = at - 1001; },
    (f: ReturnType<typeof fixture>) => { mutate(f, 'specs', 1).receipt.receivedAt = at + 1; },
  ])('requires exact metadata capture binding and chronology', change => {
    const f = fixture(); change(f); expect(get(f).usable).toBe(false);
  });
  it.each(['specs', 'books'] as const)('requires fixed %s route without query substitution', type => {
    const f = fixture(); mutate(f, type, 1).receipt.url += '&other=1'; expect(get(f).usable).toBe(false);
  });
  it.each(['specs', 'books'] as const)('rejects malformed %s receipts with a closed reason', type => {
    const f = fixture(); mutate(f, type, 1).receipt = null; expect(get(f).usable).toBe(false);
  });
});

describe('book depth, sequence and exact contract conversions', () => {
  it.each([
    { price: '2000.01' }, { price: '2000.0' }, { quantityContracts: '1.5', quantityBase: '0.015' },
    { quantityBase: '3' }, { quantityBase: '0' }, { quantityBase: 0.03 }, { orderCount: '1.5' }, { extra: true },
  ])('rejects malformed or forged perpetual level %j', patch => {
    const f = fixture(); Object.assign(mutate(f, 'books', 1).bids[0], patch); expect(get(f).reasons).toContain('book-grid-or-units-invalid');
  });
  it.each([
    (b: Record<string, any>) => { b.bids = []; },
    (b: Record<string, any>) => { b.asks = null; },
    (b: Record<string, any>) => { b.bids[1] = structuredClone(b.bids[0]); },
    (b: Record<string, any>) => { b.bids[0].price = '2001'; },
    (b: Record<string, any>) => { b.bids.push({ price: '1900', quantityContracts: '3', quantityBase: '0.03', orderCount: '1' }); },
  ])('rejects empty/unbounded/crossed/duplicate books', change => {
    const f = fixture(); change(mutate(f, 'books', 1)); expect(get(f).reasons).toContain('book-grid-or-units-invalid');
  });
  it.each([{ quantityBase: '0.031' }, { quantityContracts: '3' }, { price: '2000.01' }])('checks Spot base quantity/tick units %j', patch => {
    const f = fixture(); Object.assign(mutate(f, 'books', 3).bids[0], patch); expect(get(f, 'okx-spot').reasons).toContain('book-grid-or-units-invalid');
  });
  it.each([
    { appliedUpdates: 0 }, { appliedUpdates: 11 }, { version: '9007199254741004' }, { bootstrapVersion: '9007199254741004' },
    { verifiedDepth: 49 }, { entireBookKnown: true }, { evaluatedAt: at + 1 }, { evaluatedAt: at - 201 },
  ])('requires coherent reconstructed MEXC evidence %j', patch => {
    const f = fixture(); Object.assign(mutate(f, 'books', 0), patch); expect(get(f, 'mexc-perpetual').reasons).toContain('book-invalid');
  });
  it.each([
    (b: Record<string, any>) => { b.bids.pop(); }, (b: Record<string, any>) => { b.knownLevels.bids = 49; },
    (b: Record<string, any>) => { b.knownLevels.asks = 10001; }, (b: Record<string, any>) => { b.knownRange.bidFloor = '1952'; },
    (b: Record<string, any>) => { b.knownRange.askCeiling = '2049'; },
  ])('does not substitute incomplete/out-of-range MEXC depth', change => {
    const f = fixture(); change(mutate(f, 'books', 0)); expect(get(f, 'mexc-perpetual').reasons).toContain('book-grid-or-units-invalid');
  });
  it('does not promote an old MEXC REST-only kind into a WS reconstructed book', () => {
    const f = fixture(); mutate(f, 'books', 0).kind = 'public-perpetual-book'; expect(get(f, 'mexc-perpetual').usable).toBe(false);
  });
});

describe('direction-specific synchronization bounds', () => {
  it.each([1000, 1001])('checks source skew %i ms independently from receipt', skew => {
    const f = fixture(); mutate(f, 'books', 1).sourceTime.at = at - 200 - skew;
    const report = run(f); expect(report.markets[1].usable).toBe(true);
    expect(report.pairs[0].sourceSkewMs).toBe(skew); expect(report.pairs[0].usableForComparison).toBe(skew === 1000);
    expect(report.pairs[1].usableForComparison).toBe(skew === 1000);
  });
  it.each([1000, 1001])('checks receipt skew %i ms independently from source', skew => {
    const f = fixture(), b = mutate(f, 'books', 1); b.receipt.requestedAt -= skew; b.receipt.receivedAt -= skew;
    // Move metadata back to keep this test about receipt skew, not receipt-before-metadata.
    const s = mutate(f, 'specs', 1); s.receipt.requestedAt = at - 2100; s.receipt.receivedAt = at - 2000; b.metadataReceivedAt = at - 2000;
    const report = run(f); expect(report.markets[1].usable).toBe(true);
    expect(report.pairs[0].receiptSkewMs).toBe(skew); expect(report.pairs[0].usableForComparison).toBe(skew === 1000);
    expect(report.pairs[4].usableForComparison).toBe(true);
  });
  it('keeps missing sources unknown and never invents zero skew', () => {
    const report = run(); expect(report.pairs[2].sourceSkewMs).toBeNull(); expect(report.pairs[2].usableForComparison).toBe(false);
  });
  it('qualifies timing only, with no profit, funding, balances or readiness result', () => {
    const result = run(); expect(result.executable).toBe(false); expect(result).not.toHaveProperty('netEdgeBps'); expect(result).not.toHaveProperty('fundingIncome');
  });
  it.each([0, -1, NaN, Infinity, at + 0.5])('rejects invalid shared evaluation time %s', evaluatedAt => {
    const f = fixture(); expect(() => qualifyJointBooks('BTC', evaluatedAt, f.specs, f.books)).toThrow('invalid-joint-evaluation');
  });
});
