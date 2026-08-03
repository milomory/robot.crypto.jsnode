import type { AppConfig } from '../config/env.js';
import type { MarketTicker, PaperOrderRequest, PositionRecord } from '../domain/types.js';
import { isFallbackMarketTicker, type MarketDataAdapter } from '../exchange/exchange-adapter.js';
import type { PaperExchange } from '../exchange/paper-exchange.js';
import type { TradeJournalService } from '../journal/trade-journal.service.js';
import type { RiskBudgetService } from '../risk/risk-budget.service.js';

type AutoTraderJournal = Pick<
  TradeJournalService,
  | 'recordMarketTick'
  | 'recordRiskEvent'
  | 'recordDecision'
  | 'listPositions'
  | 'getDailyBuyQuoteUsage'
  | 'getRealizedPnlQuote'
>;

type AutoTraderPaperExchange = Pick<PaperExchange, 'placePaperOrder'>;

export type AutoTraderAction = 'buy' | 'sell' | 'hold' | 'skip';

export interface AutoTraderSignal {
  symbol: string;
  action: AutoTraderAction;
  decision: 'allow' | 'block' | 'observe';
  reason: string;
  price?: number;
  priceChangePercent24h?: number;
  quoteValue?: number;
}

export interface AutoTraderStatus {
  enabled: boolean;
  intervalMs: number;
  orderQuote: number;
  minChangePercent: number;
  sellTakeProfitPercent: number;
  sellStopLossPercent: number;
  running: boolean;
  lastRunAt?: string;
  nextRunAt?: string;
  lastError?: string;
  consecutiveErrors: number;
  lastSignals: AutoTraderSignal[];
}

export class AutoPaperTraderService {
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastRunAt?: Date;
  private lastError?: string;
  private consecutiveErrors = 0;
  private lastSignals: AutoTraderSignal[] = [];

  constructor(
    private readonly config: AppConfig,
    private readonly marketData: MarketDataAdapter,
    private readonly journal: AutoTraderJournal,
    private readonly risk: RiskBudgetService,
    private readonly paperExchange: AutoTraderPaperExchange
  ) {}

