import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OkxCapacityReader, parseOkxCapacitySnapshot, getCapacityFailureDiagnostic } from '../src/accounts/okx-capacity-reader.js';
import { AccountTransport } from '../src/accounts/transport.js';
import type { AccountIdentityRead } from '../src/accounts/account-identity-reader.js';

const now = 1_800_000_000_000;
const credentials = { apiKey: 'CAPACITY_TEST_KEY', apiSecret: 'CAPACITY_TEST_SECRET', passphrase: 'CAPACITY_TEST_PASSPHRASE' };
const origin = 'https://www.okx.com';
const configSource = '/api/v5/account/config';
const capacitySource = '/api/v5/account/max-avail-size?instId=BTC-USDT&tdMode=cash&tradeQuoteCcy=USDT';
const baselineBlockers = ['source-time-unavailable', 'capacity-not-reserved', 'fee-inclusion-unconfirmed', 'separate-funds-evidence-required'];
const configuration = () => ({ uid: '123456789012345678901234567890', mainUid: '123456789012345678901234567890',
  type: '0', acctLv: '1', autoLoan: false, enableSpotBorrow: false, spotBorrowAutoRepay: false, feeType: '0' });
const capacity = () => ({ instId: 'BTC-USDT', availBuy: '100.123456789012345678901234567890', availSell: '0.123456789012345678901234567890' });
const envelope = (row: unknown) => JSON.stringify({ code: '0', data: [row] });
const acceptIdentity = () => true;
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function setup(responses: (string | Uint8Array)[] = [envelope(configuration()), envelope(capacity()), envelope(configuration())], clock = () => now) {
  const queue = [...responses];
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(queue.shift() as BodyInit));
  return { fetch, reader: new OkxCapacityReader({ credentials, fetch, clock }) };
}
afterEach(() => vi.useRealTimers());

