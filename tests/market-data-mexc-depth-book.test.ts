import { describe, expect, it } from 'vitest';
import { parsePublicJson } from '../src/market-data/exact-json.js';
import { parseMexcInstrument } from '../src/market-data/mexc.js';
import { MarketDataError, publicUrl, type InstrumentSpec, type PublicReceipt, type ResearchBase } from '../src/market-data/model.js';
import { DEPTH_BOOK_FAILURES, MEXC_DEPTH_BOOK_LIMITS, MexcDepthBook, mexcDepthBootstrapUrl, parseMexcDepthBootstrap,
  type MexcDepthBootstrap } from '../src/market-data/mexc-depth-book.js';
import { MexcDepthStreamEvidence, type MexcDepthStreamDelta } from '../src/market-data/mexc-depth-stream.js';

// All market messages here are synthetic; none certify exchange API acceptance.
const at = 1_800_000_000_000;
const initialVersion = '9007199254740993';
const decode = (body: unknown) => parsePublicJson(Buffer.from(JSON.stringify(body)));
const spec = (base: ResearchBase = 'BTC', receivedAt = at - 1000): InstrumentSpec => parseMexcInstrument(decode({
  success: true, code: 0, data: { symbol: `${base}_USDT`, baseCoin: base, quoteCoin: 'USDT', settleCoin: 'USDT', futureType: 1,
    type: 1, contractSize: base === 'BTC' ? '0.0001' : '0.01', priceUnit: base === 'BTC' ? '0.1' : '0.01',
    volUnit: 1, minVol: 1, state: 0, apiAllowed: true, preMarket: false, automaticDelivery: 0 },
}), base, { url: publicUrl('mexc', base, 'instrument'), requestedAt: receivedAt - 100, receivedAt });
const receipt = (base: ResearchBase = 'BTC'): PublicReceipt => ({ url: mexcDepthBootstrapUrl(base), requestedAt: at - 100, receivedAt: at });
const data = (n = 60) => ({ bids: Array.from({ length: n }, (_, i) => [2000 - i, 3, 2]),
  asks: Array.from({ length: n }, (_, i) => [2001 + i, 5, 1]), version: initialVersion, timestamp: at - 150, cts: null });
const raw = (patch: Record<string, unknown> = {}, n = 60) => decode({ success: true, code: 0, data: { ...data(n), ...patch } });
const bootstrap = (base: ResearchBase = 'BTC', n = 60) => parseMexcDepthBootstrap(raw({}, n), base, receipt(base), spec(base));
const book = (base: ResearchBase = 'BTC', n = 60) => new MexcDepthBook(spec(base), bootstrap(base, n));
const delta = (patch: Record<string, unknown> = {}, receivedAt = at + 100, base: ResearchBase = 'BTC'): MexcDepthStreamDelta =>
  new MexcDepthStreamEvidence(base).accept(JSON.stringify({ channel: 'push.depth', symbol: `${base}_USDT`, ts: receivedAt - 10,
    data: { version: (BigInt(initialVersion) + 1n).toString(), cts: receivedAt - 20, bids: [], asks: [], ...patch },
  }), receivedAt) as MexcDepthStreamDelta;

function rejectsPermanently(b: MexcDepthBook, run: () => unknown, code: string) {
  expect(run).toThrow(code); expect(() => b.apply(delta())).toThrow('depth-book-already-rejected');
  expect(() => b.snapshot(at + 100)).toThrow('depth-book-already-rejected');
}

