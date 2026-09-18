import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { BinanceReadOnly } from '../src/exchange/binance-readonly.js';

const key = 'test-only-key';
const secret = 'test-only-secret';
const permissions = { enableReading: true, enableWithdrawals: false, enableInternalTransfer: false,
  enableMargin: false, enableFutures: false, permitsUniversalTransfer: false,
  enableVanillaOptions: false, enableSpotAndMarginTrading: false };
const trade = { symbol: 'BTCUSDT', id: 40, orderId: 20, price: '100.123456789012345678',
  qty: '0.00000001', quoteQty: '0.000001', commission: '0.000000001', commissionAsset: 'BTC',
  time: 1700000000000, isBuyer: true, isMaker: false };
const account = { accountType: 'SPOT', balances: [{ asset: 'BTC', free: '0.000000000000000001', locked: '0' }] };
const config = { enabled: true, apiKey: key, apiSecret: secret, symbols: ['BTC/USDT'] };
function setup(payload: unknown = account, permissionPayload: unknown = permissions) {
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const path = new URL(String(input)).pathname;
    return Response.json(path === '/api/v3/time' ? { serverTime: Date.now() } :
      path === '/sapi/v1/account/apiRestrictions' ? permissionPayload : payload);
  });
  return { connector: new BinanceReadOnly(config, fetcher), fetcher };
}

describe('Binance read-only connector', () => {
  it('uses only fixed-host GET requests, validates key permissions and signs exact query bytes', async () => {
    const { connector, fetcher } = setup({ ...account, ignoredPrivateField: secret });
    expect(await connector.getAccount()).toEqual(account);
    expect(connector.status().verifiedAt).not.toBeNull();
    expect(JSON.stringify(connector)).not.toContain(secret);
    for (const [input, options] of fetcher.mock.calls) {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://api.binance.com');
      expect(options?.method).toBe('GET');
      expect(options?.redirect).toBe('error');
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      if (url.pathname === '/api/v3/time') {
        expect(options?.headers).toEqual({});
      } else {
        const signature = url.searchParams.get('signature');
        url.searchParams.delete('signature');
        expect(signature).toBe(createHmac('sha256', secret).update(url.searchParams.toString()).digest('hex'));
        expect(options?.headers).toEqual({ 'X-MBX-APIKEY': key });
      }
    }
  });
  it('preserves decimal precision and exposes a forward history cursor', async () => {
    const { connector, fetcher } = setup([trade]);
    const page = await connector.getTrades('BTC/USDT', 1, '40');
    expect(page.trades[0].price).toBe(trade.price);
    expect(page.nextFromId).toBe('41');
    const url = new URL(String(fetcher.mock.calls[2][0]));
    expect(url.searchParams.get('symbol')).toBe('BTCUSDT');
    expect(url.searchParams.get('fromId')).toBe('40');
    expect(url.searchParams.get('limit')).toBe('1');
  });
  it('does not fabricate data when the account has no orders', async () => {
    const { connector } = setup([]);
    expect(await connector.getOpenOrders('BTC/USDT')).toEqual([]);
  });
  it.each(['enableWithdrawals', 'enableInternalTransfer', 'enableMargin', 'enableFutures',
    'permitsUniversalTransfer', 'enableVanillaOptions', 'enableSpotAndMarginTrading',
    'enableFixApiTrade', 'enablePortfolioMarginTrading'])('rejects keys with %s', async (flag) => {
    const { connector, fetcher } = setup(account, { ...permissions, [flag]: true });
    await expect(connector.getAccount()).rejects.toMatchObject({ code: 'unsafe-permissions' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(connector.status().verifiedAt).toBeNull();
  });
  it('rechecks permissions on every operation', async () => {
    const payload = { ...permissions };
    const { connector } = setup(account, payload);
    await connector.getAccount();
    payload.enableWithdrawals = true;
    await expect(connector.getAccount()).rejects.toMatchObject({ code: 'unsafe-permissions' });
    expect(connector.status().verifiedAt).toBeNull();
  });
  it('rejects incomplete permission responses', async () => {
    const { connector } = setup(account, { enableReading: true });
    await expect(connector.getAccount()).rejects.toMatchObject({ code: 'unsafe-permissions' });
  });
  it('does not contact Binance while disabled or missing keys', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const override of [{ enabled: false }, { apiKey: '' }, { apiSecret: '' }]) {
      await expect(new BinanceReadOnly({ ...config, ...override }, fetcher).getAccount()).rejects.toMatchObject({ code: 'not-configured' });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('validates the universe and pagination before any request', async () => {
    const { connector, fetcher } = setup();
    await expect(connector.getTrades('DOGE/USDT')).rejects.toMatchObject({ code: 'invalid-symbol' });
    await expect(connector.getTrades('BTC/USDT', 1001)).rejects.toMatchObject({ code: 'invalid-query' });
    await expect(connector.getTrades('BTC/USDT', 1, '9999999999999999999')).rejects.toMatchObject({ code: 'invalid-query' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([429, 418])('respects Retry-After on HTTP %s without automatic retries', async (status) => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(secret, { status, headers: { 'retry-after': '120' } }));
    const connector = new BinanceReadOnly(config, fetcher);
    await expect(connector.getAccount()).rejects.toMatchObject({ code: 'rate-limited' });
    await expect(connector.getAccount()).rejects.toMatchObject({ code: 'rate-limited' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(connector.status().cooldownUntil).not.toBeNull();
  });
  it('redacts transport errors and upstream response bodies', async () => {
    for (const fetcher of [vi.fn<typeof fetch>().mockRejectedValue(new Error(secret)),
      vi.fn<typeof fetch>().mockResolvedValue(new Response(secret, { status: 403 }))]) {
      try { await new BinanceReadOnly(config, fetcher).getAccount(); throw new Error('Expected rejection'); }
      catch (error) { expect(String(error)).not.toContain(secret); expect(String(error)).not.toContain(key); }
    }
  });
  it('rejects unsafe numeric identifiers and malformed balances', async () => {
    await expect(setup([{ ...trade, id: Number.MAX_SAFE_INTEGER + 1 }]).connector.getTrades('BTC/USDT')).rejects.toMatchObject({ code: 'invalid-response' });
    await expect(setup({ ...account, balances: [{ asset: 'BTC', free: '-1', locked: '0' }] }).connector.getAccount()).rejects.toMatchObject({ code: 'invalid-response' });
  });
});
