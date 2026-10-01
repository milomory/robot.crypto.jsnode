import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ExecutionHistoryReader, type HistoryVenue } from '../src/accounts/execution-reader.js';
import { AccountTransport } from '../src/accounts/transport.js';

const credentials = { apiKey: 'TEST_PRIVATE_API_KEY', apiSecret: 'TEST_PRIVATE_SECRET', passphrase: 'TEST_PRIVATE_PASSPHRASE' };
const now = 1_800_000_000_000;
const range = { from: now - 3600_000, to: now };
const mexcOrder = { symbol: 'BTCUSDT', orderId: '123', side: 'BUY', type: 'MARKET', status: 'FILLED', executedQty: '0.0001', cumulativeQuoteQty: '8.4' };
const mexcFill = { symbol: 'BTCUSDT', id: '456', orderId: '123', qty: '0.0001', quoteQty: '8.4', commission: '0.0042', commissionAsset: 'USDT' };
const okxOrder = { instType: 'SPOT', instId: 'BTC-USDT', ordId: '123', side: 'buy', state: 'filled', accFillSz: '0.0001', fee: '-0.0000001', feeCcy: 'BTC' };
const okxFill = { instType: 'SPOT', instId: 'BTC-USDT', ordId: '123', tradeId: '456', billId: '789', fillSz: '0.0001', fillPx: '84000', fee: '-0.0000001', feeCcy: 'BTC' };
const okxBill = { instType: 'SPOT', instId: 'BTC-USDT', ordId: '123', tradeId: '456', billId: '789', ccy: 'USDT', balChg: '-8.4', fee: '0' };

function setup(venue: HistoryVenue, payload: unknown, clock = () => now) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(venue === 'okx' ? { code: '0', data: payload } : payload));
  return { reader: new ExecutionHistoryReader(venue, { credentials, fetch, clock }), fetch };
}
const mexcSigned = (path: string, query: string) => `https://api.mexc.com${path}?${query}&recvWindow=5000&timestamp=${now}&signature=${'a'.repeat(64)}`;
const mexcOrderUrl = mexcSigned('/api/v3/order', 'symbol=BTCUSDT&orderId=123');
const mexcWindowUrl = mexcSigned('/api/v3/myTrades', `symbol=BTCUSDT&startTime=${range.from}&endTime=${range.to}&limit=1000`);
const mexcFillsUrl = mexcSigned('/api/v3/myTrades', 'symbol=BTCUSDT&orderId=123&limit=1000');
const okxOrderUrl = 'https://www.okx.com/api/v5/trade/order?instId=BTC-USDT&ordId=123';
const okxWindowUrl = `https://www.okx.com/api/v5/trade/fills-history?instType=SPOT&instId=BTC-USDT&begin=${range.from}&end=${range.to}&limit=100`;
const okxBillsUrl = okxWindowUrl.replace('/trade/fills-history?', '/account/bills?');

