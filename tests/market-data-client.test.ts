import { afterEach, describe, expect, it, vi } from 'vitest';
import { DerivativesPublicClient } from '../src/market-data/client.js';
import { compareContractGrids } from '../src/market-data/compatibility.js';
import { parsePublicJson } from '../src/market-data/exact-json.js';
import { parseMexcInstrument } from '../src/market-data/mexc.js';
import { parseOkxInstrument } from '../src/market-data/okx.js';
import { publicUrl } from '../src/market-data/model.js';
import type { InstrumentSpec, ResearchBase, ResearchExchange } from '../src/market-data/model.js';

const now = 1_790_839_953_441;
const mexcInstrument = (base: ResearchBase) => ({ symbol: `${base}_USDT`, baseCoin: base, quoteCoin: 'USDT', settleCoin: 'USDT',
  futureType: 1, type: 1, state: 0, automaticDelivery: 0, apiAllowed: true, preMarket: false,
  contractSize: base === 'BTC' ? '0.0001' : '0.01', volUnit: 1, minVol: 1, priceUnit: base === 'BTC' ? '0.1' : '0.01', maxVol: 400000, limitMaxVol: 800000 });
const okxInstrument = (base: ResearchBase) => ({ instType: 'SWAP', instId: `${base}-USDT-SWAP`, instFamily: `${base}-USDT`, uly: `${base}-USDT`,
  ctVal: base === 'BTC' ? '0.01' : '0.1', ctMult: '1', ctType: 'linear', ctValCcy: base,
  baseCcy: '', quoteCcy: '', settleCcy: 'USDT', lotSz: '0.01', minSz: '0.01', tickSz: base === 'BTC' ? '0.1' : '0.01',
  maxMktSz: '20000', maxLmtSz: '1000000', state: 'live', listTime: '1573557408000', expTime: '', groupId: '4',
  upcChg: [], tradeQuoteCcyList: [], ruleType: 'normal' });
const packet = (exchange: ResearchExchange, data: Record<string, unknown>) => exchange === 'mexc' ? { success: true, code: 0, data } : { code: '0', data: [data], msg: '' };
function fixture(url: string) {
  const exchange = url.startsWith('https://api.mexc.com/') ? 'mexc' : 'okx';
  const base = url.includes('BTC') ? 'BTC' : 'ETH';
  const isFunding = url.includes('funding_rate/') || url.includes('funding-rate?');
  const data = isFunding ? exchange === 'mexc' ? { symbol: `${base}_USDT`, fundingRate: '0.0001', collectCycle: 8,
    nextSettleTime: now + 1000000, minFundingRate: '-0.01', maxFundingRate: '0.01' } : {
      instType: 'SWAP', instId: `${base}-USDT-SWAP`, method: 'current_period', fundingRate: '0.0002',
      fundingTime: String(now + 1000000), nextFundingTime: String(now + 1000000 + 28800000), ts: String(now - 10000),
    } : exchange === 'mexc' ? mexcInstrument(base) : okxInstrument(base);
  return packet(exchange, data);
}
const response = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
const request = (override?: (url: string, index: number, init?: RequestInit) => Response | Promise<Response> | undefined) => {
  let index = 0;
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const text = String(url), at = index++;
    return await (override?.(text, at, init) ?? response(fixture(text)));
  }) as ReturnType<typeof vi.fn> & typeof fetch;
};
const clock = () => now;
const parsedSpecs = (base: ResearchBase = 'BTC'): [InstrumentSpec, InstrumentSpec] => {
  const read = (exchange: ResearchExchange, data: Record<string, unknown>) => parsePublicJson(Buffer.from(JSON.stringify(packet(exchange, data))));
  return [parseMexcInstrument(read('mexc', mexcInstrument(base)), base, { url: publicUrl('mexc', base, 'instrument'), requestedAt: now, receivedAt: now }),
    parseOkxInstrument(read('okx', okxInstrument(base)), base, { url: publicUrl('okx', base, 'instrument'), requestedAt: now, receivedAt: now })];
};
afterEach(() => { vi.useRealTimers(); });

