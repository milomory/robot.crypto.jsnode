import json,hashlib
from pathlib import Path
from decimal import Decimal, getcontext, ROUND_CEILING, ROUND_FLOOR, ROUND_HALF_EVEN
from collections import Counter
from datetime import datetime,timezone
getcontext().prec=80
D=Decimal; Q=D('0.00000001'); ROOT=Path('/home/anton/Projects/trading/robot.crypto.jsnode/output/pair-day-20260926/hyperion')
load=lambda p:json.loads(p.read_text())
a=load(ROOT/'acceptance.json');r=load(ROOT/'report/report.json');mf=load(ROOT/'archive/manifest.json');ins=load(ROOT/'archive/instruments.json');state=load(ROOT/'archive/state.json')
assert a['ready'] and a['protocolAccepted'] and a['analysisMode']=='strict' and a['deterministicReplay']
files={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in (ROOT/'archive').iterdir()}
assert files==a['files']
assert (ROOT/'report/report.json').read_bytes()==(ROOT/'repeat-report/report.json').read_bytes()
assert hashlib.sha256((ROOT/'report/report.json').read_bytes()).hexdigest()==a['reportSha256']
samples=[load(ROOT/f'archive/{i:03}.json') for i in range(1440)]
assert [s['sequence'] for s in samples]==list(range(1440))
assert len(r['observations'])==len(samples)==state['samples']==a['sampledCount']==1440
assert state['status']=='completed' and state['endedAt']<=mf['startedAt']+mf['plan']['maxDurationMs']
lateness=[s['startedAt']-(ins['samplingStartedAt']+i*60000) for i,s in enumerate(samples)]
assert min(lateness)>=0 and max(lateness)<60000
assert all(samples[i]['checkedAt']<=samples[i+1]['startedAt'] for i in range(1439))
failures=Counter();rawbookfailures=Counter();refreshfailures=[];rawrefreshes=[(-1,ins['instruments'])]+[(s['sequence'],s['instrumentRefresh'])for s in samples if 'instrumentRefresh'in s]
assert [seq for seq,_ in rawrefreshes]==[-1]+list(range(30,1440,30))
for s in samples:
 for v in ['mexc','okx']:
  if not s['books'][v]['available']:rawbookfailures[v+':'+s['books'][v]['reason']]+=1
for seq,refresh in rawrefreshes:
 for v in ['mexc','okx']:
  if not refresh[v]['available']:refreshfailures.append({'sequence':seq,'venue':v,'reason':refresh[v]['reason']})
indexavailable=sum(s['usdIndex']['available'] and s['usdIndex']['value']['receivedAt']<=s['checkedAt'] and s['checkedAt']-s['usdIndex']['value']['requestedAt']<=5000 and s['checkedAt']-s['usdIndex']['value']['sourceAt']<=5000 for s in samples)
assert indexavailable==r['study']['usdIndexCoverage']['available']==1440
rulecounts={v:sum(bool(rr[v]['available'])for _,rr in rawrefreshes)for v in ['mexc','okx']}
assert rulecounts=={'mexc':r['study']['instrumentRefreshes']['availableMexc'],'okx':r['study']['instrumentRefreshes']['availableOkx']}

def quote(book,side,qty,fee,slip):
 remaining=qty;raw=D(0)
 for price,available in book['asks'if side=='buy'else'bids']:
  take=min(remaining,D(available));raw+=D(price)*take;remaining-=take
  if remaining==0:break
 assert remaining==0
 adjusted=raw*(1+(slip/D(10000) if side=='buy'else-slip/D(10000)))
 gross=adjusted.quantize(Q,rounding=ROUND_CEILING if side=='buy'else ROUND_FLOOR)
 fees=(adjusted*fee/D(10000)).quantize(Q,rounding=ROUND_CEILING)
 return raw,gross,fees,gross+(fees if side=='buy'else-fees)

verified=0;series={kind:{v:[]for v in ['mexc','okx']}for kind in ['quote','okxReceivedBase']};ruleReasons=Counter()
for raw,row in zip(samples,r['observations']):
 assert raw['sequence']==row['sequence'] and raw['checkedAt']==row['at']
 if not all(raw['books'][v]['available']for v in ['mexc','okx']):expectedreason='missing-book'
 else:
  skew=abs(raw['books']['mexc']['value']['receivedAt']-raw['books']['okx']['value']['receivedAt'])
  assert skew==row['receiptSkewMs']
  expectedreason='receipt-skew'if skew>1000 else None
 if expectedreason:
  assert row['reason']==expectedreason and row['status']=='unavailable' and row['directions']==[];failures[expectedreason]+=1;continue
 assert row['status']=='available' and len(row['directions'])==2
 for direction in row['directions']:
  b=direction['buyVenue'];s=direction['sellVenue'];q=D(r['plan']['quantityBTC'])
  buy=quote(raw['books'][b]['value'],'buy',q,D(mf['costs'][b]['feeBps']),D(mf['costs'][b]['slippageBps']))
  sell=quote(raw['books'][s]['value'],'sell',q,D(mf['costs'][s]['feeBps']),D(mf['costs'][s]['slippageBps']))
  net=sell[3]-buy[3]
  assert net==D(direction['netUsdt'])==D(direction['feeScenarios']['quote']['netUsdt'])
  assert buy[3]==D(direction['buyCashUsdt']) and sell[3]==D(direction['sellCashUsdt']) and buy[2]+sell[2]==D(direction['feeUsdt'])
  assert sell[0]-buy[0]==D(direction['rawSpreadUsdt'])
  base=direction['feeScenarios']['okxReceivedBase']
  if b=='okx':
   rate=D(mf['costs'][b]['feeBps'])/D(10000)
   gross=(q/(1-rate)).quantize(Q,rounding=ROUND_CEILING)
   basefee=(gross*rate).quantize(Q,rounding=ROUND_CEILING)
   coveredbuy=quote(raw['books'][b]['value'],'buy',gross,D(0),D(mf['costs'][b]['slippageBps']))
   basenet=sell[3]-coveredbuy[3]
   assert gross==D(base['requiredBuyQuantityBtc']) and basefee==D(base['buyFeeBtc'])
   assert gross-basefee==D(base['receivedBtc']) and gross-basefee-q==D(base['residualBtc'])
  else:basenet=net
  assert basenet==D(base['netUsdt'])
  for kind,n in [('quote',net),('okxReceivedBase',basenet)]:series[kind][b].append((row['sequence'],row['at'],n))
  assert direction['ruleStatus']=='blocked' and 'frozen-fees-sensitivity-only'in direction['ruleReasons']
  ruleReasons.update(direction['ruleReasons']);verified+=1

