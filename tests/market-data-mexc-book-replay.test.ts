import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { multiply, units } from '../src/market-data/exact-json.js';
import { MarketDataError, publicUrl, type PublicReceipt, type ResearchBase } from '../src/market-data/model.js';
import { mexcDepthBootstrapUrl } from '../src/market-data/mexc-depth-book.js';
import { MexcBookSession, type MexcBookCapture, type MexcBookEvent } from '../src/market-data/mexc-book-session.js';
import { MAX_MEXC_BOOK_ARCHIVE_BYTES, replayMexcBook } from '../src/market-data/mexc-book-replay.js';

// Actual public D0a metadata bytes are reused only as schema fixtures. ALL receipt times,
// books, streams and captures in these tests are synthetic, not network acceptance.
const at = 1_800_000_000_000;
const version = 9007199254740993n;
const d0 = JSON.parse(readFileSync(new URL('../fixtures/market-data/d0-public-20261001.json', import.meta.url), 'utf8')) as {
  report: { observations: { raw: string; receipt: PublicReceipt }[] };
};
function metadataRaw(base: ResearchBase): string {
  const row = d0.report.observations.find(row => row.receipt.url === publicUrl('mexc', base, 'instrument'));
  if (!row) throw Error('missing public schema fixture');
  return row.raw;
}
const metadataReceipt = (base: ResearchBase = 'BTC'): PublicReceipt => ({
  url: publicUrl('mexc', base, 'instrument'), requestedAt: at, receivedAt: at + 100,
});
const bootstrapReceipt = (base: ResearchBase = 'BTC'): PublicReceipt => ({
  url: mexcDepthBootstrapUrl(base), requestedAt: at + 121, receivedAt: at + 2000,
});
function bootstrapRaw(v = version, patch: Record<string, unknown> = {}): string {
  return JSON.stringify({ success: true, code: 0, data: {
    version: String(v), timestamp: at + 1500, cts: null,
    bids: Array.from({ length: 60 }, (_, i) => [2000 - i, 3, 2]),
    asks: Array.from({ length: 60 }, (_, i) => [2001 + i, 5, 1]), ...patch,
  } });
}
const ack = () => JSON.stringify({ channel: 'rs.sub.depth', data: 'success', ts: at + 120 });
const pong = (receivedAt = at + 125) => JSON.stringify({ channel: 'pong', data: receivedAt });
function delta(v: bigint, receivedAt: number, base: ResearchBase = 'BTC', patch: Record<string, unknown> = {}): string {
  return JSON.stringify({ channel: 'push.depth', symbol: `${base}_USDT`, ts: receivedAt - 5,
    data: { version: String(v), cts: receivedAt - 10, bids: [[2000, 7, 2]], asks: [], ...patch } });
}
const session = (base: ResearchBase = 'BTC') => new MexcBookSession(base, metadataRaw(base), metadataReceipt(base));
const sha = (raw: Buffer) => createHash('sha256').update(raw).digest('hex');
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');
const replay = (value: unknown) => { const raw = bytes(value); return replayMexcBook(raw, sha(raw)); };
const clone = <T>(value: T): T => structuredClone(value);

interface Run {
  base: ResearchBase; session: MexcBookSession; events: MexcBookEvent[]; requestCount: number;
  frame(raw: string, receivedAt: number): void;
  bootstrap(raw?: string, receipt?: PublicReceipt): void;
  report(failure?: string | null, endedAt?: number): MexcBookCapture;
}
function run(base: ResearchBase = 'BTC'): Run {
  const s = session(base), events: MexcBookEvent[] = [];
  const result: Run = {
    base, session: s, events, requestCount: 1,
    frame(raw, receivedAt) { events.push(s.acceptFrame(raw, receivedAt)); },
    bootstrap(raw = bootstrapRaw(), receipt = bootstrapReceipt(base)) {
      result.requestCount = 2; events.push(s.acceptBootstrap(raw, receipt));
    },
    report(failure = null, endedAt = at + 2200) {
      return { schema: 1, kind: 'mexc-public-depth-book', base, startedAt: at, endedAt,
        requestCount: result.requestCount, connections: 1, subscriptions: 1, pings: 0,
        socketStartedAt: at + 101, socketOpenedAt: at + 110,
        status: failure === null ? 'complete' : 'incomplete', failure, metadata: s.metadata,
        events, appliedDeltas: s.appliedDeltas, book: failure === null ? s.snapshot(endedAt) : null,
        accountRequests: false, executable: false };
    },
  };
  result.frame(ack(), at + 120);
  return result;
}
function complete(base: ResearchBase = 'BTC', buffered = 0): MexcBookCapture {
  const r = run(base);
  for (let i = 1; i <= buffered; i++) r.frame(delta(version + BigInt(i), at + 200 + i, base), at + 200 + i);
  r.bootstrap();
  for (let i = buffered + 1; i <= 10; i++) r.frame(delta(version + BigInt(i), at + 2100 + i, base), at + 2100 + i);
  return r.report();
}
function failPermanently(s: MexcBookSession, attempt: () => unknown, code: string) {
  expect(attempt).toThrow(code);
  expect(() => s.acceptFrame(pong(at + 3000), at + 3000)).toThrow('book-session-rejected');
  expect(() => s.snapshot(at + 3000)).toThrow('book-session-rejected');
}

