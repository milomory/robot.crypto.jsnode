import type { MarketTicker } from '../domain/types.js';
import type { MarketDataAdapter } from './exchange-adapter.js';

interface BinanceBookTicker {
  symbol: string;
  bidPrice: string;
  askPrice: string;
}

interface BinanceTicker24h {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  volume: string;
  quoteVolume: string;
}

const toBinanceSymbol = (symbol: string): string => symbol.replace('/', '').toUpperCase();

const normalizeArray = <T>(payload: T | T[]): T[] => (Array.isArray(payload) ? payload : [payload]);

const safeNumber = (value: string | undefined): number | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export class BinancePublicMarketDataAdapter implements MarketDataAdapter {
  readonly id = 'binance';

  async getTickers(symbols: string[]): Promise<MarketTicker[]> {
    const binanceSymbols = symbols.map(toBinanceSymbol);
    const query = encodeURIComponent(JSON.stringify(binanceSymbols));
    const [bookResponse, tickerResponse] = await Promise.all([
      fetch(`https://api.binance.com/api/v3/ticker/bookTicker?symbols=${query}`),
      fetch(`https://api.binance.com/api/v3/ticker/24hr?symbols=${query}`)
    ]);

    if (!bookResponse.ok || !tickerResponse.ok) {
      throw new Error(`Binance market data failed: book=${bookResponse.status} ticker=${tickerResponse.status}`);
    }

    const book = normalizeArray((await bookResponse.json()) as BinanceBookTicker[]);
    const ticker = normalizeArray((await tickerResponse.json()) as BinanceTicker24h[]);
    const bookBySymbol = new Map(book.map((item) => [item.symbol, item]));
    const tickerBySymbol = new Map(ticker.map((item) => [item.symbol, item]));
    const observedAt = new Date();

    return symbols.map((symbol) => {
      const exchangeSymbol = toBinanceSymbol(symbol);
      const bookItem = bookBySymbol.get(exchangeSymbol);
      const tickerItem = tickerBySymbol.get(exchangeSymbol);
      const bid = safeNumber(bookItem?.bidPrice);
      const ask = safeNumber(bookItem?.askPrice);
      const lastPrice = safeNumber(tickerItem?.lastPrice) ?? bid ?? ask;

      if (!lastPrice) {
        throw new Error(`Binance returned no price for ${symbol}`);
      }

      return {
        exchange: this.id,
        symbol,
        bid,
        ask,
        lastPrice,
        priceChangePercent24h: safeNumber(tickerItem?.priceChangePercent),
        volume24h: safeNumber(tickerItem?.volume),
        quoteVolume24h: safeNumber(tickerItem?.quoteVolume),
        observedAt
      };
    });
  }
}
