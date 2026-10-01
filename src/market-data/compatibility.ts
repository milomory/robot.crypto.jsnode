/** Exact common quantity lattice; no price, balance, margin or profitability inference. */
import { decimal, units, multiply } from './exact-json.js';
import { freeze, market, reject, type InstrumentSpec, type ResearchBase } from './model.js';
const SCALE=10n**30n;
function text(n:bigint){const f=(n%SCALE).toString().padStart(30,'0').replace(/0+$/,'');return decimal(String(n/SCALE)+(f?'.'+f:''));}
function gcd(a:bigint,b:bigint):bigint{while(b){const r=a%b;a=b;b=r;}return a;}
export function compareContractGrids(mexc:InstrumentSpec,okx:InstrumentSpec){
  if(mexc?.market.exchange!=='mexc'||okx?.market.exchange!=='okx'||mexc.market.base!==okx.market.base||
    [mexc,okx].some(s=>s.market.type!=='perpetual'||s.market.quote!=='USDT'||s.market.settlement!=='USDT'||s.quantityUnit!=='contracts'||s.contractMultiplier!=='1'))reject('incompatible-contracts');
  for(const spec of [mexc,okx]) {
    if(Object.entries(market(spec.market.exchange,spec.market.base)).some(([key,value])=>spec.market[key as keyof typeof spec.market]!==value) ||
      spec.baseQuantityStep!==multiply(decimal(spec.basePerContract,false,true),decimal(spec.quantityStepContracts,false,true)) ||
      spec.baseMinimumQuantity!==multiply(decimal(spec.basePerContract,false,true),decimal(spec.minimumContracts,false,true))) reject('inconsistent-contract-grid');
  }
  const a=units(decimal(mexc.baseQuantityStep,false,true)),b=units(decimal(okx.baseQuantityStep,false,true));
  const common=a/gcd(a,b)*b;
  const m=units(decimal(mexc.baseMinimumQuantity,false,true)),o=units(decimal(okx.baseMinimumQuantity,false,true));
  const minimum=((m>o?m:o)+common-1n)/common*common;
  const quantity=(spec:InstrumentSpec)=>{const divisor=units(decimal(spec.basePerContract,false,true)),numerator=minimum*SCALE;
    if(numerator%divisor)reject('unrepresentable-contract-quantity');const q=numerator/divisor;
    if(q%units(decimal(spec.quantityStepContracts,false,true))||q<units(decimal(spec.minimumContracts,false,true)))reject('inconsistent-contract-grid');return text(q);};
  return freeze({base:mexc.market.base as ResearchBase,commonBaseQuantityStep:text(common),minimumMatchedBaseQuantity:text(minimum),
    contractsAtMinimum:{mexc:quantity(mexc),okx:quantity(okx)},publicListingsUsable:mexc.publicListingUsable&&okx.publicListingUsable,
    maxExecutableNotional:null,netEdgeBps:null,accountEligibilityVerified:false,executable:false});
}