describe('fixed one-shot D0 public transport', () => {
  it('performs exactly eight sequential fixed GETs with no headers, credentials, redirects or account calls', async () => {
    const fetch = request(), result = await new DerivativesPublicClient({ fetch, clock }).capture();
    expect(result).toMatchObject({ schema: 1, kind: 'derivatives-public-d0', status: 'complete', requestCount: 8,
      executable: false, accountRequests: false, feesVerified: false, netEdgeBps: null, failures: [] });
    const expectedUrls: string[] = [];
    for (const exchange of ['mexc', 'okx'] as const) for (const base of ['BTC', 'ETH'] as const) for (const kind of ['instrument', 'funding'] as const) expectedUrls.push(publicUrl(exchange, base, kind));
    expect(fetch.mock.calls.map(call => call[0])).toEqual(expectedUrls);
    for (const [, init] of fetch.mock.calls) {
      expect(Object.keys(init).sort()).toEqual(['cache', 'credentials', 'method', 'redirect', 'signal']);
      expect(init).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store' });
      expect(init.headers).toBeUndefined(); expect(init.body).toBeUndefined(); expect(init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(result.observations).toHaveLength(8); expect(result.observations.every(row => !row.parsed.executable)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.observations[0])).toBe(true);
    expect(JSON.parse(result.observations[0].raw).data.symbol).toBe('BTC_USDT');
  });
  it('does not overlap requests', async () => {
    let active = 0, maximum = 0;
    const fetch = request(async url => { active++; maximum = Math.max(maximum, active); await Promise.resolve(); active--; return response(fixture(url)); });
    expect((await new DerivativesPublicClient({ fetch, clock }).capture()).status).toBe('complete'); expect(maximum).toBe(1);
  });
  it('is single use after success and concurrent invocation', async () => {
    const fetch = request(), client = new DerivativesPublicClient({ fetch, clock });
    const first = client.capture(); await expect(client.capture()).rejects.toThrow('public-client-used'); await first;
    await expect(client.capture()).rejects.toThrow('public-client-used'); expect(fetch).toHaveBeenCalledTimes(8);
  });
  it.each([[403, 'public-access-denied'], [429, 'public-rate-limited'], [418, 'public-rate-limited'], [503, 'public-http-failed'], [302, 'public-http-failed']] as const)(
    'stops on the first HTTP %s with no retries, fallback or further venue request', async (status, reason) => {
      const fetch = request(() => new Response('private upstream error text', { status })), client = new DerivativesPublicClient({ fetch, clock });
      const result = await client.capture(); expect(fetch).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ status: 'incomplete', requestCount: 1, observations: [], failures: [{ exchange: 'mexc', base: 'BTC', kind: 'instrument', reason }] });
      expect(JSON.stringify(result)).not.toContain('private upstream error text');
      await expect(client.capture()).rejects.toThrow('public-client-used');
    });
  it('stops at OKX 50011 without fetching the other OKX instruments or falling back', async () => {
    const fetch = request((_url, index) => index === 4 ? response({ code: '50011', msg: 'do not disclose', data: [] }) : undefined);
    const result = await new DerivativesPublicClient({ fetch, clock }).capture();
    expect(fetch).toHaveBeenCalledTimes(5); expect(result).toMatchObject({ status: 'incomplete', requestCount: 5, failures: [{ exchange: 'okx', base: 'BTC', kind: 'instrument', reason: 'public-rate-limited' }] });
    expect(result.observations).toHaveLength(4); expect(JSON.stringify(result)).not.toContain('do not disclose');
  });
  it('stops on a schema error rather than inventing default dimensions', async () => {
    const fetch = request(() => response(packet('mexc', { ...mexcInstrument('BTC'), contractSize: undefined })));
    const result = await new DerivativesPublicClient({ fetch, clock }).capture();
    expect(result.status).toBe('incomplete'); expect(result.observations).toHaveLength(0); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not copy thrown transport messages into the public result', async () => {
    const fetch = request(() => { throw new Error('secret exception content'); });
    const result = await new DerivativesPublicClient({ fetch, clock }).capture();
    expect(result.failures[0].reason).toBe('public-unavailable'); expect(JSON.stringify(result)).not.toContain('secret exception');
  });
  it('times out a fetch that ignores abort and never resolves', async () => {
    vi.useFakeTimers(); let signal: AbortSignal | undefined;
    const fetch = request((_url, _index, init) => { signal = init?.signal as AbortSignal; return new Promise<Response>(() => {}); });
    const capture = new DerivativesPublicClient({ fetch, clock }).capture();
    await vi.advanceTimersByTimeAsync(5000); const result = await capture;
    expect(result.failures[0].reason).toBe('public-timeout'); expect(signal?.aborted).toBe(true); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('bounds full response-body time and cancels a stalled reader', async () => {
    vi.useFakeTimers(); const cancel = vi.fn(); let signal: AbortSignal | undefined;
    const fetch = request((_url, _index, init) => { signal = init?.signal as AbortSignal; return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Buffer.from('{')); }, pull() { return new Promise<void>(() => {}); }, cancel,
    })); });
    const capture = new DerivativesPublicClient({ fetch, clock }).capture();
    await vi.advanceTimersByTimeAsync(5000); const result = await capture;
    expect(result.failures[0].reason).toBe('public-timeout'); expect(signal?.aborted).toBe(true); expect(cancel).toHaveBeenCalledTimes(1);
  });
  it.each(['524289', '-1', 'garbage'])('rejects excessive or invalid declared body size %s before reading', async length => {
    const fetch = request(() => new Response('{}', { headers: { 'content-length': length } }));
    expect((await new DerivativesPublicClient({ fetch, clock }).capture()).failures[0].reason).toBe('public-response-too-large');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('enforces streamed body size even if content-length understates it', async () => {
    const cancel = vi.fn(), fetch = request(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Buffer.alloc(512 * 1024)); controller.enqueue(Buffer.from('x')); }, cancel,
    }), { headers: { 'content-length': '1' } }));
    expect((await new DerivativesPublicClient({ fetch, clock }).capture()).failures[0].reason).toBe('public-response-too-large');
    expect(cancel).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([Buffer.from('{"code":0,"code":1}'), Uint8Array.from([0xff, 0xfe])])('rejects duplicate keys or non-UTF-8 without retries', async bytes => {
    const fetch = request(() => new Response(bytes));
    expect((await new DerivativesPublicClient({ fetch, clock }).capture()).failures[0].reason).toBe('invalid-public-json');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('stops before another request when the whole-capture deadline is reached', async () => {
    let calls = 0; const getTime = () => ++calls < 4 ? now : now + 45000;
    const fetch = request(), result = await new DerivativesPublicClient({ fetch, clock: getTime }).capture();
    expect(fetch).toHaveBeenCalledTimes(1); expect(result.requestCount).toBe(1); expect(result.failures[0].reason).toBe('public-capture-deadline');
  });
  it('rejects unapproved configuration instead of accepting an injected URL or credentials', () => {
    expect(() => new DerivativesPublicClient({ url: 'https://other.example' } as never)).toThrow('invalid-public-options');
    expect(() => new DerivativesPublicClient({ headers: { Authorization: 'test' } } as never)).toThrow('invalid-public-options');
  });
});

