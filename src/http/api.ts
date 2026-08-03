import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { z } from 'zod';

import { getConfig } from '../config/env.js';
import type { DbPool } from '../db/pool.js';
import type { MarketTicker, PaperOrderRequest } from '../domain/types.js';
import { BinancePublicMarketDataAdapter } from '../exchange/binance-public-market-data.js';
import { isFallbackMarketTicker, type MarketDataAdapter } from '../exchange/exchange-adapter.js';
import { PaperExchange } from '../exchange/paper-exchange.js';
import { ResilientMarketDataAdapter } from '../exchange/resilient-market-data.js';
import { SeedMarketDataAdapter } from '../exchange/seed-market-data.js';
import { TradeJournalService } from '../journal/trade-journal.service.js';
import { RiskBudgetService } from '../risk/risk-budget.service.js';
import { AutoPaperTraderService } from '../services/auto-paper-trader.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const paperOrderSchema = z
  .object({
    symbol: z.string().min(3),
    side: z.enum(['buy', 'sell']),
    quoteValue: z.coerce.number().positive().optional(),
    baseQuantity: z.coerce.number().positive().optional(),
    reason: z.string().min(1).max(240).default('operator paper order')
  })
  .refine((body) => Boolean(body.quoteValue || body.baseQuantity), {
    message: 'quoteValue or baseQuantity is required'
  });

const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
  try {
    return await fn();
  } catch {
    return fallback;
  }
};

const asErrorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const parseBasicAuth = (authorization?: string) => {
  if (!authorization?.startsWith('Basic ')) {
    return undefined;
  }

  const decoded = Buffer.from(authorization.slice('Basic '.length), 'base64').toString('utf8');
  const separatorIndex = decoded.indexOf(':');

  if (separatorIndex === -1) {
    return undefined;
  }

  return {
    username: decoded.slice(0, separatorIndex),
    password: decoded.slice(separatorIndex + 1)
  };
};

const timingSafeStringEqual = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
};

const isPublicPath = (url: string): boolean => url === '/health' || url === '/favicon.ico';

const stateChangingMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const firstHeaderValue = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const normalizedHost = (value: string | string[] | undefined): string | undefined =>
  firstHeaderValue(value)?.split(',')[0]?.trim().toLowerCase();

const hostFromUrl = (value: string | undefined): string | undefined => {
  if (!value) {
    return undefined;
  }

  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return undefined;
  }
};

const isTrustedStateChangingRequest = (
  hostHeader: string | string[] | undefined,
  originHeader: string | string[] | undefined,
  refererHeader: string | string[] | undefined
): boolean => {
  const requestHost = normalizedHost(hostHeader);

  if (!requestHost) {
    return true;
  }

  const originHost = hostFromUrl(firstHeaderValue(originHeader));
  if (originHost) {
    return originHost === requestHost;
  }

  const refererHost = hostFromUrl(firstHeaderValue(refererHeader));
  return !refererHost || refererHost === requestHost;
};

const latestTickerFor = async (adapter: MarketDataAdapter, symbols: string[], symbol: string): Promise<MarketTicker> => {
  const tickers = await adapter.getTickers(Array.from(new Set([...symbols, symbol])));
  const ticker = tickers.find((item) => item.symbol === symbol);

  if (!ticker) {
    throw new Error(`No market ticker for ${symbol}`);
  }

  return ticker;
};

