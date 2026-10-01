import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { OrderRecoveryReader, projectRecoveryFills, projectRecoveryOrder, type RecoveryVenue } from '../src/accounts/order-recovery-reader.js';
import { AccountTransport } from '../src/accounts/transport.js';

const credentials = { apiKey: 'PRIVATE_TEST_KEY', apiSecret: 'PRIVATE_TEST_SECRET', passphrase: 'PRIVATE_TEST_PASSPHRASE' };
const now = 1_800_000_000_000, clientOrderId = 'a'.repeat(32), exchangeOrderId = '123';
const range = { from: now - 3600_000, to: now };
const mexcOrder = { symbol: 'BTCUSDT', orderId: exchangeOrderId, clientOrderId, price: '84000', Qty: '0.0001',
  executedQty: '0.0001', cumulativeQuoteQty: '8.4', status: 'FILLED', type: 'LIMIT', side: 'BUY', time: now - 1000, updateTime: now - 100 };
const mexcFill = { symbol: 'BTCUSDT', id: '456', orderId: exchangeOrderId, price: '84000', qty: '0.0001', quoteQty: '8.4',
  commission: '0.0042', commissionAsset: 'USDT', time: now - 100, isBuyer: true };
const okxOrder = { instType: 'SPOT', instId: 'BTC-USDT', ordId: exchangeOrderId, clOrdId: clientOrderId, tdMode: 'cash', category: 'normal',
  side: 'buy', ordType: 'limit', state: 'filled', sz: '0.0001', px: '84000', accFillSz: '0.0001', avgPx: '84000',
  fee: '-0.0042', feeCcy: 'USDT', cTime: String(now - 1000), uTime: String(now - 100) };
const okxFill = { instType: 'SPOT', instId: 'BTC-USDT', ordId: exchangeOrderId, tradeId: '456', billId: '789', clOrdId: clientOrderId,
  side: 'buy', fillSz: '0.0001', fillPx: '84000', fee: '-0.0042', feeCcy: 'USDT', fillTime: String(now - 100), ts: String(now - 90) };
function setup(venue: RecoveryVenue, payload: unknown, clock = () => now) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(venue === 'okx' ? { code: '0', data: payload } : payload));
  return { reader: new OrderRecoveryReader(venue, { credentials, fetch, clock }), fetch };
}
function signedMexc(path: string, query: string) {
  return `https://api.mexc.com${path}?${query}&recvWindow=5000&timestamp=${now}&signature=${'a'.repeat(64)}`;
}
const mexcById = signedMexc('/api/v3/order', `symbol=BTCUSDT&orderId=${exchangeOrderId}`);
const mexcByClient = signedMexc('/api/v3/order', `symbol=BTCUSDT&origClientOrderId=${clientOrderId}`);
const mexcFills = signedMexc('/api/v3/myTrades', `symbol=BTCUSDT&orderId=${exchangeOrderId}&limit=1000`);
const okxById = `https://www.okx.com/api/v5/trade/order?instId=BTC-USDT&ordId=${exchangeOrderId}`;
const okxByClient = `https://www.okx.com/api/v5/trade/order?instId=BTC-USDT&clOrdId=${clientOrderId}`;
const okxFills = `https://www.okx.com/api/v5/trade/fills-history?instType=SPOT&instId=BTC-USDT&ordId=${exchangeOrderId}&begin=${range.from}&end=${range.to}&limit=100`;