describe('execution reader request signatures and private projections', () => {
  it('signs the exact MEXC query, strips private metadata and returns no signed request values', async () => {
    const { reader, fetch } = setup('mexc', { ...mexcOrder, clientOrderId: 'PRIVATE_CLIENT', apiKey: 'PRIVATE_KEY', arbitrary: { secret: 'PRIVATE' } });
    const result = await reader.getOrder('123');
    const query = `symbol=BTCUSDT&orderId=123&recvWindow=5000&timestamp=${now}`;
    const signature = createHmac('sha256', credentials.apiSecret).update(query).digest('hex');
    expect(fetch).toHaveBeenCalledExactlyOnceWith(`https://api.mexc.com/api/v3/order?${query}&signature=${signature}`, expect.objectContaining({
      method: 'GET', headers: { 'X-MEXC-APIKEY': credentials.apiKey }, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: expect.any(AbortSignal),
    }));
    expect(fetch.mock.calls[0][1]).not.toHaveProperty('body');
    expect(result).toEqual({ kind: 'order', requestedAt: now, receivedAt: now, query: { symbol: 'BTCUSDT', orderId: '123' }, data: mexcOrder });
    expect(JSON.stringify({ result, reader })).not.toMatch(/PRIVATE|signature|recvWindow|timestamp/);
  });

  it('signs the exact OKX target including cursor and order filter, and strips identity metadata', async () => {
    const { reader, fetch } = setup('okx', [{ ...okxFill, clOrdId: 'PRIVATE_CLIENT', tag: 'PRIVATE_TAG', uid: 'PRIVATE_ACCOUNT' }]);
    const result = await reader.getFills(range, '123', '789');
    const target = `/api/v5/trade/fills-history?instType=SPOT&instId=BTC-USDT&begin=${range.from}&end=${range.to}&limit=100&ordId=123&after=789`;
    const timestamp = new Date(now).toISOString();
    const signature = createHmac('sha256', credentials.apiSecret).update(`${timestamp}GET${target}`).digest('base64');
    expect(fetch).toHaveBeenCalledExactlyOnceWith('https://www.okx.com' + target, expect.objectContaining({ method: 'GET',
      headers: { 'OK-ACCESS-KEY': credentials.apiKey, 'OK-ACCESS-SIGN': signature, 'OK-ACCESS-TIMESTAMP': timestamp,
        'OK-ACCESS-PASSPHRASE': credentials.passphrase, 'Content-Type': 'application/json' }, credentials: 'omit', redirect: 'error', cache: 'no-store',
    }));
    expect(result.data).toEqual([okxFill]);
    expect(JSON.stringify({ result, reader })).not.toMatch(/PRIVATE|ACCESS|signature/);
  });

  it.each(['mexc', 'okx'] as const)('generates a fresh %s signature for every explicitly requested read', async venue => {
    let time = now;
    const { reader, fetch } = setup(venue, venue === 'mexc' ? mexcOrder : [okxOrder], () => time);
    const first = await reader.getOrder('123');
    time += 4321;
    const second = await reader.getOrder('123');
    expect(first.requestedAt).toBe(now);
    expect(second.requestedAt).toBe(time);
    const calls = fetch.mock.calls;
    if (venue === 'mexc') {
      expect(new URL(String(calls[0][0])).searchParams.get('timestamp')).toBe(String(now));
      expect(new URL(String(calls[1][0])).searchParams.get('timestamp')).toBe(String(time));
      expect(new URL(String(calls[0][0])).searchParams.get('signature')).not.toBe(new URL(String(calls[1][0])).searchParams.get('signature'));
    } else {
      const firstHeaders = calls[0][1]!.headers as Record<string, string>, secondHeaders = calls[1][1]!.headers as Record<string, string>;
      expect(secondHeaders['OK-ACCESS-TIMESTAMP']).toBe(new Date(time).toISOString());
      expect(firstHeaders['OK-ACCESS-SIGN']).not.toBe(secondHeaders['OK-ACCESS-SIGN']);
    }
  });

  it('uses the MEXC order-scoped fill route without silently adding a time range', async () => {
    const { reader, fetch } = setup('mexc', [{ ...mexcFill, clientOrderId: 'PRIVATE_CLIENT' }]);
    expect((await reader.getFills(range, '123')).data).toEqual([mexcFill]);
    const target = new URL(String(fetch.mock.calls[0][0]));
    expect(target.searchParams.get('orderId')).toBe('123');
    expect(target.searchParams.get('limit')).toBe('1000');
    expect(target.searchParams.has('startTime')).toBe(false);
    expect(target.searchParams.has('endTime')).toBe(false);
  });

  it('projects OKX monetary movements without account metadata or invented values', async () => {
    const { reader } = setup('okx', [{ ...okxBill, uid: 'PRIVATE_UID', notes: 'PRIVATE_NOTE' }]);
    expect((await reader.getBills(range, '789')).data).toEqual([okxBill]);
  });

  it.each(['mexc', 'okx'] as const)('rejects a %s order response for a different requested order', async venue => {
    const { reader } = setup(venue, venue === 'mexc' ? { ...mexcOrder, orderId: 'OTHER' } : [{ ...okxOrder, ordId: 'OTHER' }]);
    await expect(reader.getOrder('123')).rejects.toThrow(/^account-invalid-response$/);
  });

  it.each(['mexc', 'okx'] as const)('rejects %s fills belonging to another order when a filter was requested', async venue => {
    const { reader } = setup(venue, venue === 'mexc' ? [{ ...mexcFill, orderId: 'OTHER' }] : [{ ...okxFill, ordId: 'OTHER' }]);
    await expect(reader.getFills(range, '123')).rejects.toThrow(/^account-invalid-response$/);
  });

  it('copies credentials on construction so later caller mutation cannot change the signing identity', async () => {
    const mutable = { ...credentials }, fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(mexcOrder));
    const reader = new ExecutionHistoryReader('mexc', { credentials: mutable, fetch, clock: () => now });
    mutable.apiKey = 'OTHER_KEY'; mutable.apiSecret = 'OTHER_SECRET';
    await reader.getOrder('123');
    expect(fetch.mock.calls[0][1]!.headers).toEqual({ 'X-MEXC-APIKEY': credentials.apiKey });
    const target = new URL(String(fetch.mock.calls[0][0])), signature = target.searchParams.get('signature');
    target.searchParams.delete('signature');
    expect(signature).toBe(createHmac('sha256', credentials.apiSecret).update(target.searchParams.toString()).digest('hex'));
  });
});

