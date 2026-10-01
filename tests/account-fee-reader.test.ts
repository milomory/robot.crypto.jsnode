import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountFeeReader, parseAccountFeeSnapshot, type AccountFeeReadOptions } from '../src/accounts/account-fee-reader.js';
import { AccountTransport } from '../src/accounts/transport.js';
import type { AccountIdentityVenue } from '../src/accounts/account-identity-reader.js';

const now = 1_800_000_000_000;
const credentials = { apiKey: 'PRIVATE_TEST_KEY', apiSecret: 'PRIVATE_TEST_SECRET', passphrase: 'PRIVATE_TEST_PASSPHRASE' };
const mexcIdentity = { uid: 'opaque-MEXC:uid/with+PUNCT' };
const okxConfig = { uid: '123456789012345678901234567890', mainUid: '123456789012345678901234567890', type: '0', feeType: '0' };
const mexcFees = () => `{"data":{"makerCommission":0E-18,"takerCommission":0.000500000000000000},"code":0,"timestamp":${now}}`;
const mexcMx = () => JSON.stringify({ code: 0, data: { mxDeductEnable: false } });
const okxFees = () => ({ instType: 'SPOT', feeGroup: [{ groupId: '1', maker: '-0.000800000000000000', taker: '-0.001000000000000000' }], ts: String(now) });
const acceptIdentity = () => true;
afterEach(() => vi.useRealTimers());
function setup(venue: AccountIdentityVenue, responses?: (string | Uint8Array)[], clock = () => now) {
  const payloads = responses ?? (venue === 'mexc' ? [JSON.stringify(mexcIdentity), mexcFees(), mexcMx()] :
    [JSON.stringify({ code: '0', data: [okxConfig] }), JSON.stringify({ code: '0', data: [okxFees()] })]);
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(payloads.shift() as BodyInit));
  return { reader: new AccountFeeReader(venue, { credentials, fetch, clock }), fetch };
}

