import type { MarketTicker, PaperOrderRequest } from '../domain/types.js';
import type { PaperFillResult } from '../journal/trade-journal.service.js';
import type { ExchangeAdapter } from './exchange-adapter.js';

export class LiveExchangeDisabled implements ExchangeAdapter {
  readonly id = 'live-disabled';

  async placePaperOrder(_request: PaperOrderRequest, _ticker: MarketTicker): Promise<PaperFillResult> {
    throw new Error('Live exchange execution is disabled in this MVP');
  }
}
