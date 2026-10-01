import { describe, expect, it } from 'vitest';
import { parsePublicJson } from '../src/market-data/exact-json.js';
import { parseOkxInstrument } from '../src/market-data/okx.js';
import { parseOkxBook, parseOkxHistory, parseOkxMetrics } from '../src/market-data/okx-observations.js';
import { publicUrl, type InstrumentSpec, type PublicReceipt, type ResearchBase } from '../src/market-data/model.js';
import { observationUrl, type ObservationRoute } from '../src/market-data/observation-model.js';

// Documentation-derived synthetic fixtures. This test never asserts live OKX API acceptance.
const now = 1_790_840_507_000;
const receipt = (kind: ObservationRoute, base: ResearchBase = 'BTC'): PublicReceipt => ({
  url:observationUrl('okx',base,kind),requestedAt:now,receivedAt:now+100,
});
const wire = (rows: unknown[], envelope: Record<string,unknown> = {}) =>
  parsePublicJson(Buffer.from(JSON.stringify({code:'0',data:rows,...envelope})));
function spec(base: ResearchBase = 'BTC'): InstrumentSpec {
  const raw = wire([{instId:`${base}-USDT-SWAP`,instType:'SWAP',instFamily:`${base}-USDT`,uly:`${base}-USDT`,
    ctType:'linear',ctValCcy:base,settleCcy:'USDT',ctVal:base==='BTC'?'0.01':'0.1',ctMult:'1',baseCcy:'',quoteCcy:'',
    lotSz:'0.01',minSz:'0.01',tickSz:base==='BTC'?'0.1':'0.01',maxMktSz:'20000',maxLmtSz:'1000000',
    state:'live',listTime:'1573557408000',expTime:'',upcChg:[],tradeQuoteCcyList:[],groupId:'4',ruleType:'normal'}]);
  return parseOkxInstrument(raw,base,{url:publicUrl('okx',base,'instrument'),requestedAt:now-1000,receivedAt:now-900});
}
const book = (patch: Record<string,unknown> = {}) => ({
  bids:[['60000','12.34','0','2'],['59999.9','0.01','0','1']],
  asks:[['60000.1','2','0','1'],['60000.2','3.45','0','4']],seqId:9001,ts:String(now-100),...patch,
});
const metric = (component:'mark'|'index'|'open-interest', patch: Record<string,unknown> = {}, base:ResearchBase='BTC') => ({
  instType:'SWAP',instId:component==='index'?`${base}-USDT`:`${base}-USDT-SWAP`,ts:String(now-100),
  ...(component==='mark'?{markPx:'60000.123456789123456789'}:component==='index'?{idxPx:'60001.987654321987654321'}:
    {oi:'2216113.01000000309',oiCcy:base==='BTC'?'22161.1301000000309':'221611.301000000309',oiUsd:'1939251795.54769270396321'}),...patch,
});
const event = (patch: Record<string,unknown> = {}, base:ResearchBase='BTC') => ({
  instType:'SWAP',instId:`${base}-USDT-SWAP`,fundingTime:String(now-3600000),fundingRate:'0.0000746604960499',
  realizedRate:'0.0000746572360545',method:'current_period',formulaType:'withRate',...patch,
});
const parseBook = (patch: Record<string,unknown> = {}, base:ResearchBase='BTC') => parseOkxBook(wire([book(patch)]),base,receipt('book',base),spec(base));
const parseMetric = (component:'mark'|'index'|'open-interest', patch:Record<string,unknown>={},base:ResearchBase='BTC') =>
  parseOkxMetrics(wire([metric(component,patch,base)]),base,receipt(component,base),spec(base),component);
const parseHistory = (events:unknown[] = [event()],base:ResearchBase='BTC') => parseOkxHistory(wire(events),base,receipt('history',base),spec(base));

