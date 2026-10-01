import { describe, expect, it } from 'vitest';
import { parsePublicJson } from '../src/market-data/exact-json.js';
import { parseMexcInstrument } from '../src/market-data/mexc.js';
import { market, publicUrl, type InstrumentSpec, type PublicReceipt, type ResearchBase } from '../src/market-data/model.js';
import { MexcDepthBook, mexcDepthBootstrapUrl, parseMexcDepthBootstrap } from '../src/market-data/mexc-depth-book.js';
import { MexcDepthStreamEvidence, type MexcDepthStreamDelta } from '../src/market-data/mexc-depth-stream.js';
import { DEPTH_RECOVERY_FAILURES, MEXC_DEPTH_RECOVERY_LIMITS, bridgeMexcBootstrap, mexcDepthCommitsUrl, parseMexcDepthCommits,
  type MexcDepthCommits } from '../src/market-data/mexc-depth-recovery.js';

// Synthetic exact public shapes only; no network, account state or source-time claims.
const at=1_800_000_000_000, version=9007199254740993n;
const decode=(raw:unknown)=>parsePublicJson(Buffer.from(JSON.stringify(raw)));
const metadataReceipt=(base:ResearchBase='BTC'):PublicReceipt=>({url:publicUrl('mexc',base,'instrument'),requestedAt:at,receivedAt:at+100});
const snapshotReceipt=(base:ResearchBase='BTC'):PublicReceipt=>({url:mexcDepthBootstrapUrl(base),requestedAt:at+110,receivedAt:at+200});
const receipt=(base:ResearchBase='BTC'):PublicReceipt=>({url:mexcDepthCommitsUrl(base),requestedAt:at+300,receivedAt:at+400});
function spec(base:ResearchBase='BTC',tick='0.1'):InstrumentSpec {
  return parseMexcInstrument(decode({success:true,code:0,data:{symbol:`${base}_USDT`,baseCoin:base,quoteCoin:'USDT',settleCoin:'USDT',
    futureType:1,type:1,state:0,automaticDelivery:0,apiAllowed:true,preMarket:false,contractSize:base==='BTC'?'0.0001':'0.01',
    volUnit:1,minVol:1,priceUnit:tick}}),base,metadataReceipt(base));
}
function bootstrap(base:ResearchBase='BTC',count=60,s=spec(base)){
  return parseMexcDepthBootstrap(decode({success:true,code:0,data:{symbol:`${base}_USDT`,version:String(version),timestamp:at+190,cts:at+189,
    bids:Array.from({length:count},(_,i)=>[2000-i,3,1]),asks:Array.from({length:count},(_,i)=>[2001+i,5,2])}}),base,snapshotReceipt(base),s);
}
const row=(offset:number,patch:Record<string,unknown>={})=>({version:String(version+BigInt(offset)),bids:[['2000','7','2']],asks:[],...patch});
const raw=(rows:unknown=[row(1)])=>decode({success:true,code:0,data:rows});
const commits=(rows:unknown=[row(1)],base:ResearchBase='BTC',s=spec(base))=>parseMexcDepthCommits(raw(rows),base,receipt(base),s);
const target=(offset=1)=>String(version+BigInt(offset));
const unsafe=(value:unknown)=>value as MexcDepthCommits;

 describe('fixed public depth commits parser',()=>{
  it.each(['BTC','ETH'] as const)('binds exact %s URL, metadata and commit fields without inventing cts',base=>{
    const result=commits([row(1)],base);
    expect(mexcDepthCommitsUrl(base)).toBe(`https://api.mexc.com/api/v1/contract/depth_commits/${base}_USDT/1000`);
    expect(result).toEqual({schema:1,kind:'mexc-depth-commits',market:market('mexc',base),receipt:receipt(base),metadataReceivedAt:at+100,
      commits:[{version:target(),bids:[{price:'2000',quantityContracts:'7',orderCount:'2',action:'set'}],asks:[]}],
      sourceFreshnessVerified:false,executable:false});
    expect(Object.hasOwn(result,'sourceTime')).toBe(false);expect(Object.hasOwn(result.commits[0],'cts')).toBe(false);
  });
  it('normalizes both documented monotonic orders to the same ascending commits',()=>{
    const ascending=[row(1),row(2),row(3)];expect(commits(ascending)).toEqual(commits([...ascending].reverse()));
  });
  it('preserves exact version and quantities larger than IEEE-safe integers',()=>{
    const result=commits([row(1,{bids:[['2000','9007199254740993','9007199254740995']]})]);
    expect(result.commits[0]).toMatchObject({version:'9007199254740994',bids:[{quantityContracts:'9007199254740993',orderCount:'9007199254740995'}]});
  });
  it('accepts numeric JSON tokens without converting through Number',()=>{
    const bytes=Buffer.from('{"success":true,"code":0,"data":[{"version":9007199254740994,"bids":[[2000,9007199254740993,1]],"asks":[]}]}');
    expect(parseMexcDepthCommits(parsePublicJson(bytes),'BTC',receipt(),spec()).commits[0].bids[0].quantityContracts).toBe('9007199254740993');
  });
  it('normalizes quantity zero to delete and leaves independent bid/ask ordering unchanged',()=>{
    const result=commits([row(1,{bids:[['2000','0','0'],['1999','1','2']],asks:[['2002','3','1'],['2001','0','0']]})]);
    expect(result.commits[0].bids[0].action).toBe('delete');expect(result.commits[0].asks[1].action).toBe('delete');
  });
  it.each([[],null,{},[row(1),row(1)],[row(1),row(3),row(2)],[row(3),row(1),row(2)],[row(1,{bids:[],asks:[]})]])('rejects missing/duplicate/mixed/empty commits %j',rows=>{
    expect(()=>commits(rows)).toThrow();
  });
  it('accepts gaps in the response only as raw evidence; bridge will require the exact selected contiguous range',()=>{
    expect(commits([row(-1),row(1),row(3)]).commits).toHaveLength(3);
  });
  it('accepts exactly 1000 commits and rejects 1001',()=>{
    expect(commits(Array.from({length:1000},(_,i)=>row(i+1))).commits).toHaveLength(1000);
    expect(()=>commits(Array.from({length:1001},(_,i)=>row(i+1)))).toThrow('invalid-depth-commits');
  });
  it('accepts exactly 2000 updates on a side and rejects 2001',()=>{
    const levels=Array.from({length:2000},(_,i)=>[String(i+1),'1','1']);
    expect(commits([row(1,{bids:levels})]).commits[0].bids).toHaveLength(2000);
    expect(()=>commits([row(1,{bids:[...levels,['2001','1','1']]})])).toThrow('invalid-depth-commit-levels');
  });
  it.each([
    [['0','1','1']],[['2000','-1','1']],[['2000','1.5','1']],[['2000.01','1','1']],
    [['2000','1','-1']],[['2000','1','1.5']],[['2000','1']],[['2000','1','1','extra']],
    [['2000','1','1'],['2000.0','2','1']],null,{},[null],
  ])('rejects malformed, duplicate or off-grid commit levels %j',bids=>{
    expect(()=>commits([row(1,{bids})])).toThrow();
  });
  it('rejects native Number amounts when callers bypass exact JSON decoding',()=>{
    expect(()=>parseMexcDepthCommits({success:true,code:'0',data:[{version:target(),bids:[[2000,'1','1']],asks:[]}]},'BTC',receipt(),spec())).toThrow('invalid-public-number');
  });
  it.each(['-1','1.5','01','1e3','1000000000000000000000000000000',null])('rejects invalid version %s',v=>{
    expect(()=>commits([row(1,{version:v})])).toThrow();
  });
  it.each([
    {url:mexcDepthCommitsUrl('ETH')},{url:'https://example.invalid/'},{url:'https://api.mexc.com/api/v1/contract/depth_commits/BTC_USDT/100'},
    {requestedAt:at+401},{receivedAt:at+3301},{requestedAt:0},{receivedAt:NaN},{extra:true},
  ])('rejects invalid fixed receipt %j',patch=>{
    expect(()=>parseMexcDepthCommits(raw(),'BTC',{...receipt(),...patch},spec())).toThrow();
  });
  it('accepts the three-second request boundary exactly',()=>{
    expect(parseMexcDepthCommits(raw(),'BTC',{...receipt(),receivedAt:at+3300},spec()).receipt.receivedAt).toBe(at+3300);
  });
  it('accepts metadata exactly 20 minutes old and rejects one ms more',()=>{
    const r={...receipt(),requestedAt:at+100+1_200_000,receivedAt:at+100+1_200_100};
    expect(parseMexcDepthCommits(raw(),'BTC',r,spec()).metadataReceivedAt).toBe(at+100);
    expect(()=>parseMexcDepthCommits(raw(),'BTC',{...r,requestedAt:r.requestedAt+1},spec())).toThrow('observation-spec-mismatch');
  });
  it.each([
    ()=>spec('ETH'),()=>({...spec(),basePerContract:'0.001'}),()=>({...spec(),quantityStepContracts:'0.0'}),
    ()=>({...spec(),receipt:{...metadataReceipt(),receivedAt:at+301}}),
  ])('rejects mismatched or malformed metadata',make=>{
    expect(()=>parseMexcDepthCommits(raw(),'BTC',receipt(),make())).toThrow();
  });
  it('rejects an echoed wrong symbol at either response or commit level',()=>{
    expect(()=>parseMexcDepthCommits(decode({success:true,code:0,symbol:'ETH_USDT',data:[row(1)]}),'BTC',receipt(),spec())).toThrow('unsupported-public-contract');
    expect(()=>commits([row(1,{symbol:'ETH_USDT'})])).toThrow('unsupported-public-contract');
  });
  it('rejects failed envelopes and freezes copied evidence without mutating a caller receipt',()=>{
    expect(()=>parseMexcDepthCommits(decode({success:false,code:0,data:[row(1)]}),'BTC',receipt(),spec())).toThrow('invalid-public-response');
    const r=receipt(),result=parseMexcDepthCommits(raw(),'BTC',r,spec());r.receivedAt++;
    expect(result.receipt.receivedAt).toBe(at+400);
    for(const x of [result,result.market,result.receipt,result.commits,result.commits[0],result.commits[0].bids[0]])expect(Object.isFrozen(x)).toBe(true);
  });
 });

