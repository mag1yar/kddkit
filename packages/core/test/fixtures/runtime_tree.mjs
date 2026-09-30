import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {appendFileSync} from 'node:fs';
const [mode,path]=process.argv.slice(2);
if(mode==='writer'){
  process.on('SIGTERM',()=>{});process.send?.({pid:process.pid});
  setInterval(()=>appendFileSync(path,'write\n'),20);
}else if(mode==='ignore-term'){
  process.on('SIGTERM',()=>{});process.send?.({pid:process.pid});setInterval(()=>{},100);
}else if(mode==='late-escape'){
  process.send?.({pid:process.pid});
  process.once('message',()=>{
    const child=fork(fileURLToPath(import.meta.url),['writer',path],{detached:true,stdio:['ignore','ignore','ignore','ipc']});
    child.once('message',message=>process.send({childPid:message.pid},()=>process.exit(0)));
  });
}else{
  const child=fork(fileURLToPath(import.meta.url),['writer',path],{detached:mode==='escape',stdio:['ignore','ignore','pipe','ipc']});
  child.once('message',message=>process.send?.({pid:process.pid,childPid:message.pid}));
  process.on('message',message=>{if(message==='exit-parent')process.exit(0)});
}
