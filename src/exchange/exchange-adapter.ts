import type { MarketTicker, PaperOrderRequest } from '../domain/types.js';
import type { PaperFillResult } from '../journal/trade-journal.service.js';

export interface MarketDataAdapter {
  readonly id: string;
  getTickers(symbols: string[]): Promise<MarketTicker[]>;
}

export interface ExchangeAdapter {
  readonly id: string;
  placePaperOrder(request: PaperOrderRequest, ticker: MarketTicker): Promise<PaperFillResult>;
}

export const isFallbackMarketTicker = (ticker: Pick<MarketTicker, 'exchange'>): boolean =>
  ticker.exchange.includes(':fallback');
