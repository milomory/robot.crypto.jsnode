import type { PaperOrderRequest, RiskBudget, RiskContext, RiskDecision, RiskEventInput } from '../domain/types.js';

const spreadPercent = (bid?: number, ask?: number): number | undefined => {
  if (!bid || !ask || bid <= 0 || ask <= 0) {
    return undefined;
  }

  const mid = (bid + ask) / 2;
  return ((ask - bid) / mid) * 100;
};

export class RiskBudgetService {
  constructor(private readonly budget: RiskBudget) {}

  getBudget(): RiskBudget {
    return this.budget;
  }

  evaluateOrder(request: PaperOrderRequest, context: RiskContext): RiskDecision {
    const events: RiskEventInput[] = [];
    const quoteValue = request.baseQuantity * context.ticker.lastPrice;
    const currentPosition = context.openPositions.find((position) => position.symbol === request.symbol);
    const currentExposure = (currentPosition?.baseQuantity ?? 0) * context.ticker.lastPrice;
    const nextExposure = request.side === 'buy' ? currentExposure + quoteValue : Math.max(0, currentExposure - quoteValue);
    const openPositionCount = context.openPositions.filter((position) => position.baseQuantity > 0).length;
    const isNewPosition = !currentPosition || currentPosition.baseQuantity <= 0;
    const currentSpread = spreadPercent(context.ticker.bid, context.ticker.ask);

    const block = (gate: string, message: string, extra: Record<string, unknown> = {}) => {
      events.push({
        severity: 'critical',
        gate,
        symbol: request.symbol,
        decision: 'block',
        message,
        context: {
          quoteValue,
          ...extra
        }
      });
    };

    if (context.mode !== 'paper') {
      block('mode', 'MVP execution is restricted to paper mode', { mode: context.mode });
    }

    if (context.liveTradingLocked) {
      events.push({
        severity: 'info',
        gate: 'live-lock',
        symbol: request.symbol,
        decision: 'observe',
        message: 'Live trading lock is enabled',
        context: { liveTradingLocked: true }
      });
    }

    if (!context.allowedSymbols.includes(request.symbol)) {
      block('allowed-symbols', 'Symbol is not in the configured spot universe', {
        allowedSymbols: context.allowedSymbols
      });
    }

    if (request.side === 'buy' && quoteValue > context.budget.maxOrderQuote) {
      block('max-order-quote', 'Order quote value exceeds max order budget', {
        maxOrderQuote: context.budget.maxOrderQuote
      });
    }

    if (request.side === 'buy' && context.dailyBuyQuoteUsage + quoteValue > context.budget.dailyQuoteBudget) {
      block('daily-budget', 'Daily quote budget would be exceeded', {
        dailyBuyQuoteUsage: context.dailyBuyQuoteUsage,
        dailyQuoteBudget: context.budget.dailyQuoteBudget
      });
    }

    if (request.side === 'buy' && isNewPosition && openPositionCount >= context.budget.maxOpenPositions) {
      block('max-open-positions', 'Open position count limit would be exceeded', {
        openPositionCount,
        maxOpenPositions: context.budget.maxOpenPositions
      });
    }

    if (request.side === 'buy' && nextExposure > context.budget.maxSymbolExposureQuote) {
      block('symbol-exposure', 'Symbol exposure limit would be exceeded', {
        nextExposure,
        maxSymbolExposureQuote: context.budget.maxSymbolExposureQuote
      });
    }

    if (request.side === 'buy' && context.realizedPnlQuote <= -context.budget.maxDailyLossQuote) {
      block('max-daily-loss', 'Realized loss guard is active', {
        realizedPnlQuote: context.realizedPnlQuote,
        maxDailyLossQuote: context.budget.maxDailyLossQuote
      });
    }

    if (currentSpread !== undefined && currentSpread > context.budget.maxSpreadPercent) {
      block('spread', 'Spread exceeds risk budget', {
        spreadPercent: currentSpread,
        maxSpreadPercent: context.budget.maxSpreadPercent
      });
    }

    if (events.some((event) => event.decision === 'block')) {
      return { decision: 'block', events };
    }

    events.push({
      severity: 'info',
      gate: 'risk-budget',
      symbol: request.symbol,
      decision: 'allow',
      message: 'Paper order passed configured risk gates',
      context: { quoteValue }
    });

    return { decision: 'allow', events };
  }
}
