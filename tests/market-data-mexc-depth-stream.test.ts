import { describe, expect, it } from 'vitest';
import { MarketDataError } from '../src/market-data/model.js';
import { MEXC_DEPTH_STREAM_LIMITS, MEXC_DEPTH_STREAM_SUBSCRIPTION, MEXC_DEPTH_STREAM_URL, STREAM_FAILURES,
  MexcDepthStreamEvidence, type MexcDepthStreamDelta } from '../src/market-data/mexc-depth-stream.js';

const at = 1_800_000_000_000;
const event = (data: Record<string, unknown> = {}, root: Record<string, unknown> = {}) => JSON.stringify({
  channel: 'push.depth', symbol: 'BTC_USDT', ts: at - 10,
  data: { version: '9007199254740993', cts: at - 20, bids: [[100, 5, 2]], asks: [[101, 6, 3]], ...data }, ...root,
});
const decode = (raw = event(), receivedAt = at) => new MexcDepthStreamEvidence().accept(raw, receivedAt) as MexcDepthStreamDelta;

// All input messages in this file are synthetic, not exchange capture evidence.
describe('MEXC WS incremental evidence remains separate from a reconstructed book', () => {
  it('pins a public unmerged BTC subscription with independent gzip setting', () => {
    expect(MEXC_DEPTH_STREAM_URL).toBe('wss://contract.mexc.com/edge');
    expect(MEXC_DEPTH_STREAM_SUBSCRIPTION).toEqual({ method: 'sub.depth', param: { symbol: 'BTC_USDT', compress: false }, gzip: false });
    expect(Object.isFrozen(MEXC_DEPTH_STREAM_SUBSCRIPTION.param)).toBe(true);
  });
  it('retains exact delta amounts, time meaning and the absence of a bootstrap', () => {
    const result = decode();
    expect(result).toEqual({ kind: 'delta', channel: 'push.depth', symbol: 'BTC_USDT', receivedAt: at,
      version: '9007199254740993', previousVersion: null,
      bids: [{ price: '100', quantityContracts: '5', orderCount: '2', action: 'set' }],
      asks: [{ price: '101', quantityContracts: '6', orderCount: '3', action: 'set' }],
      sourceTime: { at: at - 20, meaning: 'matching-engine-book-production', ageMs: 20, ageStatus: 'within-window' },
      sourceTimeFresh: true, exchangeTimestamp: at - 10, exchangeTimestampVerified: false,
      bookReconstructed: false, bookFreshnessVerified: false, executable: false });
    expect(result).not.toHaveProperty('quantityBase');
    expect(result).not.toHaveProperty('usableForBookComparison');
  });
  it('preserves numeric JSON lexemes above the safe Number integer range', () => {
    const raw = event({ bids: [['100.12345678901234567890123456789', '9007199254740993', '9007199254740995']] })
      .replace('"100.12345678901234567890123456789"', '100.12345678901234567890123456789')
      .replaceAll('"9007199254740993"', '9007199254740993').replace('"9007199254740995"', '9007199254740995');
    expect(decode(raw)).toMatchObject({ version: '9007199254740993',
      bids: [{ price: '100.12345678901234567890123456789', quantityContracts: '9007199254740993', orderCount: '9007199254740995' }] });
  });
  it('treats zero quantity as deletion and does not infer contract lot or base conversion', () => {
    const result = decode(event({ bids: [[100, 0, 0], [99, '0.000000000000000000000000000001', 1]] }));
    expect(result.bids[0]).toEqual({ price: '100', quantityContracts: '0', orderCount: '0', action: 'delete' });
    expect(result.bids[1].quantityContracts).toBe('0.000000000000000000000000000001');
    expect(result.bids[1].action).toBe('set');
  });
  it.each([{ bids: [] }, { asks: [] }, { bids: [], asks: [] }])('accepts empty delta sides: %j', patch => {
    expect(decode(event(patch)).kind).toBe('delta');
  });
  it('does not impose snapshot sorting or reject cross-side overlap on independent delta entries', () => {
    const result = decode(event({ bids: [[99, 1, 1], [101, 0, 0], [100, 2, 1]], asks: [[100, 0, 0], [99, 1, 1]] }));
    expect(result.bids.map(row => row.price)).toEqual(['99', '101', '100']);
    expect(result.asks.map(row => row.price)).toEqual(['100', '99']);
    expect(result.bookReconstructed).toBe(false);
  });
  it('accepts exactly 2000 levels on each side without silently truncating', () => {
    const rows = Array.from({ length: 2000 }, (_, i) => [i + 1, 1, 1]);
    const result = decode(event({ bids: rows, asks: rows }));
    expect(result.bids).toHaveLength(2000); expect(result.asks).toHaveLength(2000);
  });
  it('deeply freezes output, including levels and timing', () => {
    const result = decode();
    for (const object of [result, result.bids, result.bids[0], result.asks, result.asks[0], result.sourceTime]) {
      expect(Object.isFrozen(object)).toBe(true);
    }
  });
});

