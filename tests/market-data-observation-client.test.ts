import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parsePublicJson } from '../src/market-data/exact-json.js';
import { DerivativesObservationClient, normalizeObservation, type D0bCapture } from '../src/market-data/observations-client.js';
import { MarketDataError } from '../src/market-data/model.js';
import { replayObservationArchive } from '../src/market-data/observations-replay.js';
import { parseMexcInstrument } from '../src/market-data/mexc.js';
import { parseOkxInstrument } from '../src/market-data/okx.js';
import { assertBoundSpec, assertHistoryOrder, assertObservationReceipt, assertUncrossed, bookLevels, historyCount,
  observationPlan, observationUrl, signedRate, sourceFresh, sourceTime } from '../src/market-data/observation-model.js';
import type { FundingEvent, Route } from '../src/market-data/observation-model.js';
import type { InstrumentSpec, PublicReceipt, ResearchBase, ResearchExchange } from '../src/market-data/model.js';

const now = 1_790_840_507_000;
const d0 = JSON.parse(readFileSync(new URL('../fixtures/market-data/d0-public-20261001.json', import.meta.url), 'utf8')) as {
  report: { observations: { raw: string; parsed: InstrumentSpec; receipt: PublicReceipt }[] };
};
const instrumentWire = (exchange: ResearchExchange, base: ResearchBase) => d0.report.observations.find(row =>
  row.parsed.kind === 'public-linear-contract' && row.parsed.market.exchange === exchange && row.parsed.market.base === base)!.raw;
function receipt(route: Route, requestedAt = now, receivedAt = requestedAt): PublicReceipt {
  return { url: observationUrl(route.exchange, route.base, route.kind), requestedAt, receivedAt };
}
function spec(exchange: ResearchExchange = 'mexc', base: ResearchBase = 'BTC'): InstrumentSpec {
  const read = exchange === 'mexc' ? parseMexcInstrument : parseOkxInstrument;
  return read(parsePublicJson(Buffer.from(instrumentWire(exchange, base))), base, receipt({ exchange, base, kind: 'instrument' }));
}
const bookRoute: Route = { exchange: 'mexc', base: 'BTC', kind: 'book' };
const levelRows = (text: string) => parsePublicJson(Buffer.from(text));
afterEach(() => { vi.useRealTimers(); });

