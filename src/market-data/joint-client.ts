/** Explicit one-shot. No server import, secrets, retries, background loop or account route. */
import { numberText, parsePublicJson, record } from './exact-json.js';
import { market, MarketDataError, reject, type ResearchBase } from './model.js';
import { MexcBookClient } from './mexc-book-client.js';
import type { DepthSocket } from './mexc-depth-source-client.js';
import type { MexcBookCapture } from './mexc-book-session.js';
import { JOINT_FAILURES, JOINT_LIMITS, JOINT_ROUTES, jointResult, jointUrl, normalizeJointRead,
  type JointCapture, type JointRead, type JointRoute } from './joint-observation.js';
const failureCode=(error:unknown)=>error instanceof MarketDataError&&JOINT_FAILURES.includes(error.code)?error.code:'joint-http-unavailable';
export class JointObservationClient {
  #used=false; #last=0; #startedAt=0;
  readonly #base:ResearchBase; readonly #fetch:typeof fetch; readonly #clock:()=>number;
  readonly #factory:((url:string)=>DepthSocket)|undefined;
  readonly #cancellations=new Set<(reason:string)=>void>();
  constructor(base:ResearchBase, options:{fetch?:typeof fetch;clock?:()=>number;factory?:(url:string)=>DepthSocket}={}){
    market('mexc',base);if(Object.keys(options).some(k=>!['fetch','clock','factory'].includes(k)))reject('invalid-public-options');
    this.#base=base;this.#fetch=options.fetch??globalThis.fetch;this.#clock=options.clock??Date.now;this.#factory=options.factory;
  }
  #now():number {
    const at=this.#clock();if(!Number.isSafeInteger(at)||at<=0||at<this.#last||at>8_640_000_000_000_000)return reject('invalid-public-clock');
    this.#last=at;return at;
  }
  #deadline(at:number):void {if(at-this.#startedAt>=JOINT_LIMITS.captureTimeoutMs)reject('joint-capture-deadline');}
  async #read(route:JointRoute, prior:readonly JointRead[], batchAt?:number):Promise<JointRead>{
    const requestedAt=batchAt??this.#now();this.#deadline(requestedAt);
    const url=jointUrl(this.#base,route),controller=new AbortController();
    const timeout=route.endsWith('book')?JOINT_LIMITS.bookTimeoutMs:JOINT_LIMITS.metadataTimeoutMs;
    const remaining=JOINT_LIMITS.captureTimeoutMs-(requestedAt-this.#startedAt),wait=Math.min(timeout,remaining);
    let reader:ReadableStreamDefaultReader<Uint8Array>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
    let rejectCancelled:((error:MarketDataError)=>void)|undefined,closed=false,dispatched=false;
    const cancelled=new Promise<never>((_,no)=>{rejectCancelled=no;});
    const cancel=(reason:string)=>{controller.abort();void reader?.cancel().catch(()=>{});rejectCancelled?.(new MarketDataError(reason));};
    this.#cancellations.add(cancel);
    const operation=async()=>{
      // A shared batch timestamp cannot authorize a later dispatch after a pause.
      this.#deadline(this.#now());
      if(controller.signal.aborted)return reject('joint-peer-failed');
      dispatched=true;
      const response=await this.#fetch(url,{method:'GET',credentials:'omit',redirect:'error',cache:'no-store',signal:controller.signal});
      if(closed||controller.signal.aborted){void response.body?.cancel().catch(()=>{});return reject('joint-peer-failed');}
      if(!response.ok){void response.body?.cancel().catch(()=>{});return reject(response.status===403?'joint-http-access-denied':response.status===429||response.status===418?'joint-http-rate-limited':'joint-http-failed');}
      const length=response.headers.get('content-length');
      if(length!==null&&(!/^\d+$/.test(length)||BigInt(length)>BigInt(JOINT_LIMITS.maximumResponseBytes))){void response.body?.cancel().catch(()=>{});return reject('joint-response-too-large');}
      if(!response.body)return reject('joint-schema-rejected');
      reader=response.body.getReader();let bytes=0;const chunks:Uint8Array[]=[];
      while(true){const next=await reader.read();if(closed||controller.signal.aborted)return reject('joint-peer-failed');if(next.done)break;
        bytes+=next.value.byteLength;if(bytes>JOINT_LIMITS.maximumResponseBytes)return reject('joint-response-too-large');chunks.push(next.value);}
      const endedAt=this.#now();this.#deadline(endedAt);if(endedAt-requestedAt>timeout)return reject('joint-http-timeout');
      const body=Buffer.concat(chunks,bytes),receipt={url,requestedAt,receivedAt:endedAt};
      let raw:string,parsed;
      try{
        const envelope=record(parsePublicJson(body));
        if(envelope.code!==undefined&&['429','418','50011','50013','50040'].includes(numberText(envelope.code)))return reject('joint-http-rate-limited');
        raw=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(body);parsed=normalizeJointRead(this.#base,route,raw,receipt,prior);
      }catch(error){if(error instanceof MarketDataError&&error.code==='joint-http-rate-limited')throw error;return reject('joint-schema-rejected');}
      return {route,requestedAt,endedAt,observation:{raw,receipt,parsed},failure:null} satisfies JointRead;
    };
    try{
      timer=setTimeout(()=>cancel(wait===remaining?'joint-capture-deadline':'joint-http-timeout'),wait);
      return await Promise.race([operation(),cancelled]);
    }catch(error){
      let failure=failureCode(error),endedAt=this.#last;
      try{endedAt=this.#now();}catch{failure='invalid-public-clock';}
      for(const stop of this.#cancellations)if(stop!==cancel)stop('joint-peer-failed');
      return {route,requestedAt,endedAt,observation:null,failure,...(!dispatched?{notDispatched:true as const}:{})};
    }finally{closed=true;if(timer)clearTimeout(timer);this.#cancellations.delete(cancel);cancel('joint-peer-failed');}
  }
  async capture():Promise<JointCapture>{
    if(this.#used)return reject('public-client-used');this.#used=true;this.#startedAt=this.#now();
    const reads:JointRead[]=[];let mexc:MexcBookCapture|null=null,failure:string|null=null,jointDeadlineHit=false;
    try{
      // The timestamp-less MEXC Spot diagnostic happens before the time-critical books.
      for(const route of JOINT_ROUTES.slice(0,4)){
        const read=await this.#read(route,reads);reads.push(read);if(read.failure){failure=read.failure;break;}
      }
      if(!failure){
        this.#deadline(this.#now());
        mexc=await new MexcBookClient(this.#base,{profile:'joint-recovery-v1',fetch:this.#fetch,clock:()=>{
          const at=this.#now();if(at-this.#startedAt>=JOINT_LIMITS.captureTimeoutMs){jointDeadlineHit=true;return reject('joint-capture-deadline');}return at;
        },factory:this.#factory}).capture();
        if(mexc.status!=='complete')failure=jointDeadlineHit?'joint-capture-deadline':'joint-mexc-incomplete';
      }
      if(!failure){
        // Both fixed GETs start together. A failure aborts the peer, with no retry.
        const batchAt=this.#now();this.#deadline(batchAt);
        const pair=await Promise.all(JOINT_ROUTES.slice(4).map(route=>this.#read(route,reads,batchAt)));
        reads.push(...pair);failure=pair.find(r=>r.failure&&r.failure!=='joint-peer-failed')?.failure??pair.find(r=>r.failure)?.failure??null;
      }
    }catch(error){failure=failureCode(error);for(const cancel of this.#cancellations)cancel('joint-peer-failed');}
    let endedAt=this.#last;
    try{endedAt=this.#now();this.#deadline(endedAt);}catch(error){failure??=failureCode(error);}
    return jointResult(this.#base,this.#startedAt,endedAt,reads,mexc,failure);
  }
}
