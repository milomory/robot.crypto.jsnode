import { createHash } from 'node:crypto';
import { replayMexcBook } from '../src/market-data/mexc-book-replay.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MexcBookClient, BOOK_CAPTURE_LIMITS, BOOK_CLIENT_FAILURES } from '../src/market-data/mexc-book-client.js';
import type { DepthSocket } from '../src/market-data/mexc-depth-source-client.js';
import type { ResearchBase } from '../src/market-data/model.js';
// All HTTP and WebSocket inputs here are synthetic; these tests open no network connections.
const start=1_790_841_600_000;
class Socket implements DepthSocket {
  onopen:DepthSocket['onopen']=null;onmessage:DepthSocket['onmessage']=null;onerror:DepthSocket['onerror']=null;onclose:DepthSocket['onclose']=null;
  send=vi.fn<(data:string|ArrayBufferLike|Blob|ArrayBufferView)=>void>();close=vi.fn();
  open(){this.onopen?.call(this as unknown as WebSocket,new Event('open'));}
  message(data:unknown){this.onmessage?.call(this as unknown as WebSocket,{data} as MessageEvent);}
  error(){this.onerror?.call(this as unknown as WebSocket,new Event('error'));}
  closed(){this.onclose?.call(this as unknown as WebSocket,new Event('close') as CloseEvent);}
}
function metadata(base:ResearchBase='BTC'){
  return JSON.stringify({success:true,code:0,data:{symbol:`${base}_USDT`,baseCoin:base,quoteCoin:'USDT',settleCoin:'USDT',
    futureType:1,type:1,state:0,automaticDelivery:0,apiAllowed:true,preMarket:false,contractSize:'0.001',volUnit:1,minVol:1,priceUnit:1}});
}
function snapshot(version=100){return JSON.stringify({success:true,code:0,data:{version,timestamp:Date.now(),
  bids:Array.from({length:60},(_,i)=>[String(1000-i),'1','1']),asks:Array.from({length:60},(_,i)=>[String(1001+i),'1','1'])}});}
const ack=()=>JSON.stringify({channel:'rs.sub.depth',data:'success',ts:Date.now()});
const pong=(padding='')=>JSON.stringify({channel:'pong',data:Date.now(),padding});
function delta(version:number,base:ResearchBase='BTC',cts:unknown=Date.now()){
  return JSON.stringify({channel:'push.depth',symbol:`${base}_USDT`,data:{version,cts,bids:[['1000','2','1']],asks:[]},ts:Date.now()});
}
const flush=()=>vi.advanceTimersByTimeAsync(0);
function deferred<T>(){let resolve!:(value:T)=>void;let reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
async function setup(options:{base?:ResearchBase;fetch?:typeof fetch;clock?:()=>number;factory?:(url:string)=>DepthSocket}={}){
  const base=options.base??'BTC',socket=new Socket(),factory=vi.fn(options.factory??(()=>socket));
  const fetcher=vi.fn(options.fetch??(async(url:string|URL|Request)=>new Response(String(url).includes('/detail/')?metadata(base):snapshot())));
  const client=new MexcBookClient(base,{fetch:fetcher as typeof fetch,factory,clock:options.clock});const promise=client.capture().then(result=>{
    const bytes=Buffer.from(JSON.stringify(result)+'\n'),digest=createHash('sha256').update(bytes).digest('hex');
    expect(replayMexcBook(bytes,digest)).toEqual(result);return result;
  });await flush();
  return{base,socket,factory,fetcher,client,promise};
}
async function boot(run:Awaited<ReturnType<typeof setup>>){run.socket.open();run.socket.message(ack());await flush();}
function ten(run:Awaited<ReturnType<typeof setup>>,first=101){for(let i=first;i<first+10;i++)run.socket.message(delta(i,run.base));}
function closed(run:Awaited<ReturnType<typeof setup>>){expect(run.socket.close).toHaveBeenCalledTimes(1);expect(run.socket.onopen).toBeNull();expect(run.socket.onmessage).toBeNull();expect(run.socket.onerror).toBeNull();expect(run.socket.onclose).toBeNull();expect(vi.getTimerCount()).toBe(0);}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(start);});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();});