describe('deterministic MEXC metadata/bootstrap/buffered stream session', () => {
  it.each(['BTC', 'ETH'] as const)('binds actual public %s metadata schema to explicitly synthetic fresh receipts', base => {
    const s = session(base);
    expect(s.metadata.raw).toBe(metadataRaw(base));
    expect(s.metadata.parsed).toMatchObject({ market: { base, exchange: 'mexc', type: 'perpetual' },
      basePerContract: base === 'BTC' ? '0.0001' : '0.01', executable: false, sourceUpdatedAt: null });
    expect(s.metadata.receipt).toEqual(metadataReceipt(base));
    expect(s.appliedDeltas).toBe(0);
  });
  it.each([0, 1, 5, 10])('reconstructs the same exact book with %i deltas before REST completion', buffered => {
    const value = complete('BTC', buffered);
    const result = replay(value);
    expect(result.book).toMatchObject({ kind: 'mexc-reconstructed-top50', market: { base: 'BTC' },
      bootstrapVersion: String(version), version: String(version + 10n), appliedUpdates: 10,
      verifiedDepth: 50, entireBookKnown: false, bookReconstructed: true, sourceFreshnessVerified: true,
      bookFreshnessVerified: true, executable: false });
    expect(result.book!.bids[0]).toEqual({ price: '2000', quantityContracts: '7', quantityBase: '0.0007', orderCount: '2' });
    expect(result.book!.bids).toHaveLength(50); expect(result.book!.asks).toHaveLength(50);
    expect(result.appliedDeltas).toBe(10);
  });
  it('keeps independent ETH contract/base conversion through replay', () => {
    const result = replay(complete('ETH', 5));
    expect(result.book!.bids[0].quantityBase).toBe('0.07');
    expect(result.book!.market.instrumentId).toBe('ETH_USDT');
    expect(result.book!.bootstrapReceipt.url).toBe(mexcDepthBootstrapUrl('ETH'));
  });
  it('buffers a stream frame before acknowledgement, preserving event arrival order', () => {
    const s = session(), events: MexcBookEvent[] = [];
    events.push(s.acceptFrame(delta(version + 1n, at + 115), at + 115));
    events.push(s.acceptFrame(ack(), at + 120));
    events.push(s.acceptBootstrap(bootstrapRaw(), bootstrapReceipt()));
    for (let i = 2; i <= 10; i++) events.push(s.acceptFrame(delta(version + BigInt(i), at + 2100 + i), at + 2100 + i));
    const value = complete(); value.events = events; value.book = s.snapshot(value.endedAt);
    expect(replay(value).appliedDeltas).toBe(10);
    expect(events.map(e => e.kind).slice(0, 3)).toEqual(['frame', 'frame', 'bootstrap']);
  });
  it('discards covered buffered versions and bridges snapshot+1 without recounting old data', () => {
    const r = run();
    for (let i = -3; i <= 4; i++) r.frame(delta(version + BigInt(i), at + 210 + i), at + 210 + i);
    r.bootstrap(); expect(r.session.appliedDeltas).toBe(4);
    for (let i = 5; i <= 10; i++) r.frame(delta(version + BigInt(i), at + 2100 + i), at + 2100 + i);
    expect(replay(r.report()).book).toMatchObject({ version: String(version + 10n), appliedUpdates: 10 });
  });
  it('waits while the REST version is ahead of buffered and subsequent WS messages', () => {
    const r = run();
    for (let i = 0; i <= 2; i++) r.frame(delta(version + BigInt(i), at + 200 + i), at + 200 + i);
    r.bootstrap(bootstrapRaw(version + 4n)); expect(r.session.appliedDeltas).toBe(0);
    for (let i = 3; i <= 14; i++) r.frame(delta(version + BigInt(i), at + 2100 + i), at + 2100 + i);
    expect(replay(r.report()).book).toMatchObject({ bootstrapVersion: String(version + 4n), version: String(version + 14n), appliedUpdates: 10 });
  });
  it('can apply more than ten buffered updates atomically when the bootstrap arrives', () => {
    const r = run();
    for (let i = 1; i <= 12; i++) r.frame(delta(version + BigInt(i), at + 200 + i), at + 200 + i);
    r.bootstrap(); const value = r.report(null, at + 2000);
    expect(replay(value).appliedDeltas).toBe(12); expect(value.book!.version).toBe(String(version + 12n));
  });
  it('does not promote a bootstrap or covered old deltas into an updated book', () => {
    const s = session();
    s.acceptFrame(delta(version, at + 200), at + 200);
    s.acceptBootstrap(bootstrapRaw(), bootstrapReceipt());
    expect(s.appliedDeltas).toBe(0);
    failPermanently(s, () => s.snapshot(at + 2200), 'depth-book-no-update');
  });
  it('does not count acknowledgements/pongs as updates', () => {
    const r = run(); r.frame(pong(), at + 125); r.bootstrap();
    expect(r.session.appliedDeltas).toBe(0);
    expect(replay(r.report('book-stream-timeout')).appliedDeltas).toBe(0);
  });
  it('rejects a missing bootstrap rather than treating deltas as snapshots', () => {
    const s = session(); s.acceptFrame(delta(version + 1n, at + 200), at + 200);
    failPermanently(s, () => s.snapshot(at + 300), 'book-session-missing-bootstrap');
  });
  it('keeps the accepted event prefix and count atomic if applying buffered updates fails', () => {
    const r = run();
    r.frame(delta(version + 1n, at + 200), at + 200);
    r.frame(delta(version + 2n, at + 201, 'BTC', { bids: [[2001, 7, 1]] }), at + 201);
    expect(() => r.bootstrap()).toThrow('crossed-public-book');
    expect(r.events).toHaveLength(3); expect(r.session.appliedDeltas).toBe(0);
    expect(replay(r.report('crossed-public-book'))).toMatchObject({ events: r.events, appliedDeltas: 0, book: null, status: 'incomplete' });
  });
  it('keeps the accepted prefix after a post-bootstrap frame fails', () => {
    const r = run(); r.bootstrap();
    r.frame(delta(version + 1n, at + 2100), at + 2100);
    expect(() => r.frame(delta(version + 2n, at + 2101, 'BTC', { asks: [[1999, 7, 1]] }), at + 2101)).toThrow('crossed-public-book');
    expect(r.session.appliedDeltas).toBe(1); expect(r.events).toHaveLength(3);
    expect(replay(r.report('crossed-public-book'))).toMatchObject({ appliedDeltas: 1, book: null, status: 'incomplete' });
  });
  it('rejects a missing first bridge version atomically', () => {
    const r = run(); r.frame(delta(version + 2n, at + 200), at + 200);
    expect(() => r.bootstrap()).toThrow('depth-book-version-discontinuity');
    expect(r.session.appliedDeltas).toBe(0);
    expect(replay(r.report('depth-book-version-discontinuity')).events).toHaveLength(2);
  });
  it('rejects a gap inside the buffered stream before REST can cover it', () => {
    const r = run(); r.frame(delta(version, at + 200), at + 200);
    failPermanently(r.session, () => r.frame(delta(version + 2n, at + 201), at + 201), 'stream-version-discontinuity');
    expect(replay(r.report('stream-version-discontinuity')).appliedDeltas).toBe(0);
  });
  it.each([null, undefined, at - 10000, at + 10000])('rejects unverifiable source cts %s in the buffer', cts => {
    const s = session(); failPermanently(s, () => s.acceptFrame(delta(version, at + 200, 'BTC', { cts }), at + 200), 'book-session-source-unverified');
  });
  it('rejects a duplicate bootstrap and remains terminal', () => {
    const r = run(); r.bootstrap();
    failPermanently(r.session, () => r.bootstrap(), 'book-session-duplicate-bootstrap');
  });
  it('rejects bootstrap started before metadata was received', () => {
    const s = session(); failPermanently(s, () => s.acceptBootstrap(bootstrapRaw(), { ...bootstrapReceipt(), requestedAt: at + 99 }), 'book-session-timing');
  });
  it('rejects event receipt regression across the asynchronous REST completion', () => {
    const s = session(); s.acceptFrame(delta(version + 1n, at + 2001), at + 2001);
    failPermanently(s, () => s.acceptBootstrap(bootstrapRaw(), bootstrapReceipt()), 'book-session-timing');
  });
  it('does not let later acknowledgements make earlier evaluation times valid', () => {
    const r = run(); r.bootstrap(); r.frame(delta(version + 1n, at + 2100), at + 2100); r.frame(pong(at + 2300), at + 2300);
    failPermanently(r.session, () => r.session.snapshot(at + 2299), 'book-session-timing');
  });
  it('keeps earlier snapshots immutable after exact subsequent updates', () => {
    const r = run(); r.bootstrap(); r.frame(delta(version + 1n, at + 2100), at + 2100);
    const first = r.session.snapshot(at + 2100);
    r.frame(delta(version + 2n, at + 2101, 'BTC', { bids: [[2000, '9007199254740993', 1]] }), at + 2101);
    const second = r.session.snapshot(at + 2101);
    expect(first.bids[0].quantityContracts).toBe('7'); expect(second.bids[0].quantityBase).toBe('900719925474.0993');
    expect(Object.isFrozen(first)).toBe(true); expect(Object.isFrozen(r.events[1])).toBe(true);
  });
});

