import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readHistory, updateHistory } from '../src/accounts/balance-history.js';
import { balanceHistorySchema, BALANCE_HISTORY_MAX_BYTES, BALANCE_HISTORY_RETENTION_MS, type BalanceHistory } from '../src/accounts/balance-history-contract.js';
import type { AccountDashboard, DashboardOperation } from '../src/accounts/dashboard-contract.js';

const NOW = 1_800_000_000_000;
const directories: string[] = [];
const none = () => {};
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'crypto-balance-history-'));
  directories.push(path); await chmod(path, 0o700); return path;
}
const transfer = (id: string, at: number, delta: Partial<DashboardOperation> = {}): DashboardOperation => ({
  id, venue: 'mexc', type: 'deposit', symbol: null, asset: 'USDT', side: null,
  amount: '3.000000000000000001', quoteAmount: null, fee: null, feeAsset: null,
  status: 'completed', at, isOpen: false, ...delta
});
function dashboard(at = NOW): AccountDashboard {
  return { schema: 1, observedAt: at, status: 'ready', liveExecutionEnabled: false,
    totals: { portfolioUsdt: '999', pricedUsdt: '999', usdtBalance: '1', availableUsdt: '1', valuationComplete: true },
    exchanges: (['mexc', 'okx'] as const).map((venue, i) => ({ venue, status: 'connected', observedAt: at,
      portfolioUsdt: i === 0 ? '0.100000000000000001' : '-0.2', pricedUsdt: i === 0 ? '0.100000000000000001' : '-0.2',
      usdtBalance: '0', availableUsdt: '0', valuationComplete: true, unpricedAssets: [], assets: [] })),
    operations: { status: 'not-connected', items: [], coverageLabel: 'История бирж ещё не подключена' } };
}
const point = (at: number) => ({ at, totalUsdt: '3', mexcUsdt: '1', okxUsdt: '2' });
async function seed(path: string, history: unknown) {
  await writeFile(join(path, 'balance-history.json'), JSON.stringify(history), { mode: 0o600 });
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('private exact balance history', () => {
  it('records the first real snapshot only, deriving signed total from the known exchange values', async () => {
    const path = await directory(), guard = vi.fn();
    expect(await updateHistory(path, dashboard(), guard, () => NOW)).toEqual({ written: true, pointCount: 1, transferCount: 0 });
    const history = await readHistory(path, NOW);
    expect(history).toEqual({ schema: 1, startedAt: NOW, updatedAt: NOW,
      points: [{ at: NOW, totalUsdt: '-0.099999999999999999', mexcUsdt: '0.100000000000000001', okxUsdt: '-0.2' }], transfers: [] });
    expect(guard).toHaveBeenCalledOnce();
    expect((await lstat(join(path, 'balance-history.json'))).mode & 0o777).toBe(0o600);
    expect(await readdir(path)).toEqual(['balance-history.json']);
  });

  it('preserves legacy values and records the actual expanded wallet basis without backfill', async () => {
    const path = await directory(); await updateHistory(path, dashboard(), none, () => NOW);
    const original = (await readHistory(path, NOW)).points[0];
    const report = dashboard(NOW + 300_000);
    report.exchanges[0].coverage = { basis: 'mexc-spot-futures', status: 'partial', scope: 'current-account',
      wallets: [{ id: 'spot', status: 'included', valueUsdt: '0.100000000000000001' },
        { id: 'futures', status: 'included', valueUsdt: '0' }, { id: 'earn', status: 'unsupported', valueUsdt: null }],
      assetBreakdown: 'spot' };
    report.exchanges[1].coverage = { basis: 'okx-account-total', status: 'complete', scope: 'current-account',
      wallets: [{ id: 'trading', status: 'included', valueUsdt: '-0.2' },
        { id: 'funding', status: 'included', valueUsdt: '0' }, { id: 'earn', status: 'included', valueUsdt: '0' },
        { id: 'classic', status: 'included', valueUsdt: '0' }],
      assetBreakdown: 'trading-funding' };
    await updateHistory(path, report, none, () => report.observedAt);
    const history = await readHistory(path, report.observedAt);
    expect(history.startedAt).toBe(NOW);
    expect(history.points[0]).toEqual(original);
    expect(history.points[0].basis).toBeUndefined();
    expect(history.points[1].basis).toEqual({ mexc: 'mexc-spot-futures', okx: 'okx-account-total' });
    // Unsupported wallets do not erase the known subtotal or pretend to add zero balances.
    expect(history.points[1].mexcUsdt).toBe('0.100000000000000001');
    expect(history.points[1].totalUsdt).toBe('-0.099999999999999999');
    const previousFile = await lstat(join(path, 'balance-history.json'));
    expect(await updateHistory(path, report, none, () => report.observedAt + 1))
      .toEqual({ written: false, pointCount: 2, transferCount: 0 });
    const repeatedFile = await lstat(join(path, 'balance-history.json'));
    expect(repeatedFile.ino).toBe(previousFile.ino);
    expect(repeatedFile.mtimeMs).toBe(previousFile.mtimeMs);
  });

  it('retains unknown sample gaps with their requested basis and rejects a duplicate basis change', async () => {
    const path = await directory(), report = dashboard();
    report.exchanges[1].coverage = { basis: 'okx-account-total', status: 'complete', scope: 'current-account',
      wallets: [{ id: 'trading', status: 'included', valueUsdt: '-0.2' },
        { id: 'funding', status: 'included', valueUsdt: '0' }, { id: 'earn', status: 'included', valueUsdt: '0' },
        { id: 'classic', status: 'included', valueUsdt: '0' }],
      assetBreakdown: 'trading-funding' };
    report.status = 'partial'; report.exchanges[1].portfolioUsdt = null; report.exchanges[1].valuationComplete = false;
    report.totals.portfolioUsdt = null; report.totals.valuationComplete = false;
    await updateHistory(path, report, none, () => NOW);
    const before = await readHistory(path, NOW);
    expect(before.points[0]).toMatchObject({ totalUsdt: null, okxUsdt: null,
      basis: { mexc: 'mexc-spot', okx: 'okx-account-total' } });
    report.exchanges[1].coverage.basis = 'okx-trading-funding';
    report.exchanges[1].coverage.status = 'partial';
    await expect(updateHistory(path, report, none, () => NOW)).rejects.toThrow('history-conflicting-point');
    expect(await readHistory(path, NOW)).toEqual(before);
  });

  it('strictly rejects invalid or private coverage fields in stored history', () => {
    const history = { schema: 1, startedAt: NOW, updatedAt: NOW,
      points: [{ ...point(NOW), basis: { mexc: 'mexc-spot', okx: 'okx-account-total' } }], transfers: [] };
    expect(balanceHistorySchema.safeParse(history).success).toBe(true);
    for (const basis of [{ mexc: 'okx-account-total', okx: 'okx-account-total' },
      { mexc: 'mexc-spot' }, { mexc: 'mexc-spot', okx: 'okx-account-total', private: 'PRIVATE_SENTINEL' }]) {
      expect(balanceHistorySchema.safeParse({ ...history, points: [{ ...point(NOW), basis }] }).success).toBe(false);
    }
  });

  it('does not rewrite an identical observedAt or duplicate completed transfer', async () => {
    const path = await directory(), report = dashboard();
    report.operations = { status: 'available', coverageLabel: 'Observed only', items: [transfer('t1', NOW)] };
    await updateHistory(path, report, none, () => NOW);
    const before = await lstat(join(path, 'balance-history.json'));
    expect(await updateHistory(path, report, none, () => NOW + 1)).toEqual({ written: false, pointCount: 1, transferCount: 1 });
    const after = await lstat(join(path, 'balance-history.json'));
    expect(after.ino).toBe(before.ino); expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('rejects a conflicting duplicate or timestamp rewind without overwriting the archive', async () => {
    const path = await directory(); await updateHistory(path, dashboard(), none, () => NOW);
    const before = await readFile(join(path, 'balance-history.json'));
    const conflicting = dashboard(); conflicting.exchanges[0].portfolioUsdt = '50';
    await expect(updateHistory(path, conflicting, none, () => NOW)).rejects.toThrow('history-conflicting-point');
    await expect(updateHistory(path, dashboard(NOW - 1), none, () => NOW)).rejects.toThrow('history-clock-rewind');
    expect(await readFile(join(path, 'balance-history.json'))).toEqual(before);
  });

  it('preserves a null gap while the independent healthy exchange series remains known', async () => {
    const path = await directory(); await updateHistory(path, dashboard(), none, () => NOW);
    const partial = dashboard(NOW + 300_000); partial.status = 'partial';
    partial.exchanges[1] = { ...partial.exchanges[1], status: 'error', observedAt: null,
      portfolioUsdt: null, pricedUsdt: null, usdtBalance: null, availableUsdt: null, valuationComplete: false };
    partial.totals = { portfolioUsdt: null, pricedUsdt: null, usdtBalance: null, availableUsdt: null, valuationComplete: false };
    await updateHistory(path, partial, none, () => partial.observedAt);
    await updateHistory(path, dashboard(NOW + 600_000), none, () => NOW + 600_000);
    const history = await readHistory(path, NOW + 600_000);
    expect(history.points).toHaveLength(3);
    expect(history.points[1]).toEqual({ at: NOW + 300_000, totalUsdt: null, mexcUsdt: '0.100000000000000001', okxUsdt: null });
    expect(history.points[2].totalUsdt).toBe('-0.099999999999999999');
  });

  it('records unknown valuations as null instead of using a priced subtotal', async () => {
    const path = await directory(), report = dashboard(); report.status = 'partial';
    report.exchanges[0] = { ...report.exchanges[0], valuationComplete: false, portfolioUsdt: null,
      pricedUsdt: '100', unpricedAssets: ['UNKNOWN'] };
    report.totals.portfolioUsdt = null; report.totals.valuationComplete = false;
    await updateHistory(path, report, none, () => NOW);
    expect((await readHistory(path, NOW)).points[0]).toEqual({ at: NOW, totalUsdt: null, mexcUsdt: null, okxUsdt: '-0.2' });
  });

  it('does not backfill old snapshots; stale per-venue data creates a null value', async () => {
    const path = await directory();
    await expect(updateHistory(path, dashboard(NOW - 600_001), none, () => NOW)).rejects.toThrow('history-clock-rewind');
    expect(await readdir(path)).toEqual([]);
    const report = dashboard(); report.exchanges[1].observedAt = NOW - 600_001;
    await updateHistory(path, report, none, () => NOW);
    expect((await readHistory(path, NOW)).points[0]).toMatchObject({ totalUsdt: null, mexcUsdt: '0.100000000000000001', okxUsdt: null });
  });

  it('stores only observed completed deposit/withdrawal markers within the chart window', async () => {
    const path = await directory(); await updateHistory(path, dashboard(), none, () => NOW);
    const report = dashboard(NOW + 300_000);
    report.operations = { status: 'partial', coverageLabel: 'Observed only', items: [
      transfer('good-in', NOW + 1), transfer('good-out', NOW + 2, { venue: 'okx', type: 'withdrawal', asset: 'BTC', amount: '0.01' }),
      transfer('old', NOW - 1), transfer('future', NOW + 300_001),
      transfer('pending', NOW + 3, { status: 'pending' }), transfer('open', NOW + 4, { isOpen: true }),
      transfer('trade', NOW + 5, { type: 'trade', side: 'buy' })
    ] };
    await updateHistory(path, report, none, () => report.observedAt);
    const history = await readHistory(path, report.observedAt);
    expect(history.transfers.map(row => row.id)).toEqual(['good-in', 'good-out']);
    expect(history.transfers[0]).toEqual({ id: 'good-in', venue: 'mexc', type: 'deposit', asset: 'USDT',
      amount: '3.000000000000000001', at: NOW + 1 });
    expect(JSON.stringify(history)).not.toMatch(/quoteAmount|fee|profit|netFlow|address|txId/);
  });

  it('rejects changing an observed transfer amount or recording a negative amount', async () => {
    const path = await directory(), first = dashboard();
    first.operations = { status: 'available', coverageLabel: 'Observed', items: [transfer('same', NOW)] };
    await updateHistory(path, first, none, () => NOW);
    const before = await readFile(join(path, 'balance-history.json'));
    const next = dashboard(NOW + 1);
    next.operations = { status: 'available', coverageLabel: 'Observed', items: [transfer('same', NOW, { amount: '100' })] };
    await expect(updateHistory(path, next, none, () => NOW + 1)).rejects.toThrow('history-conflicting-transfer');
    next.operations.items = [transfer('negative', NOW + 1, { amount: '-1' })];
    await expect(updateHistory(path, next, none, () => NOW + 1)).rejects.toThrow('history-invalid-data');
    expect(await readFile(join(path, 'balance-history.json'))).toEqual(before);
  });

  it('retains the rolling 30-day window and original collection start honestly', async () => {
    const path = await directory(), old = NOW - BALANCE_HISTORY_RETENTION_MS - 1;
    await seed(path, { schema: 1, startedAt: old, updatedAt: NOW - 1,
      points: [point(old), point(NOW - 1)], transfers: [
        { id: 'old', venue: 'mexc', type: 'deposit', asset: 'USDT', amount: '1', at: old }
      ] });
    await updateHistory(path, dashboard(), none, () => NOW);
    const history = await readHistory(path, NOW);
    expect(history.startedAt).toBe(old); expect(history.points.map(row => row.at)).toEqual([NOW - 1, NOW]);
    expect(history.transfers).toEqual([]);
  });

  it('bounds points at 9000 and transfers at 2000 by retaining newest records', async () => {
    const path = await directory(), start = NOW - 10_000;
    const transfers = Array.from({ length: 2000 }, (_, i) => ({ id: `t${i}`, venue: 'mexc' as const,
      type: 'deposit' as const, asset: 'USDT', amount: '1', at: start + i + 2 }));
    await seed(path, { schema: 1, startedAt: start, updatedAt: start + 8999,
      points: Array.from({ length: 9000 }, (_, i) => point(start + i)), transfers });
    const report = dashboard(); report.operations = { status: 'available', coverageLabel: 'Observed', items: [transfer('latest', NOW)] };
    await updateHistory(path, report, none, () => NOW);
    const history = await readHistory(path, NOW);
    expect(history.points).toHaveLength(9000); expect(history.points[0].at).toBe(start + 1);
    expect(history.transfers).toHaveLength(2000); expect(history.transfers[0].id).toBe('t1');
    expect(history.transfers.at(-1)?.id).toBe('latest');
  });

  it.each(['malformed', 'numeric-money', 'wrong-total', 'nonnull-unknown', 'unknown-field', 'duplicate-time', 'future'])
    ('rejects %s corruption without overwriting it', async kind => {
      const path = await directory();
      const history: any = { schema: 1, startedAt: NOW - 1, updatedAt: NOW, points: [point(NOW - 1), point(NOW)], transfers: [] };
      if (kind === 'numeric-money') history.points[0].totalUsdt = 3;
      if (kind === 'wrong-total') history.points[0].totalUsdt = '999';
      if (kind === 'nonnull-unknown') history.points[0].okxUsdt = null;
      if (kind === 'unknown-field') history.apiKey = 'PRIVATE_SENTINEL';
      if (kind === 'duplicate-time') history.points[0].at = NOW;
      if (kind === 'future') { history.updatedAt = NOW + 3; history.points[1].at = NOW + 3; }
      await seed(path, history);
      if (kind === 'malformed') await writeFile(join(path, 'balance-history.json'), '{PRIVATE_CORRUPTION');
      const before = await readFile(join(path, 'balance-history.json'));
      await expect(updateHistory(path, dashboard(NOW + 2), none, () => NOW + 2)).rejects.toThrow();
      if (kind === 'future') {
        await expect(readHistory(path, NOW)).rejects.toThrow();
      }
      expect(await readFile(join(path, 'balance-history.json'))).toEqual(before);
    });

  it('distinguishes only a missing file from unsafe/missing directory configuration', async () => {
    const path = await directory();
    await expect(readHistory(path, NOW)).rejects.toThrow('history-not-found');
    await expect(readHistory(join(path, 'missing'), NOW)).rejects.toThrow('history-invalid-file');
    await expect(readHistory('relative', NOW)).rejects.toThrow('history-invalid-file');
    await chmod(path, 0o755);
    await expect(readHistory(path, NOW)).rejects.toThrow('history-invalid-file');
  });

  it.each(['symlink', 'hardlink', 'public', 'directory', 'oversize'])('rejects unsafe history file %s', async kind => {
    const path = await directory(), file = join(path, 'balance-history.json');
    await updateHistory(path, dashboard(), none, () => NOW);
    if (kind === 'symlink') { await rm(file); await symlink('/dev/null', file); }
    if (kind === 'hardlink') await link(file, join(path, 'alias'));
    if (kind === 'public') await chmod(file, 0o644);
    if (kind === 'directory') { await rm(file); await mkdir(file, { mode: 0o700 }); }
    if (kind === 'oversize') await writeFile(file, ' '.repeat(BALANCE_HISTORY_MAX_BYTES + 1));
    await expect(readHistory(path, NOW)).rejects.toThrow('history-invalid-file');
    await expect(updateHistory(path, dashboard(NOW + 1), none, () => NOW + 1)).rejects.toThrow();
  });

  it('requires current process ownership for writes but permits a read by the API UID', async () => {
    const path = await directory(); await updateHistory(path, dashboard(), none, () => NOW);
    vi.spyOn(process, 'getuid').mockReturnValue(-1);
    expect((await readHistory(path, NOW)).points).toHaveLength(1);
    await expect(updateHistory(path, dashboard(NOW + 1), none, () => NOW + 1)).rejects.toThrow('history-invalid-file');
  });

  it('keeps the old archive when the secret assertion fails and writes no temporary file', async () => {
    const path = await directory(); await updateHistory(path, dashboard(), none, () => NOW);
    const before = await readFile(join(path, 'balance-history.json'));
    await expect(updateHistory(path, dashboard(NOW + 1), () => { throw Error('rejected'); }, () => NOW + 1)).rejects.toThrow('rejected');
    expect(await readFile(join(path, 'balance-history.json'))).toEqual(before);
    expect(await readdir(path)).toEqual(['balance-history.json']);
  });

  it('rejects invalid/future clocks and contract snapshots with arbitrary secret fields', async () => {
    const path = await directory();
    await expect(updateHistory(path, dashboard(), none, () => NaN)).rejects.toThrow('history-invalid-clock');
    await expect(updateHistory(path, dashboard(NOW + 1), none, () => NOW)).rejects.toThrow('history-invalid-clock');
    await expect(updateHistory(path, { ...dashboard(), apiKey: 'PRIVATE_KEY' } as AccountDashboard, none, () => NOW)).rejects.toThrow('history-invalid-data');
    expect(await readdir(path)).toEqual([]);
  });

  it('the shared contract requires exact two-venue sums and forbids signed transfer quantities', () => {
    const history: BalanceHistory = { schema: 1, startedAt: NOW, updatedAt: NOW, points: [point(NOW)], transfers: [] };
    expect(balanceHistorySchema.safeParse(history).success).toBe(true);
    history.points[0].totalUsdt = '3.00'; expect(balanceHistorySchema.safeParse(history).success).toBe(true);
    history.points[0].mexcUsdt = null; expect(balanceHistorySchema.safeParse(history).success).toBe(false);
    history.points[0].totalUsdt = null; expect(balanceHistorySchema.safeParse(history).success).toBe(true);
    history.transfers.push({ id: 'bad', venue: 'okx', type: 'withdrawal', asset: 'USDT', amount: '-1', at: NOW });
    expect(balanceHistorySchema.safeParse(history).success).toBe(false);
  });
});