describe('OKX bounded perpetual order books',()=>{
  it.each([['BTC','0.1234'],['ETH','1.234']] as const)('converts %s contracts to base and preserves request-only identity',(base,quantityBase)=>{
    const result=parseBook({},base);
    expect(result).toMatchObject({kind:'public-perpetual-book',market:{base,type:'perpetual',exchange:'okx'},identityBinding:'request',
      bids:[{price:'60000',quantityContracts:'12.34',quantityBase,orderCount:'2'},{price:'59999.9'}],sequence:'9001',
      sourceTime:{at:now-100,meaning:'book-generation',representsUpdate:true,ageStatus:'within-window'},sourceFreshnessVerified:true,
      auxiliaryTimestamp:null,auxiliaryTimestampVerified:false,executable:false});
  });
  it('retains very large numeric sequence tokens exactly',()=>{
    const text=JSON.stringify({code:'0',data:[book({seqId:'EXACT'})]}).replace('"EXACT"','9007199254740993');
    expect(parseOkxBook(parsePublicJson(Buffer.from(text)),'BTC',receipt('book'),spec()).sequence).toBe('9007199254740993');
  });
  it('retains exact fractional contract volume without float loss',()=>{
    const custom={...spec(),quantityStepContracts:'0.000000000000000001',baseQuantityStep:'0.00000000000000000001'};
    const result=parseOkxBook(wire([book({bids:[['60000','1.123456789123456789','0','2']]})]),'BTC',receipt('book'),custom);
    expect(result.bids[0].quantityBase).toBe('0.01123456789123456789');
  });
  it.each([
    {bids:[]},{asks:[]},{bids:null},{asks:{}},{bids:[['60000','1','1']]},{asks:[['60000.1','1','0','1','extra']]},
    {bids:[['60000','1','1','1']]},{bids:[['60000','-1','0','1']]},{bids:[['60000','0','0','1']]},
    {bids:[['60000','0.015','0','1']]},{bids:[['60000.05','1','0','1']]},{bids:[['0','1','0','1']]},
    {bids:[['60000','1','0','1.5']]},{bids:[['60000','1','0','-1']]},
    {bids:[['60000','1','0','1'],['60000','2','0','1']]},
    {bids:[['60000','1','0','1'],['60000.1','2','0','1']]},
    {asks:[['60000.2','1','0','1'],['60000.1','2','0','1']]},
    {asks:[['60000','1','0','1']]},{asks:[['59999.9','1','0','1']]},
    {seqId:undefined},{seqId:'-1'},{seqId:'1.2'},{seqId:'1e3'},
    {instId:'ETH-USDT-SWAP'},{instType:'SPOT'},
  ])('rejects invalid book geometry, units or contradictory identity: %j',patch=>{expect(()=>parseBook(patch)).toThrow();});
  it('rejects depth greater than its requested 50 levels',()=>{
    expect(()=>parseBook({asks:Array.from({length:51},(_,i)=>[String(60001+i),'1','0','1'])})).toThrow('invalid-public-book');
  });
  it.each([
    [String(now+100-5000),'within-window',true], [String(now+100-5001),'stale',false],
    [String(now+100+5001),'future',false], ['', 'missing',false], [undefined,'missing',false],
  ])('keeps book timing quality explicit for source ts %s',(ts,ageStatus,fresh)=>{
    expect(parseBook({ts})).toMatchObject({sourceTime:{ageStatus,meaning:'book-generation'},sourceFreshnessVerified:fresh,executable:false});
  });
  it('does not promote a suspended public listing to executable',()=>{
    const result=parseOkxBook(wire([book()]),'BTC',receipt('book'),{...spec(),publicListingUsable:false,publicState:'suspend'});
    expect(result.executable).toBe(false);
  });
});

