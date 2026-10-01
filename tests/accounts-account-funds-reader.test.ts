import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountFundsReader, ACCOUNT_FUNDS_REASONS, type AccountFundsReadOptions } from '../src/accounts/account-funds-reader.js';
import type { AccountIdentityVenue } from '../src/accounts/account-identity-reader.js';
import { AccountTransport } from '../src/accounts/transport.js';

const now = 1_800_000_000_000;
const credentials = { apiKey: 'PRIVATE_TEST_KEY', apiSecret: 'PRIVATE_TEST_SECRET', passphrase: 'PRIVATE_TEST_PASSPHRASE' };
const mexcIdentity = { uid: 'opaque-MEXC:uid/with+PUNCT' };
const okxConfig = { uid: '123456789012345678901234567890', mainUid: '123456789012345678901234567890', type: '0',
  acctLv: '1', autoLoan: false, enableSpotBorrow: false, spotBorrowAutoRepay: false };
const mexcRow = (asset = 'USDT') => ({ asset, free: '1111078.000000000000000001', locked: '33', available: '1.000000000000000000' });
const okxRow = (ccy = 'USDT') => ({ ccy, cashBal: '1111078.000000000000000001', availBal: '1.000000000000000000',
  frozenBal: '33', liab: '0', crossLiab: '0', isoLiab: '0', interest: '0', borrowFroz: '0', uTime: String(now - 5) });
const mexcFunds = () => ({ accountType: 'SPOT', canTrade: true, updateTime: null, balances: ['BTC', 'USDT', 'MX'].map(mexcRow) });
const okxFunds = () => ({ uTime: String(now - 3), details: ['BTC', 'USDT', 'MX'].map(okxRow) });
const acceptIdentity = () => true;
afterEach(() => vi.useRealTimers());
function setup(venue: AccountIdentityVenue, identity: unknown = venue === 'mexc' ? mexcIdentity : okxConfig,
  funds: unknown = venue === 'mexc' ? mexcFunds() : okxFunds(), clock = () => now) {
  const payloads = [identity, funds];
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    const value = payloads.shift();
    return Response.json(venue === 'mexc' ? value : { code: '0', data: [value] });
  });
  return { reader: new AccountFundsReader(venue, { credentials, fetch, clock }), fetch };
}