def display(d):return format(d,'f')
summary={}
for kind,byvenue in series.items():
 summary[kind]={}
 for venue,rows in byvenue.items():
  nets=[x[2]for x in rows];pos=sum(n>0 for n in nets);previous=-2;current=longest=span=0;start=0
  for seq,at,n in rows:
   if n>0:
    if seq!=previous+1 or current==0:current=1;start=at
    else:current+=1
    longest=max(longest,current);span=max(span,at-start)
   else:current=0
   previous=seq
  expected=next(x for x in r['study'][kind+'Scenario']if x['buyVenue']==venue)
  assert expected['evaluatedSamples']==len(rows) and expected['positiveSamples']==pos and expected['longestConsecutivePositiveSamples']==longest and expected['longestSampledSpanMs']==span
  summary[kind][venue]={'buyVenue':venue,'sellVenue':'okx'if venue=='mexc'else'mexc','evaluated':len(rows),'positive':pos,'minimumNetUsdt':display(min(nets)),'maximumNetUsdt':display(max(nets)),'meanNetUsdtRounded18':display((sum(nets)/len(nets)).quantize(D('0.000000000000000001'),rounding=ROUND_HALF_EVEN)),'longestConsecutivePositive':longest,'longestSampledSpanMs':span}
assert verified==r['counts']['directionalComparisons']==2838
assert sum(failures.values())==r['coverage']['unavailablePairs']==21
assert len(series['quote']['mexc'])==r['coverage']['availablePairs']==1419
assert not r['coverage']['complete'] and not r['study']['metadataComplete']
assert r['counts']['paperPairs']==r['counts']['ruleEligibleDirections']==r['counts']['positiveDirections']==len(r['journal'])==0
age=state['endedAt']-min(x['requestedAt']for x in mf['feeEvidence']['fees'].values());assert age==r['study']['maximumFeeEvidenceAgeMs']
selected=series['okxReceivedBase'];selectednets=[row[2]for rows in selected.values()for row in rows]
assert r['study']['selectedFeeScenario']=='okx-received-base'
assert min(selectednets)==D(r['study']['selectedScenarioSummary']['netRangeUsdt']['minimum']) and max(selectednets)==D(r['study']['selectedScenarioSummary']['netRangeUsdt']['maximum'])
iso=lambda t:datetime.fromtimestamp(t/1000,timezone.utc).isoformat()
evidence={'status':'pass','scope':'Independent local decimal recomputation and archive consistency; no network/runtime changes','protocolAccepted':a['protocolAccepted'],'completeUsableMarketData':r['coverage']['complete'],'captureId':r['captureId'],'archiveFiles':len(files),'archiveBytes':sum(p.stat().st_size for p in (ROOT/'archive').iterdir()),'archiveFileHashesMatchAcceptance':True,'byteIdenticalReplay':True,'reportSha256':a['reportSha256'],'samplingStartedAtUtc':iso(ins['samplingStartedAt']),'endedAtUtc':iso(state['endedAt']),'scheduledSamples':1440,'archivedSamples':1440,'missedSlots':sum(x>=60000 for x in lateness),'earlySlots':sum(x<0 for x in lateness),'minimumStartLatenessMs':min(lateness),'maximumStartLatenessMs':max(lateness),'usablePairs':1419,'unusablePairs':21,'unusableReasonCounts':dict(failures),'rawBookFailureCounts':dict(rawbookfailures),'unusableSequences':[x['sequence']for x in r['observations']if x['status']!='available'],'freshUsdIndexSamples':indexavailable,'ruleRefreshCoverage':rulecounts,'ruleRefreshFailures':refreshfailures,'maximumReceiptSkewMsAll':max(x.get('receiptSkewMs',0)for x in r['observations']),'maximumReceiptSkewMsAccepted':max(x.get('receiptSkewMs',0)for x in r['observations']if x['status']=='available'),'maximumFrozenFeeAgeMs':age,'independentlyRecomputedDirectionRows':verified,'selectedFeeScenario':'okx-received-base','scenarios':summary,'ruleReasonCounts':dict(ruleReasons),'paperFills':0,'caveats':['Protocol and deterministic calculation accepted, market coverage incomplete.','Negative selected-scenario price/cost sensitivities are not realized loss or P/L.','Initial fees frozen and not continuously verified; source synchronization absent at MEXC.','1 minute samples do not establish absence of opportunities between samples or on other pairs.','MEXC quantity and market-buy semantics and OKX admission/fee quantum remain unresolved.']}
Path('/tmp/crypto-day-audit-20260928.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n');print(json.dumps(evidence,ensure_ascii=False,indent=2))