describe('MEXC book fixed public capture',()=>{
  it.each(['BTC','ETH'] as const)('completes %s with two public requests, one socket and ten applied deltas',async base=>{
    const run=await setup({base});expect(run.factory.mock.calls).toEqual([['wss://contract.mexc.com/edge']]);
    expect(run.fetcher).toHaveBeenCalledTimes(1);await boot(run);ten(run);const result=await run.promise;
    expect(run.fetcher.mock.calls.map(row=>String(row[0]))).toEqual([
      `https://api.mexc.com/api/v1/contract/detail/country?symbol=${base}_USDT`,
      `https://api.mexc.com/api/v1/contract/depth/${base}_USDT?limit=1000`]);
    for(const row of run.fetcher.mock.calls){const config=row[1] as RequestInit;expect(config).toMatchObject({method:'GET',credentials:'omit',redirect:'error',cache:'no-store'});expect(Object.keys(config).sort()).toEqual(['cache','credentials','method','redirect','signal']);expect(config.signal?.aborted).toBe(true);}
    expect(run.socket.send.mock.calls).toEqual([[JSON.stringify({method:'sub.depth',param:{symbol:`${base}_USDT`,compress:false},gzip:false})]]);
    expect(result).toMatchObject({schema:1,kind:'mexc-public-depth-book',base,status:'complete',failure:null,requestCount:2,connections:1,subscriptions:1,pings:0,appliedDeltas:10,accountRequests:false,executable:false});
    expect(result.book).toMatchObject({version:'110',verifiedDepth:50,entireBookKnown:false,bookFreshnessVerified:true,evaluatedAt:result.endedAt,executable:false});
    expect(result.book?.bids).toHaveLength(50);expect(result.book?.asks).toHaveLength(50);
    expect(result.events.map(x=>x.kind)).toEqual(['frame','bootstrap',...Array(10).fill('frame')]);
    expect(Object.isFrozen(result)).toBe(true);expect(Object.isFrozen(result.events)).toBe(true);closed(run);
  });
  it('does not request bootstrap before acknowledgement even if deltas arrive',async()=>{
    const run=await setup();run.socket.open();run.socket.message(delta(99));expect(run.fetcher).toHaveBeenCalledTimes(1);
    run.socket.message(ack());await flush();for(let v=100;v<=110;v++)run.socket.message(delta(v));
    const result=await run.promise;expect(result.status).toBe('complete');expect(result.appliedDeltas).toBe(10);closed(run);
  });
  it('buffers frames during the HTTP snapshot and applies its V+1 bridge atomically',async()=>{
    const pending=deferred<Response>();const run=await setup({fetch:vi.fn().mockResolvedValueOnce(new Response(metadata())).mockImplementationOnce(()=>pending.promise)});
    run.socket.open();run.socket.message(ack());for(let v=99;v<=111;v++)run.socket.message(delta(v));
    expect(run.socket.close).not.toHaveBeenCalled();pending.resolve(new Response(snapshot(100)));await flush();
    const result=await run.promise;expect(result).toMatchObject({status:'complete',appliedDeltas:11});expect(result.events.at(-1)?.kind).toBe('bootstrap');expect(result.book?.version).toBe('111');closed(run);
  });
  it('snapshot ahead of buffered frames waits without skipping a required new version',async()=>{
    const pending=deferred<Response>();const run=await setup({fetch:vi.fn().mockResolvedValueOnce(new Response(metadata())).mockImplementationOnce(()=>pending.promise)});
    run.socket.open();run.socket.message(ack());run.socket.message(delta(98));run.socket.message(delta(99));pending.resolve(new Response(snapshot(102)));await flush();
    for(let v=100;v<=112;v++)run.socket.message(delta(v));const result=await run.promise;
    expect(result).toMatchObject({status:'complete',appliedDeltas:10});expect(result.book?.version).toBe('112');closed(run);
  });
  it('rejects bootstrap that is behind the first buffered update without its V+1 bridge',async()=>{
    const pending=deferred<Response>();const run=await setup({fetch:vi.fn().mockResolvedValueOnce(new Response(metadata())).mockImplementationOnce(()=>pending.promise)});
    run.socket.open();run.socket.message(ack());run.socket.message(delta(102));pending.resolve(new Response(snapshot(100)));await flush();
    const result=await run.promise;expect(result).toMatchObject({status:'incomplete',failure:'depth-book-version-discontinuity',appliedDeltas:0,book:null});expect(result.events).toHaveLength(2);closed(run);
  });
  it('preserves accepted prefix if a later buffered delta fails tick validation during bootstrap',async()=>{
    const pending=deferred<Response>();const run=await setup({fetch:vi.fn().mockResolvedValueOnce(new Response(metadata())).mockImplementationOnce(()=>pending.promise)});
    run.socket.open();run.socket.message(ack());run.socket.message(delta(101));const bad=JSON.parse(delta(102));bad.data.bids=[['1000.5','2','1']];run.socket.message(JSON.stringify(bad));
    pending.resolve(new Response(snapshot(100)));await flush();const result=await run.promise;
    expect(result).toMatchObject({failure:'depth-book-invalid-delta',appliedDeltas:0,book:null});expect(result.events.every(x=>x.kind==='frame')).toBe(true);closed(run);
  });
  it('is single-use before and after completion',async()=>{
    const run=await setup();await expect(run.client.capture()).rejects.toThrow('public-client-used');await boot(run);ten(run);await run.promise;
    await expect(run.client.capture()).rejects.toThrow('public-client-used');expect(run.factory).toHaveBeenCalledTimes(1);closed(run);
  });
  it.each(['SOL','btc','',null])('rejects unsupported base %s without network',base=>{const fetcher=vi.fn(),factory=vi.fn();expect(()=>new MexcBookClient(base as never,{fetch:fetcher,factory})).toThrow('unsupported-market');expect(fetcher).not.toHaveBeenCalled();expect(factory).not.toHaveBeenCalled();});
  it.each(['url','headers','token','maxFrames','reconnect'])('rejects unknown option %s',key=>{expect(()=>new MexcBookClient('BTC',{[key]:'x'} as never)).toThrow('invalid-public-options');});
  it('uses native socket factory only with the approved public URL',async()=>{
    const socket=new Socket(),factory=vi.fn(function(_url:string){return socket;});vi.stubGlobal('WebSocket',factory);
    const fetcher=vi.fn(async(url:string|URL|Request)=>new Response(String(url).includes('/detail/')?metadata():snapshot()));
    const promise=new MexcBookClient('BTC',{fetch:fetcher as typeof fetch}).capture();await flush();socket.open();socket.message(ack());await flush();
    for(let v=101;v<=110;v++)socket.message(delta(v));expect((await promise).status).toBe('complete');expect(factory.mock.calls).toEqual([['wss://contract.mexc.com/edge']]);expect(vi.getTimerCount()).toBe(0);
  });
});

