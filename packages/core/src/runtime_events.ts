import {KddError} from './errors.js';
import {integer,shape} from './execution.js';
import {redactRuntimeDetail} from './runtime.js';
import type {RuntimeKind,RuntimeLimits,RuntimeEvent,RuntimeEventKind,RuntimeReason} from './runtime.js';

/** Protocol validation, not process completion or work-item acceptance. */
export class RuntimeParser{
  private readonly decoder=new TextDecoder('utf-8',{fatal:true});
  private pending='';private bytes=0;private sequence=0;private ended=false;
  private sessionId:string|null=null;private terminal:'success'|'failure'|null=null;private reason:RuntimeReason|null=null;
  constructor(runtime:RuntimeKind,private readonly expectedSessionId:string|null,
    private readonly limits:Pick<RuntimeLimits,'maxEventBytes'|'maxStreamBytes'>,private readonly secrets:readonly string[]=[]){
    if(runtime!=='codex')throw new KddError('unsupported runtime protocol');
    shape(limits,['maxEventBytes','maxStreamBytes']);integer(limits.maxEventBytes);integer(limits.maxStreamBytes);
    if(limits.maxEventBytes>limits.maxStreamBytes||limits.maxStreamBytes>64*1024*1024)throw new KddError('invalid protocol limit');
    if(expectedSessionId!==null&&!this.uuid(expectedSessionId))throw new KddError('invalid provider session identity');
    redactRuntimeDetail({},secrets);this.secrets=[...secrets];
  }
  private uuid(value:unknown):value is string{return typeof value==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)}
  private fail(reason:RuntimeReason='protocol_error'):RuntimeEvent[]{
    if(this.reason===null)this.reason=reason;
    this.terminal='failure';this.pending='';return [];
  }
  private event(kind:RuntimeEventKind,detail:object):RuntimeEvent{
    return {sequence:++this.sequence,kind,detail:JSON.parse(redactRuntimeDetail(detail,this.secrets))};
  }
  push(chunk:Uint8Array):RuntimeEvent[]{
    if(this.ended){this.fail();return []}if(this.reason!==null)return [];
    this.bytes+=chunk.byteLength;if(this.bytes>this.limits.maxStreamBytes)return this.fail();
    try{return this.consume(this.decoder.decode(chunk,{stream:true}))}catch{return this.fail()}
  }
  private consume(decoded:string):RuntimeEvent[]{
    const events:RuntimeEvent[]=[];this.pending+=decoded;
    for(let end;(end=this.pending.indexOf('\n'))>=0&&this.reason===null;){
      const line=this.pending.slice(0,end);this.pending=this.pending.slice(end+1);
      if(Buffer.byteLength(line)>this.limits.maxEventBytes)return this.fail();
      if(line.trim())events.push(...this.line(line));
    }
    if(Buffer.byteLength(this.pending)>this.limits.maxEventBytes)return this.fail();
    return events;
  }
  private line(line:string):RuntimeEvent[]{
    // Bound nesting before JSON.parse; braces inside quoted strings do not count.
    let depth=0,quoted=false,escaped=false;
    for(const char of line){
      if(quoted){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quoted=false;continue}
      if(char==='"')quoted=true;else if(char==='{'||char==='['){if(++depth>32)return this.fail()}
      else if(char==='}'||char===']')depth--;
    }
    const event=JSON.parse(line) as Record<string,any>;
    if(!event||typeof event!=='object'||Array.isArray(event)||typeof event.type!=='string')return this.fail();
    if(event.type==='error'||event.type==='turn.failed')return this.fail('provider_error');
    if(this.terminal!==null)return this.fail();
    if(event.type==='thread.started'){
      if(this.sessionId!==null||!this.uuid(event.thread_id)
        ||this.expectedSessionId!==null&&event.thread_id!==this.expectedSessionId)return this.fail();
      this.sessionId=event.thread_id;return [this.event('session',{sessionId:this.sessionId})];
    }
    if(this.sessionId===null)return this.fail();
    if(event.type==='turn.started')return [];
    if(event.type==='turn.completed'){
      const usage=event.usage;
      if(usage!==undefined&&(!usage||typeof usage!=='object'||Array.isArray(usage)))return this.fail();
      const count=(key:string):number|null=>{
        const value=usage?.[key];if(value===undefined)return null;integer(value,0);return value;
      };
      const detail={scope:'attempt',inputTokens:count('input_tokens'),cachedInputTokens:count('cached_input_tokens'),
        outputTokens:count('output_tokens'),costUsd:null};
      // Validate additional reported counts even when not projected publicly.
      count('cache_write_input_tokens');count('reasoning_output_tokens');
      this.terminal='success';return [this.event('usage',detail),this.event('provider_terminal',{outcome:'success'})];
    }
    if(!['item.started','item.updated','item.completed'].includes(event.type))return this.fail();
    const item=event.item;
    if(!item||typeof item!=='object'||typeof item.id!=='string'||!item.id||item.id.length>256)return this.fail();
    if(item.type==='error')return this.fail('provider_error');
    if(item.type==='agent_message'){
      if(typeof item.text!=='string')return this.fail();
      return event.type==='item.completed'?[this.event('text',{text:item.text})]:[];
    }
    if(item.type==='reasoning'||item.type==='todo_list')return [];
    if(!['command_execution','file_change','mcp_tool_call'].includes(item.type))return this.fail();
    const detail:{id:string;name:string;status?:string;exitCode?:number|null}={id:item.id,name:item.type};
    if(event.type==='item.completed'){
      if(!['completed','failed'].includes(item.status))return this.fail();
      detail.status=item.status;
      if(item.type==='command_execution'){
        if(item.exit_code!==null&&(!Number.isSafeInteger(item.exit_code)||item.exit_code<0))return this.fail();
        detail.exitCode=item.exit_code;
      }
      return [this.event('tool_finish',detail)];
    }
    return event.type==='item.started'?[this.event('tool_start',detail)]:[];
  }
  end():RuntimeEvent[]{
    if(this.ended)return [];this.ended=true;if(this.reason!==null)return [];
    try{
      const events=this.consume(this.decoder.decode());
      if(this.pending.trim())events.push(...this.line(this.pending));this.pending='';
      if(this.terminal===null||this.sessionId===null)this.fail();return events;
    }catch{return this.fail()}
  }
  result():{sessionId:string|null;terminal:'success'|'failure'|null;reason:RuntimeReason|null}{
    return {sessionId:this.sessionId,terminal:this.terminal,reason:this.reason};
  }
}
