import { describe, expect, it } from 'vitest';
import { parsePublicJson } from '../src/market-data/exact-json.js';
import { type PublicReceipt, type ResearchBase, type ResearchExchange } from '../src/market-data/model.js';
import { parseSpotBook, parseSpotInstrument, spotUrl, type SpotInstrument } from '../src/market-data/spot-observations.js';

// Synthetic documentation-derived payloads only: these tests make no exchange requests.
const now=1_790_840_507_000;
const wire=(raw:unknown)=>parsePublicJson(Buffer.from(JSON.stringify(raw)));
const receipt=(exchange:ResearchExchange,kind:'instrument'|'book',base:ResearchBase='BTC'):PublicReceipt=>({
  url:spotUrl(exchange,base,kind),requestedAt:kind==='instrument'?now-1000:now,receivedAt:kind==='instrument'?now-900:now+100,
});
function instrumentRaw(exchange:ResearchExchange,base:ResearchBase='BTC',patch:Record<string,unknown>={}) {
  return exchange==='okx'?{code:'0',data:[{instType:'SPOT',instId:`${base}-USDT`,baseCcy:base,quoteCcy:'USDT',state:'live',
    tickSz:'0.1',lotSz:'0.00000001',minSz:'0.00001',listTime:'1573557408000',expTime:'',contTdSwTime:'',
    upcChg:[],ruleType:'normal',tradeQuoteCcyList:['USDT'],...patch}]}:
    {symbols:[{symbol:`${base}USDT`,baseAsset:base,quoteAsset:'USDT',status:'1',baseAssetPrecision:8,quoteAssetPrecision:2,
      quotePrecision:2,baseSizePrecision:'0.000001',quoteAmountPrecision:'1',isSpotTradingAllowed:true,tradeSideType:1,
      orderTypes:['LIMIT','MARKET','LIMIT_MAKER'],permissions:['SPOT'],filters:[{filterType:'PERCENT_PRICE_BY_SIDE',bidMultiplierUp:'0.2',askMultiplierDown:'0.2'}],...patch}]};
}
const instrument=(exchange:ResearchExchange,base:ResearchBase='BTC',patch:Record<string,unknown>={})=>
  parseSpotInstrument(wire(instrumentRaw(exchange,base,patch)),exchange,base,receipt(exchange,'instrument',base));
function bookRaw(exchange:ResearchExchange,patch:Record<string,unknown>={}) {
  return exchange==='okx'?{code:'0',data:[{bids:[['60000','0.12345678','0','2'],['59999.9','0.00000001','0','1']],
    asks:[['60000.1','0.5','0','1'],['60000.2','0.006','0','4']],ts:String(now-100),seqId:9001,...patch}]}:
    {bids:[['60000','0.12345678'],['59999.9','0.00000001']],asks:[['60000.1','0.5'],['60000.2','0.006']],lastUpdateId:9001,...patch};
}
const book=(exchange:ResearchExchange,patch:Record<string,unknown>={},base:ResearchBase='BTC')=>
  parseSpotBook(wire(bookRaw(exchange,patch)),exchange,base,receipt(exchange,'book',base),instrument(exchange,base));

