import { afterEach, expect, it } from 'vitest';
import * as core from '../src/index.js';
import { cleanupFixtures, fixture } from './execution_fixture.js';
import { runRace } from './fixtures/execution_race.mjs';
afterEach(cleanupFixtures);
const definition:core.WorkItemDefinition={kind:'analysis',repoId:null,sourceTasks:[],
  outputs:[{key:'contract',kind:'contract',required:true,version:'v1',checkRefs:[]}]};
it('serializes twenty opposing-edge races across separate processes and persists one DAG edge',async()=>{
  const f=fixture();
  for(let round=0;round<20;round++) {
    const a=core.createWorkItem(f.handle,{task:f.ref(f.task('a'+round).id),definition,dependencies:[]});
    const b=core.createWorkItem(f.handle,{task:f.ref(f.task('b'+round).id),definition,dependencies:[]});
    const proposal=(consumer:core.WorkItemRecord,producer:core.WorkItemRecord)=>({ref:consumer.ref,expectedRevision:1,definition,
      dependencies:[{key:'needs',producer:producer.ref,producerRevision:1,outputKey:'contract',binding:{kind:'contract' as const,repoId:null,version:'v1'}}]});
    const before=(f.db.prepare("SELECT count(*) n FROM events WHERE action='work_item_revised'").get() as {n:number}).n;
    const outcomes=await runRace(f.dbPath,[{op:'revise',input:proposal(a,b)},{op:'revise',input:proposal(b,a)}]);
    expect(outcomes.filter(o=>o.ok)).toHaveLength(1);expect(outcomes.find(o=>!o.ok)?.error).toMatch(/cycle|revision/);
    const current=[core.workItem(f.handle,a.ref),core.workItem(f.handle,b.ref)];
    expect(current.flatMap(w=>w.dependencies)).toHaveLength(1);
    expect(current.map(w=>w.revision).sort()).toEqual([1,2]);
    expect((f.db.prepare("SELECT count(*) n FROM events WHERE action='work_item_revised'").get() as {n:number}).n).toBe(before+1);
    expect(f.db.prepare(`WITH RECURSIVE active(c,p) AS (SELECT d.consumer_id,d.producer_id FROM work_item_dependencies d
      JOIN work_items w ON w.id=d.consumer_id AND w.current_revision=d.consumer_revision),
      paths(c,p) AS (SELECT c,p FROM active UNION SELECT paths.c,active.p FROM paths JOIN active ON active.c=paths.p)
      SELECT 1 FROM paths WHERE c=p LIMIT 1`).get()).toBeUndefined();
  }
},120000);
it('keeps one live owner in twenty separate-process reservation races, and allows independent items',async()=>{
  const f=fixture();
  const create=(name:string)=>core.createWorkItem(f.handle,{task:f.ref(f.task(name).id),
    definition:{kind:'implementation',repoId:null,sourceTasks:[],outputs:[]},dependencies:[]});
  const input=(item:core.WorkItemRecord,ownerId:string):core.ReserveWorkItemInput=>({ref:item.ref,expectedRevision:1,
    expectedFence:0,expectedMode:'manual',ownerId,write:true});
  for(let round=0;round<20;round++) {
    const item=create('owner'+round);
    const outcomes=await runRace(f.dbPath,[{op:'reserve',input:input(item,'a')},{op:'reserve',input:input(item,'b')}]);
    expect(outcomes.filter(o=>o.ok)).toHaveLength(1);expect(outcomes.find(o=>!o.ok)?.error).toMatch(/owner|fence/);
    expect(f.db.prepare('SELECT count(*) n FROM work_item_owners WHERE work_item_id=? AND released_at IS NULL').get(item.ref.workItemId)).toEqual({n:1});
    expect(core.workItem(f.handle,item.ref).fence).toBe(1);
    expect(f.db.prepare("SELECT count(*) n FROM events WHERE action='work_item_reserved' AND json_extract(detail,'$.work_item_id')=?").get(item.ref.workItemId)).toEqual({n:1});
  }
  const a=create('independent-a'),b=create('independent-b');
  const independent=await runRace(f.dbPath,[{op:'reserve',input:input(a,'a')},{op:'reserve',input:input(b,'b')}]);
  expect(independent.map(o=>o.ok)).toEqual([true,true]);
  expect(f.db.prepare('SELECT count(*) n FROM work_item_owners WHERE work_item_id IN (?,?) AND released_at IS NULL').get(a.ref.workItemId,b.ref.workItemId)).toEqual({n:2});
},120000);
