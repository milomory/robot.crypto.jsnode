import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JointObservationClient } from '../src/market-data/joint-client.js';
import { replayJointCapture } from '../src/market-data/joint-replay.js';
import { JOINT_ROUTES, jointUrl, jointResult, normalizeJointRead, type JointCapture, type JointRead } from '../src/market-data/joint-observation.js';
import type { DepthSocket } from '../src/market-data/mexc-depth-source-client.js';
import type { ResearchBase } from '../src/market-data/model.js';
import type { MexcBookCapture } from '../src/market-data/mexc-book-session.js';
const start=1_790_841_600_000;
// All network inputs are synthetic. No private endpoints, credentials or production imports.
class Socket implements DepthSocket {
  constructor(readonly base:ResearchBase,readonly sourceOffset:number){ }
  onopen:DepthSocket['onopen']=null;onmessage:DepthSocket['onmessage']=null;onerror:DepthSocket['onerror']=null;onclose:DepthSocket['onclose']=null;
  close=vi.fn();send=vi.fn((text:string|ArrayBufferLike|Blob|ArrayBufferView)=>{
    if(String(text).includes('sub.depth'))queueMicrotask(()=>{
      this.message({channel:'rs.sub.depth',data:'success',ts:Date.now()});
      this.message({channel:'push.depth',symbol:`${this.base}_USDT`,data:{version:100,cts:Date.now()+this.sourceOffset,bids:[['1000','1','1']],asks:[]},ts:Date.now()});
    });
  });
  message(value:unknown){this.onmessage?.call(this as unknown as WebSocket,{data:JSON.stringify(value)} as MessageEvent);}
}
const encode=(value:unknown)=>new Response(JSON.stringify(value));
function payload(url:string,base:ResearchBase){
  if(url.includes('detail/country'))return {success:true,code:0,data:{symbol:`${base}_USDT`,baseCoin:base,quoteCoin:'USDT',settleCoin:'USDT',futureType:1,type:1,state:0,automaticDelivery:0,apiAllowed:true,preMarket:false,contractSize:'0.001',volUnit:1,minVol:1,priceUnit:1}};
  if(url.includes('/contract/depth/'))return {success:true,code:0,data:{version:100,timestamp:Date.now(),bids:Array.from({length:60},(_,i)=>[String(1000-i),'1','1']),asks:Array.from({length:60},(_,i)=>[String(1001+i),'1','1'])}};
  if(url.includes('exchangeInfo'))return {symbols:[{symbol:`${base}USDT`,baseAsset:base,quoteAsset:'USDT',status:'1',baseAssetPrecision:8,quoteAssetPrecision:2,quotePrecision:2,baseSizePrecision:'0.000001',quoteAmountPrecision:'1',isSpotTradingAllowed:true,tradeSideType:1,orderTypes:['LIMIT','MARKET'],permissions:['SPOT'],filters:[]}]};
  if(url.includes('instType=SWAP'))return {code:'0',data:[{instId:`${base}-USDT-SWAP`,instType:'SWAP',instFamily:`${base}-USDT`,uly:`${base}-USDT`,ctVal:'0.01',ctMult:'1',ctType:'linear',ctValCcy:base,baseCcy:'',quoteCcy:'',settleCcy:'USDT',lotSz:'0.01',minSz:'0.01',tickSz:'1',maxMktSz:'20000',maxLmtSz:'1000000',state:'live',listTime:'1573557408000',expTime:'',groupId:'4',upcChg:[],tradeQuoteCcyList:[],ruleType:'normal'}]};
  if(url.includes('instruments'))return {code:'0',data:[{instType:'SPOT',instId:`${base}-USDT`,baseCcy:base,quoteCcy:'USDT',state:'live',tickSz:'1',lotSz:'0.00000001',minSz:'0.00001',listTime:'1573557408000',expTime:'',contTdSwTime:'',upcChg:[],ruleType:'normal',tradeQuoteCcyList:['USDT']}]};
  if(url.includes('/api/v3/depth'))return {lastUpdateId:123,bids:[['1000','0.1']],asks:[['1001','0.1']]};
  if(url.includes('/market/books'))return {code:'0',data:[{bids:[['1000','1','0','1']],asks:[['1001','1','0','1']],ts:String(Date.now()),seqId:123}]};
  throw new Error('unexpected route');
}
function replay(result:JointCapture){const bytes=Buffer.from(JSON.stringify(result)+'\n');return replayJointCapture(bytes,createHash('sha256').update(bytes).digest('hex'));}
function setup(options:{base?:ResearchBase;intercept?:(url:string,n:number,init:RequestInit)=>Promise<Response>|Response|undefined;clock?:()=>number;sourceOffset?:number}={}){
  const base=options.base??'BTC',sockets:Socket[]=[];let count=0;
  const fetcher=vi.fn(async(input:string|URL|Request,init?:RequestInit)=>{
    const url=String(input),override=options.intercept?.(url,++count,init!);if(override)return await override;
    if(url.includes('/contract/depth/'))setTimeout(()=>{for(let v=101;v<=110;v++)sockets[0].message({channel:'push.depth',symbol:`${base}_USDT`,data:{version:v,cts:Date.now()+(options.sourceOffset??0),bids:[['1000','2','1']],asks:[]},ts:Date.now()});},0);
    return encode(payload(url,base));
  });
  const factory=vi.fn((url:string)=>{expect(url).toBe('wss://contract.mexc.com/edge');const socket=new Socket(base,options.sourceOffset??0);sockets.push(socket);setTimeout(()=>socket.onopen?.call(socket as unknown as WebSocket,new Event('open')),0);return socket;});
  const client=new JointObservationClient(base,{fetch:fetcher as typeof fetch,factory,clock:options.clock});
  const promise=client.capture().then(result=>{expect(replay(result)).toEqual(result);return result;});
  return {client,promise,fetcher,factory,sockets};
}
async function complete(run:ReturnType<typeof setup>){await vi.advanceTimersByTimeAsync(1000);return run.promise;}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(start);});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();});

