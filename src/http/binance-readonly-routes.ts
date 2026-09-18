import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config/env.js';
import { BinanceReadOnly, BinanceReadOnlyError } from '../exchange/binance-readonly.js';

const querySchema = z.object({
  symbol: z.string().min(3),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  fromId: z.string().regex(/^\d{1,19}$/).optional()
}).strict();

export const registerBinanceReadOnlyRoutes = (app: FastifyInstance, config: AppConfig) => {
  const connector = new BinanceReadOnly(config.binanceReadOnly);
  for (const kind of ['status', 'account', 'open-orders', 'trades'] as const) {
    app.get(`/api/exchanges/binance/${kind}`, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      // The parent authentication hook validates credentials; do not expose real
      // account data in development configurations where that hook is disabled.
      if (!config.dashboard.authEnabled || !config.dashboard.password) {
        return reply.code(503).send({ ok: false, error: 'Dashboard authentication is required for private exchange access' });
      }
      try {
        if (kind === 'status') return connector.status();
        if (kind === 'account') return { account: await connector.getAccount() };
        const query = querySchema.safeParse(request.query);
        if (!query.success) return reply.code(400).send({ ok: false, error: 'Invalid symbol, cursor or limit' });
        const { symbol, limit, fromId } = query.data;
        if (kind === 'open-orders') return { symbol, orders: await connector.getOpenOrders(symbol) };
        return { symbol, ...await connector.getTrades(symbol, limit, fromId) };
      } catch (error) {
        if (error instanceof BinanceReadOnlyError) {
          return reply.code(error.httpStatus).send({ ok: false, code: error.code, error: error.message });
        }
        return reply.code(502).send({ ok: false, error: 'Binance read-only request failed' });
      }
    });
  }
};
