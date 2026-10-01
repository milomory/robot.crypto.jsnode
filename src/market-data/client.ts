/** One-shot public D0 observation. Fixed eight GETs at most; no timers, keys or execution. */
import { parsePublicJson, numberText, record } from './exact-json.js';
import { MarketDataError, freeze, publicUrl, reject, type ResearchExchange, type ResearchBase, type InstrumentSpec, type FundingEstimate, type PublicReceipt } from './model.js';
import { parseMexcInstrument, parseMexcFunding } from './mexc.js';
import { parseOkxInstrument, parseOkxFunding } from './okx.js';
export type PublicObservation = { receipt: PublicReceipt; raw: string; parsed: InstrumentSpec | FundingEstimate };
export type D0Capture = Readonly<{schema:1;kind:'derivatives-public-d0';startedAt:number;endedAt:number;requestCount:number;
  status:'complete'|'incomplete';observations:readonly PublicObservation[];failures:readonly {exchange:ResearchExchange;base:ResearchBase;kind:'instrument'|'funding';reason:string}[];
  executable:false;accountRequests:false;feesVerified:false;netEdgeBps:null}>;
export class DerivativesPublicClient {
  #used=false;
  #request:typeof fetch;
  #clock:()=>number;
  #last=0;
  #requests=0;
  #start=0;
  constructor(options:Readonly<{fetch?:typeof fetch;clock?:()=>number}>={}) {
    if(Object.keys(options).some(k=>!['fetch','clock'].includes(k)))reject('invalid-public-options');
    this.#request=options.fetch??globalThis.fetch;this.#clock=options.clock??Date.now;
  }
  #now(){const n=this.#clock();if(!Number.isSafeInteger(n)||n<=0||n<this.#last||n>8_640_000_000_000_000)reject('invalid-public-clock');this.#last=n;return n;}
  async #get(exchange:ResearchExchange,base:ResearchBase,kind:'instrument'|'funding'):Promise<PublicObservation>{
    const requestedAt=this.#now();
    if(this.#requests>=8||requestedAt-this.#start>=45000)reject('public-capture-deadline');
    const target=publicUrl(exchange,base,kind),controller=new AbortController();
    let reader:ReadableStreamDefaultReader<Uint8Array>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
    const cancel=()=>{controller.abort();void reader?.cancel().catch(()=>{});};
    const limit=512*1024;
    const operation=async()=>{
      this.#requests++;
      const response=await this.#request(target,{method:'GET',credentials:'omit',redirect:'error',cache:'no-store',signal:controller.signal});
      if(controller.signal.aborted){void response.body?.cancel().catch(()=>{});return reject('public-timeout');}
      if(!response.ok){void response.body?.cancel().catch(()=>{});return reject(response.status===429||response.status===418?'public-rate-limited':response.status===403?'public-access-denied':'public-http-failed');}
      const length=response.headers.get('content-length');
      if(length!==null&&(!/^\d+$/.test(length)||BigInt(length)>BigInt(limit))){void response.body?.cancel().catch(()=>{});return reject('public-response-too-large');}
      if(!response.body)return reject('invalid-public-json');
      reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
      while(true){const item=await reader.read();if(controller.signal.aborted)return reject('public-timeout');if(item.done)break;size+=item.value.byteLength;if(size>limit)reject('public-response-too-large');chunks.push(item.value);}
      const bytes=Buffer.concat(chunks,size),raw=parsePublicJson(bytes),receivedAt=this.#now(),receipt={url:target,requestedAt,receivedAt};
      if(controller.signal.aborted||receivedAt-this.#start>=45000)reject('public-capture-deadline');
      const envelope=record(raw);
      if(envelope.code!==undefined&&['429','418','50011','50013','50040'].includes(numberText(envelope.code)))reject('public-rate-limited');
      const parsed=exchange==='mexc'?(kind==='instrument'?parseMexcInstrument(raw,base,receipt):parseMexcFunding(raw,base,receipt)):
        (kind==='instrument'?parseOkxInstrument(raw,base,receipt):parseOkxFunding(raw,base,receipt));
      return {receipt,raw:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes),parsed};
    };
    try{return await Promise.race([operation(),new Promise<never>((_,rejectTimeout)=>{timer=setTimeout(()=>{cancel();rejectTimeout(new MarketDataError('public-timeout'));},5000);})]);}
    finally{if(timer)clearTimeout(timer);cancel();}
  }
  async capture():Promise<D0Capture>{
    if(this.#used)reject('public-client-used');this.#used=true;this.#start=this.#now();
    const observations:PublicObservation[]=[],failures:D0Capture['failures'][number][]=[];
    // Stop the entire run after the first rejected response; no fallback or catch-up.
    outer:for(const exchange of ['mexc','okx'] as const)for(const base of ['BTC','ETH'] as const)for(const kind of ['instrument','funding'] as const){
      try{observations.push(await this.#get(exchange,base,kind));}
      catch(error){failures.push({exchange,base,kind,reason:error instanceof MarketDataError?error.code:'public-unavailable'});break outer;}
    }
    const endedAt=this.#now();
    return freeze({schema:1,kind:'derivatives-public-d0',startedAt:this.#start,endedAt,requestCount:this.#requests,
      status:failures.length?'incomplete':'complete',observations,failures,executable:false,accountRequests:false,feesVerified:false,netEdgeBps:null});
  }
}