describe('MEXC reconstructed book archive hash and normalized evidence', () => {
  it('replays deterministically with the exact original receipt and evaluation times', () => {
    const value = complete('ETH', 5); expect(replay(value)).toEqual(value); expect(replay(value)).toEqual(replay(value));
    expect(Object.isFrozen(replay(value).events)).toBe(true);
    expect(value.book!.evaluatedAt).toBe(value.endedAt);
    expect(value.book!.sourceTime.ageMs).toBe(value.endedAt - value.book!.sourceTime.at);
  });
  it('checks bytes, canonical form and SHA before trusting normalized metadata', () => {
    const value = complete(), raw = bytes(value);
    expect(() => replayMexcBook(raw, '0'.repeat(64))).toThrow();
    expect(() => replayMexcBook(raw, sha(raw).toUpperCase())).toThrow();
    for (const bad of [Buffer.concat([raw, Buffer.from('\n')]), Buffer.from(JSON.stringify(value, null, 2) + '\n'),
      Buffer.from([0xff]), Buffer.from(raw.toString().replace('{"schema":1,', '{"schema":1,"schema":1,'))]) {
      expect(() => replayMexcBook(bad, sha(bad))).toThrow();
    }
  });
  it.each(['metadata', 'bootstrap', 'frame', 'book'] as const)('rejects %s normalized tampering even with a newly calculated hash', part => {
    const value = clone(complete());
    if (part === 'metadata') value.metadata!.parsed.basePerContract = '1';
    if (part === 'bootstrap') {
      const event = value.events.find(e => e.kind === 'bootstrap')!;
      if (event.kind === 'bootstrap') Object.assign(event.parsed.bids[0], { quantityBase: '1' });
    }
    if (part === 'frame') {
      const event = value.events.find(e => e.kind === 'frame' && e.parsed.kind === 'delta')!;
      Object.assign(event.parsed, { sourceTimeFresh: false });
    }
    if (part === 'book') Object.assign(value.book!.bids[0], { quantityBase: '999' });
    expect(() => replay(value)).toThrow('invalid-mexc-book-normalization');
  });
  it.each([
    ['version gap', (row: any) => { row.data.version = String(version + 30n); }],
    ['wrong contract', (row: any) => { row.symbol = 'ETH_USDT'; }],
    ['missing time', (row: any) => { delete row.data.cts; }],
    ['zero delete', (row: any) => { row.data.bids[0][1] = 0; }],
  ] as const)('reparses raw stream %s and rejects inconsistent normalized state', (_label, alter) => {
    const value = clone(complete()), event = value.events.find(e => e.kind === 'frame' && e.parsed.kind === 'delta')!;
    const row = JSON.parse(event.raw); alter(row); event.raw = JSON.stringify(row);
    expect(() => replay(value)).toThrow();
  });
  it('checks the final evaluation timestamp and source age instead of copying recorded claims', () => {
    for (const patch of [{ evaluatedAt: at + 2201 }, { sourceTime: { ...complete().book!.sourceTime, ageMs: 0 } },
      { version: String(version + 20n) }, { appliedUpdates: 9 }, { executable: true }, { entireBookKnown: true }]) {
      const value = clone(complete()); Object.assign(value.book!, patch); expect(() => replay(value)).toThrow('invalid-mexc-book-normalization');
    }
  });
  it('rejects a stale final snapshot even if each original frame was fresh on receipt', () => {
    const value = clone(complete()); value.endedAt = at + 8000;
    expect(() => replay(value)).toThrow('depth-book-source-time-unverified');
  });
  it('permits finalization failure after ten updates only as incomplete with no ready book', () => {
    const value = clone(complete()); value.endedAt = at + 26000; value.status = 'incomplete'; value.failure = 'book-capture-deadline'; value.book = null;
    expect(replay(value)).toMatchObject({ status: 'incomplete', appliedDeltas: 10, book: null });
    expect(() => replay({ ...value, status: 'complete', failure: null })).toThrow();
  });
});

