/** Verify internal archive integrity and replay original receipt times. Not source authentication. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parsePublicJson, timestamp } from './exact-json.js';
import { freeze, reject } from './model.js';
import { assertObservationReceipt, observationPlan, type Route } from './observation-model.js';
import { normalizeObservation, observationQuality, OBSERVATION_FAILURES, type D0bCapture, type D0bObservation } from './observations-client.js';
const MAX_ARCHIVE_BYTES=32*1024*1024;
function keys(value:unknown, names:readonly string[]):asserts value is Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==[...names].sort().join(','))return reject('invalid-observation-archive');
}
function time(value:unknown):number{if(typeof value!=='number'||timestamp(String(value))!==value)return reject('invalid-observation-archive');return value;}
function route(value:unknown, expected:Route):void{
  keys(value,['exchange','base','kind']);if(!isDeepStrictEqual(value,expected))return reject('invalid-observation-archive');
}
export function replayObservationArchive(bytes:Uint8Array, expectedSha256:string):D0bCapture{
  try{
    if(bytes.byteLength>MAX_ARCHIVE_BYTES||!(/^[0-9a-f]{64}$/).test(expectedSha256)||createHash('sha256').update(bytes).digest('hex')!==expectedSha256)return reject('invalid-observation-archive');
    const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
    const input:unknown=JSON.parse(text);
    // Writer format is compact canonical JSON plus exactly one LF. This also rejects
    // duplicate outer keys, noncanonical/rounded numeric tokens and hidden suffixes.
    if(JSON.stringify(input)+'\n'!==text)return reject('invalid-observation-archive');
    keys(input,['schema','kind','startedAt','endedAt','requestCount','status','observations','failures','quality','executable','accountRequests','feesVerified','netEdgeBps']);
    if(input.schema!==1||input.kind!=='derivatives-public-d0b'||input.executable!==false||input.accountRequests!==false||input.feesVerified!==false||input.netEdgeBps!==null||
       !Array.isArray(input.observations)||!Array.isArray(input.failures)||!Array.isArray(input.quality)||
       typeof input.requestCount!=='number'||!Number.isSafeInteger(input.requestCount)||input.requestCount<0||input.requestCount>24)return reject('invalid-observation-archive');
    const start=time(input.startedAt),end=time(input.endedAt),plan=observationPlan(),observations:D0bObservation[]=[];
    if(end<start||input.observations.length>24)return reject('invalid-observation-archive');
    if(input.status==='complete'){
      if(input.observations.length!==24||input.requestCount!==24||input.failures.length!==0||end-start>=125000)return reject('invalid-observation-archive');
    }else if(input.status==='incomplete'){
      if(input.failures.length!==1||input.requestCount<input.observations.length||input.requestCount>input.observations.length+1)return reject('invalid-observation-archive');
      const failure=input.failures[0];keys(failure,['route','reason']);
      if(typeof failure.reason!=='string'||!OBSERVATION_FAILURES.includes(failure.reason))return reject('invalid-observation-archive');
      if(input.observations.length===24&&!['invalid-public-clock','public-capture-deadline'].includes(failure.reason))return reject('invalid-observation-archive');
      if(input.requestCount===input.observations.length&&!['invalid-public-clock','public-capture-deadline'].includes(failure.reason))return reject('invalid-observation-archive');
      // A suspended process may resume after its deadline with an HTTP/timeout failure.
      // Retain the original failure and overrun duration as incomplete evidence; only
      // successful observations and complete reports must fit the capture deadline.
      route(failure.route,plan[Math.min(input.observations.length,23)]);
    }else reject('invalid-observation-archive');
    let previous=start;
    for(let index=0;index<input.observations.length;index++){
      const row=input.observations[index];keys(row,['route','receipt','raw','parsed']);route(row.route,plan[index]);
      keys(row.receipt,['url','requestedAt','receivedAt']);
      const receipt={url:row.receipt.url as string,requestedAt:time(row.receipt.requestedAt),receivedAt:time(row.receipt.receivedAt)};
      assertObservationReceipt(receipt,plan[index]);
      if(receipt.requestedAt<previous||receipt.receivedAt>end||receipt.receivedAt-start>=125000||typeof row.raw!=='string')return reject('invalid-observation-archive');
      const parsed=normalizeObservation(parsePublicJson(Buffer.from(row.raw,'utf8')),plan[index],receipt,observations);
      if(!isDeepStrictEqual(parsed,row.parsed))return reject('invalid-observation-archive');
      observations.push({route:{...plan[index]},receipt,raw:row.raw,parsed});previous=receipt.receivedAt;
    }
    const quality=observationQuality(observations);
    if(!isDeepStrictEqual(quality,input.quality))return reject('invalid-observation-archive');
    return freeze({...input,observations,quality}) as unknown as D0bCapture;
  }catch{return reject('invalid-observation-archive');}
}