describe('OKX public mark, index and open interest',()=>{
  it('does not confuse REST mark response time with price-update freshness',()=>{
    expect(parseMetric('mark')).toMatchObject({component:'mark',markPrice:'60000.123456789123456789',indexPrice:null,openInterestContracts:null,
      identityBinding:'request-and-response',sourceTime:{meaning:'response-time',representsUpdate:false,ageStatus:'within-window'},sourceFreshnessVerified:false});
  });
  it.each(['BTC','ETH'] as const)('binds %s index separately from perpetual identity and preserves index freshness',base=>{
    expect(parseMetric('index',{},base)).toMatchObject({component:'index',indexPrice:'60001.987654321987654321',markPrice:null,
      market:{instrumentId:`${base}-USDT-SWAP`},sourceTime:{meaning:'price-update',representsUpdate:true},sourceFreshnessVerified:true});
  });
  it.each([['BTC','22161.1301000000309'],['ETH','221611.301000000309']] as const)('keeps %s contracts, base and USD distinct',(base,amount)=>{
    expect(parseMetric('open-interest',{},base)).toMatchObject({openInterestContracts:'2216113.01000000309',openInterestBase:amount,
      reportedOpenInterestBase:amount,openInterestBaseConsistency:'matches',openInterestUsd:'1939251795.54769270396321',
      sourceTime:{meaning:'response-time',representsUpdate:false},sourceFreshnessVerified:false,executable:false});
  });
  it('flags differences in reported oiCcy instead of replacing either exact value',()=>{
    expect(parseMetric('open-interest',{oi:'123.45',oiCcy:'1.23'})).toMatchObject({openInterestContracts:'123.45',openInterestBase:'1.2345',
      reportedOpenInterestBase:'1.23',openInterestBaseConsistency:'differs'});
  });
  it('preserves legitimate zero open interest',()=>{
    expect(parseMetric('open-interest',{oi:'0',oiCcy:'0',oiUsd:'0'})).toMatchObject({openInterestContracts:'0',openInterestBase:'0',reportedOpenInterestBase:'0',openInterestUsd:'0'});
  });
  it('accepts aggregated OI precision independently of order lot sizing',()=>{
    expect(parseMetric('open-interest',{oi:'0.123456789123456789',oiCcy:'0.00123456789123456789'}).openInterestBase).toBe('0.00123456789123456789');
  });
  it.each(['mark','index','open-interest'] as const)('marks absent, stale and future %s timing as unverified',component=>{
    for(const [ts,ageStatus] of [[undefined,'missing'],[String(now+100-120001),'stale'],[String(now+100+5001),'future']] as const)
      expect(parseMetric(component,{ts})).toMatchObject({sourceTime:{ageStatus},sourceFreshnessVerified:false});
  });
  it.each([
    ['mark',{instId:'ETH-USDT-SWAP'}],['mark',{instType:'FUTURES'}],['mark',{markPx:'0'}],['mark',{markPx:'-1'}],['mark',{markPx:''}],
    ['index',{instId:'BTC-USDT-SWAP'}],['index',{instId:'BTC-USD'}],['index',{idxPx:'NaN'}],['index',{idxPx:'0'}],
    ['open-interest',{instType:'SPOT'}],['open-interest',{instId:'ETH-USDT-SWAP'}],['open-interest',{oi:'-1'}],
    ['open-interest',{oiCcy:undefined}],['open-interest',{oiUsd:''}],['open-interest',{oiUsd:'-1'}],['open-interest',{oi:'1e-31'}],
  ] as const)('rejects malformed or mismatched %s metric %j',(component,patch)=>{expect(()=>parseMetric(component,patch)).toThrow();});
});

describe('OKX funding history retains actual rates without inventing account income',()=>{
  it('keeps forecast and realized values separate with method and formula version',()=>{
    expect(parseHistory()).toMatchObject({kind:'public-funding-history',identityBinding:'request-and-response',
      events:[{settlementAt:now-3600000,forecastRate:'0.0000746604960499',settledRate:'0.0000746572360545',
        rateMeaning:'exchange-realized-rate',method:'current_period',formula:'withRate',reportedIntervalMs:null}],
      limit:20,totalRecords:null,totalPages:null,hasMore:null,historyComplete:false,continuityVerified:false,realizedAccountIncome:null,executable:false});
  });
  it('binds ETH history independently',()=>{expect(parseHistory([event({},'ETH')],'ETH').market.base).toBe('ETH');});
  it.each([undefined,null,''])('does not substitute forecast for unavailable realizedRate %s',realizedRate=>{
    expect(parseHistory([event({realizedRate,fundingRate:'0.3'})]).events[0]).toMatchObject({settledRate:null,rateMeaning:'unavailable',forecastRate:'0.3'});
  });
  it.each([undefined,null,''])('keeps missing forecast unknown, not zero %s',fundingRate=>{
    expect(parseHistory([event({fundingRate})]).events[0].forecastRate).toBeNull();
  });
  it.each(['0','-0.000000000000000000000000000001','1','-1'])('preserves signed actual rate %s',rate=>{
    expect(parseHistory([event({realizedRate:rate})]).events[0]).toMatchObject({settledRate:rate,rateMeaning:'exchange-realized-rate'});
  });
  it('retains historical old mechanism and formula rather than rewriting to current version',()=>{
    expect(parseHistory([event({method:'next_period',formulaType:'noRate'})]).events[0]).toMatchObject({method:'next_period',formula:'noRate'});
  });
  it('records irregular settlement times without inferring fixed intervals or gap-free history',()=>{
    const result=parseHistory([1,3,9,17].map(hours=>event({fundingTime:String(now-hours*3600000)})));
    expect(result.events.map(row=>row.reportedIntervalMs)).toEqual([null,null,null,null]);expect(result.continuityVerified).toBe(false);
  });
  it.each([0,1,19,20])('does not assert completeness or pagination from %s events',count=>{
    const result=parseHistory(Array.from({length:count},(_,i)=>event({fundingTime:String(now-(i+1)*3600000)})));
    expect(result.events).toHaveLength(count);expect(result).toMatchObject({historyComplete:false,hasMore:null,totalRecords:null,totalPages:null});
  });
  it('rejects more than the explicitly requested 20 rows',()=>{
    expect(()=>parseHistory(Array.from({length:21},(_,i)=>event({fundingTime:String(now-(i+1)*3600000)})))).toThrow('invalid-history-count');
  });
  it.each([
    {instId:'ETH-USDT-SWAP'},{instType:'FUTURES'},{fundingTime:String(now)},{fundingTime:String(now+1)},
    {fundingTime:'0'},{fundingTime:'9007199254740993'},{method:'future_unknown'},{method:undefined},{formulaType:'future_unknown'},
    {realizedRate:'NaN'},{realizedRate:'1.00001'},{realizedRate:'-1.00001'},{realizedRate:'1e-31'},{fundingRate:'NaN'},
  ])('rejects unknown identity, method, timing or rate %j',patch=>{expect(()=>parseHistory([event(patch)])).toThrow();});
  it.each([
    [[event(),event()]],
    [[event(),event({realizedRate:'0.1'})]],
    [[event(),event({fundingTime:String(now-1000)})]],
  ])('rejects duplicate, conflicting or reversed settlements',events=>{expect(()=>parseHistory(events)).toThrow('invalid-history-order');});
});

