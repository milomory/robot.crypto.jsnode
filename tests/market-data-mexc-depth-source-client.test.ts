import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MexcDepthSourceClient, MEXC_DEPTH_SOURCE_URL, MEXC_DEPTH_SUBSCRIPTION, MEXC_DEPTH_PING,
  type DepthSocket } from '../src/market-data/mexc-depth-source-client.js';

// Every socket is synthetic. These tests never open network connections.
const start = 1_790_841_600_000;
class MockSocket implements DepthSocket {
  onopen: DepthSocket['onopen'] = null;
  onmessage: DepthSocket['onmessage'] = null;
  onerror: DepthSocket['onerror'] = null;
  onclose: DepthSocket['onclose'] = null;
  send = vi.fn<(data: string | ArrayBufferLike | Blob | ArrayBufferView) => void>();
  close = vi.fn<(code?: number, reason?: string) => void>();
  open() { this.onopen?.call(this as unknown as WebSocket, new Event('open')); }
  message(data: unknown) { this.onmessage?.call(this as unknown as WebSocket, { data } as MessageEvent); }
  error() { this.onerror?.call(this as unknown as WebSocket, new Event('error')); }
  closed() { this.onclose?.call(this as unknown as WebSocket, new Event('close') as CloseEvent); }
}
function setup(clock: () => number = Date.now) {
  const socket = new MockSocket();
  const factory = vi.fn((_url: string) => socket);
  const client = new MexcDepthSourceClient({ factory, clock });
  const promise = client.capture();
  return { socket, factory, client, promise };
}
const ack = () => JSON.stringify({ channel: 'rs.sub.depth', data: 'success', ts: Date.now() });
const pong = () => JSON.stringify({ channel: 'pong', data: Date.now(), ts: Date.now() });
function delta(version: number | string, cts: number | null | undefined = Date.now()) {
  return JSON.stringify({ channel: 'push.depth', symbol: 'BTC_USDT',
    data: { version, cts, bids: [['60000', '2', '1']], asks: [] }, ts: Date.now() });
}
function ten(socket: MockSocket) { for (let version = 100; version < 110; version++) socket.message(delta(version)); }
function closedExactlyOnce(socket: MockSocket) {
  expect(socket.close).toHaveBeenCalledTimes(1);
  expect(socket.onopen).toBeNull(); expect(socket.onmessage).toBeNull();
  expect(socket.onerror).toBeNull(); expect(socket.onclose).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(start); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('bounded MEXC source-time transport policy', () => {
  it('opens only the fixed public endpoint and subscribes without compression, keys, login or extra arguments', async () => {
    const run = setup();
    expect(run.factory.mock.calls).toEqual([['wss://contract.mexc.com/edge']]);
    expect(MEXC_DEPTH_SOURCE_URL).toBe('wss://contract.mexc.com/edge');
    expect(run.socket.send).not.toHaveBeenCalled();
    run.socket.open();
    expect(run.socket.send.mock.calls).toEqual([[JSON.stringify({ method: 'sub.depth', param: { symbol: 'BTC_USDT', compress: false }, gzip: false })]]);
    expect(MEXC_DEPTH_SUBSCRIPTION).toBe(run.socket.send.mock.calls[0][0]);
    ten(run.socket);
    const result = await run.promise;
    expect(result).toMatchObject({ schema: 1, kind: 'mexc-public-depth-source', url: MEXC_DEPTH_SOURCE_URL,
      startedAt: start, endedAt: start, connections: 1, subscriptions: 1, pings: 0, status: 'complete',
      acceptedDeltas: 10, failure: null, sourceTimeObserved: true, bookReconstructed: false, executable: false });
    expect(result.frames).toHaveLength(10);
    expect(result.frames.map(frame => frame.parsed.kind)).toEqual(Array(10).fill('delta'));
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.frames)).toBe(true);
    expect(Object.isFrozen(result.frames[0].parsed)).toBe(true);
    closedExactlyOnce(run.socket);
  });
  it('uses the native WebSocket factory with only the fixed URL when no factory is supplied', async () => {
    const socket = new MockSocket();
    const NativeSocket = vi.fn(function (_url: string) { return socket; });
    vi.stubGlobal('WebSocket', NativeSocket);
    const resultPromise = new MexcDepthSourceClient().capture();
    expect(NativeSocket.mock.calls).toEqual([[MEXC_DEPTH_SOURCE_URL]]);
    socket.open(); ten(socket);
    expect((await resultPromise).status).toBe('complete'); closedExactlyOnce(socket);
  });
  it.each(['url', 'token', 'headers', 'reconnect', 'symbol', 'maxFrames'])('rejects unapproved option %s before opening any socket', key => {
    const factory = vi.fn();
    expect(() => new MexcDepthSourceClient({ factory, [key]: 'unapproved' } as never)).toThrow('invalid-public-options');
    expect(factory).not.toHaveBeenCalled();
  });
  it('completes only at ten deltas and does not count acknowledgement or pong as evidence deltas', async () => {
    const run = setup(); run.socket.open(); run.socket.message(ack()); run.socket.message(pong());
    let settled = false; void run.promise.then(() => { settled = true; });
    for (let v = 1; v <= 9; v++) run.socket.message(delta(v));
    await Promise.resolve(); expect(settled).toBe(false); expect(run.socket.close).not.toHaveBeenCalled();
    run.socket.message(delta(10)); const result = await run.promise;
    expect(result).toMatchObject({ status: 'complete', acceptedDeltas: 10 }); expect(result.frames).toHaveLength(12);
    run.socket.message(delta(11)); expect(result.frames).toHaveLength(12); closedExactlyOnce(run.socket);
  });
  it('retains exact versions above Number safe integer and accepts their contiguous successors', async () => {
    const run = setup(); run.socket.open();
    const first = 900719925474099300000n;
    for (let n = 0n; n < 10n; n++) run.socket.message(delta(String(first + n)));
    const result = await run.promise;
    expect(result.status).toBe('complete');
    expect(result.frames[9].parsed).toMatchObject({ version: String(first + 9n), previousVersion: String(first + 8n) });
  });
  it('rejects a second capture while the first is pending and after it completes', async () => {
    const run = setup();
    await expect(run.client.capture()).rejects.toThrow('public-client-used');
    run.socket.open(); ten(run.socket); await run.promise;
    await expect(run.client.capture()).rejects.toThrow('public-client-used');
    expect(run.factory).toHaveBeenCalledTimes(1);
  });
  it('does not resume or reconnect after transport error', async () => {
    const run = setup(); run.socket.open(); run.socket.message(delta(1));
    const lateMessage = run.socket.onmessage; run.socket.error();
    const result = await run.promise;
    expect(result).toMatchObject({ status: 'incomplete', acceptedDeltas: 1, failure: 'depth-source-unavailable' });
    lateMessage?.call(run.socket as unknown as WebSocket, { data: delta(2) } as MessageEvent);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(result.frames).toHaveLength(1); expect(run.factory).toHaveBeenCalledTimes(1); closedExactlyOnce(run.socket);
  });
  it('does not reconnect after normal close before ten deltas', async () => {
    const run = setup(); run.socket.open(); run.socket.message(delta(1)); run.socket.closed();
    expect(await run.promise).toMatchObject({ status: 'incomplete', acceptedDeltas: 1, failure: 'depth-source-closed' });
    await vi.advanceTimersByTimeAsync(60_000); expect(run.factory).toHaveBeenCalledTimes(1); closedExactlyOnce(run.socket);
  });
  it.each([3, 1, 0])('stops on a sequence gap, duplicate or regression to version %s', async version => {
    const run = setup(); run.socket.open(); run.socket.message(delta(1)); run.socket.message(delta(version));
    const result = await run.promise;
    expect(result).toMatchObject({ status: 'incomplete', acceptedDeltas: 1, failure: 'stream-version-discontinuity' });
    expect(result.frames).toHaveLength(1); expect(run.factory).toHaveBeenCalledTimes(1); closedExactlyOnce(run.socket);
  });
  it('does not expose exception messages from a failed constructor', async () => {
    const factory = vi.fn(() => { throw Error('private exception details'); });
    const result = await new MexcDepthSourceClient({ factory }).capture();
    expect(result).toMatchObject({ status: 'incomplete', failure: 'depth-source-unavailable', acceptedDeltas: 0 });
    expect(JSON.stringify(result)).not.toContain('private exception details'); expect(factory).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('stops if the subscription send fails and does not count it as sent', async () => {
    const run = setup(); run.socket.send.mockImplementation(() => { throw Error('private transport details'); });
    run.socket.open(); const result = await run.promise;
    expect(result).toMatchObject({ failure: 'depth-source-unavailable', subscriptions: 0, pings: 0 });
    expect(JSON.stringify(result)).not.toContain('private transport details'); closedExactlyOnce(run.socket);
  });
  it('rejects a second open callback without a second subscription', async () => {
    const run = setup(); run.socket.open(); run.socket.open();
    expect(await run.promise).toMatchObject({ failure: 'depth-source-unexpected-open', subscriptions: 1 });
    expect(run.socket.send).toHaveBeenCalledTimes(1); closedExactlyOnce(run.socket);
  });
  it('rejects frames received before the open event', async () => {
    const run = setup(); run.socket.message(delta(1));
    expect(await run.promise).toMatchObject({ failure: 'depth-source-before-open', acceptedDeltas: 0, subscriptions: 0 });
    expect(run.socket.send).not.toHaveBeenCalled(); closedExactlyOnce(run.socket);
  });
});

describe('MEXC source-time frame and byte budgets', () => {
  it.each([new Uint8Array([1, 2]), new ArrayBuffer(4), new Blob(['not text']), null, 42])('rejects binary or non-string frame %j', async value => {
    const run = setup(); run.socket.open(); run.socket.message(value);
    expect(await run.promise).toMatchObject({ status: 'incomplete', failure: 'depth-source-binary-message', acceptedDeltas: 0, frames: [] });
    closedExactlyOnce(run.socket);
  });
  it.each(['push.personal.order', 'push.ticker', 'push.depth.full', 'unknown'])('rejects unsupported channel %s', async channel => {
    const run = setup(); run.socket.open(); run.socket.message(JSON.stringify({ channel, data: 'synthetic' }));
    const result = await run.promise;
    expect(result.status).toBe('incomplete'); expect(result.acceptedDeltas).toBe(0); expect(result.frames).toHaveLength(0);
    closedExactlyOnce(run.socket);
  });
  it.each(['{', '{"channel":"pong","channel":"push.depth","data":1}', 'not-json'])('rejects malformed or ambiguous JSON %s', async raw => {
    const run = setup(); run.socket.open(); run.socket.message(raw);
    expect(await run.promise).toMatchObject({ status: 'incomplete', frames: [], acceptedDeltas: 0 }); closedExactlyOnce(run.socket);
  });
  it.each(['x'.repeat(524289), 'я'.repeat(262145)])('rejects a frame exceeding 512 KiB by UTF-8 byte size', async raw => {
    const run = setup(); run.socket.open(); run.socket.message(raw);
    expect(await run.promise).toMatchObject({ failure: 'depth-source-message-budget', frames: [] }); closedExactlyOnce(run.socket);
  });
  it('permits 32 valid frames, then stops before parsing a 33rd', async () => {
    const run = setup(); run.socket.open();
    for (let count = 0; count < 32; count++) run.socket.message(pong());
    expect(run.socket.close).not.toHaveBeenCalled(); run.socket.message(pong());
    const result = await run.promise;
    expect(result).toMatchObject({ status: 'incomplete', failure: 'depth-source-message-budget', acceptedDeltas: 0 });
    expect(result.frames).toHaveLength(32); closedExactlyOnce(run.socket);
  });
  it('permits exactly 4 MiB of accepted frames and rejects the next byte budget increment', async () => {
    const run = setup(); run.socket.open();
    const skeleton = JSON.stringify({ channel: 'pong', data: start, padding: '' });
    const raw = JSON.stringify({ channel: 'pong', data: start, padding: 'x'.repeat(524288 - Buffer.byteLength(skeleton)) });
    expect(Buffer.byteLength(raw)).toBe(524288);
    for (let count = 0; count < 8; count++) run.socket.message(raw);
    expect(run.socket.close).not.toHaveBeenCalled(); run.socket.message(pong());
    const result = await run.promise;
    expect(result).toMatchObject({ failure: 'depth-source-message-budget', acceptedDeltas: 0 }); expect(result.frames).toHaveLength(8);
    closedExactlyOnce(run.socket);
  });
  it.each([undefined, null, start - 5001, start + 5001])('stops when cts is missing or outside freshness bounds: %s', async cts => {
    const run = setup(); run.socket.open();
    const row = JSON.parse(delta(1)); if (cts === undefined) delete row.data.cts; else row.data.cts = cts;
    run.socket.message(JSON.stringify(row)); const result = await run.promise;
    expect(result).toMatchObject({ status: 'incomplete', failure: 'depth-source-time-unverified', acceptedDeltas: 0, sourceTimeObserved: false });
    expect(result.frames).toHaveLength(1); expect(result.frames[0].parsed).toMatchObject({ kind: 'delta', sourceTimeFresh: false });
    closedExactlyOnce(run.socket);
  });
  it('stops on matching-engine source time regression', async () => {
    const run = setup(); run.socket.open(); run.socket.message(delta(1, start)); run.socket.message(delta(2, start - 1));
    expect(await run.promise).toMatchObject({ failure: 'stream-source-time-regression', acceptedDeltas: 1 }); closedExactlyOnce(run.socket);
  });
});

describe('MEXC source-time lifecycle deadlines and exact clock failures', () => {
  it('times out an unopened socket after 20 seconds and never subscribes', async () => {
    const run = setup(); const delayedOpen = run.socket.onopen;
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await run.promise;
    expect(result).toMatchObject({ failure: 'depth-source-timeout', endedAt: start + 20_000, subscriptions: 0, pings: 0 });
    delayedOpen?.call(run.socket as unknown as WebSocket, new Event('open'));
    expect(run.socket.send).not.toHaveBeenCalled(); closedExactlyOnce(run.socket);
  });
  it('rejects an open event after deadline even before the scheduled timeout gets CPU time', async () => {
    const run = setup(); vi.setSystemTime(start + 20_000); run.socket.open();
    expect(await run.promise).toMatchObject({ failure: 'depth-source-timeout', subscriptions: 0, pings: 0 });
    expect(run.socket.send).not.toHaveBeenCalled(); closedExactlyOnce(run.socket);
  });
  it('sends exactly one public heartbeat at 10 seconds and times out at 20 seconds', async () => {
    const run = setup(); run.socket.open(); await vi.advanceTimersByTimeAsync(9999);
    expect(run.socket.send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(run.socket.send.mock.calls).toEqual([[MEXC_DEPTH_SUBSCRIPTION], [MEXC_DEPTH_PING]]);
    expect(MEXC_DEPTH_PING).toBe(JSON.stringify({ method: 'ping' }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await run.promise).toMatchObject({ failure: 'depth-source-timeout', subscriptions: 1, pings: 1 });
    expect(run.socket.send).toHaveBeenCalledTimes(2); closedExactlyOnce(run.socket);
  });
  it('keeps the 20-second deadline relative to capture start after a delayed open', async () => {
    const run = setup(); await vi.advanceTimersByTimeAsync(15_000); run.socket.open();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await run.promise).toMatchObject({ failure: 'depth-source-timeout', endedAt: start + 20_000, pings: 0, subscriptions: 1 });
    expect(run.socket.send).toHaveBeenCalledTimes(1); closedExactlyOnce(run.socket);
  });
  it('completes after one heartbeat without leaving timers or a socket open', async () => {
    const run = setup(); run.socket.open(); await vi.advanceTimersByTimeAsync(10_000); run.socket.message(pong()); ten(run.socket);
    expect(await run.promise).toMatchObject({ status: 'complete', pings: 1, acceptedDeltas: 10 }); closedExactlyOnce(run.socket);
  });
  it('stops when heartbeat send fails without incrementing ping count', async () => {
    const run = setup(); run.socket.open(); run.socket.send.mockImplementation(() => { throw Error('private heartbeat error'); });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await run.promise).toMatchObject({ failure: 'depth-source-unavailable', pings: 0 }); closedExactlyOnce(run.socket);
  });
  it('rejects a message at the exact deadline instead of accepting its fresh source timestamp', async () => {
    const run = setup(); run.socket.open(); vi.setSystemTime(start + 20_000); run.socket.message(delta(1));
    expect(await run.promise).toMatchObject({ failure: 'depth-source-timeout', acceptedDeltas: 0, frames: [] }); closedExactlyOnce(run.socket);
  });
  it.each([NaN, Infinity, 0, -1, 1.5, 8_640_000_000_000_001])('rejects invalid initial clock %s before creating a socket', async value => {
    const factory = vi.fn();
    await expect(new MexcDepthSourceClient({ factory, clock: () => value }).capture()).rejects.toThrow('invalid-public-clock');
    expect(factory).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('preserves exact invalid-public-clock when time moves backward before open', async () => {
    const clock = vi.fn<() => number>().mockReturnValue(start).mockReturnValueOnce(start).mockReturnValueOnce(start - 1);
    const run = setup(clock); run.socket.open();
    expect(await run.promise).toMatchObject({ failure: 'invalid-public-clock', endedAt: start, subscriptions: 0 }); closedExactlyOnce(run.socket);
  });
  it('preserves exact invalid-public-clock on a frame despite later clock recovery', async () => {
    const clock = vi.fn<() => number>().mockReturnValue(start).mockReturnValueOnce(start).mockReturnValueOnce(start).mockReturnValueOnce(start - 1);
    const run = setup(clock); run.socket.open(); run.socket.message(delta(1));
    expect(await run.promise).toMatchObject({ failure: 'invalid-public-clock', endedAt: start, acceptedDeltas: 0, frames: [] }); closedExactlyOnce(run.socket);
  });
  it('preserves exact invalid-public-clock on heartbeat despite later clock recovery', async () => {
    const clock = vi.fn<() => number>().mockReturnValue(start).mockReturnValueOnce(start).mockReturnValueOnce(start).mockReturnValueOnce(start - 1);
    const run = setup(clock); run.socket.open(); await vi.advanceTimersByTimeAsync(10_000);
    expect(await run.promise).toMatchObject({ failure: 'invalid-public-clock', endedAt: start, pings: 0 }); closedExactlyOnce(run.socket);
  });
  it('marks a clock regression during successful completion as incomplete and retains last valid time', async () => {
    let calls = 0; const clock = () => ++calls === 13 ? start - 1 : start;
    const run = setup(clock); run.socket.open(); ten(run.socket);
    expect(await run.promise).toMatchObject({ status: 'incomplete', failure: 'invalid-public-clock', endedAt: start, acceptedDeltas: 10 });
    closedExactlyOnce(run.socket);
  });
  it('suppresses socket-close exceptions and still settles once', async () => {
    const run = setup(); run.socket.close.mockImplementation(() => { throw Error('private close error'); });
    run.socket.open(); ten(run.socket);
    expect(await run.promise).toMatchObject({ status: 'complete', failure: null }); closedExactlyOnce(run.socket);
  });
});
