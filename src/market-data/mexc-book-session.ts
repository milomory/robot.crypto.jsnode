/** Deterministic merge of the captured REST snapshot and buffered public WS deltas. */
import { parsePublicJson } from './exact-json.js';
import { parseMexcInstrument } from './mexc.js';
import { freeze, market, reject, type InstrumentSpec, type PublicReceipt, type ResearchBase } from './model.js';
import { MexcDepthStreamEvidence, type MexcDepthStreamMessage, type MexcDepthStreamDelta } from './mexc-depth-stream.js';
import { MexcDepthBook, parseMexcDepthBootstrap, type MexcDepthBootstrap, type MexcReconstructedBook } from './mexc-depth-book.js';
export interface MexcBookMetadata { raw:string; receipt:PublicReceipt; parsed:InstrumentSpec }
export type MexcBookEvent =
  | {kind:'frame';raw:string;receivedAt:number;parsed:MexcDepthStreamMessage}
  | {kind:'bootstrap';raw:string;receipt:PublicReceipt;parsed:MexcDepthBootstrap};
export interface MexcBookCapture {
  schema:1;kind:'mexc-public-depth-book';base:ResearchBase;startedAt:number;endedAt:number;
  requestCount:number;connections:number;subscriptions:number;pings:number;
  status:'complete'|'incomplete';failure:string|null;metadata:MexcBookMetadata|null;
  socketStartedAt:number|null;socketOpenedAt:number|null;events:readonly MexcBookEvent[];appliedDeltas:number;
  book:MexcReconstructedBook|null;accountRequests:false;executable:false;
}
export class MexcBookSession {
  readonly metadata:MexcBookMetadata;
  readonly #base:ResearchBase;
  readonly #stream:MexcDepthStreamEvidence;
  #book:MexcDepthBook|undefined;
  #buffer:MexcDepthStreamDelta[]=[];
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
        if(this.#book){if(this.#book.apply(parsed))this.#count++;}
        else this.#buffer.push(parsed);
      }
      return freeze({kind:'frame',raw,receivedAt,parsed});
    }catch(error){this.#dead=true;throw error;}
  }
  acceptBootstrap(raw:string,receipt:PublicReceipt):MexcBookEvent{
    this.#guard();try{
      if(this.#bootstrapStarted)return reject('book-session-duplicate-bootstrap');this.#bootstrapStarted=true;
      if(receipt.requestedAt<this.metadata.receipt.receivedAt)return reject('book-session-timing');
      this.#time(receipt.receivedAt);
      const parsed=parseMexcDepthBootstrap(parsePublicJson(Buffer.from(raw)),this.#base,receipt,this.metadata.parsed);
      const next=new MexcDepthBook(this.metadata.parsed,parsed);let count=0;
      for(const delta of this.#buffer)if(next.apply(delta))count++;
      this.#book=next;this.#count=count;this.#buffer=[];
      return freeze({kind:'bootstrap',raw,receipt:{...receipt},parsed});
    }catch(error){this.#dead=true;throw error;}
  }
  snapshot(at:number):MexcReconstructedBook{
    this.#guard();try{this.#time(at);if(!this.#book)return reject('book-session-missing-bootstrap');return this.#book.snapshot(at);}
    catch(error){this.#dead=true;throw error;}
  }
}
export const BOOK_SESSION_FAILURES=Object.freeze(['book-session-timing','book-session-rejected',
  'book-session-source-unverified','book-session-duplicate-bootstrap','book-session-missing-bootstrap']);
