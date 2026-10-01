import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MexcDepthStreamEvidence } from '../src/market-data/mexc-depth-stream.js';
import { MexcDepthSourceClient, MEXC_DEPTH_SOURCE_URL, type DepthSocket, type DepthSourceCapture } from '../src/market-data/mexc-depth-source-client.js';
import { MAX_DEPTH_SOURCE_ARCHIVE_BYTES, replayMexcDepthSource } from '../src/market-data/mexc-depth-source-replay.js';

const now = 1_790_854_940_000;
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');
const replay = (value: unknown) => { const raw = bytes(value); return replayMexcDepthSource(raw, sha(raw)); };
const ack = () => JSON.stringify({ channel: 'rs.sub.depth', data: 'success', ts: now });
const delta = (index: number, patch: Record<string, unknown> = {}) => JSON.stringify({
  channel: 'push.depth', symbol: 'BTC_USDT', ts: now + 100 + index,
  data: { version: String(10_000 + index), cts: now + 90 + index,
    bids: [['83000', index === 0 ? '0' : '2', index === 0 ? '0' : '1']],
    asks: [['83000.1', '3', '1']], ...patch },
});
function capture(raws = [ack(), ...Array.from({ length: 10 }, (_, index) => delta(index))],
  failure: string | null = null): DepthSourceCapture {
  const parser = new MexcDepthStreamEvidence();
  const frames = raws.map((raw, index) => {
    const receivedAt = now + 100 + index;
    return { raw, receivedAt, parsed: parser.accept(raw, receivedAt) };
  });
  const acceptedDeltas = frames.filter(frame => frame.parsed.kind === 'delta' && frame.parsed.sourceTimeFresh).length;
  return { schema: 1, kind: 'mexc-public-depth-source', url: MEXC_DEPTH_SOURCE_URL,
    startedAt: now, endedAt: now + 100 + raws.length, connections: 1, subscriptions: 1, pings: 0,
    status: failure ? 'incomplete' : 'complete', frames, acceptedDeltas, failure,
    sourceTimeObserved: acceptedDeltas > 0, bookReconstructed: false, executable: false };
}
const clone = <T>(value: T): T => structuredClone(value);