describe('bounded initial snapshot bridge without timestamp promotion',()=>{
  it.each(['BTC','ETH'] as const)('bridges exactly six missing %s versions and retains original receipt/system timestamps',base=>{
    const before=bootstrap(base),result=bridgeMexcBootstrap(before,commits(Array.from({length:6},(_,i)=>row(i+1)),base),target(6),spec(base));
    expect(result).toMatchObject({version:target(6),receipt:before.receipt,sourceTime:before.sourceTime,auxiliaryTimestamp:before.auxiliaryTimestamp,
      metadataReceivedAt:before.metadataReceivedAt,sourceFreshnessVerified:false,bookReconstructed:false,executable:false});
    expect(result.bids[0]).toEqual({price:'2000',quantityContracts:'7',quantityBase:base==='BTC'?'0.0007':'0.07',orderCount:'2'});
    expect(result.knownRange).toEqual(before.knownRange);expect(result.bids).toHaveLength(60);
    const book=new MexcDepthBook(spec(base),result);expect(()=>book.snapshot(at+500)).toThrow('depth-book-no-update');
    const liveBook=new MexcDepthBook(spec(base),result);
    const delta=new MexcDepthStreamEvidence(base).accept(JSON.stringify({channel:'push.depth',symbol:`${base}_USDT`,ts:at+490,
      data:{version:target(7),cts:at+480,bids:[['2000','8','1']],asks:[]}}),at+500) as MexcDepthStreamDelta;
    expect(liveBook.apply(delta)).toBe(true);expect(liveBook.snapshot(at+510)).toMatchObject({version:target(7),appliedUpdates:1,
      sourceTime:{at:at+480,meaning:'matching-engine-book-production'},sourceFreshnessVerified:true});
  });
  it('ignores older and future commits rather than applying beyond target',()=>{
    const result=bridgeMexcBootstrap(bootstrap(),commits([row(-1,{bids:[['2000','8','1']]}),row(1),row(2,{bids:[['2000','9','1']]})]),target(),spec());
    expect(result.bids[0].quantityContracts).toBe('7');expect(result.version).toBe(target());
  });
  it.each([0,-1,1001])('rejects a target outside the initial 1..1000 version span: %i',offset=>{
    expect(()=>bridgeMexcBootstrap(bootstrap(),commits(),target(offset),spec())).toThrow('depth-recovery-invalid-target');
  });
  it.each(['1.5','-1','NaN','01'])('rejects noncanonical target %s',v=>{
    expect(()=>bridgeMexcBootstrap(bootstrap(),commits(),v,spec())).toThrow();
  });
  it('bridges exactly 1000 versions without a guessed jump',()=>{
    expect(bridgeMexcBootstrap(bootstrap(),commits(Array.from({length:1000},(_,i)=>row(i+1))),target(1000),spec()).version).toBe(target(1000));
  });
  it.each([[row(2)],[row(1),row(3)],[row(1)]].map(rows=>({rows})))('rejects any missing version in the requested bridge $rows',({rows})=>{
    expect(()=>bridgeMexcBootstrap(bootstrap(),commits(rows),target(3),spec())).toThrow('depth-recovery-missing-version');
  });
  it('applies absolute quantities and deletes, rather than adding update quantities',()=>{
    const result=bridgeMexcBootstrap(bootstrap(),commits([row(1,{bids:[['2000','10','2']]}),row(2,{bids:[['2000','2','1'],['1999','0','0']]})]),target(2),spec());
    expect(result.bids[0].quantityContracts).toBe('2');expect(result.bids.some(x=>x.price==='1999')).toBe(false);
  });
  it('applies both sides of one commit atomically before checking crossing',()=>{
    const result=bridgeMexcBootstrap(bootstrap(),commits([row(1,{bids:[['2001','1','1']],asks:[['2001','0','0'],['2001.1','2','1']]})]),target(),spec());
    expect(result.bids[0].price).toBe('2001');expect(result.asks[0].price).toBe('2001.1');
  });
  it('rejects a crossed committed state even if a later commit would fix it',()=>{
    expect(()=>bridgeMexcBootstrap(bootstrap(),commits([row(1,{bids:[['2001','1','1']]}),row(2,{bids:[['2001','0','0']]})]),target(2),spec())).toThrow('crossed-public-book');
  });
  it('ignores out-of-range inserts and does not use them to refill known depth',()=>{
    const before=bootstrap(),result=bridgeMexcBootstrap(before,commits([row(1,{bids:[['1940','100','1']],asks:[['2061','100','1']]})]),target(),spec());
    expect(result.knownRange).toEqual(before.knownRange);expect(result.bids).toEqual(before.bids);expect(result.asks).toEqual(before.asks);
    const s=bootstrap('BTC',50);
    expect(()=>bridgeMexcBootstrap(s,commits([row(1,{bids:[['2000','0','0'],['1900','100','1']]})]),target(),spec())).toThrow('depth-book-range-exhausted');
  });
  it('narrows the known range when its original boundary levels are removed',()=>{
    const result=bridgeMexcBootstrap(bootstrap(),commits([row(1,{bids:[['1941','0','0']],asks:[['2060','0','0']]})]),target(),spec());
    expect(result.knownRange).toEqual({bidFloor:'1942',askCeiling:'2059'});
  });
  it('retains closest 1000 levels and narrows the range after in-range insertion',()=>{
    const s=spec('BTC','0.1'),before=bootstrap('BTC',1000,s);
    const result=bridgeMexcBootstrap(before,commits([row(1,{bids:[['1999.9','2','1']],asks:[['2001.1','2','1']]})],'BTC',s),target(),s);
    expect(result.bids).toHaveLength(1000);expect(result.asks).toHaveLength(1000);
    expect(result.knownRange).toEqual({bidFloor:'1002',askCeiling:'2999'});
    expect(result.bids.some(x=>x.price==='1999.9')).toBe(true);expect(result.asks.some(x=>x.price==='2001.1')).toBe(true);
  });
  it('enforces the 10000-level internal capacity before truncating the derived snapshot',()=>{
    const s=spec('BTC','0.0001'),before=bootstrap('BTC',1000,s);
    const rowsFor=(count:number)=>{
      const updates=Array.from({length:count},(_,i)=>['1500.'+String(i+1).padStart(4,'0'),'1','1']);
      return Array.from({length:Math.ceil(count/2000)},(_,i)=>row(i+1,{bids:updates.slice(i*2000,(i+1)*2000)}));
    };
    const accepted=parseMexcDepthCommits({success:true,code:'0',data:rowsFor(9000)},'BTC',receipt(),s);
    expect(bridgeMexcBootstrap(before,accepted,target(5),s).bids).toHaveLength(1000);
    const excessive=parseMexcDepthCommits({success:true,code:'0',data:rowsFor(9001)},'BTC',receipt(),s);
    expect(()=>bridgeMexcBootstrap(before,excessive,target(5),s)).toThrow('depth-book-capacity-exceeded');
  });
  it('rejects recovery whose request preceded the original snapshot receipt',()=>{
    const value=parseMexcDepthCommits(raw(),'BTC',{...receipt(),requestedAt:at+199},spec());
    expect(()=>bridgeMexcBootstrap(bootstrap(),value,target(),spec())).toThrow('depth-recovery-timing');
  });
  it.each([
    {executable:true},{sourceFreshnessVerified:true},{metadataReceivedAt:at+101},{kind:'other'},
    {market:market('mexc','ETH')},{extra:true},
  ])('revalidates normalized commits against tampering %j',patch=>{
    expect(()=>bridgeMexcBootstrap(bootstrap(),unsafe({...commits(),...patch}),target(),spec())).toThrow('invalid-depth-commits-normalization');
  });
  it('rejects forged normalized actions even though numeric fields would otherwise be valid',()=>{
    const value=structuredClone(commits());value.commits[0].bids[0].action='delete';
    expect(()=>bridgeMexcBootstrap(bootstrap(),value,target(),spec())).toThrow('invalid-depth-commits-normalization');
  });
  it('revalidates original bootstrap amounts and all existing safety flags',()=>{
    const value=structuredClone(bootstrap());value.bids[0].quantityBase='999';
    expect(()=>bridgeMexcBootstrap(value,commits(),target(),spec())).toThrow('invalid-depth-bootstrap');
    expect(()=>bridgeMexcBootstrap({...bootstrap(),sourceFreshnessVerified:true} as never,commits(),target(),spec())).toThrow('invalid-depth-bootstrap');
  });
  it('leaves caller evidence untouched on success and on a later crossing failure',()=>{
    const before=structuredClone(bootstrap()),evidence=structuredClone(commits()),a=structuredClone(before),b=structuredClone(evidence);
    const result=bridgeMexcBootstrap(before,evidence,target(),spec());expect(before).toEqual(a);expect(evidence).toEqual(b);
    expect(Object.isFrozen(result)).toBe(true);expect(Object.isFrozen(result.bids[0])).toBe(true);
    const failing=commits([row(1),row(2,{bids:[['2001','1','1']]})]);
    expect(()=>bridgeMexcBootstrap(before,failing,target(2),spec())).toThrow('crossed-public-book');expect(before).toEqual(a);
  });
  it('exports immutable bounded limits and a unique closed error list',()=>{
    expect(Object.isFrozen(MEXC_DEPTH_RECOVERY_LIMITS)).toBe(true);expect(Object.isFrozen(DEPTH_RECOVERY_FAILURES)).toBe(true);
    expect(new Set(DEPTH_RECOVERY_FAILURES).size).toBe(DEPTH_RECOVERY_FAILURES.length);
    expect(MEXC_DEPTH_RECOVERY_LIMITS).toMatchObject({maximumCommits:1000,maximumUpdatesPerSide:2000,requestTimeoutMs:3000,maximumKnownLevelsPerSide:10000});
  });
});
