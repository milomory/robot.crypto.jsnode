import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { BalanceHistoryResponse } from '../accounts/balance-history-contract.js';
import { HistoryError, readHistory } from '../accounts/balance-history.js';
import { ACCOUNT_BALANCE_HISTORY_PATH } from '../auth/auth-core.js';

const windows = { '1d': 24 * 60 * 60_000, '7d': 7 * 24 * 60 * 60_000, '30d': 30 * 24 * 60 * 60_000 } as const;
type Range = keyof typeof windows;
function rangeFrom(url: string): Range | undefined {
  // Inspect the original query, including duplicate and otherwise parser-ignored
  // keys. Values never become a file path or an upstream request parameter.
  const entries = [...new URLSearchParams(url.split('?').slice(1).join('?')).entries()];
  if (entries.length === 0) return '1d';
  if (entries.length !== 1 || entries[0][0] !== 'range') return undefined;
  const value = entries[0][1];
  return value === '1d' || value === '7d' || value === '30d' ? value : undefined;
}

export function registerBalanceHistoryRoutes(app: FastifyInstance, options: {
  directory: string; isAccountOwner: (request: FastifyRequest) => boolean; clock?: () => number
}) {
  app.get(ACCOUNT_BALANCE_HISTORY_PATH, { exposeHeadRoute: false }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!options.isAccountOwner(request)) return reply.code(403).send({ ok: false, error: 'account_owner_required' });
    const range = rangeFrom(request.url);
    if (!range) return reply.code(400).send({ ok: false, error: 'invalid_balance_history_query' });
    try {
      const now = options.clock?.() ?? Date.now();
      if (!Number.isSafeInteger(now) || now <= 0 || now > 8_640_000_000_000_000) throw new Error();
      const response: BalanceHistoryResponse = { schema: 1, startedAt: null, updatedAt: null,
        range, from: now - windows[range], to: now, points: [], transfers: [], transfersCoverage: 'observed-only' };
      try {
        const history = await readHistory(options.directory, now);
        return { ...response, startedAt: history.startedAt, updatedAt: history.updatedAt,
          points: history.points.filter(point => point.at >= response.from && point.at <= response.to),
          transfers: history.transfers.filter(transfer => transfer.at >= response.from && transfer.at <= response.to) } satisfies BalanceHistoryResponse;
      } catch (error) {
        if (error instanceof HistoryError && error.reason === 'history-not-found') return response;
        throw error;
      }
    } catch { return reply.code(503).send({ ok: false, error: 'balance_history_unavailable' }); }
  });
}