describe('fixed MEXC REST bootstrap for bounded known depth', () => {
  it.each(['BTC', 'ETH'] as const)('binds %s public metadata and exact contract conversion', base => {
    const result = bootstrap(base);
    expect(result).toMatchObject({ schema: 1, kind: 'mexc-depth-bootstrap', market: { exchange: 'mexc', type: 'perpetual', base },
      version: initialVersion, metadataReceivedAt: at - 1000, identityBinding: 'request',
      knownRange: { bidFloor: '1941', askCeiling: '2060' }, sourceFreshnessVerified: false,
      sourceTime: { at: at - 150, meaning: 'exchange-system', representsUpdate: false },
      bookReconstructed: false, executable: false });
    expect(result.bids[0].quantityBase).toBe(base === 'BTC' ? '0.0003' : '0.03');
    expect(mexcDepthBootstrapUrl(base)).toBe(`https://api.mexc.com/api/v1/contract/depth/${base}_USDT?limit=1000`);
  });
  it.each([50, 1000])('accepts exactly %i levels per side without truncating', n => {
    expect(bootstrap('BTC', n).bids).toHaveLength(n);
    expect(bootstrap('BTC', n).asks).toHaveLength(n);
  });
  it.each([0, 1, 49, 1001])('rejects insufficient/unbounded depth %i', n => {
    expect(() => bootstrap('BTC', n)).toThrow('invalid-depth-bootstrap');
  });
  it('checks an optional identity echo without assuming its existence', () => {
    expect(parseMexcDepthBootstrap(raw({ symbol: 'BTC_USDT' }), 'BTC', receipt(), spec()).identityBinding).toBe('request-and-response');
    expect(() => parseMexcDepthBootstrap(raw({ symbol: 'ETH_USDT' }), 'BTC', receipt(), spec())).toThrow('unsupported-public-contract');
  });
  it('preserves exact numbers above IEEE safe integers', () => {
    const body = JSON.stringify({ success: true, code: 0, data: data() }).replace('"9007199254740993"', '9007199254740993')
      .replace('[2000,3,2]', '[2000,9007199254740993,9007199254740995]');
    const result = parseMexcDepthBootstrap(parsePublicJson(Buffer.from(body)), 'BTC', receipt(), spec());
    expect(result.version).toBe(initialVersion);
    expect(result.bids[0]).toMatchObject({ quantityContracts: '9007199254740993', quantityBase: '900719925474.0993', orderCount: '9007199254740995' });
  });
  it('rejects native Number quantities that bypass exact JSON decoding', () => {
    expect(() => parseMexcDepthBootstrap({ success: true, code: '0', data: data() }, 'BTC', receipt(), spec())).toThrow('invalid-public-number');
  });
  it.each([undefined, null, at - 1, at + 99_999])('does not transfer WS time semantics to REST cts: %s', cts => {
    const result = parseMexcDepthBootstrap(raw({ cts }), 'BTC', receipt(), spec());
    expect(result.auxiliaryTimestamp).toBe(cts ?? null); expect(result.auxiliaryTimestampVerified).toBe(false);
    expect(result.sourceFreshnessVerified).toBe(false);
  });
  it.each([undefined, null, '', at - 999_999, at + 999_999])('keeps REST system timestamp unverified: %s', timestamp => {
    expect(parseMexcDepthBootstrap(raw({ timestamp }), 'BTC', receipt(), spec()).sourceFreshnessVerified).toBe(false);
  });
  it.each([
    { version: null }, { version: '-1' }, { version: '1.5' }, { version: '01' }, { version: '1e3' },
    { version: '1000000000000000000000000000000' }, { timestamp: -1 }, { cts: '' },
    { bids: null }, { asks: [] }, { symbol: null },
  ])('rejects malformed bootstrap schema %j', patch => {
    expect(() => parseMexcDepthBootstrap(raw(patch), 'BTC', receipt(), spec())).toThrow(MarketDataError);
  });
  it.each([
    [0, 1, 1], ['NaN', 1, 1], [2000.01, 1, 1], [2000, 0, 1], [2000, -1, 1], [2000, 1.5, 1],
    [2000, 1, -1], [2000, 1, 1.5], [2000, 1], [2000, 1, 1, 0], [1999, 1, 1],
  ])('rejects invalid, duplicate or off-grid first level %j', (...entry) => {
    const rows = data().bids; rows[0] = entry as number[];
    expect(() => parseMexcDepthBootstrap(raw({ bids: rows }), 'BTC', receipt(), spec())).toThrow(MarketDataError);
  });
  it('rejects a crossed snapshot', () => {
    const rows = data().bids; rows[0] = [2001, 1, 1];
    expect(() => parseMexcDepthBootstrap(raw({ bids: rows }), 'BTC', receipt(), spec())).toThrow('crossed-public-book');
  });
  it.each([
    { url: 'https://api.mexc.com/api/v1/contract/depth/BTC_USDT?limit=50' },
    { url: 'https://api.mexc.com/api/v1/contract/depth/ETH_USDT?limit=1000' },
    { url: 'https://example.invalid/' }, { requestedAt: at + 1 }, { requestedAt: at - 3001 },
    { requestedAt: at - 100.5 }, { receivedAt: NaN }, { receivedAt: '1800000000000' }, { unexpected: true },
  ])('rejects an invalid bootstrap receipt %j', patch => {
    expect(() => parseMexcDepthBootstrap(raw(), 'BTC', { ...receipt(), ...patch } as PublicReceipt, spec())).toThrow(MarketDataError);
  });
  it.each([
    () => spec('ETH'), () => spec('BTC', at - 1_200_101), () => spec('BTC', at - 99),
    () => ({ ...spec(), baseQuantityStep: '99' }), () => ({ ...spec(), priceTick: '0' }),
    () => ({ ...spec(), receipt: { ...spec().receipt, url: publicUrl('okx', 'BTC', 'instrument') } }),
  ])('requires fresh same-market correctly derived metadata', makeSpec => {
    expect(() => parseMexcDepthBootstrap(raw(), 'BTC', receipt(), makeSpec())).toThrow(MarketDataError);
  });
  it('accepts the exact 20-minute metadata age boundary', () => {
    expect(parseMexcDepthBootstrap(raw(), 'BTC', receipt(), spec('BTC', at - 1_200_100)).metadataReceivedAt).toBe(at - 1_200_100);
  });
  it('freezes copied evidence', () => {
    const r = receipt(), result = parseMexcDepthBootstrap(raw(), 'BTC', r, spec()); r.receivedAt += 1;
    expect(result.receipt.receivedAt).toBe(at);
    for (const row of [result, result.receipt, result.bids, result.bids[0], result.knownRange, result.sourceTime]) expect(Object.isFrozen(row)).toBe(true);
  });
});