describe('MEXC book HTTP stop and cancellation',()=>{
  it.each([[403,'book-http-access-denied'],[429,'book-http-rate-limited'],[418,'book-http-rate-limited'],[500,'book-http-failed']] as const)('stops after metadata HTTP %s',async(status,failure)=>{
    const run=await setup({fetch:vi.fn().mockResolvedValue(new Response('hidden server body',{status}))});const result=await run.promise;
    expect(result).toMatchObject({status:'incomplete',failure,requestCount:1,connections:0,metadata:null,events:[]});expect(run.factory).not.toHaveBeenCalled();expect(run.fetcher).toHaveBeenCalledTimes(1);expect(JSON.stringify(result)).not.toContain('hidden');expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['429','418','50011','50013','50040'])('stops on public API rate limit code %s',async code=>{
    const run=await setup({fetch:vi.fn().mockResolvedValue(new Response(JSON.stringify({code,msg:'hidden'})))});expect(await run.promise).toMatchObject({failure:'book-http-rate-limited',requestCount:1,connections:0});expect(vi.getTimerCount()).toBe(0);
  });
  it('stops snapshot HTTP failure without retry or fallback',async()=>{
    const run=await setup({fetch:vi.fn().mockResolvedValueOnce(new Response(metadata())).mockResolvedValueOnce(new Response('hidden',{status:403}))});await boot(run);
    expect(await run.promise).toMatchObject({failure:'book-http-access-denied',requestCount:2,connections:1,book:null});await vi.advanceTimersByTimeAsync(60_000);expect(run.fetcher).toHaveBeenCalledTimes(2);closed(run);
  });
  it('cancels the pending bootstrap and its timer when the socket closes',async()=>{
    const pending=deferred<Response>();const run=await setup({fetch:vi.fn().mockResolvedValueOnce(new Response(metadata())).mockImplementationOnce(()=>pending.promise)});
    run.socket.open();run.socket.message(ack());run.socket.closed();const result=await run.promise;await flush();
    expect(result).toMatchObject({failure:'book-stream-closed',requestCount:2,events:[{kind:'frame'}],book:null});closed(run);
    pending.resolve(new Response(snapshot()));await flush();expect(result.events).toHaveLength(1);expect(result.book).toBeNull();closed(run);
  });
  it('times out metadata after five seconds, aborts and never starts a socket',async()=>{
    const pending=deferred<Response>();const run=await setup({fetch:vi.fn(()=>pending.promise)});await vi.advanceTimersByTimeAsync(5000);
    expect(await run.promise).toMatchObject({failure:'book-http-timeout',requestCount:1,connections:0,metadata:null});expect((run.fetcher.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);expect(vi.getTimerCount()).toBe(0);
    pending.resolve(new Response(metadata()));await flush();expect(run.factory).not.toHaveBeenCalled();
  });
  it('times out the snapshot after three seconds with preserved frames',async()=>{
    const run=await setup({fetch:vi.fn().mockResolvedValueOnce(new Response(metadata())).mockImplementationOnce(()=>new Promise(()=>{}))});run.socket.open();run.socket.message(ack());run.socket.message(delta(101));
    await vi.advanceTimersByTimeAsync(3000);expect(await run.promise).toMatchObject({failure:'book-http-timeout',requestCount:2,appliedDeltas:0});closed(run);
  });
  it('includes body reading in HTTP timeout and cancels a stalled body',async()=>{
    const cancel=vi.fn();const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode('{'));},cancel});
    const run=await setup({fetch:vi.fn().mockResolvedValue(new Response(body))});await vi.advanceTimersByTimeAsync(5000);
    expect(await run.promise).toMatchObject({failure:'book-http-timeout',connections:0});expect(cancel).toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['-1','abc','524289'])('rejects malformed/excess content-length %s before parsing',async length=>{
    const run=await setup({fetch:vi.fn().mockResolvedValue(new Response(metadata(),{headers:{'content-length':length}}))});expect(await run.promise).toMatchObject({failure:'book-response-too-large',connections:0});expect(vi.getTimerCount()).toBe(0);
  });
  it('enforces streamed response byte size when no content-length is declared',async()=>{
    const run=await setup({fetch:vi.fn().mockResolvedValue(new Response('x'.repeat(524289)))});expect(await run.promise).toMatchObject({failure:'book-response-too-large',connections:0});expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['{','{"success":true,"code":0,"data":{},"data":{}}'])('rejects malformed/ambiguous metadata JSON',async raw=>{
    const run=await setup({fetch:vi.fn().mockResolvedValue(new Response(raw))});expect((await run.promise).status).toBe('incomplete');expect(run.factory).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
  });
  it('redacts an arbitrary fetch exception and error code',async()=>{
    const run=await setup({fetch:vi.fn().mockRejectedValue(new Error('secret private transport message'))});const result=await run.promise;
    expect(result.failure).toBe('book-http-unavailable');expect(JSON.stringify(result)).not.toContain('secret');expect(vi.getTimerCount()).toBe(0);
  });
});