describe('closed Spot routes and exact public metadata',()=>{
  it.each(['BTC','ETH'] as const)('binds %s IDs and depth50 to the only permitted origins',base=>{
    expect(spotUrl('okx',base,'instrument')).toBe(`https://www.okx.com/api/v5/public/instruments?instType=SPOT&instId=${base}-USDT`);
    expect(spotUrl('okx',base,'book')).toBe(`https://www.okx.com/api/v5/market/books?instId=${base}-USDT&sz=50`);
    expect(spotUrl('mexc',base,'instrument')).toBe(`https://api.mexc.com/api/v3/exchangeInfo?symbol=${base}USDT`);
    expect(spotUrl('mexc',base,'book')).toBe(`https://api.mexc.com/api/v3/depth?symbol=${base}USDT&limit=50`);
  });
  it.each([['other','BTC','book'],['mexc','SOL','book'],['okx','BTC','funding'],['mexc','BTC&extra=x','book'],['okx','BTC','private']])('rejects runtime route escape %j/%j/%j',(exchange,base,kind)=>{
    expect(()=>spotUrl(exchange as ResearchExchange,base as ResearchBase,kind as 'book')).toThrow();
  });
  it.each(['BTC','ETH'] as const)('preserves OKX %s rules and base quantity units',base=>{
    expect(instrument('okx',base)).toMatchObject({schema:1,kind:'public-spot-instrument',market:{exchange:'okx',type:'spot',base,quote:'USDT',instrumentId:`${base}-USDT`},
      priceTick:'0.1',quantityStep:'0.00000001',minimumQuantity:'0.00001',minimumNotional:null,publicState:'live',publicListingUsable:true,executable:false});
  });
  it.each(['BTC','ETH'] as const)('does not infer MEXC %s quantity step or price tick from precision or minimum quantity',base=>{
    expect(instrument('mexc',base)).toMatchObject({market:{exchange:'mexc',type:'spot',base,instrumentId:`${base}USDT`},
      priceTick:null,quantityStep:null,minimumQuantity:'0.000001',minimumNotional:'1',publicState:'1',publicListingUsable:true,executable:false});
  });
  it('normalizes exact decimal rules without binary float',()=>{
    const s=instrument('okx','BTC',{tickSz:'0.000000000000000001',lotSz:'0.000000000000000001',minSz:'0.123456789123456789'});
    expect(s.minimumQuantity).toBe('0.123456789123456789');expect(s.quantityStep).toBe('0.000000000000000001');
  });
  it.each([{state:'suspend'},{state:'post_only'},{listTime:String(now+1)},{expTime:String(now+86400000)},
    {contTdSwTime:String(now+1)},{ruleType:'pre_market'},{tradeQuoteCcyList:['USDC']},
    {upcChg:[{param:'tickSz',newValue:'0.01',effTime:String(now+1)}]}])('keeps unsupported OKX public listing observable but unusable: %j',patch=>{
    expect(instrument('okx','BTC',patch)).toMatchObject({publicListingUsable:false,executable:false});
  });
  it.each([{status:'2'},{status:'3'},{isSpotTradingAllowed:false},{tradeSideType:2},{tradeSideType:3},{tradeSideType:4},
    {orderTypes:['MARKET']},{permissions:[]}])('keeps restricted MEXC public listing observable but unusable: %j',patch=>{
    expect(instrument('mexc','BTC',patch)).toMatchObject({publicListingUsable:false,executable:false});
  });
  it.each([{instId:'ETH-USDT'},{instType:'SWAP'},{baseCcy:'ETH'},{quoteCcy:'USD'},{tickSz:'0'},{lotSz:'0'},
    {minSz:'0'},{lotSz:'0.03',minSz:'0.01'},{tickSz:'NaN'},{lotSz:'1e-31'},{state:''},{listTime:'-1'},
    {expTime:undefined},{expTime:null},{upcChg:null},{upcChg:[{param:'tickSz',newValue:'',effTime:String(now)}]},
    {tradeQuoteCcyList:['USDT','USDT']}])('rejects malformed OKX metadata: %j',patch=>expect(()=>instrument('okx','BTC',patch)).toThrow());
  it.each([{symbol:'ETHUSDT'},{baseAsset:'ETH'},{quoteAsset:'USD'},{status:'TRADING'},{status:undefined},
    {tradeSideType:0},{tradeSideType:5},{tradeSideType:'1.5'},{isSpotTradingAllowed:'true'},
    {baseAssetPrecision:-1},{quoteAssetPrecision:31},{baseAssetPrecision:1.5},{baseSizePrecision:'0'},
    {quoteAmountPrecision:'-1'},{permissions:null},{orderTypes:['LIMIT','LIMIT']},{filters:null},
    {filters:[{filterType:'contains whitespace'}]}])('rejects malformed MEXC metadata: %j',patch=>expect(()=>instrument('mexc','BTC',patch)).toThrow());
  it.each(['okx','mexc'] as const)('rejects multiple or absent %s instruments rather than picking a row',exchange=>{
    const valid=instrumentRaw(exchange) as {data?:unknown[];symbols?:unknown[]};
    const key=exchange==='okx'?'data':'symbols';
    for(const rows of [[],[valid[key]![0],valid[key]![0]],null])expect(()=>parseSpotInstrument(wire({...valid,[key]:rows}),exchange,'BTC',receipt(exchange,'instrument'))).toThrow();
  });
  it('rejects an error envelope even if plausible MEXC symbols are appended',()=>{
    expect(()=>parseSpotInstrument(wire({...instrumentRaw('mexc'),code:123}),'mexc','BTC',receipt('mexc','instrument'))).toThrow();
  });
});

