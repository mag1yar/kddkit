import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as core from '../../dist/index.js';
const entry = fileURLToPath(import.meta.url);

export async function runRace(dbPath, requests) {
  const children = requests.map(() => fork(entry, [dbPath], {
    execPath: process.execPath, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  }));
  const diagnostics = children.map(() => '');
  const pending = new Set();
  const closed = children.map((child, i) => {
    child.stderr.on('data', data => { diagnostics[i] = (diagnostics[i] + data).slice(-4096); });
    child.on('error', error => { diagnostics[i] = (diagnostics[i] + error.message).slice(-4096); });
    return new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  });
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('race worker timeout')), 10000);
  });
  const message = (child, i) => new Promise((resolve, reject) => {
    const finish = (error, value) => {
      pending.delete(cancel); child.off('error', failed); child.off('exit', exited); child.off('message', received);
      error ? reject(error) : resolve(value);
    };
    const cancel = () => finish(new Error('race cancelled'));
    const failed = error => finish(error);
    const exited = code => finish(new Error(`race worker exited ${code}: ${diagnostics[i]}`));
    const received = value => finish(null, value);
    pending.add(cancel); child.once('error', failed); child.once('exit', exited); child.once('message', received);
  });
  try {
    const ready = children.map(message);
    children.forEach((child, i) => child.send({ request: requests[i] }));
    const acknowledgements = await Promise.race([Promise.all(ready), deadline]);
    if (!acknowledgements.every(value => value.ready === true)) throw new Error('race barrier incomplete');
    const replies = children.map(message); children.forEach(child => child.send('go'));
    const results = await Promise.race([Promise.all(replies), deadline]);
    if (!results.every(value => typeof value.ok === 'boolean' && (value.ok || typeof value.error === 'string'))) {
      throw new Error('malformed race result');
    }
    const exits = await Promise.race([Promise.all(closed), deadline]);
    if (exits.some(exit => exit.code !== 0)) throw new Error(`race exit failed: ${JSON.stringify(exits)} ${diagnostics.join('\n')}`);
    return results;
  } finally {
    clearTimeout(timer);
    for (const cancel of [...pending]) cancel();
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.all(closed);
  }
}

export async function crashMemoryWrite(dbPath,input) {
  const child=fork(entry,[dbPath],{execPath:process.execPath,stdio:['ignore','ignore','pipe','ipc']});
  let diagnostic='',timer,received,failed,exited;
  child.stderr.on('data',data=>{diagnostic=(diagnostic+data).slice(-4096);});
  const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
  try {
    await new Promise((resolve,reject)=>{
      let ready=false;
      failed=error=>reject(error);
      exited=code=>reject(new Error(`crash worker exited ${code}: ${diagnostic}`));
      received=value=>{
        if(!ready && value.ready===true){ready=true;child.send('go');}
        else if(ready && value.pending===true)resolve();
        else reject(new Error(`crash barrier failed: ${JSON.stringify(value)}`));
      };
      child.on('message',received);child.on('error',failed);child.on('exit',exited);
      timer=setTimeout(()=>reject(new Error('crash worker timeout')),10000);
      child.send({request:{op:'memory-crash',input}});
    });
    child.kill('SIGKILL');
    const exit=await closed;
    if(exit.signal!=='SIGKILL')throw new Error(`crash kill failed: ${JSON.stringify(exit)}`);
  }finally {
    clearTimeout(timer);child.off('message',received);child.off('error',failed);child.off('exit',exited);
    if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL');
    await closed;
  }
}

if (process.argv[1] === entry) {
  const db = core.openDb(process.argv[2]), handle = core.openController(db);
  let request;
  process.on('message', message => {
    if (message !== 'go') { request = message.request; process.send({ ready: true }); return; }
    let response;
    try {
      if (request.op === 'reserve') response = { ok: true, value: core.reserveWorkItem(handle, request.input) };
      else if (request.op === 'revise') response = { ok: true, value: core.reviseWorkItem(handle, request.input) };
      else if (request.op === 'memory') response = { ok: true, value: core.writeMemory(handle, request.input) };
      else if (request.op === 'memory-crash') {
        db.exec('BEGIN IMMEDIATE');core.writeMemory(handle,request.input);
        process.send({pending:true});return;
      }
      else throw new Error('unknown race operation');
    } catch (error) { response = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    db.close(); process.send(response, () => process.disconnect());
  });
}
