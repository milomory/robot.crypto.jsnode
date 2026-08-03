import type { MarketTicker } from '../domain/types.js';
import type { MarketDataAdapter } from './exchange-adapter.js';

export class ResilientMarketDataAdapter implements MarketDataAdapter {
  readonly id: string;

  constructor(
    private readonly primary: MarketDataAdapter,
    private readonly fallback: MarketDataAdapter
  ) {
    this.id = primary.id;
  }

  async getTickers(symbols: string[]): Promise<MarketTicker[]> {
    try {
      return await this.primary.getTickers(symbols);
    } catch (error) {
      const fallbackTickers = await this.fallback.getTickers(symbols);
      return fallbackTickers.map((ticker) => ({
        ...ticker,
        exchange: `${this.primary.id}:fallback`
      }));
    }
  }
}
