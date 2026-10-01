/** Historical byte/normalization check; not proof of exchange authenticity or a full book. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { freeze, reject } from './model.js';
import { MexcDepthStreamEvidence, STREAM_FAILURES } from './mexc-depth-stream.js';
import { MEXC_DEPTH_SOURCE_URL, type DepthSourceCapture } from './mexc-depth-source-client.js';
export const MAX_DEPTH_SOURCE_ARCHIVE_BYTES=32*1024*1024;
export const DEPTH_SOURCE_FAILURES=Object.freeze([
  'invalid-public-clock','depth-source-timeout','depth-source-unavailable','depth-source-unexpected-open',
  'depth-source-ping-budget','depth-source-before-open','depth-source-binary-message','depth-source-message-budget',
  'depth-source-time-unverified','depth-source-closed','depth-stream-schema-rejected',...STREAM_FAILURES,
]);
export function replayMexcDepthSource(bytes:Buffer,expectedSha256:string):DepthSourceCapture{
  if(bytes.length>MAX_DEPTH_SOURCE_ARCHIVE_BYTES||! /^[a-f0-9]{64}$/.test(expectedSha256)||createHash('sha256').update(bytes).digest('hex')!==expectedSha256)return reject('invalid-depth-source-archive');
  let archive:DepthSourceCapture;
  try{archive=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{return reject('invalid-depth-source-archive');}
  if(!archive||JSON.stringify(archive)+'\n'!==bytes.toString('utf8')||Object.keys(archive).sort().join(',')!==
      'acceptedDeltas,bookReconstructed,connections,endedAt,executable,failure,frames,kind,pings,schema,sourceTimeObserved,startedAt,status,subscriptions,url')return reject('invalid-depth-source-archive');
  const validTime=(n:number)=>Number.isSafeInteger(n)&&n>0&&n<=8_640_000_000_000_000;
  if(archive.schema!==1||archive.kind!=='mexc-public-depth-source'||archive.url!==MEXC_DEPTH_SOURCE_URL||
      !validTime(archive.startedAt)||!validTime(archive.endedAt)||archive.endedAt<archive.startedAt||archive.connections!==1||
      ![0,1].includes(archive.subscriptions)||![0,1].includes(archive.pings)||archive.pings>archive.subscriptions||
      !Array.isArray(archive.frames)||archive.frames.length>32||archive.bookReconstructed!==false||archive.executable!==false||
      !['complete','incomplete'].includes(archive.status)||typeof archive.sourceTimeObserved!=='boolean'||
      !Number.isInteger(archive.acceptedDeltas)||archive.acceptedDeltas<0||archive.acceptedDeltas>10||
      (archive.status==='complete'?archive.failure!==null:!DEPTH_SOURCE_FAILURES.includes(archive.failure??'')))return reject('invalid-depth-source-archive');
  if(archive.pings===1&&archive.endedAt-archive.startedAt<10_000)return reject('invalid-depth-source-archive');
  if(archive.frames.length&&archive.subscriptions!==1)return reject('invalid-depth-source-archive');
  const parser=new MexcDepthStreamEvidence();let deltas=0,last=archive.startedAt,total=0,unverified=false;
  for(const [index,frame] of archive.frames.entries()){
    if(!frame||Object.keys(frame).sort().join(',')!=='parsed,raw,receivedAt'||typeof frame.raw!=='string'||!validTime(frame.receivedAt)||
        frame.receivedAt<last||frame.receivedAt>archive.endedAt||frame.receivedAt-archive.startedAt>=20_000)return reject('invalid-depth-source-archive');
    last=frame.receivedAt;const size=Buffer.byteLength(frame.raw);total+=size;
    if(size>524288||total>4*1024*1024)return reject('invalid-depth-source-archive');
    const parsed=parser.accept(frame.raw,frame.receivedAt);
    if(!isDeepStrictEqual(parsed,frame.parsed))return reject('invalid-depth-source-normalization');
    if(parsed.kind==='delta'){
      if(parsed.sourceTimeFresh)deltas++;else{
        unverified=true;if(index!==archive.frames.length-1)return reject('invalid-depth-source-archive');
      }
      if(deltas===10&&index!==archive.frames.length-1)return reject('invalid-depth-source-archive');
    }
  }
  if(deltas!==archive.acceptedDeltas||archive.sourceTimeObserved!==(deltas>0)||
      unverified&&archive.failure!=='depth-source-time-unverified'||!unverified&&archive.failure==='depth-source-time-unverified')return reject('invalid-depth-source-archive');
  if(archive.status==='complete'&&(deltas!==10||archive.subscriptions!==1||archive.endedAt-archive.startedAt>=20_000))return reject('invalid-depth-source-archive');
  // A clock/deadline failure may occur while finalizing the tenth accepted delta.
  if(archive.status==='incomplete'&&deltas===10&&!['invalid-public-clock','depth-source-timeout'].includes(archive.failure!))return reject('invalid-depth-source-archive');
  return freeze(archive);
}
