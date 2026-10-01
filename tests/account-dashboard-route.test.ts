import { mkdtemp, writeFile, rm, chmod, symlink, link, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountDashboardSchema, type AccountDashboard } from '../src/accounts/dashboard-contract.js';
import { readAccountDashboard, registerAccountDashboardRoutes } from '../src/http/account-dashboard-routes.js';
import { collectOkxEarn } from '../src/accounts/earn-observation.js';
import { mexcEarnNotConnected } from '../src/accounts/mexc-earn.js';
import { getConfig } from '../src/config/env.js';

const now = 1_800_000_000_000;
const directories: string[] = [];
const fresh = (): AccountDashboard => ({ schema: 1, observedAt: now - 1000, status: 'ready',
  totals: { portfolioUsdt: '3', pricedUsdt: '3', usdtBalance: '3', availableUsdt: '2', valuationComplete: true },
  exchanges: (['mexc', 'okx'] as const).map((venue, i) => ({ venue, status: 'connected', observedAt: now - 2000,
    portfolioUsdt: String(i + 1), pricedUsdt: String(i + 1), usdtBalance: String(i + 1), availableUsdt: '1',
    valuationComplete: true, unpricedAssets: [], assets: [{ currency: 'USDT', total: String(i + 1),
      available: '1', locked: String(i), valueUsdt: String(i + 1) }] })),
  operations: { status: 'not-connected', items: [], coverageLabel: 'История бирж ещё не подключена' },
  liveExecutionEnabled: false });
