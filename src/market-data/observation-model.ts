/** D0b public observations. Receipt time is not automatically a market update time. */
import { decimal, multiply, numberText, timestamp, units } from './exact-json.js';
import { assertReceipt, freeze, market, publicUrl, reject, type InstrumentSpec, type PublicReceipt, type ResearchBase, type ResearchExchange, type ResearchMarket } from './model.js';
export type ObservationRoute = 'instrument' | 'funding' | 'book' | 'ticker' | 'mark' | 'index' | 'open-interest' | 'history';
export interface Route { exchange: ResearchExchange; base: ResearchBase; kind: ObservationRoute }
export type TimeMeaning = 'book-generation' | 'price-update' | 'exchange-system' | 'trade' | 'response-time';
export interface SourceTime {
  at: number | null; meaning: TimeMeaning; ageMs: number | null;
  ageStatus: 'within-window' | 'stale' | 'future' | 'missing'; representsUpdate: boolean;
}
export interface BookLevel { price: string; quantityContracts: string; quantityBase: string; orderCount: string }
interface ObservationBase {
  schema: 1; market: ResearchMarket; receipt: PublicReceipt; metadataReceivedAt: number;
  identityBinding: 'request' | 'request-and-response'; executable: false;
}
export interface PerpetualBook extends ObservationBase {
  kind: 'public-perpetual-book'; bids: readonly BookLevel[]; asks: readonly BookLevel[];
  sequence: string; sourceTime: SourceTime; auxiliaryTimestamp: number | null;
  auxiliaryTimestampVerified: false; sourceFreshnessVerified: boolean;
}
export interface MarketMetrics extends ObservationBase {
  kind: 'public-market-metrics'; component: 'ticker' | 'mark' | 'index' | 'open-interest';
  markPrice: string | null; indexPrice: string | null; openInterestContracts: string | null;
  openInterestBase: string | null; reportedOpenInterestBase: string | null; openInterestUsd: string | null;
  openInterestBaseConsistency: 'matches' | 'differs' | 'not-reported' | null;
  sourceTime: SourceTime; sourceFreshnessVerified: boolean;
}
export interface FundingEvent {
  settlementAt: number; forecastRate: string | null; settledRate: string | null;
  rateMeaning: 'reported-settlement-rate' | 'exchange-realized-rate' | 'unavailable';
  reportedIntervalMs: number | null; method: string | null; formula: string | null;
}
export interface FundingHistory extends ObservationBase {
  kind: 'public-funding-history'; events: readonly FundingEvent[]; limit: 20;
  totalRecords: number | null; totalPages: number | null; hasMore: boolean | null;
  historyComplete: false; continuityVerified: false; realizedAccountIncome: null;
}
export function observationUrl(exchange: ResearchExchange, base: ResearchBase, kind: ObservationRoute): string {
  const m = market(exchange, base);
  if (kind === 'instrument' || kind === 'funding') return publicUrl(exchange, base, kind);
  if (exchange === 'mexc') {
    const root = 'https://api.mexc.com/api/v1/contract/';
    if (kind === 'book') return `${root}depth/${m.instrumentId}?limit=50`;
    if (kind === 'ticker') return `${root}ticker?symbol=${m.instrumentId}`;
    if (kind === 'history') return `${root}funding_rate/history?symbol=${m.instrumentId}&page_num=1&page_size=20`;
  } else {
    const root = 'https://www.okx.com/api/v5/';
    if (kind === 'book') return `${root}market/books?instId=${m.instrumentId}&sz=50`;
    if (kind === 'mark') return `${root}public/mark-price?instType=SWAP&instId=${m.instrumentId}`;
    if (kind === 'index') return `${root}market/index-tickers?instId=${base}-USDT`;
    if (kind === 'open-interest') return `${root}public/open-interest?instType=SWAP&instId=${m.instrumentId}`;
    if (kind === 'history') return `${root}public/funding-rate-history?instId=${m.instrumentId}&limit=20`;
  }
  return reject('unsupported-observation-route');
}
export function observationPlan(): readonly Route[] {
  const routes: Route[] = [];
  for (const base of ['BTC', 'ETH'] as const) {
    for (const kind of ['instrument', 'funding'] as const) for (const exchange of ['mexc', 'okx'] as const) routes.push({exchange,base,kind});
    routes.push({exchange:'mexc',base,kind:'ticker'});
    for (const kind of ['mark','index','open-interest'] as const) routes.push({exchange:'okx',base,kind});
    for (const kind of ['history', 'book'] as const) for (const exchange of ['mexc','okx'] as const) routes.push({exchange,base,kind});
  }
  return freeze(routes);
}
export function assertObservationReceipt(receipt: PublicReceipt, route: Route): void {
  if (!receipt || Object.keys(receipt).sort().join(',') !== 'receivedAt,requestedAt,url' ||
      receipt.url !== observationUrl(route.exchange, route.base, route.kind) ||
      timestamp(String(receipt.requestedAt)) !== receipt.requestedAt || timestamp(String(receipt.receivedAt)) !== receipt.receivedAt ||
      receipt.receivedAt < receipt.requestedAt || receipt.receivedAt - receipt.requestedAt > (route.kind === 'book' ? 3000 : 5000)) return reject('invalid-observation-receipt');
}
export function assertBoundSpec(spec: InstrumentSpec, route: Route, receipt: PublicReceipt): void {
  assertObservationReceipt(receipt, route);
  const expected = market(route.exchange, route.base);
  if (!spec || spec.schema !== 1 || spec.kind !== 'public-linear-contract' || !spec.market ||
      Object.entries(expected).some(([k,v]) => spec.market[k as keyof ResearchMarket] !== v) ||
      spec.quantityUnit !== 'contracts' || spec.contractMultiplier !== '1') return reject('observation-spec-mismatch');
  assertReceipt(spec.receipt, route.exchange, route.base, 'instrument');
  if (spec.receipt.receivedAt > receipt.requestedAt || receipt.requestedAt - spec.receipt.receivedAt > 1_200_000 ||
      spec.baseQuantityStep !== multiply(decimal(spec.basePerContract,false,true), decimal(spec.quantityStepContracts,false,true)) ||
      spec.baseMinimumQuantity !== multiply(decimal(spec.basePerContract,false,true), decimal(spec.minimumContracts,false,true)) ||
      units(decimal(spec.minimumContracts,false,true)) % units(decimal(spec.quantityStepContracts,false,true)) !== 0n) return reject('observation-spec-mismatch');
  decimal(spec.priceTick,false,true);
}
export function sourceTime(value: unknown, meaning: TimeMeaning, receipt: PublicReceipt, maximumAgeMs: number): SourceTime {
  const at = value === undefined || value === null || value === '' ? null : timestamp(value);
  const ageMs = at === null ? null : receipt.receivedAt - at;
  return {at,meaning,ageMs,ageStatus:ageMs===null?'missing':ageMs < -5000?'future':ageMs>maximumAgeMs?'stale':'within-window',
    representsUpdate:meaning==='book-generation'||meaning==='price-update'};
}
export const sourceFresh = (time: SourceTime): boolean => time.representsUpdate && time.ageStatus === 'within-window';
export function integerText(value: unknown): string {
  const text=numberText(value);if(!/^(?:0|[1-9]\d{0,29})$/.test(text)) return reject('invalid-observation-integer');return text;
}
export function historyCount(value: unknown): number {
  const n=Number(integerText(value));if(!Number.isSafeInteger(n))return reject('invalid-history-count');return n;
}
export function signedRate(value: unknown): string {
  const n=decimal(value,true);if(units(n)<-units('1')||units(n)>units('1'))return reject('invalid-history-rate');return n;
}
export function bookLevels(rows: unknown, side: 'bids'|'asks', columns: 3|4, spec: InstrumentSpec): readonly BookLevel[] {
  if(!Array.isArray(rows)||rows.length<1||rows.length>50)return reject('invalid-public-book');
  let previous:bigint|null=null;
  return rows.map(row=>{
    if(!Array.isArray(row)||row.length!==columns)return reject('invalid-public-book');
    const price=decimal(row[0],false,true),quantityContracts=decimal(row[1],false,true),p=units(price);
    if(p%units(decimal(spec.priceTick,false,true)) || units(quantityContracts)%units(decimal(spec.quantityStepContracts,false,true)) ||
       previous!==null && (side==='bids'?p>=previous:p<=previous))return reject('invalid-public-book');
    if(columns===4 && numberText(row[2])!=='0')return reject('invalid-public-book');
    previous=p;
    return {price,quantityContracts,quantityBase:multiply(quantityContracts,spec.basePerContract),orderCount:integerText(row[columns-1])};
  });
}
export function assertUncrossed(bids: readonly BookLevel[], asks: readonly BookLevel[]): void {
  if(units(bids[0].price)>=units(asks[0].price))return reject('crossed-public-book');
}
export function assertHistoryOrder(events: readonly FundingEvent[], receipt: PublicReceipt): void {
  if(events.length>20)return reject('invalid-history-count');
  let previous=receipt.requestedAt;
  for(const event of events){if(event.settlementAt>=previous)return reject('invalid-history-order');previous=event.settlementAt;}
}