describe('Spot book exact quantities, geometry, freshness and identity',()=>{
  it.each(['okx','mexc'] as const)('preserves %s base volumes without a contract multiplier',exchange=>{
    expect(book(exchange)).toMatchObject({kind:'public-spot-book',market:{type:'spot'},identityBinding:'request',
      bids:[{price:'60000',quantityBase:'0.12345678'},{price:'59999.9',quantityBase:'0.00000001'}],sequence:'9001',executable:false});
  });
  it.each(['BTC','ETH'] as const)('binds %s Spot without perpetual aliases',base=>{
    for(const exchange of ['okx','mexc'] as const)expect(book(exchange,{},base).market).toMatchObject({base,type:'spot',instrumentId:exchange==='okx'?`${base}-USDT`:`${base}USDT`});
  });
  it.each(['okx','mexc'] as const)('preserves %s unsafe-size integer wire sequences exactly',exchange=>{
    const key=exchange==='okx'?'seqId':'lastUpdateId';
    const raw=JSON.stringify(bookRaw(exchange,{[key]:'EXACT_SEQUENCE'})).replace('"EXACT_SEQUENCE"','9007199254740993123456');
    expect(parseSpotBook(parsePublicJson(Buffer.from(raw)),exchange,'BTC',receipt(exchange,'book'),instrument(exchange)).sequence).toBe('9007199254740993123456');
  });
  it('preserves fractional numeric MEXC quantities without float conversion',()=>{
    const raw=JSON.stringify(bookRaw('mexc',{bids:[['60000','EXACT_QUANTITY']]})).replace('"EXACT_QUANTITY"','0.123456789123456789123456789');
    expect(parseSpotBook(parsePublicJson(Buffer.from(raw)),'mexc','BTC',receipt('mexc','book'),instrument('mexc')).bids[0].quantityBase).toBe('0.123456789123456789123456789');
  });
  it('never promotes undocumented MEXC timestamps or receipt time into generation time',()=>{
    expect(book('mexc',{ts:String(now),timestamp:now,time:now})).toMatchObject({
      sourceTime:{at:null,ageMs:null,ageStatus:'missing',meaning:'book-generation'},sourceFreshnessVerified:false});
  });
  it.each([
    [String(now-100),'within-window',true], [String(now+100-5000),'within-window',true], [String(now+100-5001),'stale',false],
    [String(now+100+5000),'within-window',true],[String(now+100+5001),'future',false],['','missing',false],[undefined,'missing',false],[null,'missing',false],
  ])('records OKX book source time quality %s',(ts,ageStatus,verified)=>{
    expect(book('okx',{ts})).toMatchObject({sourceTime:{meaning:'book-generation',ageStatus},sourceFreshnessVerified:verified,executable:false});
  });
  it.each(['-1','0','1.5','1e3','NaN'])('rejects invalid OKX source timestamp %s',ts=>expect(()=>book('okx',{ts})).toThrow());
  it.each(['okx','mexc'] as const)('rejects %s nonpositive, duplicate, unsorted, crossed or excessive levels',exchange=>{
    const row=(price:string,quantity='1')=>exchange==='okx'?[price,quantity,'0','1']:[price,quantity];
    for(const patch of [{bids:[]},{asks:[]},{bids:null},{bids:[row('0')]},{bids:[row('-1')]},{bids:[row('60000','0')]},
      {bids:[row('60000','-1')]},{bids:[row('60000'),row('60000')]},{bids:[row('60000'),row('60000.1')]},
      {asks:[row('60000.2'),row('60000.1')]},{asks:[row('60000')]},{asks:[row('59999.9')]},
      {bids:[['60000']]},{asks:Array.from({length:51},(_,i)=>row(String(60001+i)))}])expect(()=>book(exchange,patch)).toThrow();
  });
  it.each([{bids:[['60000.05','1','0','1']]},{bids:[['60000','0.000000001','0','1']]},
    {bids:[['60000','1','1','1']]},{bids:[['60000','1','0','1.5']]},{bids:[['60000','1','0','-1']]},
    {asks:[['60000.1','1','0','1','extra']]}])('validates known OKX tick/lot and reserved/order-count columns: %j',patch=>expect(()=>book('okx',patch)).toThrow());
  it.each(['okx','mexc'] as const)('does not allow contradictory optional %s book identity',exchange=>{
    for(const patch of [{instId:'ETH-USDT'},{symbol:'ETHUSDT'},{instType:'SWAP'},{baseAsset:'ETH'},{quoteAsset:'USD'}])expect(()=>book(exchange,patch)).toThrow();
  });
  it.each(['okx','mexc'] as const)('requires a canonical documented %s sequence token',exchange=>{
    const key=exchange==='okx'?'seqId':'lastUpdateId';
    for(const seq of [undefined,null,'-1','1.5','1e3','01'])expect(()=>book(exchange,{[key]:seq})).toThrow();
    expect(book(exchange,{[key]:0}).sequence).toBe('0');
  });
  it.each(['okx','mexc'] as const)('accepts at most the actual %s returned depth without inventing missing levels',exchange=>{
    const row=(price:string)=>exchange==='okx'?[price,'1','0','1']:[price,'1'];
    for(const count of [1,50])expect(book(exchange,{bids:Array.from({length:count},(_,i)=>row(String(60000-i)))}).bids).toHaveLength(count);
  });
  it('does not impose order minimum on residual book volume',()=>{
    expect(book('okx').bids[1].quantityBase).toBe('0.00000001');
    expect(book('mexc').bids[1].quantityBase).toBe('0.00000001');
  });
});