async function directory(payload: unknown = fresh()) {
  const path = await mkdtemp(join(tmpdir(), 'crypto-owner-dashboard-')); directories.push(path);
  await chmod(path, 0o700);
  await writeFile(join(path, 'current.json'), JSON.stringify(payload), { mode: 0o600 });
  return path;
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('private dashboard projection', () => {
  it('returns exact decimal strings and independently reads atomic replacements', async () => {
    const report = fresh(); report.exchanges[0].assets[0].total = '1.000000000000000000000000000001';
    const path = await directory(report);
    expect((await readAccountDashboard(path, now)).exchanges[0].assets[0].total).toBe(report.exchanges[0].assets[0].total);
    report.observedAt += 1;
    await writeFile(join(path, 'next.json'), JSON.stringify(report), { mode: 0o600 });
    await rename(join(path, 'next.json'), join(path, 'current.json'));
    expect((await readAccountDashboard(path, now)).observedAt).toBe(report.observedAt);
  });
  it('marks an old account stale even when the report itself is newer, and suppresses combined totals', async () => {
    const report = fresh(); report.exchanges[0].observedAt = now - 600_001;
    const result = await readAccountDashboard(await directory(report), now);
    expect(result.status).toBe('stale');
    expect(result.exchanges.map(row => row.status)).toEqual(['stale', 'connected']);
    expect(result.exchanges[0].usdtBalance).toBe('1');
    expect(result.totals).toEqual({ portfolioUsdt: null, pricedUsdt: null, usdtBalance: null,
      availableUsdt: null, valuationComplete: false });
  });
  it('marks the complete report stale after ten minutes and preserves historical timestamps', async () => {
    const path = await directory();
    const result = await readAccountDashboard(path, now + 600_000);
    expect(result.status).toBe('stale');
    expect(result.exchanges.every(row => row.status === 'stale')).toBe(true);
    expect(result.observedAt).toBe(now - 1000);
    expect(result.totals.portfolioUsdt).toBeNull();
  });
  it('keeps missing prices partial, preserving priced subtotal without inventing the portfolio value', async () => {
    const report = fresh(); report.status = 'partial';
    Object.assign(report.exchanges[0], { portfolioUsdt: null, valuationComplete: false, unpricedAssets: ['UNKNOWN'] });
    report.exchanges[0].assets.push({ currency: 'UNKNOWN', total: '5', available: '5', locked: '0', valueUsdt: null });
    Object.assign(report.totals, { portfolioUsdt: null, valuationComplete: false });
    const result = await readAccountDashboard(await directory(report), now);
    expect(result.totals).toMatchObject({ portfolioUsdt: null, pricedUsdt: '3', valuationComplete: false });
  });
  it('does not reuse success after a failed exchange or malformed replacement', async () => {
    const path = await directory(); await readAccountDashboard(path, now);
    const report = fresh(); report.status = 'partial';
    Object.assign(report.exchanges[0], { status: 'error', observedAt: null, portfolioUsdt: null, pricedUsdt: null,
      usdtBalance: null, availableUsdt: null, valuationComplete: false, assets: [] });
    report.totals = { portfolioUsdt: null, pricedUsdt: null, usdtBalance: null, availableUsdt: null, valuationComplete: false };
    await writeFile(join(path, 'current.json'), JSON.stringify(report));
    const result = await readAccountDashboard(path, now);
    expect(result.exchanges[0].status).toBe('error'); expect(result.exchanges[1].usdtBalance).toBe('2');
    await writeFile(join(path, 'current.json'), '{private-invalid-json');
    await expect(readAccountDashboard(path, now)).rejects.toThrow();
  });
  it.each(['future-report', 'future-account', 'nan-clock', 'fractional-clock', 'unknown-field', 'numeric-money',
    'duplicate-venue', 'duplicate-asset', 'complete-unpriced', 'failed-venue-total', 'live-enabled'])('rejects %s', async kind => {
    const report = fresh() as any;
    let clock = now;
    if (kind === 'future-report') report.observedAt = now + 1;
    if (kind === 'future-account') report.exchanges[0].observedAt = now;
    if (kind === 'nan-clock') clock = NaN;
    if (kind === 'fractional-clock') clock = now + 0.5;
    if (kind === 'unknown-field') report.apiSecret = 'synthetic-private-marker';
    if (kind === 'numeric-money') report.totals.portfolioUsdt = 3;
    if (kind === 'duplicate-venue') report.exchanges[1].venue = 'mexc';
    if (kind === 'duplicate-asset') report.exchanges[0].assets.push(report.exchanges[0].assets[0]);
    if (kind === 'complete-unpriced') report.exchanges[0].unpricedAssets = ['BTC'];
    if (kind === 'failed-venue-total') report.exchanges[0].status = 'error';
    if (kind === 'live-enabled') report.liveExecutionEnabled = true;
    await expect(readAccountDashboard(await directory(report), clock)).rejects.toThrow();
  });
  it.each(['oversized', 'file-symlink', 'directory-symlink', 'hardlink', 'public-file', 'writable-directory', 'not-file'])('rejects unsafe filesystem %s', async kind => {
    const path = await directory(); let target = path;
    if (kind === 'oversized') await writeFile(join(path, 'current.json'), ' '.repeat(512 * 1024 + 1));
    if (kind === 'file-symlink') { await rename(join(path, 'current.json'), join(path, 'actual.json')); await symlink('actual.json', join(path, 'current.json')); }
    if (kind === 'directory-symlink') { target = join(path, 'alias'); await symlink(path, target); }
    if (kind === 'hardlink') await link(join(path, 'current.json'), join(path, 'other.json'));
    if (kind === 'public-file') await chmod(join(path, 'current.json'), 0o644);
    if (kind === 'writable-directory') await chmod(path, 0o777);
    if (kind === 'not-file') { await rm(join(path, 'current.json')); await mkdir(join(path, 'current.json')); }
    await expect(readAccountDashboard(target, now)).rejects.toThrow();
  });
  it('accepts bounded operation projections but rejects raw account fields and future dates', async () => {
    const report = fresh();
    report.operations = { status: 'partial', coverageLabel: 'Последние операции; охват неполный', items: [{
      id: 'okx:trade:123', venue: 'okx', type: 'trade', symbol: 'BTC/USDT', asset: 'BTC', side: 'buy',
      amount: '0.01', quoteAmount: '10', fee: '0.01', feeAsset: 'USDT', status: 'completed', at: now - 5000, isOpen: false
    }] };
    expect((await readAccountDashboard(await directory(report), now)).operations.items).toHaveLength(1);
    expect(accountDashboardSchema.safeParse({ ...report, operations: { ...report.operations,
      items: [{ ...report.operations.items[0], address: 'private-address' }] } }).success).toBe(false);
    report.operations.items[0].at = now + 1;
    await expect(readAccountDashboard(await directory(report), now)).rejects.toThrow();
  });
});

describe('private dashboard route', () => {
  it('requires owner capability before any report access and never leaks malformed text', async () => {
    const path = await directory({ leakedSecret: 'synthetic-private-marker' });
    let allowed = false;
    const app = Fastify(); registerAccountDashboardRoutes(app, { directory: path, isAccountOwner: () => allowed, clock: () => now });
    try {
      expect((await app.inject('/api/accounts/dashboard')).statusCode).toBe(403);
      allowed = true;
      const reply = await app.inject('/api/accounts/dashboard');
      expect(reply.statusCode).toBe(503); expect(reply.headers['cache-control']).toBe('no-store');
      expect(reply.json()).toEqual({ ok: false, error: 'account_dashboard_unavailable' });
      expect(reply.body).not.toContain('synthetic-private-marker');
    } finally { await app.close(); }
  });
  it('serves the validated projection with no-store and rejects arbitrary selectors', async () => {
    const path = await directory(); const app = Fastify();
    registerAccountDashboardRoutes(app, { directory: path, isAccountOwner: () => true, clock: () => now });
    try {
      const result = await app.inject('/api/accounts/dashboard');
      expect(result.statusCode).toBe(200); expect(result.json()).toEqual(fresh());
      expect(result.headers['cache-control']).toBe('no-store');
      expect((await app.inject('/api/accounts/dashboard?path=/etc/passwd')).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: '/api/accounts/dashboard' })).statusCode).toBe(404);
    } finally { await app.close(); }
  });
  it('requires an explicit UUID owner subset and defaults to no owner', () => {
    const id = '12345678-1234-4234-8234-123456789abc';
    vi.stubEnv('AUTH_CORE_VIEWER_IDS', id); vi.stubEnv('AUTH_CORE_OWNER_IDS', '');
    expect(getConfig().authCore.ownerIds).toEqual([]);
    vi.stubEnv('AUTH_CORE_OWNER_IDS', id); expect(getConfig().authCore.ownerIds).toEqual([id]);
    for (const invalid of ['admin', '22345678-1234-4234-8234-123456789abc', `${id},${id}`]) {
      vi.stubEnv('AUTH_CORE_OWNER_IDS', invalid);
      expect(() => getConfig()).toThrow('Invalid account owner authorization configuration');
    }
  });
});