describe('D0b contract, receipt and public quantity binding', () => {
  it('contains exactly 24 unique immutable public routes, preserving adjacent venue books per base', () => {
    const plan = observationPlan();
    expect(plan).toHaveLength(24); expect(Object.isFrozen(plan)).toBe(true); expect(Object.isFrozen(plan[0])).toBe(true);
    expect(new Set(plan.map(route => observationUrl(route.exchange, route.base, route.kind))).size).toBe(24);
    for (const base of ['BTC', 'ETH'] as const) {
      const perBase = plan.filter(route => route.base === base);
      expect(perBase.filter(route => route.exchange === 'mexc').map(route => route.kind)).toEqual(['instrument', 'funding', 'ticker', 'history', 'book']);
      expect(perBase.filter(route => route.exchange === 'okx').map(route => route.kind)).toEqual(['instrument', 'funding', 'mark', 'index', 'open-interest', 'history', 'book']);
      expect(perBase.slice(-2)).toEqual([{ exchange: 'mexc', base, kind: 'book' }, { exchange: 'okx', base, kind: 'book' }]);
    }
  });
  it.each([['mexc', 'mark'], ['mexc', 'index'], ['mexc', 'open-interest'], ['okx', 'ticker'], ['okx', 'withdraw']] as const)(
    'does not accept an unapproved %s %s route', (exchange, kind) => {
      expect(() => observationUrl(exchange, 'BTC', kind as never)).toThrow('unsupported-observation-route');
    });
  it('binds each receipt to the exact URL and a book-specific bounded response duration', () => {
    expect(() => assertObservationReceipt(receipt(bookRoute, now, now + 3000), bookRoute)).not.toThrow();
    expect(() => assertObservationReceipt(receipt(bookRoute, now, now + 3001), bookRoute)).toThrow();
    expect(() => assertObservationReceipt({ ...receipt(bookRoute), url: observationUrl('mexc', 'ETH', 'book') }, bookRoute)).toThrow();
    expect(() => assertObservationReceipt({ ...receipt(bookRoute), token: 'not allowed' } as never, bookRoute)).toThrow();
    expect(() => assertObservationReceipt(receipt(bookRoute, now, now - 1), bookRoute)).toThrow();
    expect(() => assertObservationReceipt({ ...receipt(bookRoute), receivedAt: Infinity }, bookRoute)).toThrow();
    const history = { ...bookRoute, kind: 'history' } as const;
    expect(() => assertObservationReceipt(receipt(history, now, now + 5000), history)).not.toThrow();
    expect(() => assertObservationReceipt(receipt(history, now, now + 5001), history)).toThrow();
  });
  it('accepts the same captured spec only before the bounded metadata-age limit', () => {
    expect(() => assertBoundSpec(spec(), bookRoute, receipt(bookRoute, now + 1_200_000))).not.toThrow();
    expect(() => assertBoundSpec(spec(), bookRoute, receipt(bookRoute, now + 1_200_001))).toThrow('observation-spec-mismatch');
    expect(() => assertBoundSpec(spec(), bookRoute, receipt(bookRoute, now - 1))).toThrow('observation-spec-mismatch');
  });
  it.each([
    { baseQuantityStep: '0.0002' }, { baseMinimumQuantity: '0.0002' }, { basePerContract: '0.0002' },
    { quantityStepContracts: '2' }, { minimumContracts: '2' }, { contractMultiplier: '2' }, { quantityUnit: 'BTC' },
  ])('rejects altered units or inconsistent source-derived dimensions %j', patch => {
    expect(() => assertBoundSpec({ ...spec(), ...patch } as InstrumentSpec, bookRoute, receipt(bookRoute))).toThrow();
  });
  it('rejects a valid spec from the other venue, base or instrument route', () => {
    expect(() => assertBoundSpec(spec('okx'), bookRoute, receipt(bookRoute))).toThrow('observation-spec-mismatch');
    expect(() => assertBoundSpec(spec('mexc', 'ETH'), bookRoute, receipt(bookRoute))).toThrow('observation-spec-mismatch');
    expect(() => assertBoundSpec({ ...spec(), receipt: receipt(bookRoute) }, bookRoute, receipt(bookRoute))).toThrow();
  });
  it('derives book base amounts using the different venue contract sizes', () => {
    expect(bookLevels(levelRows('[["83000","2","3"]]'), 'bids', 3, spec())[0]).toEqual({ price: '83000', quantityContracts: '2', quantityBase: '0.0002', orderCount: '3' });
    expect(bookLevels(levelRows('[["83000","0.02","0","3"]]'), 'bids', 4, spec('okx'))[0].quantityBase).toBe('0.0002');
    expect(bookLevels(levelRows('[["2600","2","3"]]'), 'bids', 3, spec('mexc', 'ETH'))[0].quantityBase).toBe('0.02');
  });
  it.each([
    '[]', '[["83000","0","1"]]', '[["83000.01","1","1"]]', '[["83000","0.5","1"]]',
    '[["83000","1","1"],["83000","2","1"]]', '[["83000","1","1"],["83000.1","2","1"]]',
    '[["83000","1","1.5"]]', '[["83000","1","-1"]]', '[["83000","1","1","extra"]]',
  ])('rejects invalid, duplicate, unsorted or off-grid contract depth %s', text => {
    expect(() => bookLevels(levelRows(text), 'bids', 3, spec())).toThrow();
  });
  it('rejects unsupported OKX level metadata and a locked or crossed book', () => {
    expect(() => bookLevels(levelRows('[["83000","0.01","1","1"]]'), 'bids', 4, spec('okx'))).toThrow();
    const bids = bookLevels(levelRows('[["83000","1","1"]]'), 'bids', 3, spec());
    expect(() => assertUncrossed(bids, bookLevels(levelRows('[["83000","1","1"]]'), 'asks', 3, spec()))).toThrow('crossed-public-book');
    expect(() => assertUncrossed(bids, bookLevels(levelRows('[["82999.9","1","1"]]'), 'asks', 3, spec()))).toThrow('crossed-public-book');
    expect(() => assertUncrossed(bids, bookLevels(levelRows('[["83000.1","1","1"]]'), 'asks', 3, spec()))).not.toThrow();
  });
});

