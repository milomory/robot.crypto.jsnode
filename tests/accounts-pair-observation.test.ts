import { afterEach, describe, expect, it, vi } from 'vitest';
import { MexcAccountReader } from '../src/accounts/mexc.js';
import { OkxAccountReader } from '../src/accounts/okx.js';
import { observeAccountPair } from '../src/accounts/pair-observation.js';
import { AccountError } from '../src/accounts/types.js';
import { LabError, type OrderBook, type PublicVenue } from '../src/lab/order-book.js';

const NOW = 1_800_000_000_000;
const credentials = { apiKey: 'fixture-key', apiSecret: 'fixture-secret', passphrase: 'fixture-passphrase' };
function fixtures() {
  return {
    mexc: { accountType: 'SPOT', canTrade: true, canWithdraw: true, canDeposit: true, updateTime: 1,
      balances: [{ asset: 'BTC', free: '0.5', locked: '0.1', available: '0.4' },
        { asset: 'USDT', free: '100.000000000000000001', locked: '1', available: '90.000000000000000001' },
        { asset: 'ETH', free: '123456789', locked: '987654321', available: '234567891' }],
      private: 'PRIVATE_EXCHANGE_ECHO' },
    mexcFees: { code: 0, data: { makerCommission: 0, takerCommission: 0.0001 } },
    mexcFeePayment: { code: 0, data: { mxDeductEnable: false, private: 'PRIVATE_FEE_ECHO' } },
    config: { code: '0', data: [{ perm: 'read_only,trade,withdraw,future_permission', acctLv: '1',
      uid: 'PRIVATE_EXCHANGE_UID', private: 'PRIVATE_EXCHANGE_ECHO' }] },
    trading: { code: '0', data: [{ totalEq: '99999', uTime: '1', details: [
      { ccy: 'BTC', cashBal: '0.5', eq: '50', availBal: '0.4', availEq: '500', frozenBal: '0.1', uTime: '1' },
      { ccy: 'USDT', cashBal: '100.000000000000000009', eq: '99999', availBal: '90.000000000000000009',
        availEq: '99999', frozenBal: '10', uTime: '1' },
      { ccy: 'ETH', cashBal: '987654321', eq: '987654321', availBal: '987654321',
        availEq: '987654321', frozenBal: '0', uTime: '1' }
    ] }] },
    funding: { code: '0', data: [{ ccy: 'USDT', bal: '1000000', availBal: '1000000', frozenBal: '0' }] },
    okxFees: { code: '0', data: [{ instType: 'SPOT', instId: 'BTC-USDT', ts: '1',
      feeGroup: [{ groupId: '1', maker: '0.0001', taker: '-0.001' }] }] }
  };
}
function book(venue: 'mexc' | 'okx', at: number): OrderBook<PublicVenue> {
  return { venue, symbol: 'BTC/USDT', bids: [[venue === 'mexc' ? 99_990 : 100_300, 1]],
    asks: [[venue === 'mexc' ? 100_000 : 100_310, 1]], requestedAt: at, receivedAt: at,
    ...(venue === 'okx' ? { sourceAt: at } : {}) };
}
function setup() {
  let now = NOW;
  const payloads = fixtures();
  const paths: string[] = [];
  const fakeFetch = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    paths.push(`${url.host}${url.pathname}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store' });
    const routes: Record<string, unknown> = {
      'api.mexc.com/api/v3/account': payloads.mexc, 'api.mexc.com/api/v3/tradeFee': payloads.mexcFees,
      'api.mexc.com/api/v3/mxDeduct/enable': payloads.mexcFeePayment,
      'www.okx.com/api/v5/account/config': payloads.config,
      'www.okx.com/api/v5/account/balance': payloads.trading,
      'www.okx.com/api/v5/asset/balances': payloads.funding,
      'www.okx.com/api/v5/account/trade-fee': payloads.okxFees,
    };
    expect(Object.hasOwn(routes, `${url.host}${url.pathname}`)).toBe(true);
    return Response.json(routes[`${url.host}${url.pathname}`]);
  });
  const clock = () => now;
  const mexc = new MexcAccountReader({ credentials, fetch: fakeFetch, clock });
  const okx = new OkxAccountReader({ credentials, fetch: fakeFetch, clock });
  const books = { getBook: vi.fn(async (venue: 'mexc' | 'okx', symbol: string) => {
    expect(symbol).toBe('BTC/USDT'); return book(venue, now);
  }) };
  return { payloads, paths, fakeFetch, mexc, okx, books, clock, setNow: (at: number) => { now = at; },
    run: () => observeAccountPair(mexc, okx, books, clock) };
}
afterEach(() => vi.useRealTimers());

describe('private MEXC/OKX pair observation', () => {
  it('uses exactly seven sequential per-venue account GETs, then only the two public books', async () => {
    const fixture = setup();
    fixture.books.getBook.mockImplementation(async venue => {
      expect(fixture.paths).toHaveLength(7); return book(venue, NOW);
    });
    const result = await fixture.run();
    expect(fixture.paths.filter(path => path.startsWith('api.mexc.com'))).toEqual([
      'api.mexc.com/api/v3/account', 'api.mexc.com/api/v3/tradeFee', 'api.mexc.com/api/v3/mxDeduct/enable']);
    expect(fixture.paths.filter(path => path.startsWith('www.okx.com'))).toEqual([
      'www.okx.com/api/v5/account/config', 'www.okx.com/api/v5/account/balance',
      'www.okx.com/api/v5/asset/balances', 'www.okx.com/api/v5/account/trade-fee']);
    expect(fixture.books.getBook.mock.calls.map(([venue]) => venue)).toEqual(['mexc', 'okx']);
    expect(result).toMatchObject({ schema: 1, status: 'observed', mode: 'observation-only', executable: false,
      symbol: 'BTC/USDT', quantity: 0.0001, adverseBps: 5, checkedAt: NOW });
    expect(result.comparisons).toHaveLength(2);
    for (const comparison of result.comparisons) {
      expect(comparison).toMatchObject({ status: 'observed', inventory: {
        status: 'sufficient-estimate', executableInventoryProven: false } });
      if (comparison.status === 'observed') expect(comparison.estimate.indicativeOnly).toBe(true);
    }
  });

  it('preserves selected decimal strings, declares numeric MEXC fee precision and omits unrelated private data', async () => {
    const result = await setup().run();
    expect(result.accounts.mexc).toMatchObject({ status: 'available', feeReadVerified: true,
      balances: { USDT: { free: '100.000000000000000001', available: '90.000000000000000001' } },
      fees: { takerCostRate: 0.0001, ratePrecision: 'json-number' } });
    expect(result.accounts.okx).toMatchObject({ status: 'available', feeReadVerified: true,
      balances: { USDT: { cashBalance: '100.000000000000000009', availableBalance: '90.000000000000000009' } },
      permissions: { accountMode: '1', unknownPermissionsPresent: true } });
    expect(JSON.stringify(result)).not.toMatch(/fixture-|PRIVATE_|totalEquity|availableEquity/);
    expect(result.accounts.mexc).toMatchObject({ holdings: expect.arrayContaining([expect.objectContaining({ currency: 'ETH', free: '123456789' })]) });
    if (result.accounts.mexc.status === 'available') expect(JSON.stringify(result.accounts.mexc.balances)).not.toContain('ETH');
    expect(result.limitations.join(' ')).toContain('Fee currency is unknown');
  });

  it.each(['0', '1'] as const)('retains actual OKX fee type %s through the private projection', async feeType => {
    const fixture = setup(); Object.assign(fixture.payloads.config.data[0], { feeType });
    const result = await fixture.run();
    expect(result.accounts.okx).toMatchObject({ status: 'available', feeReadVerified: true,
      permissions: { feeType, read: true, trade: true, withdraw: true, accountMode: '1' } });
    expect(fixture.paths.filter(path => path.endsWith('/api/v5/account/config'))).toHaveLength(1);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|fixture-/);
    expect(result.executable).toBe(false);
  });

  it('does not infer an OKX fee type when config omits it or returns an unknown value', async () => {
    for (const feeType of [undefined, 'PRIVATE_FEE_SETTING', 0, 1]) {
      const fixture = setup(); Object.assign(fixture.payloads.config.data[0], { feeType });
      const result = await fixture.run();
      expect(result.accounts.okx).toMatchObject({ status: 'available', permissions: { feeType: null } });
      expect(JSON.stringify(result)).not.toContain('PRIVATE_FEE_SETTING');
    }
  });

  it.each([true, false])('retains actual MEXC MX deduction status %s without exposing raw response', async enabled => {
    const fixture = setup(); fixture.payloads.mexcFeePayment.data.mxDeductEnable = enabled;
    const result = await fixture.run();
    expect(result.accounts.mexc).toMatchObject({ status: 'available', feeReadVerified: true,
      feePayment: { mxDeductEnabled: enabled, readVerified: true, reason: null } });
    expect(fixture.paths.filter(path => path.endsWith('/api/v3/mxDeduct/enable'))).toHaveLength(1);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|fixture-/);
    expect(result.executable).toBe(false);
  });

  it.each([
    { error: new Error('PRIVATE_FEE_ERROR fixture-secret'), reason: 'account-unavailable' },
    { error: new AccountError('PRIVATE_FEE_ERROR'), reason: 'account-unavailable' },
    { error: new AccountError('account-timeout'), reason: 'account-timeout' },
    { error: new AccountError('account-rate-limited'), reason: 'account-rate-limited' },
  ])('preserves core balances and rates when optional fee-payment read fails: $reason', async ({ error, reason }) => {
    const fixture = setup();
    vi.spyOn(fixture.mexc, 'getMxDeductStatus').mockRejectedValue(error);
    const result = await fixture.run();
    expect(result.accounts.mexc).toMatchObject({ status: 'available', feeReadVerified: true,
      feePayment: { mxDeductEnabled: null, readVerified: false, reason },
      balances: { USDT: { free: '100.000000000000000001', available: '90.000000000000000001' } },
      fees: { takerCostRate: 0.0001, ratePrecision: 'json-number' } });
    expect(result.accounts.okx.status).toBe('available');
    expect(result.status).toBe('observed');
    expect(result.comparisons.every(row => row.status === 'observed')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|fixture-secret/);
    expect(result.executable).toBe(false);
  });

  it('does not reuse a previous successful fee-payment status after the next read fails', async () => {
    const fixture = setup(); fixture.payloads.mexcFeePayment.data.mxDeductEnable = true;
    expect((await fixture.run()).accounts.mexc).toMatchObject({ feePayment: { mxDeductEnabled: true, readVerified: true } });
    vi.spyOn(fixture.mexc, 'getMxDeductStatus').mockRejectedValue(new Error('PRIVATE_FEE_ERROR'));
    expect((await fixture.run()).accounts.mexc).toMatchObject({ status: 'available', feeReadVerified: true,
      feePayment: { mxDeductEnabled: null, readVerified: false, reason: 'account-unavailable' } });
  });

  it('bounds a hung optional fee-payment read and preserves independently verified core data', async () => {
    vi.useFakeTimers();
    const fixture = setup();
    vi.spyOn(fixture.mexc, 'getMxDeductStatus').mockImplementation(() => new Promise(() => {}));
    const pending = fixture.run();
    await vi.advanceTimersByTimeAsync(6_000);
    const result = await pending;
    expect(result.accounts.mexc).toMatchObject({ status: 'available', feeReadVerified: true,
      feePayment: { mxDeductEnabled: null, readVerified: false, reason: 'account-timeout' } });
    expect(result.accounts.okx.status).toBe('available');
    expect(result.status).toBe('observed');
  });

  it.each(['-0.001', '0', '0.003'])('normalizes OKX taker rate %s without crediting rebates', async rate => {
    const fixture = setup();
    fixture.payloads.okxFees.data[0].feeGroup[0].taker = rate;
    const result = await fixture.run();
    expect(result.accounts.okx).toMatchObject({ fees: { takerRate: rate, takerCostRate: Math.max(0, -Number(rate)) } });
    for (const comparison of result.comparisons) {
      if (comparison.status !== 'observed') throw new Error('Expected observation');
      const fill = comparison.buyVenue === 'okx' ? comparison.estimate.purchase : comparison.estimate.sale;
      expect(fill.feeQuote).toBeGreaterThanOrEqual(0);
      if (Number(rate) >= 0) expect(fill.feeQuote).toBe(0);
    }
  });

  it('accepts small numeric fee exponent notation while retaining the precision warning', async () => {
    const fixture = setup(); fixture.payloads.mexcFees.data.takerCommission = 1e-7;
    expect((await fixture.run()).accounts.mexc).toMatchObject({ status: 'available',
      fees: { takerRate: '1e-7', takerCostRate: 1e-7, ratePrecision: 'json-number' } });
  });

  it('keeps another venue healthy when a read fails and stops failed-venue reads at that stage', async () => {
    const fixture = setup();
    vi.spyOn(fixture.mexc, 'getBalances').mockRejectedValue(new Error('PRIVATE_UPSTREAM_TEXT fixture-secret'));
    const report = await fixture.run();
    expect(report.accounts.mexc).toEqual({ status: 'unavailable', feeReadVerified: false,
      stage: 'balances', reason: 'account-unavailable' });
    expect(report.accounts.okx.status).toBe('available');
    expect(fixture.paths.some(path => path.startsWith('api.mexc.com'))).toBe(false);
    expect(report.status).toBe('blocked');
    expect(report.comparisons.every(row => row.status === 'blocked')).toBe(true);
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE_|fixture-secret/);
  });

  it('replaces an earlier good result after a fee failure and never reuses balances or comparisons', async () => {
    const fixture = setup();
    expect((await fixture.run()).status).toBe('observed');
    vi.spyOn(fixture.okx, 'getSpotFees').mockRejectedValue(new AccountError('account-timeout'));
    const failed = await fixture.run();
    expect(failed.accounts.okx).toEqual({ status: 'unavailable', feeReadVerified: false,
      stage: 'fees', reason: 'account-timeout' });
    expect(failed.comparisons.every(row => row.status === 'blocked')).toBe(true);
    expect(JSON.stringify(failed.accounts.okx)).not.toContain('balances');
  });

  it('uses request age rather than exchange update timestamps and invalidates slow account data', async () => {
    const fixture = setup();
    const fees = fixture.okx.getSpotFees.bind(fixture.okx);
    vi.spyOn(fixture.okx, 'getSpotFees').mockImplementation(async symbol => {
      const result = await fees(symbol); fixture.setNow(NOW + 120_001); return result;
    });
    const result = await fixture.run();
    expect(result.accounts.mexc).toMatchObject({ status: 'unavailable', reason: 'account-stale', stage: 'clock' });
    expect(result.accounts.okx).toMatchObject({ status: 'unavailable', reason: 'account-stale' });
    expect(result.status).toBe('blocked');
  });

  it('expires account data when book acquisition delays an otherwise fresh account response', async () => {
    const fixture = setup();
    fixture.books.getBook.mockImplementation(async venue => { fixture.setNow(NOW + 120_001); return book(venue, NOW + 120_001); });
    const result = await fixture.run();
    expect(result.accounts.mexc).toMatchObject({ status: 'unavailable', reason: 'account-stale' });
    expect(result.accounts.okx).toMatchObject({ status: 'unavailable', reason: 'account-stale' });
  });

  it.each([0, NaN, Infinity, -1, NOW + 0.5, 8_640_000_000_000_001])('fails without I/O on invalid clock %s', async now => {
    const fixture = setup(); fixture.setNow(now);
    const result = await fixture.run();
    expect(result).toMatchObject({ checkedAt: null, status: 'blocked', executable: false });
    expect(fixture.fakeFetch).not.toHaveBeenCalled();
    expect(fixture.books.getBook).not.toHaveBeenCalled();
  });

  it('drops all account data on a backwards final clock or throwing clock', async () => {
    const fixture = setup();
    fixture.books.getBook.mockImplementation(async venue => { fixture.setNow(NOW - 1); return book(venue, NOW - 1); });
    const result = await fixture.run();
    expect(result.checkedAt).toBeNull();
    expect(result.accounts.mexc.status).toBe('unavailable');
    expect(result.accounts.okx.status).toBe('unavailable');
    const thrown = await observeAccountPair(fixture.mexc, fixture.okx, fixture.books, () => { throw Error('PRIVATE_CLOCK'); });
    expect(thrown.checkedAt).toBeNull();
    expect(JSON.stringify(thrown)).not.toContain('PRIVATE_CLOCK');
  });

  it.each(['2', '3', '4'])('does not treat OKX mode %s equity or borrowing as spot inventory', async mode => {
    const fixture = setup(); fixture.payloads.config.data[0].acctLv = mode;
    const result = await fixture.run();
    for (const comparison of result.comparisons) {
      expect(comparison).toMatchObject({ status: 'observed', inventory: {
        status: 'unknown', reason: 'unsupported-okx-account-mode', executableInventoryProven: false } });
    }
  });

  it('keeps null available balance unknown and excludes funding from a zero-cash trading wallet', async () => {
    const fixture = setup();
    fixture.payloads.trading.data[0].details[0].availBal = '';
    fixture.payloads.trading.data[0].details[1].cashBal = '0';
    const result = await fixture.run();
    expect(result.comparisons[0]).toMatchObject({ inventory: { status: 'unknown', sellBaseAvailableEstimate: null } });
    expect(result.comparisons[1]).toMatchObject({ inventory: { status: 'insufficient', buyQuoteAvailableEstimate: 0 } });
  });

  it('uses minimum cash/available and free/available; negative cash never funds a trade', async () => {
    const fixture = setup();
    fixture.payloads.mexc.balances[1].available = '1';
    fixture.payloads.trading.data[0].details[0].cashBal = '-2';
    const result = await fixture.run();
    expect(result.comparisons[0]).toMatchObject({ inventory: { status: 'insufficient',
      buyQuoteAvailableEstimate: 1, sellBaseAvailableEstimate: 0 } });
  });

  it('treats absent selected assets as zero and retains empty wallets as explicit empty selections', async () => {
    const fixture = setup(); fixture.payloads.mexc.balances = []; fixture.payloads.trading.data[0].details = [];
    const result = await fixture.run();
    expect(result.accounts.mexc).toMatchObject({ balances: { BTC: null, USDT: null } });
    expect(result.accounts.okx).toMatchObject({ balances: { BTC: null, USDT: null } });
    expect(result.comparisons[0]).toMatchObject({ inventory: { status: 'insufficient',
      buyQuoteAvailableEstimate: 0, sellBaseAvailableEstimate: 0 } });
  });

  it('rejects unsafe book identity and never returns arbitrary public error text', async () => {
    const fixture = setup();
    fixture.books.getBook.mockImplementation(async venue => {
      if (venue === 'mexc') return { ...book(venue, NOW), symbol: 'PRIVATE_SYMBOL' };
      throw new LabError('PRIVATE_UPSTREAM_RESPONSE');
    });
    const result = await fixture.run();
    expect(result.books.mexc).toEqual({ status: 'unavailable', reason: 'public-book-identity-mismatch' });
    expect(result.books.okx).toEqual({ status: 'unavailable', reason: 'public-request-failed' });
    expect(result.status).toBe('blocked');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_');
  });

  it('blocks stale and unsynchronised books, with no successful comparison retained', async () => {
    const stale = setup();
    stale.books.getBook.mockImplementation(async venue => book(venue, NOW - 5_001));
    expect((await stale.run()).books.mexc).toEqual({ status: 'unavailable', reason: 'stale-or-invalid-receipt-time' });
    const unsynced = setup();
    unsynced.books.getBook.mockImplementation(async venue => book(venue, venue === 'mexc' ? NOW : NOW - 2_001));
    const result = await unsynced.run();
    expect(result.comparisons).toEqual([
      { buyVenue: 'mexc', sellVenue: 'okx', status: 'blocked', reason: 'unsynchronised-books' },
      { buyVenue: 'okx', sellVenue: 'mexc', status: 'blocked', reason: 'unsynchronised-books' }
    ]);
  });

  it('rejects ambiguous or invalid fee data without falling back to nominal tariffs', async () => {
    const fixture = setup(); fixture.payloads.okxFees.data[0].feeGroup = [];
    const result = await fixture.run();
    expect(result.accounts.okx).toMatchObject({ status: 'unavailable', stage: 'fees', reason: 'account-invalid-response' });
    expect(result.comparisons.every(row => row.status === 'blocked')).toBe(true);
    const invalid = setup(); invalid.payloads.okxFees.data[0].feeGroup[0].taker = '-2';
    expect((await invalid.run()).accounts.okx).toMatchObject({ status: 'unavailable', reason: 'account-invalid-fees' });
  });

  it('blocks a non-finite derived spread instead of serializing it as null', async () => {
    const fixture = setup();
    fixture.books.getBook.mockImplementation(async venue => ({ ...book(venue, NOW),
      bids: [[venue === 'mexc' ? 5e-301 : 1e308, 1]],
      asks: [[venue === 'mexc' ? 1e-300 : 1.1e308, 1]] }));
    const result = await fixture.run();
    expect(result.comparisons[0]).toMatchObject({ status: 'blocked', reason: 'invalid-fill-arithmetic' });
    expect(result.status).toBe('blocked');
    expect(JSON.stringify(result)).not.toContain('"netBps":null');
  });

  it('does not treat an unfilled depth estimate as an opportunity', async () => {
    const fixture = setup();
    fixture.books.getBook.mockImplementation(async venue => ({ ...book(venue, NOW),
      bids: [[100_000, 0.00001]], asks: [[100_010, 0.00001]] }));
    const result = await fixture.run();
    expect(result.comparisons.every(row => row.status === 'blocked' && row.reason === 'insufficient-depth')).toBe(true);
    expect(result.status).toBe('blocked');
  });

  it('rejects more than 200 nonzero currencies instead of truncating private holdings', async () => {
    const fixture = setup();
    fixture.payloads.mexc.balances = Array.from({ length: 201 }, (_, i) => ({
      asset: `A${i}`, free: '1', locked: '0', available: '1' }));
    const result = await fixture.run();
    expect(result.accounts.mexc).toEqual({ status: 'unavailable', feeReadVerified: false,
      stage: 'balances', reason: 'account-invalid-response' });
    expect(result.accounts.okx.status).toBe('available');
  });

  it('retains signed OKX equity and excludes all-zero currencies from the private holdings', async () => {
    const fixture = setup();
    fixture.payloads.trading.data[0].details[0].eq = '-0.000000000000000001';
    fixture.payloads.mexc.balances.push({ asset: 'ZERO', free: '0.000', locked: '0', available: '0' });
    const result = await fixture.run();
    expect(result.accounts.okx).toMatchObject({ holdings: expect.arrayContaining([
      expect.objectContaining({ currency: 'BTC', equity: '-0.000000000000000001' })]) });
    if (result.accounts.mexc.status === 'available') expect(result.accounts.mexc.holdings.some(row => row.currency === 'ZERO')).toBe(false);
  });

  it('does not expose unknown AccountError codes', async () => {
    const fixture = setup();
    vi.spyOn(fixture.okx, 'getKeyPermissions').mockRejectedValue(new AccountError('PRIVATE_ERROR_TOKEN'));
    const result = await fixture.run();
    expect(result.accounts.okx).toMatchObject({ stage: 'config', reason: 'account-unavailable' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_ERROR_TOKEN');
  });

  it('returns a failed latest snapshot after a hung read instead of waiting forever', async () => {
    vi.useFakeTimers();
    const fixture = setup();
    vi.spyOn(fixture.mexc, 'getBalances').mockImplementation(() => new Promise(() => {}));
    const pending = fixture.run();
    await vi.advanceTimersByTimeAsync(6_000);
    const result = await pending;
    expect(result.accounts.mexc).toEqual({ status: 'unavailable', feeReadVerified: false,
      stage: 'balances', reason: 'account-timeout' });
    expect(result.accounts.okx.status).toBe('available');
    expect(result.status).toBe('blocked');
  });
});
