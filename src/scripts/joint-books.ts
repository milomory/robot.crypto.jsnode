/** Explicit bounded joint public capture and offline replay; never application startup. */
import { mkdir,open,lstat,realpath,readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { JointObservationClient } from '../market-data/joint-client.js';
import { replayJointCapture } from '../market-data/joint-replay.js';
import { JOINT_LIMITS, type JointCapture } from '../market-data/joint-observation.js';

process.umask(0o077);
const summary=(r:JointCapture)=>({base:r.base,status:r.status,requestCount:r.requestCount,connections:r.mexc?.connections??0,
  failure:r.failure,quality:r.quality,netEdgeBps:null,executable:false});
try{
  const args=process.argv.slice(2),mode=args[0];
  if(mode==='capture'?(args.length!==3||!['BTC','ETH'].includes(args[1])):mode!=='replay'||args.length!==2)throw Error();
  const directory=resolve(args[mode==='capture'?2:1]);
  if(mode==='capture'){
    await mkdir(directory,{mode:0o700});if((await lstat(directory)).isSymbolicLink()||await realpath(directory)!==directory)throw Error();
    const report=await new JointObservationClient(args[1] as 'BTC'|'ETH').capture(),bytes=Buffer.from(JSON.stringify(report)+'\n');
    if(bytes.length>JOINT_LIMITS.maximumArchiveBytes)throw Error();
    const sha256=createHash('sha256').update(bytes).digest('hex');
    for(const [name,content] of [['capture.json',bytes],['manifest.json',Buffer.from(JSON.stringify({schema:1,kind:'joint-public-books-manifest',sha256,publicDataOnly:true,executable:false})+'\n')]] as const){
      const handle=await open(resolve(directory,name),'wx',0o600);try{await handle.writeFile(content);await handle.sync();}finally{await handle.close();}
    }
    const handle=await open(directory,'r');try{await handle.sync();}finally{await handle.close();}
    replayJointCapture(bytes,sha256);console.log(JSON.stringify(summary(report)));if(report.status!=='complete')process.exitCode=1;
  }else{
    for(const name of ['capture.json','manifest.json']){const stat=await lstat(resolve(directory,name));if(!stat.isFile()||stat.size>(name==='capture.json'?JOINT_LIMITS.maximumArchiveBytes:2048))throw Error();}
    const raw=await readFile(resolve(directory,'manifest.json'),'utf8'),manifest=JSON.parse(raw);
    if(JSON.stringify(manifest)+'\n'!==raw||Object.keys(manifest).sort().join(',')!=='executable,kind,publicDataOnly,schema,sha256'||
       manifest.schema!==1||manifest.kind!=='joint-public-books-manifest'||manifest.publicDataOnly!==true||manifest.executable!==false)throw Error();
    const report=replayJointCapture(await readFile(resolve(directory,'capture.json')),manifest.sha256);
    console.log(JSON.stringify({...summary(report),historicalReplay:true,sourceAuthenticationVerified:false}));
  }
}catch{console.error('Joint public capture failed. Use capture BTC|ETH NEW_DIRECTORY or replay EXISTING_DIRECTORY. Preserve partial files; no automatic retry.');process.exitCode=1;}