describe('fixed joint public capture',()=>{
  it.each(['BTC','ETH'] as const)('collects %s using 8 GET and one WS; MEXC Spot remains diagnostic',async base=>{
    const run=setup({base}),result=await complete(run);
    expect(result).toMatchObject({status:'complete',requestCount:8,accountRequests:false,executable:false,netEdgeBps:null});
    expect(result.reads.map(r=>r.route)).toEqual(JOINT_ROUTES);expect(run.factory).toHaveBeenCalledTimes(1);
    expect(result.quality.markets.filter(m=>m.usable)).toHaveLength(3);
    expect(result.quality.pairs.filter(p=>p.usableForComparison)).toHaveLength(4);
    expect(result.quality.markets.find(m=>m.id==='mexc-spot')?.reasons).toContain('book-update-time-unverified');
    expect(run.fetcher).toHaveBeenCalledTimes(8);expect(run.sockets[0].close).toHaveBeenCalledTimes(1);
    for(const [,init] of run.fetcher.mock.calls)expect(Object.keys(init!).sort()).toEqual(['cache','credentials','method','redirect','signal']);
    for(const [,init] of run.fetcher.mock.calls)expect(init).toMatchObject({method:'GET',credentials:'omit',redirect:'error',cache:'no-store'});
    expect(Object.isFrozen(result.quality.pairs)).toBe(true);expect(vi.getTimerCount()).toBe(0);
  });
  it('uses at most one commits GET to bridge the initial snapshot and retains 9 total requests',async()=>{
    let run:ReturnType<typeof setup>;
    run=setup({intercept:(url)=>{
      if(url.includes('/contract/depth/')){
        setTimeout(()=>{for(let version=101;version<=110;version++)run.sockets[0].message({channel:'push.depth',symbol:'BTC_USDT',data:{version,cts:Date.now(),bids:[['1000','2','1']],asks:[]},ts:Date.now()});},0);
        const raw=payload(url,'BTC') as {data:{version:number}};raw.data.version=90;return encode(raw);
      }
      if(url.includes('/depth_commits/'))return encode({success:true,code:0,data:Array.from({length:9},(_,i)=>({version:91+i,bids:[['990','2','1']],asks:[]}))});
      return undefined;
    }});
    const r=await complete(run);expect(r.status).toBe('complete');expect(r.requestCount).toBe(9);
    expect(run.fetcher.mock.calls.filter(([url])=>String(url).includes('/depth_commits/'))).toHaveLength(1);
    expect(r.mexc?.profile).toBe('joint-recovery-v1');
    expect(r.mexc?.events.find(e=>e.kind==='bootstrap')).toHaveProperty('recovery');
    expect(r.quality.pairs.filter(p=>p.usableForComparison)).toHaveLength(4);
  });
  it('single-use and closed runtime options',async()=>{
    const run=setup();await complete(run);await expect(run.client.capture()).rejects.toThrow('public-client-used');
    expect(()=>new JointObservationClient('SOL' as ResearchBase)).toThrow();
    expect(()=>new JointObservationClient('BTC',{endpoint:'https://other'} as never)).toThrow();
    expect(()=>jointUrl('BTC','accounts' as never)).toThrow();
  });
  it.each([1,2,3,4,5,6,7,8])('preserves a bounded partial archive when GET %i is denied',async at=>{
    const run=setup({intercept:(_url,n)=>n===at?new Response('private error must not be saved',{status:403}):undefined});
    const result=await complete(run);expect(result.status).toBe('incomplete');
    expect(result.failure).toBe(at===5||at===6?'joint-mexc-incomplete':'joint-http-access-denied');
    expect(result.requestCount).toBe(at<7?at:8);expect(JSON.stringify(result)).not.toContain('private error');
    if(at<5)expect(run.factory).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
  });
  it.each([418,429,500])('classifies HTTP %i without preserving error text',async status=>{
    const run=setup({intercept:(_url,n)=>n===1?new Response('unknown text',{status}):undefined});
    expect((await complete(run)).failure).toBe(status===500?'joint-http-failed':'joint-http-rate-limited');
  });
  it.each(['50011','50013','50040','429','418'])('classifies API rate code %s',async code=>{
    const run=setup({intercept:(_url,n)=>n===1?encode({code,msg:'sensitive arbitrary text'}):undefined});
    const result=await complete(run);expect(result.failure).toBe('joint-http-rate-limited');expect(JSON.stringify(result)).not.toContain('sensitive');
  });
  it.each(['not json','{"code":"0","data":[]}','{"code":"0","code":"0","data":[]}'])('rejects malformed bodies %s',async raw=>{
    const run=setup({intercept:(_url,n)=>n===1?new Response(raw):undefined});expect((await complete(run)).failure).toBe('joint-schema-rejected');
  });
  it.each(['524289','invalid','-1'])('rejects oversized or invalid content length %s',async length=>{
    const run=setup({intercept:(_url,n)=>n===1?new Response('{}',{headers:{'content-length':length}}):undefined});
    expect((await complete(run)).failure).toBe('joint-response-too-large');
  });
  it('rejects streamed overflow and cancels the reader',async()=>{
    const cancel=vi.fn();const run=setup({intercept:(_url,n)=>n===1?new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(524289));},cancel})):undefined});
    expect((await complete(run)).failure).toBe('joint-response-too-large');expect(cancel).toHaveBeenCalled();
  });
  it('times out even when fetch ignores abort; late HTTP completion cannot mutate the report',async()=>{
    let finish!:(r:Response)=>void;const run=setup({intercept:(_url,n)=>n===1?new Promise(resolve=>{finish=resolve;}):undefined});
    await vi.advanceTimersByTimeAsync(5000);const result=await run.promise,copy=JSON.stringify(result);
    expect(result.failure).toBe('joint-http-timeout');finish(encode(payload(jointUrl('BTC',JOINT_ROUTES[0]),'BTC')));await vi.advanceTimersByTimeAsync(0);
    expect(JSON.stringify(result)).toBe(copy);expect(run.fetcher).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
  });
  it('aborts an in-flight peer after final-batch failure without leaving unresolved work',async()=>{
    let peer:AbortSignal|undefined;
    const run=setup({intercept:(url,_n,init)=>url===jointUrl('BTC','okx-perpetual-book')?new Response('denied',{status:403}):url===jointUrl('BTC','okx-spot-book')?(peer=init.signal as AbortSignal,new Promise(()=>{})):undefined});
    const result=await complete(run);expect(result.failure).toBe('joint-http-access-denied');expect(result.reads[5].failure).toBe('joint-peer-failed');expect(peer?.aborted).toBe(true);expect(vi.getTimerCount()).toBe(0);
  });
  it('final OKX batch has two concurrent GETs, while MEXC has already closed',async()=>{
    let arrived=0;const pending:(()=>void)[]=[];
    const run=setup({intercept:(url)=>url.includes('okx.com/api/v5/market/books')?new Promise(resolve=>{
      expect(run.sockets[0].close).toHaveBeenCalledTimes(1);arrived++;pending.push(()=>resolve(encode(payload(url,'BTC'))));if(arrived===2)pending.forEach(f=>f());
    }):undefined});
    expect((await complete(run)).status).toBe('complete');expect(arrived).toBe(2);
  });
  it('complete acquisition can be temporally unusable; stale/skew is not silently repaired',async()=>{
    const run=setup({sourceOffset:-2000});const result=await complete(run);
    expect(result.status).toBe('complete');expect(result.quality.pairs.filter(p=>p.usableForComparison)).toHaveLength(1);
    expect(result.quality.pairs.find(p=>p.longMarket==='mexc-perpetual')?.reasons).toContain('book-source-skew');
  });
  it('stops nested metadata on a forward clock jump beyond the outer deadline before opening WS',async()=>{
    const run=setup({intercept:(url)=>{if(url.includes('/detail/country'))vi.setSystemTime(start+50_000);return undefined;}});
    const result=await complete(run);expect(result).toMatchObject({status:'incomplete',failure:'joint-capture-deadline',requestCount:5});
    expect(run.factory).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
  });
  it('does not dispatch the second final GET after a clock jump to the outer deadline',async()=>{
    const run=setup({intercept:(_url,n)=>{if(n===7)vi.setSystemTime(start+50_000);return undefined;}});
    const result=await complete(run);expect(result.failure).toBe('joint-capture-deadline');
    expect(run.fetcher).toHaveBeenCalledTimes(7);expect(result.requestCount).toBe(7);
    expect(result.reads[5]).toMatchObject({notDispatched:true,observation:null,failure:'joint-capture-deadline'});
    expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects a clock reversal before any request without inventing a request',async()=>{
    let calls=0;const run=setup({clock:()=>++calls===1?start:start-1});const result=await run.promise;
    expect(result).toMatchObject({status:'incomplete',failure:'invalid-public-clock',requestCount:0});expect(run.fetcher).not.toHaveBeenCalled();
  });
});

