import { describe, expect, it, vi } from 'vitest';
import { inspect } from 'node:util';
import { BybitAccountReader } from '../src/accounts/bybit.js';
import { AccountError, type AccountOptions, type AccountSymbol } from '../src/accounts/types.js';

const now = 1_800_000_000_000;
const credentials = { apiKey: 'dummy-key', apiSecret: 'dummy-secret' };
function json(result: unknown, retCode: unknown = 0) {
  return new Response(JSON.stringify({ retCode, retMsg: 'private-upstream-message', result }));
}
function key() {
  return { apiKey: 'private-key-echo', secret: 'private-secret-echo', userID: 123456, ips: ['private-ip'],
    readOnly: 0, permissions: { Spot: ['SpotTrade'], Wallet: ['AccountTransfer', 'SubMemberTransfer', 'Withdraw'],
      ContractTrade: ['Order', 'Position'] } };
}
function balances() {
  return { list: [{ accountType: 'UNIFIED', totalEquity: '1234.123456789012345678', totalWalletBalance: '1230.00',
    totalAvailableBalance: '123.4500', privateField: 'not-for-output', coin: [{ coin: 'BTC',
      walletBalance: '0.100000000000000001', equity: '-0.010000000000000001', usdValue: '-10.010',
      locked: '0.0010', borrowAmount: '0.110000000000000002', accruedInterest: '0.000000000000000003',
      spotBorrow: '0.01000', availableToWithdraw: '999999', free: '888888', privateField: 'not-for-output' }] }] };
}
function fees(symbol = 'BTCUSDT') { return { category: 'spot', list: [{ symbol,
  makerFeeRate: '-0.000100000000000001', takerFeeRate: '0.001000000000000000', privateField: 'not-for-output' }] }; }
function client(fetch: typeof globalThis.fetch, clock = () => now) {
  return new BybitAccountReader({ credentials, fetch, clock });
}

