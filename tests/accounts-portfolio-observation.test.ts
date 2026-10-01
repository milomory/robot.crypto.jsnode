import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountValuationClient, buildAccountDashboard, type ValuationClient } from '../src/accounts/portfolio-observation.js';
import type { PairObservation, PairVenue } from '../src/accounts/pair-observation.js';
import type { OkxKeyPermissions } from '../src/accounts/okx.js';

const NOW = 1_800_000_000_000;
const mexcRow = (currency: string, free: string, locked = '0', available: string | null = null) => ({ currency, free, locked, available });
const okxRow = (currency: string, equity: string, cashBalance = equity, availableBalance: string | null = equity,
  frozenBalance: string | null = '0') => ({ currency, equity, cashBalance, availableBalance, frozenBalance });
const fundingRow = (currency: string, balance: string, availableBalance = balance, frozenBalance = '0') => ({ currency, balance, availableBalance, frozenBalance });
function pair() {
  return {
    schema: 1, mode: 'observation-only', executable: false, symbol: 'BTC/USDT', quantity: 0.0001,
    adverseBps: 5, checkedAt: NOW, status: 'blocked', books: {
      mexc: { status: 'unavailable', reason: 'public-request-failed' },
      okx: { status: 'unavailable', reason: 'public-request-failed' }
    }, comparisons: [], limitations: [],
    accounts: {
      mexc: { status: 'available', feeReadVerified: true, requestedAt: NOW, receivedAt: NOW, account: 'spot',
        holdings: [mexcRow('USDT', '10.000000000000000001', '0.1'), mexcRow('BTC', '0.1', '0.2', '0.05')],
        balances: { BTC: null, USDT: null }, accountCapabilities: { canTrade: true, canWithdraw: true, canDeposit: true },
        fees: { makerRate: '0', takerRate: '0.001', takerCostRate: 0.001, ratePrecision: 'decimal-string', rateConvention: 'positive-fee' } },
      okx: { status: 'available', feeReadVerified: true, requestedAt: NOW, receivedAt: NOW, account: 'trading',
        holdings: [okxRow('USDT', '20', '20', '19', '1'), okxRow('BTC', '0.1', '0.1', '0.09', '0.01')],
        fundingHoldings: [fundingRow('USDT', '3', '2', '1'), fundingRow('BTC', '0.2')],
        balances: { BTC: null, USDT: null }, funding: { BTC: null, USDT: null },
        permissions: { read: true, trade: true, withdraw: true, unknownPermissionsPresent: false,
          accountMode: '1' as OkxKeyPermissions['accountMode'] },
        fees: { makerRate: '0', takerRate: '-0.001', takerCostRate: 0.001,
          ratePrecision: 'decimal-string', rateConvention: 'negative-fee-positive-rebate' } }
    }
  } satisfies PairObservation;
}
function values(mexc: Record<string, string> = { BTC: '100' }, okx: Record<string, string> = { BTC: '200' }): ValuationClient {
  return { getPrices: vi.fn(async (venue: PairVenue) => ({ venue, requestedAt: NOW, receivedAt: NOW,
    prices: venue === 'mexc' ? mexc : okx })) };
}
const ticks = (rows: Array<{ currency: string; price: unknown; ts?: string; instType?: string }>) => ({
  code: '0', data: rows.map(row => ({ instId: `${row.currency}-USDT`, last: row.price,
    ts: row.ts ?? String(NOW), instType: row.instType ?? 'SPOT', private: 'PRIVATE_UPSTREAM' }))
});
afterEach(() => vi.useRealTimers());

