/** Explicit local public capture; exclusive output directory, no recurring observation. */
import { mkdir, open, lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DerivativesPublicClient } from '../market-data/client.js';
import { compareContractGrids } from '../market-data/compatibility.js';
import type { InstrumentSpec } from '../market-data/model.js';
process.umask(0o077);
try {
  const args=process.argv.slice(2);if(args.length!==1||!args[0])throw Error();
  const directory=resolve(args[0]);await mkdir(directory,{mode:0o700});
  if((await lstat(directory)).isSymbolicLink()||await realpath(directory)!==directory)throw Error();
  const report=await new DerivativesPublicClient().capture();
  const specs=report.observations.map(x=>x.parsed).filter((x):x is InstrumentSpec=>x.kind==='public-linear-contract');
  const compatibility=report.status==='complete'?(['BTC','ETH'] as const).map(base=>compareContractGrids(specs.find(s=>s.market.exchange==='mexc'&&s.market.base===base)!,specs.find(s=>s.market.exchange==='okx'&&s.market.base===base)!)):[];
  const raw=JSON.stringify({report,compatibility})+'\n';
  const file=await open(resolve(directory,'capture.json'),'wx',0o600);try{await file.writeFile(raw);await file.sync();}finally{await file.close();}
  const manifest=await open(resolve(directory,'manifest.json'),'wx',0o600);try{await manifest.writeFile(JSON.stringify({schema:1,sha256:createHash('sha256').update(raw).digest('hex'),publicDataOnly:true,requestCount:report.requestCount,status:report.status,executable:false})+'\n');await manifest.sync();}finally{await manifest.close();}
  console.log(JSON.stringify({status:report.status,requestCount:report.requestCount,failures:report.failures,compatibility,publicDataOnly:true,executable:false}));
  if(report.status!=='complete')process.exitCode=1;
} catch {console.error('Public derivatives capture failed. Use one NEW_OUTPUT_DIRECTORY; preserve partial files. No automatic retry.');process.exitCode=1;}