describe('closed capture routes, counters, chronology and event budget', () => {
  it.each([
    { schema: 2 }, { kind: 'other' }, { base: 'SOL' }, { accountRequests: true }, { executable: true },
    { status: 'pending' }, { status: 'complete', failure: 'book-stream-closed' },
    { status: 'incomplete', failure: 'raw private server error' }, { status: 'incomplete', failure: null },
    { startedAt: 0 }, { startedAt: at + 1 }, { endedAt: at - 1 }, { endedAt: Number.MAX_SAFE_INTEGER },
    { requestCount: 0 }, { requestCount: 1 }, { requestCount: 3 }, { requestCount: 1.5 },
    { connections: 0 }, { connections: 2 }, { subscriptions: 0 }, { subscriptions: 2 },
    { pings: -1 }, { pings: 2 }, { pings: 1 }, { appliedDeltas: 9 }, { appliedDeltas: 257 }, { appliedDeltas: 10.5 },
    { socketStartedAt: null }, { socketStartedAt: at + 99 }, { socketStartedAt: at + 2201 },
    { socketOpenedAt: null }, { socketOpenedAt: at + 100 }, { socketOpenedAt: at + 2201 },
    { headers: {} }, { events: null }, { metadata: null }, { book: null },
  ])('rejects invalid capture metadata %j', patch => {
    expect(() => replay({ ...complete(), ...patch })).toThrow();
  });
  it.each([
    { url: publicUrl('mexc', 'ETH', 'instrument') }, { url: 'https://example.invalid/' },
    { url: mexcDepthBootstrapUrl('BTC') }, { requestedAt: at - 1 }, { receivedAt: at + 2201 },
    { receivedAt: at + 25000 }, { requestedAt: at - 5001 }, { unexpected: 1 },
  ])('rejects mismatched or unsafe metadata receipt %j', patch => {
    const value = clone(complete()); Object.assign(value.metadata!.receipt, patch); expect(() => replay(value)).toThrow();
  });
  it.each([
    { url: mexcDepthBootstrapUrl('ETH') }, { url: 'https://api.mexc.com/api/v1/contract/depth/BTC_USDT?limit=50' },
    { url: 'https://example.invalid/' }, { requestedAt: at + 119 }, { receivedAt: at + 119 },
    { requestedAt: at + 2001 }, { requestedAt: at - 1001 }, { receivedAt: at + 2201 }, { unexpected: 1 },
  ])('rejects invalid bootstrap receipt %j', patch => {
    const value = clone(complete()), event = value.events.find(e => e.kind === 'bootstrap')!;
    if (event.kind === 'bootstrap') Object.assign(event.receipt, patch); expect(() => replay(value)).toThrow();
  });
  it.each([at + 99, at + 109, at + 119, at + 2201, at + 20101, at + 25000, NaN, 0, 1.5])(
    'rejects frame receipt outside causal/clock window: %s', receivedAt => {
      const value = clone(complete()), event = value.events[2]; if (event.kind === 'frame') event.receivedAt = receivedAt;
      expect(() => replay(value)).toThrow();
    });
  it('rejects a bootstrap without a captured subscription acknowledgement', () => {
    const value = clone(complete()); value.events = value.events.slice(1); expect(() => replay(value)).toThrow();
  });
  it('rejects any event after the atomic target has already been reached', () => {
    const value = clone(complete()), event = value.events[0];
    value.events = [...value.events, { ...event, raw: pong(at + 2199), receivedAt: at + 2199 } as MexcBookEvent];
    expect(() => replay(value)).toThrow('invalid-mexc-book-archive');
  });
  it('rejects duplicate bootstraps, unknown events and extra nested fields', () => {
    const value = clone(complete()), boot = value.events[1];
    for (const events of [[...value.events.slice(0, 2), boot, ...value.events.slice(2)],
      [value.events[0], { ...boot, kind: 'snapshot' }, ...value.events.slice(2)],
      [{ ...value.events[0], cookie: 'not a real cookie' }, ...value.events.slice(1)]]) {
      expect(() => replay({ ...value, events })).toThrow();
    }
  });
  it('checks aggregate 4 MiB raw budget independently of the larger archive budget', () => {
    const r = run(), padded = JSON.stringify({ channel: 'pong', data: at + 125, padding: 'x'.repeat(500000) });
    for (let i = 0; i < 9; i++) r.frame(padded, at + 125 + i);
    const value = r.report('book-raw-budget'); expect(bytes(value).length).toBeLessThan(MAX_MEXC_BOOK_ARCHIVE_BYTES);
    expect(() => replay(value)).toThrow('invalid-mexc-book-archive');
  });
  it('rejects too many frames or an oversized individual raw message', () => {
    const value = run().report('book-stream-timeout');
    const repeated = Array.from({ length: 258 }, () => value.events[0]);
    expect(() => replay({ ...value, events: repeated })).toThrow('invalid-mexc-book-archive');
    const oversized = clone(value); oversized.events[0].raw = ' '.repeat(524289);
    expect(() => replay(oversized)).toThrow('invalid-mexc-book-archive');
  });
  it('accepts exactly 256 control frames as an incomplete accepted prefix', () => {
    const r = run(); for (let i = 0; i < 255; i++) r.frame(pong(at + 125 + i), at + 125 + i);
    expect(replay(r.report('book-stream-frame-budget')).events).toHaveLength(256);
    r.frame(pong(at + 400), at + 400);
    expect(() => replay(r.report('book-stream-frame-budget'))).toThrow('invalid-mexc-book-archive');
  });
  it('bounds one ping from actual socket open time rather than capture start', () => {
    const value = run().report('book-stream-closed', at + 10110); value.pings = 1;
    expect(replay(value).pings).toBe(1);
    expect(() => replay({ ...value, endedAt: at + 10109 })).toThrow();
  });
});

