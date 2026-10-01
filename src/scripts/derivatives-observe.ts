/** Standalone D0b: explicit capture or offline replay, never application startup. */
import { mkdir, open, lstat, realpath, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DerivativesObservationClient, type D0bCapture } from '../market-data/observations-client.js';
import { replayObservationArchive } from '../market-data/observations-replay.js';
process.umask(0o077);
const summary=(report:D0bCapture)=>({status:report.status,requestCount:report.requestCount,observations:report.observations.length,
  failures:report.failures,quality:report.quality,publicDataOnly:true,executable:false});
try{
  const args=process.argv.slice(2);
  if(args.length!==2||!['capture','replay'].includes(args[0])||!args[1])throw Error();
  const directory=resolve(args[1]);
  if(args[0]==='capture'){
    await mkdir(directory,{mode:0o700});
    if((await lstat(directory)).isSymbolicLink()||await realpath(directory)!==directory)throw Error();
    const report=await new DerivativesObservationClient().capture(),bytes=Buffer.from(JSON.stringify(report)+'\n');
    const sha256=createHash('sha256').update(bytes).digest('hex');
    const capture=await open(resolve(directory,'capture.json'),'wx',0o600);
    try{await capture.writeFile(bytes);await capture.sync();}finally{await capture.close();}
    const manifest=await open(resolve(directory,'manifest.json'),'wx',0o600);
    try{await manifest.writeFile(JSON.stringify({schema:1,kind:'derivatives-public-d0b-manifest',sha256,publicDataOnly:true,executable:false})+'\n');await manifest.sync();}finally{await manifest.close();}
    const handle=await open(directory,'r');try{await handle.sync();}finally{await handle.close();}
    // Keep the diagnostic archive even if an internal replay check fails. A manifest is only a byte hash.
    replayObservationArchive(bytes,sha256);
    console.log(JSON.stringify(summary(report)));if(report.status!=='complete')process.exitCode=1;
  }else{
    for(const name of ['capture.json','manifest.json']){const stat=await lstat(resolve(directory,name));if(!stat.isFile()||stat.size>(name==='capture.json'?32*1024*1024:2048))throw Error();}
    const manifestText=await readFile(resolve(directory,'manifest.json'),'utf8'),manifest=JSON.parse(manifestText);
    if(JSON.stringify(manifest)+'\n'!==manifestText)throw Error();
    if(Object.keys(manifest).sort().join(',')!=='executable,kind,publicDataOnly,schema,sha256'||manifest.schema!==1||manifest.kind!=='derivatives-public-d0b-manifest'||manifest.publicDataOnly!==true||manifest.executable!==false)throw Error();
    const report=replayObservationArchive(await readFile(resolve(directory,'capture.json')),manifest.sha256);
    console.log(JSON.stringify({...summary(report),historicalReplay:true,sourceAuthenticationVerified:false}));
  }
}catch{console.error('D0b failed. Use capture NEW_DIRECTORY or replay EXISTING_DIRECTORY. Preserve partial files; no automatic retry.');process.exitCode=1;}
