/** One bounded public WS source-time probe. This does not reconstruct a book. */
import { freeze, MarketDataError, reject } from './model.js';
import { MexcDepthStreamEvidence, STREAM_FAILURES, type MexcDepthStreamMessage } from './mexc-depth-stream.js';
export const MEXC_DEPTH_SOURCE_URL = 'wss://contract.mexc.com/edge';
export const MEXC_DEPTH_SUBSCRIPTION = JSON.stringify({method:'sub.depth',param:{symbol:'BTC_USDT',compress:false},gzip:false});
export const MEXC_DEPTH_PING = JSON.stringify({method:'ping'});
export type DepthSocket = Pick<WebSocket,'onopen'|'onmessage'|'onerror'|'onclose'|'close'|'send'>;
export interface DepthSourceFrame { raw:string; receivedAt:number; parsed:MexcDepthStreamMessage }
export interface DepthSourceCapture {
  schema:1;kind:'mexc-public-depth-source';url:typeof MEXC_DEPTH_SOURCE_URL;
  startedAt:number;endedAt:number;connections:1;subscriptions:number;pings:number;
  status:'complete'|'incomplete';frames:readonly DepthSourceFrame[];acceptedDeltas:number;
  failure:string|null;sourceTimeObserved:boolean;bookReconstructed:false;executable:false;
}
const safeFailure = (error:unknown):string => error instanceof MarketDataError && (error.code==='invalid-public-clock'||STREAM_FAILURES.includes(error.code))
  ?error.code:'depth-stream-schema-rejected';
export class MexcDepthSourceClient {
  #used=false;
  readonly #factory:(url:string)=>DepthSocket;
  readonly #clock:()=>number;
  constructor(options:{factory?:(url:string)=>DepthSocket;clock?:()=>number}={}){
    if(Object.keys(options).some(k=>!['factory','clock'].includes(k)))throw new MarketDataError('invalid-public-options');
    this.#factory=options.factory??(url=>new WebSocket(url));this.#clock=options.clock??Date.now;
  }
  async capture():Promise<DepthSourceCapture>{
    if(this.#used)return reject('public-client-used');this.#used=true;
    let last=0;
    const now=()=>{const n=this.#clock();if(!Number.isSafeInteger(n)||n<=0||n<last||n>8_640_000_000_000_000)return reject('invalid-public-clock');last=n;return n;};
    const startedAt=now(),frames:DepthSourceFrame[]=[],parser=new MexcDepthStreamEvidence();
    let socket:DepthSocket|undefined,done=false,opened=false,subscriptions=0,pings=0,deltas=0,totalBytes=0;
    let timer:ReturnType<typeof setTimeout>|undefined,heartbeat:ReturnType<typeof setInterval>|undefined;
    return await new Promise(resolve=>{
      const finish=(failure:string|null)=>{
        if(done)return;done=true;
        let endedAt=last;try{endedAt=now();}catch{failure??='invalid-public-clock';}
        if(endedAt-startedAt>=20_000)failure??='depth-source-timeout';
        if(timer)clearTimeout(timer);if(heartbeat)clearInterval(heartbeat);
        if(socket){socket.onopen=null;socket.onmessage=null;socket.onclose=null;socket.onerror=null;try{socket.close();}catch{}}
        resolve(freeze({schema:1,kind:'mexc-public-depth-source',url:MEXC_DEPTH_SOURCE_URL,startedAt,endedAt,connections:1,
          subscriptions,pings,status:failure?'incomplete':'complete',frames,acceptedDeltas:deltas,failure,
          sourceTimeObserved:deltas>0,bookReconstructed:false,executable:false}));
      };
      timer=setTimeout(()=>finish('depth-source-timeout'),20_000);
      try{socket=this.#factory(MEXC_DEPTH_SOURCE_URL);}catch{finish('depth-source-unavailable');return;}
      socket.onopen=()=>{
        if(done)return;
        try{
          if(opened){finish('depth-source-unexpected-open');return;}
          opened=true;if(now()-startedAt>=20_000){finish('depth-source-timeout');return;}
          socket!.send(MEXC_DEPTH_SUBSCRIPTION);subscriptions++;
          heartbeat=setInterval(()=>{
            if(done)return;
            try{if(now()-startedAt>=20_000){finish('depth-source-timeout');return;}
              if(pings>=1){finish('depth-source-ping-budget');return;}
              socket!.send(MEXC_DEPTH_PING);pings++;
            }catch(error){finish(error instanceof MarketDataError? safeFailure(error):'depth-source-unavailable');}
          },10_000);
        }catch(error){finish(error instanceof MarketDataError?safeFailure(error):'depth-source-unavailable');}
      };
      socket.onmessage=event=>{
        if(done)return;
        try{
          const receivedAt=now();if(receivedAt-startedAt>=20_000){finish('depth-source-timeout');return;}
          if(!opened){finish('depth-source-before-open');return;}
          if(typeof event.data!=='string'){finish('depth-source-binary-message');return;}
          const size=Buffer.byteLength(event.data);totalBytes+=size;
          if(size>524288||totalBytes>4*1024*1024||frames.length>=32){finish('depth-source-message-budget');return;}
          const parsed=parser.accept(event.data,receivedAt);
          frames.push({raw:event.data,receivedAt,parsed});
          if(parsed.kind==='delta'){
            if(!parsed.sourceTimeFresh){finish('depth-source-time-unverified');return;}
            deltas++;if(deltas===10)finish(null);
          }
        }catch(error){finish(safeFailure(error));}
      };
      socket.onerror=()=>finish('depth-source-unavailable');
      socket.onclose=()=>finish('depth-source-closed');
    });
  }
}
