import { createHmac } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { OkxAccountReader } from '../src/accounts/okx.js';
import type { AccountOptions, AccountSymbol } from '../src/accounts/types.js';

const now = 1_800_000_000_000;
const credentials = { apiKey: 'fixture-key', apiSecret: 'fixture-secret', passphrase: 'fixture-passphrase' };
const json = (value: unknown, init?: ResponseInit) => new Response(JSON.stringify(value), init);
const success = (data: unknown) => ({ code: '0', msg: '', data });
const permissions = () => success([{ perm: 'read_only,withdraw,trade', acctLv: '1', uid: 'private-uid',
  label: 'private-label', ip: 'private-ip', apiKey: credentials.apiKey }]);
const balance = () => success([{ totalEq: '99999999999999999999.000000000000000001', uTime: String(now),
  details: [{ ccy: 'BTC', cashBal: '-0.000000000000000001', eq: '-0.000000000000000001',
    availBal: '', availEq: '0.000000000000000019', frozenBal: '0.0000', uTime: String(now), uid: 'private-uid' }] }]);
const fees = () => success([{ instType: 'SPOT', ts: String(now), maker: '-9', taker: '-8',
  feeGroup: [{ groupId: '12', maker: '-0.00080000', taker: '-0.00100000' }] }]);
function setup(body: unknown) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => json(body));
  return { fetch, reader: new OkxAccountReader({ credentials, fetch, clock: () => now }) };
}

