import {expect,it} from 'vitest';
import {RuntimeParser} from '../src/runtime_events.js';
const id='01a0f13f-5c2c-7e60-a736-566842f9d328';
const limits={maxEventBytes:65536,maxStreamBytes:1048576};
const wire=(events:object[])=>Buffer.from(events.map(e=>JSON.stringify(e)).join('\n')+'\n');
const init={type:'thread.started',thread_id:id},done={type:'turn.completed',usage:{input_tokens:21,cached_input_tokens:7,output_tokens:8}};
const text={type:'item.completed',item:{id:'item_0',type:'agent_message',text:'Привет 🙂'}};
it('preserves every UTF-8 split and validates the observed Codex terminal envelope',()=>{
  const data=wire([init,{type:'turn.started'},text,done]);
  for(let at=1;at<data.length;at++){
    const p=new RuntimeParser('codex',null,limits);
    const events=[...p.push(data.subarray(0,at)),...p.push(data.subarray(at)),...p.end()];
    expect(events.filter(e=>e.kind==='text').map(e=>e.detail)).toEqual([{text:'Привет 🙂'}]);
    expect(p.result()).toEqual({sessionId:id,terminal:'success',reason:null});
    expect(events.find(e=>e.kind==='usage')?.detail).toMatchObject({scope:'attempt',inputTokens:21,cachedInputTokens:7,outputTokens:8,costUsd:null});
  }
});
it('keeps absent usage unknown and accepts a valid EOF line without a newline',()=>{
  const p=new RuntimeParser('codex',id,limits);
  const events=[...p.push(Buffer.from(JSON.stringify(init)+'\n'+JSON.stringify({type:'turn.completed'}))),...p.end()];
  expect(p.result().terminal).toBe('success');
  expect(events.find(e=>e.kind==='usage')?.detail).toMatchObject({inputTokens:null,outputTokens:null,costUsd:null});
});
it('never declares malformed, missing, conflicting or unsupported protocol successful',()=>{
  const cases:Uint8Array[]=[Buffer.alloc(0),Buffer.from('{}\n'),Buffer.from('{bad}\n'),wire([init]),wire([done]),
    wire([init,done,done]),wire([init,done,{type:'error',message:'late failure'}]),
    wire([{...init,thread_id:'foreign'},done]),wire([init,{type:'turn.failed',error:{message:'provider failure'}}]),
    wire([init,{type:'turn.completed',usage:{input_tokens:-1}}]),wire([init,{type:'new.unknown'},done]),
    Buffer.concat([wire([init,text,done]),Buffer.from([0xff])]),
    Buffer.concat([wire([init,text,done]),Buffer.from([0xf0,0x9f])]),
    Buffer.from('{"x":'+ '['.repeat(33)+'0'+']'.repeat(33)+'}\n')];
  for(const data of cases){
    const p=new RuntimeParser('codex',id,limits);p.push(data);p.end();
    expect(p.result().reason).not.toBeNull();expect(p.result().terminal).not.toBe('success');
  }
});
it('bounds chunks, lines and total stream before accepting success',()=>{
  for(const [bounded,data] of [[{maxEventBytes:10,maxStreamBytes:20},wire([init,done])],
    [{maxEventBytes:100,maxStreamBytes:100},Buffer.alloc(101,32)]] as const){
    const p=new RuntimeParser('codex',null,bounded);p.push(data);p.end();
    expect(p.result()).toMatchObject({terminal:'failure',reason:'protocol_error'});
  }
});
it('maps tool correlation without persisting raw command payloads and rejects late protocol input',()=>{
  const p=new RuntimeParser('codex',id,limits),token='sk-'+ 'A'.repeat(30);
  const events=p.push(wire([init,{type:'item.started',item:{id:'tool_1',type:'command_execution',command:`echo ${token}`,status:'in_progress'}},
    {type:'item.completed',item:{id:'tool_1',type:'command_execution',command:`echo ${token}`,aggregated_output:'ok',exit_code:0,status:'completed'}},done]));
  p.end();expect(events.filter(e=>e.kind.startsWith('tool_')).map(e=>e.detail)).toEqual([
    {id:'tool_1',name:'command_execution'},{id:'tool_1',name:'command_execution',status:'completed',exitCode:0}]);
  expect(JSON.stringify(events)).not.toContain(token);
  expect(p.push(wire([done]))).toEqual([]);expect(p.result().reason).toBe('protocol_error');
});
it('redacts exact host-supplied credentials that have no known vendor prefix',()=>{
  const token='abc12345'.repeat(8),p=new RuntimeParser('codex',id,limits,[token]);
  const events=p.push(wire([init,{...text,item:{...text.item,text:`token ${token}`}},done]));p.end();
  expect(events.find(e=>e.kind==='text')?.detail).toEqual({text:'token [redacted]'});
});
it('redacts environment dumps at actual string line boundaries',()=>{
  const p=new RuntimeParser('codex',id,limits),text='SERVICE_TOKEN=abc12345abc12345\n';
  const events=p.push(wire([init,{type:'item.completed',item:{id:'item_0',type:'agent_message',text}},done]));p.end();
  expect(events.find(e=>e.kind==='text')?.detail).toEqual({text:'SERVICE_TOKEN=[redacted]\n'});
});
it('rejects redaction expansion past the event limit before emitting text',()=>{
  const message={...text,item:{...text.item,text:'SERVICE_TOKEN=abcdefgh\n'.repeat(100)}};
  const maxEventBytes=Buffer.byteLength(JSON.stringify(message));
  const p=new RuntimeParser('codex',id,{...limits,maxEventBytes});
  p.push(wire([init]));
  const events=[...p.push(wire([message,done])),...p.end()];
  expect(events.some(e=>e.kind==='text')).toBe(false);
  expect(p.result()).toMatchObject({terminal:'failure',reason:'protocol_error'});
});
