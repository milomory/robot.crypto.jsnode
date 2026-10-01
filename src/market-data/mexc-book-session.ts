/** Deterministic merge of the captured REST snapshot and buffered public WS deltas. */
import { isDeepStrictEqual } from 'node:util';
import { parsePublicJson, units } from './exact-json.js';
import { parseMexcInstrument } from './mexc.js';
import { freeze, market, reject, type InstrumentSpec, type PublicReceipt, type ResearchBase } from './model.js';
import { MexcDepthStreamEvidence, type MexcDepthStreamMessage, type MexcDepthStreamDelta } from './mexc-depth-stream.js';
import { MexcDepthBook, parseMexcDepthBootstrap, type MexcDepthBootstrap, type MexcReconstructedBook } from './mexc-depth-book.js';
import { parseMexcDepthCommits, bridgeMexcBootstrap, type MexcDepthCommits, type MexcDepthCommit } from './mexc-depth-recovery.js';
export interface MexcBootstrapSource {raw:string;receipt:PublicReceipt;parsed:MexcDepthBootstrap}
export interface MexcRecoveryInput {raw:string;receipt:PublicReceipt}
export interface MexcBookMetadata { raw:string; receipt:PublicReceipt; parsed:InstrumentSpec }
export type MexcBookEvent =
  | {kind:'frame';raw:string;receivedAt:number;parsed:MexcDepthStreamMessage}
  | {kind:'bootstrap';raw:string;receipt:PublicReceipt;parsed:MexcDepthBootstrap;recovery?:MexcRecoveryInput&{parsed:MexcDepthCommits};bridged?:MexcDepthBootstrap};
