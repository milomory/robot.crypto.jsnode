#!/usr/bin/env python3
"""Independent Decimal cross-check of a completed received-base study: pass its evidence directory."""
from pathlib import Path
from decimal import Decimal as D, getcontext, ROUND_CEILING as UP, ROUND_FLOOR as DOWN
import json,hashlib,sys
getcontext().prec=100
if len(sys.argv)!=2:raise SystemExit('Usage: verify-pair-study-decimal.py EVIDENCE_DIRECTORY')
root=Path(sys.argv[1]).resolve()
r=json.loads((root/'report/report.json').read_text())
assert r['study']['selectedFeeScenario']=='okx-received-base'
costs=r['costs'];q=D(r['plan']['quantityBTC']);quantum=D('0.00000001')
def cash(book,side,qty,venue,base_fee=False):
 raw=D(0);remaining=qty
 for p,v in book['asks' if side=='buy' else 'bids']:
  take=min(remaining,D(v));raw+=take*D(p);remaining-=take
  if remaining==0:break
 assert remaining==0
 adjusted=raw*(D(1)+(D(1) if side=='buy' else D(-1))*D(costs[venue]['slippageBps'])/10000)
 fee=(adjusted*(D(0) if base_fee else D(costs[venue]['feeBps'])/10000)).quantize(quantum,rounding=UP)
 gross=adjusted.quantize(quantum,rounding=UP if side=='buy' else DOWN)
 return gross+fee if side=='buy' else gross-fee
nets=[];checks=0;usd_checks=0
for row in r['observations']:
 if row['status']!='available':continue
 s=json.loads((root/'archive'/('%03d.json'%row['sequence'])).read_text())
 for direction in row['directions']:
  buy,sell=direction['buyVenue'],direction['sellVenue'];books=s['books'];selected=None
  for kind in ['quote','okxReceivedBase']:
   base_fee=kind=='okxReceivedBase' and buy=='okx';gross=q
   if base_fee:
    rate=D(costs['okx']['feeBps'])/10000
    gross=(q/(1-rate)).quantize(quantum,rounding=UP)
    received=gross-(gross*rate).quantize(quantum,rounding=UP)
    assert received>=q
   net=cash(books[sell]['value'],'sell',q,sell)-cash(books[buy]['value'],'buy',gross,buy,base_fee)
   v=direction['feeScenarios'][kind]
   assert D(v['netUsdt'])==net and D(v['requiredBuyQuantityBtc'])==gross
   if kind=='okxReceivedBase':selected=net
   checks+=1
   usd=direction['usdLimits'][kind]
   if usd['status']=='within-model-cap':
    expected=(D(usd['quantityBtc'])*D(s['usdIndex']['value']['usdPerBtc'])*D('1.01')).quantize(D('0.000000000000000001'),rounding=UP)
    assert D(usd['bufferedNotionalUsd'])==expected and expected<=D(usd['maximumUsd'])
    usd_checks+=1
  nets.append(selected)
summary=r['study']['selectedScenarioSummary']
assert len(nets)==summary['directionalComparisons']
assert sum(x>0 for x in nets)==summary['positiveDirections']
assert min(nets)==D(summary['netRangeUsdt']['minimum']) and max(nets)==D(summary['netRangeUsdt']['maximum'])
result={'method':'independent Python Decimal,100digit precision, archived depth walk, upward BTC fee gross-up and cash rounding','scenarioCashChecks':checks,'usdProxyChecks':usd_checks,'selectedComparisons':len(nets),'positiveSelectedComparisons':sum(x>0 for x in nets),'allEqual':True,'reportSha256':hashlib.sha256((root/'report/report.json').read_bytes()).hexdigest()}
output=root/'decimal-acceptance.json'
encoded=json.dumps(result,indent=2)+'\n'
if output.exists():
 assert output.read_text()==encoded
else:
 with output.open('x') as f:f.write(encoded)
print(json.dumps(result))