describe('matching engine time is not fabricated from outer ts or receipt', () => {
  it.each([
    { cts: undefined, status: 'missing', fresh: false }, { cts: null, status: 'missing', fresh: false },
    { cts: at - 5000, status: 'within-window', fresh: true }, { cts: at - 5001, status: 'stale', fresh: false },
    { cts: at + 5000, status: 'within-window', fresh: true }, { cts: at + 5001, status: 'future', fresh: false },
  ])('labels $status source time independently', ({ cts, status, fresh }) => {
    const result = decode(event({ cts }));
    expect(result.sourceTime).toMatchObject({ at: cts ?? null, ageStatus: status });
    expect(result.sourceTimeFresh).toBe(fresh); expect(result.exchangeTimestamp).toBe(at - 10);
    expect(result.bookFreshnessVerified).toBe(false); expect(result.executable).toBe(false);
  });
  it.each([undefined, null, at + 50000, at - 50000])('retains outer ts separately without using it as freshness: %s', ts => {
    const result = decode(event({}, { ts }));
    expect(result.sourceTimeFresh).toBe(true); expect(result.exchangeTimestamp).toBe(ts ?? null);
    expect(result.exchangeTimestampVerified).toBe(false);
  });
  it.each(['', '0', 0, -1, '1.5', '1e3', '01', 'NaN', 'Infinity', '9007199254740993', '8640000000000001', {}, true])(
    'rejects malformed cts instead of replacing it: %j', cts => {
      expect(() => decode(event({ cts }))).toThrow(MarketDataError);
    });
  it('permits equal consecutive engine times', () => {
    const stream = new MexcDepthStreamEvidence(); stream.accept(event(), at);
    expect(stream.accept(event({ version: '9007199254740994' }), at + 1)).toMatchObject({
      previousVersion: '9007199254740993', sourceTime: { at: at - 20, ageMs: 21 } });
  });
  it('rejects engine time regression across a message with missing cts', () => {
    const stream = new MexcDepthStreamEvidence(); stream.accept(event(), at);
    stream.accept(event({ version: '9007199254740994', cts: null }), at + 1);
    expect(() => stream.accept(event({ version: '9007199254740995', cts: at - 21 }), at + 2))
      .toThrow('stream-source-time-regression');
  });
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, '1800000000000', null, undefined])(
    'rejects unsafe receipt time: %j', time => {
      expect(() => new MexcDepthStreamEvidence().accept(event(), time as number)).toThrow('invalid-stream-timing');
    });
  it('rejects backwards receipt time even for pong messages', () => {
    const stream = new MexcDepthStreamEvidence(); stream.accept(event(), at);
    expect(() => stream.accept(JSON.stringify({ channel: 'pong', data: at }), at - 1)).toThrow('invalid-stream-timing');
  });
});

