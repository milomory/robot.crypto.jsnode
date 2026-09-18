import { describe, expect, it } from 'vitest';

import type { PaperOrderRequest, RiskContext } from '../src/domain/types.js';
import { RiskBudgetService } from '../src/risk/risk-budget.service.js';

const budget = {
  maxOrderQuote: 50,
  dailyQuoteBudget: 250,
  maxDailyLossQuote: 30,
  maxOpenPositions: 5,
  maxSymbolExposureQuote: 150,
  maxSpreadPercent: 0.25
};

const baseRequest: PaperOrderRequest = {
  symbol: 'BTC/USDT',
  side: 'buy',
  type: 'market',
  baseQuantity: 0.0002,
  reason: 'test'
};

const baseContext: RiskContext = {
  feePercent: 0.1,
  mode: 'paper',
  liveTradingLocked: true,
  allowedSymbols: ['BTC/USDT', 'ETH/USDT'],
  dailyBuyQuoteUsage: 0,
  realizedPnlQuote: 0,
  openPositions: [],
  budget,
  ticker: {
    exchange: 'seed',
    symbol: 'BTC/USDT',
    bid: 99_990,
    ask: 100_010,
    lastPrice: 100_000,
    observedAt: new Date()
  }
};

describe('RiskBudgetService', () => {
  it('allows a small paper order and records the live lock as observe-only', () => {
    const service = new RiskBudgetService(budget);
    const decision = service.evaluateOrder(baseRequest, baseContext);

    expect(decision.decision).toBe('allow');
    expect(decision.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gate: 'live-lock',
          decision: 'observe'
        }),
        expect.objectContaining({
          gate: 'risk-budget',
          decision: 'allow'
        })
      ])
    );
  });

  it('blocks orders above the per-order quote budget', () => {
    const service = new RiskBudgetService(budget);
    const decision = service.evaluateOrder(
      {
        ...baseRequest,
        baseQuantity: 0.001
      },
      baseContext
    );

    expect(decision.decision).toBe('block');
    expect(decision.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gate: 'max-order-quote',
          decision: 'block'
        })
      ])
    );
  });

  it('blocks any non-paper execution mode in the MVP', () => {
    const service = new RiskBudgetService(budget);
    const decision = service.evaluateOrder(baseRequest, {
      ...baseContext,
      mode: 'live'
    });

    expect(decision.decision).toBe('block');
    expect(decision.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gate: 'mode',
          decision: 'block'
        })
      ])
    );
  });
});

it('includes the new buy fee in the daily budget', () => {
  const service = new RiskBudgetService(budget);
  const decision = service.evaluateOrder({ ...baseRequest, baseQuantity: 0.00025 }, {
    ...baseContext, dailyBuyQuoteUsage: 225
  });
  expect(decision.decision).toBe('block');
  expect(decision.events).toContainEqual(expect.objectContaining({ gate: 'daily-budget', decision: 'block' }));
});
