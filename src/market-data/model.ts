/** Public research identities. Support in one reader never grants another reader access. */
export type ExchangeId = 'binance' | 'bybit' | 'okx' | 'mexc' | 'hitbtc';
export type MarketType = 'spot' | 'perpetual';
export interface MarketId { exchange: ExchangeId; type: MarketType; instrumentId: string; base: string; quote: string }
export type ResearchExchange = 'mexc' | 'okx';
export type ResearchBase = 'BTC' | 'ETH';
export interface ResearchMarket extends MarketId {
  exchange: ResearchExchange; type: 'perpetual'; base: ResearchBase; quote: 'USDT'; settlement: 'USDT';
}
export interface PublicReceipt { url: string; requestedAt: number; receivedAt: number }
export interface InstrumentSpec {
  schema: 1; kind: 'public-linear-contract'; market: ResearchMarket; receipt: PublicReceipt;
  sourceUpdatedAt: null; quantityUnit: 'contracts'; basePerContract: string; contractMultiplier: '1';
  quantityStepContracts: string; minimumContracts: string; priceTick: string;
  baseQuantityStep: string; baseMinimumQuantity: string;
  maximumContractsReported: string | null; limitMaximumContractsReported: string | null;
  publicState: string; exchangeApiAllowed: boolean | null; publicListingUsable: boolean;
  upcomingChange: boolean; feeGroupId: string | null;
  accountEligibilityVerified: false; personalFeesVerified: false; executable: false;
}
export interface FundingEstimate {
  schema: 1; kind: 'public-funding-estimate'; market: ResearchMarket; receipt: PublicReceipt;
  sourceUpdatedAt: number | null; rate: string; rateMeaning: 'estimate-not-settled';
  upcomingSettlementAt: number; followingSettlementAt: number | null; intervalMs: number;
  intervalBasis: 'reported-cycle' | 'next-times-difference';
  realizedAccountIncome: null; executable: false;
}
export class MarketDataError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'MarketDataError'; }
}
export const reject = (code = 'invalid-public-data'): never => { throw new MarketDataError(code); };
export function market(exchange: ResearchExchange, base: ResearchBase): ResearchMarket {
  if (!['mexc','okx'].includes(exchange) || !['BTC','ETH'].includes(base)) return reject('unsupported-market');
  return Object.freeze({exchange,type:'perpetual',base,quote:'USDT',settlement:'USDT',instrumentId:exchange==='mexc'?`${base}_USDT`:`${base}-USDT-SWAP`});
}
export function publicUrl(exchange: ResearchExchange, base: ResearchBase, kind: 'instrument' | 'funding'): string {
  const m=market(exchange,base);
  if (!['instrument','funding'].includes(kind)) return reject('unsupported-public-route');
  return exchange==='mexc' ? `https://api.mexc.com/api/v1/contract/${kind==='instrument'?'detail/country?symbol=':'funding_rate/'}${m.instrumentId}` :
    `https://www.okx.com/api/v5/public/${kind==='instrument'?'instruments?instType=SWAP&instId=':'funding-rate?instId='}${m.instrumentId}`;
}
export function assertReceipt(receipt: PublicReceipt, exchange: ResearchExchange, base: ResearchBase, kind: 'instrument' | 'funding') {
  if (!receipt || Object.keys(receipt).sort().join(',')!=='receivedAt,requestedAt,url' || receipt.url!==publicUrl(exchange,base,kind) ||
    !Number.isSafeInteger(receipt.requestedAt)||!Number.isSafeInteger(receipt.receivedAt)||receipt.requestedAt<=0||
    receipt.receivedAt<receipt.requestedAt||receipt.receivedAt-receipt.requestedAt>5000||receipt.receivedAt>8_640_000_000_000_000) reject('invalid-public-timing');
}
export function freeze<T>(value: T): T {
  if (value && typeof value==='object') {Object.values(value).forEach(freeze);Object.freeze(value);}return value;
}
