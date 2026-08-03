import type { MarketTicker } from '../domain/types.js';
import type { MarketDataAdapter } from './exchange-adapter.js';

const seedPrices: Record<string, number> = {
  'BTC/USDT': 104_000,
  'ETH/USDT': 2_450,
  'SOL/USDT': 136,
  'BNB/USDT': 645,
  'XRP/USDT': 2.1
};

export class SeedMarketDataAdapter implements MarketDataAdapter {
  readonly id = 'seed';

  async getTickers(symbols: string[]): Promise<MarketTicker[]> {
    const observedAt = new Date();

    return symbols.map((symbol, index) => {
      const basePrice = seedPrices[symbol] ?? 100 + index * 25;
      const drift = Math.sin(Date.now() / 120_000 + index) * 0.004;
      const lastPrice = basePrice * (1 + drift);
      const spread = lastPrice * 0.0006;

      return {
        exchange: this.id,
        symbol,
        bid: lastPrice - spread / 2,
        ask: lastPrice + spread / 2,
        lastPrice,
        priceChangePercent24h: Math.sin(Date.now() / 300_000 + index) * 2,
        volume24h: 10_000 + index * 1_000,
        quoteVolume24h: lastPrice * (10_000 + index * 1_000),
        observedAt
      };
    });
  }
}
