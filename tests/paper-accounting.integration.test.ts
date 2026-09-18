import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { runMigrations } from '../src/db/migrate.js';
import { buildServer } from '../src/http/api.js';
import { BinancePublicMarketDataAdapter } from '../src/exchange/binance-public-market-data.js';
import { PaperExchange } from '../src/exchange/paper-exchange.js';
import { PaperRiskBlockedError, TradeJournalService } from '../src/journal/trade-journal.service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
// This suite destroys test data. Never accept a production database name or remote host.
if (databaseUrl) {
  const url = new URL(databaseUrl);
  if (url.pathname !== '/robot_crypto_test' || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error('TEST_DATABASE_URL must use localhost and database robot_crypto_test');
  }
}

describe.skipIf(!databaseUrl)('paper accounting with isolated PostgreSQL', () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 1000 });
  const journal = new TradeJournalService(pool);
  const budget = { maxOrderQuote: 1000, dailyQuoteBudget: 10000, maxDailyLossQuote: 30,
    maxOpenPositions: 5, maxSymbolExposureQuote: 10000, maxSpreadPercent: 0.25 };
  const ticker = (price = 100, symbol = 'BTC/USDT') => ({
    exchange: 'binance', symbol, lastPrice: price, bid: price, ask: price, observedAt: new Date()
  });
  const fill = (side: 'buy' | 'sell', price = 100, quantity = 1, symbol = 'BTC/USDT', riskBudget = budget) =>
    journal.createPaperFill({ exchange: 'binance', price, feePercent: 0,
      request: { symbol, side, type: 'market', baseQuantity: quantity, reason: 'integration test' },
      riskContext: { mode: 'paper', liveTradingLocked: true, allowedSymbols: ['BTC/USDT', 'ETH/USDT'],
        ticker: ticker(price, symbol), budget: riskBudget }
    });

  beforeAll(async () => { await runMigrations(pool); });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await pool.query('TRUNCATE app.trades, app.orders, app.positions, app.risk_events, app.decision_journal');
  });
  afterAll(async () => { vi.restoreAllMocks(); await pool.end(); });

  it('serializes the global budget across concurrent symbols', async () => {
    const riskBudget = { ...budget, dailyQuoteBudget: 250 };
    await fill('buy', 100, 2.2, 'BTC/USDT', riskBudget);
    const results = await Promise.allSettled([
      fill('buy', 100, 0.25, 'BTC/USDT', riskBudget),
      fill('buy', 100, 0.25, 'ETH/USDT', riskBudget)
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const rejection = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejection.reason).toBeInstanceOf(PaperRiskBlockedError);
    expect(await journal.getDailyBuyQuoteUsage()).toBeCloseTo(245);
  });

  it('serializes the open position limit across symbols', async () => {
    const riskBudget = { ...budget, maxOpenPositions: 1 };
    const results = await Promise.allSettled([
      fill('buy', 100, 1, 'BTC/USDT', riskBudget), fill('buy', 100, 1, 'ETH/USDT', riskBudget)
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(await journal.listPositions()).toHaveLength(1);
  });

  it('counts only today’s realized losses, excluding previous profit', async () => {
    await fill('buy', 100);
    await fill('sell', 200);
    await pool.query("UPDATE app.trades SET executed_at = executed_at - interval '1 day'");
    await fill('buy', 100);
    await fill('sell', 60);
    expect(await journal.getRealizedPnlQuote()).toBeCloseTo(60);
    expect(await journal.getDailyRealizedPnlQuote()).toBeCloseTo(-40);
    await expect(fill('buy')).rejects.toBeInstanceOf(PaperRiskBlockedError);
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    expect(await journal.getDailyRealizedPnlQuote(tomorrow)).toBe(0);
  });

  it('keeps fees in the cost basis and realizes them on partial sells', async () => {
    const exchange = new PaperExchange(journal, 'binance', 0.1, {
      mode: 'paper', liveTradingLocked: true, allowedSymbols: ['BTC/USDT'], budget
    });
    await exchange.placePaperOrder({ symbol: 'BTC/USDT', side: 'buy', type: 'market', baseQuantity: 2, reason: 'test' }, ticker());
    await exchange.placePaperOrder({ symbol: 'BTC/USDT', side: 'sell', type: 'market', baseQuantity: 1, reason: 'test' }, ticker(110));
    expect(await journal.getDailyRealizedPnlQuote()).toBeCloseTo(9.79);
    expect(await journal.getDailyBuyQuoteUsage()).toBeCloseTo(200.2);
  });

  it('returns fills without pool reads after COMMIT, even with one connection', async () => {
    const singlePool = new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 200 });
    const singleJournal = new TradeJournalService(singlePool);
    const spy = vi.spyOn(singlePool, 'query').mockRejectedValue(new Error('No additional pool reads allowed') as never);
    try {
      const exchange = new PaperExchange(singleJournal, 'binance', 0, {
        mode: 'paper', liveTradingLocked: true, allowedSymbols: ['BTC/USDT'], budget
      });
      const result = await exchange.placePaperOrder({ symbol: 'BTC/USDT', side: 'buy', type: 'market', baseQuantity: 1, reason: 'test' }, ticker());
      expect(result.order.status).toBe('filled');
      expect(result.position.baseQuantity).toBe(1);
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); await singlePool.end(); }
  });

  it.each(['getDailyBuyQuoteUsage', 'getDailyRealizedPnlQuote', 'listPositions'] as const)('rolls back when %s fails', async (method) => {
    const spy = vi.spyOn(TradeJournalService.prototype, method).mockRejectedValue(new Error('read unavailable'));
    await expect(fill('buy')).rejects.toThrow('read unavailable');
    spy.mockRestore();
    expect(await journal.listTrades()).toHaveLength(0);
    expect(await journal.listOrders()).toHaveLength(0);
    expect(await journal.listPositions()).toHaveLength(0);
  });

  it.each(['getDailyBuyQuoteUsage', 'getDailyRealizedPnlQuote', 'listPositions'] as const)('HTTP fails closed when %s fails', async (method) => {
    vi.stubEnv('AUTO_PAPER_TRADER_ENABLED', 'false');
    vi.stubEnv('DASHBOARD_AUTH_ENABLED', 'false');
    vi.stubEnv('TRADING_MODE', 'paper');
    vi.stubEnv('SYMBOLS', 'BTC/USDT');
    vi.spyOn(BinancePublicMarketDataAdapter.prototype, 'getTickers').mockResolvedValue([ticker()]);
    vi.spyOn(TradeJournalService.prototype, method).mockRejectedValue(new Error('read unavailable'));
    const exchange = vi.spyOn(PaperExchange.prototype, 'placePaperOrder');
    const app = await buildServer(pool);
    try {
      const result = await app.inject({ method: 'POST', url: '/api/paper/orders',
        payload: { symbol: 'BTC/USDT', side: 'buy', quoteValue: 25 } });
      expect(result.statusCode).toBe(500);
      expect(exchange).not.toHaveBeenCalled();
    } finally { await app.close(); vi.unstubAllEnvs(); }
  });

  it('backfills historical per-trade P/L and preserves current positions', async () => {
    await fill('buy', 100, 2);
    await fill('sell', 110);
    await fill('sell', 120);
    const before = await journal.listPositions();
    // Give the fixture an unambiguous historical order, independent of clock precision.
    await pool.query("UPDATE app.trades SET executed_at = date_trunc('day', now()) + price * interval '1 second'");
    await pool.query('ALTER TABLE app.trades DROP COLUMN realized_pnl_quote');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(await readFile('migrations/003_trade_realized_pnl.sql', 'utf8'));
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    expect(await journal.getDailyRealizedPnlQuote()).toBeCloseTo(30);
    expect(await journal.listPositions()).toEqual(before);
  });
  it('rolls back migration rather than guess an ambiguous historical order', async () => {
    await fill('buy');
    await fill('sell', 110);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE app.trades SET executed_at = now()');
      await client.query('ALTER TABLE app.trades DROP COLUMN realized_pnl_quote');
      await expect(client.query(await readFile('migrations/003_trade_realized_pnl.sql', 'utf8')))
        .rejects.toThrow('Ambiguous historical trade order');
    } finally { await client.query('ROLLBACK'); client.release(); }
    expect(await journal.getDailyRealizedPnlQuote()).toBeCloseTo(10);
  });

  it('returns HTTP 409 when the transactional check blocks a previously allowed order', async () => {
    await fill('buy', 100, 2.45);
    vi.stubEnv('AUTO_PAPER_TRADER_ENABLED', 'false');
    vi.stubEnv('DASHBOARD_AUTH_ENABLED', 'false');
    vi.stubEnv('TRADING_MODE', 'paper');
    vi.stubEnv('SYMBOLS', 'BTC/USDT');
    vi.stubEnv('RISK_MAX_SYMBOL_EXPOSURE_QUOTE', '10000');
    vi.stubEnv('RISK_DAILY_QUOTE_BUDGET', '250');
    vi.spyOn(BinancePublicMarketDataAdapter.prototype, 'getTickers').mockResolvedValue([ticker()]);
    // The preliminary snapshot predates a concurrent fill; the transaction sees 245.
    vi.spyOn(TradeJournalService.prototype, 'getDailyBuyQuoteUsage').mockResolvedValueOnce(220);
    const app = await buildServer(pool);
    try {
      const result = await app.inject({ method: 'POST', url: '/api/paper/orders',
        payload: { symbol: 'BTC/USDT', side: 'buy', quoteValue: 25 } });
      expect(result.statusCode).toBe(409);
      expect(result.json().decision.events).toContainEqual(expect.objectContaining({ gate: 'daily-budget', decision: 'block' }));
      expect(await journal.listTrades()).toHaveLength(1);
      expect(await journal.listDecisionJournal()).toContainEqual(expect.objectContaining({ decision: 'block' }));
    } finally { await app.close(); vi.unstubAllEnvs(); }
  });

});
