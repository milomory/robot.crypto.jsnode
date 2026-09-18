import { describe, expect, it } from 'vitest';

import type { AppConfig } from '../src/config/env.js';
import type { MarketTicker, PositionRecord } from '../src/domain/types.js';
import { PaperRiskBlockedError } from '../src/journal/trade-journal.service.js';
import { RiskBudgetService } from '../src/risk/risk-budget.service.js';
import { AutoPaperTraderService } from '../src/services/auto-paper-trader.service.js';

const budget = {
  maxOrderQuote: 50,
  dailyQuoteBudget: 250,
  maxDailyLossQuote: 30,
  maxOpenPositions: 5,
  maxSymbolExposureQuote: 150,
  maxSpreadPercent: 0.25
};

const makeConfig = (overrides: Partial<AppConfig> = {}): AppConfig =>
  ({
    nodeEnv: 'test',
    http: { host: '127.0.0.1', port: 3000 },
    db: {
      host: '127.0.0.1',
      port: 5432,
      database: 'test',
      user: 'test',
      password: '',
      ssl: false
    },
    dashboard: { authEnabled: false, username: 'robot', password: '' },
    exchange: { id: 'seed', quoteCurrency: 'USDT', symbols: ['BTC/USDT'] },
    trading: { mode: 'paper', liveTradingLocked: true, paperFeePercent: 0.1 },
    risk: budget,
    autoTrader: {
      enabled: true,
      intervalMs: 60_000,
      orderQuote: 10,
      minChangePercent: 0.5,
      sellTakeProfitPercent: 2,
      sellStopLossPercent: 1.5,
      allowFallbackMarketData: false,
      recordObservations: false
    },
    ...overrides
  }) as AppConfig;

const ticker: MarketTicker = {
  exchange: 'seed',
  symbol: 'BTC/USDT',
  bid: 99_990,
  ask: 100_010,
  lastPrice: 100_000,
  priceChangePercent24h: 1.2,
  observedAt: new Date()
};

const makeJournal = (positions: PositionRecord[] = []) => {
  const decisions: unknown[] = [];
  const riskEvents: unknown[] = [];

  return {
    decisions,
    riskEvents,
    journal: {
      recordMarketTick: async () => undefined,
      recordRiskEvent: async (event: unknown) => {
        riskEvents.push(event);
      },
      recordDecision: async (decision: unknown) => {
        decisions.push(decision);
      },
      listPositions: async () => positions,
      getDailyBuyQuoteUsage: async () => 0,
      getDailyRealizedPnlQuote: async () => 0
    }
  };
};