describe('single immutable account/funds capture', () => {
  it.each(['mexc', 'okx'] as const)('signs exactly the two documented %s GETs in order', async venue => {
    const { reader, fetch } = setup(venue);
    const check = vi.fn(() => { expect(fetch).toHaveBeenCalledTimes(1); return true; });
    const snapshot = await reader.getSnapshot({ acceptIdentity: check });
    expect(snapshot).toMatchObject({ schema: 1, venue, environment: 'mainnet', requestCount: 2,
      identityAccepted: true, fundsAdmission: false, executable: false,
      assessment: { requiredAssets: { BTC: true, USDT: true, MX: true } } });
    expect(snapshot.assessment.reasons).toContain('money-admission-not-implemented');
    expect(check).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledTimes(2);
    const paths = venue === 'mexc' ? ['/api/v3/uid', '/api/v3/account'] : ['/api/v5/account/config', '/api/v5/account/balance'];
    for (const [index, [urlValue, init]] of fetch.mock.calls.entries()) {
      const url = new URL(String(urlValue));
      expect(url.pathname).toBe(paths[index]);
      expect(init).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store' });
      const headers = new Headers(init!.headers);
      if (venue === 'mexc') {
        expect(url.origin).toBe('https://api.mexc.com');
        const query = (index ? 'recvWindow=5000&' : '') + `timestamp=${now}`;
        expect(url.search).toBe(`?${query}&signature=${createHmac('sha256', credentials.apiSecret).update(query).digest('hex')}`);
        expect(headers.get('X-MEXC-APIKEY')).toBe(credentials.apiKey);
        expect(headers.has('OK-ACCESS-KEY')).toBe(false);
      } else {
        expect(url.origin).toBe('https://www.okx.com'); expect(url.search).toBe('');
        const stamp = new Date(now).toISOString();
        expect(headers.get('OK-ACCESS-SIGN')).toBe(createHmac('sha256', credentials.apiSecret).update(`${stamp}GET${paths[index]}`).digest('base64'));
        expect(headers.get('OK-ACCESS-KEY')).toBe(credentials.apiKey);
        expect(headers.get('OK-ACCESS-PASSPHRASE')).toBe(credentials.passphrase);
        expect(headers.has('X-MEXC-APIKEY')).toBe(false);
      }
    }
    expect(snapshot.identity.requestedAt).toBe(now); expect(snapshot.identity.receivedAt).toBe(now);
    expect(snapshot.funds.requestedAt).toBe(now); expect(snapshot.funds.receivedAt).toBe(now);
    expect(Object.isFrozen(reader)).toBe(true); expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.funds.balances[0])).toBe(true);
    expect(JSON.stringify(reader)).toBe('{}');
    await expect(reader.getSnapshot({ acceptIdentity })).rejects.toThrow(/^account-reader-used$/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each(['mexc', 'okx'] as const)('copies %s credentials and callback before suspension', async venue => {
    const mutable = { ...credentials };
    let reader: AccountFundsReader;
    const readOptions: AccountFundsReadOptions = { acceptIdentity: () => {
      expect(Object.isFrozen(reader)).toBe(true); return true;
    } };
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> => {
      const headers = new Headers(init!.headers);
      expect(headers.get(venue === 'mexc' ? 'X-MEXC-APIKEY' : 'OK-ACCESS-KEY')).toBe(credentials.apiKey);
      const value = fetch.mock.calls.length === 1 ? venue === 'mexc' ? mexcIdentity : okxConfig : venue === 'mexc' ? mexcFunds() : okxFunds();
      return Response.json(venue === 'mexc' ? value : { code: '0', data: [value] });
    });
    reader = new AccountFundsReader(venue, { credentials: mutable, fetch, clock: () => now });
    mutable.apiKey = 'MUTATED_KEY'; mutable.apiSecret = 'MUTATED_SECRET'; mutable.passphrase = 'MUTATED_PASSPHRASE';
    const result = reader.getSnapshot(readOptions);
    Object.assign(readOptions, { acceptIdentity: () => false });
    expect((await result).identityAccepted).toBe(true);
  });
  it('requires a trusted identity callback before any I/O', async () => {
    const { reader, fetch } = setup('mexc');
    for (const options of [undefined, {}, { acceptIdentity: true }]) {
      await expect(reader.getSnapshot(options as never)).rejects.toThrow(/^account-invalid-config$/);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([false, undefined, null, 1, 'true'])('does not read funds after non-true callback: %#', async result => {
    const { reader, fetch } = setup('mexc');
    await expect(reader.getSnapshot({ acceptIdentity: () => result } as never)).rejects.toThrow(/^account-identity-mismatch$/);
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(reader.getSnapshot({ acceptIdentity })).rejects.toThrow(/^account-reader-used$/);
  });
  it('redacts a callback exception and blocks second read', async () => {
    const { reader, fetch } = setup('okx');
    await expect(reader.getSnapshot({ acceptIdentity: () => { throw new Error('PRIVATE_UID_AND_SECRET'); } })).rejects.toThrow(/^account-identity-mismatch$/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects overlapping captures without sending another identity request', async () => {
    const { reader, fetch } = setup('mexc');
    const pending = reader.getSnapshot({ acceptIdentity });
    await expect(reader.getSnapshot({ acceptIdentity })).rejects.toThrow(/^account-reader-used$/);
    await pending; expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('rejects bad venue, credentials or absent OKX passphrase before network', () => {
    const fetch = vi.fn();
    expect(() => new AccountFundsReader('bybit' as never, { credentials, fetch })).toThrow(/^account-invalid-config$/);
    expect(() => new AccountFundsReader('okx', { credentials: { ...credentials, passphrase: undefined }, fetch })).toThrow(/^account-invalid-config$/);
    expect(() => new AccountFundsReader('mexc', { credentials: { ...credentials, apiKey: 'PRIVATE\r\n' }, fetch })).toThrow(/^account-invalid-config$/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('exact, narrowly projected funds without admission', () => {
  it('preserves MEXC free and available independently and never sums them', async () => {
    const result = await setup('mexc').reader.getSnapshot({ acceptIdentity });
    expect(result.venue).toBe('mexc');
    expect(result.funds.balances[0]).toMatchObject({ free: '1111078.000000000000000001', locked: '33', available: '1.000000000000000000' });
    expect(result.funds.sourceUpdatedAt).toBeNull();
    expect(result.funds.unavailableFields).toEqual({ updateTime: 'null' });
    expect(result.identity.mainAccountConfirmed).toBe(false);
    expect(result.assessment.reasons).toContain('mexc-available-semantics-unconfirmed');
    expect(result.funds).not.toHaveProperty('availableCapital');
  });
  it.each([['missing', undefined], ['null', null], ['empty', '']] as const)('retains MEXC available %s without substitution', async (reason, available) => {
    const funds = mexcFunds(); Object.assign(funds.balances[0], { available });
    const snapshot = await setup('mexc', mexcIdentity, funds).reader.getSnapshot({ acceptIdentity });
    expect(snapshot.funds.balances[0]).toMatchObject({ available: null, unavailableFields: { available: reason } });
    expect(snapshot.assessment.reasons).toContain('fields-unavailable');
  });
  it('keeps OKX cash, free, frozen and liabilities without equity/private config', async () => {
    const funds = okxFunds(); Object.assign(funds, { totalEq: '9999999', availEq: '88888', private: 'PRIVATE_TEXT' });
    Object.assign(funds.details[0], { eq: '222222222', eqUsd: '66666', private: 'PRIVATE_TEXT' });
    const result = await setup('okx', { ...okxConfig, label: 'PRIVATE_LABEL', ip: 'PRIVATE_IP', perm: 'read_only,trade' }, funds).reader.getSnapshot({ acceptIdentity });
    expect(result.configuration).toEqual({ accountMode: '1', autoLoan: false, enableSpotBorrow: false, spotBorrowAutoRepay: false, unavailableFields: {} });
    expect(result.funds.balances[0]).toMatchObject({ cashBal: '1111078.000000000000000001', availBal: '1.000000000000000000',
      frozenBal: '33', liab: '0', crossLiab: '0', isoLiab: '0', interest: '0', borrowFroz: '0', sourceUpdatedAt: String(now - 5) });
    expect(result.assessment.reasons).toEqual(['money-admission-not-implemented']);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|totalEq|availEq|eqUsd|label|perm/);
    expect(result.identity).not.toHaveProperty('accountMode');
  });
  it.each(['2', '3', '4', '99', undefined])('keeps unsupported OKX mode %s as an observation only', async acctLv => {
    const result = await setup('okx', { ...okxConfig, acctLv }).reader.getSnapshot({ acceptIdentity });
    expect(result.assessment.reasons).toContain('okx-mode-not-supported');
    expect(result.fundsAdmission).toBe(false);
  });
  it.each(['autoLoan', 'enableSpotBorrow', 'spotBorrowAutoRepay'])('marks enabled or missing %s conservatively', async field => {
    for (const value of [true, undefined, null]) {
      const result = await setup('okx', { ...okxConfig, [field]: value }).reader.getSnapshot({ acceptIdentity });
      expect(result.assessment.reasons).toContain('okx-borrow-enabled-or-unknown');
    }
  });
  it.each(['mexc', 'okx'] as const)('preserves negative and excessive precision %s without admission', async venue => {
    const funds = venue === 'mexc' ? { ...mexcFunds(), balances: [{ ...mexcRow('BTC'), free: '-1.000000000000000000000001' }] } :
      { ...okxFunds(), details: [{ ...okxRow('BTC'), cashBal: '-1.000000000000000000000001', liab: '2' }] };
    const result = await setup(venue, venue === 'mexc' ? mexcIdentity : okxConfig, funds).reader.getSnapshot({ acceptIdentity });
    expect(result.assessment.reasons).toEqual(expect.arrayContaining(['negative-amount-reported', 'precision-over-18']));
    if (venue === 'okx') expect(result.assessment.reasons).toContain('liability-reported');
    expect(result.fundsAdmission).toBe(false); expect(JSON.stringify(result)).toContain('-1.000000000000000000000001');
  });
  it.each(['liab', 'crossLiab', 'isoLiab', 'interest', 'borrowFroz'])('retains unresolved OKX %s liability independently', async field => {
    const funds = { ...okxFunds(), details: [{ ...okxRow(), [field]: '0.000000000000000001' }] };
    const result = await setup('okx', okxConfig, funds).reader.getSnapshot({ acceptIdentity });
    expect(result.assessment.reasons).toContain('liability-reported');
  });
  it('distinguishes absent, null, empty and reported zero OKX fields', async () => {
    const row = { ...okxRow(), cashBal: undefined, availBal: null, frozenBal: '', liab: '0' };
    const result = await setup('okx', okxConfig, { details: [row] }).reader.getSnapshot({ acceptIdentity });
    expect(result.funds.balances[0]).toMatchObject({ cashBal: null, availBal: null, frozenBal: null, liab: '0',
      unavailableFields: { cashBal: 'missing', availBal: 'null', frozenBal: 'empty' } });
    expect(result.funds.sourceUpdatedAt).toBeNull(); expect(result.funds.unavailableFields).toEqual({ uTime: 'missing' });
  });
  it.each(['mexc', 'okx'] as const)('does not silently invent missing %s assets as zeros', async venue => {
    const funds = venue === 'mexc' ? { ...mexcFunds(), balances: [] } : { ...okxFunds(), details: [] };
    const result = await setup(venue, venue === 'mexc' ? mexcIdentity : okxConfig, funds).reader.getSnapshot({ acceptIdentity });
    expect(result.assessment.requiredAssets).toEqual({ BTC: false, USDT: false, MX: false });
    expect(result.assessment.reasons).toContain('required-assets-not-reported');
    expect(result.funds.balances).toEqual([]);
  });
  it('retains source timestamps separately from local response receipt and flags future source times', async () => {
    const result = await setup('mexc', mexcIdentity, { ...mexcFunds(), updateTime: now + 1 }).reader.getSnapshot({ acceptIdentity });
    expect(result.funds.sourceUpdatedAt).toBe(String(now + 1)); expect(result.funds.receivedAt).toBe(now);
    expect(result.assessment.reasons).toContain('source-time-in-future');
  });
  it('exports only fixed assessment reasons', async () => {
    const result = await setup('mexc').reader.getSnapshot({ acceptIdentity });
    expect(result.assessment.reasons.every(value => ACCOUNT_FUNDS_REASONS.includes(value))).toBe(true);
  });
});

describe('malformed and untrusted responses fail without private echoes', () => {
  it.each([undefined, null, 1, '', '00', '01.1', '.1', '1.', '1e-8', '+1', '1,1', 'NaN', 'Infinity', '1\n', '9'.repeat(31), '1.' + '0'.repeat(31)])
    ('rejects malformed MEXC required decimal case %#', async free => {
      const { reader } = setup('mexc', mexcIdentity, { ...mexcFunds(), balances: [{ ...mexcRow(), free }] });
      await expect(reader.getSnapshot({ acceptIdentity })).rejects.toThrow(/^account-invalid-response$/);
    });
  it.each(['cashBal', 'availBal', 'frozenBal', 'liab', 'crossLiab', 'isoLiab', 'interest', 'borrowFroz'])('rejects numeric/garbage OKX %s without coercion', async field => {
    for (const value of [1, 'PRIVATE_SECRET', '1e3']) {
      await expect(setup('okx', okxConfig, { ...okxFunds(), details: [{ ...okxRow(), [field]: value }] }).reader.getSnapshot({ acceptIdentity })).rejects.toThrow(/^account-invalid-response$/);
    }
  });
  it.each(['mexc', 'okx'] as const)('rejects duplicate %s currencies', async venue => {
    const funds = venue === 'mexc' ? { ...mexcFunds(), balances: [mexcRow(), mexcRow()] } : { ...okxFunds(), details: [okxRow(), okxRow()] };
    await expect(setup(venue, venue === 'mexc' ? mexcIdentity : okxConfig, funds).reader.getSnapshot({ acceptIdentity })).rejects.toThrow(/^account-invalid-response$/);
  });
  it.each(['', 'btc', 'PRIVATE\n', 'A'.repeat(33), null, 1, 'BTC/USDT'])('rejects invalid currency case %#', async asset => {
    await expect(setup('mexc', mexcIdentity, { ...mexcFunds(), balances: [{ ...mexcRow(), asset }] }).reader.getSnapshot({ acceptIdentity })).rejects.toThrow(/^account-invalid-response$/);
  });
  it('accepts general bounded currency symbols instead of silently dropping non-BTC assets', async () => {
    const assets = ['1000SATS', 'X.Y', 'A-B', 'A_B', '9'.repeat(32)];
    const result = await setup('mexc', mexcIdentity, { ...mexcFunds(), balances: assets.map(mexcRow) }).reader.getSnapshot({ acceptIdentity });
    expect(result.funds.balances.map(row => row.currency)).toEqual(assets);
  });
  it('bounds the number of reported assets', async () => {
    const balances = Array.from({ length: 2001 }, (_, i) => ({ asset: `A${i}`, free: '0', locked: '0' }));
    await expect(setup('mexc', mexcIdentity, { ...mexcFunds(), balances }).reader.getSnapshot({ acceptIdentity })).rejects.toThrow(/^account-invalid-response$/);
    balances.pop();
    const result = await setup('mexc', mexcIdentity, { ...mexcFunds(), balances }).reader.getSnapshot({ acceptIdentity });
    expect(result.funds.balances).toHaveLength(2000);
  });
  it.each([{ uid: 123 }, { uid: '' }, { uid: 'PRIVATE\n' }, { uid: 'A'.repeat(257) }])('rejects malformed identity before funds %#', async identity => {
    const { reader, fetch } = setup('mexc', identity);
    await expect(reader.getSnapshot({ acceptIdentity })).rejects.toThrow(/^account-invalid-response$/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([{ ...okxConfig, uid: 'PRIVATE_UID' }, { ...okxConfig, mainUid: '999' }, { ...okxConfig, type: '1' },
    { ...okxConfig, type: '99' }, { ...okxConfig, autoLoan: 'false' }])('rejects contradictory identity or malformed config before funds %#', async config => {
    const { reader, fetch } = setup('okx', config);
    await expect(reader.getSnapshot({ acceptIdentity })).rejects.toThrow(/^account-invalid-response$/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('prevents reflected credentials reaching callback or archive DTO', async () => {
    const check = vi.fn(() => true);
    const { reader, fetch } = setup('mexc', { uid: credentials.apiSecret });
    await expect(reader.getSnapshot({ acceptIdentity: check })).rejects.toThrow(/^account-invalid-response$/);
    expect(check).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['mexc', 'okx'] as const)('drops unknown %s response metadata rather than archiving it', async venue => {
    const funds = venue === 'mexc' ? { ...mexcFunds(), apiKey: credentials.apiKey, note: 'PRIVATE_RESPONSE' } :
      { ...okxFunds(), apiKey: credentials.apiKey, note: 'PRIVATE_RESPONSE' };
    const result = await setup(venue, venue === 'mexc' ? { ...mexcIdentity, label: 'PRIVATE_LABEL' } : { ...okxConfig, label: 'PRIVATE_LABEL' }, funds).reader.getSnapshot({ acceptIdentity });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|apiKey|label/);
  });
  it.each([0, -1, 'PRIVATE_TIME', '01', '1e10', '9007199254740993'])('rejects invalid source timestamp %#', async updateTime => {
    await expect(setup('mexc', mexcIdentity, { ...mexcFunds(), updateTime }).reader.getSnapshot({ acceptIdentity })).rejects.toThrow(/^account-invalid-response$/);
  });
});

describe('bounded failures and isolated transport', () => {
  it.each([401, 403, 429, 418, 500])('halts after identity HTTP %s without leaking body or retrying', async status => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('PRIVATE_UID_SECRET', { status }));
    const reader = new AccountFundsReader('mexc', { credentials, fetch, clock: () => now });
    const code = status === 401 ? 'account-auth-failed' : status === 403 ? 'account-access-denied' : status === 429 || status === 418 ? 'account-rate-limited' : 'account-api-rejected';
    await expect(reader.getSnapshot({ acceptIdentity })).rejects.toThrow(new RegExp(`^${code}$`));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([['mexc', 429], ['mexc', 418], ['okx', '50011'], ['okx', '50013'], ['okx', '50040']] as const)('halts %s API rate limit %s', async (venue, code) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ code, data: [], msg: credentials.apiSecret }));
    await expect(new AccountFundsReader(venue, { credentials, fetch, clock: () => now }).getSnapshot({ acceptIdentity })).rejects.toThrow(/^account-rate-limited$/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([['mexc', 429], ['mexc', 418], ['okx', '50011'], ['okx', '50013'], ['okx', '50040']] as const)
    ('preserves late %s API rate-limit %s for durable caller cooldown', async (venue, code) => {
      let at = now;
      const fetch = vi.fn<typeof globalThis.fetch>(async () => {
        at += 30_001;
        return Response.json({ code, data: [], msg: credentials.apiSecret });
      });
      const reader = new AccountFundsReader(venue, { credentials, fetch, clock: () => at });
      await expect(reader.getSnapshot({ acceptIdentity })).rejects.toThrow(/^account-rate-limited$/);
      await expect(reader.getSnapshot({ acceptIdentity })).rejects.toThrow(/^account-reader-used$/);
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  it('reports funds-read failure without returning a partial successful snapshot', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (): Promise<Response> => fetch.mock.calls.length === 1 ? Response.json(mexcIdentity) : new Response('PRIVATE_SECRET', { status: 429 }));
    await expect(new AccountFundsReader('mexc', { credentials, fetch, clock: () => now }).getSnapshot({ acceptIdentity })).rejects.toThrow(/^account-rate-limited$/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each([-1, 30_001])('blocks next GET on local time shift %s', async delta => {
    let at = now;
    const { reader, fetch } = setup('mexc', mexcIdentity, mexcFunds(), () => at);
    await expect(reader.getSnapshot({ acceptIdentity: () => { at += delta; return true; } })).rejects.toThrow(delta < 0 ? /^account-invalid-clock$/ : /^account-timeout$/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('redacts a clock exception before any network call', async () => {
    const fetch = vi.fn();
    const reader = new AccountFundsReader('mexc', { credentials, fetch, clock: () => { throw new Error('PRIVATE_CLOCK_SECRET'); } });
    await expect(reader.getSnapshot({ acceptIdentity })).rejects.toThrow(/^account-invalid-clock$/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not leak a clock exception or send funds after identity approval', async () => {
    let broken = false;
    const { reader, fetch } = setup('okx', okxConfig, okxFunds(), () => {
      if (broken) throw new Error('PRIVATE_CLOCK_SECRET'); return now;
    });
    await expect(reader.getSnapshot({ acceptIdentity: () => { broken = true; return true; } })).rejects.toThrow(/^account-invalid-clock$/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('bounds a never-ending identity callback and sends no later request when it resolves', async () => {
    vi.useFakeTimers(); let release!: (value: boolean) => void;
    const { reader, fetch } = setup('mexc');
    const pending = reader.getSnapshot({ acceptIdentity: () => new Promise<boolean>(resolve => { release = resolve; }) });
    const rejected = expect(pending).rejects.toThrow(/^account-timeout$/);
    await vi.advanceTimersByTimeAsync(30_000); await rejected;
    release(true); await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('bounds a hanging HTTP request to transport timeout', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => {}));
    const reader = new AccountFundsReader('mexc', { credentials, fetch, clock: () => now });
    const rejected = expect(reader.getSnapshot({ acceptIdentity })).rejects.toThrow(/^account-timeout$/);
    await vi.advanceTimersByTimeAsync(5000); await rejected;
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    'https://www.okx.com/api/v5/asset/balances', 'https://www.okx.com/api/v5/account/balance?ccy=USDT',
    'https://www.okx.com/api/v5/account/config?', 'https://www.okx.com/api/v5/trade/order',
    'https://api.mexc.com/api/v3/order', 'https://api.mexc.com/api/v3/account',
    'https://api.bybit.com/v5/user/query-api', 'https://www.okx.com.evil.test/api/v5/account/config',
  ])('isolated funds transport refuses %s before I/O', async url => {
    const fetch = vi.fn(); const transport = new AccountTransport({ credentials, fetch }, 'account-funds');
    await expect(transport.request(url, {})).rejects.toThrow(/^account-unsupported-endpoint$/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not expand prior identity scope with balance endpoints', async () => {
    const fetch = vi.fn(); const transport = new AccountTransport({ credentials, fetch }, 'account-identity');
    await expect(transport.request('https://www.okx.com/api/v5/account/balance', {})).rejects.toThrow(/^account-unsupported-endpoint$/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
