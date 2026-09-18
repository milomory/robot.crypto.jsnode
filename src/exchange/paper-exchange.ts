import type { MarketTicker, PaperOrderRequest, RiskContext } from '../domain/types.js';
import { TradeJournalService, type PaperFillResult } from '../journal/trade-journal.service.js';
import type { ExchangeAdapter } from './exchange-adapter.js';

export class PaperExchange implements ExchangeAdapter {
  readonly id: string;

  constructor(
    private readonly journal: TradeJournalService,
    exchangeId: string,
    private readonly feePercent: number,
    private readonly riskContext: Pick<RiskContext, 'mode' | 'liveTradingLocked' | 'allowedSymbols' | 'budget'>
  ) {
    this.id = `${exchangeId}:paper`;
  }

  async placePaperOrder(request: PaperOrderRequest, ticker: MarketTicker): Promise<PaperFillResult> {
    return this.journal.createPaperFill({
      exchange: ticker.exchange,
      request,
      price: ticker.lastPrice,
      feePercent: this.feePercent,
      riskContext: { ...this.riskContext, ticker }
    });
  }
}
