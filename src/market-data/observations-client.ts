/** Explicit D0b profile: a fixed 24-read plan, separate from the accepted eight-read D0a. */
import { numberText, parsePublicJson, record } from './exact-json.js';
import { freeze, MarketDataError, reject, type FundingEstimate, type InstrumentSpec, type PublicReceipt } from './model.js';
import { observationPlan, observationUrl, type FundingHistory, type MarketMetrics, type PerpetualBook, type Route } from './observation-model.js';
import { bookPairQuality, type BookPairQuality } from './observation-quality.js';
import { parseMexcFunding, parseMexcInstrument } from './mexc.js';
import { parseOkxFunding, parseOkxInstrument } from './okx.js';
import { parseMexcBook, parseMexcHistory, parseMexcTicker } from './mexc-observations.js';
import { parseOkxBook, parseOkxHistory, parseOkxMetrics } from './okx-observations.js';
export type ObservationValue = InstrumentSpec | FundingEstimate | PerpetualBook | MarketMetrics | FundingHistory;
export interface D0bObservation { route: Route; receipt: PublicReceipt; raw: string; parsed: ObservationValue }
export interface D0bCapture {
  schema: 1; kind: 'derivatives-public-d0b'; startedAt: number; endedAt: number; requestCount: number;
  status: 'complete'|'incomplete'; observations: readonly D0bObservation[];
  failures: readonly {route:Route;reason:string}[]; quality: readonly BookPairQuality[];
  executable:false; accountRequests:false; feesVerified:false; netEdgeBps:null;
}
export function normalizeObservation(raw: unknown, route: Route, receipt: PublicReceipt, prior: readonly D0bObservation[]): ObservationValue {
  const {exchange,base,kind}=route;
  if(kind==='instrument')return exchange==='mexc'?parseMexcInstrument(raw,base,receipt):parseOkxInstrument(raw,base,receipt);
  if(kind==='funding')return exchange==='mexc'?parseMexcFunding(raw,base,receipt):parseOkxFunding(raw,base,receipt);
  const spec=prior.map(p=>p.parsed).find((p):p is InstrumentSpec=>p.kind==='public-linear-contract'&&p.market.exchange===exchange&&p.market.base===base);
  if(!spec)return reject('missing-observation-spec');
  if(exchange==='mexc'){
    if(kind==='book')return parseMexcBook(raw,base,receipt,spec);
    if(kind==='ticker')return parseMexcTicker(raw,base,receipt,spec);
    if(kind==='history')return parseMexcHistory(raw,base,receipt,spec);
  }else{
    if(kind==='book')return parseOkxBook(raw,base,receipt,spec);
    if(kind==='history')return parseOkxHistory(raw,base,receipt,spec);
    if(kind==='mark'||kind==='index'||kind==='open-interest')return parseOkxMetrics(raw,base,receipt,spec,kind);
  }
  return reject('unsupported-observation-route');
}
export function observationQuality(observations: readonly D0bObservation[]): readonly BookPairQuality[] {
  const values=observations.map(o=>o.parsed);
  return (['BTC','ETH'] as const).map(base=>bookPairQuality(base,
    values.filter((v):v is InstrumentSpec=>v.kind==='public-linear-contract'),
    values.filter((v):v is PerpetualBook=>v.kind==='public-perpetual-book')));
}
export const OBSERVATION_FAILURES = Object.freeze([
  'public-timeout','public-rate-limited','public-access-denied','public-http-failed','public-response-too-large',
  'invalid-public-json','invalid-public-clock','public-capture-deadline','public-schema-rejected','public-unavailable',
]);
export class DerivativesObservationClient {
  #used=false; #last=0; #start=0; #requests=0;
  readonly #fetch:typeof fetch; readonly #clock:()=>number;
  constructor(options:Readonly<{fetch?:typeof fetch;clock?:()=>number}>={}){
    if(Object.keys(options).some(k=>!['fetch','clock'].includes(k)))throw new MarketDataError('invalid-public-options');
    this.#fetch=options.fetch??globalThis.fetch;this.#clock=options.clock??Date.now;
  }
  #now():number{
    const value=this.#clock();if(!Number.isSafeInteger(value)||value<=0||value<this.#last||value>8_640_000_000_000_000)return reject('invalid-public-clock');
    this.#last=value;return value;
  }
  async #read(route:Route, prior:readonly D0bObservation[]):Promise<D0bObservation>{
    const requestedAt=this.#now();
    if(this.#requests>=24||requestedAt-this.#start>=125000)return reject('public-capture-deadline');
    const target=observationUrl(route.exchange,route.base,route.kind),controller=new AbortController();
    let reader:ReadableStreamDefaultReader<Uint8Array>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
    const cancel=()=>{controller.abort();void reader?.cancel().catch(()=>{});};
    const remaining=125000-(requestedAt-this.#start),perRequest=route.kind==='book'?3000:5000;
    const timeout=Math.min(perRequest,remaining),timeoutReason=remaining<=perRequest?'public-capture-deadline':'public-timeout';
    const operation=async()=>{
      this.#requests++;
      const response=await this.#fetch(target,{method:'GET',credentials:'omit',redirect:'error',cache:'no-store',signal:controller.signal});
      if(controller.signal.aborted){void response.body?.cancel().catch(()=>{});return reject('public-timeout');}
      if(!response.ok){void response.body?.cancel().catch(()=>{});return reject(response.status===429||response.status===418?'public-rate-limited':response.status===403?'public-access-denied':'public-http-failed');}
      const length=response.headers.get('content-length');
      if(length!==null&&(!/^\d+$/.test(length)||BigInt(length)>524288n)){void response.body?.cancel().catch(()=>{});return reject('public-response-too-large');}
      if(!response.body)return reject('invalid-public-json');
      reader=response.body.getReader();const chunks:Uint8Array[]=[];let bytes=0;
      while(true){const part=await reader.read();if(controller.signal.aborted)return reject('public-timeout');if(part.done)break;
        bytes+=part.value.byteLength;if(bytes>524288)return reject('public-response-too-large');chunks.push(part.value);}
      const body=Buffer.concat(chunks,bytes),raw=parsePublicJson(body),receivedAt=this.#now();
      if(controller.signal.aborted||receivedAt-this.#start>=125000)return reject('public-capture-deadline');
      const receipt={url:target,requestedAt,receivedAt},envelope=record(raw);
      if(envelope.code!==undefined&&['429','418','50011','50013','50040'].includes(numberText(envelope.code)))return reject('public-rate-limited');
      const parsed=normalizeObservation(raw,route,receipt,prior);
      return {route:{...route},receipt,raw:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(body),parsed};
    };
    try{return await Promise.race([operation(),new Promise<never>((_,onTimeout)=>{timer=setTimeout(()=>{cancel();onTimeout(new MarketDataError(timeoutReason));},timeout);})]);}
    finally{if(timer)clearTimeout(timer);cancel();}
  }
  async capture():Promise<D0bCapture>{
    if(this.#used)return reject('public-client-used');this.#used=true;this.#start=this.#now();
    const observations:D0bObservation[]=[],failures:{route:Route;reason:string}[]=[];
    for(const route of observationPlan()){
      try{observations.push(await this.#read(route,observations));}
      catch(error){const reason=error instanceof MarketDataError?(OBSERVATION_FAILURES.includes(error.code)?error.code:'public-schema-rejected'):'public-unavailable';
        failures.push({route:{...route},reason});break;}
    }
    // A backwards clock preserves only the last valid time and marks the run incomplete.
    let endedAt=this.#last;
    try{endedAt=this.#now();if(endedAt-this.#start>=125000&&!failures.length)failures.push({route:{...observationPlan()[Math.min(observations.length,23)]},reason:'public-capture-deadline'});}catch{
      if(!failures.length)failures.push({route:{...observationPlan()[Math.min(observations.length,23)]},reason:'invalid-public-clock'});
    }
    return freeze({schema:1,kind:'derivatives-public-d0b',startedAt:this.#start,endedAt,requestCount:this.#requests,
      status:failures.length?'incomplete':'complete',observations,failures,quality:observationQuality(observations),
      executable:false,accountRequests:false,feesVerified:false,netEdgeBps:null});
  }
}