describe('AutoPaperTraderService', () => {
  it('fills one paper buy when momentum passes risk gates', async () => {
    const config = makeConfig();
    const { journal, decisions, riskEvents } = makeJournal();
    const fills: unknown[] = [];
    const service = new AutoPaperTraderService(
      config,
      { id: 'seed', getTickers: async () => [ticker] },
      journal,
      new RiskBudgetService(config.risk),
      {
        placePaperOrder: async (request) => {
          fills.push(request);
          return {
            order: { id: 'order-1' },
            trade: { quoteValue: 10 },
            position: {}
          } as never;
        }
      }
    );

    const status = await service.runScan('test');

    expect(status.lastSignals[0]).toMatchObject({ symbol: 'BTC/USDT', action: 'buy', decision: 'allow' });
    expect(fills).toHaveLength(1);
    expect(decisions).toHaveLength(1);
    expect(riskEvents).toEqual(expect.arrayContaining([expect.objectContaining({ gate: 'risk-budget' })]));
  });

  it('holds an existing position instead of repeatedly buying the same symbol', async () => {
    const config = makeConfig();
    const { journal, decisions } = makeJournal([
      {
        symbol: 'BTC/USDT',
        baseQuantity: 0.001,
        avgEntryPrice: 100_000,
        realizedPnlQuote: 0,
        updatedAt: new Date()
      }
    ]);
    const fills: unknown[] = [];
    const service = new AutoPaperTraderService(
      config,
      { id: 'seed', getTickers: async () => [ticker] },
      journal,
      new RiskBudgetService(config.risk),
      {
        placePaperOrder: async (request) => {
          fills.push(request);
          return {} as never;
        }
      }
    );

    const status = await service.runScan('test');

    expect(status.lastSignals[0]).toMatchObject({ action: 'hold', decision: 'observe' });
    expect(fills).toHaveLength(0);
    expect(decisions).toHaveLength(0);
  });

  it('blocks fills when runtime mode is not paper', async () => {
    const config = makeConfig({
      trading: { mode: 'live', liveTradingLocked: true, paperFeePercent: 0.1 }
    });
    const { journal, decisions } = makeJournal();
    const fills: unknown[] = [];
    const service = new AutoPaperTraderService(
      config,
      { id: 'seed', getTickers: async () => [ticker] },
      journal,
      new RiskBudgetService(config.risk),
      {
        placePaperOrder: async (request) => {
          fills.push(request);
          return {} as never;
        }
      }
    );

    const status = await service.runScan('test');

    expect(status.lastSignals[0]).toMatchObject({ action: 'skip', decision: 'block' });
    expect(fills).toHaveLength(0);
    expect(decisions).toHaveLength(0);
  });

  it('blocks scans when the auto trader is disabled', async () => {
    const baseConfig = makeConfig();
    const config = makeConfig({
      autoTrader: { ...baseConfig.autoTrader, enabled: false }
    });
    const { journal } = makeJournal();
    const fills: unknown[] = [];
    const service = new AutoPaperTraderService(
      config,
      { id: 'seed', getTickers: async () => [ticker] },
      journal,
      new RiskBudgetService(config.risk),
      {
        placePaperOrder: async (request) => {
          fills.push(request);
          return {} as never;
        }
      }
    );

    const status = await service.runScan('manual');

    expect(status.lastSignals[0]).toMatchObject({ action: 'skip', decision: 'block' });
    expect(String(status.lastSignals[0].reason)).toContain('disabled');
    expect(fills).toHaveLength(0);
  });

  it('blocks autonomous scans when live lock is disabled', async () => {
    const config = makeConfig({
      trading: { mode: 'paper', liveTradingLocked: false, paperFeePercent: 0.1 }
    });
    const { journal } = makeJournal();
    const fills: unknown[] = [];
    const service = new AutoPaperTraderService(
      config,
      { id: 'seed', getTickers: async () => [ticker] },
      journal,
      new RiskBudgetService(config.risk),
      {
        placePaperOrder: async (request) => {
          fills.push(request);
          return {} as never;
        }
      }
    );

    const status = await service.runScan('test');

    expect(status.lastSignals[0]).toMatchObject({ action: 'skip', decision: 'block' });
    expect(fills).toHaveLength(0);
  });

  it('blocks fallback market data by default', async () => {
    const config = makeConfig();
    const { journal, decisions } = makeJournal();
    const fills: unknown[] = [];
    const service = new AutoPaperTraderService(
      config,
      {
        id: 'seed',
        getTickers: async () => [
          {
            ...ticker,
            exchange: 'binance:fallback'
          }
        ]
      },
      journal,
      new RiskBudgetService(config.risk),
      {
        placePaperOrder: async (request) => {
          fills.push(request);
          return {} as never;
        }
      }
    );

    const status = await service.runScan('test');

    expect(status.lastSignals[0]).toMatchObject({ action: 'skip', decision: 'block' });
    expect(String(status.lastSignals[0].reason)).toContain('fallback');
    expect(fills).toHaveLength(0);
    expect(decisions).toHaveLength(1);
  });
});


it('records a transactional risk rejection as a blocked signal rather than a scan error', async () => {
  const config = makeConfig();
  const { journal, decisions } = makeJournal();
  const service = new AutoPaperTraderService(
    config, { id: 'seed', getTickers: async () => [ticker] }, journal, new RiskBudgetService(config.risk),
    { placePaperOrder: async () => { throw new PaperRiskBlockedError({
      decision: 'block', events: [{ severity: 'critical', gate: 'daily-budget', decision: 'block', message: 'Budget exhausted' }]
    }); } }
  );
  const status = await service.runScan('test');
  expect(status.lastSignals[0]).toMatchObject({ decision: 'block', reason: 'Budget exhausted' });
  expect(status.consecutiveErrors).toBe(0);
  expect(decisions).toContainEqual(expect.objectContaining({ decision: 'block' }));
});