describe('bounded continuous book reconstruction', () => {
  it.each(['BTC', 'ETH'] as const)('produces only verified %s top50 after a continuous matching-engine update', base => {
    const b = book(base); expect(b.apply(delta({ bids: [[2000, 7, 2]] }, at + 100, base))).toBe(true);
    const result = b.snapshot(at + 110);
    expect(result).toMatchObject({ market: { base }, kind: 'mexc-reconstructed-top50', bootstrapVersion: initialVersion,
      version: '9007199254740994', appliedUpdates: 1, verifiedDepth: 50, entireBookKnown: false, bookReconstructed: true,
      bookFreshnessVerified: true, sourceFreshnessVerified: true, executable: false,
      knownLevels: { bids: 60, asks: 60 }, sourceTime: { at: at + 80, ageMs: 30, representsUpdate: true } });
    expect(result.bids).toHaveLength(50); expect(result.asks).toHaveLength(50);
    expect(result.bids[0].quantityContracts).toBe('7'); expect(result.bids[0].quantityBase).toBe(base === 'BTC' ? '0.0007' : '0.07');
  });
  it('never promotes bootstrap alone to a current book', () => {
    const b = book(); rejectsPermanently(b, () => b.snapshot(at), 'depth-book-no-update');
  });
  it('skips buffered old versions and applies version snapshot+1 even when already observed before REST completion', () => {
    const b = book();
    expect(b.apply(delta({ version: '9007199254740992' }, at - 50))).toBe(false);
    expect(b.apply(delta({ version: initialVersion }, at - 40))).toBe(false);
    expect(b.apply(delta({}, at - 30))).toBe(true);
    expect(b.snapshot(at)).toMatchObject({ appliedUpdates: 1, receivedAt: at - 30, sourceTime: { at: at - 50, ageMs: 50 } });
  });
  it.each(['9007199254740995', '9007199254740999'])('rejects a first-new gap at %s', version => {
    const b = book(); rejectsPermanently(b, () => b.apply(delta({ version })), 'depth-book-version-discontinuity');
  });
  it.each(['9007199254740993', '9007199254740994', '9007199254740996'])('rejects backwards, duplicate or skipped later version %s', version => {
    const b = book(); b.apply(delta());
    rejectsPermanently(b, () => b.apply(delta({ version }, at + 101)), 'depth-book-version-discontinuity');
  });
  it('uses absolute quantity, deletes zero and maintains exact ordering with inserted levels', () => {
    const b = book(); b.apply(delta({ bids: [[2000, 7, 2], [1999, 0, 0], [1999.5, 2, 1]], asks: [[2001, 0, 0], [2001.5, 1, 1]] }));
    const result = b.snapshot(at + 100);
    expect(result.bids.slice(0, 3).map(x => [x.price, x.quantityContracts])).toEqual([['2000', '7'], ['1999.5', '2'], ['1998', '3']]);
    expect(result.asks[0].price).toBe('2001.5');
  });
  it('applies both sides before crossing validation', () => {
    const b = book(); b.apply(delta({ asks: [[2001, 0, 0], [2002, 0, 0]], bids: [[2001, 7, 2]] }));
    expect(b.snapshot(at + 100).bids[0].price).toBe('2001');
    expect(b.snapshot(at + 100).asks[0].price).toBe('2003');
  });
  it('rejects a crossed reconstructed spread', () => {
    const b = book(); rejectsPermanently(b, () => b.apply(delta({ bids: [[2001, 7, 2]] })), 'crossed-public-book');
  });
  it('ignores out-of-range additions and deletion while preserving initial known boundaries', () => {
    const b = book(); b.apply(delta({ bids: [[1900, 1000, 1], [1899, 0, 0]], asks: [[2100, 1000, 1]] }));
    expect(b.snapshot(at + 100)).toMatchObject({ knownLevels: { bids: 60, asks: 60 }, knownRange: { bidFloor: '1941', askCeiling: '2060' } });
  });
  it('does not use observed isolated deeper levels to replace unknown depth', () => {
    const b = book('BTC', 50);
    rejectsPermanently(b, () => b.apply(delta({ bids: [[2000, 0, 0], [1900, 9999, 1]] })), 'depth-book-range-exhausted');
  });
  it.each(['bids', 'asks'] as const)('rejects exhausted %s depth', side => {
    const b = book('BTC', 50), price = side === 'bids' ? 2000 : 2001;
    rejectsPermanently(b, () => b.apply(delta({ [side]: [[price, 0, 0]] })), 'depth-book-range-exhausted');
  });
  it('accepts exactly 50 known levels after ten deletions from a deeper bootstrap', () => {
    const b = book(); b.apply(delta({ bids: Array.from({ length: 10 }, (_, i) => [2000 - i, 0, 0]) }));
    expect(b.snapshot(at + 100)).toMatchObject({ knownLevels: { bids: 50, asks: 60 } });
  });
  it.each([{ bids: [[2000.01, 1, 1]] }, { asks: [[2001, 1.5, 1]] }, { bids: [[1900.01, 0, 0]] }])('rejects off-grid delta even outside tracked range: %j', patch => {
    const b = book(); rejectsPermanently(b, () => b.apply(delta(patch)), 'depth-book-invalid-delta');
  });
  it('retains old returned snapshots unchanged after later updates', () => {
    const b = book(); b.apply(delta()); const first = b.snapshot(at + 100);
    b.apply(delta({ version: '9007199254740995', bids: [[2000, 99, 1]] }, at + 101));
    expect(first.bids[0].quantityContracts).toBe('3'); expect(b.snapshot(at + 101).bids[0].quantityContracts).toBe('99');
    for (const item of [first, first.bids, first.bids[0], first.market, first.sourceTime, first.knownRange, first.knownLevels]) expect(Object.isFrozen(item)).toBe(true);
  });
});

