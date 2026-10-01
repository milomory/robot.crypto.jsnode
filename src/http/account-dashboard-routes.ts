import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ACCOUNT_DASHBOARD_MAX_AGE_MS, ACCOUNT_DASHBOARD_PATH,
  accountDashboardSchema, type AccountDashboard } from '../accounts/dashboard-contract.js';

const MAX_BYTES = 512 * 1024;
const emptyTotals = () => ({ portfolioUsdt: null, pricedUsdt: null,
  usdtBalance: null, availableUsdt: null, valuationComplete: false });

export async function readAccountDashboard(directory: string, now = Date.now()): Promise<AccountDashboard> {
  if (!Number.isSafeInteger(now) || now <= 0 || now > 8_640_000_000_000_000 || !isAbsolute(directory)) throw new Error();
  const parent = await lstat(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o022)) throw new Error();
  // NONBLOCK makes even a substituted FIFO fail at fstat instead of hanging the API.
  const file = await open(join(directory, 'current.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_BYTES || (info.mode & 0o077)) throw new Error();
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length <= MAX_BYTES) {
      const chunk = await file.read(bytes, length, bytes.length - length, null);
      if (chunk.bytesRead === 0) break;
      length += chunk.bytesRead;
    }
    if (length === 0 || length > MAX_BYTES) throw new Error();
    const report = accountDashboardSchema.parse(JSON.parse(bytes.subarray(0, length).toString('utf8')));
    if (report.observedAt > now || report.exchanges.some(row => row.observedAt !== null && row.observedAt > report.observedAt) ||
        report.operations.items.some(row => row.at > now) || (report.earn !== undefined && report.earn.okx.observedAt > now)) throw new Error();
    const reportExpired = now - report.observedAt > ACCOUNT_DASHBOARD_MAX_AGE_MS;
    const exchanges = report.exchanges.map(row => row.status === 'connected' &&
      (reportExpired || now - row.observedAt! > ACCOUNT_DASHBOARD_MAX_AGE_MS)
      ? { ...row, status: 'stale' as const } : row);
    const stale = report.status === 'stale' || reportExpired || exchanges.some(row => row.status === 'stale');
    return { ...report, exchanges, status: stale ? 'stale' : report.status,
      totals: exchanges.some(row => row.status !== 'connected') || stale ? emptyTotals() : report.totals };
  } finally { await file.close(); }
}

export function registerAccountDashboardRoutes(app: FastifyInstance, options: {
  directory: string; isAccountOwner: (request: FastifyRequest) => boolean; clock?: () => number
}) {
  app.get(ACCOUNT_DASHBOARD_PATH, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!options.isAccountOwner(request)) return reply.code(403).send({ ok: false, error: 'account_owner_required' });
    if (Object.keys(request.query as Record<string, unknown>).length !== 0) {
      return reply.code(400).send({ ok: false, error: 'invalid_dashboard_query' });
    }
    try { return await readAccountDashboard(options.directory, options.clock?.() ?? Date.now()); }
    catch { return reply.code(503).send({ ok: false, error: 'account_dashboard_unavailable' }); }
  });
}