describe('MEXC bounded source-time archive replay, offline synthetic transport evidence', () => {
  it('replays ten contiguous fresh cts deltas without claiming a reconstructed or executable book', () => {
    const report = replay(capture());
    expect(report).toMatchObject({ status: 'complete', connections: 1, subscriptions: 1, pings: 0,
      acceptedDeltas: 10, sourceTimeObserved: true, bookReconstructed: false, executable: false, failure: null });
    expect(report.frames).toHaveLength(11);
    expect(report.frames[1].parsed).toMatchObject({ kind: 'delta', version: '10000', previousVersion: null,
      sourceTime: { meaning: 'matching-engine-book-production', ageStatus: 'within-window', at: now + 90 },
      sourceTimeFresh: true, bookFreshnessVerified: false, bids: [{ action: 'delete', quantityContracts: '0' }] });
    expect(report.frames[10].parsed).toMatchObject({ version: '10009', previousVersion: '10008' });
    expect(Object.isFrozen(report)).toBe(true); expect(Object.isFrozen(report.frames[1].parsed)).toBe(true);
  });
  it('preserves only accepted frames on an upstream error, never storing the rejected error body', () => {
    const value = capture([ack(), delta(0)], 'stream-server-error');
    const report = replay(value);
    expect(report).toMatchObject({ status: 'incomplete', acceptedDeltas: 1, sourceTimeObserved: true });
    expect(report.frames).toHaveLength(2);
    expect(JSON.stringify(report)).not.toContain('rs.error');
    const poisoned = clone(value);
    poisoned.frames = [...poisoned.frames, { raw: JSON.stringify({ channel: 'rs.error', data: 'untrusted upstream text' }),
      receivedAt: poisoned.endedAt, parsed: poisoned.frames[0].parsed }];
    expect(() => replay(poisoned)).toThrow();
  });
  it('allows an unavailable connection before subscription with an empty safe diagnostic prefix', () => {
    const value = capture([], 'depth-source-unavailable'); value.subscriptions = 0;
    expect(replay(value)).toMatchObject({ status: 'incomplete', frames: [], acceptedDeltas: 0,
      subscriptions: 0, sourceTimeObserved: false });
  });
  it.each([null, undefined, now - 5001, now + 10000])('retains terminal unverifiable cts %s and fails closed', cts => {
    const value = capture([ack(), delta(0, { cts })], 'depth-source-time-unverified');
    expect(replay(value)).toMatchObject({ status: 'incomplete', acceptedDeltas: 0, sourceTimeObserved: false });
    expect(value.frames[1].parsed).toMatchObject({ kind: 'delta', sourceTimeFresh: false, bookFreshnessVerified: false });
    expect(() => replay({ ...value, status: 'complete', failure: null })).toThrow();
    expect(() => replay({ ...value, sourceTimeObserved: true })).toThrow();
  });
  it('distinguishes observed earlier source time from a later unverified terminal delta', () => {
    const value = capture([ack(), delta(0), delta(1, { cts: null })], 'depth-source-time-unverified');
    expect(replay(value)).toMatchObject({ acceptedDeltas: 1, sourceTimeObserved: true, status: 'incomplete' });
    expect(() => replay({ ...value, failure: 'depth-source-closed' })).toThrow();
    expect(() => replay(capture([ack(), delta(0)], 'depth-source-time-unverified'))).toThrow();
  });
  it('rejects accepted frames following unverified source time or the tenth accepted delta', () => {
    expect(() => replay(capture([ack(), delta(0, { cts: null }), delta(1)], 'depth-source-time-unverified'))).toThrow();
    const extra = capture([...capture().frames.map(frame => frame.raw), JSON.stringify({ channel: 'pong', data: now })]);
    expect(() => replay(extra)).toThrow();
  });
  it('accepts a finalization timeout after ten deltas only as incomplete evidence', () => {
    const value = capture(); value.status = 'incomplete'; value.failure = 'depth-source-timeout'; value.endedAt = now + 20001;
    expect(replay(value).status).toBe('incomplete');
    expect(() => replay({ ...value, failure: 'depth-source-closed' })).toThrow();
    expect(() => replay({ ...value, status: 'complete', failure: null })).toThrow();
  });
  it('requires the exact supplied hash and canonical UTF-8 archive bytes', () => {
    const raw = bytes(capture());
    expect(() => replayMexcDepthSource(raw, '0'.repeat(64))).toThrow();
    expect(() => replayMexcDepthSource(raw, sha(raw).toUpperCase())).toThrow();
    for (const altered of [Buffer.concat([raw, Buffer.from('\n')]), Buffer.from(JSON.stringify(capture(), null, 2) + '\n'), Buffer.from([0xff])]) {
      expect(() => replayMexcDepthSource(altered, sha(altered))).toThrow();
    }
    const duplicate = Buffer.from(raw.toString().replace('{"schema":1,', '{"schema":1,"schema":1,'));
    expect(() => replayMexcDepthSource(duplicate, sha(duplicate))).toThrow();
  });
  it.each([
    { url: 'wss://contract.mexc.com/private' }, { url: 'wss://example.invalid/edge' }, { schema: 2 },
    { kind: 'other' }, { connections: 2 }, { subscriptions: 2 }, { subscriptions: 0 }, { pings: 2 },
    { pings: 1 }, { acceptedDeltas: 9 }, { acceptedDeltas: 11 }, { acceptedDeltas: 10.1 },
    { sourceTimeObserved: false }, { bookReconstructed: true }, { executable: true },
    { status: 'incomplete', failure: 'untrusted error text' }, { status: 'complete', failure: 'depth-source-closed' },
    { startedAt: 0 }, { startedAt: now + 1000 }, { endedAt: now - 1 }, { endedAt: now + 20000 },
    { startedAt: Number.MAX_SAFE_INTEGER + 1 }, { endedAt: Infinity }, { headers: {} },
  ])('rejects an altered route, counters, timing, policy or extra metadata %j', patch => {
    expect(() => replay({ ...capture(), ...patch })).toThrow();
  });
  it('permits one bounded ping after ten seconds and rejects a ping before subscription', () => {
    const value = capture([ack()], 'depth-source-closed'); value.pings = 1; value.endedAt = now + 10000;
    expect(replay(value).pings).toBe(1);
    expect(() => replay({ ...value, subscriptions: 0 })).toThrow();
  });
  it('rejects frame receipt regression, out-of-capture times and extra frame fields', () => {
    for (const receivedAt of [now - 1, now + 20000, now + 100000, 0, 1.5]) {
      const value = clone(capture()); value.frames[1].receivedAt = receivedAt;
      expect(() => replay(value)).toThrow();
    }
    const extra = clone(capture()); Object.assign(extra.frames[0], { authorization: 'not a real secret' });
    expect(() => replay(extra)).toThrow();
  });
  it('detects normalized data tampering even if the archive hash is recomputed', () => {
    const value = clone(capture());
    Object.assign(value.frames[1].parsed, { sourceTimeFresh: false });
    expect(() => replay(value)).toThrow('invalid-depth-source-normalization');
  });
  it.each([
    ['wrong symbol', (row: Record<string, any>) => { row.symbol = 'ETH_USDT'; }],
    ['version gap', (row: Record<string, any>) => { row.data.version = '10020'; }],
    ['source regression', (row: Record<string, any>) => { row.data.cts = now - 1; }],
    ['false cts', (row: Record<string, any>) => { row.data.cts = false; }],
  ] as const)('rejects %s in raw payload, not merely normalized metadata', (_name, change) => {
    const value = clone(capture()); const row = JSON.parse(value.frames[2].raw); change(row);
    value.frames[2].raw = JSON.stringify(row); expect(() => replay(value)).toThrow();
  });
  it('does not accept duplicate acknowledgements or a negative acknowledgement in an accepted prefix', () => {
    for (const raw of [ack(), JSON.stringify({ channel: 'rs.sub.depth', data: 'failed' })]) {
      const value = clone(capture()); value.frames[1].raw = raw;
      expect(() => replay(value)).toThrow();
    }
  });
  it('allows a first delta before an optional acknowledgement without inventing book synchronization', () => {
    const value = capture(Array.from({ length: 10 }, (_, index) => delta(index)));
    expect(replay(value)).toMatchObject({ acceptedDeltas: 10, bookReconstructed: false, executable: false });
  });
  it('enforces the archive and frame-count budgets before parsing payloads', () => {
    expect(MAX_DEPTH_SOURCE_ARCHIVE_BYTES).toBe(32 * 1024 * 1024);
    const tooLarge = Buffer.alloc(MAX_DEPTH_SOURCE_ARCHIVE_BYTES + 1);
    expect(() => replayMexcDepthSource(tooLarge, sha(tooLarge))).toThrow();
    const value = capture([ack()], 'depth-source-closed');
    value.frames = Array.from({ length: 33 }, () => value.frames[0]);
    expect(() => replay(value)).toThrow();
  });
  it('round-trips transport-accepted 4 MiB raw depth when normalized JSON expands beyond 8 MiB', async () => {
    // Maximum allowed side lengths and valid 30-digit quantities/order counts make the
    // stored raw+normalized archive much larger than the sum of incoming WS bytes.
    const large = 100000000000000000000000000000n;
    const rows = (offset: bigint) => Array.from({ length: 2000 }, (_, index) =>
      [String(large + offset + BigInt(index)), String(large), String(large)]);
    const bids = rows(0n), asks = rows(10000n);
    const raws = [ack(), ...Array.from({ length: 10 }, (_, index) => JSON.stringify({
      channel: 'push.depth', symbol: 'BTC_USDT', ts: now,
      data: { version: String(10000 + index), cts: now, bids, asks },
    }))];
    const totalRaw = raws.reduce((sum, raw) => sum + Buffer.byteLength(raw), 0);
    expect(totalRaw).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(Math.max(...raws.map(raw => Buffer.byteLength(raw)))).toBeLessThanOrEqual(512 * 1024);
    let closed = false;
    const socket: DepthSocket = { onopen: null, onmessage: null, onerror: null, onclose: null,
      send: () => {}, close: () => { closed = true; } };
    const pending = new MexcDepthSourceClient({ factory: () => socket, clock: () => now }).capture();
    socket.onopen?.call(socket as unknown as WebSocket, new Event('open'));
    for (const raw of raws) socket.onmessage?.call(socket as unknown as WebSocket, { data: raw } as MessageEvent);
    const captured = await pending;
    expect(closed).toBe(true);
    expect(captured).toMatchObject({ status: 'complete', acceptedDeltas: 10, failure: null });
    expect(captured.frames).toHaveLength(11);
    const serialized = bytes(captured);
    expect(serialized.length).toBeGreaterThan(8 * 1024 * 1024);
    expect(serialized.length).toBeLessThan(MAX_DEPTH_SOURCE_ARCHIVE_BYTES);
    const restored = replayMexcDepthSource(serialized, sha(serialized));
    expect(restored).toMatchObject({ status: 'complete', acceptedDeltas: 10,
      sourceTimeObserved: true, bookReconstructed: false, executable: false });
    const final = restored.frames[10].parsed;
    if (final.kind !== 'delta') throw Error('expected the tenth accepted delta');
    expect(final.bids).toHaveLength(2000); expect(final.asks).toHaveLength(2000);
    expect(final.bids[1999]).toMatchObject({ price: String(large + 1999n),
      quantityContracts: String(large), orderCount: String(large), action: 'set' });
  }, 15000);
  it('rejects an oversized frame and a collectively oversized accepted prefix', () => {
    const value = clone(capture()); value.frames[0].raw = ' '.repeat(524289);
    expect(() => replay(value)).toThrow();
    const padded = Array.from({ length: 9 }, (_, index) => JSON.stringify({ channel: 'pong', data: now + index,
      padding: 'x'.repeat(500000) }));
    expect(() => replay(capture(padded, 'depth-source-closed'))).toThrow();
  });
});


