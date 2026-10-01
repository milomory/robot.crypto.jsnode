/** Public Spot metadata/books only. No account access, fees or execution authority. */
import { decimal, numberText, record, timestamp, units } from './exact-json.js';
import { freeze, reject, type MarketId, type PublicReceipt, type ResearchBase, type ResearchExchange } from './model.js';
import { integerText, sourceFresh, sourceTime, type SourceTime } from './observation-model.js';

export interface SpotMarket extends MarketId {
  exchange: ResearchExchange; type: 'spot'; base: ResearchBase; quote: 'USDT';
}
export interface SpotInstrument {
  schema: 1; kind: 'public-spot-instrument'; market: SpotMarket; receipt: PublicReceipt;
  priceTick: string | null; quantityStep: string | null; minimumQuantity: string; minimumNotional: string | null;
  publicState: string; publicListingUsable: boolean; executable: false;
}
export interface SpotLevel { price: string; quantityBase: string }
export interface SpotBook {
  schema: 1; kind: 'public-spot-book'; market: SpotMarket; receipt: PublicReceipt;
  metadataReceivedAt: number; identityBinding: 'request'; bids: readonly SpotLevel[]; asks: readonly SpotLevel[];
  sourceTime: SourceTime; sequence: string | null; sourceFreshnessVerified: boolean; executable: false;
}
function spotMarket(exchange: ResearchExchange, base: ResearchBase): SpotMarket {
  if (!['okx','mexc'].includes(exchange) || !['BTC','ETH'].includes(base)) return reject('unsupported-spot-market');
  return {exchange,type:'spot',base,quote:'USDT',instrumentId:exchange==='okx'?`${base}-USDT`:`${base}USDT`};
}
export function spotUrl(exchange: ResearchExchange, base: ResearchBase, kind: 'instrument' | 'book'): string {
  const m = spotMarket(exchange,base);
  if (!['instrument','book'].includes(kind)) return reject('unsupported-spot-route');
  if (exchange === 'okx') return `https://www.okx.com/api/v5/${kind==='instrument'?'public/instruments?instType=SPOT&instId=':'market/books?instId='}${m.instrumentId}${kind==='book'?'&sz=50':''}`;
  return `https://api.mexc.com/api/v3/${kind==='instrument'?'exchangeInfo':'depth'}?symbol=${m.instrumentId}${kind==='book'?'&limit=50':''}`;
}
function assertSpotReceipt(receipt: PublicReceipt, exchange: ResearchExchange, base: ResearchBase, kind: 'instrument' | 'book'): void {
  if (!receipt || Object.keys(receipt).sort().join(',') !== 'receivedAt,requestedAt,url' || receipt.url !== spotUrl(exchange,base,kind) ||
      timestamp(String(receipt.requestedAt)) !== receipt.requestedAt || timestamp(String(receipt.receivedAt)) !== receipt.receivedAt ||
      receipt.receivedAt < receipt.requestedAt || receipt.receivedAt - receipt.requestedAt > (kind==='book'?3000:5000)) {
    return reject('invalid-spot-receipt');
  }
}
function okxItem(raw: unknown): Record<string,unknown> {
  const envelope=record(raw);
  if (envelope.code !== '0' || !Array.isArray(envelope.data) || envelope.data.length !== 1) return reject('invalid-spot-envelope');
  return record(envelope.data[0]);
}
function label(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(raw)) return reject('invalid-spot-label');
  return raw;
}
function labels(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length>32) return reject('invalid-spot-labels');
  const values=raw.map(label);if(new Set(values).size!==values.length)return reject('invalid-spot-labels');return values;
}
function precision(raw: unknown): void {
  const value=integerText(raw);if(BigInt(value)>30n)return reject('invalid-spot-precision');
}
export function parseSpotInstrument(raw: unknown, exchange: ResearchExchange, base: ResearchBase, receipt: PublicReceipt): SpotInstrument {
  assertSpotReceipt(receipt,exchange,base,'instrument');
  const market=spotMarket(exchange,base);
  let priceTick: string|null, quantityStep: string|null, minimumQuantity: string, minimumNotional: string|null;
  let publicState: string, publicListingUsable: boolean;
  if(exchange==='okx') {
    const row=okxItem(raw);
    if(row.instType!=='SPOT'||row.instId!==market.instrumentId||row.baseCcy!==base||row.quoteCcy!=='USDT')return reject('unexpected-spot-instrument');
    priceTick=decimal(row.tickSz,false,true);quantityStep=decimal(row.lotSz,false,true);minimumQuantity=decimal(row.minSz,false,true);
    if(units(minimumQuantity)%units(quantityStep)!==0n)return reject('invalid-spot-limits');
    minimumNotional=null; // This public endpoint does not document a Spot minimum notional.
    publicState=label(row.state);
    const listedAt=timestamp(row.listTime);
    if(typeof row.expTime!=='string'||!Array.isArray(row.upcChg)||row.upcChg.length>20)return reject('invalid-spot-listing');
    const expiresAt=row.expTime===''?null:timestamp(row.expTime);
    const continuousAt=row.contTdSwTime===undefined||row.contTdSwTime===''?null:timestamp(row.contTdSwTime);
    for(const rawChange of row.upcChg) {
      const change=record(rawChange);label(change.param);timestamp(change.effTime);
      if(typeof change.newValue!=='string'||change.newValue.length===0||change.newValue.length>128)return reject('invalid-spot-listing');
    }
    const quoteCurrencies=row.tradeQuoteCcyList===undefined?null:labels(row.tradeQuoteCcyList);
    publicListingUsable=publicState==='live'&&listedAt<=receipt.requestedAt&&expiresAt===null&&row.upcChg.length===0&&
      (continuousAt===null||continuousAt<=receipt.requestedAt)&&row.ruleType==='normal'&&
      (quoteCurrencies===null||quoteCurrencies.length===0||quoteCurrencies.includes('USDT'));
  } else {
    const envelope=record(raw);
    if(envelope.code!==undefined||!Array.isArray(envelope.symbols)||envelope.symbols.length!==1)return reject('invalid-spot-envelope');
    const row=record(envelope.symbols[0]);
    if(row.symbol!==market.instrumentId||row.baseAsset!==base||row.quoteAsset!=='USDT')return reject('unexpected-spot-instrument');
    publicState=numberText(row.status);
    if(!['1','2','3'].includes(publicState)||typeof row.isSpotTradingAllowed!=='boolean')return reject('invalid-spot-listing');
    const side=integerText(row.tradeSideType);
    if(!['1','2','3','4'].includes(side))return reject('invalid-spot-listing');
    precision(row.baseAssetPrecision);precision(row.quoteAssetPrecision);
    const orderTypes=labels(row.orderTypes),permissions=labels(row.permissions);
    if(!Array.isArray(row.filters)||row.filters.length>20)return reject('invalid-spot-listing');
    for(const rawFilter of row.filters)label(record(rawFilter).filterType);
    minimumQuantity=decimal(row.baseSizePrecision,false,true);minimumNotional=decimal(row.quoteAmountPrecision,false,true);
    // MEXC calls baseSizePrecision a MINIMUM quantity. Asset decimal precision does not
    // document a step/tick rule. Never derive executable increments from either field.
    priceTick=null;quantityStep=null;
    publicListingUsable=publicState==='1'&&side==='1'&&row.isSpotTradingAllowed&&orderTypes.includes('LIMIT')&&permissions.includes('SPOT');
  }
  return freeze({schema:1,kind:'public-spot-instrument',market,receipt:{...receipt},priceTick,quantityStep,
    minimumQuantity,minimumNotional,publicState,publicListingUsable,executable:false});
}
function assertSpec(spec: SpotInstrument, exchange: ResearchExchange, base: ResearchBase, receipt: PublicReceipt): void {
  const expected=spotMarket(exchange,base);
  if(!spec||spec.schema!==1||spec.kind!=='public-spot-instrument'||!spec.market||
      Object.keys(spec.market).sort().join(',')!=='base,exchange,instrumentId,quote,type'||
      Object.entries(expected).some(([key,value])=>spec.market[key as keyof SpotMarket]!==value)||
      spec.executable!==false||typeof spec.publicListingUsable!=='boolean')return reject('spot-spec-mismatch');
  assertSpotReceipt(spec.receipt,exchange,base,'instrument');label(spec.publicState);
  if(spec.receipt.receivedAt>receipt.requestedAt||receipt.requestedAt-spec.receipt.receivedAt>1_200_000||
      decimal(spec.minimumQuantity,false,true)!==spec.minimumQuantity)return reject('spot-spec-mismatch');
  if(exchange==='okx') {
    if(decimal(spec.priceTick,false,true)!==spec.priceTick||decimal(spec.quantityStep,false,true)!==spec.quantityStep||
      spec.minimumNotional!==null||units(spec.minimumQuantity)%units(spec.quantityStep)!==0n)return reject('spot-spec-mismatch');
  } else if(spec.priceTick!==null||spec.quantityStep!==null||decimal(spec.minimumNotional,false,true)!==spec.minimumNotional) {
    return reject('spot-spec-mismatch');
  }
}
function levels(raw: unknown, side: 'bids'|'asks', exchange: ResearchExchange, spec: SpotInstrument): readonly SpotLevel[] {
  if(!Array.isArray(raw)||raw.length<1||raw.length>50)return reject('invalid-spot-book');
  let previous:bigint|null=null;
  return raw.map(value=>{
    if(!Array.isArray(value)||value.length!==(exchange==='okx'?4:2))return reject('invalid-spot-book');
    const price=decimal(value[0],false,true),quantityBase=decimal(value[1],false,true),p=units(price);
    if(spec.priceTick!==null&&p%units(spec.priceTick)!==0n||
      spec.quantityStep!==null&&units(quantityBase)%units(spec.quantityStep)!==0n||
      previous!==null&&(side==='bids'?p>=previous:p<=previous))return reject('invalid-spot-book');
    if(exchange==='okx') {
      if(numberText(value[2])!=='0')return reject('invalid-spot-book');
      integerText(value[3]);
    }
    previous=p;return {price,quantityBase};
  });
}
export function parseSpotBook(raw: unknown, exchange: ResearchExchange, base: ResearchBase, receipt: PublicReceipt, spec: SpotInstrument): SpotBook {
  assertSpotReceipt(receipt,exchange,base,'book');assertSpec(spec,exchange,base,receipt);
  const market=spotMarket(exchange,base),row=exchange==='okx'?okxItem(raw):record(raw);
  if(exchange==='mexc'&&row.code!==undefined||row.instId!==undefined&&row.instId!==market.instrumentId||
    row.symbol!==undefined&&row.symbol!==market.instrumentId||row.instType!==undefined&&row.instType!=='SPOT'||
    row.baseAsset!==undefined&&row.baseAsset!==base||row.quoteAsset!==undefined&&row.quoteAsset!=='USDT')return reject('unexpected-spot-instrument');
  const bids=levels(row.bids,'bids',exchange,spec),asks=levels(row.asks,'asks',exchange,spec);
  if(units(bids[0].price)>=units(asks[0].price))return reject('crossed-spot-book');
  // MEXC REST depth has lastUpdateId but no documented generation timestamp.
  // Even an incidental ts/time field cannot establish market-update freshness.
  const time=sourceTime(exchange==='okx'?row.ts:null,'book-generation',receipt,5000);
  const sequence=integerText(exchange==='okx'?row.seqId:row.lastUpdateId);
  return freeze({schema:1,kind:'public-spot-book',market,receipt:{...receipt},metadataReceivedAt:spec.receipt.receivedAt,
    identityBinding:'request',bids,asks,sourceTime:time,sequence,sourceFreshnessVerified:sourceFresh(time),executable:false});
}
