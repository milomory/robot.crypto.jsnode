import { describe, expect, it, vi } from 'vitest';
import { extendAccountCoverage, observeAccountCoverage, type AccountCoverageReads } from '../src/accounts/account-coverage.js';
import { AccountError } from '../src/accounts/types.js';
import { accountDashboardSchema, type AccountDashboard } from '../src/accounts/dashboard-contract.js';
const NOW = 1_800_000_000_000;
const base = (): AccountDashboard => ({ schema: 1, observedAt: NOW, status: 'ready', liveExecutionEnabled: false,
  totals: { portfolioUsdt: '12', pricedUsdt: '12', availableUsdt: '10', usdtBalance: '10', valuationComplete: true },
  exchanges: (['mexc', 'okx'] as const).map((venue, i) => ({ venue, status: 'connected', observedAt: NOW - 2000,
    portfolioUsdt: i ? '2' : '10', pricedUsdt: i ? '2' : '10', usdtBalance: '5', availableUsdt: '5',
    valuationComplete: true, unpricedAssets: [], assets: [{ currency: 'USDT', total: '5', available: '5', locked: '0', valueUsdt: '5' }] })),
  operations: { status: 'available', items: [], coverageLabel: 'Synthetic' } });
const reads = (): AccountCoverageReads => ({
  mexc: { status: 'available', requestedAt: NOW - 1000, receivedAt: NOW, value: {
    venue: 'mexc', account: 'futures', requestedAt: NOW - 1000, receivedAt: NOW, balances: [
      { currency: 'USDT', equity: '3.000000000000000001', bonus: '0', debtAmount: '0', availableBalance: '2', availableCash: '2' }] } },
  okx: { status: 'available', requestedAt: NOW - 1000, receivedAt: NOW, value: {
    venue: 'okx', currency: 'USDT', totalUsdt: '102', updatedAt: String(NOW),
    wallets: { trading: '2', funding: '0', earn: '100', classic: '0' }, breakdownMatchesTotal: true } }
});
const prices = { getPrices: vi.fn(async () => ({ venue: 'mexc' as const, requestedAt: NOW, receivedAt: NOW, prices: { BTC: '100' } })) };