describe('strict version continuity without recovery or hidden gaps', () => {
  it('compares versions with BigInt rather than Number arithmetic', () => {
    const stream = new MexcDepthStreamEvidence(); stream.accept(event(), at);
    const raw = event({ version: '9007199254740994' }).replace('"9007199254740994"', '9007199254740994');
    expect(stream.accept(raw, at)).toMatchObject({ version: '9007199254740994', previousVersion: '9007199254740993' });
  });
  it.each(['9007199254740993', '9007199254740992', '9007199254740995', '0'])(
    'rejects duplicate, backwards or skipped version %s permanently', version => {
      const stream = new MexcDepthStreamEvidence(); stream.accept(event(), at);
      expect(() => stream.accept(event({ version }), at)).toThrow('stream-version-discontinuity');
      expect(() => stream.accept(event({ version: '9007199254740994' }), at)).toThrow('stream-already-rejected');
    });
  it.each([undefined, null, '-1', '1.5', '1e3', '01', '', true, '1000000000000000000000000000000'])(
    'rejects malformed or unbounded versions: %j', version => {
      expect(() => decode(event({ version }))).toThrow(MarketDataError);
    });
  it('does not reset version continuity on ack or pong', () => {
    const stream = new MexcDepthStreamEvidence(); stream.accept(event(), at);
    stream.accept(JSON.stringify({ channel: 'rs.sub.depth', data: 'success', ts: at }), at);
    stream.accept(JSON.stringify({ channel: 'pong', data: at }), at);
    expect(() => stream.accept(event({ version: '9007199254740995' }), at)).toThrow('stream-version-discontinuity');
  });
});

describe('public control messages never certify book freshness', () => {
  it('accepts one successful subscription acknowledgement', () => {
    const stream = new MexcDepthStreamEvidence();
    const raw = JSON.stringify({ channel: 'rs.sub.depth', data: 'success', ts: String(at) });
    expect(stream.accept(raw, at)).toEqual({ kind: 'ack', channel: 'rs.sub.depth', receivedAt: at,
      exchangeTimestamp: at, exchangeTimestampVerified: false, executable: false });
    expect(() => stream.accept(raw, at)).toThrow('invalid-stream-ack');
  });
  it('accepts pong with a separate unverified server time', () => {
    expect(new MexcDepthStreamEvidence().accept(JSON.stringify({ channel: 'pong', data: at }), at)).toEqual({
      kind: 'pong', channel: 'pong', receivedAt: at, serverTime: at, serverTimeVerified: false,
      exchangeTimestamp: null, exchangeTimestampVerified: false, executable: false });
  });
  it.each([null, '', 'Success', 'failed', true, {}, []])('rejects an acknowledgement without exact success: %j', data => {
    expect(() => decode(JSON.stringify({ channel: 'rs.sub.depth', data }))).toThrow('invalid-stream-ack');
  });
  it.each([undefined, null, '', 0, -1, '9007199254740993', {}])('rejects malformed pong data: %j', data => {
    expect(() => decode(JSON.stringify({ channel: 'pong', data }))).toThrow(MarketDataError);
  });
  it('throws only a fixed code for server errors; no arbitrary server text escapes', () => {
    const stream = new MexcDepthStreamEvidence();
    expect(() => stream.accept(JSON.stringify({ channel: 'rs.error', data: 'DO_NOT_RENDER_PRIVATE_TEXT' }), at))
      .toThrow('stream-server-error');
    expect(() => stream.accept(event(), at)).toThrow('stream-already-rejected');
  });
  it.each(['push.depth.full', 'push.depth.step', 'push.ticker', 'push.personal.asset', 'rs.sub.deal', 'login', null, undefined])(
    'rejects unexpected channel %j', channel => {
      expect(() => decode(event({}, { channel }))).toThrow('unexpected-stream-channel');
    });
});