describe('incomplete prefix evidence stays useful without retaining rejected responses', () => {
  it.each([0, 1])('accepts failure before metadata with %i attempted GETs', requestCount => {
    const value: MexcBookCapture = { ...run().report(requestCount === 0 ? 'invalid-public-clock' : 'book-http-unavailable'), metadata: null, events: [],
      connections: 0, subscriptions: 0, pings: 0, requestCount, socketStartedAt: null, socketOpenedAt: null };
    expect(replay(value)).toMatchObject({ metadata: null, events: [], book: null, status: 'incomplete' });
    for (const patch of [{ connections: 1 }, { socketStartedAt: at + 100 }, { requestCount: 2 }, { appliedDeltas: 1 },
      { events: complete().events }, { book: complete().book }]) expect(() => replay({ ...value, ...patch })).toThrow();
  });
  it('accepts failure between verified metadata and socket creation', () => {
    const value = run().report('invalid-public-clock');
    Object.assign(value, { connections: 0, subscriptions: 0, socketStartedAt: null, socketOpenedAt: null, events: [] });
    expect(replay(value)).toMatchObject({ requestCount: 1, connections: 0, metadata: value.metadata, book: null });
  });
  it('accepts a socket failure before open without claiming subscription', () => {
    const value = run().report('book-stream-unavailable'); Object.assign(value, { subscriptions: 0, socketOpenedAt: null, events: [] });
    expect(replay(value)).toMatchObject({ connections: 1, subscriptions: 0, book: null });
  });
  it('accepts an in-flight bootstrap failure while replaying only the accepted WS prefix', () => {
    const r = run(); r.requestCount = 2; r.frame(delta(version + 1n, at + 200), at + 200);
    expect(replay(r.report('book-http-access-denied'))).toMatchObject({ requestCount: 2, appliedDeltas: 0, book: null });
  });
  it('does not retain rejected private-channel or server-error bodies in accepted replay events', () => {
    const r = run();
    expect(() => r.frame(JSON.stringify({ channel: 'rs.error', data: 'DO_NOT_PERSIST_UNTRUSTED_TEXT' }), at + 200)).toThrow('stream-server-error');
    const value = r.report('stream-server-error');
    expect(JSON.stringify(replay(value))).not.toContain('DO_NOT_PERSIST_UNTRUSTED_TEXT');
    const bad = clone(value); bad.events = [...bad.events, { kind: 'frame', raw: JSON.stringify({ channel: 'rs.error', data: 'DO_NOT_PERSIST_UNTRUSTED_TEXT' }),
      receivedAt: at + 200, parsed: value.events[0].parsed as any }];
    expect(() => replay(bad)).toThrow();
  });
  it('rejects an ordinary stream closure after ten successful updates already ended capture', () => {
    const value = complete(); Object.assign(value, { status: 'incomplete', failure: 'book-stream-closed', book: null });
    expect(() => replay(value)).toThrow('invalid-mexc-book-archive');
  });
  it('rejects a book-processing failure before any query, connection or metadata exists', () => {
    const value = run().report('depth-book-invalid-delta');
    Object.assign(value, { metadata: null, requestCount: 0, connections: 0, subscriptions: 0,
      socketStartedAt: null, socketOpenedAt: null, events: [] });
    expect(() => replay(value)).toThrow('invalid-mexc-book-archive');
  });
  it.each(['book-http-unavailable', 'book-http-access-denied', 'book-http-timeout', 'book-response-too-large'])(
    'rejects impossible HTTP failure %s after successful bootstrap, with no further HTTP requests', failure => {
      const r = run(); r.bootstrap(); r.frame(delta(version + 1n, at + 2100), at + 2100);
      expect(() => replay(r.report(failure))).toThrow('invalid-mexc-book-archive');
    });
  it('rejects a claimed ready book on every incomplete archive', () => {
    const value = complete(); value.status = 'incomplete'; value.failure = 'book-stream-closed';
    expect(() => replay(value)).toThrow('invalid-mexc-book-archive');
  });
});