describe('freshness, chronology and normalized-boundary tampering', () => {
  it.each([null, undefined, at - 5001, at + 5101])('rejects absent/stale/future source cts %s permanently', cts => {
    const b = book(); rejectsPermanently(b, () => b.apply(delta({ cts })), 'depth-book-source-time-unverified');
  });
  it('checks source age again when evaluating an otherwise once-fresh book', () => {
    const b = book(); b.apply(delta());
    rejectsPermanently(b, () => b.snapshot(at + 5081), 'depth-book-source-time-unverified');
  });
  it('accepts exactly five seconds source age and does not refresh time using idle evaluation', () => {
    const b = book(); b.apply(delta());
    expect(b.snapshot(at + 5080).sourceTime.ageMs).toBe(5000);
  });
  it('checks monotonic engine time even when using individually decoded delta objects', () => {
    const b = book(); b.apply(delta());
    rejectsPermanently(b, () => b.apply(delta({ version: '9007199254740995', cts: at + 79 }, at + 101)), 'depth-book-source-time-regression');
  });
  it('accepts equal engine times', () => {
    const b = book(); b.apply(delta()); b.apply(delta({ version: '9007199254740995', cts: at + 80 }, at + 101));
    expect(b.snapshot(at + 101).appliedUpdates).toBe(2);
  });
  it.each([0, -1, NaN, Infinity, at - 1, at + 99, 1.5])('rejects invalid final evaluation %s', time => {
    const b = book(); b.apply(delta()); rejectsPermanently(b, () => b.snapshot(time), 'depth-book-invalid-evaluation');
  });
  it('rejects evaluation clock rollback', () => {
    const b = book(); b.apply(delta()); b.snapshot(at + 101);
    rejectsPermanently(b, () => b.snapshot(at + 100), 'depth-book-invalid-evaluation');
  });
  it('rejects delta receipt clock rollback', () => {
    const b = book(); b.apply(delta());
    rejectsPermanently(b, () => b.apply(delta({ version: '9007199254740995', cts: at + 80 }, at + 99)), 'depth-book-invalid-delta');
  });
  it('rejects a delayed metadata-bound update even when the delta itself is fresh', () => {
    const b = book(); rejectsPermanently(b, () => b.apply(delta({}, at + 1_200_001)), 'depth-book-stale-metadata');
  });
  it('rechecks metadata age at evaluation independently of source freshness', () => {
    const s = spec('BTC', at - 1_199_950), boot = parseMexcDepthBootstrap(raw(), 'BTC', receipt(), s), b = new MexcDepthBook(s, boot);
    b.apply(delta({}, at + 40));
    rejectsPermanently(b, () => b.snapshot(at + 51), 'depth-book-stale-metadata');
  });
  it('rejects a conflicting symbol even for an old buffered delta', () => {
    const b = book(); rejectsPermanently(b, () => b.apply(delta({ version: initialVersion }, at + 100, 'ETH')), 'unsupported-stream-symbol');
  });
  it.each([
    { sourceFreshnessVerified: true }, { executable: true }, { version: '01' }, { knownRange: { bidFloor: '1', askCeiling: '9999' } },
    { market: { ...bootstrap().market, exchange: 'okx' } }, { metadataReceivedAt: at }, { identityBinding: 'unknown' },
    { bids: bootstrap().bids.map((x, i) => i ? x : { ...x, quantityBase: '9' }) },
  ])('revalidates normalized bootstrap rather than trusting forged fields %j', patch => {
    expect(() => new MexcDepthBook(spec(), { ...bootstrap(), ...patch } as MexcDepthBootstrap)).toThrow(MarketDataError);
  });
  it.each([
    { sourceTimeFresh: false }, { sourceTime: { ...delta().sourceTime, ageMs: 0 } }, { bookReconstructed: true },
    { executable: true }, { previousVersion: '1e3' }, { receivedAt: '1800000000100' },
    { bids: [{ ...delta({ bids: [[2000, 1, 1]] }).bids[0], action: 'delete' }] },
  ])('revalidates normalized delta rather than trusting forged fields %j', patch => {
    const b = book(); expect(() => b.apply({ ...delta(), ...patch } as MexcDepthStreamDelta)).toThrow(MarketDataError);
    expect(() => b.apply(delta())).toThrow('depth-book-already-rejected');
  });
  it('exports immutable unique closed failure codes and resource bounds', () => {
    expect(Object.isFrozen(DEPTH_BOOK_FAILURES)).toBe(true);
    expect(new Set(DEPTH_BOOK_FAILURES).size).toBe(DEPTH_BOOK_FAILURES.length);
    expect(Object.isFrozen(MEXC_DEPTH_BOOK_LIMITS)).toBe(true);
  });
});

