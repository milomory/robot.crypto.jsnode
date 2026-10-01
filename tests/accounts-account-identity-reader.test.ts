import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountIdentityReader, type AccountIdentityVenue } from '../src/accounts/account-identity-reader.js';
import { AccountTransport } from '../src/accounts/transport.js';

const credentials = { apiKey: 'PRIVATE_TEST_KEY', apiSecret: 'PRIVATE_TEST_SECRET', passphrase: 'PRIVATE_TEST_PASSPHRASE' };
const now = 1_800_000_000_000;
const identity = '123456789012345678901234567890', parentIdentity = '123456789012345678901234567891';
const okxMain = { uid: identity, mainUid: identity, type: '0' };
const mexcUrl = `https://api.mexc.com/api/v3/uid?timestamp=${now}&signature=${'a'.repeat(64)}`;
const okxUrl = 'https://www.okx.com/api/v5/account/config';
afterEach(() => vi.useRealTimers());
function setup(venue: AccountIdentityVenue, payload: unknown, clock = () => now) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(venue === 'okx' ? { code: '0', data: payload } : payload));
  return { reader: new AccountIdentityReader(venue, { credentials, fetch, clock }), fetch };
}

describe('private account identity reader', () => {
  it('signs only the documented MEXC timestamp and returns no invented main-account status', async () => {
    const { reader, fetch } = setup('mexc', { uid: identity, mainUid: identity, type: '0', mainAccountConfirmed: true,
      apiKey: 'PRIVATE_UPSTREAM_KEY', label: 'PRIVATE_LABEL', permissions: ['TRADE', 'WITHDRAW'] });
    const read = await reader.getIdentity();
    const unsigned = `timestamp=${now}`;
    const signature = createHmac('sha256', credentials.apiSecret).update(unsigned).digest('hex');
    expect(fetch).toHaveBeenCalledExactlyOnceWith(`https://api.mexc.com/api/v3/uid?${unsigned}&signature=${signature}`,
      expect.objectContaining({ method: 'GET', headers: { 'X-MEXC-APIKEY': credentials.apiKey },
        redirect: 'error', credentials: 'omit', cache: 'no-store' }));
    expect(read).toEqual({ venue: 'mexc', uid: identity, mainUid: null, accountType: null, mainAccountConfirmed: false,
      mainAccountEvidence: 'not-reported', source: '/api/v3/uid', requestedAt: now, receivedAt: now });
    expect(Object.isFrozen(read)).toBe(true); expect(Object.isFrozen(reader)).toBe(true);
    expect(JSON.stringify(reader)).toBe('{}');
    expect(JSON.stringify(read)).not.toMatch(/PRIVATE|permission|signature|apiKey/);
    expect(read).not.toHaveProperty('accountIdentityVerified'); expect(read).not.toHaveProperty('approvedUid');
  });
  it('signs exact OKX path with no query and verifies both account identifiers and type', async () => {
    const { reader, fetch } = setup('okx', [{ ...okxMain, label: 'PRIVATE_LABEL', ip: 'PRIVATE_IP',
      apiKey: 'PRIVATE_KEY', perm: 'read_only,trade,withdraw', acctLv: '1' }]);
    const read = await reader.getIdentity(), stamp = new Date(now).toISOString();
    const signature = createHmac('sha256', credentials.apiSecret).update(`${stamp}GET/api/v5/account/config`).digest('base64');
    expect(fetch).toHaveBeenCalledExactlyOnceWith(okxUrl, expect.objectContaining({ method: 'GET', headers: {
      'OK-ACCESS-KEY': credentials.apiKey, 'OK-ACCESS-SIGN': signature, 'OK-ACCESS-TIMESTAMP': stamp,
      'OK-ACCESS-PASSPHRASE': credentials.passphrase, 'Content-Type': 'application/json',
    }, redirect: 'error', credentials: 'omit', cache: 'no-store' }));
    expect(read).toEqual({ venue: 'okx', uid: identity, mainUid: identity, accountType: '0', mainAccountConfirmed: true,
      mainAccountEvidence: 'uid-mainUid-and-account-type', source: '/api/v5/account/config', requestedAt: now, receivedAt: now });
    expect(Object.isFrozen(read)).toBe(true); expect(JSON.stringify(read)).not.toMatch(/PRIVATE|perm|acctLv/);
    expect(read).not.toHaveProperty('accountIdentityVerified'); expect(read).not.toHaveProperty('approvedUid');
  });
  it.each(['1', '2', '5', '9', '12'])('keeps documented OKX subaccount type %s distinct from main', async type => {
    const { reader } = setup('okx', [{ uid: identity, mainUid: parentIdentity, type }]);
    expect(await reader.getIdentity()).toMatchObject({ uid: identity, mainUid: parentIdentity, accountType: type,
      mainAccountConfirmed: false, mainAccountEvidence: 'uid-mainUid-and-account-type' });
  });
  it.each(['mexc', 'okx'] as const)('copies credentials and prevents runtime venue replacement on %s', async venue => {
    const mutable = { ...credentials };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(venue === 'mexc' ? { uid: identity } : { code: '0', data: [okxMain] }));
    const reader = new AccountIdentityReader(venue, { credentials: mutable, fetch, clock: () => now });
    mutable.apiKey = 'OTHER_KEY'; mutable.apiSecret = 'OTHER_SECRET'; mutable.passphrase = 'OTHER_PASSPHRASE';
    expect(Reflect.set(reader, 'venue', venue === 'mexc' ? 'okx' : 'mexc')).toBe(false);
    expect(() => Object.defineProperty(reader, 'venue', { value: venue === 'mexc' ? 'okx' : 'mexc' })).toThrow(TypeError);
    const read = await reader.getIdentity();
    expect(reader.venue).toBe(venue); expect(read.venue).toBe(venue);
    const [target, options] = fetch.mock.calls[0], url = new URL(String(target));
    const headers = new Headers(options!.headers);
    if (venue === 'mexc') {
      expect(url.origin).toBe('https://api.mexc.com');
      expect(headers.get('X-MEXC-APIKEY')).toBe(credentials.apiKey); expect(headers.has('OK-ACCESS-KEY')).toBe(false);
      expect(url.searchParams.get('signature')).toBe(createHmac('sha256', credentials.apiSecret).update(`timestamp=${now}`).digest('hex'));
    } else {
      expect(url.origin).toBe('https://www.okx.com');
      expect(headers.get('OK-ACCESS-KEY')).toBe(credentials.apiKey); expect(headers.has('X-MEXC-APIKEY')).toBe(false);
      expect(headers.get('OK-ACCESS-PASSPHRASE')).toBe(credentials.passphrase);
      expect(headers.get('OK-ACCESS-SIGN')).toBe(createHmac('sha256', credentials.apiSecret)
        .update(`${new Date(now).toISOString()}GET/api/v5/account/config`).digest('base64'));
    }
  });
  it.each(['mexc', 'okx'] as const)('does not make the first %s observation an approved identity baseline', async venue => {
    let currentIdentity = identity;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(venue === 'mexc' ? { uid: currentIdentity } :
      { code: '0', data: [{ uid: currentIdentity, mainUid: currentIdentity, type: '0' }] }));
    const reader = new AccountIdentityReader(venue, { credentials, fetch, clock: () => now });
    const first = await reader.getIdentity(); currentIdentity = parentIdentity;
    const second = await reader.getIdentity();
    expect(first.uid).toBe(identity); expect(second.uid).toBe(parentIdentity);
    expect(first).not.toHaveProperty('bindingVerified'); expect(second).not.toHaveProperty('bindingVerified');
  });
  it('rejects missing passphrase, bad credentials and unsupported venue before I/O', () => {
    const fetch = vi.fn();
    for (const options of [undefined, {}, { credentials: {} }, { credentials: { ...credentials, passphrase: '' } },
      { credentials: { ...credentials, apiKey: 'PRIVATE\r\nHEADER' } }]) {
      expect(() => new AccountIdentityReader('okx', { ...options, fetch } as never)).toThrow(/^account-invalid-config$/);
    }
    expect(() => new AccountIdentityReader('bybit' as never, { credentials, fetch })).toThrow(/^account-invalid-config$/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('account identity projection fails closed', () => {
  it.each([undefined, null, 123, 9007199254740992, '', ' ', '1\n', '\tuid', 'uid\r', 'uid\x00', 'uid\x7f', 'méxc', 'uid\u00a0', '1'.repeat(257)])
    ('rejects malformed UID without coercion or echo: case %#', async uid => {
      for (const venue of ['mexc', 'okx'] as const) {
        const { reader } = setup(venue, venue === 'mexc' ? { uid } : [{ uid, mainUid: identity, type: '1' }]);
        await expect(reader.getIdentity()).rejects.toThrow(/^account-invalid-response$/);
      }
    });
  it.each(['0', '01', '-1', '1.0', '1e8', 'PRIVATE_ID', '1'.repeat(65)])
    ('retains the existing OKX-only decimal decoder restriction: case %#', async uid => {
      await expect(setup('okx', [{ uid, mainUid: identity, type: '1' }]).reader.getIdentity()).rejects.toThrow(/^account-invalid-response$/);
    });
  it.each(['5c85987e-fef9-4b82-b9cd-bbb9a67599a9', 'aB0f91dE22446688', '0000912', '0', '1e8',
    'opaque:UID/with+PUNCT._~-', 'uid"with\\slash', 'x'.repeat(256)])
    ('preserves MEXC opaque visible-ASCII UID exactly without normalization: case %#', async uid => {
      const { reader, fetch } = setup('mexc', { uid });
      expect(await reader.getIdentity()).toMatchObject({ uid, mainUid: null, mainAccountConfirmed: false });
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  it('preserves all digits of a bounded 64-digit ID instead of converting it to a number', async () => {
    const uid = '9'.repeat(64);
    for (const venue of ['mexc', 'okx'] as const) {
      const { reader } = setup(venue, venue === 'mexc' ? { uid } : [{ uid, mainUid: uid, type: '0' }]);
      expect((await reader.getIdentity()).uid).toBe(uid);
    }
  });
  it.each([
    {}, [], [okxMain, okxMain], [null], [{ ...okxMain, uid: undefined }], [{ ...okxMain, mainUid: undefined }],
    [{ ...okxMain, mainUid: 123 }], [{ ...okxMain, mainUid: 'PRIVATE' }], [{ ...okxMain, type: undefined }],
    [{ ...okxMain, type: 0 }], [{ ...okxMain, type: '3' }], [{ ...okxMain, type: '13' }],
    [{ ...okxMain, mainUid: parentIdentity }], [{ ...okxMain, type: '1' }], [{ ...okxMain, type: '12' }],
  ].map(payload => ({ payload })))('rejects missing, multiple or contradictory OKX identities: case %#', async ({ payload }) => {
    await expect(setup('okx', payload).reader.getIdentity()).rejects.toThrow(/^account-invalid-response$/);
  });
  it.each([null, [], [{ uid: identity }], { accountId: identity }, { data: { uid: identity } }].map(payload => ({ payload })))
    ('requires the documented MEXC root UID shape: case %#', async ({ payload }) => {
      await expect(setup('mexc', payload).reader.getIdentity()).rejects.toThrow(/^account-invalid-response$/);
    });
  it.each([null, [], {}, { code: '0' }, { data: [okxMain] }, { code: '0', data: okxMain }].map(payload => ({ payload })))
    ('requires the OKX envelope and single-row array: case %#', async ({ payload }) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(payload));
      await expect(new AccountIdentityReader('okx', { credentials, fetch, clock: () => now }).getIdentity()).rejects.toThrow(/^account-invalid-response$/);
    });
});

describe('identity failures remain private and bounded', () => {
  it.each([['mexc', { code: -2015, msg: 'PRIVATE_SECRET' }], ['okx', { code: '50113', data: [], msg: 'PRIVATE_SECRET' }],
    ['okx', { code: 0, data: [okxMain], msg: 'PRIVATE_SECRET' }]] as const)
    ('uses a fixed %s application rejection with no automatic retry', async (venue, payload) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(payload));
      const reader = new AccountIdentityReader(venue, { credentials, fetch, clock: () => now });
      await expect(reader.getIdentity()).rejects.toThrow(/^account-api-rejected$/); expect(fetch).toHaveBeenCalledTimes(1);
    });
  it.each([['mexc', 418], ['mexc', 429], ['okx', '50011'], ['okx', '50013'], ['okx', '50040']] as const)
    ('holds %s application rate-limit cooldown without network retries: %s', async (venue, code) => {
      let clock = now;
      const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ code, data: [], msg: 'PRIVATE' }));
      const reader = new AccountIdentityReader(venue, { credentials, fetch, clock: () => clock });
      await expect(reader.getIdentity()).rejects.toThrow(/^account-rate-limited$/);
      clock += 59_999;
      await expect(reader.getIdentity()).rejects.toThrow(/^account-rate-limited$/); expect(fetch).toHaveBeenCalledTimes(1);
    });
  it.each(['mexc', 'okx'] as const)('keeps longer HTTP Retry-After for %s and sends nothing during cooldown', async venue => {
    let clock = now;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('PRIVATE', { status: 429, headers: { 'Retry-After': '120' } }));
    const reader = new AccountIdentityReader(venue, { credentials, fetch, clock: () => clock });
    await expect(reader.getIdentity()).rejects.toThrow(/^account-rate-limited$/);
    clock += 119_999;
    await expect(reader.getIdentity()).rejects.toThrow(/^account-rate-limited$/); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([['mexc', 401, 'account-auth-failed'], ['mexc', 403, 'account-access-denied'], ['okx', 403, 'account-auth-failed'],
    ['mexc', 404, 'account-api-rejected'], ['okx', 500, 'account-api-rejected'], ['okx', 302, 'account-api-rejected']] as const)
    ('redacts HTTP %s/%s response text', async (venue, status, code) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('PRIVATE_HEADER_COOKIE_KEY_UID', { status }));
      const reader = new AccountIdentityReader(venue, { credentials, fetch, clock: () => now });
      const error = await reader.getIdentity().catch(error => error);
      expect(error).toMatchObject({ code, reason: code, message: code }); expect(String(error)).not.toContain('PRIVATE');
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  it('redacts TLS/network errors and never installs a certificate bypass', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => { throw new Error('certificate verification PRIVATE_SIGNED_URL'); });
    const reader = new AccountIdentityReader('mexc', { credentials, fetch, clock: () => now });
    await expect(reader.getIdentity()).rejects.toThrow(/^account-unavailable$/);
    const options = fetch.mock.calls[0][1];
    expect(options).not.toHaveProperty('dispatcher'); expect(options).not.toHaveProperty('agent');
    expect(options).not.toHaveProperty('rejectUnauthorized');
  });
  it('bounds the entire stalled response and rejects overlap instead of queuing signed reads', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(new ReadableStream({ start() {} })));
    const reader = new AccountIdentityReader('okx', { credentials, fetch, clock: () => now });
    const pending = expect(reader.getIdentity()).rejects.toThrow(/^account-timeout$/);
    await expect(reader.getIdentity()).rejects.toThrow(/^account-busy$/);
    await vi.advanceTimersByTimeAsync(5001); await pending;
    expect(fetch).toHaveBeenCalledTimes(1); expect(fetch.mock.calls[0][1]!.signal!.aborted).toBe(true);
  });
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 8_640_000_000_000_001])('rejects invalid request clocks before HTTP: %s', async clock => {
    const { reader, fetch } = setup('okx', [okxMain], () => clock);
    await expect(reader.getIdentity()).rejects.toThrow(/^account-invalid-clock$/); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['mexc', 'okx'] as const)('records receipt time and rejects a backward %s clock', async venue => {
    let clock = now;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => { clock--; return Response.json(venue === 'mexc' ? { uid: identity } : { code: '0', data: [okxMain] }); });
    const reader = new AccountIdentityReader(venue, { credentials, fetch, clock: () => clock });
    await expect(reader.getIdentity()).rejects.toThrow(/^account-invalid-clock$/);
    fetch.mockImplementation(async () => { clock += 10; return Response.json(venue === 'mexc' ? { uid: identity } : { code: '0', data: [okxMain] }); });
    expect(await reader.getIdentity()).toMatchObject({ requestedAt: now - 1, receivedAt: now + 9 });
  });
});

