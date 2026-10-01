import type { PairVenue } from '../../src/paper-pair/public.js';
import { parsePairBook, parsePairInstrument } from '../../src/paper-pair/public.js';
import type { PairMarketInput, PairBalances, PairEvent } from '../../src/paper-pair/engine.js';
export const T = 1_800_000_000_000;
export function rawBook(venue: PairVenue, at = T) {
  return venue === 'mexc' ? { lastUpdateId: 12, bids: [['49999.000000000000000001', '2']], asks: [['50000', '2']] } :
    { code: '0', data: [{ ts: String(at), seqId: 34, bids: [['51000', '2', '0', '1']], asks: [['51001', '2', '0', '1']] }] };
}
export function rawInstrument(venue: PairVenue): any {
  return venue === 'mexc' ? { symbols: [{ symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: '1',
    baseAssetPrecision: 8, quoteAssetPrecision: 2, baseSizePrecision: '0.000001', quoteAmountPrecisionMarket: '1',
    maxQuoteAmountMarket: '4000000', tradeSideType: 1, isSpotTradingAllowed: true, orderTypes: ['LIMIT', 'MARKET'],
    filters: [{ filterType: 'PERCENT_PRICE_BY_SIDE' }] }] } : { code: '0', data: [{ instType: 'SPOT', instId: 'BTC-USDT',
    baseCcy: 'BTC', quoteCcy: 'USDT', state: 'live', lotSz: '0.00000001', minSz: '0.00001',
    maxMktSz: '1000000', maxMktAmt: '', tickSz: '0.1', upcChg: [] }] };
}
export function fees(at = T) {
  return { checkedAt: at, fees: {
    mexc: { status: 'available', feeReadVerified: true, requestedAt: at - 20, receivedAt: at - 10,
      takerRate: '0.0005', ratePrecision: 'json-number', rateConvention: 'positive-fee' },
    okx: { status: 'available', feeReadVerified: true, requestedAt: at - 20, receivedAt: at - 10,
      takerRate: '-0.001', ratePrecision: 'decimal-string', rateConvention: 'negative-fee-positive-rebate' }
  } };
}
export function fakeCaptureOptions(failSequence = -1) {
  let now = T, bookCalls = 0;
  return { host: 'fixture', clock: () => now, sleep: async (ms: number) => { now += ms; }, client: {
    getBook: async (venue: PairVenue) => {
      const requestedAt = now++; const receivedAt = now++;
      const sequence = Math.floor(bookCalls++ / 2);
      if (sequence === failSequence && venue === 'okx') throw new Error('private-upstream-text');
      return parsePairBook(venue, rawBook(venue, requestedAt), requestedAt, receivedAt);
    },
    getInstrument: async (venue: PairVenue) => {
      const requestedAt = now++; const receivedAt = now++;
      return parsePairInstrument(venue, rawInstrument(venue), requestedAt, receivedAt);
    }
  } };
}
export const opening: PairBalances = { mexc: { btc: '1', usdt: '1000' }, okx: { btc: '1', usdt: '1000' } };
export function market(): PairMarketInput {
  const leg = (venue: PairVenue, bid: string, ask: string) => ({
    book: { venue, symbol: 'BTC/USDT' as const, bids: [[bid, '1']] as [string, string][], asks: [[ask, '1']] as [string, string][],
      requestedAt: T - 100, receivedAt: T - 10 },
    instrument: { venue, symbol: 'BTC/USDT' as const, fetchedAt: T - 200, trading: true,
      minQuantity: '0.1', quantityStep: '0.1', maxQuantity: '10', minNotional: '1' },
    costs: { feeBps: '10', slippageBps: '5', feeAsset: 'USDT' as const }
  });
  return { buy: leg('mexc', '99', '100'), sell: leg('okx', '102', '103'), quantity: '0.1', now: T };
}
export function prepare(): PairEvent {
  const { now, ...m } = market(); return { type: 'prepare', id: 'prepare-1', at: now, pairId: 'pair-1', market: m };
}
export function leg(side: 'buy' | 'sell', quantity: string, status: 'partial' | 'filled' | 'rejected' | 'unknown', id = side): PairEvent {
  return { type: 'leg', id, at: T + 100, pairId: 'pair-1', side, cumulativeQuantity: quantity, status };
}
