import { constants, type Stats } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { accountDashboardSchema, ACCOUNT_DASHBOARD_MAX_AGE_MS, type AccountDashboard } from './dashboard-contract.js';
import { balanceHistorySchema, BALANCE_HISTORY_MAX_BYTES, BALANCE_HISTORY_RETENTION_MS,
  BALANCE_HISTORY_MAX_POINTS, BALANCE_HISTORY_MAX_TRANSFERS, sumHistoryAmounts, type BalanceHistory,
  type BalanceHistoryPoint, type BalanceHistoryTransfer } from './balance-history-contract.js';

const NAME = 'balance-history.json';
type Reason = 'history-not-found' | 'history-invalid-file' | 'history-invalid-data' |
  'history-invalid-clock' | 'history-clock-rewind' | 'history-conflicting-point' | 'history-conflicting-transfer';
export class HistoryError extends Error {
  constructor(readonly reason: Reason) { super(reason); this.name = 'HistoryError'; }
}
function validTime(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 8_640_000_000_000_000) {
    throw new HistoryError('history-invalid-clock');
  }
}
async function directoryInfo(directory: string, owner: boolean) {
  if (!isAbsolute(directory)) throw new HistoryError('history-invalid-file');
  const info = await lstat(directory).catch(() => { throw new HistoryError('history-invalid-file'); });
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 ||
    (owner && info.uid !== process.getuid?.())) throw new HistoryError('history-invalid-file');
}
function regular(info: Stats, owner: boolean): void {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 ||
    info.size > BALANCE_HISTORY_MAX_BYTES || (owner && info.uid !== process.getuid?.())) {
    throw new HistoryError('history-invalid-file');
  }
}
function projected(raw: unknown): BalanceHistory {
  const result = balanceHistorySchema.safeParse(raw);
  if (!result.success) throw new HistoryError('history-invalid-data');
  return result.data;
}
/** Standalone read of the private archive; API may run as a different UID.
 * Missing history is distinct from corrupt history. Neither case writes files.
 */