describe('OKX D0b context binding and immutable projections',()=>{
  const parsers = [
    {kind:'book',run:(raw:unknown,r:PublicReceipt,s:InstrumentSpec)=>parseOkxBook(raw,'BTC',r,s),raw:()=>wire([book()])},
    {kind:'mark',run:(raw:unknown,r:PublicReceipt,s:InstrumentSpec)=>parseOkxMetrics(raw,'BTC',r,s,'mark'),raw:()=>wire([metric('mark')])},
    {kind:'index',run:(raw:unknown,r:PublicReceipt,s:InstrumentSpec)=>parseOkxMetrics(raw,'BTC',r,s,'index'),raw:()=>wire([metric('index')])},
    {kind:'open-interest',run:(raw:unknown,r:PublicReceipt,s:InstrumentSpec)=>parseOkxMetrics(raw,'BTC',r,s,'open-interest'),raw:()=>wire([metric('open-interest')])},
    {kind:'history',run:(raw:unknown,r:PublicReceipt,s:InstrumentSpec)=>parseOkxHistory(raw,'BTC',r,s),raw:()=>wire([event()])},
  ] as const;
  it.each(parsers)('validates exact receipt, metadata identity and precision for $kind',({kind,run,raw})=>{
    expect(()=>run(raw(),receipt(kind,'ETH'),spec())).toThrow();
    expect(()=>run(raw(),receipt(kind),spec('ETH'))).toThrow();
    expect(()=>run(raw(),{...receipt(kind),url:receipt(kind).url+'&extra=1'},spec())).toThrow();
    expect(()=>run(raw(),receipt(kind),{...spec(),baseQuantityStep:'999'})).toThrow();
    expect(()=>run(raw(),receipt(kind),{...spec(),receipt:{...spec().receipt,requestedAt:now-1200101,receivedAt:now-1200001}})).toThrow();
  });
  it.each(parsers)('rejects API errors before treating $kind response as data',({kind,run})=>{
    for(const envelope of [{code:'50011'},{code:0},{data:null},{data:{}},{data:[null]}])
      expect(()=>run(wire([],envelope),receipt(kind),spec())).toThrow();
  });
  it.each(parsers)('freezes $kind result while leaving caller receipt mutable',({kind,run,raw})=>{
    const incoming=receipt(kind),result=run(raw(),incoming,spec());
    expect(Object.isFrozen(result)).toBe(true);expect(Object.isFrozen(result.receipt)).toBe(true);
    expect(Object.isFrozen(incoming)).toBe(false);incoming.receivedAt+=1;expect(result.receipt.receivedAt).toBe(now+100);
  });
  it.each(['book','mark','index','open-interest'] as const)('rejects empty and multi-row %s envelopes',kind=>{
    const p=parsers.find(value=>value.kind===kind)!;
    for(const raw of [wire([]),wire([book(),book()])])expect(()=>p.run(raw,receipt(kind),spec())).toThrow();
  });
});