describe('isolated OKX private account reader', () => {
  it('signs timestamp + uppercase GET + exact query, includes passphrase and fixed global origin', async () => {
    const { reader, fetch } = setup(fees());
    await reader.getSpotFees('BTC/USDT');
    const [url, init] = fetch.mock.calls[0];
    const path = '/api/v5/account/trade-fee?instType=SPOT&instId=BTC-USDT';
    expect(String(url)).toBe(`https://www.okx.com${path}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(init?.body).toBeUndefined();
    const headers = new Headers(init?.headers);
    expect(headers.get('OK-ACCESS-KEY')).toBe(credentials.apiKey);
    expect(headers.get('OK-ACCESS-PASSPHRASE')).toBe(credentials.passphrase);
    expect(headers.get('OK-ACCESS-TIMESTAMP')).toBe('2027-01-15T08:00:00.000Z');
    expect(headers.get('OK-ACCESS-SIGN')).toBe(createHmac('sha256', credentials.apiSecret)
      .update(`2027-01-15T08:00:00.000ZGET${path}`).digest('base64'));
    expect(headers.get('x-simulated-trading')).toBeNull();
    expect(String(url)).not.toContain(credentials.apiKey);
  });

  it('accepts all three permissions and strips identity, labels and raw config', async () => {
    const { reader } = setup(permissions());
    expect(await reader.getKeyPermissions()).toEqual({ venue: 'okx', read: true, trade: true,
      withdraw: true, unknownPermissionsPresent: false, accountMode: '1', feeType: null });
    expect(JSON.stringify(reader)).toBe('{}');
    expect(inspect(reader)).not.toMatch(/fixture|apiKey|apiSecret|passphrase/);
  });

  it('reports unknown permission presence without echoing its token', async () => {
    const { reader } = setup(success([{ perm: 'read_only,future_permission', acctLv: '4' }]));
    expect(await reader.getKeyPermissions()).toEqual({ venue: 'okx', read: true, trade: false,
      withdraw: false, unknownPermissionsPresent: true, accountMode: '4', feeType: null });
  });

  it.each(['0', '1'] as const)('preserves fee type %s from the existing config read', async feeType => {
    const body = permissions(); Object.assign(body.data[0], { feeType });
    const { reader, fetch } = setup(body);
    expect(await reader.getKeyPermissions()).toEqual({ venue: 'okx', read: true, trade: true,
      withdraw: true, unknownPermissionsPresent: false, accountMode: '1', feeType });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toBe('https://www.okx.com/api/v5/account/config');
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(fetch.mock.calls[0][1]?.body).toBeUndefined();
  });

  it('leaves missing, malformed and future fee types unknown without exposing their values', async () => {
    for (const feeType of [undefined, null, '', '2', 0, 1, false, {}, [], 'private-fee-setting']) {
      const body = permissions(); Object.assign(body.data[0], { feeType });
      const { reader, fetch } = setup(body);
      expect(await reader.getKeyPermissions()).toEqual({ venue: 'okx', read: true, trade: true,
        withdraw: true, unknownPermissionsPresent: false, accountMode: '1', feeType: null });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it('reports absent read permission without inferring it from trade privileges', async () => {
    const { reader } = setup(success([{ perm: 'trade', acctLv: '2' }]));
    expect(await reader.getKeyPermissions()).toMatchObject({ read: false, trade: true, withdraw: false });
  });

  it('requires all credentials, including passphrase, before any network I/O', () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    for (const field of ['apiKey', 'apiSecret', 'passphrase']) {
      for (const value of [undefined, '', ' ', '\nsecret', 'secret\r\nHeader:value', 'x'.repeat(4097), 123]) {
        expect(() => new OkxAccountReader({ credentials: { ...credentials, [field]: value }, fetch } as AccountOptions))
          .toThrow('account-invalid-credentials');
      }
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('copies credentials so later options mutation cannot alter the signed request', async () => {
    const supplied = { ...credentials };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(permissions()));
    const reader = new OkxAccountReader({ credentials: supplied, fetch, clock: () => now });
    supplied.apiKey = 'changed'; supplied.apiSecret = 'changed'; supplied.passphrase = 'changed';
    await reader.getKeyPermissions();
    const headers = new Headers(fetch.mock.calls[0][1]?.headers);
    expect(headers.get('OK-ACCESS-KEY')).toBe(credentials.apiKey);
    expect(headers.get('OK-ACCESS-PASSPHRASE')).toBe(credentials.passphrase);
  });

  it('keeps precise signed cash/equity and distinguishes margin available equity from balance', async () => {
    const { reader } = setup(balance());
    expect(await reader.getBalances()).toEqual({ venue: 'okx', account: 'trading', updatedAt: String(now),
      totalEquityUsd: '99999999999999999999.000000000000000001', balances: [{ currency: 'BTC',
        cashBalance: '-0.000000000000000001', equity: '-0.000000000000000001', availableBalance: null,
        availableEquity: '0.000000000000000019', frozenBalance: '0.0000', updatedAt: String(now) }] });
  });

  it('supports empty trading and funding accounts without inventing balances', async () => {
    const trading = setup(success([{ totalEq: '0', uTime: String(now), details: [] }]));
    expect((await trading.reader.getBalances()).balances).toEqual([]);
    const funding = setup(success([]));
    expect(await funding.reader.getFundingBalances()).toEqual({ venue: 'okx', account: 'funding', balances: [] });
  });

  it('reads funding balances separately with exact strings and no identity', async () => {
    const { reader, fetch } = setup(success([{ ccy: 'USDT', bal: '10.000000000000000001',
      availBal: '9.000000000000000001', frozenBal: '1.000000000000000000', uid: 'private-uid' }]));
    expect(await reader.getFundingBalances()).toEqual({ venue: 'okx', account: 'funding', balances: [{
      currency: 'USDT', balance: '10.000000000000000001', availableBalance: '9.000000000000000001',
      frozenBalance: '1.000000000000000000' }] });
    expect(String(fetch.mock.calls[0][0])).toBe('https://www.okx.com/api/v5/asset/balances');
  });


  it('reads the authoritative USDT valuation including Earn with exact signed GET and privacy projection', async () => {
    const body = success([{ totalBal: '113.840000000000000001', ts: String(now),
      details: { trading: '8.220000000000000001', funding: '0', earn: '105.62', classic: '0', privateToken: credentials.apiSecret },
      uid: 'private-uid', privateToken: credentials.passphrase }]);
    const { reader, fetch } = setup(body);
    const value = await reader.getAssetValuation();
    expect(value).toEqual({ venue: 'okx', currency: 'USDT', totalUsdt: '113.840000000000000001', updatedAt: String(now),
      wallets: { trading: '8.220000000000000001', funding: '0', earn: '105.62', classic: '0' }, breakdownMatchesTotal: true });
    const [url, init] = fetch.mock.calls[0];
    const path = '/api/v5/asset/asset-valuation?ccy=USDT';
    expect(String(url)).toBe('https://www.okx.com' + path);
    expect(init).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store' });
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).get('OK-ACCESS-SIGN')).toBe(createHmac('sha256', credentials.apiSecret)
      .update('2027-01-15T08:00:00.000ZGET' + path).digest('base64'));
    expect(JSON.stringify(value)).not.toMatch(/private|fixture|apiSecret|passphrase|uid/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('preserves the official valuation when wallet breakdown differs, including the official documentation example', async () => {
    const { reader } = setup(success([{ totalBal: '3790.09', ts: String(now),
      details: { classic: '124.6', earn: '1122.73', funding: '0.09', trading: '2544.28' } }]));
    const result = await reader.getAssetValuation();
    expect(result.totalUsdt).toBe('3790.09'); expect(result.breakdownMatchesTotal).toBe(false);
    expect(result.wallets).toEqual({ classic: '124.6', earn: '1122.73', funding: '0.09', trading: '2544.28' });
  });

  it('compares mixed-precision wallet values exactly and retains negative trading equity', async () => {
    const { reader } = setup(success([{ totalBal: '-0.000000000000000000000000000001', ts: String(now),
      details: { trading: '-99999999999999999999.100000000000000000000000000001',
        funding: '99999999999999999999', earn: '0.10', classic: '0.0000' } }]));
    const result = await reader.getAssetValuation();
    expect(result.totalUsdt).toBe('-0.000000000000000000000000000001'); expect(result.breakdownMatchesTotal).toBe(true);
  });

  it('accepts explicit zero wallets, without adding earnings or inventing available balances', async () => {
    const { reader } = setup(success([{ totalBal: '0.000', ts: String(now),
      details: { trading: '0', funding: '0', earn: '0', classic: '0' }, earnings: '100', available: '100' }]));
    expect(await reader.getAssetValuation()).toEqual({ venue: 'okx', currency: 'USDT', totalUsdt: '0.000', updatedAt: String(now),
      wallets: { trading: '0', funding: '0', earn: '0', classic: '0' }, breakdownMatchesTotal: true });
  });

  it.each(['totalBal', 'ts', 'details', 'trading', 'funding', 'earn', 'classic'])(
    'requires valuation field %s and never substitutes a missing wallet with zero', async field => {
      const row: any = { totalBal: '3', ts: String(now), details: { trading: '1', funding: '0', earn: '2', classic: '0' } };
      if (['totalBal', 'ts', 'details'].includes(field)) delete row[field]; else delete row.details[field];
      await expect(setup(success([row])).reader.getAssetValuation()).rejects.toThrow(/^account-invalid-response$/);
    });

  it.each(['', null, 113.84, '1e2', '+1', '01', 'private-valuation', '1'.repeat(31), '1.' + '0'.repeat(31)])(
    'rejects invalid valuation amounts without leaking upstream data (%s)', async amount => {
      for (const field of ['totalBal', 'trading', 'funding', 'earn', 'classic']) {
        const row: any = { totalBal: '3', ts: String(now), details: { trading: '1', funding: '0', earn: '2', classic: '0' } };
        if (field === 'totalBal') row.totalBal = amount; else row.details[field] = amount;
        await expect(setup(success([row])).reader.getAssetValuation()).rejects.toThrow(/^account-invalid-response$/);
      }
    });

  it.each(['funding', 'earn', 'classic'])('rejects negative nontrading wallet %s', async field => {
    const details: Record<string, string> = { trading: '1', funding: '0', earn: '2', classic: '0' }; details[field] = '-1';
    await expect(setup(success([{ totalBal: '2', ts: String(now), details }])).reader.getAssetValuation()).rejects.toThrow(/^account-invalid-response$/);
  });

  it.each([String(now + 1), '0', '-1', '1.5', '9007199254740992', 1800000000000])('rejects invalid or future valuation timestamp %s', async ts => {
    await expect(setup(success([{ totalBal: '3', ts, details: { trading: '1', funding: '0', earn: '2', classic: '0' } }]))
      .reader.getAssetValuation()).rejects.toThrow(/^account-invalid-response$/);
  });

  it('checks valuation timestamp against receipt rather than send time and retains old source time for freshness checks', async () => {
    let clock = now;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      clock += 250;
      return json(success([{ totalBal: '3', ts: String(now + 125), details: { trading: '1', funding: '0', earn: '2', classic: '0' } }]));
    });
    const reader = new OkxAccountReader({ credentials, fetch, clock: () => clock });
    expect((await reader.getAssetValuation()).updatedAt).toBe(String(now + 125));
    const stale = setup(success([{ totalBal: '3', ts: String(now - 20 * 60_000), details: { trading: '1', funding: '0', earn: '2', classic: '0' } }]));
    expect((await stale.reader.getAssetValuation()).updatedAt).toBe(String(now - 20 * 60_000));
  });

  it('rejects clock rewind while reading valuation', async () => {
    let clock = now;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      clock -= 1;
      return json(success([{ totalBal: '3', ts: String(now - 1), details: { trading: '1', funding: '0', earn: '2', classic: '0' } }]));
    });
    const reader = new OkxAccountReader({ credentials, fetch, clock: () => clock });
    await expect(reader.getAssetValuation()).rejects.toThrow(/^account-invalid-clock$/);
  });

  it('rejects ambiguous valuation responses and preserves rate-limit/error redaction', async () => {
    const row = { totalBal: '3', ts: String(now), details: { trading: '1', funding: '0', earn: '2', classic: '0' } };
    for (const data of [[], [row, row], [null], [{ ...row, details: [] }]]) {
      await expect(setup(success(data)).reader.getAssetValuation()).rejects.toThrow(/^account-invalid-response$/);
    }
    const limited = setup({ code: '50011', msg: credentials.apiSecret, data: [] });
    await expect(limited.reader.getAssetValuation()).rejects.toThrow(/^account-rate-limited$/);
    await expect(limited.reader.getFundingBalances()).rejects.toThrow(/^account-rate-limited$/);
    expect(limited.fetch).toHaveBeenCalledTimes(1);
    const rejected = setup({ code: '50113', msg: credentials.apiSecret, data: [credentials] });
    await expect(rejected.reader.getAssetValuation()).rejects.toThrow(/^account-api-rejected$/);
  });

  it('uses current fee-group rates with explicit commission/rebate sign convention', async () => {
    const body = fees(); body.data[0].feeGroup[0].maker = '0.00010000';
    const { reader } = setup(body);
    expect(await reader.getSpotFees('ETH/USDT')).toEqual({ venue: 'okx', symbol: 'ETH/USDT',
      makerRate: '0.00010000', takerRate: '-0.00100000', rateConvention: 'negative-fee-positive-rebate',
      source: 'fee-group', updatedAt: String(now) });
  });

  it('supports only three explicit symbols; rejects URL or prototype injection before I/O', async () => {
    const { reader, fetch } = setup(fees());
    for (const symbol of ['LTC/USDT', 'BTC/USDT&instType=MARGIN', 'https://invalid.test', '__proto__', 'toString']) {
      await expect(reader.getSpotFees(symbol as AccountSymbol)).rejects.toThrow('account-unsupported-symbol');
    }
    expect(fetch).not.toHaveBeenCalled();
    for (const symbol of ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'] as const) await reader.getSpotFees(symbol);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual(['BTC', 'ETH', 'SOL'].map((coin) =>
      `https://www.okx.com/api/v5/account/trade-fee?instType=SPOT&instId=${coin}-USDT`));
  });

  it('fails closed on missing or ambiguous fee groups even when deprecated rates exist', async () => {
    for (const group of [undefined, [], [{ groupId: '1', maker: '-0.1', taker: '-0.2' },
      { groupId: '2', maker: '-0.2', taker: '-0.3' }]]) {
      const body = fees(); (body.data[0] as Record<string, unknown>).feeGroup = group;
      await expect(setup(body).reader.getSpotFees('BTC/USDT')).rejects.toThrow('account-invalid-response');
    }
    for (const patch of [{ instType: 'MARGIN' }, { instId: 'ETH-USDT' }, { ts: '-1' }]) {
      const body = fees(); Object.assign(body.data[0], patch);
      await expect(setup(body).reader.getSpotFees('BTC/USDT')).rejects.toThrow('account-invalid-response');
    }
  });

  it('rejects malformed data and numeric/empty/exponent balances without leaking values', async () => {
    for (const value of [1, null, undefined, '', '1e-8', '+1', '01', 'private-value', '1'.repeat(31)]) {
      const body = balance(); (body.data[0].details[0] as Record<string, unknown>).cashBal = value;
      await expect(setup(body).reader.getBalances()).rejects.toThrow('account-invalid-response');
    }
    for (const raw of [null, [], {}, { code: 0, data: [] }, success([{}, {}]), success([null])]) {
      await expect(setup(raw).reader.getBalances()).rejects.toThrow('account-invalid-response');
    }
  });

  it('rejects duplicate currencies rather than double-counting an account', async () => {
    const body = balance(); body.data[0].details.push({ ...body.data[0].details[0] });
    await expect(setup(body).reader.getBalances()).rejects.toThrow('account-invalid-response');
    const funding = { ccy: 'BTC', bal: '1', availBal: '1', frozenBal: '0' };
    await expect(setup(success([funding, funding])).reader.getFundingBalances()).rejects.toThrow('account-invalid-response');
  });

  it('rejects invalid permission metadata and never echoes raw config', async () => {
    for (const patch of [{ perm: '' }, { perm: 'read_only,read_only' }, { perm: 'read_only, secret' },
      { acctLv: '5' }, { acctLv: 1 }]) {
      const body = permissions(); Object.assign(body.data[0], patch);
      await expect(setup(body).reader.getKeyPermissions()).rejects.toThrow('account-invalid-response');
    }
  });

  it.each(['50011', '50013', '50040'])('applies shared cooldown on application rate-limit code %s', async (code) => {
    const { reader, fetch } = setup({ code, msg: 'private-response', data: [] });
    await expect(reader.getKeyPermissions()).rejects.toThrow('account-rate-limited');
    await expect(reader.getBalances()).rejects.toThrow('account-rate-limited');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('surfaces clock skew separately without echoing raw error text or automatically retrying', async () => {
    const { reader, fetch } = setup({ code: '50102', msg: 'private-clock-message', data: [] });
    await expect(reader.getKeyPermissions()).rejects.toThrow('account-clock-skew');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('maps remaining application errors to a fixed redacted code', async () => {
    for (const code of ['50113', '50030', 'private-secret']) {
      await expect(setup({ code, msg: credentials.apiSecret, data: [credentials] }).reader.getKeyPermissions())
        .rejects.toThrow('account-api-rejected');
    }
  });

  it('has only explicit account-read methods, never a raw request or mutation method', () => {
    expect(Object.getOwnPropertyNames(OkxAccountReader.prototype).sort()).toEqual([
      'constructor', 'getAssetValuation', 'getBalances', 'getDeposits', 'getEarnBalance', 'getEarnHistoryPage', 'getFundingBalances', 'getKeyPermissions',
      'getOpenOrders', 'getRecentTrades', 'getSpotFees', 'getWithdrawals',
    ]);
  });
});
