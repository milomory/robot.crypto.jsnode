import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MexcFuturesAccountReader } from '../src/accounts/mexc-futures.js';
import { AccountTransport } from '../src/accounts/transport.js';

const credentials = { apiKey: 'MEXC_FUTURES_TEST_KEY', apiSecret: 'MEXC_FUTURES_TEST_SECRET' };
const now = 1_800_000_000_000;
const endpoint = 'https://api.mexc.com/api/v1/private/account/assets';
const row = { currency: 'USDT', equity: '32.8', availableBalance: '20', bonus: '0', debtAmount: '0', availableCash: '19' };
function setup(payload: unknown = { success: true, code: 0, data: [row] }) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(payload));
  return { client: new MexcFuturesAccountReader({ credentials, fetch, clock: () => now }), fetch };
}
function raw(text: string) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(text));
  return { client: new MexcFuturesAccountReader({ credentials, fetch, clock: () => now }), fetch };
}
afterEach(() => vi.useRealTimers());

describe('MEXC futures account read', () => {
  it('uses the current host and independent HMAC vector with no query and no mutation', async () => {
    const { client, fetch } = setup();
    expect(await client.getBalances()).toEqual({ venue: 'mexc', account: 'futures', requestedAt: now, receivedAt: now, balances: [row] });
    // Independently calculated with Python hmac/hashlib and test-only credentials.
    expect(fetch).toHaveBeenCalledExactlyOnceWith(endpoint, expect.objectContaining({
      method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store',
      headers: { ApiKey: credentials.apiKey, 'Request-Time': String(now), Signature: 'f9b695ed860641ccacd200914303a2725b75fda5808fe0b08b48908e972aed6e' }
    }));
    expect(inspect(client)).not.toMatch(/MEXC_FUTURES_TEST|Signature/);
    expect(JSON.stringify(client)).toBe('{}');
    expect(Object.keys(Object.getPrototypeOf(client))).toEqual([]);
  });
  it('retains every digit of bare JSON decimals, exponent amounts, negative equity and zero', async () => {
    const { client } = raw('{"success":true,"code":0,"message":"PRIVATE_ECHO 123 \\" 42","data":[{"currency":"USDT","equity":9007199254740993.123456789012345678901234567890,"availableBalance":-1.25e-7,"bonus":0E-18,"debtAmount":1.0000000000000000001,"availableCash":1.234e2,"vcoinId":"PRIVATE_ID"}]}');
    expect((await client.getBalances()).balances).toEqual([{ currency: 'USDT', equity: '9007199254740993.12345678901234567890123456789', availableBalance: '-0.000000125', bonus: '0', debtAmount: '1.0000000000000000001', availableCash: '123.4' }]);
    const signed = setup({ success: true, code: 0, data: [{ ...row, equity: '-0.1230000', availableBalance: '-0' }] });
    expect((await signed.client.getBalances()).balances[0]).toMatchObject({ equity: '-0.123', availableBalance: '0' });
  });
  it('preserves missing supplemental fields as unknown rather than inventing zeros', async () => {
    const result = await setup({ success: true, code: 0, data: [{ currency: 'BTC', equity: '2', availableBalance: '1' }] }).client.getBalances();
    expect(result.balances).toEqual([{ currency: 'BTC', equity: '2', availableBalance: '1', bonus: null, debtAmount: null, availableCash: null }]);
    expect((await setup({ success: true, code: 0, data: [] }).client.getBalances()).balances).toEqual([]);
  });
  it('strips all unrelated fields and copies credentials before callers can change them', async () => {
    const input = { ...credentials };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ success: true, code: 0, message: 'PRIVATE', data: [{ ...row, vcoinId: 'PRIVATE_ID', secret: 'PRIVATE_SECRET', unrealized: 9, positionMargin: 20 }] }));
    const client = new MexcFuturesAccountReader({ credentials: input, fetch, clock: () => now });
    input.apiKey = 'CHANGED'; input.apiSecret = 'CHANGED';
    expect(JSON.stringify(await client.getBalances())).not.toMatch(/PRIVATE|unrealized|positionMargin/);
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('apikey')).toBe(credentials.apiKey);
  });
  it.each([
    { currency: 'bad/private' }, { equity: null }, { equity: true }, { equity: 'NaN' },
    { equity: '01' }, { equity: '1e1000' }, { equity: '1e-61' }, { equity: '1e90' },
    { equity: '1e309' }, { equity: '1.' }, { equity: '+1' }, { equity: 'PRIVATE_ECHO' },
    { bonus: '-0.1' }, { debtAmount: '-1' }, { availableBalance: undefined }
  ])('rejects malformed values without exposing payload: %j', async delta => {
    const { client } = setup({ success: true, code: 0, data: [{ ...row, ...delta }] });
    await expect(client.getBalances()).rejects.toThrow(/^account-invalid-response$/);
  });
  it.each([
    '{"success":true,"code":0,"data":[],1:2}',
    '{"success":true,"code":0,"data":[{"currency":"USDT","equity":01,"availableBalance":0}]}',
    '{"success":true,"code":0,"data":[{"currency":"USDT","equity":NaN,"availableBalance":0}]}',
    '{"success":true,"code":0,"data":[{"currency":"USDT","equity":1e999,"availableBalance":0}]}',
    'PRIVATE_ECHO', '{"success":true,"code":0,"data":[]} trailing'
  ])('does not repair malformed JSON or overflowing numeric tokens', async text => {
    await expect(raw(text).client.getBalances()).rejects.toThrow(/^account-invalid-response$/);
  });
  it('rejects duplicate currencies, excessive rows, inconsistent envelopes and missing data', async () => {
    for (const payload of [
      { success: true, code: 0, data: [row, row] },
      { success: true, code: 0, data: Array.from({ length: 201 }, (_, n) => ({ ...row, currency: `C${n}` })) },
      { success: false, code: 0, data: [row] }, { success: true, data: [row] }, { success: true, code: 0 }
    ]) await expect(setup(payload).client.getBalances()).rejects.toThrow(/^account-invalid-response$/);
  });
  it.each([
    [401, 'account-auth-failed'], [402, 'account-auth-failed'], [602, 'account-auth-failed'],
    [406, 'account-access-denied'], [511, 'account-access-denied'], [701, 'account-access-denied'],
    [604, 'account-unavailable'], [801, 'account-unavailable'], [1000, 'account-api-rejected']
  ])('maps only known API error code %s without disclosing upstream message', async (code, reason) => {
    await expect(setup({ success: false, code, message: 'PRIVATE_ECHO', apiKey: credentials.apiKey }).client.getBalances()).rejects.toThrow(new RegExp(`^${reason}$`));
  });
  it('honors futures API cooldown and never retries in the background', async () => {
    const { client, fetch } = setup({ success: false, code: 510, message: 'PRIVATE_ECHO' });
    await expect(client.getBalances()).rejects.toThrow(/^account-rate-limited$/);
    await expect(client.getBalances()).rejects.toThrow(/^account-rate-limited$/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('bounds the response body and sanitizes network/WAF failures', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('PRIVATE_ECHO', { headers: { 'content-length': String(256 * 1024 + 1) } }))
      .mockRejectedValueOnce(new Error('PRIVATE_ECHO ' + credentials.apiSecret))
      .mockResolvedValueOnce(new Response('PRIVATE_ECHO', { status: 403 }));
    const client = new MexcFuturesAccountReader({ credentials, fetch, clock: () => now });
    await expect(client.getBalances()).rejects.toThrow(/^account-response-too-large$/);
    await expect(client.getBalances()).rejects.toThrow(/^account-unavailable$/);
    await expect(client.getBalances()).rejects.toThrow(/^account-access-denied$/);
  });
  it('times out once and refuses concurrent requests', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => {}));
    const client = new MexcFuturesAccountReader({ credentials, fetch, clock: () => now });
    const first = expect(client.getBalances()).rejects.toThrow(/^account-timeout$/);
    await expect(client.getBalances()).rejects.toThrow(/^account-busy$/);
    await vi.advanceTimersByTimeAsync(5000);
    await first;
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([NaN, -1, 1.5, Number.MAX_SAFE_INTEGER])('rejects invalid clocks before network: %s', async value => {
    const fetch = vi.fn();
    await expect(new MexcFuturesAccountReader({ credentials, fetch, clock: () => value }).getBalances()).rejects.toThrow(/^account-invalid-clock$/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([-1, 120_001])('rejects rewind or excessive clock jumps after receipt: %s', async delta => {
    let time = now;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => { time += delta; return Response.json({ success: true, code: 0, data: [row] }); });
    await expect(new MexcFuturesAccountReader({ credentials, fetch, clock: () => time }).getBalances()).rejects.toThrow(/^account-invalid-clock$/);
  });
  it.each([{ apiKey: 'KEY\r\nINJECT' }, { apiKey: 'key?private' }, { apiSecret: '' }])('rejects invalid credentials before requests', delta => {
    const fetch = vi.fn();
    expect(() => new MexcFuturesAccountReader({ credentials: { ...credentials, ...delta }, fetch })).toThrow(/^account-invalid-config$/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('new exact account transport paths', () => {
  it.each([
    endpoint + '?currency=USDT', endpoint + '?timestamp=1', endpoint + '/',
    'https://contract.mexc.com/api/v1/private/account/assets',
    'https://api.mexc.com/api/v1/private/order/submit',
    'https://www.okx.com/api/v5/asset/asset-valuation',
    'https://www.okx.com/api/v5/asset/asset-valuation?ccy=USD',
    'https://www.okx.com/api/v5/asset/asset-valuation?ccy=USDT&ccy=USDT',
    'https://www.okx.com/api/v5/asset/asset-valuation?ccy=USDT&apiKey=private'
  ])('refuses URL outside exact read policy: %s', async url => {
    const fetch = vi.fn();
    await expect(new AccountTransport({ credentials, fetch, clock: () => now }).request(url, {})).rejects.toThrow(/^account-unsupported-endpoint$/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('retains numeric JSON behavior for the OKX endpoint while accepting its exact URL', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('{"code":"0","data":[],"testNumber":1.5}'));
    const transport = new AccountTransport({ credentials, fetch, clock: () => now });
    expect(await transport.request('https://www.okx.com/api/v5/asset/asset-valuation?ccy=USDT', {})).toEqual({ code: '0', data: [], testNumber: 1.5 });
  });
});