describe('OKX cash capacity observation', () => {
  it('brackets the cash read with two accepted main-account configurations and signs exactly three GETs', async () => {
    const { reader, fetch } = setup();
    const checkpoints: number[] = [];
    const accept = vi.fn((identity: AccountIdentityRead) => {
      checkpoints.push(fetch.mock.calls.length);
      expect(Object.isFrozen(identity)).toBe(true);
      expect(identity).toMatchObject({ venue: 'okx', uid: configuration().uid, mainUid: configuration().mainUid,
        accountType: '0', mainAccountConfirmed: true, source: configSource });
      return true;
    });
    const result = await reader.getSnapshot({ acceptIdentity: accept });
    expect(checkpoints).toEqual([1, 3]);
    expect(fetch).toHaveBeenCalledTimes(3);
    const stamp = new Date(now).toISOString();
    for (const [index, [url, init]] of fetch.mock.calls.entries()) {
      const source = [configSource, capacitySource, configSource][index];
      expect(String(url)).toBe(origin + source);
      expect(init).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store' });
      expect(init?.body).toBeUndefined();
      const headers = new Headers(init?.headers);
      expect(headers.get('OK-ACCESS-SIGN')).toBe(createHmac('sha256', credentials.apiSecret).update(`${stamp}GET${source}`).digest('base64'));
      expect(headers.get('OK-ACCESS-KEY')).toBe(credentials.apiKey);
      expect(headers.get('OK-ACCESS-PASSPHRASE')).toBe(credentials.passphrase);
      expect(headers.get('x-simulated-trading')).toBeNull();
    }
    expect(result).toMatchObject({ schema: 1, venue: 'okx', environment: 'mainnet', origin, symbol: 'BTC/USDT',
      requestCount: 3, identityAccepted: true, configurationStable: true, executable: false,
      capacity: { source: capacitySource, requestedAt: now, receivedAt: now, sourceUpdatedAt: null,
        buyQuoteAvailable: capacity().availBuy, sellBaseAvailable: capacity().availSell, buyUnit: 'USDT', sellUnit: 'BTC' } });
    expect(result.blockers).toEqual(baselineBlockers);
    expect(result.before.configuration).toEqual(result.after.configuration);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.capacity)).toBe(true);
    expect(Object.isFrozen(result.before.configuration.unavailableFields)).toBe(true);
    expect(Object.isFrozen(reader)).toBe(true);
    expect(JSON.stringify(reader)).toBe('{}');
    expect(parseOkxCapacitySnapshot(plain(result))).toEqual(result);
    for (const secret of Object.values(credentials)) expect(JSON.stringify(result)).not.toContain(secret);
    await expect(reader.getSnapshot({ acceptIdentity })).rejects.toThrow(/^account-reader-used$/);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('records different receipt times without requiring identical bracketing timestamps', async () => {
    let at = now;
    const { reader } = setup(undefined, () => at++);
    const result = await reader.getSnapshot({ acceptIdentity });
    expect(result.before.identity.receivedAt).toBeLessThanOrEqual(result.capacity.requestedAt);
    expect(result.capacity.receivedAt).toBeLessThanOrEqual(result.after.identity.requestedAt);
    expect(result.before.identity.requestedAt).toBeLessThan(result.after.identity.requestedAt);
    expect(parseOkxCapacitySnapshot(plain(result))).toEqual(result);
  });

  it('retains zero capacity as an observation and never substitutes wallet equity', async () => {
    const result = await setup([envelope(configuration()), envelope({ instId: 'BTC-USDT', availBuy: '0', availSell: '0', eq: '1000000' }), envelope(configuration())])
      .reader.getSnapshot({ acceptIdentity });
    expect(result.capacity).toMatchObject({ buyQuoteAvailable: '0', sellBaseAvailable: '0' });
    expect(result.blockers).toEqual(baselineBlockers);
    expect(result.executable).toBe(false);
    expect(result.capacity).not.toHaveProperty('eq');
  });

  it.each(['2', '3', '4'])('keeps account mode %s observed but explicitly blocked', async acctLv => {
    const config = { ...configuration(), acctLv };
    const result = await setup([envelope(config), envelope(capacity()), envelope(config)]).reader.getSnapshot({ acceptIdentity });
    expect(result.before.configuration.accountMode).toBe(acctLv);
    expect(result.blockers).toEqual(expect.arrayContaining(baselineBlockers));
    expect(result.blockers.length).toBeGreaterThan(baselineBlockers.length);
    expect(result.executable).toBe(false);
  });

  it.each(['autoLoan', 'enableSpotBorrow', 'spotBorrowAutoRepay'] as const)('does not turn enabled %s into a cash authorization', async field => {
    const config = { ...configuration(), [field]: true };
    const result = await setup([envelope(config), envelope(capacity()), envelope(config)]).reader.getSnapshot({ acceptIdentity });
    expect(result.before.configuration[field]).toBe(true);
    expect(result.blockers.length).toBeGreaterThan(baselineBlockers.length);
    expect(result.executable).toBe(false);
  });

  it.each([
    ['acctLv', 'accountMode'], ['autoLoan', 'autoLoan'], ['enableSpotBorrow', 'enableSpotBorrow'],
    ['spotBorrowAutoRepay', 'spotBorrowAutoRepay'], ['feeType', 'feeType'],
  ] as const)('preserves missing/null/empty provenance for %s', async (upstream, projected) => {
    for (const [value, missingKind] of [[undefined, 'missing'], [null, 'null'], ['', 'empty']] as const) {
      const config = { ...configuration(), [upstream]: value };
      const result = await setup([envelope(config), envelope(capacity()), envelope(config)]).reader.getSnapshot({ acceptIdentity });
      expect(result.before.configuration[projected]).toBeNull();
      expect(result.before.configuration.unavailableFields).toEqual({ [projected]: missingKind });
      expect(result.after.configuration).toEqual(result.before.configuration);
      expect(result.blockers.length).toBeGreaterThan(baselineBlockers.length);
      expect(parseOkxCapacitySnapshot(plain(result))).toEqual(result);
    }
  });

  it.each([
    { acctLv: '5' }, { acctLv: 1 }, { feeType: '2' }, { feeType: 0 },
    { autoLoan: 'false' }, { enableSpotBorrow: 0 }, { spotBorrowAutoRepay: 'true' },
  ])('rejects unknown or wrongly typed configuration before capacity: %j', async patch => {
    const { reader, fetch } = setup([envelope({ ...configuration(), ...patch })]);
    await expect(reader.getSnapshot({ acceptIdentity })).rejects.toThrow(/^account-invalid-response$/);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([{ uid: 123 }, { uid: '0', mainUid: '0' }, { mainUid: '111' }, { type: '1', mainUid: '111' }, { type: '9' }])
  ('refuses non-main or invalid identity before capacity: %j', async patch => {
    const { reader, fetch } = setup([envelope({ ...configuration(), ...patch })]);
    await expect(reader.getSnapshot({ acceptIdentity })).rejects.toThrow(/^account-invalid-response$/);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    { acctLv: '2' }, { autoLoan: true }, { enableSpotBorrow: true }, { spotBorrowAutoRepay: true }, { feeType: '1' },
    { uid: '222', mainUid: '222' }, { autoLoan: undefined },
  ])('rejects changed identity or configuration even when both identity callbacks accept: %j', async patch => {
    const { reader, fetch } = setup([envelope(configuration()), envelope(capacity()), envelope({ ...configuration(), ...patch })]);
    await expect(reader.getSnapshot({ acceptIdentity })).rejects.toThrow(/^account-invalid-response$/);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('treats different unavailable provenance as a configuration change', async () => {
    const { reader } = setup([envelope({ ...configuration(), feeType: undefined }), envelope(capacity()), envelope({ ...configuration(), feeType: null })]);
    await expect(reader.getSnapshot({ acceptIdentity })).rejects.toThrow(/^account-invalid-response$/);
  });

  it.each([false, undefined, 'true', 1])('requires exact true before capacity (%s)', async accepted => {
    const { reader, fetch } = setup();
    await expect(reader.getSnapshot({ acceptIdentity: () => accepted as never })).rejects.toThrow(/^account-identity-mismatch$/);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('rechecks acceptance after the last configuration read', async () => {
    const { reader, fetch } = setup();
    let called = 0;
    await expect(reader.getSnapshot({ acceptIdentity: () => ++called === 1 })).rejects.toThrow(/^account-identity-mismatch$/);
    expect(called).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([1, 2])('sanitizes a failure in identity acceptance #%i', async failureAt => {
    const { reader, fetch } = setup();
    let called = 0;
    await expect(reader.getSnapshot({ acceptIdentity: () => {
      if (++called === failureAt) throw new Error(credentials.apiSecret);
      return true;
    } })).rejects.toThrow(/^account-identity-mismatch$/);
    expect(fetch).toHaveBeenCalledTimes(failureAt === 1 ? 1 : 3);
  });

  it('does not issue I/O without an identity policy', async () => {
    const { reader, fetch } = setup();
    await expect(reader.getSnapshot({} as never)).rejects.toThrow(/^account-invalid-config$/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('copies credentials and the acceptance callback before the first suspension', async () => {
    const mutable = { ...credentials };
    const bodies = [envelope(configuration()), envelope(capacity()), envelope(configuration())];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      expect(new Headers(init?.headers).get('OK-ACCESS-KEY')).toBe(credentials.apiKey);
      expect(new Headers(init?.headers).get('OK-ACCESS-PASSPHRASE')).toBe(credentials.passphrase);
      return new Response(bodies.shift());
    });
    const reader = new OkxCapacityReader({ credentials: mutable, fetch, clock: () => now });
    mutable.apiKey = 'REPLACED'; mutable.passphrase = 'REPLACED'; mutable.apiSecret = 'REPLACED';
    const options = { acceptIdentity };
    const pending = reader.getSnapshot(options);
    options.acceptIdentity = () => false;
    expect((await pending).identityAccepted).toBe(true);
    const signature = new Headers(fetch.mock.calls[1][1]?.headers).get('OK-ACCESS-SIGN');
    expect(signature).toBe(createHmac('sha256', credentials.apiSecret).update(`${new Date(now).toISOString()}GET${capacitySource}`).digest('base64'));
  });
});

describe('OKX capacity validation and bounded failure', () => {
  it.each([
    { instId: 'ETH-USDT' }, { instId: 'BTC-USDC' }, { instId: 'BTC-USDT-SWAP' }, { instId: undefined },
    { tradeQuoteCcy: 'USDC' }, { tradeQuoteCcy: null },
    { availBuy: 100 }, { availSell: 0.01 }, { availBuy: '-1' }, { availSell: '-0.1' },
    { availBuy: '' }, { availSell: null }, { availBuy: '1e2' }, { availSell: 'NaN' },
    { availBuy: ' 1' }, { availSell: '01' }, { availBuy: '0.0000000000000000000000000000001' },
  ])('rejects invalid capacity without fallback or further requests: %j', async patch => {
    const { reader, fetch } = setup([envelope(configuration()), envelope({ ...capacity(), ...patch })]);
    await expect(reader.getSnapshot({ acceptIdentity })).rejects.toThrow(/^account-invalid-response$/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([{ data: [] }, { data: [capacity(), capacity()] }])('rejects non-singleton capacity rows', async ({ data }) => {
    const { reader, fetch } = setup([envelope(configuration()), JSON.stringify({ code: '0', data })]);
    await expect(reader.getSnapshot({ acceptIdentity })).rejects.toThrow(/^account-invalid-response$/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([0, 1, 2])('preserves HTTP 429 at request #%i and never retries', async failureAt => {
    const bodies = [envelope(configuration()), envelope(capacity()), envelope(configuration())];
    let count = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => count++ === failureAt
      ? new Response(credentials.apiSecret, { status: 429 }) : new Response(bodies[count - 1]));
    await expect(new OkxCapacityReader({ credentials, fetch, clock: () => now }).getSnapshot({ acceptIdentity })).rejects.toThrow(/^account-rate-limited$/);
    expect(fetch).toHaveBeenCalledTimes(failureAt + 1);
  });

  it.each(['50011', '50013', '50040'])('preserves API cooldown code %s after identity', async code => {
    const { reader, fetch } = setup([envelope(configuration()), JSON.stringify({ code, msg: credentials.apiSecret })]);
    await expect(reader.getSnapshot({ acceptIdentity })).rejects.toThrow(/^account-rate-limited$/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('preserves a late rate limit instead of replacing it with a clock timeout', async () => {
    let at = now;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => { at += 30_001; return new Response('private', { status: 429 }); });
    await expect(new OkxCapacityReader({ credentials, fetch, clock: () => at }).getSnapshot({ acceptIdentity })).rejects.toThrow(/^account-rate-limited$/);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('sanitizes network and upstream rejection errors', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => { throw new Error(credentials.apiSecret); });
    await expect(new OkxCapacityReader({ credentials, fetch, clock: () => now }).getSnapshot({ acceptIdentity })).rejects.toThrow(/^account-unavailable$/);
    await expect(setup([JSON.stringify({ code: '50113', msg: credentials.apiSecret })]).reader.getSnapshot({ acceptIdentity })).rejects.toThrow(/^account-api-rejected$/);
  });

  it('rejects credential-shaped account data without exposing it', async () => {
    const privateCredentials = { ...credentials, apiKey: configuration().uid };
    const bodies = [envelope(configuration()), envelope(capacity()), envelope(configuration())];
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(bodies.shift()));
    await expect(new OkxCapacityReader({ credentials: privateCredentials, fetch, clock: () => now }).getSnapshot({ acceptIdentity })).rejects.toThrow(/^account-invalid-response$/);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('rejects clock regression after acceptance before reading capacity', async () => {
    let at = now;
    const { reader, fetch } = setup(undefined, () => at);
    await expect(reader.getSnapshot({ acceptIdentity: () => { at--; return true; } })).rejects.toThrow(/^account-invalid-clock$/);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('expires suspended acceptance and cannot resume into a capacity read', async () => {
    vi.useFakeTimers();
    let release!: (value: boolean) => void;
    const { reader, fetch } = setup();
    const pending = reader.getSnapshot({ acceptIdentity: () => new Promise<boolean>(resolve => { release = resolve; }) });
    const rejected = expect(pending).rejects.toThrow(/^account-timeout$/);
    await vi.advanceTimersByTimeAsync(30_001); await rejected;
    release(true); await vi.runAllTimersAsync();
    expect(fetch).toHaveBeenCalledOnce();
    await expect(reader.getSnapshot({ acceptIdentity })).rejects.toThrow(/^account-reader-used$/);
  });

  it('cannot publish a snapshot when final acceptance exceeds the capture window', async () => {
    let at = now, accepted = 0;
    const { reader, fetch } = setup(undefined, () => at);
    await expect(reader.getSnapshot({ acceptIdentity: () => { if (++accepted === 2) at += 30_001; return true; } })).rejects.toThrow(/^account-timeout$/);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe('isolated capacity transport and archived snapshot', () => {
  it.each([
    '{"code":"0","code":"0","data":[]}',
    '{"code":"0","data":[{"instId":"BTC-USDT","availBuy":"1","availBuy":"9","availSell":"0"}]}',
    '{"code":"0","data":[{"instId":"BTC-USDT","availBuy":"1","avail\\u0042uy":"9","availSell":"0"}]}',
    '{"code":"0","data":[{"instId":"BTC-USDT","availBuy":"1","availSell":"0","extra":{"x":1,"x":2}}]}',
  ])('rejects ambiguous JSON keys in the signed capacity response', async body => {
    const { reader, fetch } = setup([envelope(configuration()), body]);
    await expect(reader.getSnapshot({ acceptIdentity })).rejects.toThrow(/^account-invalid-response$/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed UTF-8 instead of repairing response text', async () => {
    const body = Buffer.concat([Buffer.from('{"code":"0","msg":"'), Buffer.from([0xff]), Buffer.from('","data":[]}')]);
    await expect(setup([body]).reader.getSnapshot({ acceptIdentity })).rejects.toThrow(/^account-invalid-response$/);
  });

  it.each([
    '/api/v5/account/balance', '/api/v5/account/trade-fee?instType=SPOT&instId=BTC-USDT',
    '/api/v5/trade/order?instId=BTC-USDT&ordId=1', '/api/v5/account/max-size?instId=BTC-USDT&tdMode=cash',
    '/api/v5/account/config?', '/api/v5/account/config?extra=1', '/api/v5/account/max-avail-size',
    '/api/v5/account/max-avail-size?instId=ETH-USDT&tdMode=cash&tradeQuoteCcy=USDT',
    '/api/v5/account/max-avail-size?instId=BTC-USDT&tdMode=cross&tradeQuoteCcy=USDT',
    '/api/v5/account/max-avail-size?instId=BTC-USDT&tdMode=cash&tradeQuoteCcy=USDC',
    '/api/v5/account/max-avail-size?instId=BTC-USDT&tdMode=cash',
    capacitySource + '&instId=BTC-USDT', capacitySource + '&ccy=USDT', capacitySource + '&reduceOnly=true',
  ])('refuses unscoped endpoint before I/O: %s', async source => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const transport = new AccountTransport({ credentials, fetch, clock: () => now }, 'okx-capacity');
    await expect(transport.request(origin + source, {})).rejects.toThrow(/^account-unsupported-endpoint$/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    'http://www.okx.com' + configSource, 'https://www.okx.com:8443' + configSource,
    'https://eea.okx.com' + configSource, 'https://evil.test' + configSource,
    'https://www.okx.com.evil.test' + configSource, 'https://user@www.okx.com' + configSource,
    origin + capacitySource + '#fragment', 'https://api.mexc.com/api/v3/account',
  ])('refuses alternate origins, credentials and fragments: %s', async url => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(new AccountTransport({ credentials, fetch, clock: () => now }, 'okx-capacity').request(url, {}))
      .rejects.toThrow(/^account-unsupported-endpoint$/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['accounts', 'account-identity', 'account-funds', 'account-fees', 'execution-history', 'order-recovery'] as const)
  ('does not widen existing %s transport scope', async scope => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(new AccountTransport({ credentials, fetch, clock: () => now }, scope).request(origin + capacitySource, {}))
      .rejects.toThrow(/^account-unsupported-endpoint$/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects altered claims, provenance, currencies, config and timestamps in archived DTOs', async () => {
    const result = await setup().reader.getSnapshot({ acceptIdentity });
    const mutations: ((value: any) => void)[] = [
      x => { x.executable = true; }, x => { x.requestCount = 2; }, x => { x.configurationStable = false; },
      x => { x.identityAccepted = false; }, x => { x.origin = 'https://evil.test'; }, x => { x.symbol = 'ETH/USDT'; },
      x => { x.blockers = []; }, x => { x.blockers.push('made-up'); },
      x => { x.capacity.sourceUpdatedAt = String(now); }, x => { x.capacity.buyUnit = 'BTC'; },
      x => { x.capacity.sellUnit = 'USDT'; }, x => { x.capacity.buyQuoteAvailable = 100; },
      x => { x.capacity.sellBaseAvailable = '-1'; }, x => { x.capacity.source = '/api/v5/account/balance'; },
      x => { x.before.identity.mainAccountConfirmed = false; }, x => { x.after.identity.uid = '111'; },
      x => { x.after.configuration.autoLoan = true; }, x => { x.before.configuration.unavailableFields.autoLoan = 'empty'; },
      x => { x.capacity.requestedAt = now - 1; }, x => { x.capacity.receivedAt = now + 1; },
      x => { x.after.identity.receivedAt = now + 30_001; }, x => { x.extra = 'forged'; },
    ];
    for (const mutate of mutations) {
      const tampered = plain(result);
      mutate(tampered);
      expect(() => parseOkxCapacitySnapshot(tampered)).toThrow(/^account-invalid-response$/);
    }
  });
});


describe('closed capacity failure diagnostics', () => {
  it.each([
    { responses: [envelope({ ...configuration(), uid: 123 })], step: 'before-config', reason: 'identity-shape' },
    { responses: [envelope({ ...configuration(), autoLoan: credentials.apiSecret })], step: 'before-config', reason: 'configuration-shape' },
    { responses: [envelope(configuration()), envelope({ ...capacity(), instId: credentials.apiSecret })], step: 'capacity', reason: 'instrument' },
    { responses: [envelope(configuration()), envelope({ ...capacity(), availBuy: credentials.apiSecret })], step: 'capacity', reason: 'buy-amount' },
    { responses: [envelope(configuration()), envelope({ ...capacity(), availSell: 0 })], step: 'capacity', reason: 'sell-amount' },
    { responses: [envelope(configuration()), envelope(capacity()), envelope({ ...configuration(), autoLoan: 'false' })], step: 'after-config', reason: 'configuration-shape' },
    { responses: [envelope(configuration()), envelope(capacity()), envelope({ ...configuration(), feeType: '1' })], step: 'snapshot', reason: 'configuration-changed' },
  ])('returns only closed vocabulary for $step/$reason', async ({responses,step,reason}) => {
    let rejected: unknown;
    try { await setup(responses).reader.getSnapshot({acceptIdentity}); } catch(error) { rejected=error; }
    const diagnostic = getCapacityFailureDiagnostic(rejected);
    expect(diagnostic).toEqual({step,reason});
    expect(Object.isFrozen(diagnostic)).toBe(true);
    expect(JSON.stringify(diagnostic)).not.toContain(credentials.apiSecret);
    expect(JSON.stringify(diagnostic)).not.toContain(configuration().uid);
  });
  it('does not trust a diagnostic property on an unrelated error', () => {
    expect(getCapacityFailureDiagnostic({step:'capacity',reason:'buy-amount'})).toBeNull();
    expect(getCapacityFailureDiagnostic(new Error(credentials.apiSecret))).toBeNull();
  });
});


describe('optional undocumented quote currency echo', () => {
  it.each([{echo:undefined,expected:'not-reported'},{echo:'',expected:'empty'},{echo:'USDT',expected:'matched'}])('preserves $expected without changing instrument/units', async ({echo,expected}) => {
    const result = await setup([envelope(configuration()),envelope({...capacity(),tradeQuoteCcy:echo}),envelope(configuration())]).reader.getSnapshot({acceptIdentity});
    expect(result.capacity).toMatchObject({quoteCurrencyEcho:expected,buyUnit:'USDT',sellUnit:'BTC'});
    expect(result.executable).toBe(false);
  });
  it('keeps a conflicting optional quote echo separate from an instrument mismatch', async () => {
    let error: unknown;
    try { await setup([envelope(configuration()),envelope({...capacity(),tradeQuoteCcy:'USD'})]).reader.getSnapshot({acceptIdentity}); } catch(e) { error=e; }
    expect(getCapacityFailureDiagnostic(error)).toEqual({step:'capacity',reason:'quote-currency'});
  });
});
