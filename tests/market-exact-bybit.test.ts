import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExactBybitClient, parseRawBook, parseRawInstrument, toPaperBook, toPaperInstrument } from '../src/market-exact/bybit.js';
import type { RawBook, RawInstrument } from '../src/market-exact/bybit.js';
import { PaperError } from '../src/paper-v2/exact.js';

const now = 1_800_000_000_000;
function book() {
  return { retCode: 0, result: { s: 'BTCUSDT', ts: now, cts: now - 10,
    b: [['99999.123456789012345678', '1.000000000000000000']],
    a: [['100000.123456789012345679', '2.123456789012345678']] } };
}
function instrument() {
  return { retCode: 0, result: { category: 'spot', list: [{ symbol: 'BTCUSDT', baseCoin: 'BTC', quoteCoin: 'USDT',
    status: 'Trading', lotSizeFilter: { basePrecision: '0.000001000000000000', quotePrecision: '0.00000001',
      minOrderAmt: '5.000000000000000000', maxMarketOrderQty: '100.000000000000000000',
      minOrderQty: 'invalid-deprecated', maxOrderQty: '0', maxOrderAmt: '0.00001' },
    priceFilter: { tickSize: '0.01' } }] } };
}
function json(raw: unknown, init?: ResponseInit) { return new Response(JSON.stringify(raw), init); }
function request(body: unknown) { return vi.fn<typeof fetch>(async () => json(body)); }
afterEach(() => { vi.useRealTimers(); });