export async function readHistory(directory: string, now = Date.now()): Promise<BalanceHistory> {
  validTime(now);
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await directoryInfo(directory, false);
    file = await open(join(directory, NAME), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await file.stat(); regular(before, false);
    const bytes = Buffer.alloc(BALANCE_HISTORY_MAX_BYTES + 1);
    let length = 0;
    while (length <= BALANCE_HISTORY_MAX_BYTES) {
      const chunk = await file.read(bytes, length, bytes.length - length, null);
      if (chunk.bytesRead === 0) break;
      length += chunk.bytesRead;
    }
    if (length === 0 || length > BALANCE_HISTORY_MAX_BYTES) throw new HistoryError('history-invalid-file');
    const after = await file.stat(); regular(after, false);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || length !== after.size) {
      throw new HistoryError('history-invalid-file');
    }
    let raw: unknown;
    try { raw = JSON.parse(bytes.subarray(0, length).toString('utf8')); }
    catch { throw new HistoryError('history-invalid-data'); }
    const history = projected(raw);
    if (history.updatedAt > now) throw new HistoryError('history-clock-rewind');
    return history;
  } catch (error) {
    if (error instanceof HistoryError) throw error;
    throw new HistoryError((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'history-not-found' : 'history-invalid-file');
  } finally { await file?.close(); }
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const transferKey = (transfer: BalanceHistoryTransfer) => `${transfer.venue}:${transfer.type}:${transfer.id}`;
function pointFrom(dashboard: AccountDashboard, now: number): BalanceHistoryPoint {
  const snapshotFresh = dashboard.status !== 'stale' && dashboard.status !== 'unavailable' &&
    now - dashboard.observedAt <= ACCOUNT_DASHBOARD_MAX_AGE_MS;
  const value = (venue: 'mexc' | 'okx'): string | null => {
    const exchange = dashboard.exchanges.find(row => row.venue === venue)!;
    return snapshotFresh && exchange.status === 'connected' && exchange.valuationComplete &&
      exchange.observedAt !== null && exchange.observedAt <= dashboard.observedAt &&
      now - exchange.observedAt <= ACCOUNT_DASHBOARD_MAX_AGE_MS ? exchange.portfolioUsdt : null;
  };
  const mexcUsdt = value('mexc'), okxUsdt = value('okx');
  const mexcBasis = dashboard.exchanges.find(row => row.venue === 'mexc')!.coverage?.basis;
  const okxBasis = dashboard.exchanges.find(row => row.venue === 'okx')!.coverage?.basis;
  if ((mexcBasis && !['mexc-spot', 'mexc-spot-futures'].includes(mexcBasis)) ||
      (okxBasis && !['okx-trading-funding', 'okx-account-total'].includes(okxBasis))) throw new HistoryError('history-invalid-data');
  const basis: BalanceHistoryPoint['basis'] = mexcBasis || okxBasis ? {
    mexc: mexcBasis === 'mexc-spot-futures' ? mexcBasis : 'mexc-spot',
    okx: okxBasis === 'okx-account-total' ? okxBasis : 'okx-trading-funding'
  } : undefined;
  return { at: dashboard.observedAt,
    totalUsdt: mexcUsdt !== null && okxUsdt !== null ? sumHistoryAmounts(mexcUsdt, okxUsdt) : null,
    mexcUsdt, okxUsdt, ...(basis ? { basis } : {}) };
}
/** Caller serializes publishers with the existing observer flock. No exchange
 * calls occur here. Returns metadata only; archive values must never be logged.
 */
export async function updateHistory(directory: string, dashboard: AccountDashboard,
  assertNoSecrets: (text: string) => void, clock = Date.now): Promise<{
    written: boolean; pointCount: number; transferCount: number;
  }> {
  let now: number;
  try { now = clock(); } catch { throw new HistoryError('history-invalid-clock'); }
  validTime(now);
  const parsed = accountDashboardSchema.safeParse(dashboard);
  if (!parsed.success) throw new HistoryError('history-invalid-data');
  dashboard = parsed.data;
  if (dashboard.observedAt > now || dashboard.exchanges.some(row => row.observedAt !== null && row.observedAt > dashboard.observedAt)) {
    throw new HistoryError('history-invalid-clock');
  }
  await directoryInfo(directory, true);
  let previous: BalanceHistory | undefined;
  let identity: { ino: number; dev: number } | undefined;
  try {
    const info = await lstat(join(directory, NAME)); regular(info, true);
    identity = { ino: info.ino, dev: info.dev };
    previous = await readHistory(directory, now);
  } catch (error) {
    if (!(error instanceof HistoryError && error.reason === 'history-not-found') &&
      (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (previous && dashboard.observedAt < previous.updatedAt) throw new HistoryError('history-clock-rewind');
  if (now - dashboard.observedAt > ACCOUNT_DASHBOARD_MAX_AGE_MS) throw new HistoryError('history-clock-rewind');
  const point = pointFrom(dashboard, now);
  const duplicate = previous?.updatedAt === point.at;
  if (duplicate && !same(previous!.points.at(-1), point)) throw new HistoryError('history-conflicting-point');
  const cutoff = now - BALANCE_HISTORY_RETENTION_MS;
  const points = (previous ? duplicate ? [...previous.points] : [...previous.points, point] : [point])
    .filter(row => row.at >= cutoff).slice(-BALANCE_HISTORY_MAX_POINTS);
  const startedAt = previous?.startedAt ?? point.at;
  const transfers = new Map((previous?.transfers ?? []).map(row => [transferKey(row), row]));
  if (['available', 'partial'].includes(dashboard.operations.status)) {
    for (const operation of dashboard.operations.items) {
      if (!['deposit', 'withdrawal'].includes(operation.type) || operation.status !== 'completed' || operation.isOpen ||
        operation.at < startedAt || operation.at > dashboard.observedAt || operation.at < cutoff) continue;
      const marker: BalanceHistoryTransfer = { id: operation.id, venue: operation.venue,
        type: operation.type as 'deposit' | 'withdrawal', asset: operation.asset, amount: operation.amount, at: operation.at };
      const key = transferKey(marker), existing = transfers.get(key);
      if (existing && !same(existing, marker)) throw new HistoryError('history-conflicting-transfer');
      transfers.set(key, marker);
    }
  }
  const retainedTransfers = [...transfers.values()].filter(row => row.at >= cutoff && row.at >= points[0].at)
    .sort((a, b) => a.at - b.at || transferKey(a).localeCompare(transferKey(b))).slice(-BALANCE_HISTORY_MAX_TRANSFERS);
  const history = projected({ schema: 1, startedAt, updatedAt: point.at, points, transfers: retainedTransfers });
  const encoded = JSON.stringify(history);
  if (Buffer.byteLength(encoded) > BALANCE_HISTORY_MAX_BYTES) throw new HistoryError('history-invalid-file');
  assertNoSecrets(encoded);
  if (previous && same(previous, history)) return { written: false, pointCount: points.length, transferCount: retainedTransfers.length };
  const temporary = join(directory, `.${NAME}.${randomUUID()}`), destination = join(directory, NAME);
  let created = false;
  try {
    await directoryInfo(directory, true);
    try {
      const current = await lstat(destination); regular(current, true);
      if (!identity || current.ino !== identity.ino || current.dev !== identity.dev) throw new HistoryError('history-invalid-file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || identity) throw error;
    }
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    try { await file.writeFile(encoded); await file.sync(); } finally { await file.close(); }
    await rename(temporary, destination); created = false;
    return { written: true, pointCount: points.length, transferCount: retainedTransfers.length };
  } finally { if (created) await unlink(temporary).catch(() => {}); }
}