describe('D0b public timestamps and historical funding are qualified, not income', () => {
  it.each(['exchange-system', 'response-time', 'trade'] as const)('does not call a recent %s timestamp fresh market data', meaning => {
    const time = sourceTime(String(now), meaning, receipt(bookRoute), 5000);
    expect(time.ageStatus).toBe('within-window'); expect(sourceFresh(time)).toBe(false);
  });
  it('distinguishes missing, stale, future and genuine bounded update time', () => {
    expect(sourceTime(undefined, 'book-generation', receipt(bookRoute), 5000)).toMatchObject({ at: null, ageStatus: 'missing', ageMs: null });
    expect(sourceFresh(sourceTime(undefined, 'book-generation', receipt(bookRoute), 5000))).toBe(false);
    expect(sourceTime(String(now - 5001), 'book-generation', receipt(bookRoute), 5000).ageStatus).toBe('stale');
    expect(sourceTime(String(now + 5001), 'price-update', receipt(bookRoute), 5000).ageStatus).toBe('future');
    expect(sourceFresh(sourceTime(String(now - 5000), 'book-generation', receipt(bookRoute), 5000))).toBe(true);
    expect(sourceTime(String(now + 5000), 'price-update', receipt(bookRoute), 5000).ageMs).toBe(-5000);
  });
  it('does not make timestamps from native rounded numbers or negative fractional values', () => {
    for (const value of [now, -1, '-1', '1.5', 'NaN']) expect(() => sourceTime(value, 'book-generation', receipt(bookRoute), 5000)).toThrow();
  });
  it('requires settlement events to be unique, strictly descending and before the request', () => {
    const event = (settlementAt: number): FundingEvent => ({ settlementAt, forecastRate: null, settledRate: '0.0001', rateMeaning: 'reported-settlement-rate', reportedIntervalMs: null, method: null, formula: null });
    expect(() => assertHistoryOrder([event(now - 1), event(now - 3_600_001)], receipt(bookRoute))).not.toThrow();
    for (const times of [[now], [now + 1], [now - 1, now - 1], [now - 2, now - 1]]) {
      expect(() => assertHistoryOrder(times.map(event), receipt(bookRoute))).toThrow('invalid-history-order');
    }
    expect(() => assertHistoryOrder(Array.from({ length: 21 }, (_, index) => event(now - index - 1)), receipt(bookRoute))).toThrow('invalid-history-count');
  });
  it('retains signed settlement rates and bounds untrusted counts', () => {
    expect(signedRate('-0.00100')).toBe('-0.001'); expect(signedRate('0')).toBe('0');
    expect(() => signedRate('1.00001')).toThrow('invalid-history-rate'); expect(() => signedRate('-1.00001')).toThrow('invalid-history-rate');
    expect(historyCount('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => historyCount('9007199254740992')).toThrow('invalid-history-count');
  });
});

// Synthetic transport responses: successful mocks are not live endpoint acceptance.
function observationFixture(route: Route): string {
  const { exchange, base, kind } = route;
  if (kind === 'instrument') return instrumentWire(exchange, base);
  const identity = { instType: 'SWAP', instId: `${base}-USDT-SWAP` };
  let data: unknown;
  if (exchange === 'mexc') {
    if (kind === 'funding') data = { symbol: `${base}_USDT`, fundingRate: '0.0001', collectCycle: 8, nextSettleTime: now + 3600000, timestamp: now };
    else if (kind === 'book') data = { bids: [['60000', '10', '1']], asks: [['60000.1', '20', '2']], timestamp: now, version: 123, cts: null };
    else if (kind === 'ticker') data = { symbol: `${base}_USDT`, fairPrice: '60000', indexPrice: '60000.1', holdVol: '30', timestamp: now };
    else if (kind === 'history') data = { pageSize: 20, totalCount: 1, totalPage: 1, currentPage: 1,
      resultList: [{ symbol: `${base}_USDT`, fundingRate: '0.00001', settleTime: now - 3600000, collectCycle: 8 }] };
    else throw Error('invalid synthetic route');
    return JSON.stringify({ success: true, code: 0, data });
  }
  if (kind === 'funding') data = { ...identity, method: 'current_period', fundingRate: '0.0002', fundingTime: String(now + 3600000),
    nextFundingTime: String(now + 3600000 + 28800000), ts: String(now) };
  else if (kind === 'book') data = { bids: [['60000', '1', '0', '1']], asks: [['60000.1', '1', '0', '1']], seqId: '123', ts: String(now) };
  else if (kind === 'mark') data = { ...identity, markPx: '60000', ts: String(now) };
  else if (kind === 'index') data = { instId: `${base}-USDT`, idxPx: '60000', ts: String(now) };
  else if (kind === 'open-interest') data = { ...identity, oi: '100', oiCcy: base === 'BTC' ? '1' : '10', oiUsd: '60000', ts: String(now) };
  else if (kind === 'history') data = { ...identity, fundingTime: String(now - 3600000), fundingRate: '0.0001', realizedRate: '0.00009', method: 'current_period', formulaType: 'withRate' };
  else throw Error('invalid synthetic route');
  return JSON.stringify({ code: '0', data: [data] });
}
const mockRequest = (override?: (route: Route, index: number, init?: RequestInit) => Response | Promise<Response> | undefined) => {
  let index = 0;
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const route = observationPlan().find(r => observationUrl(r.exchange, r.base, r.kind) === String(url));
    if (!route) throw Error('request escaped public route allowlist');
    const current = index++;
    return await (override?.(route, current, init) ?? new Response(observationFixture(route)));
  }) as ReturnType<typeof vi.fn> & typeof fetch;
};

