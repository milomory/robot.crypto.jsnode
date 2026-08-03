import { describe, expect, it } from 'vitest';

import { LiveExchangeDisabled } from '../src/exchange/live-exchange-disabled.js';

describe('LiveExchangeDisabled', () => {
  it('has no executable live order path', async () => {
    const adapter = new LiveExchangeDisabled();

    await expect(
      adapter.placePaperOrder(
        {
          symbol: 'BTC/USDT',
          side: 'buy',
          type: 'market',
          baseQuantity: 0.001,
          reason: 'test'
        },
        {
          exchange: 'seed',
          symbol: 'BTC/USDT',
          lastPrice: 100_000,
          observedAt: new Date()
        }
      )
    ).rejects.toThrow('Live exchange execution is disabled');
  });
});