describe('Bybit private account reader', () => {
  it('signs fixed GET reads with independently computed HMAC vectors and no URL secrets or body', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(key()))
      .mockResolvedValueOnce(json(balances())).mockResolvedValueOnce(json(fees()));
    const reader = client(fetch);
    await reader.getKeyPermissions(); await reader.getBalances(); await reader.getSpotFees('BTC/USDT');
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://api.bybit.com/v5/user/query-api',
      'https://api.bybit.com/v5/account/wallet-balance?accountType=UNIFIED',
      'https://api.bybit.com/v5/account/fee-rate?category=spot&symbol=BTCUSDT'
    ]);
    const expectedSignatures = [
      'bd7b179059f0e2e2aeffe4a9d98c29bbf3d114f835a3d092926db3e87c4db6ac',
      '40cf1c5f6347bd80c488a039a7518470458a57530b00c24c2431b6c3510a1d0e',
      '816c374ac6917be8d4d51be36d6120c352bd7fbb53d75383651113b4424b5306'
    ];
    for (const [index, [url, options]] of fetch.mock.calls.entries()) {
      expect(options).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error' });
      expect(options).not.toHaveProperty('body');
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(options?.headers);
      expect(headers.get('X-BAPI-API-KEY')).toBe('dummy-key');
      expect(headers.get('X-BAPI-TIMESTAMP')).toBe(String(now));
      expect(headers.get('X-BAPI-RECV-WINDOW')).toBe('5000');
      expect(headers.get('X-BAPI-SIGN')).toBe(expectedSignatures[index]);
      expect(String(url)).not.toContain('dummy');
    }
  });

  it('accepts read/write keys with transfer and withdrawal rights but returns no private key or identity fields', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(key()));
    const reader = client(fetch);
    expect(await reader.getKeyPermissions()).toEqual({ venue: 'bybit', readOnly: false,
      rights: { spotTrade: true, accountTransfer: true, subAccountTransfer: true, withdraw: true } });
    expect(Object.keys(reader)).toEqual([]);
    expect(JSON.stringify(reader)).toBe('{}');
    expect(inspect(reader)).not.toContain('dummy');
    expect(Object.getOwnPropertyNames(BybitAccountReader.prototype)).toEqual([
      'constructor', 'getKeyPermissions', 'getBalances', 'getSpotFees'
    ]);
  });

  it('does not report mutation capability on read-only keys even when named permission arrays contain those names', async () => {
    const raw = key(); raw.readOnly = 1;
    expect(await client(async () => json(raw)).getKeyPermissions()).toEqual({ venue: 'bybit', readOnly: true,
      rights: { spotTrade: false, accountTransfer: false, subAccountTransfer: false, withdraw: false } });
  });

  it('copies credentials so later caller mutation cannot retarget signing material', async () => {
    const supplied = { ...credentials };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(key()));
    const reader = new BybitAccountReader({ credentials: supplied, fetch, clock: () => now });
    supplied.apiKey = 'changed-key'; supplied.apiSecret = 'changed-secret';
    await reader.getKeyPermissions();
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('X-BAPI-API-KEY')).toBe('dummy-key');
  });

  it('preserves signed monetary digits and labels margin values without inventing spendable or withdrawable cash', async () => {
    const result = await client(async () => json(balances())).getBalances();
    expect(result).toEqual({ venue: 'bybit', accountType: 'UNIFIED',
      margin: { totalEquityUSD: '1234.123456789012345678', totalWalletBalanceUSD: '1230.00', totalAvailableBalanceUSD: '123.4500' },
      coins: [{ coin: 'BTC', walletBalance: '0.100000000000000001', equity: '-0.010000000000000001', usdValue: '-10.010',
        locked: '0.0010', borrowAmount: '0.110000000000000002', accruedInterest: '0.000000000000000003', spotBorrow: '0.01000' }] });
    expect(JSON.stringify(result)).not.toMatch(/private|Withdraw|withdraw|free|spendable|999999|888888/);
  });

  it('keeps unavailable isolated account-wide values as null and supports an empty non-zero-coin result', async () => {
    const raw = balances(); raw.list[0].totalEquity = ''; raw.list[0].totalWalletBalance = ''; raw.list[0].totalAvailableBalance = '';
    raw.list[0].coin = [];
    expect(await client(async () => json(raw)).getBalances()).toEqual({ venue: 'bybit', accountType: 'UNIFIED', coins: [],
      margin: { totalEquityUSD: null, totalWalletBalanceUSD: null, totalAvailableBalanceUSD: null } });
  });

  it.each(['BTC/USDT', 'ETH/USDT', 'SOL/USDT'] as const)('returns exact signed fee fractions for %s', async symbol => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(fees(symbol.replace('/', ''))));
    expect(await client(fetch).getSpotFees(symbol)).toEqual({ venue: 'bybit', symbol,
      makerRate: '-0.000100000000000001', takerRate: '0.001000000000000000', rateUnit: 'fraction' });
  });

  it('rejects arbitrary symbols and path injection before making a request', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    for (const symbol of ['BTCUSDT', 'DOGE/USDT', 'BTC/USDT&secret=bad', '__proto__', 'toString', '', null, {}]) {
      await expect(client(fetch).getSpotFees(symbol as AccountSymbol)).rejects.toThrow('account-invalid-symbol');
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects malformed key permission responses without returning payload values', async () => {
    for (const patch of [{ readOnly: '0' }, { readOnly: 2 }, { permissions: null },
      { permissions: { Spot: 'private', Wallet: [] } }, { permissions: { Spot: [], Wallet: [null] } },
      { permissions: { Spot: ['private permission'], Wallet: [] } }]) {
      await expect(client(async () => json({ ...key(), ...patch })).getKeyPermissions()).rejects
        .toThrowError(new AccountError('account-invalid-response'));
    }
  });

  it('rejects numeric coercion, exponent notation and malformed monetary strings', async () => {
    for (const invalid of [1, null, {}, '1e-8', 'NaN', 'Infinity', '+1', '01', '1.', '.1', ' 1', '', '1.2 private']) {
      const raw = balances(); (raw.list[0].coin[0] as Record<string, unknown>).walletBalance = invalid;
      await expect(client(async () => json(raw)).getBalances()).rejects.toThrow('account-invalid-response');
      const fee = fees(); (fee.list[0] as Record<string, unknown>).takerFeeRate = invalid;
      await expect(client(async () => json(fee)).getSpotFees('BTC/USDT')).rejects.toThrow('account-invalid-response');
    }
  });

  it('rejects negative locked funds or debt, duplicate coins and mismatched account type', async () => {
    for (const field of ['locked', 'borrowAmount', 'accruedInterest', 'spotBorrow']) {
      const raw = balances(); (raw.list[0].coin[0] as Record<string, unknown>)[field] = '-0.01';
      await expect(client(async () => json(raw)).getBalances()).rejects.toThrow('account-invalid-response');
    }
    const duplicate = balances(); duplicate.list[0].coin.push({ ...duplicate.list[0].coin[0] });
    const different = balances(); different.list[0].accountType = 'FUND';
    for (const raw of [duplicate, different, { list: [] }, { list: [null] }, { list: [{ accountType: 'UNIFIED', coin: null }] }]) {
      await expect(client(async () => json(raw)).getBalances()).rejects.toThrow('account-invalid-response');
    }
  });

  it('rejects mismatched, missing or ambiguous spot fee rows', async () => {
    for (const raw of [fees('ETHUSDT'), { ...fees(), category: 'linear' }, { list: fees().list },
      { ...fees(), list: [] }, { ...fees(), list: [...fees().list, ...fees().list] }]) {
      await expect(client(async () => json(raw)).getSpotFees('BTC/USDT')).rejects.toThrow('account-invalid-response');
    }
  });

  it.each([10006, 429])('shares a 60-second cooldown after application rate limit %s without retries', async retCode => {
    let time = now;
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(null, retCode)).mockImplementation(async () => json(key()));
    const reader = client(fetch, () => time);
    await expect(reader.getBalances()).rejects.toThrow('account-rate-limited');
    time += 59_999;
    await expect(reader.getKeyPermissions()).rejects.toThrow('account-rate-limited');
    expect(fetch).toHaveBeenCalledTimes(1);
    time++;
    await expect(reader.getKeyPermissions()).resolves.toHaveProperty('readOnly', false);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([-2015, 33004, 10003, 10004, 10005, 10007, 10010])('maps application authentication code %s to a fixed error', async retCode => {
    await expect(client(async () => json({ apiKey: 'private-key-echo' }, retCode)).getBalances()).rejects
      .toThrowError(new AccountError('account-auth-failed'));
  });

  it('never discloses server errors and refuses malformed envelopes', async () => {
    await expect(client(async () => json({ secret: 'private' }, 10001)).getBalances()).rejects
      .toThrowError(new AccountError('account-api-rejected'));
    for (const retCode of ['0', null, {}, 0.5]) {
      await expect(client(async () => json(key(), retCode)).getKeyPermissions()).rejects.toThrow('account-invalid-response');
    }
    for (const body of [null, [], 'private', { retCode: 0, result: null }]) {
      await expect(client(async () => new Response(JSON.stringify(body))).getKeyPermissions()).rejects.toThrow('account-invalid-response');
    }
  });

  it('rejects missing, malformed or injected credentials without echoing them', () => {
    for (const supplied of [undefined, { apiKey: '', apiSecret: 'private' }, { apiKey: 'private\nheader', apiSecret: 'private' },
      { apiKey: 'dummy', apiSecret: '' }, { apiKey: 'dummy', apiSecret: 'private\nsecret' }, { apiKey: 123, apiSecret: 'private' }]) {
      expect(() => new BybitAccountReader({ credentials: supplied } as AccountOptions)).toThrowError(new AccountError('account-invalid-config'));
    }
  });
});