describe('D0b fixed bounded public transport', () => {
  it('captures exactly the 24 fixed sequential GETs with no headers, keys, credentials, redirects or request body', async () => {
    let active = 0, maximum = 0;
    const fetch = mockRequest(async route => { active++; maximum = Math.max(maximum, active); await Promise.resolve(); active--; return new Response(observationFixture(route)); });
    const result = await new DerivativesObservationClient({ fetch, clock: () => now }).capture();
    expect(result).toMatchObject({ schema: 1, kind: 'derivatives-public-d0b', requestCount: 24, status: 'complete', failures: [],
      executable: false, accountRequests: false, feesVerified: false, netEdgeBps: null });
    expect(maximum).toBe(1); expect(result.observations).toHaveLength(24);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(observationPlan().map(r => observationUrl(r.exchange, r.base, r.kind)));
    for (const [, init] of fetch.mock.calls) {
      expect(Object.keys(init).sort()).toEqual(['cache', 'credentials', 'method', 'redirect', 'signal']);
      expect(init).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store' });
      expect(init.signal).toBeInstanceOf(AbortSignal); expect(init.headers).toBeUndefined(); expect(init.body).toBeUndefined();
    }
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.observations[0].parsed)).toBe(true);
    expect(result.observations.every(row => row.parsed.executable === false)).toBe(true);
    expect(result.quality).toHaveLength(2);
    expect(result.quality.every(row => !row.usableForBookComparison && row.reasons.includes('mexc-book-update-time-unverified'))).toBe(true);
  });
  it('is single use for concurrent calls and after a completed capture', async () => {
    const fetch = mockRequest(), client = new DerivativesObservationClient({ fetch, clock: () => now });
    const first = client.capture(); await expect(client.capture()).rejects.toThrow('public-client-used'); await first;
    await expect(client.capture()).rejects.toThrow('public-client-used'); expect(fetch).toHaveBeenCalledTimes(24);
  });
  it.each([[403, 'public-access-denied'], [429, 'public-rate-limited'], [418, 'public-rate-limited'], [503, 'public-http-failed'], [302, 'public-http-failed']] as const)(
    'stops the complete run after HTTP %s at OKX, retaining only the accepted prefix', async (status, reason) => {
      const fetch = mockRequest((_route, index) => index === 1 ? new Response('do not publish upstream detail', { status }) : undefined);
      const client = new DerivativesObservationClient({ fetch, clock: () => now }), result = await client.capture();
      expect(result.status).toBe('incomplete'); expect(result.observations).toHaveLength(1); expect(result.requestCount).toBe(2);
      expect(result.failures).toEqual([{ route: observationPlan()[1], reason }]); expect(fetch).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(result)).not.toContain('upstream detail'); await expect(client.capture()).rejects.toThrow('public-client-used');
    });
  it.each(['50011', '50013', '50040', '429', '418'])('stops at public API rate limit %s with no retry or other route', async code => {
    const fetch = mockRequest((_route, index) => index === 5 ? new Response(JSON.stringify({ code, msg: 'private upstream context' })) : undefined);
    const result = await new DerivativesObservationClient({ fetch, clock: () => now }).capture();
    expect(result.failures).toEqual([{ route: observationPlan()[5], reason: 'public-rate-limited' }]);
    expect(result.observations).toHaveLength(5); expect(fetch).toHaveBeenCalledTimes(6); expect(JSON.stringify(result)).not.toContain('upstream context');
  });
  it('stops a malformed response before any fallback and never supplies fabricated observations', async () => {
    const fetch = mockRequest((route, index) => index === 4 ? new Response(JSON.stringify({ success: true, code: 0, data: { symbol: `${route.base}_USDT` } })) : undefined);
    const result = await new DerivativesObservationClient({ fetch, clock: () => now }).capture();
    expect(result.failures).toEqual([{ route: observationPlan()[4], reason: 'public-schema-rejected' }]);
    expect(result.observations).toHaveLength(4); expect(fetch).toHaveBeenCalledTimes(5);
  });
  it.each([new Error('do not expose secret exception'), new MarketDataError('do not expose secret exception')])('does not copy thrown transport or schema details', async error => {
    const fetch = mockRequest(() => { throw error; });
    const result = await new DerivativesObservationClient({ fetch, clock: () => now }).capture();
    expect(result.failures[0].reason).toBe(error instanceof MarketDataError ? 'public-schema-rejected' : 'public-unavailable');
    expect(JSON.stringify(result)).not.toContain('secret exception'); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([[0, 5000], [10, 3000]] as const)('bounds request %s fetch including an abort-ignoring endpoint to %sms', async (target, timeout) => {
    vi.useFakeTimers(); let signal: AbortSignal | undefined;
    const fetch = mockRequest((_route, index, init) => index === target ? (signal = init?.signal as AbortSignal, new Promise<Response>(() => {})) : undefined);
    const capture = new DerivativesObservationClient({ fetch, clock: () => now }).capture();
    await vi.advanceTimersByTimeAsync(0); expect(fetch).toHaveBeenCalledTimes(target + 1);
    await vi.advanceTimersByTimeAsync(timeout - 1); expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1); const result = await capture;
    expect(result.failures[0].reason).toBe('public-timeout'); expect(signal?.aborted).toBe(true);
    expect(result.observations).toHaveLength(target); expect(fetch).toHaveBeenCalledTimes(target + 1);
  });
  it('includes stalled book body reads in the 3s limit and cancels the reader', async () => {
    vi.useFakeTimers(); const cancel = vi.fn();
    const fetch = mockRequest((_route, index) => index === 10 ? new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Buffer.from('{')); }, pull() { return new Promise<void>(() => {}); }, cancel,
    })) : undefined);
    const capture = new DerivativesObservationClient({ fetch, clock: () => now }).capture();
    await vi.advanceTimersByTimeAsync(3000); const result = await capture;
    expect(result.failures[0].reason).toBe('public-timeout'); expect(cancel).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(11);
  });
  it('cancels a late successful response after timeout without parsing it or issuing more requests', async () => {
    vi.useFakeTimers(); let deliver!: (response: Response) => void;
    const fetch = mockRequest(() => new Promise<Response>(resolve => { deliver = resolve; }));
    const capture = new DerivativesObservationClient({ fetch, clock: () => now }).capture();
    await vi.advanceTimersByTimeAsync(5000); const result = await capture;
    const cancel = vi.fn(); deliver(new Response(new ReadableStream<Uint8Array>({ cancel })));
    await vi.advanceTimersByTimeAsync(0);
    expect(result.observations).toHaveLength(0); expect(cancel).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['524289', '-1', 'garbage'])('rejects invalid or excessive declared size %s before processing a body', async length => {
    const fetch = mockRequest(() => new Response('{}', { headers: { 'content-length': length } }));
    expect((await new DerivativesObservationClient({ fetch, clock: () => now }).capture()).failures[0].reason).toBe('public-response-too-large');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('enforces the streamed-byte limit even with understated content-length', async () => {
    const cancel = vi.fn();
    const fetch = mockRequest(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Buffer.alloc(524288)); controller.enqueue(Buffer.from('x')); }, cancel,
    }), { headers: { 'content-length': '1' } }));
    const result = await new DerivativesObservationClient({ fetch, clock: () => now }).capture();
    expect(result.failures[0].reason).toBe('public-response-too-large'); expect(cancel).toHaveBeenCalledTimes(1);
  });
  it.each([Buffer.from('{"code":"0","code":"1"}'), Uint8Array.from([0xff, 0xfe])])('rejects ambiguous JSON or malformed UTF-8 without requests beyond the first', async bytes => {
    const fetch = mockRequest(() => new Response(bytes));
    expect((await new DerivativesObservationClient({ fetch, clock: () => now }).capture()).failures[0].reason).toBe('invalid-public-json');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('stops before the next request when the 125s capture deadline is reached', async () => {
    let calls = 0; const clock = () => ++calls < 4 ? now : now + 125000;
    const fetch = mockRequest(), result = await new DerivativesObservationClient({ fetch, clock }).capture();
    expect(result.failures[0].reason).toBe('public-capture-deadline'); expect(result.requestCount).toBe(1); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('preserves only accepted evidence when the clock moves backwards during a request', async () => {
    let time = now;
    const fetch = mockRequest((_route, index) => { if (index === 1) time--; return undefined; });
    const result = await new DerivativesObservationClient({ fetch, clock: () => time }).capture();
    expect(result).toMatchObject({ status: 'incomplete', requestCount: 2, endedAt: now });
    expect(result.observations).toHaveLength(1); expect(result.failures[0].reason).toBe('invalid-public-clock'); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('cannot obtain metadata for later observations without prior captured instrument evidence', () => {
    expect(() => normalizeObservation(parsePublicJson(Buffer.from(observationFixture(bookRoute))), bookRoute, receipt(bookRoute), [])).toThrow('missing-observation-spec');
  });
  it('rejects configurable routes, origins and authentication', () => {
    for (const options of [{ url: 'https://unapproved.invalid' }, { plan: [] }, { headers: { Authorization: 'test' } }, { secret: 'test' }]) {
      expect(() => new DerivativesObservationClient(options as never)).toThrow('invalid-public-options');
    }
  });
});

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const archiveBytes = (report: unknown) => Buffer.from(JSON.stringify(report) + '\n');
const syntheticCapture = async () => new DerivativesObservationClient({ fetch: mockRequest(), clock: () => now }).capture();
const mutable = (report: D0bCapture) => JSON.parse(JSON.stringify(report)) as D0bCapture;
function replay(report: unknown) { const bytes = archiveBytes(report); return replayObservationArchive(bytes, sha(bytes)); }

describe('D0b offline archive integrity and independent replay', () => {
  it('reconstructs the synthetic complete capture from original raw responses with zero network access', async () => {
    const report = await syntheticCapture(), network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw Error('replay must be offline'); });
    try {
      const result = replay(report);
      expect(result).toEqual(report); expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.observations[0].parsed)).toBe(true);
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });
  it('does historical replay without relabeling original receipt times as current observations', async () => {
    const report = await syntheticCapture(), clock = vi.spyOn(Date, 'now').mockReturnValue(now + 365 * 86400000);
    try {
      const result = replay(report);
      expect(result.startedAt).toBe(now); expect(result.quality.map(q => q.evaluatedAt)).toEqual([now, now]); expect(result.executable).toBe(false);
      expect(clock).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });
  it('preserves a genuine HTTP-error prefix and excludes rejected response text', async () => {
    const report = await new DerivativesObservationClient({ fetch: mockRequest((_route, index) => index === 1 ? new Response('secret detail', { status: 403 }) : undefined), clock: () => now }).capture();
    expect(replay(report)).toEqual(report); expect(replay(report).requestCount).toBe(2); expect(JSON.stringify(replay(report))).not.toContain('secret detail');
  });
  it('accepts pre-request deadline failure without inventing a request', async () => {
    let calls = 0;
    const report = await new DerivativesObservationClient({ fetch: mockRequest(), clock: () => ++calls < 4 ? now : now + 125000 }).capture();
    expect(report.requestCount).toBe(1); expect(replay(report)).toEqual(report);
  });
  it('accepts a final clock rollback as incomplete even when all 24 responses were accepted', async () => {
    let calls = 0;
    const report = await new DerivativesObservationClient({ fetch: mockRequest(), clock: () => ++calls <= 49 ? now : now - 1 }).capture();
    expect(report.status).toBe('incomplete'); expect(report.observations).toHaveLength(24);
    expect(report.failures[0].reason).toBe('invalid-public-clock'); expect(replay(report)).toEqual(report);
  });
  it('marks a final 125s deadline as incomplete after all 24 responses and replays that evidence', async () => {
    let calls = 0;
    const report = await new DerivativesObservationClient({ fetch: mockRequest(), clock: () => ++calls <= 49 ? now : now + 125000 }).capture();
    expect(report.status).toBe('incomplete'); expect(report.observations).toHaveLength(24);
    expect(report.failures[0].reason).toBe('public-capture-deadline'); expect(replay(report)).toEqual(report);
  });
  it('rejects an attempted HTTP failure relabeled as zero additional requests even with an updated hash', async () => {
    const original = await new DerivativesObservationClient({ fetch: mockRequest((_route, index) => index === 1 ? new Response('', { status: 403 }) : undefined), clock: () => now }).capture();
    const report = mutable(original); report.requestCount = report.observations.length;
    expect(() => replay(report)).toThrow('invalid-observation-archive');
  });
  it('rejects altered raw bytes under the original hash and malformed expected digests', async () => {
    const original = archiveBytes(await syntheticCapture()), edited = Buffer.from(original);
    edited[edited.indexOf('60000')] = '5'.charCodeAt(0);
    expect(() => replayObservationArchive(edited, sha(original))).toThrow('invalid-observation-archive');
    for (const hash of ['', '0'.repeat(64), sha(original).toUpperCase(), '1'.repeat(65)]) {
      expect(() => replayObservationArchive(original, hash)).toThrow('invalid-observation-archive');
    }
  });
  it.each(['space', 'duplicate-key', 'rounded-number', 'missing-lf', 'double-lf', 'bom'])(
    'rejects noncanonical %s archives even with a matching content hash', async attack => {
      const raw = archiveBytes(await syntheticCapture()).toString();
      const altered = attack === 'space' ? raw.replace('{', '{ ') : attack === 'duplicate-key' ? raw.replace('"schema":1', '"schema":1,"schema":1') :
        attack === 'rounded-number' ? raw.replace('"requestCount":24', '"requestCount":24.000000000000001') : attack === 'missing-lf' ? raw.slice(0, -1) :
          attack === 'double-lf' ? raw + '\n' : '\ufeff' + raw;
      const bytes = Buffer.from(altered);
      expect(() => replayObservationArchive(bytes, sha(bytes))).toThrow('invalid-observation-archive');
    });
  it('bounds archive size independently of response-body size', () => {
    const bytes = Buffer.alloc(32 * 1024 * 1024 + 1, 32);
    expect(() => replayObservationArchive(bytes, sha(bytes))).toThrow('invalid-observation-archive');
  });
  it.each(['swap', 'duplicate', 'missing', 'extra-route', 'route-url'])(
    'rejects %s route-plan corruption after rehashing', async attack => {
      const report = mutable(await syntheticCapture()), rows = report.observations as Array<D0bCapture['observations'][number]>;
      if (attack === 'swap') [rows[0], rows[1]] = [rows[1], rows[0]];
      else if (attack === 'duplicate') rows[1] = structuredClone(rows[0]);
      else if (attack === 'missing') rows.splice(9, 1);
      else if (attack === 'extra-route') rows.push(structuredClone(rows[23]));
      else rows[10].receipt.url = rows[11].receipt.url;
      expect(() => replay(report)).toThrow('invalid-observation-archive');
    });
  it.each(['received-before-request', 'overlong-book', 'out-of-sequence', 'after-end', 'capture-over-budget'])(
    'rejects inconsistent recorded timing %s', async attack => {
      const report = mutable(await syntheticCapture()), book = report.observations[10];
      if (attack === 'received-before-request') book.receipt.receivedAt = now - 1;
      else if (attack === 'overlong-book') { book.receipt.receivedAt = now + 3001; report.endedAt = now + 3001; }
      else if (attack === 'out-of-sequence') { book.receipt.requestedAt = now - 1; book.receipt.receivedAt = now - 1; }
      else if (attack === 'after-end') book.receipt.receivedAt = now + 1;
      else report.endedAt = now + 125000;
      expect(() => replay(report)).toThrow('invalid-observation-archive');
    });
  it.each(['normalized-only', 'raw-only', 'metadata-derived', 'metadata-raw', 'quality', 'flag', 'extra-field'])(
    'recomputes accepted evidence rather than trusting rehashed %s claims', async attack => {
      const report = mutable(await syntheticCapture()), book = report.observations[10];
      if (attack === 'normalized-only' && book.parsed.kind === 'public-perpetual-book') book.parsed.bids[0].quantityBase = '999';
      else if (attack === 'raw-only') book.raw = book.raw.replace('"60000"', '"59999"');
      else if (attack === 'metadata-derived' && report.observations[0].parsed.kind === 'public-linear-contract') report.observations[0].parsed.basePerContract = '0.01';
      else if (attack === 'metadata-raw') report.observations[0].raw = report.observations[0].raw.replace('"contractSize":0.0001', '"contractSize":0.001');
      else if (attack === 'quality') report.quality[0].usableForBookComparison = true;
      else if (attack === 'flag') report.executable = true as never;
      else (report as unknown as Record<string, unknown>).accountSecret = 'not allowed';
      expect(() => replay(report)).toThrow('invalid-observation-archive');
    });
  it('rejects an unbounded or opaque failure message without leaking it in the verifier error', async () => {
    const report = mutable(await new DerivativesObservationClient({ fetch: mockRequest(() => new Response('', { status: 403 })), clock: () => now }).capture());
    (report.failures as Array<D0bCapture['failures'][number]>)[0].reason = 'private upstream information';
    expect(() => replay(report)).toThrow('invalid-observation-archive');
    try { replay(report); } catch (error) { expect(String(error)).not.toContain('private upstream'); }
  });
});

describe('D0b deadline exhaustion and suspended-process diagnostics', () => {
  it('uses the remaining 1ms global budget and archives a deadline failure with the accepted prefix', async () => {
    vi.useFakeTimers(); let calls = 0; let signal: AbortSignal | undefined;
    const clock = () => { calls++; return calls <= 3 ? now : calls === 4 ? now + 124999 : now + 125000; };
    const fetch = mockRequest((_route, index, init) => index === 1 ? (signal = init?.signal as AbortSignal, new Promise<Response>(() => {})) : undefined);
    const capture = new DerivativesObservationClient({ fetch, clock }).capture();
    await vi.advanceTimersByTimeAsync(0); expect(fetch).toHaveBeenCalledTimes(2); expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1); const report = await capture;
    expect(report).toMatchObject({ status: 'incomplete', requestCount: 2, endedAt: now + 125000 });
    expect(report.observations).toHaveLength(1); expect(report.failures[0].reason).toBe('public-capture-deadline');
    expect(signal?.aborted).toBe(true); expect(fetch).toHaveBeenCalledTimes(2); expect(replay(report)).toEqual(report);
  });
  it('preserves the first HTTP403 failure when a suspended process resumes after the capture deadline', async () => {
    let time = now;
    const fetch = mockRequest((_route, index) => {
      if (index !== 1) return undefined;
      time = now + 130000;
      return new Response('upstream detail is excluded', { status: 403 });
    });
    const report = await new DerivativesObservationClient({ fetch, clock: () => time }).capture();
    expect(report).toMatchObject({ status: 'incomplete', requestCount: 2, endedAt: now + 130000 });
    expect(report.observations).toHaveLength(1); expect(report.failures[0].reason).toBe('public-access-denied');
    expect(fetch).toHaveBeenCalledTimes(2); expect(replay(report)).toEqual(report); expect(JSON.stringify(replay(report))).not.toContain('upstream detail');
  });
  it('preserves a per-request timeout and partial archive when the final clock reports a suspension overrun', async () => {
    vi.useFakeTimers(); let time = now;
    const fetch = mockRequest((_route, index) => {
      if (index !== 1) return undefined;
      time = now + 130000;
      return new Promise<Response>(() => {});
    });
    const capture = new DerivativesObservationClient({ fetch, clock: () => time }).capture();
    await vi.advanceTimersByTimeAsync(5000); const report = await capture;
    expect(report).toMatchObject({ status: 'incomplete', requestCount: 2, endedAt: now + 130000 });
    expect(report.observations).toHaveLength(1); expect(report.failures[0].reason).toBe('public-timeout');
    expect(fetch).toHaveBeenCalledTimes(2); expect(replay(report)).toEqual(report);
  });
});