export const buildServer = async (pool: DbPool) => {
  const config = getConfig();
  const app = Fastify({ logger: true });
  const journal = new TradeJournalService(pool);
  const risk = new RiskBudgetService(config.risk);
  const marketData = new ResilientMarketDataAdapter(new BinancePublicMarketDataAdapter(), new SeedMarketDataAdapter());
  const paperExchange = new PaperExchange(journal, config.exchange.id, config.trading.paperFeePercent);
  const autoTrader = new AutoPaperTraderService(config, marketData, journal, risk, paperExchange);

  app.addHook('onRequest', async (request, reply) => {
    if (!config.dashboard.authEnabled || isPublicPath(request.url)) {
      return;
    }

    if (!config.dashboard.password) {
      return reply.code(503).send({
        ok: false,
        error: 'Dashboard authentication is enabled but DASHBOARD_PASSWORD is not configured'
      });
    }

    const credentials = parseBasicAuth(request.headers.authorization);
    const authorized =
      credentials &&
      timingSafeStringEqual(credentials.username, config.dashboard.username) &&
      timingSafeStringEqual(credentials.password, config.dashboard.password);

    if (!authorized) {
      return reply
        .header('www-authenticate', 'Basic realm="Crypto Robot"')
        .code(401)
        .send('Authentication required');
    }
  });

  app.addHook('preHandler', async (request, reply) => {
    if (!stateChangingMethods.has(request.method)) {
      return;
    }

    const hostHeader = request.headers['x-forwarded-host'] ?? request.headers.host;
    if (!isTrustedStateChangingRequest(hostHeader, request.headers.origin, request.headers.referer)) {
      return reply.code(403).send({
        ok: false,
        error: 'State-changing requests must originate from the dashboard origin'
      });
    }
  });

  const uiDist = path.resolve(__dirname, '../../ui/dist');
  const hasBuiltUi = existsSync(path.join(uiDist, 'index.html'));

  if (hasBuiltUi) {
    await app.register(fastifyStatic, {
      root: uiDist,
      prefix: '/',
      decorateReply: false
    });
  }

  app.get('/health', async () => ({ ok: true }));

  app.get('/favicon.ico', async (_request, reply) => reply.code(204).send());

  app.addHook('onReady', async () => {
    autoTrader.start();
  });

  app.addHook('onClose', async () => {
    autoTrader.stop();
  });

  app.get('/api/status', async () => {
    const database = await safe<{ ok: boolean; error?: string }>(async () => ({ ok: await journal.health() }), {
      ok: false,
      error: 'database unavailable'
    });

    return {
      ok: database.ok && config.trading.mode === 'paper' && config.trading.liveTradingLocked,
      mode: config.trading.mode,
      liveTradingLocked: config.trading.liveTradingLocked,
      dashboardAuth: config.dashboard.authEnabled ? 'enabled' : 'disabled',
      autoTrader: autoTrader.getStatus(),
      exchange: config.exchange.id,
      marketData: marketData.id,
      database,
      symbols: config.exchange.symbols,
      quoteCurrency: config.exchange.quoteCurrency,
      serverTime: new Date().toISOString()
    };
  });

  app.get('/api/runtime-config', async () => ({
    exchange: config.exchange,
    trading: config.trading,
    risk: config.risk,
    database: {
      host: config.db.host,
      port: config.db.port,
      database: config.db.database,
      user: config.db.user,
      ssl: config.db.ssl
    }
  }));

  app.get('/api/market/tickers', async () => {
    const tickers = await marketData.getTickers(config.exchange.symbols);
    return { tickers };
  });

  app.get('/api/risk-budget', async () => {
    const [dailyBuyQuoteUsage, realizedPnlQuote, positions] = await Promise.all([
      safe(() => journal.getDailyBuyQuoteUsage(), 0),
      safe(() => journal.getRealizedPnlQuote(), 0),
      safe(() => journal.listPositions(), [])
    ]);

    return {
      budget: risk.getBudget(),
      usage: {
        dailyBuyQuoteUsage,
        realizedPnlQuote,
        openPositions: positions.filter((position) => position.baseQuantity > 0).length
      }
    };
  });

  app.get('/api/journal', async () => {
    const [orders, trades, decisions] = await Promise.all([
      safe(() => journal.listOrders(), []),
      safe(() => journal.listTrades(), []),
      safe(() => journal.listDecisionJournal(), [])
    ]);

    return { orders, trades, decisions };
  });

  app.get('/api/positions', async () => ({
    positions: await safe(() => journal.listPositions(), [])
  }));

  app.get('/api/risk-events', async () => ({
    events: await safe(() => journal.listRiskEvents(), [])
  }));

  app.get('/api/auto-trader/status', async () => autoTrader.getStatus());

  app.post('/api/auto-trader/scan', async () => autoTrader.runScan('manual'));

  app.post('/api/paper/orders', async (request, reply) => {
    const parsed = paperOrderSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }

    const body = parsed.data;
    const symbol = body.symbol.toUpperCase();
    const ticker = await latestTickerFor(marketData, config.exchange.symbols, symbol);

    if (isFallbackMarketTicker(ticker)) {
      const message = 'fallback market data is disabled for paper order fills';
      await Promise.all([
        safe(
          () =>
            journal.recordRiskEvent({
              severity: 'critical',
              gate: 'market-data',
              symbol,
              decision: 'block',
              message,
              context: { tickerSource: ticker.exchange, observedAt: ticker.observedAt }
            }),
          undefined
        ),
        safe(
          () =>
            journal.recordDecision({
              symbol,
              signal: `${body.side}:operator-paper`,
              decision: 'block',
              reason: message,
              context: { ticker }
            }),
          undefined
        )
      ]);

      return reply.code(503).send({ ok: false, error: message });
    }

    const baseQuantity = body.baseQuantity ?? (body.quoteValue ?? 0) / ticker.lastPrice;
    const paperRequest: PaperOrderRequest = {
      symbol,
      side: body.side,
      type: 'market',
      baseQuantity,
      reason: body.reason
    };

    const [dailyBuyQuoteUsage, realizedPnlQuote, openPositions] = await Promise.all([
      safe(() => journal.getDailyBuyQuoteUsage(), 0),
      safe(() => journal.getRealizedPnlQuote(), 0),
      safe(() => journal.listPositions(), [])
    ]);

    const decision = risk.evaluateOrder(paperRequest, {
      mode: config.trading.mode,
      liveTradingLocked: config.trading.liveTradingLocked,
      allowedSymbols: config.exchange.symbols,
      dailyBuyQuoteUsage,
      realizedPnlQuote,
      openPositions,
      ticker,
      budget: risk.getBudget()
    });

    await Promise.all(decision.events.map((event) => safe(() => journal.recordRiskEvent(event), undefined)));

    if (decision.decision === 'block') {
      await safe(
        () =>
          journal.recordDecision({
            symbol,
            signal: `${body.side}:operator-paper`,
            decision: 'block',
            reason: decision.events.find((event) => event.decision === 'block')?.message ?? 'risk blocked',
            context: { request: paperRequest, events: decision.events }
          }),
        undefined
      );

      return reply.code(409).send({ ok: false, decision });
    }

    try {
      const fill = await paperExchange.placePaperOrder(paperRequest, ticker);
      await safe(
        () =>
          journal.recordDecision({
            symbol,
            signal: `${body.side}:operator-paper`,
            decision: 'allow',
            reason: 'paper order filled',
            context: { request: paperRequest, ticker, orderId: fill.order.id }
          }),
        undefined
      );

      return { ok: true, decision, fill };
    } catch (error) {
      await safe(
        () =>
          journal.recordRiskEvent({
            severity: 'critical',
            gate: 'paper-exchange',
            symbol,
            decision: 'block',
            message: asErrorMessage(error),
            context: { request: paperRequest }
          }),
        undefined
      );

      return reply.code(500).send({ ok: false, error: asErrorMessage(error) });
    }
  });

  app.post('/api/admin/live-unlock', async (_request, reply) =>
    reply.code(423).send({
      ok: false,
      error: 'Live trading is locked in the MVP. Add a private adapter and explicit operator approval first.'
    })
  );

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ ok: false, error: 'API route not found' });
    }

    if (hasBuiltUi) {
      return reply.sendFile('index.html');
    }

    return reply.code(404).send({ ok: false, error: 'UI is not built yet. Run npm run build:ui or npm run dev:ui.' });
  });

  return app;
};