describe('standalone reconstruction rejects discontinuous buffered evidence', () => {
  it.each(['9007199254740990', '9007199254740992'])('rejects duplicate/gap old buffered version %s', version => {
    const b = book(); b.apply(delta({ version: '9007199254740990' }, at - 50));
    rejectsPermanently(b, () => b.apply(delta({ version }, at - 49)), 'depth-book-version-discontinuity');
  });
  it('rejects a contradictory previousVersion even on its first observation', () => {
    const b = book(); rejectsPermanently(b, () => b.apply({ ...delta(), previousVersion: '1' }), 'depth-book-version-discontinuity');
  });
  it('accepts truthful previousVersion evidence', () => {
    const b = book(); b.apply({ ...delta(), previousVersion: initialVersion });
    b.apply({ ...delta({ version: '9007199254740995' }, at + 101), previousVersion: '9007199254740994' });
    expect(b.snapshot(at + 101).appliedUpdates).toBe(2);
  });
  it.each(['1e-1', '0.10'])('rejects noncanonical normalized metadata tick %s before BigInt arithmetic', priceTick => {
    expect(() => parseMexcDepthBootstrap(raw(), 'BTC', receipt(), { ...spec(), priceTick })).toThrow('observation-spec-mismatch');
  });
  it.each([{ bids: {} }, { asks: null }, { bids: [null] }])('rejects malformed normalized bootstrap with fixed codes %j', patch => {
    try { new MexcDepthBook(spec(), { ...bootstrap(), ...patch } as unknown as MexcDepthBootstrap); throw new Error('unexpected acceptance'); }
    catch (error) { expect(error).toBeInstanceOf(MarketDataError); expect(DEPTH_BOOK_FAILURES).toContain((error as MarketDataError).code); }
  });
  it('rejects malformed normalized delta levels with fixed codes', () => {
    const b = book();
    try { b.apply({ ...delta(), bids: [null] } as unknown as MexcDepthStreamDelta); throw new Error('unexpected acceptance'); }
    catch (error) { expect(error).toBeInstanceOf(MarketDataError); expect(DEPTH_BOOK_FAILURES).toContain((error as MarketDataError).code); }
    expect(() => b.apply(delta())).toThrow('depth-book-already-rejected');
  });
});