describe('matching base-quantity grids is not tradability or profit', () => {
  it.each([['BTC', '0.0001', '1', '0.01'], ['ETH', '0.01', '1', '0.1']] as const)('finds the common %s minimum', (base, minimum, mexcQty, okxQty) => {
    const [mexc, okx] = parsedSpecs(base);
    expect(compareContractGrids(mexc, okx)).toMatchObject({ base, commonBaseQuantityStep: minimum, minimumMatchedBaseQuantity: minimum,
      contractsAtMinimum: { mexc: mexcQty, okx: okxQty }, publicListingsUsable: true, maxExecutableNotional: null, netEdgeBps: null,
      accountEligibilityVerified: false, executable: false });
  });
  it('rounds up both minimum requirements on the common lattice rather than assuming equal contract counts', () => {
    const [m, o] = parsedSpecs();
    const mexc = { ...m, basePerContract: '0.03', quantityStepContracts: '1', minimumContracts: '3', baseQuantityStep: '0.03', baseMinimumQuantity: '0.09' };
    const okx = { ...o, basePerContract: '0.02', quantityStepContracts: '1', minimumContracts: '1', baseQuantityStep: '0.02', baseMinimumQuantity: '0.02' };
    expect(compareContractGrids(mexc, okx)).toMatchObject({ commonBaseQuantityStep: '0.06', minimumMatchedBaseQuantity: '0.12', contractsAtMinimum: { mexc: '4', okx: '6' } });
  });
  it('carries unavailable listings as unavailable while retaining mathematical grid information', () => {
    const [mexc, okx] = parsedSpecs();
    expect(compareContractGrids({ ...mexc, publicListingUsable: false }, okx)).toMatchObject({ publicListingsUsable: false, executable: false });
  });
  it.each([
    { baseQuantityStep: '0.0002' }, { baseMinimumQuantity: '0.0002' }, { basePerContract: '0.0002' },
    { quantityStepContracts: '2' }, { minimumContracts: '2' },
  ])('rejects contradictory source and derived contract fields: %j', patch => {
    const [mexc, okx] = parsedSpecs(); expect(() => compareContractGrids({ ...mexc, ...patch }, okx)).toThrow();
  });
  it('rejects swapped venues, a mixed base, or inverse settlement masquerading as the same market', () => {
    const [mexc, okx] = parsedSpecs(), [, eth] = parsedSpecs('ETH');
    expect(() => compareContractGrids(okx, mexc)).toThrow(); expect(() => compareContractGrids(mexc, eth)).toThrow();
    expect(() => compareContractGrids(mexc, { ...okx, market: { ...okx.market, settlement: 'BTC' } } as never)).toThrow();
  });
});