describe('Spot receipt bounds, same-spec binding and immutable normalized evidence',()=>{
  for(const exchange of ['okx','mexc'] as const) {
    it.each(['instrument','book'] as const)(`${exchange} rejects malformed %s receipts`,kind=>{
      const r=receipt(exchange,kind);
      for(const patch of [{url:r.url+'&extra=1'},{url:r.url.replace('https:','http:')},{requestedAt:r.receivedAt+1},{requestedAt:0},
        {requestedAt:now+0.1},{receivedAt:Number.MAX_SAFE_INTEGER},{receivedAt:r.requestedAt+(kind==='book'?3001:5001)},
        {extra:'not-permitted'},{receivedAt:String(r.receivedAt)}]) {
        const bad={...r,...patch} as PublicReceipt;
        expect(()=>kind==='instrument'?parseSpotInstrument(wire(instrumentRaw(exchange)),exchange,'BTC',bad):
          parseSpotBook(wire(bookRaw(exchange)),exchange,'BTC',bad,instrument(exchange))).toThrow();
      }
    });
    it(`${exchange} accepts exact request latency boundary`,()=>{
      const meta=receipt(exchange,'instrument');
      expect(parseSpotInstrument(wire(instrumentRaw(exchange)),exchange,'BTC',{...meta,requestedAt:meta.receivedAt-5000}).executable).toBe(false);
      const r=receipt(exchange,'book');
      expect(parseSpotBook(wire(bookRaw(exchange)),exchange,'BTC',{...r,receivedAt:r.requestedAt+3000},instrument(exchange)).executable).toBe(false);
    });
    it(`${exchange} rejects stale, future, wrong-market or forged metadata bindings`,()=>{
      const s=instrument(exchange),r=receipt(exchange,'book');
      const patches:Record<string,unknown>[]=[{schema:2},{kind:'public-linear-contract'},{executable:true},{publicListingUsable:'true'},
        {market:{...s.market,base:'ETH'}},{market:{...s.market,type:'perpetual'}},{market:{...s.market,settlement:'USDT'}},
        {receipt:{...s.receipt,url:s.receipt.url+'&other=1'}},{receipt:{...s.receipt,requestedAt:now-1200002,receivedAt:now-1200001}},
        {receipt:{...s.receipt,requestedAt:now,receivedAt:now+1}},{minimumQuantity:'0'},{minimumQuantity:'0.0000100'},
        ...(exchange==='okx'?[{priceTick:null},{priceTick:'0'},{quantityStep:null},{quantityStep:'0'},{minimumNotional:'1'}]:
          [{priceTick:'0.01'},{quantityStep:'0.000001'},{minimumNotional:null},{minimumNotional:'0'}])];
      for(const patch of patches)expect(()=>parseSpotBook(wire(bookRaw(exchange)),exchange,'BTC',r,{...s,...patch} as SpotInstrument)).toThrow();
    });
    it(`${exchange} accepts metadata exactly 20 minutes old`,()=>{
      const s=instrument(exchange),meta={...s.receipt,requestedAt:now-1200100,receivedAt:now-1200000};
      expect(parseSpotBook(wire(bookRaw(exchange)),exchange,'BTC',receipt(exchange,'book'),{...s,receipt:meta}).metadataReceivedAt).toBe(now-1200000);
    });
    it(`${exchange} freezes all normalized evidence and clones external receipt`,()=>{
      const r=receipt(exchange,'instrument');
      const s=parseSpotInstrument(wire(instrumentRaw(exchange)),exchange,'BTC',r);r.receivedAt++;
      const b=book(exchange);
      expect(s.receipt.receivedAt).toBe(now-900);
      for(const value of [s,s.market,s.receipt,b,b.market,b.receipt,b.bids,b.bids[0],b.asks,b.sourceTime])expect(Object.isFrozen(value)).toBe(true);
      expect(()=>{b.bids[0].price='1';}).toThrow();
    });
  }
});