describe('separate account-identity transport scope', () => {
  it.each([mexcUrl, okxUrl])('permits its one fixed venue endpoint with GET/TLS/no redirect only', async target => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({}));
    await new AccountTransport({ credentials, fetch, clock: () => now }, 'account-identity').request(target, {});
    expect(fetch).toHaveBeenCalledExactlyOnceWith(target, expect.objectContaining({ method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store' }));
    expect(fetch.mock.calls[0][1]).not.toHaveProperty('body');
  });
  it.each([
    mexcUrl + '&recvWindow=5000', mexcUrl + '&timestamp=' + now, mexcUrl + '&signature=' + 'a'.repeat(64),
    mexcUrl + '&uid=123', mexcUrl + '&accessKey=PRIVATE', mexcUrl + '&symbol=BTCUSDT', mexcUrl + '&',
    mexcUrl.replace(String(now), '0'), mexcUrl.replace(String(now), '01'), mexcUrl.replace(String(now), '9007199254740992'),
    mexcUrl.replace('timestamp=', 'time='), mexcUrl.replace('timestamp=', '%74imestamp='),
    mexcUrl.replace('a'.repeat(64), 'A'.repeat(64)), mexcUrl.replace('a'.repeat(64), 'a'.repeat(63)),
    mexcUrl.replace('/uid?', '/account?'), mexcUrl.replace('/uid?', '/apiKeyInfo?'),
    mexcUrl.replace('/uid?', '/order?'), mexcUrl.replace('/uid?', '/capital/withdraw/apply?'),
    mexcUrl.replace('api.mexc.com', 'gateway-cli.mexc.com'), mexcUrl.replace('api.mexc.com', 'www.okx.com'),
    mexcUrl.replace('https:', 'http:'), mexcUrl.replace('api.mexc.com', 'api.mexc.com.evil.invalid'),
    mexcUrl.replace('api.mexc.com', 'user:PRIVATE@api.mexc.com'), mexcUrl + '#PRIVATE',
    mexcUrl.replace('api.mexc.com', 'api.mexc.com:443'), mexcUrl.replace('/api/v3/uid', '/api/v3/other/../uid'),
    okxUrl + '?', okxUrl + '?uid=123', okxUrl + '?type=0', okxUrl + '?ccy=USDT',
    okxUrl + '?timestamp=' + now, okxUrl + '/', okxUrl.replace('/config', '/balance'),
    okxUrl.replace('/account/config', '/trade/order'), okxUrl.replace('/account/config', '/asset/withdrawal'),
    okxUrl.replace('www.okx.com', 'my.okx.com'), okxUrl.replace('www.okx.com', 'api.mexc.com'),
  ])('rejects route/query expansion or ambiguous encoding before I/O: case %#', async target => {
    const fetch = vi.fn();
    await expect(new AccountTransport({ credentials, fetch, clock: () => now }, 'account-identity').request(target, {}))
      .rejects.toThrow(/^account-unsupported-endpoint$/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not add identity endpoints to existing recovery or historical scopes', async () => {
    const fetch = vi.fn();
    for (const scope of ['order-recovery', 'execution-history'] as const) {
      for (const target of [mexcUrl, okxUrl]) {
        await expect(new AccountTransport({ credentials, fetch, clock: () => now }, scope).request(target, {}))
          .rejects.toThrow(/^account-unsupported-endpoint$/);
      }
    }
    await expect(new AccountTransport({ credentials, fetch, clock: () => now }).request(mexcUrl, {}))
      .rejects.toThrow(/^account-unsupported-endpoint$/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