describe('decimal-preserving Bybit parser', () => {
  it('preserves all digits and trailing zeros, with separate system and matching timestamps', () => {
    const raw = book(); const parsed = parseRawBook(raw, now - 50, now);
    expect(parsed).toEqual({ venue: 'bybit', symbol: 'BTC/USDT', requestedAt: now - 50, receivedAt: now,
      systemAt: now, matchingAt: now - 10, bids: raw.result.b, asks: raw.result.a });
    raw.result.b[0][0] = '1';
    expect(parsed.bids[0][0]).toBe('99999.123456789012345678');
    const noMatching = book(); delete (noMatching.result as { cts?: number }).cts;
    expect(parseRawBook(noMatching, now - 50, now).matchingAt).toBeUndefined();
  });
  it('keeps active spot metadata and never enforces deprecated quantity/notional limits', () => {
    const parsed = parseRawInstrument(instrument(), now - 50, now);
    expect(parsed.basePrecision).toBe('0.000001000000000000');
    expect(parsed.maxMarketOrderQty).toBe('100.000000000000000000');
    expect(toPaperInstrument(parsed)).toEqual({ venue: 'bybit', symbol: 'BTC/USDT', fetchedAt: now,
      trading: true, minQuantity: '0.000001', quantityStep: '0.000001', maxQuantity: '100', minNotional: '5' });
    expect(parsed).not.toHaveProperty('minOrderQty');
    expect(parsed).not.toHaveProperty('maxOrderAmt');
  });
  it('only trims insignificant zeros when converting to paper-v2; never rounds', () => {
    const raw = book(); raw.result.b = [['100.123456780000000000', '1.000000000000000000']];
    raw.result.a = [['101.000000000000000000', '2.500000000000000000']];
    const parsed = parseRawBook(raw, now, now);
    expect(toPaperBook(parsed).bids).toEqual([['100.12345678', '1']]);
    expect(toPaperBook(parsed).asks).toEqual([['101', '2.5']]);
    expect(parsed.bids).toEqual(raw.result.b);
    expect(() => toPaperBook(parseRawBook(book(), now, now))).toThrow('unsupported-paper-precision');
    for (const key of ['basePrecision', 'minOrderAmt', 'maxMarketOrderQty'] as const) {
      const i = parseRawInstrument(instrument(), now, now); i[key] = '0.123456789';
      expect(() => toPaperInstrument(i)).toThrow('unsupported-paper-precision');
    }
  });
  it('rejects number coercion, exponent, excessive precision and non-positive money', () => {
    for (const value of [100, '1e5', '01', ' 1', '+1', '-1', '0', '0.000000000000000000',
      '1.1234567890123456789', '100000000000000000000', null, {}, 'private-input']) {
      const raw = book(); (raw.result.b[0] as unknown[])[0] = value;
      expect(() => parseRawBook(raw, now, now)).toThrowError(new PaperError('exact-market-invalid-decimal'));
      const metadata = instrument(); (metadata.result.list[0].lotSizeFilter as Record<string, unknown>).basePrecision = value;
      expect(() => parseRawInstrument(metadata, now, now)).toThrow('exact-market-invalid-decimal');
    }
    const large = book(); large.result.b = [['99999999999999999999.999999999999999998', '1']];
    large.result.a = [['99999999999999999999.999999999999999999', '1']];
    expect(parseRawBook(large, now, now).asks[0][0]).toBe('99999999999999999999.999999999999999999');
  });
  it('checks depth, strict order and crossed books at 18-digit precision', () => {
    for (const b of [[], null, 'private-input', [null], [['1']], [['1', '1', 'extra']],
      [['1', '1'], ['1.000000000000000000', '2']], [['1', '1'], ['1.000000000000000001', '1']],
      Array.from({ length: 51 }, () => ['1', '1'])]) {
      expect(() => parseRawBook({ ...book(), result: { ...book().result, b } }, now, now)).toThrow(PaperError);
    }
    const raw = book(); raw.result.a = raw.result.b;
    expect(() => parseRawBook(raw, now, now)).toThrow('exact-market-crossed-book');
    raw.result.a = [['100001', '1'], ['100000', '1']];
    expect(() => parseRawBook(raw, now, now)).toThrow('exact-market-unsorted-book');
  });
  it('validates freshness using matching time when available and receipt duration', () => {
    const raw = book(); raw.result.cts = now - 5_000;
    expect(parseRawBook(raw, now - 5_000, now)).toBeDefined();
    raw.result.cts = now - 5_001;
    expect(() => parseRawBook(raw, now, now)).toThrow('exact-market-invalid-source-time');
    raw.result.cts = now + 1_000;
    expect(parseRawBook(raw, now, now)).toBeDefined();
    raw.result.cts = now + 1_001;
    expect(() => parseRawBook(raw, now, now)).toThrow('exact-market-invalid-source-time');
    const noMatching = book(); delete (noMatching.result as { cts?: number }).cts;
    noMatching.result.ts = now - 5_001;
    expect(() => parseRawBook(noMatching, now, now)).toThrow('exact-market-invalid-source-time');
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1800000000000', NaN, null]) {
      expect(() => parseRawBook({ ...book(), result: { ...book().result, ts: value } }, now, now)).toThrow(PaperError);
    }
    for (const pair of [[now + 1, now], [now - 5_001, now], [0, now], [now, NaN]]) {
      expect(() => parseRawBook(book(), pair[0], pair[1])).toThrow('exact-market-invalid-receipt-time');
      expect(() => parseRawInstrument(instrument(), pair[0], pair[1])).toThrow('exact-market-invalid-receipt-time');
    }
  });
  it('requires exact spot BTC/USDT metadata and a single trading instrument', () => {
    expect(() => parseRawBook({ ...book(), result: { ...book().result, category: 'linear' } }, now, now))
      .toThrow('exact-market-wrong-market');
    expect(() => parseRawBook({ ...book(), result: { ...book().result, s: 'ETHUSDT' } }, now, now))
      .toThrow('exact-market-wrong-market');
    for (const patch of [{ symbol: 'ETHUSDT' }, { baseCoin: 'ETH' }, { quoteCoin: 'USD' }, { status: 'PendingOpen' }]) {
      const raw = instrument(); Object.assign(raw.result.list[0], patch);
      expect(() => parseRawInstrument(raw, now, now)).toThrow('exact-market-wrong-market');
    }
    for (const result of [{ category: 'linear', list: instrument().result.list }, { list: instrument().result.list },
      { category: 'spot', list: [] }, { category: 'spot', list: [null] },
      { category: 'spot', list: [...instrument().result.list, ...instrument().result.list] }]) {
      expect(() => parseRawInstrument({ retCode: 0, result }, now, now)).toThrow('exact-market-wrong-market');
    }
  });
  it('revalidates raw conversions and emits fixed errors on hostile payloads', () => {
    for (const raw of [null, undefined, [], 'secret']) {
      expect(() => parseRawBook(raw, now, now)).toThrow('exact-market-invalid-response');
      expect(() => parseRawInstrument(raw, now, now)).toThrow('exact-market-invalid-response');
      expect(() => toPaperBook(raw as unknown as RawBook)).toThrow('exact-market-wrong-market');
      expect(() => toPaperInstrument(raw as unknown as RawInstrument)).toThrow('exact-market-wrong-market');
    }
  });
});

