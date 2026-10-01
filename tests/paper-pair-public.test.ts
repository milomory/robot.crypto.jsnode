import { describe, it, expect, vi } from 'vitest';
import { ExactPairPublicClient, parsePairBook, parsePairInstrument, validatePairBook, validatePairInstrument, parsePairUsdIndex, validatePairUsdIndex } from '../src/paper-pair/public.js';
import { T, rawBook, rawInstrument } from './helpers/pair-fixtures.js';

describe('exact paired public inputs', () => {
  it('preserves decimals beyond binary and eight-place precision; MEXC has no source timestamp', () => {
    const p = parsePairBook('mexc', { ...rawBook('mexc'), timestamp: T }, T, T + 20);
    expect(p.bids[0][0]).toBe('49999.000000000000000001'); expect(p.sourceAt).toBeNull();
    expect(validatePairBook(p)).toEqual(p);
  });
  it.each([50000, '5e4', 'NaN', '0', '-1'])('rejects nonpositive/numeric/nonordinary price %s', price => {
    expect(() => parsePairBook('mexc', { lastUpdateId: 1, bids: [[price, '1']], asks: [['60000', '1']] }, T, T + 1)).toThrow('invalid-public-book');
  });
  it('rejects crossed, duplicate, unordered and stale books', () => {
    for (const bids of [[['50000', '1']], [['49999', '1'], ['49999', '2']], [['49998', '1'], ['49999', '1']]]) {
      expect(() => parsePairBook('mexc', { lastUpdateId: 1, bids, asks: [['50000', '1']] }, T, T)).toThrow();
    }
    expect(() => parsePairBook('okx', rawBook('okx', T - 6000), T, T)).toThrow();
    expect(() => parsePairBook('mexc', rawBook('mexc'), T, T + 5001)).toThrow();
  });
  it('does not invent MEXC step from its minimum or asset precision', () => {
    const p = parsePairInstrument('mexc', rawInstrument('mexc'), T, T + 1);
    expect(p.quantityStep).toBeNull(); expect(p.minQuantity).toBe('0.000001');
    expect(p.reason).toBe('quantity-step-unconfirmed'); expect(validatePairInstrument(p)).toEqual(p);
    expect(() => validatePairInstrument({ ...p, status: 'supported', quantityStep: '0.000001' })).toThrow();
  });
  it('treats OKX maxMktSz as USDT; a USD cap is not silently converted to USDT', () => {
    const raw = rawInstrument('okx'); const p = parsePairInstrument('okx', raw, T, T + 1);
    expect(p.maxQuantity).toBeNull(); expect(p.maxNotionalUsdt).toBe('1000000'); expect(p.status).toBe('supported');
    raw.data[0].maxMktAmt = '1000000'; expect(parsePairInstrument('okx', raw, T, T + 1).reason).toBe('usd-limit-unconverted');
    raw.data[0].maxMktAmt = ''; raw.data[0].upcChg = [{}]; expect(parsePairInstrument('okx', raw, T, T + 1).reason).toBe('upcoming-rule-change');
  });
  it('only calls fixed GET URLs with credentials omitted and redirects refused', async () => {
    const request = vi.fn(async (_url: unknown, _options: unknown) => new Response(JSON.stringify(rawBook('mexc'))));
    const c = new ExactPairPublicClient(request as typeof fetch, () => T);
    await c.getBook('mexc'); const [url, options] = request.mock.calls[0];
    expect(url).toBe('https://api.mexc.com/api/v3/depth?symbol=BTCUSDT&limit=50');
    expect(options).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error' });
    expect(options).not.toHaveProperty('headers');
  });
  it('halts a venue after rate limiting and never exposes upstream body', async () => {
    const request = vi.fn(async () => new Response('private-token', { status: 429 }));
    const c = new ExactPairPublicClient(request as typeof fetch, () => T);
    await expect(c.getBook('mexc')).rejects.toThrow('public-http-unavailable');
    await expect(c.getInstrument('mexc')).rejects.toThrow('public-venue-unavailable'); expect(request).toHaveBeenCalledTimes(1);
  });
  it.each(['50011', '50040'])('halts OKX after a HTTP200 API rate limit %s', async code => {
    const request = vi.fn(async () => new Response(JSON.stringify({ code, msg: 'private-text' })));
    const c = new ExactPairPublicClient(request as typeof fetch, () => T);
    await expect(c.getBook('okx')).rejects.toThrow('public-rate-limited');
    await expect(c.getBook('okx')).rejects.toThrow('public-venue-unavailable');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('bounds declared and streamed response bytes', async () => {
    for (const response of [new Response('{}', { headers: { 'content-length': '999999' } }), new Response('x'.repeat(131073))]) {
      const c = new ExactPairPublicClient((async () => response) as typeof fetch, () => T);
      await expect(c.getBook('mexc')).rejects.toThrow('public-response-too-large');
    }
  });
  it('bounds a transport that does not cooperate with cancellation', async () => {
    vi.useFakeTimers();
    try {
      const c = new ExactPairPublicClient((async () => new Promise(() => {})) as typeof fetch, () => T);
      const promise = expect(c.getBook('mexc')).rejects.toThrow('public-timeout');
      await vi.advanceTimersByTimeAsync(5001); await promise;
    } finally { vi.useRealTimers(); }
  });
});


describe('separate public BTC-USD index', () => {
  const raw = (patch = {}) => ({ code: '0', data: [{ instId: 'BTC-USD', idxPx: '84027.300000000001', ts: String(T), ...patch }] });
  it('preserves USD decimals and source time', () => {
    const index = parsePairUsdIndex(raw(), T, T + 20);
    expect(index.usdPerBtc).toBe('84027.300000000001');
    expect(index.sourceAt).toBe(T); expect(validatePairUsdIndex(index)).toEqual(index);
  });
  it.each([{ instId: 'BTC-USDT' }, { idxPx: 84027.3 }, { idxPx: '8e4' }, { ts: String(T - 5001) }, { ts: String(T + 1001) }])('rejects wrong unit, numeric prices and stale/future source %j', patch => {
    expect(() => parsePairUsdIndex(raw(patch), T, T)).toThrow('invalid-public-usd-index');
  });
  it('uses a fixed anonymous GET and shares the OKX rate-limit gate', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify(raw())));
    const client = new ExactPairPublicClient(request as typeof fetch, () => T);
    await client.getUsdIndex();
    expect(request).toHaveBeenCalledWith('https://www.okx.com/api/v5/market/index-tickers?instId=BTC-USD', expect.objectContaining({ method: 'GET', credentials: 'omit', redirect: 'error' }));
    const limited = vi.fn(async () => new Response(JSON.stringify({ code: '50011', msg: 'private-text' })));
    const blocked = new ExactPairPublicClient(limited as typeof fetch, () => T);
    await expect(blocked.getUsdIndex()).rejects.toThrow('public-rate-limited');
    await expect(blocked.getBook('okx')).rejects.toThrow('public-venue-unavailable');
    expect(limited).toHaveBeenCalledTimes(1);
  });
});
