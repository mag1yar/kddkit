import {fork,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {afterEach,expect,it} from 'vitest';
import * as core from '../src/index.js';
import {fixture,cleanupFixtures} from './execution_fixture.js';
afterEach(cleanupFixtures);
const entry=fileURLToPath(new URL('./fixtures/runtime_tree.mjs',import.meta.url));
function snapshot(){
  return execFileSync('/bin/ps',['-axo','pid=,pgid=,stat='],{encoding:'utf8',timeout:1000,maxBuffer:8*1024*1024})
    .trim().split('\n').map(line=>{const [pid,group,state]=line.trim().split(/\s+/);return{pid:Number(pid),group:Number(group),state}});
}
function killFixture(pid:number,group=false){
  if(!snapshot().some(row=>(group?row.group:row.pid)===pid&&!row.state.startsWith('Z')))return;
  try{process.kill(group?-pid:pid,'SIGKILL')}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e}
}
function owned(){const f=fixture(),task=f.task('process'),item=core.createWorkItem(f.handle,{task:f.ref(task.id),
  definition:{kind:'analysis',repoId:null,sourceTasks:[],outputs:[]},dependencies:[]});
  const owner=core.reserveWorkItem(f.handle,{ref:item.ref,expectedRevision:1,expectedFence:0,expectedMode:'manual',ownerId:'host',write:false});
  return{...f,owner:core.recordLaunchIntent(f.handle,{owner:owner.ref,intent:{launchId:'launch',writerScopeId:'scope'}})};
}
for(const mode of ['ignore-term','orphan','escape','late-escape'])it.runIf(process.platform==='darwin')(`holds ownership for actual ${mode} writers without containment proof`,async()=>{
  const f=owned(),child=fork(entry,[mode,join(f.root,'writes')],{detached:true,stdio:['ignore','ignore','ignore','ipc']});
  let writer:number|undefined;
  try{
    const ready=await once(child,'message');writer=(ready[0] as {childPid?:number}).childPid;
    expect(snapshot().some(row=>row.pid===child.pid&&row.group===child.pid)).toBe(true);
    if(mode==='ignore-term'){
      child.kill('SIGTERM');expect(child.killed).toBe(true);expect(()=>process.kill(child.pid!,0)).not.toThrow();
      const exited=once(child,'exit');killFixture(child.pid!,true);await exited;
    }else{
      const exited=once(child,'exit');
      if(mode==='late-escape'){
        const message=once(child,'message');child.send('spawn');writer=((await message)[0] as {childPid:number}).childPid;
      }else child.send('exit-parent');
      await exited;expect(()=>process.kill(writer!,0)).not.toThrow();
      const liveGroup=snapshot().some(row=>row.group===child.pid&&!row.state.startsWith('Z'));
      expect(liveGroup).toBe(mode==='orphan');
    }
    const verdict=mode==='orphan'?'live':'unknown';
    const result=await core.retireOwnership(f.handle,{commandId:'stop',owner:f.owner.ref},async owner=>({
      observationId:'host-probe',owner:owner.ref,launchId:'launch',writerScopeId:'scope',observedAt:core.now(),verdict,complete:false,
      writers:[{id:String(child.pid),state:mode==='orphan'?'alive':'gone'}]}));
    expect(result.status).toBe('held');expect(core.ownership(f.handle,f.owner.ref).releasedAt).toBeNull();
  }finally{
    killFixture(child.pid!,true);if(writer)killFixture(writer);
    if(child.exitCode===null&&child.signalCode===null)await once(child,'exit');
  }
},10000);
