/** Explicit bounded public bootstrap and offline replay; never application startup. */
import { mkdir,open,lstat,realpath,readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { MexcBookClient } from '../market-data/mexc-book-client.js';
import { replayMexcBook, MAX_MEXC_BOOK_ARCHIVE_BYTES } from '../market-data/mexc-book-replay.js';
import type { MexcBookCapture } from '../market-data/mexc-book-session.js';
process.umask(0o077);
const summary=(r:MexcBookCapture)=>({base:r.base,status:r.status,requestCount:r.requestCount,connections:r.connections,
  frames:r.events.filter(e=>e.kind==='frame').length,appliedDeltas:r.appliedDeltas,failure:r.failure,
  verifiedDepth:r.book?.verifiedDepth??null,sourceAgeMs:r.book?.sourceTime.ageMs??null,entireBookKnown:false,executable:false});
try{
  const args=process.argv.slice(2),mode=args[0];
  if(mode==='capture'?(args.length!==3||!['BTC','ETH'].includes(args[1])):mode!=='replay'||args.length!==2)throw Error();
  const directory=resolve(args[mode==='capture'?2:1]);
  if(mode==='capture'){
    await mkdir(directory,{mode:0o700});if((await lstat(directory)).isSymbolicLink()||await realpath(directory)!==directory)throw Error();
    const report=await new MexcBookClient(args[1] as 'BTC'|'ETH').capture(),bytes=Buffer.from(JSON.stringify(report)+'\n');
    const sha256=createHash('sha256').update(bytes).digest('hex');
    for(const [name,content] of [['capture.json',bytes],['manifest.json',Buffer.from(JSON.stringify({schema:1,kind:'mexc-public-depth-book-manifest',sha256,publicDataOnly:true,executable:false})+'\n')]] as const){
      const handle=await open(resolve(directory,name),'wx',0o600);try{await handle.writeFile(content);await handle.sync();}finally{await handle.close();}
    }
    const handle=await open(directory,'r');try{await handle.sync();}finally{await handle.close();}
    replayMexcBook(bytes,sha256);console.log(JSON.stringify(summary(report)));if(report.status!=='complete')process.exitCode=1;
  }else{
    for(const name of ['capture.json','manifest.json']){const stat=await lstat(resolve(directory,name));if(!stat.isFile()||stat.size>(name==='capture.json'?MAX_MEXC_BOOK_ARCHIVE_BYTES:2048))throw Error();}
    const raw=await readFile(resolve(directory,'manifest.json'),'utf8'),manifest=JSON.parse(raw);
    if(JSON.stringify(manifest)+'\n'!==raw||Object.keys(manifest).sort().join(',')!=='executable,kind,publicDataOnly,schema,sha256'||
       manifest.schema!==1||manifest.kind!=='mexc-public-depth-book-manifest'||manifest.publicDataOnly!==true||manifest.executable!==false)throw Error();
    const report=replayMexcBook(await readFile(resolve(directory,'capture.json')),manifest.sha256);
    console.log(JSON.stringify({...summary(report),historicalReplay:true,sourceAuthenticationVerified:false}));
  }
}catch{console.error('MEXC book failed. Use capture BTC|ETH NEW_DIRECTORY or replay EXISTING_DIRECTORY. Preserve partial files; no automatic retry.');process.exitCode=1;}
