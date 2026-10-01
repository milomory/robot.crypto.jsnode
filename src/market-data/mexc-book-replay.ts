/** Reconstructs historical top50 from exact raw events. Not exchange authentication. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { freeze, market, reject } from './model.js';
import { STREAM_FAILURES } from './mexc-depth-stream.js';
import { DEPTH_BOOK_FAILURES } from './mexc-depth-book.js';
import { BOOK_CLIENT_FAILURES } from './mexc-book-client.js';
import { BOOK_SESSION_FAILURES, MexcBookSession, type MexcBookCapture } from './mexc-book-session.js';
// Up to 256 delta frames can expand substantially after exact normalized fields are added.
export const MAX_MEXC_BOOK_ARCHIVE_BYTES=128*1024*1024;
const failures=()=>new Set([...STREAM_FAILURES,...DEPTH_BOOK_FAILURES,...BOOK_CLIENT_FAILURES,...BOOK_SESSION_FAILURES]);
const validTime=(n:number)=>Number.isSafeInteger(n)&&n>0&&n<=8_640_000_000_000_000;
const invalid=():never=>reject('invalid-mexc-book-archive');
const beforeRequest=new Set(['invalid-public-clock','book-capture-deadline']);
const beforeMetadata=new Set([...beforeRequest,'book-http-timeout','book-http-unavailable','book-http-access-denied','book-http-rate-limited',
  'book-http-failed','book-response-too-large','book-raw-budget','book-schema-rejected','invalid-public-contract','invalid-public-response',
  'invalid-public-timing','invalid-public-json','invalid-public-data','invalid-public-number','invalid-public-time','public-response-too-large','unsupported-public-contract']);
export function replayMexcBook(bytes:Buffer,expectedSha256:string):MexcBookCapture{
  if(bytes.length>MAX_MEXC_BOOK_ARCHIVE_BYTES||! /^[a-f0-9]{64}$/.test(expectedSha256)||createHash('sha256').update(bytes).digest('hex')!==expectedSha256)return invalid();
  let value:MexcBookCapture;
  try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{return invalid();}
  if(!value||JSON.stringify(value)+'\n'!==bytes.toString('utf8')||Object.keys(value).sort().join(',')!==
    'accountRequests,appliedDeltas,base,book,connections,endedAt,events,executable,failure,kind,metadata,pings,requestCount,schema,socketOpenedAt,socketStartedAt,startedAt,status,subscriptions')return invalid();
  market('mexc',value.base);
  if(value.schema!==1||value.kind!=='mexc-public-depth-book'||!validTime(value.startedAt)||!validTime(value.endedAt)||value.endedAt<value.startedAt||
    !Number.isInteger(value.requestCount)||value.requestCount<0||value.requestCount>2||![0,1].includes(value.connections)||
    ![0,1].includes(value.subscriptions)||![0,1].includes(value.pings)||value.pings>value.subscriptions||value.subscriptions>value.connections||
    !Number.isInteger(value.appliedDeltas)||value.appliedDeltas<0||value.appliedDeltas>256||!Array.isArray(value.events)||value.events.length>257||
    value.accountRequests!==false||value.executable!==false||!['complete','incomplete'].includes(value.status)||
    (value.status==='complete'?value.failure!==null:!failures().has(value.failure??'')))return invalid();
  if(value.metadata===null){
    if(value.status!=='incomplete'||value.requestCount>1||value.connections!==0||value.socketStartedAt!==null||value.socketOpenedAt!==null||value.events.length||value.appliedDeltas!==0||value.book!==null)return invalid();
    if(!(value.requestCount===0?beforeRequest:beforeMetadata).has(value.failure!))return invalid();
    return freeze(value);
  }
  const m=value.metadata;
  if(!m||Object.keys(m).sort().join(',')!=='parsed,raw,receipt'||typeof m.raw!=='string'||Buffer.byteLength(m.raw)>524288||
      !m.receipt||m.receipt.requestedAt<value.startedAt||m.receipt.receivedAt>value.endedAt||m.receipt.receivedAt-value.startedAt>=25000||value.requestCount<1)return invalid();
  const session=new MexcBookSession(value.base,m.raw,m.receipt);
  if(!isDeepStrictEqual(session.metadata,m))return reject('invalid-mexc-book-normalization');
  if(value.connections===0&&(value.socketStartedAt!==null||value.socketOpenedAt!==null||value.events.length||value.requestCount!==1))return invalid();
  if(value.connections===0&&!beforeRequest.has(value.failure!))return invalid();
  if(value.connections===1&&(!validTime(value.socketStartedAt!)||value.socketStartedAt!<m.receipt.receivedAt||value.socketStartedAt!>value.endedAt||value.socketStartedAt!-value.startedAt>=25000))return invalid();
  if(value.socketOpenedAt!==null&&(!validTime(value.socketOpenedAt)||value.connections!==1||value.socketOpenedAt<value.socketStartedAt!||value.socketOpenedAt>value.endedAt||value.socketOpenedAt-value.socketStartedAt!>=20000||value.socketOpenedAt-value.startedAt>=25000))return invalid();
  if(value.subscriptions===1&&value.socketOpenedAt===null||value.pings===1&&value.endedAt-value.socketOpenedAt!<10000)return invalid();
  if(value.events.length&&value.subscriptions!==1)return invalid();
  let last=m.receipt.receivedAt,rawBytes=Buffer.byteLength(m.raw),bootstrap=false,frameCount=0,ackAt:number|null=null,reached=false;
  for(const event of value.events){
    if(reached||!event||typeof event.raw!=='string')return invalid();
    const size=Buffer.byteLength(event.raw);rawBytes+=size;if(size>524288||rawBytes>4*1024*1024)return invalid();
    let replayed;
    if(event.kind==='frame'){
      if(Object.keys(event).sort().join(',')!=='kind,parsed,raw,receivedAt'||++frameCount>256||!validTime(event.receivedAt)||
        event.receivedAt<last||event.receivedAt>value.endedAt||event.receivedAt<value.socketOpenedAt!||
        event.receivedAt-value.socketStartedAt!>=20000||event.receivedAt-value.startedAt>=25000)return invalid();
      last=event.receivedAt;replayed=session.acceptFrame(event.raw,event.receivedAt);
      if(replayed.kind==='frame'&&replayed.parsed.kind==='ack')ackAt=event.receivedAt;
    }else if(event.kind==='bootstrap'){
      if(Object.keys(event).sort().join(',')!=='kind,parsed,raw,receipt'||bootstrap||ackAt===null||value.requestCount!==2||
        !event.receipt||event.receipt.requestedAt<ackAt||event.receipt.receivedAt<last||event.receipt.receivedAt>value.endedAt||
        event.receipt.receivedAt-value.socketStartedAt!>=20000||event.receipt.receivedAt-value.startedAt>=25000)return invalid();
      last=event.receipt.receivedAt;replayed=session.acceptBootstrap(event.raw,event.receipt);bootstrap=true;
    }else return invalid();
    if(!isDeepStrictEqual(replayed,event))return reject('invalid-mexc-book-normalization');
    reached=session.appliedDeltas>=10;
  }
  if(value.requestCount===2&&ackAt===null||value.appliedDeltas!==session.appliedDeltas)return invalid();
  if(value.status==='complete'){
    if(!reached||!bootstrap||value.connections!==1||value.subscriptions!==1||value.requestCount!==2||value.endedAt-value.startedAt>=25000||value.endedAt-value.socketStartedAt!>=20000)return invalid();
    if(!isDeepStrictEqual(value.book,session.snapshot(value.endedAt)))return reject('invalid-mexc-book-normalization');
  }else {
    if(value.book!==null)return invalid();
    if(bootstrap&&(value.failure!.startsWith('book-http-')||value.failure==='book-response-too-large'))return invalid();
    if(reached&&!['invalid-public-clock','book-capture-deadline','book-stream-timeout','depth-book-source-time-unverified'].includes(value.failure!))return invalid();
  }
  return freeze(value);
}