describe('private account portfolio projection', () => {
  it('values all assets once per venue with exact decimal arithmetic and preserves funding/equity semantics', async () => {
    const quotes = values(), report = pair();
    const result = await buildAccountDashboard(report, quotes, () => NOW);
    expect(result.status).toBe('ready');
    expect(result.totals).toEqual({ portfolioUsdt: '123.100000000000000001', pricedUsdt: '123.100000000000000001',
      usdtBalance: '33.100000000000000001', availableUsdt: '31.000000000000000001', valuationComplete: true });
    expect(result.exchanges[0].assets).toContainEqual({ currency: 'BTC', total: '0.3', available: '0.05', locked: '0.2', valueUsdt: '30' });
    expect(result.exchanges[1].assets).toContainEqual({ currency: 'BTC', total: '0.3', available: '0.29', locked: '0.01', valueUsdt: '60' });
    expect(quotes.getPrices).toHaveBeenCalledTimes(2);
    expect(result.operations).toEqual({ status: 'not-connected', items: [], coverageLabel: 'История бирж ещё не подключена' });
    expect(result.liveExecutionEnabled).toBe(false);
  });

  it('does not double-count OKX cash plus equity and retains signed debt', async () => {
    const report = pair();
    report.accounts.mexc.holdings = [];
    report.accounts.okx.holdings = [okxRow('USDT', '-2', '100', '100'), okxRow('BTC', '-0.1', '50', '50')];
    report.accounts.okx.fundingHoldings = [fundingRow('USDT', '1')];
    const result = await buildAccountDashboard(report, values(), () => NOW);
    expect(result.exchanges[1].usdtBalance).toBe('-1');
    expect(result.exchanges[1].portfolioUsdt).toBe('-21');
    expect(result.exchanges[1].assets.find(row => row.currency === 'BTC')).toMatchObject({ total: '-0.1', valueUsdt: '-20' });
  });

  it('keeps a priced subtotal while an unknown asset prevents a complete portfolio total', async () => {
    const report = pair(); report.accounts.mexc.holdings.push(mexcRow('UNKNOWN', '15'));
    const result = await buildAccountDashboard(report, values(), () => NOW);
    expect(result.status).toBe('partial');
    expect(result.totals.portfolioUsdt).toBeNull();
    expect(result.totals.pricedUsdt).toBe('123.100000000000000001');
    expect(result.exchanges[0]).toMatchObject({ valuationComplete: false, portfolioUsdt: null, unpricedAssets: ['UNKNOWN'] });
    expect(result.exchanges[0].assets.find(row => row.currency === 'UNKNOWN')?.valueUsdt).toBeNull();
  });

  it('never values an asset through the other venue or assumes a USD/USDC peg', async () => {
    const report = pair(); report.accounts.mexc.holdings = [mexcRow('USDC', '10'), mexcRow('USD', '11'), mexcRow('BTC', '1')];
    const result = await buildAccountDashboard(report, values({}, { BTC: '500', USDC: '1', USD: '1' }), () => NOW);
    expect(result.exchanges[0]).toMatchObject({ portfolioUsdt: null, pricedUsdt: '0', unpricedAssets: ['BTC', 'USD', 'USDC'] });
    expect(result.totals.portfolioUsdt).toBeNull();
  });

  it('keeps a healthy venue visible but suppresses every combined total when the other account failed', async () => {
    const report: PairObservation = pair();
    report.accounts.mexc = { status: 'unavailable', feeReadVerified: false, stage: 'balances', reason: 'account-auth-failed' };
    const result = await buildAccountDashboard(report, values(), () => NOW);
    expect(result.status).toBe('partial');
    expect(result.exchanges[0]).toMatchObject({ status: 'error', assets: [], portfolioUsdt: null });
    expect(result.exchanges[1].portfolioUsdt).toBe('83');
    expect(result.totals).toEqual({ portfolioUsdt: null, pricedUsdt: null, usdtBalance: null,
      availableUsdt: null, valuationComplete: false });
  });

  it('shows unknown availability for non-spot OKX mode or missing available balance, without using equity', async () => {
    const report = pair(); report.accounts.okx.permissions.accountMode = '4';
    let result = await buildAccountDashboard(report, values(), () => NOW);
    expect(result.exchanges[1].availableUsdt).toBeNull();
    expect(result.totals.availableUsdt).toBeNull();
    expect(result.exchanges[1].portfolioUsdt).toBe('83');
    report.accounts.okx.permissions.accountMode = '1';
    report.accounts.okx.holdings[0].availableBalance = null;
    result = await buildAccountDashboard(report, values(), () => NOW);
    expect(result.exchanges[1].availableUsdt).toBeNull();
    expect(result.exchanges[1].assets.find(row => row.currency === 'BTC')?.available).toBe('0.29');
  });

  it('does not fabricate locked values where the exchange returned unknown', async () => {
    const report = pair(); report.accounts.okx.holdings[0].frozenBalance = null;
    const result = await buildAccountDashboard(report, values(), () => NOW);
    expect(result.exchanges[1].assets.find(row => row.currency === 'USDT')?.locked).toBeNull();
  });

  it('retains all 60 fractional places in a multiplication rather than converting through Number', async () => {
    const report = pair();
    report.accounts.mexc.holdings = [mexcRow('TINY', '0.000000000000000000000000000001')];
    report.accounts.okx.holdings = []; report.accounts.okx.fundingHoldings = [];
    const result = await buildAccountDashboard(report, values({ TINY: '0.000000000000000000000000000001' }, {}), () => NOW);
    expect(result.totals.portfolioUsdt).toBe(`0.${'0'.repeat(59)}1`);
    expect(result.totals.usdtBalance).toBe('0');
  });

  it('keeps offsetting nonzero wallet holdings visible with unknown valuation until a direct price exists', async () => {
    const report = pair();
    report.accounts.okx.holdings = [okxRow('UNKNOWN', '-2', '-2', '0')];
    report.accounts.okx.fundingHoldings = [fundingRow('UNKNOWN', '2')];
    const result = await buildAccountDashboard(report, values(), () => NOW);
    expect(result.exchanges[1].assets).toContainEqual({ currency: 'UNKNOWN', total: '0',
      available: '2', locked: '0', valueUsdt: null });
    expect(result.exchanges[1].portfolioUsdt).toBeNull();
  });

  it('reports genuinely empty accounts as complete zero portfolios, even with unavailable price services', async () => {
    const report = pair(); report.accounts.mexc.holdings = []; report.accounts.okx.holdings = [];
    report.accounts.okx.fundingHoldings = [];
    const result = await buildAccountDashboard(report, { getPrices: async () => { throw new Error('PRIVATE_RESPONSE'); } }, () => NOW);
    expect(result.status).toBe('ready');
    expect(result.totals).toEqual({ portfolioUsdt: '0', pricedUsdt: '0', usdtBalance: '0', availableUsdt: '0', valuationComplete: true });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_RESPONSE');
  });

  it('does not keep an old portfolio after account expiry or public-price failure', async () => {
    const report = pair();
    const stale = await buildAccountDashboard(report, values(), () => NOW + 120_001);
    expect(stale.status).toBe('stale');
    expect(stale.exchanges.every(exchange => exchange.assets.length === 0)).toBe(true);
    const failed = await buildAccountDashboard(report, { getPrices: async () => { throw new Error('PRIVATE_ERROR'); } }, () => NOW);
    expect(failed.status).toBe('partial');
    expect(failed.totals.portfolioUsdt).toBeNull();
    expect(failed.totals.pricedUsdt).toBe('33.100000000000000001');
    expect(JSON.stringify(failed)).not.toContain('PRIVATE_ERROR');
  });

  it('rejects more than 200 assets or duplicate currencies instead of silently dropping balances', async () => {
    const report = pair(); report.accounts.mexc.holdings = Array.from({ length: 201 }, (_, i) => mexcRow(`A${i}`, '1'));
    let result = await buildAccountDashboard(report, values(), () => NOW);
    expect(result.exchanges[0]).toMatchObject({ status: 'error', assets: [] });
    report.accounts.mexc.holdings = [mexcRow('BTC', '1'), mexcRow('BTC', '2')];
    result = await buildAccountDashboard(report, values(), () => NOW);
    expect(result.exchanges[0].status).toBe('error');
  });

  it('strips upstream identities, arbitrary extra fields and credentials from the dashboard projection', async () => {
    const report = pair();
    Object.assign(report, { credentials: { apiKey: 'PRIVATE_KEY' } });
    Object.assign(report.accounts.okx, { raw: 'PRIVATE_UPSTREAM', uid: 'PRIVATE_UID' });
    Object.assign(report.accounts.mexc.holdings[0], { label: 'PRIVATE_LABEL' });
    const result = await buildAccountDashboard(report, values(), () => NOW);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|credentials|apiKey|makerRate|takerRate|accountMode/);
  });

  it('rejects invalid clock rather than timestamping a fabricated fresh report', async () => {
    await expect(buildAccountDashboard(pair(), values(), () => NaN)).rejects.toThrow('portfolio-invalid-clock');
  });

  it('a stalled injected valuation source becomes a partial report with no old prices', async () => {
    vi.useFakeTimers();
    const result = buildAccountDashboard(pair(), { getPrices: async () => new Promise(() => {}) }, () => NOW);
    await vi.advanceTimersByTimeAsync(6_000);
    expect((await result).totals.portfolioUsdt).toBeNull();
  });
});

