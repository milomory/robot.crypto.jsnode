/** Explicit public source-time research; no server imports, credentials or trading. */
import { mkdir,open,lstat,realpath,readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { MexcDepthSourceClient, type DepthSourceCapture } from '../market-data/mexc-depth-source-client.js';
import { replayMexcDepthSource, MAX_DEPTH_SOURCE_ARCHIVE_BYTES } from '../market-data/mexc-depth-source-replay.js';
process.umask(0o077);
const summary=(r:DepthSourceCapture)=>({status:r.status,connections:r.connections,subscriptions:r.subscriptions,pings:r.pings,
  frames:r.frames.length,acceptedDeltas:r.acceptedDeltas,failure:r.failure,sourceTimeObserved:r.sourceTimeObserved,
  bookReconstructed:false,executable:false});
try{
  const [mode,argument,...extra]=process.argv.slice(2);
  if(!['capture','replay'].includes(mode)||!argument||extra.length)throw Error();
  const directory=resolve(argument);
  if(mode==='capture'){
    await mkdir(directory,{mode:0o700});
    if((await lstat(directory)).isSymbolicLink()||await realpath(directory)!==directory)throw Error();
    const report=await new MexcDepthSourceClient().capture(),bytes=Buffer.from(JSON.stringify(report)+'\n');
    const sha256=createHash('sha256').update(bytes).digest('hex');
    for(const [name,content] of [['capture.json',bytes],['manifest.json',Buffer.from(JSON.stringify({schema:1,kind:'mexc-public-depth-source-manifest',sha256,publicDataOnly:true,bookReconstructed:false,executable:false})+'\n')]] as const){
      const file=await open(resolve(directory,name),'wx',0o600);try{await file.writeFile(content);await file.sync();}finally{await file.close();}
    }
    const handle=await open(directory,'r');try{await handle.sync();}finally{await handle.close();}
    replayMexcDepthSource(bytes,sha256);console.log(JSON.stringify(summary(report)));if(report.status!=='complete')process.exitCode=1;
  }else{
    for(const name of ['capture.json','manifest.json']){const stat=await lstat(resolve(directory,name));if(!stat.isFile()||stat.size>(name==='capture.json'?MAX_DEPTH_SOURCE_ARCHIVE_BYTES:2048))throw Error();}
    const raw=await readFile(resolve(directory,'manifest.json'),'utf8'),manifest=JSON.parse(raw);
    if(JSON.stringify(manifest)+'\n'!==raw||Object.keys(manifest).sort().join(',')!=='bookReconstructed,executable,kind,publicDataOnly,schema,sha256'||
        manifest.schema!==1||manifest.kind!=='mexc-public-depth-source-manifest'||manifest.publicDataOnly!==true||manifest.bookReconstructed!==false||manifest.executable!==false)throw Error();
    const report=replayMexcDepthSource(await readFile(resolve(directory,'capture.json')),manifest.sha256);
    console.log(JSON.stringify({...summary(report),historicalReplay:true,sourceAuthenticationVerified:false}));
  }
}catch{console.error('Depth source probe failed. Use capture NEW_DIRECTORY or replay EXISTING_DIRECTORY. Preserve partial files; no automatic retry.');process.exitCode=1;}
