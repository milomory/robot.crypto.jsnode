import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountTransport } from '../src/accounts/transport.js';
const credentials = { apiKey: 'TEST_PRIVATE_KEY', apiSecret: 'TEST_PRIVATE_SECRET' };
const url = 'https://api.bybit.com/v5/account/wallet-balance?accountType=UNIFIED';
afterEach(() => vi.useRealTimers());
function setup(impl: typeof fetch = vi.fn(async () => Response.json({ ok: true })), clock = () => 1_000_000) {
  return { client: new AccountTransport({ credentials, fetch: impl, clock }), fetch: impl };
}

describe('private account transport boundary', () => {
  it('uses only GET with no redirects/cookies and exposes no credentials through JSON serialization', async () => {
    const { client, fetch } = setup();
    expect(await client.request(url, { 'X-BAPI-API-KEY': credentials.apiKey })).toEqual({ ok: true });
    const call = vi.mocked(fetch).mock.calls[0];
    expect(call[1]).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store' });
    expect(JSON.stringify(client)).not.toContain('PRIVATE');
  });
  it.each([
    'http://api.bybit.com/v5/user/query-api',
    'https://attacker.invalid/v5/user/query-api',
    'https://api.bybit.com/v5/order/create',
    'https://api.bybit.com/v5/asset/withdraw/create',
    'https://www.okx.com/api/v5/asset/withdrawal',
    'https://api.hitbtc.com/api/3/wallet/crypto/withdraw',
    'https://api.bybit.com/v5/user/query-api?api_key=SECRET',
    'https://api.bybit.com/v5/account/wallet-balance?accountType=UNIFIED&accountType=UNIFIED',
    'https://api.bybit.com/v5/account/wallet-balance?accountType=CONTRACT',
    'https://api.bybit.com/v5/account/fee-rate?category=spot&symbol=DOGEUSDT',
    'https://api.hitbtc.com/api/3/spot/fee/BTCUSD',
    'https://user:secret@api.bybit.com/v5/user/query-api',
    'https://api.bybit.com/v5/user/query-api#PRIVATE',
  ])('rejects unsupported target before I/O: %s', async bad => {
    const { client, fetch } = setup();
    await expect(client.request(bad, {})).rejects.toThrow('account-unsupported-endpoint');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects write-shaped MX deduction parameters before HTTP', async () => {
    const signature = 'a'.repeat(64);
    for (const extra of ['&mxDeductEnable=true', '&enable=true', '&timestamp=1000000']) {
      const { client, fetch } = setup();
      await expect(client.request('https://api.mexc.com/api/v3/mxDeduct/enable?recvWindow=5000&timestamp=1000000&signature=' + signature + extra, {}))
        .rejects.toThrow('account-unsupported-endpoint');
      expect(fetch).not.toHaveBeenCalled();
    }
  });
  it('forbids credential headers on public symbol metadata', async () => {
    const { client, fetch } = setup();
    await expect(client.request('https://api.hitbtc.com/api/3/public/symbol/BTCUSDT', { Authorization: 'Basic PRIVATE' }))
      .rejects.toThrow('account-public-credentials-forbidden');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects invalid credentials before a request and never echoes input', () => {
    const mock = vi.fn();
    expect(() => new AccountTransport({ credentials: { ...credentials, apiKey: 'PRIVATE\r\nAuthorization: other' }, fetch: mock }))
      .toThrow(/^account-invalid-config$/);
    expect(mock).not.toHaveBeenCalled();
  });
  it.each([401, 403, 500])('redacts rejected HTTP %s bodies', async status => {
    const { client } = setup(vi.fn(async () => new Response('PRIVATE_SECRET response', { status })));
    await expect(client.request(url, {})).rejects.toThrow(status === 500 ? /^account-api-rejected$/ : /^account-auth-failed$/);
  });
  it('redacts fetch and malformed JSON errors', async () => {
    const first = setup(vi.fn(async () => { throw new Error('PRIVATE_SECRET https://secret.invalid'); }));
    await expect(first.client.request(url, {})).rejects.toThrow(/^account-unavailable$/);
    const second = setup(vi.fn(async () => new Response('PRIVATE_SECRET')));
    await expect(second.client.request(url, {})).rejects.toThrow(/^account-invalid-response$/);
  });
  it('preserves longer Retry-After and makes no requests during cooldown', async () => {
    let now = 1_000_000;
    const mock = vi.fn(async () => new Response('PRIVATE', { status: 429, headers: { 'Retry-After': '3600' } }));
    const { client } = setup(mock, () => now);
    await expect(client.request(url, {})).rejects.toThrow('account-rate-limited');
    now += 3_599_999;
    await expect(client.request(url, {})).rejects.toThrow('account-rate-limited');
    expect(mock).toHaveBeenCalledTimes(1);
    now++;
    await expect(client.request(url, {})).rejects.toThrow('account-rate-limited');
    expect(mock).toHaveBeenCalledTimes(2);
  });
  it('supports Retry-After dates and never shortens an application cooldown', async () => {
    let now = 1_000_000;
    const mock = vi.fn(async () => new Response(null, { status: 418, headers: { 'Retry-After': new Date(now + 120_000).toUTCString() } }));
    const { client } = setup(mock, () => now);
    await expect(client.request(url, {})).rejects.toThrow('account-rate-limited');
    client.cooldown(1);
    now += 100_000;
    await expect(client.request(url, {})).rejects.toThrow('account-rate-limited');
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it.each([true, false])('bounds advertised and streamed payloads (header=%s)', async header => {
    const { client } = setup(vi.fn(async () => new Response('x'.repeat(256 * 1024 + 1), {
      headers: header ? { 'Content-Length': String(256 * 1024 + 1) } : undefined
    })));
    await expect(client.request(url, {})).rejects.toThrow(/^account-response-too-large$/);
  });
  it('stops both a stalled fetch and stalled body at the shared deadline', async () => {
    vi.useFakeTimers();
    for (const body of [false, true]) {
      let signal: AbortSignal | undefined;
      const mock = vi.fn(async (_url: any, opts: any) => {
        signal = opts.signal;
        if (body) return new Response(new ReadableStream({ start() {} }));
        return await new Promise<Response>(() => {});
      });
      const { client } = setup(mock);
      const result = expect(client.request(url, {})).rejects.toThrow(/^account-timeout$/);
      await vi.advanceTimersByTimeAsync(5000); await result;
      expect(signal?.aborted).toBe(true);
    }
  });
  it('does not queue requests signed with aging timestamps', async () => {
    let release!: (response: Response) => void;
    const mock = vi.fn(() => new Promise<Response>(resolve => { release = resolve; }));
    const { client } = setup(mock);
    const first = client.request(url, {});
    await expect(client.request(url, {})).rejects.toThrow('account-busy');
    expect(mock).toHaveBeenCalledTimes(1);
    release(Response.json({ ok: true })); await first;
  });
});


describe('late injected transport completion', () => {
  it('cancels a stalled response body at the deadline', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const { client } = setup(vi.fn(async () => new Response(new ReadableStream({ cancel }))));
    const rejected = expect(client.request(url, {})).rejects.toThrow('account-timeout');
    await vi.advanceTimersByTimeAsync(5000); await rejected;
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('discards a late 429 without changing cooldown for the next request', async () => {
    vi.useFakeTimers();
    let late!: (response: Response) => void;
    const mock = vi.fn<typeof fetch>()
      .mockImplementationOnce(() => new Promise<Response>(resolve => { late = resolve; }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    const { client } = setup(mock);
    const rejected = expect(client.request(url, {})).rejects.toThrow('account-timeout');
    await vi.advanceTimersByTimeAsync(5000); await rejected;
    late(new Response(null, { status: 429, headers: { 'Retry-After': '3600' } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await client.request(url, {})).toEqual({ ok: true });
    expect(mock).toHaveBeenCalledTimes(2);
  });
});


describe('MEXC signed endpoint allowlist', () => {
  const suffix = 'recvWindow=5000&timestamp=1800000000000&signature=' + 'a'.repeat(64);
  const account = 'https://api.mexc.com/api/v3/account?' + suffix;
  const fee = 'https://api.mexc.com/api/v3/tradeFee?symbol=BTCUSDT&' + suffix;
  it.each([account, fee])('permits only complete signed account/fee GET queries', async target => {
    const { client, fetch } = setup();
    await client.request(target, { 'X-MEXC-APIKEY': credentials.apiKey });
    expect(vi.mocked(fetch).mock.calls[0][1]?.method).toBe('GET');
  });
  it.each([
    account.replace('/account?', '/order?'), account.replace('/account?', '/capital/withdraw?'),
    account.replace('/account?', '/apiKeyInfo?'), account + '&accessKey=PRIVATE',
    account + '&timestamp=1800000000000', account + '&signature=' + 'b'.repeat(64),
    account.replace('5000', '60000'), account.replace('1800000000000', '-1'),
    account.replace('1800000000000', '9007199254740992'), account.replace('timestamp=1', 'timestamp=%31'),
    account.replace('signature=' + 'a'.repeat(64), 'signature=' + 'A'.repeat(64)),
    account.replace('signature=' + 'a'.repeat(64), 'signature=PRIVATE'),
    'https://api.mexc.com/api/v3/account', fee.replace('BTCUSDT', 'BTCUSD'),
    fee.replace('BTCUSDT', 'DOGEUSDT'), fee + '&side=BUY', account.replace('api.mexc.com', 'api.mexc.com.attacker.invalid')
  ])('blocks unsupported signed target before network', async target => {
    const { client, fetch } = setup();
    await expect(client.request(target, {})).rejects.toThrow(/^account-unsupported-endpoint$/);
    expect(fetch).not.toHaveBeenCalled();
  });
});


describe('OKX Earn read-only boundary', () => {
  const origin = 'https://www.okx.com/api/v5/finance/savings/';
  it.each(['balance?ccy=USDT', 'lending-history?ccy=USDT&limit=100',
    'lending-history?ccy=USDT&limit=100&after=1790593200000'])('accepts bounded Earn read %s', async path => {
    const { client, fetch } = setup();
    await client.request(origin + path, {});
    expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error' });
  });
  it.each(['purchase-redempt', 'set-lending-rate', 'balance', 'balance?ccy=BTC',
    'balance?ccy=USDT&ccy=USDT', 'balance?ccy=USDT&amt=100',
    'lending-history?ccy=USDT&limit=101', 'lending-history?ccy=USDT&limit=100&before=123',
    'lending-history?ccy=USDT&limit=100&after=-1', 'lending-history?ccy=USDT&limit=100&after=0',
    'lending-history?ccy=USDT&limit=100&after=9007199254740992',
    'lending-history?ccy=USDT&limit=100&after=123&after=123',
    'lending-history?ccy=USDT&limit=100&subAcct=other'])('rejects unrelated or malformed Earn read %s', async path => {
    const { client, fetch } = setup();
    await expect(client.request(origin + path, {})).rejects.toThrow('account-unsupported-endpoint');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not expand the execution-history credential scope', async () => {
    const request = vi.fn();
    const client = new AccountTransport({ credentials, fetch: request }, 'execution-history');
    await expect(client.request(origin + 'balance?ccy=USDT', {})).rejects.toThrow('account-unsupported-endpoint');
    expect(request).not.toHaveBeenCalled();
  });
});
