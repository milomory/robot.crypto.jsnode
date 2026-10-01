import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { numberText, parsePublicJson, record } from '../src/market-data/exact-json.js';
import { replayJointCapture } from '../src/market-data/joint-replay.js';
const root=new URL('../fixtures/market-data/',import.meta.url);
describe('actual public joint acquisition evidence',()=>{
  it.each(['btc','eth'])('replays accepted %s joint books with four time-compatible pairs',base=>{
    const stem='joint-'+base+'-public-20261001',bytes=readFileSync(new URL(stem+'.json',root));
    const manifest=JSON.parse(readFileSync(new URL(stem+'.manifest.json',root),'utf8'));
    const r=replayJointCapture(bytes,manifest.sha256);
    expect(r).toMatchObject({status:'complete',requestCount:8,accountRequests:false,netEdgeBps:null,executable:false});
    expect(r.mexc).toMatchObject({profile:'joint-recovery-v1',status:'complete'});
    expect(r.quality.pairs.filter(p=>p.usableForComparison)).toHaveLength(4);
    expect(r.quality.markets.find(m=>m.id==='mexc-spot')?.usable).toBe(false);
    expect(r.mexc?.events.find(e=>e.kind==='bootstrap')).not.toHaveProperty('recovery');
  });
  it('retains the historically recorded merge timeout after optimization',()=>{
    const stem='joint-btc-merge-timeout-public-20261001',bytes=readFileSync(new URL(stem+'.json',root));
    const manifest=JSON.parse(readFileSync(new URL(stem+'.manifest.json',root),'utf8'));
    const r=replayJointCapture(bytes,manifest.sha256);
    expect(r.status).toBe('incomplete');expect(r.mexc).toMatchObject({failure:'book-stream-timeout',appliedDeltas:1904,book:null});
  });

  it.each(['joint-btc-version-gap-public-20261001','joint-btc-bootstrap-diagnostic-public-20261001','joint-btc-warm-gap-public-20261001'])('keeps version-gap evidence incomplete: %s',stem=>{
    const bytes=readFileSync(new URL(stem+'.json',root)),manifest=JSON.parse(readFileSync(new URL(stem+'.manifest.json',root),'utf8'));
    const r=replayJointCapture(bytes,manifest.sha256);
    expect(r).toMatchObject({status:'incomplete',requestCount:6,netEdgeBps:null});
    expect(r.mexc).toMatchObject({profile:'joint-4096',failure:'depth-book-version-discontinuity',book:null});
    expect(r.mexc?.events.some(e=>e.kind==='bootstrap')).toBe(false);
  });
  it('preserves the diagnostic raw proof that REST snapshot precedes first buffered WS version',()=>{
    const stem='joint-btc-bootstrap-diagnostic-public-20261001';
    const diagnostic=JSON.parse(readFileSync(new URL(stem+'.bootstrap.json',root),'utf8'));
    const snapshotVersion=BigInt(numberText(record(record(parsePublicJson(Buffer.from(diagnostic.bootstrap.raw))).data).version));
    const r=JSON.parse(readFileSync(new URL(stem+'.json',root),'utf8'));
    const first=BigInt(r.mexc.events.find((e:any)=>e.kind==='frame'&&e.parsed.kind==='delta').parsed.version);
    expect(snapshotVersion).toBe(42267265960n);expect(first).toBe(42267265967n);expect(first>snapshotVersion+1n).toBe(true);
    expect(diagnostic.extraRequests).toBe(0);expect(diagnostic.diagnosticOnly).toBe(true);
  });
  it('preserves the historical 256-frame burst failure without upgrading it to success',()=>{
    const bytes=readFileSync(new URL('joint-btc-frame-limit-public-20261001.json',root));
    const manifest=JSON.parse(readFileSync(new URL('joint-btc-frame-limit-public-20261001.manifest.json',root),'utf8'));
    const r=replayJointCapture(bytes,manifest.sha256);
    expect(r).toMatchObject({status:'incomplete',requestCount:6,failure:'joint-mexc-incomplete',netEdgeBps:null,executable:false});
    expect(r.mexc).toMatchObject({failure:'book-stream-frame-budget',appliedDeltas:0,book:null});
    expect(r.mexc).not.toHaveProperty('profile');
    expect(r.mexc?.events.filter(e=>e.kind==='frame')).toHaveLength(256);
    expect(r.quality.pairs.every(p=>!p.usableForComparison)).toBe(true);
  });
});