describe('account wallet coverage', () => {
  it('uses official OKX total once, adds independent MEXC equity exactly, keeps liquidity scoped', async () => {
    const before = base(), report = await extendAccountCoverage(before, reads(), prices, () => NOW);
    expect(report.exchanges[1]).toMatchObject({ portfolioUsdt: '102', availableUsdt: '5', usdtBalance: '5',
      coverage: { basis: 'okx-account-total', status: 'complete', scope: 'current-account', wallets: [
        { id: 'trading', valueUsdt: '2' }, { id: 'funding', valueUsdt: '0' }, { id: 'earn', valueUsdt: '100' }, { id: 'classic', valueUsdt: '0' }] } });
    expect(report.exchanges[0]).toMatchObject({ portfolioUsdt: '13.000000000000000001', coverage: {
      basis: 'mexc-spot-futures', status: 'partial', wallets: [{ id: 'spot', valueUsdt: '10' },
        { id: 'futures', valueUsdt: '3.000000000000000001' }, { id: 'earn', status: 'unsupported', valueUsdt: null }] } });
    expect(report.totals.portfolioUsdt).toBe('115.000000000000000001');
    expect(report.totals.availableUsdt).toBe('10');
    expect(report.status).toBe('partial'); // Missing MEXC Earn is not an empty wallet.
    expect(before).toEqual(base());
  });
  it('preserves official total even when separately updated breakdown differs', async () => {
    const extra = reads(); if (extra.okx.status === 'available') { extra.okx.value.totalUsdt = '101.99'; extra.okx.value.breakdownMatchesTotal = false; }
    const report = await extendAccountCoverage(base(), extra, prices, () => NOW);
    expect(report.exchanges[1].portfolioUsdt).toBe('101.99');
    expect(report.exchanges[1].coverage?.breakdownMatchesTotal).toBe(false);
  });
  it('failed OKX total retains labelled subtotal but cannot become full total/history', async () => {
    const extra = reads(); extra.okx = { status: 'unavailable', reason: 'read-failed' };
    const report = await extendAccountCoverage(base(), extra, prices, () => NOW);
    expect(report.exchanges[1]).toMatchObject({ portfolioUsdt: null, pricedUsdt: '2', valuationComplete: false,
      coverage: { basis: 'okx-trading-funding', status: 'partial' } });
    expect(report.totals.portfolioUsdt).toBeNull();
  });
  it('futures permission failure preserves Spot and explicitly unknown futures', async () => {
    const extra = reads(); extra.mexc = { status: 'unavailable', reason: 'read-failed' };
    const report = await extendAccountCoverage(base(), extra, prices, () => NOW);
    expect(report.exchanges[0]).toMatchObject({ portfolioUsdt: '10', coverage: { basis: 'mexc-spot', status: 'partial',
      wallets: [{ id: 'spot', valueUsdt: '10' }, { id: 'futures', status: 'unavailable', valueUsdt: null },
        { id: 'earn', status: 'unsupported', valueUsdt: null }] } });
  });
  it.each(['bonus', 'debtAmount'] as const)('does not invent equity netting for unknown/nonzero %s', async key => {
    for (const value of [null, '1']) {
      const extra = reads(); if (extra.mexc.status === 'available') extra.mexc.value.balances[0][key] = value;
      const report = await extendAccountCoverage(base(), extra, prices, () => NOW);
      expect(report.exchanges[0].portfolioUsdt).toBe('10');
      expect(report.exchanges[0].coverage?.wallets[1]).toMatchObject({ status: 'unavailable', valueUsdt: null, reason: 'ambiguous-equity' });
    }
  });
  it('prices non-USDT futures equity independently without cash or unrealized duplication', async () => {
    const extra = reads(); if (extra.mexc.status === 'available') Object.assign(extra.mexc.value.balances[0], { currency: 'BTC', equity: '0.01' });
    const report = await extendAccountCoverage(base(), extra, prices, () => NOW);
    expect(report.exchanges[0].portfolioUsdt).toBe('11');
    expect(report.exchanges[0].assets).toEqual(base().exchanges[0].assets);
  });
  it('missing futures price is partial, never a made-up zero', async () => {
    const extra = reads(); if (extra.mexc.status === 'available') Object.assign(extra.mexc.value.balances[0], { currency: 'UNKNOWN', equity: '1' });
    const report = await extendAccountCoverage(base(), extra, prices, () => NOW);
    expect(report.exchanges[0]).toMatchObject({ portfolioUsdt: null, pricedUsdt: '10', valuationComplete: false, unpricedAssets: ['UNKNOWN'] });
  });
  it.each(['old-source', 'future-source', 'old-read', 'reversed-read'] as const)('refuses OKX %s', async kind => {
    const extra = reads(); if (extra.okx.status === 'available') {
      if (kind === 'old-source') extra.okx.value.updatedAt = String(NOW - 120001);
      if (kind === 'future-source') extra.okx.value.updatedAt = String(NOW + 1);
      if (kind === 'old-read') extra.okx.requestedAt = NOW - 120001;
      if (kind === 'reversed-read') extra.okx.receivedAt = extra.okx.requestedAt - 1;
    }
    expect((await extendAccountCoverage(base(), extra, prices, () => NOW)).exchanges[1].portfolioUsdt).toBeNull();
  });
  it('strict schema rejects duplicate wallets, false completeness and venue mixing', async () => {
    const report = await extendAccountCoverage(base(), reads(), prices, () => NOW);
    const duplicate = structuredClone(report); duplicate.exchanges[0].coverage!.wallets.push(duplicate.exchanges[0].coverage!.wallets[0]);
    expect(accountDashboardSchema.safeParse(duplicate).success).toBe(false);
    const falseComplete = structuredClone(report); falseComplete.exchanges[0].coverage!.status = 'complete';
    expect(accountDashboardSchema.safeParse(falseComplete).success).toBe(false);
    const mixed = structuredClone(report); mixed.exchanges[0].coverage!.basis = 'okx-account-total';
    expect(accountDashboardSchema.safeParse(mixed).success).toBe(false);
    const missing = structuredClone(report); missing.exchanges[1].coverage!.wallets.pop();
    expect(accountDashboardSchema.safeParse(missing).success).toBe(false);
    const wrongAssets = structuredClone(report); wrongAssets.exchanges[1].coverage!.assetBreakdown = 'spot';
    expect(accountDashboardSchema.safeParse(wrongAssets).success).toBe(false);
    const falseBasis = structuredClone(report); falseBasis.exchanges[1].coverage!.basis = 'okx-trading-funding';
    expect(accountDashboardSchema.safeParse(falseBasis).success).toBe(false);
  });
});
describe('additional GET orchestration', () => {
  it('isolates a failed wallet read and saves only safe rate metadata', async () => {
    const onRateLimit = vi.fn(async () => {}), extra = reads();
    const result = await observeAccountCoverage({ getBalances: async () => { throw new AccountError('account-rate-limited'); } },
      { getAssetValuation: async () => extra.okx.status === 'available' ? extra.okx.value : Promise.reject() },
      { clock: () => NOW, deadline: NOW + 10000, onRateLimit });
    expect(result.mexc).toEqual({ status: 'unavailable', reason: 'rate-limited' });
    expect(result.okx.status).toBe('available'); expect(onRateLimit).toHaveBeenCalledWith('mexc');
  });
  it('isolates cooldown-save failure without discarding the healthy venue', async () => {
    const extra = reads();
    const result = await observeAccountCoverage({ getBalances: async () => { throw new AccountError('account-rate-limited'); } },
      { getAssetValuation: async () => extra.okx.status === 'available' ? extra.okx.value : Promise.reject() },
      { clock: () => NOW, deadline: NOW + 10000, onRateLimit: async () => { throw new Error('PRIVATE_FILESYSTEM'); } });
    expect(result.mexc).toEqual({ status: 'unavailable', reason: 'rate-limited' });
    expect(result.okx.status).toBe('available');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_FILESYSTEM');
  });
  it('does not begin a read without enough bounded time left', async () => {
    const mexc = { getBalances: vi.fn() }, okx = { getAssetValuation: vi.fn() };
    const result = await observeAccountCoverage(mexc, okx, { clock: () => NOW, deadline: NOW + 5999 });
    expect(mexc.getBalances).not.toHaveBeenCalled(); expect(okx.getAssetValuation).not.toHaveBeenCalled();
    expect(result.mexc.status).toBe('unavailable'); expect(result.okx.status).toBe('unavailable');
  });
});