const acceptedPublicBooks = [
  { base: 'BTC', file: 'btc', sha256: 'f50369b8af1941d2faf6e7d4b89c1612a7dd305bf1f2fadc377def8b813d8a48',
    frames: 88, deltas: 87, applied: 52, skipped: 35, ageMs: 770, bootstrapIndex: 88 },
  { base: 'ETH', file: 'eth', sha256: '3091f508d803e416a216890d9aa771a74148311f4f2276ccb5ed8ebced4ed64a',
    frames: 11, deltas: 10, applied: 10, skipped: 0, ageMs: 169, bootstrapIndex: 1 },
] as const;

describe.each(acceptedPublicBooks)('pinned actual public $base reconstruction captured 2026-10-01', expected => {
  const directory = '../fixtures/market-data/';
  const raw = readFileSync(new URL(`${directory}mexc-book-${expected.file}-public-20261001.json`, import.meta.url));
  const manifestRaw = readFileSync(new URL(`${directory}mexc-book-${expected.file}-public-20261001.manifest.json`, import.meta.url), 'utf8');
  const manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
  const observed = () => replayMexcBook(raw, expected.sha256);

  it('matches the pinned bytes and exact public-only manifest, independent of a replaceable manifest hash', () => {
    expect(sha(raw)).toBe(expected.sha256);
    expect(manifestRaw).toBe(JSON.stringify(manifest) + '\n');
    expect(manifest).toEqual({ schema: 1, kind: 'mexc-public-depth-book-manifest',
      sha256: expected.sha256, publicDataOnly: true, executable: false });
  });
  it('replays the accepted two-GET one-socket capture with its actual number of updates', () => {
    const value = observed(), frames = value.events.filter(e => e.kind === 'frame');
    expect(value).toMatchObject({ schema: 1, kind: 'mexc-public-depth-book', base: expected.base,
      requestCount: 2, connections: 1, subscriptions: 1, pings: 0, status: 'complete', failure: null,
      appliedDeltas: expected.applied, accountRequests: false, executable: false });
    expect(frames).toHaveLength(expected.frames); expect(value.events).toHaveLength(expected.frames + 1);
    expect(value.book).toMatchObject({ appliedUpdates: expected.applied, verifiedDepth: 50,
      bookReconstructed: true, bookFreshnessVerified: true, sourceFreshnessVerified: true,
      entireBookKnown: false, executable: false });
    expect(value.metadata!.receipt.url).toBe(publicUrl('mexc', expected.base, 'instrument'));
    expect(value.book!.bootstrapReceipt.url).toBe(mexcDepthBootstrapUrl(expected.base));
  });
  it('accounts for every covered and applied WS version across the actual REST bootstrap boundary', () => {
    const value = observed(), bootstrapIndex = value.events.findIndex(e => e.kind === 'bootstrap');
    const bootstrap = value.events[bootstrapIndex];
    if (bootstrap.kind !== 'bootstrap') throw Error('missing accepted bootstrap');
    const deltas = value.events.flatMap(e => e.kind === 'frame' && e.parsed.kind === 'delta' ? [e] : []);
    expect(bootstrapIndex).toBe(expected.bootstrapIndex);
    expect(bootstrap.parsed.bids).toHaveLength(1000); expect(bootstrap.parsed.asks).toHaveLength(1000);
    expect(bootstrap.parsed.sourceFreshnessVerified).toBe(false);
    expect(bootstrap.parsed.sourceTime.meaning).toBe('exchange-system');
    expect(deltas).toHaveLength(expected.deltas);
    const versions = deltas.map(e => {
      if (e.parsed.kind !== 'delta') throw Error('unexpected frame');
      return BigInt(e.parsed.version);
    });
    const initial = BigInt(bootstrap.parsed.version);
    expect(versions.filter(v => v <= initial)).toHaveLength(expected.skipped);
    expect(versions.filter(v => v > initial)).toHaveLength(expected.applied);
    expect(expected.skipped + expected.applied).toBe(expected.deltas);
    for (let i = 1; i < versions.length; i++) expect(versions[i]).toBe(versions[i - 1] + 1n);
    expect(BigInt(value.book!.version) - initial).toBe(BigInt(expected.applied));
    expect(value.book!.version).toBe(String(versions.at(-1)));
    if (expected.base === 'BTC') {
      // The target is crossed atomically while replaying a buffered prefix: 52, not exactly ten.
      expect(deltas.every(e => e.receivedAt < bootstrap.receipt.receivedAt)).toBe(true);
      expect(value.events.at(-1)!.kind).toBe('bootstrap');
    } else {
      expect(deltas.every(e => e.receivedAt >= bootstrap.receipt.receivedAt)).toBe(true);
    }
  });
  it('uses historical matching-engine age and preserves exact top50 quantities within the known range', () => {
    const value = observed(), book = value.book!;
    expect(book.evaluatedAt).toBe(value.endedAt);
    expect(book.sourceTime).toMatchObject({ meaning: 'matching-engine-book-production',
      representsUpdate: true, ageMs: expected.ageMs });
    expect(book.evaluatedAt - book.sourceTime.at).toBe(expected.ageMs);
    expect(book.bids).toHaveLength(50); expect(book.asks).toHaveLength(50);
    for (const side of ['bids', 'asks'] as const) {
      const levels = book[side];
      for (let i = 0; i < levels.length; i++) {
        expect(levels[i].quantityBase).toBe(multiply(levels[i].quantityContracts, value.metadata!.parsed.basePerContract));
        expect(units(levels[i].quantityContracts)).toBeGreaterThan(0n);
        if (side === 'bids') expect(units(levels[i].price)).toBeGreaterThanOrEqual(units(book.knownRange.bidFloor));
        else expect(units(levels[i].price)).toBeLessThanOrEqual(units(book.knownRange.askCeiling));
        if (i > 0) {
          if (side === 'bids') expect(units(levels[i - 1].price)).toBeGreaterThan(units(levels[i].price));
          else expect(units(levels[i - 1].price)).toBeLessThan(units(levels[i].price));
        }
      }
    }
    expect(units(book.bids[0].price)).toBeLessThan(units(book.asks[0].price));
  });
});