describe('execution-only route boundary', () => {
  it.each([mexcOrderUrl, mexcWindowUrl, mexcFillsUrl, okxOrderUrl, okxWindowUrl, okxWindowUrl + '&ordId=123&after=789', okxBillsUrl, okxBillsUrl + '&after=789'])
    ('permits bounded canonical GET target: %s', async target => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json([]));
      const transport = new AccountTransport({ credentials, fetch, clock: () => now }, 'execution-history');
      await transport.request(target, {});
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store' });
      expect(fetch.mock.calls[0][1]).not.toHaveProperty('body');
    });

  it.each([mexcOrderUrl, mexcWindowUrl, mexcFillsUrl, okxOrderUrl, okxWindowUrl, okxBillsUrl])
    ('does not widen the default account scope: %s', async target => {
      const fetch = vi.fn();
      const transport = new AccountTransport({ credentials, fetch, clock: () => now });
      await expect(transport.request(target, {})).rejects.toThrow(/^account-unsupported-endpoint$/);
      expect(fetch).not.toHaveBeenCalled();
    });

  it.each([
    'https://www.okx.com/api/v5/account/balance', 'https://www.okx.com/api/v5/asset/balances',
    'https://www.okx.com/api/v5/asset/withdrawal', 'https://www.okx.com/api/v5/asset/transfer',
    'https://www.okx.com/api/v5/trade/cancel-order?instId=BTC-USDT&ordId=123',
    'https://www.okx.com/api/v5/trade/order?instId=BTC-USDT&ordId=123&side=buy',
    'https://api.bybit.com/v5/account/wallet-balance?accountType=UNIFIED',
    mexcSigned('/api/v3/account', ''), mexcSigned('/api/v3/mxDeduct/enable', ''),
    mexcSigned('/api/v3/capital/withdraw/apply', 'coin=USDT'),
    mexcOrderUrl.replace('/order?', '/order/test?'), mexcOrderUrl + '&side=BUY',
    mexcOrderUrl + '&orderId=123', mexcOrderUrl.replace('BTCUSDT', 'ETHUSDT'),
    mexcWindowUrl + '&startTime=' + range.from, mexcWindowUrl + '&fromId=1',
    mexcWindowUrl.replace('limit=1000', 'limit=1001'), mexcWindowUrl.replace('limit=1000', 'limit=100'),
    mexcWindowUrl.replace(`endTime=${range.to}`, `endTime=${range.from - 1}`),
    mexcWindowUrl.replace(`endTime=${range.to}`, `endTime=${range.from + 7 * 86400_000 + 1}`),
    mexcWindowUrl.replace(`startTime=${range.from}`, 'startTime=0'),
    mexcFillsUrl + `&startTime=${range.from}&endTime=${range.to}`,
    okxWindowUrl + '&after=0', okxWindowUrl + '&after=01', okxWindowUrl + '&after=-1',
    okxWindowUrl + '&after=opaque', okxWindowUrl + '&after=' + '1'.repeat(41),
    okxWindowUrl + '&after=123&after=123', okxWindowUrl + '&before=123',
    okxWindowUrl + '&begin=' + range.from, okxWindowUrl + '&limit=100',
    okxWindowUrl.replace('limit=100', 'limit=101'), okxWindowUrl.replace('BTC-USDT', 'ETH-USDT'),
    okxWindowUrl.replace('instType=SPOT', 'instType=SWAP'), okxBillsUrl + '&ordId=123',
    okxOrderUrl.replace('https:', 'http:'), okxOrderUrl.replace('www.okx.com', 'attacker.invalid'),
    okxOrderUrl.replace('www.okx.com', 'user:secret@www.okx.com'), okxOrderUrl + '#PRIVATE',
    'https://www.okx.com/api/v5/account/reset',
  ])('rejects other products, mutation-shaped queries and ambiguous pagination: %s', async target => {
    const fetch = vi.fn();
    const transport = new AccountTransport({ credentials, fetch, clock: () => now }, 'execution-history');
    await expect(transport.request(target, {})).rejects.toThrow(/^account-unsupported-endpoint$/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([{ from: 0, to: now }, { from: now, to: now - 1 }, { from: now, to: now + 7 * 86400_000 + 1 },
    { from: now + 0.5, to: now + 1 }, { from: now, to: Number.POSITIVE_INFINITY }])('rejects invalid history windows before HTTP', async window => {
    for (const venue of ['mexc', 'okx'] as const) {
      const { reader, fetch } = setup(venue, []);
      await expect(Promise.resolve().then(() => reader.getFills(window))).rejects.toThrow(/^account-invalid-history-window$/);
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it('rejects MEXC cursors and bills before any network call', async () => {
    const { reader, fetch } = setup('mexc', []);
    expect(() => reader.getFills(range, undefined, '123')).toThrow(/^account-unsupported-cursor$/);
    expect(() => reader.getBills(range)).toThrow(/^account-unsupported-venue$/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('execution reader failures and bounded pages', () => {
  it.each([['mexc', 429], ['mexc', 418], ['okx', '50011'], ['okx', '50013'], ['okx', '50040']] as const)
    ('keeps API cooldown after %s code %s and never automatically retries', async (venue, code) => {
      let time = now;
      const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ code, data: [], msg: 'PRIVATE_SERVER_TEXT' }));
      const reader = new ExecutionHistoryReader(venue, { credentials, fetch, clock: () => time });
      await expect(reader.getFills(range)).rejects.toThrow(/^account-rate-limited$/);
      time += 59_999;
      await expect(reader.getFills(range)).rejects.toThrow(/^account-rate-limited$/);
      expect(fetch).toHaveBeenCalledTimes(1);
      time++;
      await expect(reader.getFills(range)).rejects.toThrow(/^account-rate-limited$/);
      expect(fetch).toHaveBeenCalledTimes(2);
    });

  it.each(['mexc', 'okx'] as const)('preserves HTTP Retry-After for %s without decoding or exposing its body', async venue => {
    let time = now;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('PRIVATE_BODY', { status: 429, headers: { 'Retry-After': '120' } }));
    const reader = new ExecutionHistoryReader(venue, { credentials, fetch, clock: () => time });
    await expect(reader.getFills(range)).rejects.toThrow(/^account-rate-limited$/);
    time += 119_999;
    await expect(reader.getFills(range)).rejects.toThrow(/^account-rate-limited$/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['mexc', 'okx'] as const)('redacts %s application errors and performs one request only', async venue => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ code: venue === 'mexc' ? -2015 : '50113', msg: 'PRIVATE_API_KEY / private internal URL', data: [] }));
    const reader = new ExecutionHistoryReader(venue, { credentials, fetch, clock: () => now });
    await expect(reader.getFills(range)).rejects.toThrow(/^account-api-rejected$/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([['mexc', 1000, mexcFill], ['okx', 100, okxFill]] as const)('accepts one bounded %s page including duplicates and never paginates implicitly', async (venue, limit, row) => {
    const { reader, fetch } = setup(venue, Array.from({ length: limit }, () => row));
    expect((await reader.getFills(range)).data).toHaveLength(limit);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([['mexc', 1001, mexcFill], ['okx', 101, okxFill]] as const)('rejects an oversized %s fill page without accepting partial data', async (venue, limit, row) => {
    const { reader, fetch } = setup(venue, Array.from({ length: limit }, () => row));
    await expect(reader.getFills(range)).rejects.toThrow(/^account-invalid-response$/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized OKX bill pages and malformed private response fields', async () => {
    const bills = setup('okx', Array.from({ length: 101 }, () => okxBill));
    await expect(bills.reader.getBills(range)).rejects.toThrow(/^account-invalid-response$/);
    const fills = setup('mexc', [{ ...mexcFill, qty: 'PRIVATE_BAD_VALUE' }]);
    await expect(fills.reader.getFills(range)).rejects.toThrow(/^account-invalid-response$/);
  });

  it.each([0, -1, 1.5, 8_640_000_000_000_001])('rejects invalid signing clock %s without HTTP', async clock => {
    const { reader, fetch } = setup('okx', [okxOrder], () => clock);
    await expect(reader.getOrder('123')).rejects.toThrow(/^account-invalid-clock$/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a backwards receipt clock rather than recording impossible evidence', async () => {
    let calls = 0;
    const { reader } = setup('mexc', mexcOrder, () => ++calls < 3 ? now : now - 1);
    await expect(reader.getOrder('123')).rejects.toThrow(/^account-invalid-clock$/);
  });
});