describe('delta frame schema and resource limits', () => {
  it.each([
    { bids: undefined }, { asks: null }, { bids: {} }, { bids: [[100, 1]] }, { bids: [[100, 1, 1, 1]] },
    { bids: [[0, 1, 1]] }, { asks: [[-1, 1, 1]] }, { bids: [['NaN', 1, 1]] },
    { bids: [[100, -1, 1]] }, { bids: [[100, '-0', 1]] }, { bids: [[100, 'Infinity', 1]] },
    { bids: [[100, '0.0000000000000000000000000000001', 1]] },
    { bids: [[100, 1, -1]] }, { bids: [[100, 1, 1.5]] }, { bids: [[100, 1, '1e3']] },
    { bids: [[100, 1, null]] }, { bids: [[100, 1, 1], ['100.00', 2, 1]] },
    { asks: [[100, 1, 1], ['1e2', 0, 0]] }, { symbol: 'ETH_USDT' },
    { asks: Array.from({ length: 2001 }, (_, i) => [i + 1, 1, 1]) },
  ])('rejects invalid levels or conflicting nested symbol: %j', patch => {
    expect(() => decode(event(patch))).toThrow(MarketDataError);
  });
  it.each([undefined, null, 'ETH_USDT', 'BTCUSDT', 'BTC_USD', {}, true])('requires the exact top-level symbol: %j', symbol => {
    expect(() => decode(event({}, { symbol }))).toThrow('unsupported-stream-symbol');
  });
  it.each([null, [], 'hello', 1, false])('rejects non-object data: %j', data => {
    expect(() => decode(event({}, { data }))).toThrow(MarketDataError);
  });
  it.each(['', '{', 'null', '[]', '1', '{"channel":"push.depth","channel":"pong","data":1}',
    '{"channel":"push.depth","symbol":"BTC_USDT","data":{"version":1,"version":2}}'])('rejects invalid/ambiguous JSON: %s', raw => {
      expect(() => decode(raw)).toThrow(MarketDataError);
    });
  it.each([new Uint8Array([1, 2]), new ArrayBuffer(0), {}, null, undefined, 1])('rejects non-text input: %j', raw => {
    expect(() => new MexcDepthStreamEvidence().accept(raw as string, at)).toThrow('unsupported-stream-frame');
  });
  it('accepts the exact byte limit and rejects even one excess byte', () => {
    const raw = event(), padding = ' '.repeat(MEXC_DEPTH_STREAM_LIMITS.maximumFrameBytes - Buffer.byteLength(raw));
    expect(decode(raw + padding).kind).toBe('delta');
    expect(() => decode(raw + padding + ' ')).toThrow('public-response-too-large');
  });
  it('counts multibyte UTF-8 frame bytes, not just JS characters', () => {
    const raw = event({}, { ignored: 'я'.repeat(300000) });
    expect(raw.length).toBeLessThan(MEXC_DEPTH_STREAM_LIMITS.maximumFrameBytes);
    expect(() => decode(raw)).toThrow('public-response-too-large');
  });
  it('exports an immutable closed failure allowlist for archive diagnostics', () => {
    expect(Object.isFrozen(STREAM_FAILURES)).toBe(true);
    expect(new Set(STREAM_FAILURES).size).toBe(STREAM_FAILURES.length);
    for (const raw of ['{', event({ version: -1 }), event({ cts: 'invalid' }), event({ bids: [[0, 1, 1]] }),
      event({}, { channel: 'rs.error' }), event({}, { symbol: 'ETH_USDT' })]) {
      try { decode(raw); throw new Error('unexpected acceptance'); }
      catch (error) { expect(error).toBeInstanceOf(MarketDataError); expect(STREAM_FAILURES).toContain((error as MarketDataError).code); }
    }
  });
  it('makes any schema rejection terminal, not only sequence failures', () => {
    const stream = new MexcDepthStreamEvidence();
    expect(() => stream.accept(event({ bids: [[0, 1, 1]] }), at)).toThrow(MarketDataError);
    expect(() => stream.accept(event(), at)).toThrow('stream-already-rejected');
  });
});