  start(): void {
    if (!this.config.autoTrader.enabled || this.timer || !this.canRunAutonomously()) {
      return;
    }

    this.timer = setInterval(() => {
      void this.runScan('interval').catch((error) => {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.consecutiveErrors += 1;
      });
    }, this.config.autoTrader.intervalMs);

    this.timer.unref?.();
    void this.runScan('startup').catch((error) => {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.consecutiveErrors += 1;
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  getStatus(): AutoTraderStatus {
    return {
      enabled: this.config.autoTrader.enabled,
      intervalMs: this.config.autoTrader.intervalMs,
      orderQuote: this.config.autoTrader.orderQuote,
      minChangePercent: this.config.autoTrader.minChangePercent,
      sellTakeProfitPercent: this.config.autoTrader.sellTakeProfitPercent,
      sellStopLossPercent: this.config.autoTrader.sellStopLossPercent,
      running: this.running,
      lastRunAt: this.lastRunAt?.toISOString(),
      nextRunAt:
        this.timer && this.lastRunAt
          ? new Date(this.lastRunAt.getTime() + this.config.autoTrader.intervalMs).toISOString()
          : undefined,
      lastError: this.lastError,
      consecutiveErrors: this.consecutiveErrors,
      lastSignals: this.lastSignals
    };
  }

  async runScan(trigger = 'manual'): Promise<AutoTraderStatus> {
    if (this.running) {
      return this.getStatus();
    }

    if (!this.config.autoTrader.enabled) {
      return this.blockScan('auto paper trader is disabled');
    }

    if (!this.canRunAutonomously()) {
      return this.blockScan('auto paper trader requires TRADING_MODE=paper and LIVE_TRADING_LOCKED=true');
    }

    this.running = true;

    try {
      const tickers = await this.marketData.getTickers(this.config.exchange.symbols);
      await Promise.all(tickers.map((ticker) => this.journal.recordMarketTick(ticker)));

      const signals: AutoTraderSignal[] = [];

      for (const ticker of tickers) {
        const signal = await this.evaluateTicker(ticker, trigger);
        signals.push(signal);
      }

      this.lastSignals = signals;
      this.lastRunAt = new Date();
      this.lastError = undefined;
      this.consecutiveErrors = 0;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.consecutiveErrors += 1;
      this.lastRunAt = new Date();
      throw error;
    } finally {
      this.running = false;
    }

    return this.getStatus();
  }

  private async evaluateTicker(ticker: MarketTicker, trigger: string): Promise<AutoTraderSignal> {
    if (isFallbackMarketTicker(ticker) && !this.config.autoTrader.allowFallbackMarketData) {
      const signal: AutoTraderSignal = {
        symbol: ticker.symbol,
        action: 'skip',
        decision: 'block',
        reason: 'fallback market data is disabled for auto paper trading',
        price: ticker.lastPrice,
        priceChangePercent24h: ticker.priceChangePercent24h
      };
      await this.recordSignal(signal, trigger);
      return signal;
    }

    const positions = await this.journal.listPositions();
    const position = positions.find((item) => item.symbol === ticker.symbol && item.baseQuantity > 0);
    const request = this.buildRequest(ticker, position);

    if (!request) {
      const signal = this.observeSignal(ticker, position);
      if (this.config.autoTrader.recordObservations) {
        await this.recordSignal(signal, trigger);
      }

      return signal;
    }

    const [dailyBuyQuoteUsage, realizedPnlQuote, openPositions] = await Promise.all([
      this.journal.getDailyBuyQuoteUsage(),
      this.journal.getRealizedPnlQuote(),
      this.journal.listPositions()
    ]);

    const decision = this.risk.evaluateOrder(request, {
      mode: this.config.trading.mode,
      liveTradingLocked: this.config.trading.liveTradingLocked,
      allowedSymbols: this.config.exchange.symbols,
      dailyBuyQuoteUsage,
      realizedPnlQuote,
      openPositions,
      ticker,
      budget: this.risk.getBudget()
    });

    await Promise.all(decision.events.map((event) => this.journal.recordRiskEvent(event)));

    if (decision.decision === 'block') {
      const reason = decision.events.find((event) => event.decision === 'block')?.message ?? 'risk blocked';
      const signal: AutoTraderSignal = {
        symbol: ticker.symbol,
        action: request.side,
        decision: 'block',
        reason,
        price: ticker.lastPrice,
        priceChangePercent24h: ticker.priceChangePercent24h,
        quoteValue: request.baseQuantity * ticker.lastPrice
      };
      await this.recordSignal(signal, trigger);
      return signal;
    }

    const fill = await this.paperExchange.placePaperOrder(request, ticker);
    const signal: AutoTraderSignal = {
      symbol: ticker.symbol,
      action: request.side,
      decision: 'allow',
      reason: `paper ${request.side} filled`,
      price: ticker.lastPrice,
      priceChangePercent24h: ticker.priceChangePercent24h,
      quoteValue: fill.trade.quoteValue
    };
    await this.recordSignal(signal, trigger, fill.order.id);
    return signal;
  }

  private canRunAutonomously(): boolean {
    return this.config.trading.mode === 'paper' && this.config.trading.liveTradingLocked;
  }

  private blockScan(reason: string): AutoTraderStatus {
    this.lastRunAt = new Date();
    this.lastSignals = this.config.exchange.symbols.map((symbol) => ({
      symbol,
      action: 'skip',
      decision: 'block',
      reason
    }));
    return this.getStatus();
  }

  private buildRequest(ticker: MarketTicker, position?: PositionRecord): PaperOrderRequest | undefined {
    if (this.config.trading.mode !== 'paper') {
      return {
        symbol: ticker.symbol,
        side: 'buy',
        type: 'market',
        baseQuantity: this.config.autoTrader.orderQuote / ticker.lastPrice,
        reason: 'auto paper scan blocked: non-paper mode'
      };
    }

    if (position) {
      const pnlPercent = ((ticker.lastPrice - position.avgEntryPrice) / position.avgEntryPrice) * 100;
      if (pnlPercent >= this.config.autoTrader.sellTakeProfitPercent) {
        return {
          symbol: ticker.symbol,
          side: 'sell',
          type: 'market',
          baseQuantity: position.baseQuantity,
          reason: `auto paper take-profit ${pnlPercent.toFixed(2)}%`
        };
      }

      if (pnlPercent <= -this.config.autoTrader.sellStopLossPercent) {
        return {
          symbol: ticker.symbol,
          side: 'sell',
          type: 'market',
          baseQuantity: position.baseQuantity,
          reason: `auto paper stop-loss ${pnlPercent.toFixed(2)}%`
        };
      }

      return undefined;
    }

    const change = ticker.priceChangePercent24h ?? 0;
    if (change < this.config.autoTrader.minChangePercent) {
      return undefined;
    }

    return {
      symbol: ticker.symbol,
      side: 'buy',
      type: 'market',
      baseQuantity: this.config.autoTrader.orderQuote / ticker.lastPrice,
      reason: `auto paper momentum ${change.toFixed(2)}%`
    };
  }

  private observeSignal(ticker: MarketTicker, position?: PositionRecord): AutoTraderSignal {
    if (position) {
      const pnlPercent = ((ticker.lastPrice - position.avgEntryPrice) / position.avgEntryPrice) * 100;
      return {
        symbol: ticker.symbol,
        action: 'hold',
        decision: 'observe',
        reason: `holding paper position, unrealized ${pnlPercent.toFixed(2)}%`,
        price: ticker.lastPrice,
        priceChangePercent24h: ticker.priceChangePercent24h,
        quoteValue: position.baseQuantity * ticker.lastPrice
      };
    }

    const change = ticker.priceChangePercent24h ?? 0;
    return {
      symbol: ticker.symbol,
      action: 'skip',
      decision: 'observe',
      reason: `24h change ${change.toFixed(2)}% below ${this.config.autoTrader.minChangePercent}%`,
      price: ticker.lastPrice,
      priceChangePercent24h: ticker.priceChangePercent24h
    };
  }

  private async recordSignal(signal: AutoTraderSignal, trigger: string, orderId?: string): Promise<void> {
    await this.journal.recordDecision({
      symbol: signal.symbol,
      signal: `auto-paper:${signal.action}`,
      decision: signal.decision,
      reason: signal.reason,
      context: {
        trigger,
        orderId,
        price: signal.price,
        priceChangePercent24h: signal.priceChangePercent24h,
        quoteValue: signal.quoteValue
      }
    });
  }
}
