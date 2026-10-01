import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {decimal,multiply,parsePublicJson,record,timestamp,units} from '../src/market-data/exact-json.js';
import {integerText,type BookLevel} from '../src/market-data/observation-model.js';
import {MexcBookSession,type MexcBookCapture} from '../src/market-data/mexc-book-session.js';

const path=new URL('../fixtures/market-data/joint-btc-merge-timeout-public-20261001.json',import.meta.url);
const expectedSha='2d7fc542b4ba71d74dec1784d48e95bc6e7c7fbf54c2462bc25a88e34983d47b';

describe('large buffered MEXC merge retains exact historical output',()=>{
  it('matches an independent raw-price map through 1904 updates without rewriting the recorded timeout',()=>{
    const bytes=readFileSync(path);expect(createHash('sha256').update(bytes).digest('hex')).toBe(expectedSha);
    const archive=JSON.parse(bytes.toString('utf8')) as {status:string;mexc:MexcBookCapture};
    const capture=archive.mexc,bootstrap=capture.events.find(e=>e.kind==='bootstrap');
    expect(archive.status).toBe('incomplete');expect(capture).toMatchObject({status:'incomplete',failure:'book-stream-timeout',appliedDeltas:1904,book:null});
    if(!capture.metadata||!bootstrap||bootstrap.kind!=='bootstrap')throw Error('missing pinned public evidence');
    expect(bootstrap.recovery).toBeUndefined();
    const session=new MexcBookSession(capture.base,capture.metadata.raw,capture.metadata.receipt);
    let evaluatedAt=capture.metadata.receipt.receivedAt;
    for(const event of capture.events){
      if(event.kind==='frame'){session.acceptFrame(event.raw,event.receivedAt);evaluatedAt=Math.max(evaluatedAt,event.receivedAt);}
      else{session.acceptBootstrap(event.raw,event.receipt);evaluatedAt=Math.max(evaluatedAt,event.receipt.receivedAt);}
    }
    // This is a historical state check at captured input time, not a fresh live capture.
    const result=session.snapshot(evaluatedAt),raw=record(record(parsePublicJson(Buffer.from(bootstrap.raw))).data);
    const basePerContract=session.metadata.parsed.basePerContract;
    const level=(value:unknown):BookLevel=>{
      if(!Array.isArray(value)||value.length!==3)throw Error('invalid pinned raw level');
      const price=decimal(value[0]),quantityContracts=decimal(value[1]);
      return {price,quantityContracts,quantityBase:multiply(quantityContracts,basePerContract),orderCount:integerText(value[2])};
    };
    const rows=(value:unknown)=>{if(!Array.isArray(value))throw Error('invalid pinned side');return value.map(level);};
    const bids=new Map(rows(raw.bids).map(row=>[row.price,row])),asks=new Map(rows(raw.asks).map(row=>[row.price,row]));
    const floor=units([...bids.values()].at(-1)!.price),ceiling=units([...asks.values()].at(-1)!.price);
    const initialVersion=BigInt(integerText(raw.version));let version=initialVersion,updates=0,lastSourceAt=0,lastReceivedAt=0;
    for(const event of capture.events){
      if(event.kind!=='frame')continue;const payload=record(parsePublicJson(Buffer.from(event.raw)));if(payload.channel!=='push.depth')continue;
      const data=record(payload.data),next=BigInt(integerText(data.version));if(next<=initialVersion)continue;
      expect(next).toBe(version+1n);version=next;updates++;
      for(const side of ['bids','asks'] as const)for(const row of rows(data[side])){
        const price=units(row.price);if(side==='bids'?price<floor:price>ceiling)continue;
        const map=side==='bids'?bids:asks;if(row.quantityContracts==='0')map.delete(row.price);else map.set(row.price,row);
      }
      lastSourceAt=timestamp(data.cts);lastReceivedAt=event.receivedAt;
    }
    const sorted=(map:Map<string,BookLevel>,side:'bids'|'asks')=>[...map.values()].sort((a,b)=>
      (units(a.price)<units(b.price)?-1:units(a.price)>units(b.price)?1:0)*(side==='bids'?-1:1)).slice(0,50);
    expect(updates).toBe(1904);expect(session.appliedDeltas).toBe(updates);
    expect(result.bids).toEqual(sorted(bids,'bids'));expect(result.asks).toEqual(sorted(asks,'asks'));
    expect(result).toMatchObject({version:String(version),receivedAt:lastReceivedAt,evaluatedAt,appliedUpdates:updates,
      knownLevels:{bids:bids.size,asks:asks.size},verifiedDepth:50,entireBookKnown:false,executable:false,
      sourceTime:{at:lastSourceAt,ageMs:evaluatedAt-lastSourceAt,meaning:'matching-engine-book-production'}});
    expect(createHash('sha256').update(readFileSync(path)).digest('hex')).toBe(expectedSha);
  });
});