describe('MEXC book WS lifecycle and freshness budgets',()=>{
  it('stops at the socket deadline including connection time',async()=>{
    const run=await setup();await vi.advanceTimersByTimeAsync(15_000);run.socket.open();await vi.advanceTimersByTimeAsync(5000);
    expect(await run.promise).toMatchObject({failure:'book-stream-timeout',subscriptions:1,pings:0,requestCount:1});closed(run);
  });
  it('sends at most one heartbeat, no acknowledgement means no bootstrap',async()=>{
    const run=await setup();run.socket.open();await vi.advanceTimersByTimeAsync(10_000);expect(run.socket.send.mock.calls[1]).toEqual([JSON.stringify({method:'ping'})]);
    await vi.advanceTimersByTimeAsync(10_000);expect(await run.promise).toMatchObject({failure:'book-stream-timeout',pings:1,requestCount:1});closed(run);
  });
  it.each(['error','closed'] as const)('stops on WS %s and ignores late callback',async method=>{
    const run=await setup();await boot(run);run.socket.message(delta(101));const late=run.socket.onmessage;run.socket[method]();const result=await run.promise;
    late?.call(run.socket as unknown as WebSocket,{data:delta(102)} as MessageEvent);expect(result.appliedDeltas).toBe(1);expect(result.book).toBeNull();closed(run);
  });
  it('rejects second socket open without sending second subscription',async()=>{const run=await setup();run.socket.open();run.socket.open();expect(await run.promise).toMatchObject({failure:'book-stream-unexpected-open',subscriptions:1});closed(run);});
  it('rejects message before open',async()=>{const run=await setup();run.socket.message(ack());expect(await run.promise).toMatchObject({failure:'book-stream-before-open',requestCount:1,subscriptions:0});closed(run);});
  it.each([new Uint8Array([1]),new Blob(['x']),null,42])('rejects non-text frame %j',async data=>{const run=await setup();run.socket.open();run.socket.message(data);expect(await run.promise).toMatchObject({failure:'book-stream-binary-message',events:[]});closed(run);});
  it.each([103,101,100])('rejects sequence gap, duplicate or regression to %s',async version=>{const run=await setup();await boot(run);run.socket.message(delta(101));run.socket.message(delta(version));expect(await run.promise).toMatchObject({failure:'stream-version-discontinuity',appliedDeltas:1,book:null});closed(run);});
  it.each([null,start-5001,start+5001])('rejects unverified source time %s',async cts=>{const run=await setup();await boot(run);run.socket.message(delta(101,'BTC',cts));expect(await run.promise).toMatchObject({failure:'book-session-source-unverified',appliedDeltas:0,book:null});closed(run);});
  it('rechecks source freshness at final evaluation instead of frame receipt only',async()=>{
    let clock=start,expireAfterReceipt=false;const run=await setup({clock:()=>{const value=clock;if(expireAfterReceipt){clock=start+5001;expireAfterReceipt=false;}return value;}});
    await boot(run);for(let v=101;v<110;v++)run.socket.message(delta(v));
    // The last frame is received while fresh, then evaluation occurs after a process stall.
    expireAfterReceipt=true;run.socket.message(delta(110));const result=await run.promise;
    expect(result).toMatchObject({status:'incomplete',failure:'depth-book-source-time-unverified',appliedDeltas:10,book:null});closed(run);
  });
  it('stops before a 257th WS frame even without any bootstrap',async()=>{
    const run=await setup();run.socket.open();for(let i=0;i<256;i++)run.socket.message(pong());run.socket.message(pong());
    const result=await run.promise;expect(result.failure).toBe('book-stream-frame-budget');expect(result.events).toHaveLength(256);closed(run);
  });
  it('enforces the total raw budget including metadata and all accepted frames',async()=>{
    const run=await setup();run.socket.open();const skeleton=pong(),raw=pong('x'.repeat(524288-Buffer.byteLength(skeleton)));
    expect(Buffer.byteLength(raw)).toBe(524288);for(let i=0;i<8;i++)run.socket.message(raw);const result=await run.promise;
    expect(result.failure).toBe('book-raw-budget');expect(result.events).toHaveLength(7);closed(run);
  });
  it.each(['x'.repeat(524289),'я'.repeat(262145)])('rejects an oversized UTF-8 frame',async raw=>{const run=await setup();run.socket.open();run.socket.message(raw);expect(await run.promise).toMatchObject({failure:'book-stream-frame-budget',events:[]});closed(run);});
  it.each([NaN,Infinity,0,-1,1.5,8_640_000_000_000_001])('rejects invalid initial clock %s before all transport',async value=>{
    const fetcher=vi.fn(),factory=vi.fn();await expect(new MexcBookClient('BTC',{fetch:fetcher,factory,clock:()=>value}).capture()).rejects.toThrow('invalid-public-clock');expect(fetcher).not.toHaveBeenCalled();expect(factory).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
  });
  it('preserves clock regression failure without leaking a malformed end time',async()=>{
    let clock=start;const run=await setup({clock:()=>clock});clock=start-1;run.socket.open();expect(await run.promise).toMatchObject({failure:'invalid-public-clock',endedAt:start,subscriptions:0});closed(run);
  });
  it('enforces elapsed time even if timeout callbacks have not executed',async()=>{const run=await setup();run.socket.open();vi.setSystemTime(start+25_000);run.socket.message(ack());expect(await run.promise).toMatchObject({failure:'book-capture-deadline',requestCount:1});closed(run);});
  it('hides socket constructor, send and close exception text',async()=>{
    const factory=vi.fn(()=>{throw new Error('hidden socket secret');});const run=await setup({factory});const result=await run.promise;expect(result.failure).toBe('book-stream-unavailable');expect(JSON.stringify(result)).not.toContain('hidden');expect(vi.getTimerCount()).toBe(0);
  });
  it('exports immutable fixed limits and closed failure codes',()=>{expect(Object.isFrozen(BOOK_CAPTURE_LIMITS)).toBe(true);expect(Object.isFrozen(BOOK_CLIENT_FAILURES)).toBe(true);expect(BOOK_CAPTURE_LIMITS.maximumRequests).toBe(2);expect(new Set(BOOK_CLIENT_FAILURES).size).toBe(BOOK_CLIENT_FAILURES.length);});
});