describe('actual anonymous MEXC source-time probe, replayed offline', () => {
  it('pins the accepted public cts evidence without claiming a complete or synchronized book', () => {
    const raw = readFileSync(new URL('../fixtures/market-data/mexc-depth-source-public-20261001.json', import.meta.url));
    const manifest = JSON.parse(readFileSync(new URL('../fixtures/market-data/mexc-depth-source-public-20261001.manifest.json', import.meta.url), 'utf8'));
    const expected = '20453f24d8f8cbcf12ca85110082c9dcf653823f43eddcdf6f89b2d2ce824c7d';
    expect(raw.byteLength).toBe(7998); expect(sha(raw)).toBe(expected);
    expect(manifest).toEqual({ schema: 1, kind: 'mexc-public-depth-source-manifest', sha256: expected,
      publicDataOnly: true, bookReconstructed: false, executable: false });
    const report = replayMexcDepthSource(raw, expected);
    expect(report).toMatchObject({ status: 'complete', connections: 1, subscriptions: 1, pings: 0,
      acceptedDeltas: 10, sourceTimeObserved: true, bookReconstructed: false, executable: false, failure: null });
    expect(report.endedAt - report.startedAt).toBe(947);
    expect(report.frames).toHaveLength(11); expect(report.frames[0].parsed.kind).toBe('ack');
    let previous: string | null = null;
    for (const frame of report.frames.slice(1)) {
      if (frame.parsed.kind !== 'delta') throw Error('fixture delta type changed');
      expect(frame.parsed).toMatchObject({ symbol: 'BTC_USDT', previousVersion: previous,
        sourceTimeFresh: true, bookFreshnessVerified: false, bookReconstructed: false,
        sourceTime: { meaning: 'matching-engine-book-production', ageStatus: 'within-window' } });
      expect(frame.parsed.sourceTime.ageMs).toBeGreaterThanOrEqual(114);
      expect(frame.parsed.sourceTime.ageMs).toBeLessThanOrEqual(123);
      if (previous !== null) expect(BigInt(frame.parsed.version)).toBe(BigInt(previous) + 1n);
      previous = frame.parsed.version;
    }
  });
});