describe('fixed public last-price clients', () => {
  it('fetches only exact public endpoints with no credentials and no redirects', async () => {
    const request = vi.fn<typeof fetch>(async url => String(url).includes('mexc')
      ? Response.json([{ symbol: 'BTCUSDT', price: '100.000000000000000001' }, { symbol: 'BTCUSDC', price: '999' }])
      : Response.json(ticks([{ currency: 'BTC', price: '200.000000000000000001' }])));
    const client = new AccountValuationClient(request, () => NOW);
    expect((await client.getPrices('mexc', ['BTC', 'USDT'])).prices).toEqual({ BTC: '100.000000000000000001' });
    expect((await client.getPrices('okx', ['BTC', 'USDT'])).prices).toEqual({ BTC: '200.000000000000000001' });
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      'https://api.mexc.com/api/v3/ticker/price', 'https://www.okx.com/api/v5/market/tickers?instType=SPOT']);
    for (const [, options] of request.mock.calls) {
      expect(options).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store',
        headers: { Accept: 'application/json' } });
      expect(options?.body).toBeUndefined();
      expect(Object.keys(options?.headers ?? {})).toEqual(['Accept']);
    }
  });

  it('does not accept a duplicate direct market, a USD alias or a perpetual contract', async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ code: '0', data: [
      ...ticks([{ currency: 'BTC', price: '1' }, { currency: 'BTC', price: '2' }]).data,
      { instType: 'SPOT', instId: 'USDC-USD', last: '1', ts: String(NOW) },
      { instType: 'SWAP', instId: 'ETH-USDT-SWAP', last: '3000', ts: String(NOW) }
    ] }));
    expect((await new AccountValuationClient(request, () => NOW).getPrices('okx', ['BTC', 'USDC', 'ETH'])).prices).toEqual({});
  });

  it.each([0, 100, '1e-8', '-1', '0', 'NaN', 'PRIVATE_VALUE'])('leaves invalid price %s unknown', async price => {
    const client = new AccountValuationClient(async () => Response.json([{ symbol: 'BTCUSDT', price }]), () => NOW);
    expect((await client.getPrices('mexc', ['BTC'])).prices).toEqual({});
  });

  it('requires fresh source timestamps for OKX and never guesses missing source time', async () => {
    for (const ts of ['0', 'not-time', String(NOW - 120_001), String(NOW + 1_001)]) {
      const client = new AccountValuationClient(async () => Response.json(ticks([{ currency: 'BTC', price: '1', ts }])), () => NOW);
      expect((await client.getPrices('okx', ['BTC'])).prices).toEqual({});
    }
  });

  it('rejects oversized headers and streamed bodies at 4 MiB', async () => {
    const header = new AccountValuationClient(async () => new Response('[]', { headers: { 'content-length': String(4 * 1024 * 1024 + 1) } }), () => NOW);
    await expect(header.getPrices('mexc', ['BTC'])).rejects.toThrow('portfolio-public-too-large');
    const streamed = new AccountValuationClient(async () => new Response(new Uint8Array(4 * 1024 * 1024 + 1)), () => NOW);
    await expect(streamed.getPrices('mexc', ['BTC'])).rejects.toThrow('portfolio-public-too-large');
  });

  it('bounds the request and body deadline and redacts transport exceptions', async () => {
    vi.useFakeTimers();
    const client = new AccountValuationClient(async () => new Promise(() => {}), () => NOW);
    const pending = expect(client.getPrices('mexc', ['BTC'])).rejects.toThrow('portfolio-public-timeout');
    await vi.advanceTimersByTimeAsync(5_000); await pending;
    const redacted = new AccountValuationClient(async () => { throw new Error('PRIVATE_HEADERS_AND_KEY'); }, () => NOW);
    await expect(redacted.getPrices('mexc', ['BTC'])).rejects.toThrow(/^portfolio-public-unavailable$/);
  });

  it('rejects response redirects and input venue/path injection', async () => {
    const response = Response.json([]); Object.defineProperty(response, 'redirected', { value: true });
    const request = vi.fn<typeof fetch>(async () => response);
    const client = new AccountValuationClient(request, () => NOW);
    await expect(client.getPrices('mexc', ['BTC'])).rejects.toThrow('portfolio-public-unavailable');
    request.mockClear();
    await expect(client.getPrices('binance' as PairVenue, ['BTC'])).rejects.toThrow('portfolio-invalid-data');
    await expect(client.getPrices('mexc', ['BTC?PRIVATE_QUERY'])).rejects.toThrow('portfolio-invalid-data');
    expect(request).not.toHaveBeenCalled();
  });
});