describe('fixed account-bound fee reader', () => {
  it.each(['mexc', 'okx'] as const)('authenticates %s identity before exact fee GET sequence', async venue => {
    const { reader, fetch } = setup(venue);
    const callback = vi.fn(identity => { expect(fetch).toHaveBeenCalledTimes(1); expect(Object.isFrozen(identity)).toBe(true); return true; });
    const result = await reader.getSnapshot({ acceptIdentity: callback });
    expect(callback).toHaveBeenCalledOnce();
    const sources = venue === 'mexc' ? ['/api/v3/uid', '/api/v3/tradeFee?symbol=BTCUSDT', '/api/v3/mxDeduct/enable'] :
      ['/api/v5/account/config', '/api/v5/account/trade-fee?instType=SPOT&instId=BTC-USDT'];
    expect(fetch).toHaveBeenCalledTimes(sources.length);
    for (const [index, [input, init]] of fetch.mock.calls.entries()) {
      const url = new URL(String(input));
      expect(init).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store' });
      const headers = new Headers(init!.headers);
      if (venue === 'mexc') {
        const [path, fixed = ''] = sources[index].split('?');
        const query = new URLSearchParams(fixed);
        if (index) query.set('recvWindow', '5000');
        query.set('timestamp', String(now));
        expect(url.pathname).toBe(path);
        expect(url.search.slice(1)).toBe(`${query}&signature=${createHmac('sha256', credentials.apiSecret).update(query.toString()).digest('hex')}`);
        expect(headers.get('X-MEXC-APIKEY')).toBe(credentials.apiKey);
      } else {
        const stamp = new Date(now).toISOString();
        expect(url.pathname + url.search).toBe(sources[index]);
        expect(headers.get('OK-ACCESS-SIGN')).toBe(createHmac('sha256', credentials.apiSecret).update(`${stamp}GET${sources[index]}`).digest('base64'));
        expect(headers.get('OK-ACCESS-PASSPHRASE')).toBe(credentials.passphrase);
      }
    }
    expect(result).toMatchObject({ schema: 1, venue, symbol: 'BTC/USDT', identityAccepted: true, executable: false, requestCount: sources.length });
    expect(result.fees.requestedAt).toBe(now);
    expect(result.fees.sourceUpdatedAt).toBe(String(now));
    expect(Object.isFrozen(result.fees)).toBe(true); expect(Object.isFrozen(reader)).toBe(true);
    expect(JSON.stringify(reader)).toBe('{}');
    expect(parseAccountFeeSnapshot(JSON.parse(JSON.stringify(result)))).toEqual(result);
    await expect(reader.getSnapshot({ acceptIdentity })).rejects.toThrow(/^account-reader-used$/);
    expect(fetch).toHaveBeenCalledTimes(sources.length);
  });
  it('preserves every numeric MEXC rate digit and exponent before exact normalization', async () => {
    const result = await setup('mexc').reader.getSnapshot({ acceptIdentity });
    expect(result.fees).toMatchObject({ makerRateRaw: '0E-18', takerRateRaw: '0.000500000000000000', makerCostRate: '0', takerCostRate: '0.0005' });
    expect(result.blockers).toEqual(['fee-currency-unconfirmed']);
  });
  it('preserves significant precision beyond IEEE doubles without rounding down', async () => {
    const fees = mexcFees().replace('0.000500000000000000', '0.123456789012345678901234567890');
    const result = await setup('mexc', [JSON.stringify(mexcIdentity), fees, mexcMx()]).reader.getSnapshot({ acceptIdentity });
    expect(result.fees.takerRateRaw).toBe('0.123456789012345678901234567890');
    expect(result.fees.takerCostRate).toBe('0.12345678901234567890123456789');
    expect(result.blockers).toContain('rate-precision-over-18');
  });
  it.each(['0.0005', '5e-4', '5E-4', '50e-5', '0.0005000'])('normalizes exact MEXC fee %s', async rate => {
    const fees = mexcFees().replace('0.000500000000000000', JSON.stringify(rate));
    const result = await setup('mexc', [JSON.stringify(mexcIdentity), fees, mexcMx()]).reader.getSnapshot({ acceptIdentity });
    expect(result.fees.takerCostRate).toBe('0.0005');
  });
  it('never credits a positive OKX rebate as income', async () => {
    const fees = okxFees(); fees.feeGroup[0].maker = '0.0008';
    const result = await setup('okx', [JSON.stringify({ code: '0', data: [okxConfig] }), JSON.stringify({ code: '0', data: [fees] })]).reader.getSnapshot({ acceptIdentity });
    expect(result.fees).toMatchObject({ makerRateRaw: '0.0008', makerCostRate: '0', takerCostRate: '0.001' });
    expect(result.blockers).toEqual([]);
  });
  it.each([['0', 'received-asset'], ['1', 'quote'], [undefined, 'unknown'], ['bad', 'unknown'], [null, 'unknown']])('derives OKX fee currency from feeType %s', async (feeType, mode) => {
    const result = await setup('okx', [JSON.stringify({ code: '0', data: [{ ...okxConfig, feeType }] }), JSON.stringify({ code: '0', data: [okxFees()] })]).reader.getSnapshot({ acceptIdentity });
    expect(result.configuration.feeCurrencyMode).toBe(mode);
    expect(result.blockers.includes('fee-currency-unconfirmed')).toBe(mode === 'unknown');
  });
  it('does not invent a discount or MX currency guarantee from an enabled toggle', async () => {
    const result = await setup('mexc', [JSON.stringify(mexcIdentity), mexcFees(), JSON.stringify({ code: 0, data: { mxDeductEnable: true } })]).reader.getSnapshot({ acceptIdentity });
    expect(result.fees.takerCostRate).toBe('0.0005');
    expect(result.configuration.feeCurrencyMode).toBe('unknown');
    expect(result.blockers).toEqual(['fee-currency-unconfirmed', 'mx-fee-conversion-unconfirmed']);
  });
  it.each([false, undefined, 'true', 1])('requires exact true identity acceptance (%s)', async accepted => {
    const { reader, fetch } = setup('mexc');
    await expect(reader.getSnapshot({ acceptIdentity: () => accepted as never })).rejects.toThrow(/^account-identity-mismatch$/);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('sanitizes callback failures before another request', async () => {
    const { reader, fetch } = setup('okx');
    await expect(reader.getSnapshot({ acceptIdentity: () => { throw new Error(credentials.apiSecret); } })).rejects.toThrow(/^account-identity-mismatch$/);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('copies credentials and callback before suspension', async () => {
    const mutable = { ...credentials }, responses = [JSON.stringify(mexcIdentity), mexcFees(), mexcMx()];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      expect(new Headers(init!.headers).get('X-MEXC-APIKEY')).toBe(credentials.apiKey);
      return new Response(responses.shift());
    });
    const reader = new AccountFeeReader('mexc', { credentials: mutable, fetch, clock: () => now });
    mutable.apiKey = 'MUTATED_KEY';
    const options: AccountFeeReadOptions = { acceptIdentity };
    const result = reader.getSnapshot(options);
    Object.assign(options, { acceptIdentity: () => false });
    expect((await result).identityAccepted).toBe(true);
  });
  it('has no I/O without a callback', async () => {
    const { reader, fetch } = setup('mexc');
    await expect(reader.getSnapshot({} as never)).rejects.toThrow(/^account-invalid-config$/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([1, null, '', {}, ' bad ', true])('rejects invalid MEXC UID %j before fees', async uid => {
    const { reader, fetch } = setup('mexc', [JSON.stringify({ uid })]);
    await expect(reader.getSnapshot({ acceptIdentity })).rejects.toThrow(/^account-invalid-response$/);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([{ uid: 123 }, { type: 'unknown' }, { mainUid: '222' }])('rejects invalid OKX identity %j before fees', async patch => {
    const { reader, fetch } = setup('okx', [JSON.stringify({ code: '0', data: [{ ...okxConfig, ...patch }] })]);
    await expect(reader.getSnapshot({ acceptIdentity })).rejects.toThrow(/^account-invalid-response$/);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each(['-0.1', '1.1', '1e101', '1e-101', 'NaN', 'Infinity', '01', '', ' 0.1', '0.0000000000000000000000000000001'])('rejects invalid/unsupported MEXC rate %s', async rate => {
    const fees = mexcFees().replace('0.000500000000000000', JSON.stringify(rate));
    await expect(setup('mexc', [JSON.stringify(mexcIdentity), fees, mexcMx()]).reader.getSnapshot({ acceptIdentity })).rejects.toThrow(/^account-invalid-response$/);
  });
  it.each([{ feeGroup: [] }, { feeGroup: [{ groupId: '1', maker: '-0.001', taker: '-0.002' }, { groupId: '2', maker: '-0.003', taker: '-0.004' }] }])('rejects ambiguous OKX groups with valid legacy rates', async ({ feeGroup }) => {
    const fees = { ...okxFees(), maker: '-0.001', taker: '-0.002', feeGroup };
    await expect(setup('okx', [JSON.stringify({ code: '0', data: [okxConfig] }), JSON.stringify({ code: '0', data: [fees] })]).reader.getSnapshot({ acceptIdentity })).rejects.toThrow(/^account-invalid-response$/);
  });
  it.each([{ instType: 'SWAP' }, { instId: 'ETH-USDT' }, { feeGroup: [{ groupId: 'wrong', maker: '-0.001', taker: '-0.002' }] }])('rejects wrong fee instrument/group %j', async patch => {
    await expect(setup('okx', [JSON.stringify({ code: '0', data: [okxConfig] }), JSON.stringify({ code: '0', data: [{ ...okxFees(), ...patch }] })]).reader.getSnapshot({ acceptIdentity })).rejects.toThrow(/^account-invalid-response$/);
  });
  it.each([undefined, null, ''])('preserves absent source time as a blocker (%s)', async timestamp => {
    const fees = { code: 0, data: { makerCommission: '0', takerCommission: '0.001' }, timestamp };
    const result = await setup('mexc', [JSON.stringify(mexcIdentity), JSON.stringify(fees), mexcMx()]).reader.getSnapshot({ acceptIdentity });
    expect(result.fees.sourceUpdatedAt).toBeNull(); expect(result.blockers).toContain('source-time-unavailable');
  });
  it('blocks future source time instead of using it as freshness proof', async () => {
    const result = await setup('mexc', [JSON.stringify(mexcIdentity), mexcFees().replace(String(now), String(now + 1)), mexcMx()]).reader.getSnapshot({ acceptIdentity });
    expect(result.blockers).toContain('source-time-in-future');
  });
  it.each([60_000, 60_001])('assesses data-return timestamp freshness at %sms boundary', async age => {
    const fees = { ...okxFees(), ts: String(now - age) };
    const result = await setup('okx', [JSON.stringify({ code: '0', data: [okxConfig] }), JSON.stringify({ code: '0', data: [fees] })]).reader.getSnapshot({ acceptIdentity });
    expect(result.fees.receivedAt).toBe(now);
    expect(result.blockers.includes('source-time-stale')).toBe(age > 60_000);
  });
  it('blocks stale MEXC data-return timestamp even with a fresh HTTP response', async () => {
    const result = await setup('mexc', [JSON.stringify(mexcIdentity), mexcFees().replace(String(now), String(now - 60_001)), mexcMx()]).reader.getSnapshot({ acceptIdentity });
    expect(result.blockers).toContain('source-time-stale');
  });
  it.each([418, 429])('preserves HTTP %s as a fixed rate-limit error without retry', async status => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(credentials.apiSecret, { status }));
    const reader = new AccountFeeReader('mexc', { credentials, fetch, clock: () => now });
    await expect(reader.getSnapshot({ acceptIdentity })).rejects.toThrow(/^account-rate-limited$/);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([['mexc', { code: 429 }], ['okx', { code: '50011' }], ['okx', { code: '50013' }], ['okx', { code: '50040' }]] as const)('preserves known API cooldown %s/%j', async (venue, payload) => {
    await expect(setup(venue, [JSON.stringify(payload)]).reader.getSnapshot({ acceptIdentity })).rejects.toThrow(/^account-rate-limited$/);
  });
  it('preserves a late HTTP rejection when the capture clock expires', async () => {
    let at = now;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      at = now + 30_001;
      return new Response('private body', { status: 429, headers: { 'Retry-After': new Date(now + 90_000).toUTCString() } });
    });
    await expect(new AccountFeeReader('mexc', { credentials, fetch, clock: () => at }).getSnapshot({ acceptIdentity })).rejects.toThrow(/^account-rate-limited$/);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('stops after malformed rates without querying MX settings', async () => {
    const { reader, fetch } = setup('mexc', [JSON.stringify(mexcIdentity), mexcFees().replace('0E-18', '-1')]);
    await expect(reader.getSnapshot({ acceptIdentity })).rejects.toThrow(/^account-invalid-response$/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('sanitizes fetch failures', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => { throw new Error(credentials.apiSecret); });
    await expect(new AccountFeeReader('mexc', { credentials, fetch, clock: () => now }).getSnapshot({ acceptIdentity })).rejects.toThrow(/^account-unavailable$/);
  });
  it('rejects credential echoes before exposing a DTO', async () => {
    await expect(setup('mexc', [JSON.stringify({ uid: credentials.apiSecret })]).reader.getSnapshot({ acceptIdentity })).rejects.toThrow(/^account-invalid-response$/);
  });
  it('rejects clock regression between identity and fee requests', async () => {
    let at = now;
    const { reader, fetch } = setup('mexc', undefined, () => at);
    await expect(reader.getSnapshot({ acceptIdentity: () => { at--; return true; } })).rejects.toThrow(/^account-invalid-clock$/);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('expires a suspended identity check and cannot continue afterward', async () => {
    vi.useFakeTimers();
    let resolve!: (value: boolean) => void;
    const { reader, fetch } = setup('mexc');
    const result = reader.getSnapshot({ acceptIdentity: () => new Promise(done => { resolve = done; }) });
    const rejected = expect(result).rejects.toThrow(/^account-timeout$/);
    await vi.advanceTimersByTimeAsync(30_001); await rejected;
    resolve(true); await vi.runAllTimersAsync();
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe('strict fee transport and archive parser', () => {
  it.each(['{"uid":"a","uid":"b"}', '{"uid":"a","u\\u0069d":"b"}', '{"uid":"a","nested":{"x":1,"x":2}}', '{"uid":"a",}', '{"uid":"a","n":NaN}', '{"uid":"a","n":01}'])('rejects duplicate keys and invalid JSON: %s', async body => {
    await expect(setup('mexc', [body]).reader.getSnapshot({ acceptIdentity })).rejects.toThrow(/^account-invalid-response$/);
  });
  it('rejects invalid UTF-8 rather than replacing account identifier bytes', async () => {
    const body = Buffer.concat([Buffer.from('{"uid":"'), Buffer.from([0xff]), Buffer.from('"}')]);
    await expect(setup('mexc', [body]).reader.getSnapshot({ acceptIdentity })).rejects.toThrow(/^account-invalid-response$/);
  });
  it('bounds JSON nesting', async () => {
    const body = '{"uid":"a","extra":' + '['.repeat(40) + '0' + ']'.repeat(40) + '}';
    await expect(setup('mexc', [body]).reader.getSnapshot({ acceptIdentity })).rejects.toThrow(/^account-invalid-response$/);
  });
  it('accepts whitespace, arrays, null, booleans, escaped strings and prototype keys safely', async () => {
    const uid = 'uid"\\escaped';
    const identity = '{ "uid":' + JSON.stringify(uid) + ',"__proto__":{"x":0}, "extra": [ true, false, null, -1e-2 ] }';
    const result = await setup('mexc', [identity, mexcFees(), mexcMx()]).reader.getSnapshot({ acceptIdentity });
    expect(result.identity.uid).toBe(uid); expect(({} as { x?: number }).x).toBeUndefined();
  });
  it.each([
    'https://www.okx.com/api/v5/account/balance',
    'https://www.okx.com/api/v5/trade/order?instId=BTC-USDT&ordId=1',
    'https://www.okx.com/api/v5/account/trade-fee?instType=SPOT&instId=ETH-USDT',
    'https://www.okx.com/api/v5/account/trade-fee?instType=SPOT&instId=BTC-USDT&instId=BTC-USDT',
    'https://www.okx.com/api/v5/account/config?',
    'https://api.mexc.com/api/v3/account',
    'https://api.mexc.com/api/v3/order',
    'https://evil.test/api/v5/account/config',
  ])('refuses unscoped route before fetch %s', async url => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(new AccountTransport({ credentials, fetch, clock: () => now }, 'account-fees').request(url, {})).rejects.toThrow(/^account-unsupported-endpoint$/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    (x: any) => { x.fees.makerCostRate = '0'; },
    (x: any) => { x.fees.takerCostRate = '0.1'; },
    (x: any) => { x.configuration.feeCurrencyMode = 'quote'; },
    (x: any) => { x.blockers = ['fee-currency-unconfirmed']; },
    (x: any) => { x.identity.mainAccountConfirmed = false; },
    (x: any) => { x.identity.mainUid = '999'; },
    (x: any) => { x.fees.requestedAt = now - 1; },
    (x: any) => { x.fees.receivedAt = now + 30_001; },
    (x: any) => { x.executable = true; },
    (x: any) => { x.extra = 'forged'; },
  ])('rejects forged derived fields or timing', async mutate => {
    const result = JSON.parse(JSON.stringify(await setup('okx').reader.getSnapshot({ acceptIdentity })));
    mutate(result);
    expect(() => parseAccountFeeSnapshot(result)).toThrow(/^account-invalid-response$/);
  });
});