export type MexcBookCaptureProfile = 'joint-4096'|'joint-recovery-v1';
export interface MexcBookCapture {
  schema:1;kind:'mexc-public-depth-book';base:ResearchBase;startedAt:number;endedAt:number;
  /** Omitted on the historical 256-frame profile; only an explicit joint profile expands it. */
  profile?:MexcBookCaptureProfile;
  /** Valid initial snapshot retained when its one allowed bridge attempt did not complete. */
  recoveryPending?:MexcBootstrapSource;
  requestCount:number;connections:number;subscriptions:number;pings:number;
  status:'complete'|'incomplete';failure:string|null;metadata:MexcBookMetadata|null;
  socketStartedAt:number|null;socketOpenedAt:number|null;events:readonly MexcBookEvent[];appliedDeltas:number;
  book:MexcReconstructedBook|null;accountRequests:false;executable:false;
}
function sameCommitUpdates(a:{bids:readonly MexcDepthStreamDelta['bids'][number][];asks:readonly MexcDepthStreamDelta['asks'][number][]},b:typeof a):boolean {
  const canonical=(rows:typeof a.bids)=>rows.map(row=>({price:row.price,quantityContracts:row.quantityContracts,orderCount:row.orderCount,action:row.action}))
    .sort((a,b)=>units(a.price)<units(b.price)?-1:units(a.price)>units(b.price)?1:0);
  return isDeepStrictEqual(canonical(a.bids),canonical(b.bids))&&isDeepStrictEqual(canonical(a.asks),canonical(b.asks));
}
export class MexcBookSession {
  readonly metadata:MexcBookMetadata;
  readonly #base:ResearchBase;
  readonly #stream:MexcDepthStreamEvidence;
  #book:MexcDepthBook|undefined;
  #buffer:MexcDepthStreamDelta[]=[];
  #futureCommits=new Map<string,MexcDepthCommit>();
  #count=0;#last=0;#dead=false;#bootstrapStarted=false;
  constructor(base:ResearchBase,raw:string,receipt:PublicReceipt){
    market('mexc',base);this.#base=base;this.#stream=new MexcDepthStreamEvidence(base);
    this.metadata=freeze({raw,receipt:{...receipt},parsed:parseMexcInstrument(parsePublicJson(Buffer.from(raw)),base,receipt)});
    this.#last=receipt.receivedAt;
  }
  get appliedDeltas():number{return this.#count;}
  #time(at:number){if(!Number.isSafeInteger(at)||at<this.#last||at<=0||at>8_640_000_000_000_000)return reject('book-session-timing');this.#last=at;}
  #guard(){if(this.#dead)return reject('book-session-rejected');}
  acceptFrame(raw:string,receivedAt:number):MexcBookEvent{
    this.#guard();try{
      this.#time(receivedAt);const parsed=this.#stream.accept(raw,receivedAt);
      if(parsed.kind==='delta'){
        if(!parsed.sourceTimeFresh)return reject('book-session-source-unverified');
        const committed=this.#futureCommits.get(parsed.version);
        if(committed&&!sameCommitUpdates(committed,parsed))return reject('book-session-recovery-conflict');
        if(this.#book){if(this.#book.apply(parsed))this.#count++;}
        else this.#buffer.push(parsed);
        this.#futureCommits.delete(parsed.version);
      }
      return freeze({kind:'frame',raw,receivedAt,parsed});
    }catch(error){this.#dead=true;throw error;}
  }
  bootstrapNeedsRecovery(raw:string,receipt:PublicReceipt):boolean {
    this.#guard();if(this.#bootstrapStarted)return reject('book-session-duplicate-bootstrap');
    const parsed=parseMexcDepthBootstrap(parsePublicJson(Buffer.from(raw)),this.#base,receipt,this.metadata.parsed);
    return this.#buffer.length>0&&BigInt(parsed.version)+1n<BigInt(this.#buffer[0].version);
  }
  acceptBootstrap(raw:string,receipt:PublicReceipt,recovery?:MexcRecoveryInput):MexcBookEvent{
    this.#guard();try{
      if(this.#bootstrapStarted)return reject('book-session-duplicate-bootstrap');this.#bootstrapStarted=true;
      if(receipt.requestedAt<this.metadata.receipt.receivedAt)return reject('book-session-timing');
      const parsed=parseMexcDepthBootstrap(parsePublicJson(Buffer.from(raw)),this.#base,receipt,this.metadata.parsed);
      let bridged:MexcDepthBootstrap|undefined,commits:MexcDepthCommits|undefined;
      if(recovery!==undefined){
        if(!recovery||Object.keys(recovery).sort().join(',')!=='raw,receipt'||typeof recovery.raw!=='string'||
          !recovery.receipt||recovery.receipt.requestedAt<receipt.receivedAt)return reject('book-session-recovery-timing');
        if(!this.#buffer.length||BigInt(parsed.version)+1n>=BigInt(this.#buffer[0].version))return reject('book-session-recovery-unneeded');
        this.#time(recovery.receipt.receivedAt);
        commits=parseMexcDepthCommits(parsePublicJson(Buffer.from(recovery.raw)),this.#base,recovery.receipt,this.metadata.parsed);
        const byVersion=new Map(this.#buffer.map(delta=>[delta.version,delta]));
        for(const commit of commits.commits){
          const delta=byVersion.get(commit.version);
          if(delta&&!sameCommitUpdates(commit,delta))return reject('book-session-recovery-conflict');
        }
        bridged=bridgeMexcBootstrap(parsed,commits,String(BigInt(this.#buffer[0].version)-1n),this.metadata.parsed);
      }else this.#time(receipt.receivedAt);
      const next=new MexcDepthBook(this.metadata.parsed,bridged??parsed);let count=0;
      for(const delta of this.#buffer)if(next.apply(delta))count++;
      if(commits){
        const lastVersion=BigInt(this.#buffer.at(-1)!.version);
        this.#futureCommits=new Map(commits.commits.filter(commit=>BigInt(commit.version)>lastVersion).map(commit=>[commit.version,commit]));
      }
      this.#book=next;this.#count=count;this.#buffer=[];
      return freeze({kind:'bootstrap',raw,receipt:{...receipt},parsed,...(recovery?{
        recovery:{raw:recovery.raw,receipt:{...recovery.receipt},parsed:commits!},bridged:bridged!}:{})});
    }catch(error){this.#dead=true;throw error;}
  }
  snapshot(at:number):MexcReconstructedBook{
    this.#guard();try{this.#time(at);if(!this.#book)return reject('book-session-missing-bootstrap');return this.#book.snapshot(at);}
    catch(error){this.#dead=true;throw error;}
  }
}
export const BOOK_SESSION_FAILURES=Object.freeze(['book-session-timing','book-session-rejected',
  'book-session-source-unverified','book-session-duplicate-bootstrap','book-session-missing-bootstrap',
  'book-session-recovery-timing','book-session-recovery-unneeded','book-session-recovery-conflict']);
