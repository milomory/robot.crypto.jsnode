import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { MexcAccountReader } from '../src/accounts/mexc.js';
import type { AccountSymbol } from '../src/accounts/types.js';

const credentials = { apiKey: 'MEXC_TEST_KEY', apiSecret: 'MEXC_TEST_SECRET' };
const now = 1_800_000_000_000;
const account = {
  canTrade: true, canWithdraw: true, canDeposit: true, updateTime: null, accountType: 'SPOT',
  balances: [{ asset: 'USDT', free: '12345.678901234567890123456789', locked: '33', available: '1' }],
  permissions: ['SPOT'], makerCommission: null, takerCommission: null,
  unrelatedPrivateField: 'PRIVATE_ECHO'
};
function setup(payload: unknown = account) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(payload));
  return { client: new MexcAccountReader({ credentials, fetch, clock: () => now }), fetch };
}

describe('MEXC account reader', () => {
  it('uses the independently calculated HMAC vector and fixed GET policy', async () => {
    const { client, fetch } = setup();
    await client.getBalances();
    // Vector generated separately with Python hmac/hashlib and a fixture secret.
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      'https://api.mexc.com/api/v3/account?recvWindow=5000&timestamp=1800000000000&signature=c5796cf65be02cd87f8f3ae8ee243297267c1a891a09d5590148dbdca7d28daa',
      expect.objectContaining({ method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store',
        headers: { 'X-MEXC-APIKEY': credentials.apiKey } })
    );
    expect(String(fetch.mock.calls[0][0])).not.toMatch(/MEXC_TEST/);
    expect(inspect(client)).not.toMatch(/MEXC_TEST/);
    expect(JSON.stringify(client)).toBe('{}');
  });
  it('preserves balances exactly, including separate available, without inferring key rights', async () => {
    const { client } = setup();
    const result = await client.getBalances();
    expect(result).toEqual({ venue: 'mexc', account: 'spot', updatedAt: null,
      accountCapabilities: { canTrade: true, canWithdraw: true, canDeposit: true },
      balances: [{ currency: 'USDT', free: '12345.678901234567890123456789', locked: '33', available: '1' }] });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|permissions|makerCommission/);
    expect('getKeyPermissions' in client).toBe(false);
    expect('getFundingBalances' in client).toBe(false);
  });
  it('marks unavailable availability as null, accepts empty accounts and preserves update time', async () => {
    const first = setup({ ...account, balances: [{ asset: 'BTC', free: '1', locked: '0' }] });
    expect((await first.client.getBalances()).balances[0].available).toBeNull();
    const second = setup({ ...account, updateTime: now, balances: [] });
    expect(await second.client.getBalances()).toMatchObject({ updatedAt: now, balances: [] });
  });
  it('copies credentials so caller mutation cannot change the authenticated identity', async () => {
    const input = { ...credentials }, fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(account));
    const client = new MexcAccountReader({ credentials: input, fetch, clock: () => now });
    input.apiKey = 'OTHER'; input.apiSecret = 'OTHER';
    await client.getBalances();
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('X-MEXC-APIKEY')).toBe(credentials.apiKey);
    expect(String(fetch.mock.calls[0][0])).toContain('signature=c5796cf65be02cd87f8f3ae8ee243297267c1a891a09d5590148dbdca7d28daa');
  });
  it.each([
    { accountType: 'FUTURES' }, { canTrade: 'true' }, { updateTime: Number.MAX_SAFE_INTEGER + 1 },
    { balances: [{ asset: 'USDT', free: 1, locked: '0' }] },
    { balances: [{ asset: 'USDT', free: '-1', locked: '0' }] },
    { balances: [{ asset: 'USDT', free: '1e3', locked: '0' }] },
    { balances: [{ asset: 'USDT', free: '1', locked: '0', available: null }] },
    { balances: [account.balances[0], account.balances[0]] },
    { balances: Array.from({ length: 5001 }, () => ({ asset: 'USDT', free: '0', locked: '0' })) }
  ])('rejects malformed or ambiguous account data without echo', async delta => {
    const { client } = setup({ ...account, ...delta });
    await expect(client.getBalances()).rejects.toThrow(/^account-invalid-response$/);
  });
  it('signs exact fee parameters and accepts official numeric/exponent representation', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(
      '{"code":0,"data":{"makerCommission":0E-18,"takerCommission":0.000500000000000000,"rpiTakerCommission":null},"msg":"PRIVATE_ECHO"}'
    ));
    const client = new MexcAccountReader({ credentials, fetch, clock: () => now });
    expect(await client.getSpotFees('BTC/USDT')).toEqual({ venue: 'mexc', symbol: 'BTC/USDT', makerRate: '0', takerRate: '0.0005', rateUnit: 'fraction', ratePrecision: 'json-number' });
    expect(String(fetch.mock.calls[0][0])).toBe('https://api.mexc.com/api/v3/tradeFee?symbol=BTCUSDT&recvWindow=5000&timestamp=1800000000000&signature=070301c6905c036acdaf7ba8454a7a48dd81c6b4991647188b5d81417c173501');
  });
  it.each([true, false])('reads MX deduction as a strict boolean (%s) with the signed GET guard', async enabled => {
    const { client, fetch } = setup({ code: 0, data: { mxDeductEnable: enabled, privateExtra: 'PRIVATE_ECHO' },
      msg: 'PRIVATE_ECHO', timestamp: now });
    expect(await client.getMxDeductStatus()).toEqual({ enabled });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      'https://api.mexc.com/api/v3/mxDeduct/enable?recvWindow=5000&timestamp=1800000000000&signature=c5796cf65be02cd87f8f3ae8ee243297267c1a891a09d5590148dbdca7d28daa',
      expect.objectContaining({ method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store',
        headers: { 'X-MEXC-APIKEY': credentials.apiKey } })
    );
  });
  it.each([
    null, [], {}, { data: { mxDeductEnable: true } }, { code: '0', data: { mxDeductEnable: true } },
    { code: 0, data: {} }, { code: 0, data: { mxDeductEnable: null } },
    { code: 0, data: { mxDeductEnable: 'false' } }, { code: 0, data: { mxDeductEnable: 1 } },
    { code: 0, data: { mxDeductEnable: 0 } }, { code: 0, data: { mxDeductEnable: 'PRIVATE_ECHO' } }
  ])('rejects ambiguous MX deduction metadata without coercion or echo', async payload => {
    const { client } = setup(payload);
    await expect(client.getMxDeductStatus()).rejects.toThrow(/^account-invalid-response$/);
  });
  it.each([418, 429])('shares MX deduction API cooldown (%s) with account reads without retry', async code => {
    const { client, fetch } = setup({ code, msg: 'PRIVATE_ECHO' });
    await expect(client.getMxDeductStatus()).rejects.toThrow(/^account-rate-limited$/);
    await expect(client.getBalances()).rejects.toThrow(/^account-rate-limited$/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('honors MX deduction HTTP rate failure without exposing response or signed URL', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('PRIVATE_ECHO', {
      status: 429, headers: { 'Retry-After': '30' }
    }));
    const client = new MexcAccountReader({ credentials, fetch, clock: () => now });
    await expect(client.getMxDeductStatus()).rejects.toThrow(/^account-rate-limited$/);
    await expect(client.getMxDeductStatus()).rejects.toThrow(/^account-rate-limited$/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('sanitizes MX deduction auth and network failures', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ code: 700007, msg: 'PRIVATE_ECHO' }))
      .mockImplementationOnce(async url => { throw new Error(String(url)); });
    const client = new MexcAccountReader({ credentials, fetch, clock: () => now });
    await expect(client.getMxDeductStatus()).rejects.toThrow(/^account-auth-failed$/);
    await expect(client.getMxDeductStatus()).rejects.toThrow(/^account-unavailable$/);
  });
  it.each(['ETH/USDT', 'SOL/USDT'] as const)('keeps exact symbol mapping for %s and string fee precision', async symbol => {
    const { client, fetch } = setup({ code: 0, data: { makerCommission: '0.000123456789012345678901234567', takerCommission: '0.001' } });
    expect(await client.getSpotFees(symbol)).toMatchObject({ symbol, makerRate: '0.000123456789012345678901234567', ratePrecision: 'decimal-string' });
    expect(new URL(String(fetch.mock.calls[0][0])).searchParams.get('symbol')).toBe(symbol.replace('/', ''));
  });
  it.each(['BTC/USD', 'DOGE/USDT', '__proto__', 'BTCUSDT&side=BUY'])('rejects unsupported symbol before network: %s', async symbol => {
    const { client, fetch } = setup();
    await expect(client.getSpotFees(symbol as AccountSymbol)).rejects.toThrow(/^account-invalid-symbol$/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([null, true, -0.001, 1.01, 'NaN', 'PRIVATE_ECHO', '-0.001', '1.01'])('rejects invalid fee %s', async makerCommission => {
    const { client } = setup({ code: 0, data: { makerCommission, takerCommission: 0.001 } });
    await expect(client.getSpotFees('BTC/USDT')).rejects.toThrow(/^account-invalid-response$/);
  });
  it('requires successful fee envelope and both rates', async () => {
    for (const payload of [{ data: { makerCommission: 0, takerCommission: 0 } }, { code: 0, data: { makerCommission: 0 } }]) {
      await expect(setup(payload).client.getSpotFees('BTC/USDT')).rejects.toThrow(/^account-invalid-response$/);
    }
  });
  it.each([
    [700003, 'account-clock-skew'], [700002, 'account-auth-failed'], [700006, 'account-auth-failed'],
    [700007, 'account-auth-failed'], [403, 'account-access-denied'], [10007, 'account-api-rejected']
  ])('sanitizes API code %s', async (code, reason) => {
    const { client } = setup({ code, msg: 'PRIVATE_ECHO signed URL', apiKey: credentials.apiKey });
    await expect(client.getBalances()).rejects.toThrow(new RegExp(`^${reason}$`));
  });
  it('shares API cooldown between fee/account reads without automatic retry', async () => {
    const { client, fetch } = setup({ code: 429, msg: 'PRIVATE_ECHO' });
    await expect(client.getSpotFees('BTC/USDT')).rejects.toThrow(/^account-rate-limited$/);
    await expect(client.getBalances()).rejects.toThrow(/^account-rate-limited$/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not expose a signed URL in network failures or classify WAF as invalid key', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockImplementationOnce(async url => { throw new Error(String(url)); })
      .mockResolvedValueOnce(new Response('PRIVATE_ECHO', { status: 403 }));
    const client = new MexcAccountReader({ credentials, fetch, clock: () => now });
    await expect(client.getBalances()).rejects.toThrow(/^account-unavailable$/);
    await expect(client.getBalances()).rejects.toThrow(/^account-access-denied$/);
  });
  it.each([{ apiKey: 'PRIVATE\r\nKEY' }, { apiKey: 'key&side=BUY' }, { apiSecret: '' }])('rejects invalid credentials before I/O', delta => {
    const fetch = vi.fn();
    expect(() => new MexcAccountReader({ credentials: { ...credentials, ...delta }, fetch })).toThrow(/^account-invalid-config$/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