describe('dedicated order recovery reader', () => {
  it('signs MEXC client-order lookup without inventing an exchange ID', async () => {
    const { reader, fetch } = setup('mexc', { ...mexcOrder, apiKey: 'PRIVATE_EXTRA', extra: { cookie: 'PRIVATE_COOKIE' } });
    const read = await reader.getOrder({ clientOrderId });
    const unsigned = `symbol=BTCUSDT&origClientOrderId=${clientOrderId}&recvWindow=5000&timestamp=${now}`;
    const signature = createHmac('sha256', credentials.apiSecret).update(unsigned).digest('hex');
    expect(fetch).toHaveBeenCalledExactlyOnceWith(`https://api.mexc.com/api/v3/order?${unsigned}&signature=${signature}`, expect.objectContaining({
      method: 'GET', headers: { 'X-MEXC-APIKEY': credentials.apiKey }, redirect: 'error', credentials: 'omit', cache: 'no-store' }));
    expect(read).toEqual({ kind: 'order', venue: 'mexc', requestedAt: now, receivedAt: now,
      query: { symbol: 'BTCUSDT', origClientOrderId: clientOrderId }, data: mexcOrder });
    expect(Object.isFrozen(read)).toBe(true); expect(Object.isFrozen(read.data)).toBe(true); expect(Object.isFrozen(read.query)).toBe(true);
    expect(JSON.stringify({ read, reader })).not.toMatch(/PRIVATE|signature|recvWindow|apiKey/);
  });
  it('signs OKX exact client selector and retains client ID while stripping other account metadata', async () => {
    const { reader, fetch } = setup('okx', [{ ...okxOrder, uid: 'PRIVATE_UID', tag: 'PRIVATE_TAG' }]);
    const read = await reader.getOrderByClient(clientOrderId);
    const target = `/api/v5/trade/order?instId=BTC-USDT&clOrdId=${clientOrderId}`, stamp = new Date(now).toISOString();
    const signature = createHmac('sha256', credentials.apiSecret).update(`${stamp}GET${target}`).digest('base64');
    expect(fetch).toHaveBeenCalledExactlyOnceWith('https://www.okx.com' + target, expect.objectContaining({ method: 'GET', headers: {
      'OK-ACCESS-KEY': credentials.apiKey, 'OK-ACCESS-SIGN': signature, 'OK-ACCESS-TIMESTAMP': stamp,
      'OK-ACCESS-PASSPHRASE': credentials.passphrase, 'Content-Type': 'application/json' } }));
    expect(read.data).toEqual({ ...okxOrder, cTime: now - 1000, uTime: now - 100 });
    expect(JSON.stringify({ read, reader })).not.toMatch(/PRIVATE|signature|ACCESS/);
  });
  it.each(['mexc', 'okx'] as const)('switches to exactly one exchange ID selector on %s', async venue => {
    const { reader, fetch } = setup(venue, venue === 'mexc' ? mexcOrder : [okxOrder]);
    await reader.getOrderById(exchangeOrderId);
    const query = new URL(String(fetch.mock.calls[0][0])).searchParams;
    expect(query.get(venue === 'mexc' ? 'orderId' : 'ordId')).toBe(exchangeOrderId);
    expect(query.has('origClientOrderId')).toBe(false); expect(query.has('clOrdId')).toBe(false);
  });
  it.each(['mexc', 'okx'] as const)('reads one bounded %s fill page with no discovery or pagination', async venue => {
    const { reader, fetch } = setup(venue, [venue === 'mexc' ? mexcFill : okxFill]);
    const read = await reader.getFillsByOrder(exchangeOrderId, range);
    const query = new URL(String(fetch.mock.calls[0][0])).searchParams;
    expect(read.data).toHaveLength(1); expect(query.get('limit')).toBe(venue === 'mexc' ? '1000' : '100');
    expect(query.get(venue === 'mexc' ? 'orderId' : 'ordId')).toBe(exchangeOrderId);
    expect(query.has('after')).toBe(false); expect(query.has('before')).toBe(false);
    expect(query.has('startTime')).toBe(false); expect(query.has('endTime')).toBe(false);
    if (venue === 'okx') { expect(query.get('begin')).toBe(String(range.from)); expect(query.get('end')).toBe(String(range.to)); }
    expect(Object.isFrozen(read.data)).toBe(true); expect(Object.isFrozen(read.data[0])).toBe(true);
  });
  it('copies the credential bundle on construction', async () => {
    const mutable = { ...credentials }, fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(mexcOrder));
    const reader = new OrderRecoveryReader('mexc', { credentials: mutable, fetch, clock: () => now });
    mutable.apiKey = 'OTHER'; mutable.apiSecret = 'OTHER';
    await reader.getOrderById(exchangeOrderId);
    expect(fetch.mock.calls[0][1]!.headers).toEqual({ 'X-MEXC-APIKEY': credentials.apiKey });
    const url = new URL(String(fetch.mock.calls[0][0])), signature = url.searchParams.get('signature');
    url.searchParams.delete('signature');
    expect(signature).toBe(createHmac('sha256', credentials.apiSecret).update(url.searchParams.toString()).digest('hex'));
  });
  it.each(['mexc', 'okx'] as const)('rejects mismatched %s client/exchange identities rather than returning them', async venue => {
    const { reader } = setup(venue, venue === 'mexc' ? mexcOrder : [okxOrder]);
    await expect(reader.getOrderByClient('b'.repeat(32))).rejects.toThrow(/^account-invalid-response$/);
    await expect(reader.getOrderById('OTHER')).rejects.toThrow(/^account-invalid-response$/);
    const fills = setup(venue, [venue === 'mexc' ? mexcFill : okxFill]);
    await expect(fills.reader.getFills('OTHER', range)).rejects.toThrow(/^account-invalid-response$/);
  });
  it.each([{}, { clientOrderId, exchangeOrderId }, { clientOrderId, side: 'BUY' }, { clientOrderId: 'short' },
    { clientOrderId: 'a'.repeat(31) + '_' }, { exchangeOrderId: 'a'.repeat(65) }, { exchangeOrderId: '' },
    { exchangeOrderId: '123&side=BUY' }, { clientOrderId, exchangeOrderId: undefined }])('rejects invalid selector before HTTP: %j', selected => {
    const { reader, fetch } = setup('mexc', mexcOrder);
    expect(() => reader.getOrder(selected as never)).toThrow(/^account-invalid-order-selector$/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([{ from: 0, to: now }, { from: now, to: now - 1 }, { from: now, to: now + 7 * 86400_000 + 1 },
    { from: now, to: now + 0.5 }, { from: now - 1, to: now, extra: true }])('rejects invalid fill window before HTTP', window => {
    for (const venue of ['mexc', 'okx'] as const) {
      const { reader, fetch } = setup(venue, []);
      expect(() => reader.getFills(exchangeOrderId, window)).toThrow(/^account-invalid-history-window$/);
      expect(fetch).not.toHaveBeenCalled();
    }
  });
});

describe('recovery projections retain exact identity and cash fields', () => {
  it('supports both documented MEXC quantity/quote aliases and rejects conflicting values', () => {
    const { Qty: _, cumulativeQuoteQty: __, ...older } = mexcOrder;
    const projected = projectRecoveryOrder('mexc', { ...older, origQty: '0.00010000', cummulativeQuoteQty: '8.40000' });
    expect(projected).toMatchObject({ origQty: '0.00010000', cummulativeQuoteQty: '8.40000' });
    expect(() => projectRecoveryOrder('mexc', { ...mexcOrder, origQty: '0.00010000', cummulativeQuoteQty: '8.4000' })).not.toThrow();
    expect(() => projectRecoveryOrder('mexc', { ...mexcOrder, origQty: '0.1' })).toThrow(/^account-invalid-response$/);
    expect(() => projectRecoveryOrder('mexc', { ...mexcOrder, cummulativeQuoteQty: '8.5' })).toThrow(/^account-invalid-response$/);
    expect(() => projectRecoveryOrder('mexc', older)).toThrow(/^account-invalid-response$/);
    expect(() => projectRecoveryOrder('mexc', { ...mexcOrder, origClientOrderId: 'b'.repeat(32) })).toThrow(/^account-invalid-response$/);
  });
  it('retains up to30fractional digits without rounding or silently accepting JSON monetary numbers', () => {
    const amount = '0.123456789012345678901234567890';
    expect(projectRecoveryFills('mexc', [{ ...mexcFill, quoteQty: amount }])[0]).toMatchObject({ quoteQty: amount });
    for (const value of [8.4, '1e-4', '-1', 'NaN', '1.' + '1'.repeat(31)]) {
      expect(() => projectRecoveryFills('mexc', [{ ...mexcFill, quoteQty: value }])).toThrow(/^account-invalid-response$/);
    }
  });
  it.each(['clientOrderId', 'price', 'executedQty', 'time', 'updateTime', 'side', 'type', 'status'])('rejects missing MEXC binding field %s', key => {
    const copy = { ...mexcOrder } as Record<string, unknown>; delete copy[key];
    expect(() => projectRecoveryOrder('mexc', copy)).toThrow(/^account-invalid-response$/);
  });
  it.each(['clOrdId', 'tdMode', 'sz', 'px', 'accFillSz', 'cTime', 'uTime', 'avgPx'])('rejects missing OKX binding field %s', key => {
    const copy = { ...okxOrder } as Record<string, unknown>; delete copy[key];
    expect(() => projectRecoveryOrder('okx', [copy])).toThrow(/^account-invalid-response$/);
  });
  it('preserves absent nullable MEXC fill client identity without pretending it was reported', () => {
    const absent = projectRecoveryFills('mexc', [mexcFill])[0];
    expect(absent).not.toHaveProperty('clientOrderId');
    expect(projectRecoveryFills('mexc', [{ ...mexcFill, clientOrderId: null }])[0]).toHaveProperty('clientOrderId', null);
  });
  it('does not derive OKX quote cash from size and price', () => {
    const fill = projectRecoveryFills('okx', [{ ...okxFill, quoteQty: '8.4', cumulativeQuoteQty: '8.4' }])[0];
    expect(fill).not.toHaveProperty('quoteQty'); expect(fill).not.toHaveProperty('cumulativeQuoteQty');
    expect(fill).toMatchObject({ fillTime: now - 100, ts: now - 90 });
  });
  it.each(['mexc', 'okx'] as const)('accepts a full %s page without claiming completeness and rejects overflow', venue => {
    const limit = venue === 'mexc' ? 1000 : 100, fill = venue === 'mexc' ? mexcFill : okxFill;
    const accepted = projectRecoveryFills(venue, Array.from({ length: limit }, () => fill));
    expect(accepted).toHaveLength(limit); expect(accepted).not.toHaveProperty('complete');
    expect(() => projectRecoveryFills(venue, Array.from({ length: limit + 1 }, () => fill))).toThrow(/^account-invalid-response$/);
  });
  it.each([[], [okxOrder, okxOrder], [{ ...okxOrder, instType: 'MARGIN' }], [{ ...okxOrder, instId: 'ETH-USDT' }]].map(payload => ({ payload })))('rejects empty/multiple/wrong-instrument OKX orders', ({ payload }) => {
    expect(() => projectRecoveryOrder('okx', payload)).toThrow(/^account-invalid-response$/);
  });
  it('rejects unsafe upstream numeric IDs and malformed times without returning upstream text', () => {
    expect(() => projectRecoveryOrder('mexc', { ...mexcOrder, orderId: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/^account-invalid-response$/);
    expect(() => projectRecoveryOrder('mexc', { ...mexcOrder, time: 'PRIVATE_TIME' })).toThrow(/^account-invalid-response$/);
  });
});

describe('recovery failures do not mean an order was absent', () => {
  it('requires an array in the authenticated OKX success envelope', async () => {
    const { reader } = setup('okx', okxOrder);
    await expect(reader.getOrderById(exchangeOrderId)).rejects.toThrow(/^account-invalid-response$/);
  });
  it.each([['mexc', { code: -2013, msg: 'PRIVATE_NOT_FOUND' }], ['okx', { code: '51603', msg: 'PRIVATE_NOT_FOUND', data: [] }]] as const)
    ('does not convert %s success-envelope errors into safe resend', async (venue, payload) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(payload));
      const reader = new OrderRecoveryReader(venue, { credentials, fetch, clock: () => now });
      await expect(reader.getOrderByClient(clientOrderId)).rejects.toThrow(/^account-api-rejected$/);
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  it.each([400, 401, 404, 500])('does not inspect an HTTP%s error body or leak its content', async status => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('PRIVATE_URL_COOKIE_TOKEN', { status }));
    const reader = new OrderRecoveryReader('mexc', { credentials, fetch, clock: () => now });
    await expect(reader.getOrderById(exchangeOrderId)).rejects.toThrow(status === 401 ? /^account-auth-failed$/ : /^account-api-rejected$/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([['mexc', 429], ['mexc', 418], ['okx', '50011'], ['okx', '50013'], ['okx', '50040']] as const)
    ('persists %s application rate-limit cooldown code%s with no retries', async (venue, code) => {
      let clock = now;
      const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ code, data: [], msg: 'PRIVATE' }));
      const reader = new OrderRecoveryReader(venue, { credentials, fetch, clock: () => clock });
      await expect(reader.getOrderById(exchangeOrderId)).rejects.toThrow(/^account-rate-limited$/);
      clock += 59_999;
      await expect(reader.getOrderById(exchangeOrderId)).rejects.toThrow(/^account-rate-limited$/);
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  it('preserves request/body deadlines and disallows overlapping reads', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => {}));
      const reader = new OrderRecoveryReader('mexc', { credentials, fetch, clock: () => now });
      const read = reader.getOrderById(exchangeOrderId), rejected = expect(read).rejects.toThrow(/^account-timeout$/);
      await expect(reader.getOrderById(exchangeOrderId)).rejects.toThrow(/^account-busy$/);
      await vi.advanceTimersByTimeAsync(5001); await rejected;
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it('rejects backward clocks instead of accepting future/stale receipt intervals', async () => {
    let time = now;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => { time--; return Response.json(mexcOrder); });
    const reader = new OrderRecoveryReader('mexc', { credentials, fetch, clock: () => time });
    await expect(reader.getOrderById(exchangeOrderId)).rejects.toThrow(/^account-invalid-clock$/);
  });
});

describe('recovery-only transport scope', () => {
  it.each([mexcById, mexcByClient, mexcFills, okxById, okxByClient, okxFills])('allows exactly one fixed BTC read: %s', async target => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json([]));
    await new AccountTransport({ credentials, fetch, clock: () => now }, 'order-recovery').request(target, {});
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store' });
    expect(fetch.mock.calls[0][1]).not.toHaveProperty('body');
  });
  it.each([mexcByClient, okxByClient])('does not add client-selector routes to pre-existing scopes', async target => {
    for (const scope of ['accounts', 'execution-history'] as const) {
      const fetch = vi.fn();
      await expect(new AccountTransport({ credentials, fetch, clock: () => now }, scope).request(target, {})).rejects.toThrow(/^account-unsupported-endpoint$/);
      expect(fetch).not.toHaveBeenCalled();
    }
  });
  it.each([
    mexcById + `&origClientOrderId=${clientOrderId}`, mexcByClient + '&orderId=123', mexcById + '&side=BUY',
    mexcByClient.replace('origClientOrderId=', 'clientOrderId='), mexcByClient.replace(clientOrderId, 'a'.repeat(33)),
    mexcById + '&orderId=123', mexcByClient.replace('BTCUSDT', 'ETHUSDT'),
    mexcById.replace('/order?', '/order/test?'), mexcFills.replace('orderId=123&', ''),
    mexcFills.replace('limit=1000', 'limit=1001'), mexcFills + '&fromId=1', mexcFills + '&startTime=' + range.from,
    okxById + '&clOrdId=' + clientOrderId, okxByClient + '&ordId=123', okxByClient + '&clOrdId=' + clientOrderId,
    okxById.replace('BTC-USDT', 'ETH-USDT'), okxByClient.replace(clientOrderId, 'short'),
    okxByClient.replace(clientOrderId, '%61' + clientOrderId.slice(1)),
    okxById.replace('/order?', '/cancel-order?'), okxFills + '&after=123', okxFills + '&before=123',
    okxFills.replace('ordId=123&', ''), okxFills.replace('limit=100', 'limit=101'),
    okxFills.replace('instType=SPOT', 'instType=MARGIN'), okxFills.replace('/trade/fills-history?', '/account/bills?'),
    okxById.replace('https:', 'http:'), okxById.replace('www.okx.com', 'attacker.invalid'),
    okxById.replace('www.okx.com', 'user:secret@www.okx.com'), okxById + '#PRIVATE',
    'https://www.okx.com/api/v5/account/balance', 'https://www.okx.com/api/v5/asset/withdrawal',
    'https://api.bybit.com/v5/user/query-api', signedMexc('/api/v3/account', ''),
    signedMexc('/api/v3/mxDeduct/enable', ''), signedMexc('/api/v3/capital/withdraw/apply', 'coin=USDT'),
  ])('rejects expanded or ambiguous route before HTTP: %s', async target => {
    const fetch = vi.fn();
    await expect(new AccountTransport({ credentials, fetch, clock: () => now }, 'order-recovery').request(target, {})).rejects.toThrow(/^account-unsupported-endpoint$/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