describe('bounded public Bybit client', () => {
  it('uses only fixed public GET endpoints without credentials, redirects or request bodies', async () => {
    const mock = vi.fn<typeof fetch>().mockResolvedValueOnce(json(book())).mockResolvedValueOnce(json(instrument()));
    const client = new ExactBybitClient(mock, () => now);
    await client.getBook(); await client.getInstrument();
    expect(mock.mock.calls.map(([url]) => url)).toEqual([
      'https://api.bybit.com/v5/market/orderbook?category=spot&symbol=BTCUSDT&limit=50',
      'https://api.bybit.com/v5/market/instruments-info?category=spot&symbol=BTCUSDT'
    ]);
    for (const [, options] of mock.mock.calls) {
      expect(options).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error', headers: { accept: 'application/json' } });
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      expect(options).not.toHaveProperty('body');
      expect(Object.keys(options?.headers ?? {})).toEqual(['accept']);
    }
  });
  it.each([418, 429, 10006])('shares at least 60-second cooldown across methods after %s without retries', async code => {
    let time = now;
    const limited = code === 10006 ? json({ retCode: code, retMsg: 'do-not-output' }) : new Response('do-not-output', { status: code });
    const mock = vi.fn<typeof fetch>().mockResolvedValueOnce(limited).mockImplementation(async () => json(instrument()));
    const client = new ExactBybitClient(mock, () => time);
    await expect(client.getBook()).rejects.toThrow('exact-market-rate-limited');
    await expect(client.getInstrument()).rejects.toThrow('exact-market-cooldown');
    time += 59_999;
    await expect(client.getBook()).rejects.toThrow('exact-market-cooldown');
    expect(mock).toHaveBeenCalledTimes(1);
    time++;
    expect((await client.getInstrument()).venue).toBe('bybit');
    expect(mock).toHaveBeenCalledTimes(2);
  });
  it('honours longer Retry-After seconds and HTTP dates without shortening the server wait', async () => {
    for (const retryAfter of ['120', new Date(now + 120_000).toUTCString()]) {
      let time = now;
      const mock = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', {
        status: 429, headers: { 'retry-after': retryAfter }
      })).mockImplementation(async () => json(instrument()));
      const client = new ExactBybitClient(mock, () => time);
      await expect(client.getBook()).rejects.toThrow('exact-market-rate-limited');
      time += 119_999;
      await expect(client.getInstrument()).rejects.toThrow('exact-market-cooldown');
      expect(mock).toHaveBeenCalledTimes(1);
      time++;
      await expect(client.getInstrument()).resolves.toHaveProperty('venue', 'bybit');
      expect(mock).toHaveBeenCalledTimes(2);
    }
    let time = now;
    const mock = vi.fn<typeof fetch>(async () => new Response('', { status: 418,
      headers: { 'retry-after': '9'.repeat(400) } }));
    const client = new ExactBybitClient(mock, () => time);
    await expect(client.getBook()).rejects.toThrow('exact-market-rate-limited');
    time = Number.MAX_SAFE_INTEGER;
    await expect(client.getInstrument()).rejects.toThrow('exact-market-cooldown');
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it('enforces streamed bytes even with absent or misleading Content-Length and cancels reading', async () => {
    for (const header of [undefined, '1']) {
      let canceled = false;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(70_000)); controller.enqueue(new Uint8Array(70_000)); },
        cancel() { canceled = true; }
      });
      const mock = vi.fn<typeof fetch>(async () => new Response(stream,
        header ? { headers: { 'content-length': header } } : undefined));
      await expect(new ExactBybitClient(mock, () => now).getBook()).rejects.toThrow('exact-market-response-too-large');
      expect(canceled).toBe(true);
      expect(mock).toHaveBeenCalledTimes(1);
    }
    const mock = vi.fn<typeof fetch>(async () => new Response('{}', { headers: { 'content-length': '131073' } }));
    await expect(new ExactBybitClient(mock, () => now).getBook()).rejects.toThrow('exact-market-response-too-large');
  });
  it('accepts exactly the byte limit and rejects invalid JSON without raw text', async () => {
    const body = JSON.stringify(book());
    const mock = vi.fn<typeof fetch>(async () => new Response(body.padEnd(128 * 1024, ' ')));
    expect((await new ExactBybitClient(mock, () => now).getBook()).venue).toBe('bybit');
    const bad = vi.fn<typeof fetch>(async () => new Response('private-server-body'));
    await expect(new ExactBybitClient(bad, () => now).getBook()).rejects.toThrowError(new PaperError('exact-market-invalid-response'));
  });
  it('enforces the five-second deadline for stalled fetch and body reading', async () => {
    vi.useFakeTimers();
    for (const mock of [vi.fn<typeof fetch>(() => new Promise(() => undefined)),
      vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({ start() {} })))]) {
      const promise = new ExactBybitClient(mock, () => now).getBook();
      const assertion = expect(promise).rejects.toThrowError(new PaperError('exact-market-timeout'));
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
      expect(mock).toHaveBeenCalledTimes(1);
    }
  });
  it('honours caller abort before and during a request without leaking its reason', async () => {
    const pre = new AbortController(); pre.abort('private-abort-detail');
    const mock = request(book());
    await expect(new ExactBybitClient(mock, () => now).getBook(pre.signal)).rejects.toThrow('exact-market-aborted');
    expect(mock).not.toHaveBeenCalled();
    const running = new AbortController();
    const stalled = vi.fn<typeof fetch>(() => new Promise(() => undefined));
    const promise = new ExactBybitClient(stalled, () => now).getBook(running.signal);
    const assertion = expect(promise).rejects.toThrowError(new PaperError('exact-market-aborted'));
    running.abort('private-abort-detail'); await assertion;
  });
  it('removes the abort listener immediately while consuming a late rejected request', async () => {
    const controller = new AbortController();
    let rejectRequest!: (reason: Error) => void;
    let removeListener!: ReturnType<typeof vi.spyOn>;
    const mock = vi.fn<typeof fetch>((_url, options) => {
      removeListener = vi.spyOn(options!.signal!, 'removeEventListener');
      return new Promise((_resolve, reject) => { rejectRequest = reject; });
    });
    const pending = new ExactBybitClient(mock, () => now).getBook(controller.signal);
    const assertion = expect(pending).rejects.toThrow('exact-market-aborted');
    controller.abort();
    await assertion;
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    rejectRequest(new Error('private-late-error'));
    await Promise.resolve();
    removeListener.mockRestore();
  });
  it('sanitizes HTTP, API and thrown errors without including payloads or URLs', async () => {
    const examples: [typeof fetch, string][] = [
      [vi.fn<typeof fetch>(async () => new Response('private-http-body', { status: 503 })), 'exact-market-http-error'],
      [request({ retCode: 999, retMsg: 'private-api-message' }), 'exact-market-api-error'],
      [vi.fn<typeof fetch>(async () => { throw new Error('private-url?secret=value'); }), 'exact-market-request-failed'],
      [vi.fn<typeof fetch>(async () => { throw new PaperError('private-url?secret=value'); }), 'exact-market-request-failed']
    ];
    for (const [mock, reason] of examples) {
      await expect(new ExactBybitClient(mock, () => now).getBook()).rejects.toThrowError(new PaperError(reason));
      expect(mock).toHaveBeenCalledTimes(1);
    }
  });
});
