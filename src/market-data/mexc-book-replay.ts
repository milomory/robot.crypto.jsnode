/** Reconstructs historical top50 from exact raw events. Not exchange authentication. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { freeze, market, reject } from './model.js';
import { STREAM_FAILURES } from './mexc-depth-stream.js';
import { parsePublicJson } from './exact-json.js';
import { DEPTH_BOOK_FAILURES, parseMexcDepthBootstrap } from './mexc-depth-book.js';
import { BOOK_CLIENT_FAILURES, BOOK_CAPTURE_LIMITS, JOINT_BOOK_CAPTURE_LIMITS } from './mexc-book-client.js';
import { BOOK_SESSION_FAILURES, MexcBookSession, type MexcBookCapture } from './mexc-book-session.js';
// Both explicit frame profiles retain the same 4 MiB raw budget; normalized fields may expand it.
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
  if(!value||typeof value!=='object'||JSON.stringify(value)+'\n'!==bytes.toString('utf8'))return invalid();
  const hasProfile=Object.hasOwn(value,'profile');
  if(hasProfile&&!['joint-4096','joint-recovery-v1'].includes(value.profile!))return invalid();
  const recoveryProfile=value.profile==='joint-recovery-v1',hasPending=Object.hasOwn(value,'recoveryPending');
  if(hasPending&&!recoveryProfile)return invalid();
  if(value.failure==='book-bootstrap-warmup-incomplete'&&!hasProfile)return invalid();
  const keys='accountRequests,appliedDeltas,base,book,connections,endedAt,events,executable,failure,kind,metadata,pings,requestCount,schema,socketOpenedAt,socketStartedAt,startedAt,status,subscriptions'.split(',');
  if(hasProfile)keys.push('profile');if(hasPending)keys.push('recoveryPending');
  if(Object.keys(value).sort().join(',')!==keys.sort().join(','))return invalid();
  const frameLimit=hasProfile?JOINT_BOOK_CAPTURE_LIMITS.maximumFrames:BOOK_CAPTURE_LIMITS.maximumFrames;
  market('mexc',value.base);
  if(value.schema!==1||value.kind!=='mexc-public-depth-book'||!validTime(value.startedAt)||!validTime(value.endedAt)||value.endedAt<value.startedAt||
    !Number.isInteger(value.requestCount)||value.requestCount<0||value.requestCount>(recoveryProfile?3:2)||![0,1].includes(value.connections)||
    ![0,1].includes(value.subscriptions)||![0,1].includes(value.pings)||value.pings>value.subscriptions||value.subscriptions>value.connections||
    !Number.isInteger(value.appliedDeltas)||value.appliedDeltas<0||value.appliedDeltas>frameLimit||!Array.isArray(value.events)||value.events.length>frameLimit+1||
    value.accountRequests!==false||value.executable!==false||!['complete','incomplete'].includes(value.status)||
    (value.status==='complete'?value.failure!==null:!failures().has(value.failure??'')))return invalid();
  if(value.metadata===null){
    if(hasPending||value.status!=='incomplete'||value.requestCount>1||value.connections!==0||value.socketStartedAt!==null||value.socketOpenedAt!==null||value.events.length||value.appliedDeltas!==0||value.book!==null)return invalid();
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
  let last=m.receipt.receivedAt,rawBytes=Buffer.byteLength(m.raw),bootstrap=false,frameCount=0,ackAt:number|null=null,firstDeltaAt:number|null=null,reached=false,recovered=false;
  for(const event of value.events){
    if(reached||!event||typeof event.raw!=='string')return invalid();
    const size=Buffer.byteLength(event.raw);rawBytes+=size;if(size>524288||rawBytes>4*1024*1024)return invalid();
    let replayed;
    if(event.kind==='frame'){
      if(Object.keys(event).sort().join(',')!=='kind,parsed,raw,receivedAt'||++frameCount>frameLimit||!validTime(event.receivedAt)||
        event.receivedAt<last||event.receivedAt>value.endedAt||event.receivedAt<value.socketOpenedAt!||
        event.receivedAt-value.socketStartedAt!>=20000||event.receivedAt-value.startedAt>=25000)return invalid();
      last=event.receivedAt;replayed=session.acceptFrame(event.raw,event.receivedAt);
      if(replayed.kind==='frame'&&replayed.parsed.kind==='ack')ackAt=event.receivedAt;
      if(replayed.kind==='frame'&&replayed.parsed.kind==='delta'&&firstDeltaAt===null)firstDeltaAt=event.receivedAt;
    }else if(event.kind==='bootstrap'){
      const hasRecovery=Object.hasOwn(event,'recovery'),hasBridged=Object.hasOwn(event,'bridged');
      if(hasRecovery!==hasBridged||hasRecovery&&!recoveryProfile||
        Object.keys(event).sort().join(',')!==(hasRecovery?'bridged,kind,parsed,raw,receipt,recovery':'kind,parsed,raw,receipt')||
        bootstrap||ackAt===null||value.requestCount!==(hasRecovery?3:2)||hasPending||
        !event.receipt||event.receipt.requestedAt<ackAt||event.receipt.receivedAt>value.endedAt||
        hasProfile&&(firstDeltaAt===null||event.receipt.requestedAt<Math.max(ackAt,firstDeltaAt+JOINT_BOOK_CAPTURE_LIMITS.bootstrapWarmupMs))||
        event.receipt.receivedAt-value.socketStartedAt!>=20000||event.receipt.receivedAt-value.startedAt>=25000)return invalid();
      let effectiveAt=event.receipt.receivedAt;
      if(hasRecovery){
        const r=event.recovery!;
        if(!r||Object.keys(r).sort().join(',')!=='parsed,raw,receipt'||typeof r.raw!=='string'||Buffer.byteLength(r.raw)>524288||
          !r.receipt||r.receipt.requestedAt<event.receipt.receivedAt||r.receipt.receivedAt>value.endedAt||
          r.receipt.receivedAt-value.socketStartedAt!>=20000||r.receipt.receivedAt-value.startedAt>=25000)return invalid();
        rawBytes+=Buffer.byteLength(r.raw);if(rawBytes>4*1024*1024)return invalid();
        effectiveAt=r.receipt.receivedAt;
        if(!session.bootstrapNeedsRecovery(event.raw,event.receipt))return invalid();
      }
      if(effectiveAt<last)return invalid();
      last=effectiveAt;replayed=session.acceptBootstrap(event.raw,event.receipt,hasRecovery?{raw:event.recovery!.raw,receipt:event.recovery!.receipt}:undefined);
      bootstrap=true;recovered=hasRecovery;
    }else return invalid();
    if(!isDeepStrictEqual(replayed,event))return reject('invalid-mexc-book-normalization');
    reached=session.appliedDeltas>=10;
  }
  if(hasPending){
    const pending=value.recoveryPending!;
    if(bootstrap||value.status!=='incomplete'||value.requestCount<2||!pending||Object.keys(pending).sort().join(',')!=='parsed,raw,receipt'||
      typeof pending.raw!=='string'||Buffer.byteLength(pending.raw)>524288||!pending.receipt||ackAt===null||firstDeltaAt===null||
      pending.receipt.requestedAt<Math.max(ackAt,firstDeltaAt+JOINT_BOOK_CAPTURE_LIMITS.bootstrapWarmupMs)||
      pending.receipt.receivedAt>value.endedAt||pending.receipt.receivedAt-value.socketStartedAt!>=20000||
      pending.receipt.receivedAt-value.startedAt>=25000)return invalid();
    rawBytes+=Buffer.byteLength(pending.raw);if(rawBytes>4*1024*1024)return invalid();
    const parsed=parseMexcDepthBootstrap(parsePublicJson(Buffer.from(pending.raw)),value.base,pending.receipt,session.metadata.parsed);
    if(!isDeepStrictEqual(parsed,pending.parsed)||!session.bootstrapNeedsRecovery(pending.raw,pending.receipt))return invalid();
    if(value.requestCount===2&&!['invalid-public-clock','book-capture-deadline','book-stream-timeout','book-http-unavailable'].includes(value.failure!))return invalid();
  }
  if(value.requestCount===3&&!recovered&&!hasPending)return invalid();
  if(value.failure&&/^(?:invalid-depth-commits|invalid-depth-commit-levels|depth-commits-|depth-recovery-|book-session-recovery-)/.test(value.failure)&&
    (!recoveryProfile||!(hasPending||recovered&&bootstrap&&value.failure==='book-session-recovery-conflict')||value.requestCount!==3))return invalid();
  if(value.requestCount>=2&&ackAt===null||value.appliedDeltas!==session.appliedDeltas)return invalid();
  if(value.failure==='book-bootstrap-warmup-incomplete'&&(value.requestCount!==1||value.connections!==1||
    value.subscriptions!==1||bootstrap||ackAt===null||firstDeltaAt===null||
    value.endedAt>=Math.max(ackAt,firstDeltaAt+JOINT_BOOK_CAPTURE_LIMITS.bootstrapWarmupMs)))return invalid();
  if(value.status==='complete'){
    if(!reached||!bootstrap||value.connections!==1||value.subscriptions!==1||value.requestCount!==(recovered?3:2)||value.endedAt-value.startedAt>=25000||value.endedAt-value.socketStartedAt!>=20000)return invalid();
    if(!isDeepStrictEqual(value.book,session.snapshot(value.endedAt)))return reject('invalid-mexc-book-normalization');
  }else {
    if(value.book!==null)return invalid();
    if(bootstrap&&(value.failure!.startsWith('book-http-')||value.failure==='book-response-too-large'))return invalid();
    if(reached&&!['invalid-public-clock','book-capture-deadline','book-stream-timeout','depth-book-source-time-unverified'].includes(value.failure!))return invalid();
  }
  return freeze(value);
}