describe('joint replay does not trust derived values or arbitrary acquisition claims',()=>{
  it.each([
    (r:JointCapture)=>{r.executable=true as false;},
    (r:JointCapture)=>{r.netEdgeBps='5' as never;},
    (r:JointCapture)=>{r.requestCount++;},
    (r:JointCapture)=>{r.reads[0].notDispatched=true;},
    (r:JointCapture)=>{r.reads[0].notDispatched=false as never;},
    (r:JointCapture)=>{r.quality.pairs[0].usableForComparison=false;},
    (r:JointCapture)=>{r.mexc!.book!.bids[0].quantityBase='20';},
    (r:JointCapture)=>{r.reads[4].observation!.receipt.url='https://www.okx.com/api/v5/account/balance';},
    (r:JointCapture)=>{r.reads[4].requestedAt=r.mexc!.startedAt-1;},
    (r:JointCapture)=>{r.reads[5].requestedAt++;},
    (r:JointCapture)=>{r.reads[0].observation!.parsed.market.base='ETH';},
    (r:JointCapture)=>{r.endedAt=r.startedAt-1;},
    (r:JointCapture)=>{(r as unknown as Record<string,unknown>).extra='unexpected';},
    (r:JointCapture)=>{r.reads=(r.reads as Array<unknown>).slice(0,5) as never;},
    (r:JointCapture)=>{r.mexc=null;},
  ])('rejects archive tampering %# even with a recomputed hash',async mutate=>{
    const result=JSON.parse(JSON.stringify(await complete(setup()))) as JointCapture;mutate(result);expect(()=>replay(result)).toThrow();
  });
  it('rejects a successful peer after the first failure even after raw/quality recomputation',async()=>{
    const r=JSON.parse(JSON.stringify(await complete(setup()))) as JointCapture;
    const first=r.reads[4],peer=r.reads[5];first.observation=null;first.failure='joint-http-access-denied';first.endedAt=first.requestedAt+100;
    peer.endedAt=peer.requestedAt+200;peer.observation!.receipt.receivedAt=peer.endedAt;
    peer.observation!.parsed=normalizeJointRead(r.base,peer.route,peer.observation!.raw,peer.observation!.receipt,r.reads);
    const changed=jointResult(r.base,r.startedAt,peer.endedAt,r.reads,r.mexc,first.failure);expect(()=>replay(changed)).toThrow();
  });
  it('rejects a peer cancellation preceding the causal failure',async()=>{
    const r=JSON.parse(JSON.stringify(await complete(setup()))) as JointCapture;
    const first=r.reads[4],peer=r.reads[5];first.observation=null;first.failure='joint-http-access-denied';first.endedAt=first.requestedAt+200;
    peer.observation=null;peer.failure='joint-peer-failed';peer.endedAt=peer.requestedAt+100;
    expect(()=>replay(jointResult(r.base,r.startedAt,first.endedAt,r.reads,r.mexc,first.failure))).toThrow();
  });
  function nestedDeadlineArchive(nested:MexcBookCapture,deadline:number):JointCapture {
    const startedAt=deadline-50_000,reads:JointRead[]=[];
    for(let i=0;i<4;i++) {
      const route=JOINT_ROUTES[i],url=jointUrl('BTC',route),requestedAt=startedAt+i*100,endedAt=requestedAt+10;
      const raw=JSON.stringify(payload(url,'BTC')),receipt={url,requestedAt,receivedAt:endedAt};
      reads.push({route,requestedAt,endedAt,observation:{raw,receipt,parsed:normalizeJointRead('BTC',route,raw,receipt,reads)},failure:null});
    }
    return jointResult('BTC',startedAt,Math.max(nested.endedAt,deadline),reads,nested,'joint-capture-deadline');
  }
  const pinnedNested=():MexcBookCapture=>JSON.parse(readFileSync(new URL('../fixtures/market-data/mexc-book-btc-public-20261001.json',import.meta.url),'utf8'));
  it.each(['metadata','socket-start','socket-open','frame','bootstrap','complete-finish'] as const)(
    'rejects nested %s accepted at the outer deadline even with recomputed normalization and SHA',stage=>{
      const nested=pinnedNested();
      const frame=nested.events.find(e=>e.kind==='frame')!,bootstrap=nested.events.find(e=>e.kind==='bootstrap')!;
      const deadline=stage==='metadata'?nested.metadata!.receipt.receivedAt:stage==='socket-start'?nested.socketStartedAt!:
        stage==='socket-open'?nested.socketOpenedAt!:stage==='frame'?frame.receivedAt:stage==='bootstrap'?bootstrap.receipt.receivedAt:nested.endedAt;
      // Nested evidence remains internally valid; only the recomputed outer schedule is impossible.
      expect(()=>replay(nestedDeadlineArchive(nested,deadline))).toThrow('invalid-joint-archive');
    });
  it('rejects post-deadline accepted frames in an otherwise valid incomplete nested prefix',()=>{
    const nested=pinnedNested(),firstFrame=nested.events.find(e=>e.kind==='frame')!;
    nested.status='incomplete';nested.failure='invalid-public-clock';nested.book=null;
    expect(()=>replay(nestedDeadlineArchive(nested,firstFrame.receivedAt))).toThrow('invalid-joint-archive');
  });
  it('preserves an incomplete nested finish at the deadline when every accepted event preceded it',()=>{
    const nested=pinnedNested();nested.status='incomplete';nested.failure='invalid-public-clock';nested.book=null;
    const report=nestedDeadlineArchive(nested,nested.endedAt);
    expect(replay(report)).toEqual(report);
  });
  it('rejects bad hashes and noncanonical or invalid UTF8 archives',async()=>{
    const result=await complete(setup()),bytes=Buffer.from(JSON.stringify(result)+'\n');
    expect(()=>replayJointCapture(bytes,'0'.repeat(64))).toThrow();
    const padded=Buffer.from(' '+bytes.toString());expect(()=>replayJointCapture(padded,createHash('sha256').update(padded).digest('hex'))).toThrow();
    const invalid=Buffer.from([255]);expect(()=>replayJointCapture(invalid,createHash('sha256').update(invalid).digest('hex'))).toThrow();
  });
});
