/** Offline validation of raw observations, acquisition order, budgets and common-time quality. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { freeze, market, reject } from './model.js';
import { replayMexcBook } from './mexc-book-replay.js';
import { JOINT_FAILURES, JOINT_LIMITS, JOINT_ROUTES, jointResult, jointUrl, normalizeJointRead, type JointCapture, type JointRead } from './joint-observation.js';
const fail=():never=>reject('invalid-joint-archive');
const validTime=(at:number)=>Number.isSafeInteger(at)&&at>0&&at<=8_640_000_000_000_000;
const keys=(value:object,expected:string)=>Object.keys(value).sort().join(',')===expected;
export function replayJointCapture(bytes:Buffer,expectedSha256:string):JointCapture {
  if(bytes.length>JOINT_LIMITS.maximumArchiveBytes||! /^[a-f0-9]{64}$/.test(expectedSha256)||createHash('sha256').update(bytes).digest('hex')!==expectedSha256)return fail();
  let value:JointCapture;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{return fail();}
  if(!value||JSON.stringify(value)+'\n'!==bytes.toString('utf8')||!keys(value,'accountRequests,base,endedAt,executable,failure,kind,mexc,netEdgeBps,quality,reads,requestCount,schema,startedAt,status'))return fail();
  market('mexc',value.base);
  if(value.schema!==1||value.kind!=='joint-public-books'||!validTime(value.startedAt)||!validTime(value.endedAt)||value.endedAt<value.startedAt||
    value.accountRequests!==false||value.executable!==false||value.netEdgeBps!==null||!['complete','incomplete'].includes(value.status)||
    !Array.isArray(value.reads)||value.reads.length>6||value.reads.length===5||
    (value.status==='complete'?value.failure!==null:!JOINT_FAILURES.includes(value.failure??'')))return fail();
  let last=value.startedAt,rawBytes=0;const reads:JointRead[]=[];
  for(let i=0;i<value.reads.length;i++){
    const r=value.reads[i];
    if(!r||!keys(r,Object.hasOwn(r,'notDispatched')?'endedAt,failure,notDispatched,observation,requestedAt,route':'endedAt,failure,observation,requestedAt,route')||r.route!==JOINT_ROUTES[i]||!validTime(r.requestedAt)||!validTime(r.endedAt)||
      r.requestedAt<last||r.endedAt<r.requestedAt||r.endedAt>value.endedAt||r.requestedAt-value.startedAt>=JOINT_LIMITS.captureTimeoutMs)return fail();
    if(i===4){if(!value.mexc||value.mexc.status!=='complete'||r.requestedAt<value.mexc.endedAt)return fail();}
    if(i===5&&r.requestedAt!==value.reads[4].requestedAt)return fail();
    if(Object.hasOwn(r,'notDispatched')&&(r.notDispatched!==true||r.observation!==null||
      !['joint-capture-deadline','invalid-public-clock','joint-peer-failed'].includes(r.failure??'')||
      r.failure==='joint-capture-deadline'&&r.endedAt-value.startedAt<JOINT_LIMITS.captureTimeoutMs))return fail();
    const o=r.observation;
    if(o===null){
      if(!JOINT_FAILURES.includes(r.failure??'')||r.failure==='joint-mexc-incomplete'||i<4&&i!==value.reads.length-1||value.status!=='incomplete')return fail();
      if(i<4&&r.failure==='joint-peer-failed')return fail();
    }else{
      if(r.failure!==null||!o||!keys(o,'parsed,raw,receipt')||typeof o.raw!=='string'||Buffer.byteLength(o.raw)>JOINT_LIMITS.maximumResponseBytes||
        o.receipt?.url!==jointUrl(value.base,r.route)||o.receipt.requestedAt!==r.requestedAt||o.receipt.receivedAt!==r.endedAt||
        r.endedAt-value.startedAt>=JOINT_LIMITS.captureTimeoutMs)return fail();
      rawBytes+=Buffer.byteLength(o.raw);
      const parsed=normalizeJointRead(value.base,r.route,o.raw,o.receipt,reads);
      if(!isDeepStrictEqual(parsed,o.parsed))return reject('joint-normalization-mismatch');
    }
    reads.push(r);if(i<4)last=r.endedAt;
  }
  const finalFailures=reads.slice(4).filter(r=>r.failure&&r.failure!=='joint-peer-failed');
  if(finalFailures.length){
    const firstFailureAt=Math.min(...finalFailures.map(r=>r.endedAt));
    if(reads.slice(4).some(r=>r.observation!==null&&r.endedAt>firstFailureAt||r.failure==='joint-peer-failed'&&r.endedAt<firstFailureAt))return fail();
  }
  let mexc=null;
  if(value.mexc!==null){
    if(reads.length<4||reads.slice(0,4).some(r=>r.failure)||value.mexc.base!==value.base||value.mexc.startedAt<last||value.mexc.endedAt>value.endedAt||
      value.mexc.startedAt-value.startedAt>=JOINT_LIMITS.captureTimeoutMs)return fail();
    const nested=Buffer.from(JSON.stringify(value.mexc)+'\n');mexc=replayMexcBook(nested,createHash('sha256').update(nested).digest('hex'));
    // The nested reader also has an outer deadline. Its own 25s budget cannot
    // authorize accepted metadata/WS events after the joint capture has expired.
    const beforeJointDeadline=(at:number)=>at-value.startedAt<JOINT_LIMITS.captureTimeoutMs;
    if(mexc.metadata&&!beforeJointDeadline(mexc.metadata.receipt.receivedAt)||
      mexc.recoveryPending&&!beforeJointDeadline(mexc.recoveryPending.receipt.receivedAt)||
      mexc.socketStartedAt!==null&&!beforeJointDeadline(mexc.socketStartedAt)||
      mexc.socketOpenedAt!==null&&!beforeJointDeadline(mexc.socketOpenedAt)||
      mexc.events.some(event=>!beforeJointDeadline(event.kind==='frame'?event.receivedAt:event.recovery?.receipt.receivedAt??event.receipt.receivedAt))||
      mexc.status==='complete'&&!beforeJointDeadline(mexc.endedAt))return fail();
    // An incomplete finish may occur later; only its already accepted prefix is
    // replay evidence, and timeout/error reporting is not a new market event.
    rawBytes+=Buffer.byteLength(mexc.metadata?.raw??'')+Buffer.byteLength(mexc.recoveryPending?.raw??'')+mexc.events.reduce((n,e)=>n+Buffer.byteLength(e.raw)+(e.kind==='bootstrap'&&e.recovery?Buffer.byteLength(e.recovery.raw):0),0);
  }
  if(rawBytes>JOINT_LIMITS.maximumRawBytes||value.requestCount!==reads.filter(r=>!r.notDispatched).length+(mexc?.requestCount??0)||value.requestCount>JOINT_LIMITS.maximumRequests)return fail();
  if(value.status==='complete'){
    if(reads.length!==6||reads.some(r=>r.failure)||mexc?.status!=='complete'||value.endedAt-value.startedAt>=JOINT_LIMITS.captureTimeoutMs)return fail();
  }else{
    const failed=reads.filter(r=>r.failure);
    if(failed.length){
      const root=failed.find(r=>r.failure!=='joint-peer-failed');
      if(!root||value.failure!==root.failure)return fail();
    }else if(mexc?.status==='incomplete'){
      if(!['joint-mexc-incomplete','joint-capture-deadline'].includes(value.failure!)||reads.length!==4)return fail();
    }else if(!['invalid-public-clock','joint-capture-deadline'].includes(value.failure!))return fail();
  }
  if(value.failure==='joint-capture-deadline'&&value.endedAt-value.startedAt<JOINT_LIMITS.captureTimeoutMs)return fail();
  const rebuilt=jointResult(value.base,value.startedAt,value.endedAt,reads,mexc,value.failure);
  if(!isDeepStrictEqual(value,rebuilt))return reject('joint-normalization-mismatch');
  return freeze(rebuilt);
}
