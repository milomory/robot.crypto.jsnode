/** One-use, public-only BTC/ETH bootstrap. No retry, recovery, account access or execution. */
import { numberText, parsePublicJson, record } from './exact-json.js';
import { DEPTH_BOOK_FAILURES, mexcDepthBootstrapUrl } from './mexc-depth-book.js';
import { MEXC_DEPTH_STREAM_URL } from './mexc-depth-stream.js';
import { type DepthSocket } from './mexc-depth-source-client.js';
import { BOOK_SESSION_FAILURES, MexcBookSession, type MexcBookCapture, type MexcBookEvent } from './mexc-book-session.js';
import { freeze, MarketDataError, market, publicUrl, reject, type PublicReceipt, type ResearchBase } from './model.js';
export const BOOK_CAPTURE_LIMITS = Object.freeze({ maximumRequests:2, maximumConnections:1,
  metadataTimeoutMs:5000, bootstrapTimeoutMs:3000, socketTimeoutMs:20_000, captureTimeoutMs:25_000,
  maximumFrames:256, maximumRawBytes:4*1024*1024, maximumResponseBytes:512*1024,
  maximumPings:1, targetAppliedDeltas:10 });
export const BOOK_CLIENT_FAILURES:readonly string[]=Object.freeze([...new Set([
  ...DEPTH_BOOK_FAILURES,...BOOK_SESSION_FAILURES,'invalid-public-clock','invalid-public-contract',
  'book-capture-deadline','book-stream-timeout','book-http-timeout','book-http-unavailable',
  'book-http-access-denied','book-http-rate-limited','book-http-failed','book-response-too-large',
  'book-raw-budget','book-stream-unavailable','book-stream-closed','book-stream-unexpected-open',
  'book-stream-before-open','book-stream-binary-message','book-stream-frame-budget',
  'book-stream-ping-budget','book-schema-rejected',
])]);
const safeFailure=(error:unknown,fallback='book-schema-rejected'):string=>error instanceof MarketDataError&&BOOK_CLIENT_FAILURES.includes(error.code)?error.code:fallback;
export class MexcBookClient {
  #used=false;
  readonly #base:ResearchBase;
  readonly #request:typeof fetch;
  readonly #factory:(url:string)=>DepthSocket;
  readonly #clock:()=>number;
  constructor(base:ResearchBase,options:{fetch?:typeof fetch;factory?:(url:string)=>DepthSocket;clock?:()=>number}={}){
    market('mexc',base);if(Object.keys(options).some(k=>!['fetch','factory','clock'].includes(k)))reject('invalid-public-options');
    this.#base=base;this.#request=options.fetch??globalThis.fetch;
    this.#factory=options.factory??(url=>new WebSocket(url));this.#clock=options.clock??Date.now;
  }
  async capture():Promise<MexcBookCapture>{
    if(this.#used)return reject('public-client-used');this.#used=true;
    let last=0;
    const now=()=>{const value=this.#clock();if(!Number.isSafeInteger(value)||value<=0||value<last||value>8_640_000_000_000_000)return reject('invalid-public-clock');last=value;return value;};
    const startedAt=now();let done=false,requestCount=0,connections=0,subscriptions=0,pings=0,rawBytes=0,frameCount=0,acceptedAppliedDeltas=0;
    let socketStartedAt:number|null=null,socketOpenedAt:number|null=null;
    let socket:DepthSocket|undefined,session:MexcBookSession|undefined,bootstrapStarted=false;
    const events:MexcBookEvent[]=[],cancellations=new Set<()=>void>();
    let captureTimer:ReturnType<typeof setTimeout>|undefined,socketTimer:ReturnType<typeof setTimeout>|undefined,heartbeat:ReturnType<typeof setInterval>|undefined;
    return await new Promise<MexcBookCapture>(resolve=>{
      const finish=(initialFailure:string|null)=>{
        if(done)return;done=true;let failure=initialFailure,endedAt=last;
        try{endedAt=now();}catch{failure??='invalid-public-clock';}
        if(endedAt-startedAt>=BOOK_CAPTURE_LIMITS.captureTimeoutMs)failure??='book-capture-deadline';
        if(socketStartedAt!==null&&endedAt-socketStartedAt>=BOOK_CAPTURE_LIMITS.socketTimeoutMs)failure??='book-stream-timeout';
        let book:MexcBookCapture['book']=null;
        if(failure===null){try{book=session!.snapshot(endedAt);}catch(error){failure=safeFailure(error);}}
        if(captureTimer)clearTimeout(captureTimer);if(socketTimer)clearTimeout(socketTimer);if(heartbeat)clearInterval(heartbeat);
        for(const cancel of cancellations)cancel();cancellations.clear();
        if(socket){socket.onopen=null;socket.onmessage=null;socket.onerror=null;socket.onclose=null;try{socket.close();}catch{}}
        resolve(freeze({schema:1,kind:'mexc-public-depth-book',base:this.#base,startedAt,endedAt,requestCount,connections,subscriptions,pings,
          status:failure===null?'complete':'incomplete',failure,metadata:session?.metadata??null,socketStartedAt,socketOpenedAt,events,
          appliedDeltas:acceptedAppliedDeltas,book,accountRequests:false,executable:false}));
      };
      const checkTime=(at:number)=>{
        if(at-startedAt>=BOOK_CAPTURE_LIMITS.captureTimeoutMs)return reject('book-capture-deadline');
        if(socketStartedAt!==null&&at-socketStartedAt>=BOOK_CAPTURE_LIMITS.socketTimeoutMs)return reject('book-stream-timeout');
      };
      const addBytes=(size:number)=>{if(rawBytes+size>BOOK_CAPTURE_LIMITS.maximumRawBytes)return reject('book-raw-budget');rawBytes+=size;};
      const get=async(url:string,timeout:number):Promise<{raw:string;receipt:PublicReceipt}>=>{
        const requestedAt=now();checkTime(requestedAt);
        if(requestCount>=BOOK_CAPTURE_LIMITS.maximumRequests)return reject('book-schema-rejected');
        const controller=new AbortController();let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
        let timer:ReturnType<typeof setTimeout>|undefined,rejectCancelled:((error:MarketDataError)=>void)|undefined;
        const cancelled=new Promise<never>((_,rejectPromise)=>{rejectCancelled=rejectPromise;});
        const cancel=(reason='book-http-timeout')=>{controller.abort();if(timer)clearTimeout(timer);void reader?.cancel().catch(()=>{});rejectCancelled?.(new MarketDataError(reason));};cancellations.add(cancel);
        const remainingCapture=startedAt+BOOK_CAPTURE_LIMITS.captureTimeoutMs-requestedAt;
        const remainingSocket=socketStartedAt===null?Infinity:socketStartedAt+BOOK_CAPTURE_LIMITS.socketTimeoutMs-requestedAt;
        const timeoutMs=Math.min(timeout,remainingCapture,remainingSocket);
        const timeoutCode=timeoutMs===remainingCapture?'book-capture-deadline':timeoutMs===remainingSocket?'book-stream-timeout':'book-http-timeout';
        const operation=async()=>{
          requestCount++;
          const response=await this.#request(url,{method:'GET',credentials:'omit',redirect:'error',cache:'no-store',signal:controller.signal});
          if(done||controller.signal.aborted){void response.body?.cancel().catch(()=>{});return reject('book-http-timeout');}
          if(!response.ok){void response.body?.cancel().catch(()=>{});return reject(response.status===403?'book-http-access-denied':response.status===429||response.status===418?'book-http-rate-limited':'book-http-failed');}
          const length=response.headers.get('content-length');
          if(length!==null&&(!/^\d+$/.test(length)||BigInt(length)>BigInt(BOOK_CAPTURE_LIMITS.maximumResponseBytes))){void response.body?.cancel().catch(()=>{});return reject('book-response-too-large');}
          if(!response.body)return reject('invalid-public-json');
          reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
          while(true){const item=await reader.read();if(done||controller.signal.aborted)return reject('book-http-timeout');if(item.done)break;
            size+=item.value.byteLength;if(size>BOOK_CAPTURE_LIMITS.maximumResponseBytes)return reject('book-response-too-large');chunks.push(item.value);}
          const bytes=Buffer.concat(chunks,size);const parsed=parsePublicJson(bytes),envelope=record(parsed);
          if(envelope.code!==undefined&&['429','418','50011','50013','50040'].includes(numberText(envelope.code)))return reject('book-http-rate-limited');
          const receivedAt=now();checkTime(receivedAt);if(receivedAt-requestedAt>timeout)return reject('book-http-timeout');
          if(done||controller.signal.aborted)return reject('book-http-timeout');addBytes(size);
          return {raw:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes),receipt:{url,requestedAt,receivedAt}};
        };
        try{return await Promise.race([operation(),cancelled,new Promise<never>((_,rejectTimeout)=>{timer=setTimeout(()=>{cancel(timeoutCode);rejectTimeout(new MarketDataError(timeoutCode));},timeoutMs);})]);}
        catch(error){if(error instanceof MarketDataError)throw error;throw new MarketDataError('book-http-unavailable');}
        finally{if(timer)clearTimeout(timer);cancellations.delete(cancel);cancel();}
      };
      const bootstrap=async()=>{
        if(done||bootstrapStarted)return;bootstrapStarted=true;
        try{const response=await get(mexcDepthBootstrapUrl(this.#base),BOOK_CAPTURE_LIMITS.bootstrapTimeoutMs);if(done)return;
          events.push(session!.acceptBootstrap(response.raw,response.receipt));acceptedAppliedDeltas=session!.appliedDeltas;
          if(acceptedAppliedDeltas>=BOOK_CAPTURE_LIMITS.targetAppliedDeltas)finish(null);
        }catch(error){if(!done)finish(safeFailure(error,'book-http-unavailable'));}
      };
      const connect=()=>{
        if(done)return;const at=now();checkTime(at);socketStartedAt=at;
        socketTimer=setTimeout(()=>finish('book-stream-timeout'),BOOK_CAPTURE_LIMITS.socketTimeoutMs);
        connections++;
        try{socket=this.#factory(MEXC_DEPTH_STREAM_URL);}catch{finish('book-stream-unavailable');return;}
        socket.onopen=()=>{
          if(done)return;try{const at=now();checkTime(at);if(socketOpenedAt!==null)return finish('book-stream-unexpected-open');socketOpenedAt=at;
            socket!.send(JSON.stringify({method:'sub.depth',param:{symbol:market('mexc',this.#base).instrumentId,compress:false},gzip:false}));subscriptions++;
            heartbeat=setInterval(()=>{if(done)return;try{checkTime(now());if(pings>=BOOK_CAPTURE_LIMITS.maximumPings)return finish('book-stream-ping-budget');
              socket!.send(JSON.stringify({method:'ping'}));pings++;
            }catch(error){finish(safeFailure(error,'book-stream-unavailable'));}},10_000);
          }catch(error){finish(safeFailure(error,'book-stream-unavailable'));}
        };
        socket.onmessage=message=>{
          if(done)return;try{const receivedAt=now();checkTime(receivedAt);
            if(socketOpenedAt===null)return finish('book-stream-before-open');if(typeof message.data!=='string')return finish('book-stream-binary-message');
            const size=Buffer.byteLength(message.data,'utf8');
            if(size>BOOK_CAPTURE_LIMITS.maximumResponseBytes||frameCount>=BOOK_CAPTURE_LIMITS.maximumFrames)return finish('book-stream-frame-budget');
            addBytes(size);const event=session!.acceptFrame(message.data,receivedAt);events.push(event);frameCount++;acceptedAppliedDeltas=session!.appliedDeltas;
            if(event.kind==='frame'&&event.parsed.kind==='ack')void bootstrap();
            if(acceptedAppliedDeltas>=BOOK_CAPTURE_LIMITS.targetAppliedDeltas)finish(null);
          }catch(error){finish(safeFailure(error));}
        };
        socket.onerror=()=>finish('book-stream-unavailable');socket.onclose=()=>finish('book-stream-closed');
      };
      captureTimer=setTimeout(()=>finish('book-capture-deadline'),BOOK_CAPTURE_LIMITS.captureTimeoutMs);
      void(async()=>{try{
        const response=await get(publicUrl('mexc',this.#base,'instrument'),BOOK_CAPTURE_LIMITS.metadataTimeoutMs);if(done)return;
        session=new MexcBookSession(this.#base,response.raw,response.receipt);connect();
      }catch(error){if(!done)finish(safeFailure(error,'book-http-unavailable'));}})();
    });
  }
}