describe('independent Earn projection', () => {
  async function earned() {
    return { okx: await collectOkxEarn({
      getEarnBalance: async () => ({ currency: 'USDT', amount: '105.000001', lendingAmount: '100', pendingAmount: '5.000001', reportedEarnings: '0.12' }),
      getEarnHistoryPage: async () => [{ currency: 'USDT', amount: '100', earnings: '0.0000123456789', at: now - 3600000 }]
    }, { clock: () => now }), mexc: mexcEarnNotConnected() };
  }
  it('keeps product principal and accrued income out of portfolio totals', async () => {
    const report = fresh(); report.earn = await earned();
    const value = await readAccountDashboard(await directory(report), now);
    expect(value.earn?.okx.principalUsdt).toBe('105.000001');
    expect(value.earn?.okx.periods.days7.recordedEarningsUsdt).toBe('0.0000123456789');
    expect(value.earn?.okx.periods.days7.coverage).toBe('partial');
    expect(value.earn?.mexc.principalUsdt).toBeNull();
    expect(value.totals).toEqual(fresh().totals);
  });
  it('accepts unavailable Earn while preserving valid balances', async () => {
    const report = fresh(); report.earn = { okx: await collectOkxEarn({
      getEarnBalance: async () => { throw new Error('PRIVATE'); },
      getEarnHistoryPage: async () => { throw new Error('PRIVATE'); }
    }, { clock: () => now }), mexc: mexcEarnNotConnected() };
    const value = await readAccountDashboard(await directory(report), now);
    expect(value.earn?.okx.status).toBe('unavailable');
    expect(value.totals).toEqual(fresh().totals);
    expect(JSON.stringify(value)).not.toContain('PRIVATE');
  });
  it('rejects future Earn evidence, unexpected text and invented MEXC earnings', async () => {
    const report = fresh(); report.earn = await earned();
    await expect(readAccountDashboard(await directory(report), now - 1)).rejects.toThrow();
    const text = structuredClone(report) as any; text.earn.okx.serverMessage = 'PRIVATE';
    expect(accountDashboardSchema.safeParse(text).success).toBe(false);
    const fabricated = structuredClone(report) as any; fabricated.earn.mexc.accrued7dUsdt = '0';
    expect(accountDashboardSchema.safeParse(fabricated).success).toBe(false);
  });
});