describe('bounded reconstruction storage', () => {
  it('stops rather than retaining more than 10000 known levels per side', () => {
    const b = book('ETH', 1000);
    const inserted = Array.from({ length: 9001 }, (_, i) => {
      const cents = 200000 - Math.floor(i / 99) * 100 - (i % 99 + 1);
      return [`${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`, '1', '1'];
    });
    for (let batch = 0; batch < 4; batch++) {
      b.apply(delta({ version: (BigInt(initialVersion) + BigInt(batch + 1)).toString(),
        bids: inserted.slice(batch * 2000, (batch + 1) * 2000) }, at + 100 + batch, 'ETH'));
    }
    expect(b.snapshot(at + 103).knownLevels.bids).toBe(9000);
    rejectsPermanently(b, () => b.apply(delta({ version: (BigInt(initialVersion) + 5n).toString(),
      bids: inserted.slice(8000) }, at + 104, 'ETH')), 'depth-book-capacity-exceeded');
  });
  it('copies mutable normalized metadata so the caller cannot change conversion after initialization', () => {
    const s = structuredClone(spec()), b = new MexcDepthBook(s, bootstrap());
    s.basePerContract = '99'; s.priceTick = '7';
    b.apply(delta({ bids: [[2000, 7, 2]] }));
    expect(b.snapshot(at + 100).bids[0].quantityBase).toBe('0.0007');
  });
});
