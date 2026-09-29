import { afterEach, expect, it } from 'vitest';
import * as core from '../src/index.js';
import * as race from './fixtures/execution_race.mjs';
import type { RaceRequest } from './fixtures/execution_race.mjs';
import { memoryFixture, cleanupFixtures } from './memory_fixture.js';
afterEach(cleanupFixtures);

it('persists one winner in twenty actual process memory CAS races and leaves active rules unchanged',async()=>{
  const f=memoryFixture(), rule=f.draft('rule','Project policy');
  core.writeMemory(f.handle,rule,f.proof(rule,'create','user'));
  const rules=core.memoryRules(f.handle,f.view);
  for(let round=0;round<20;round++) {
    const draft:core.MemoryWriteInput={...f.draft('candidate',`round-${round}`),commandId:`initial-${round}`,
      source:{kind:'host',ref:'fixture:race'},author:{type:'ai',id:'fixture'}};
    const initial=core.writeMemory(f.handle,draft);
    const requests=['left','right'].map(side=>({op:'memory' as const,input:{...draft,
      commandId:`race-${round}-${side}`,entryId:initial.entryId,expectedRevision:1,body:side}}));
    const replies=await race.runRace(f.dbPath,requests as [RaceRequest,RaceRequest]);
    expect(replies.filter(r=>r.ok)).toHaveLength(1);
    expect(replies.find(r=>!r.ok)?.error).toMatch(/stale memory revision/);
    expect(f.db.prepare('SELECT count(*) n FROM memory_revisions WHERE entry_id=?').get(initial.entryId)).toEqual({n:2});
    expect(core.memoryEntry(f.handle,f.view,initial.entryId)).toMatchObject({currentRevision:2,revision:2});
    expect(f.db.prepare("SELECT count(*) n FROM events WHERE action='memory_revision' AND json_extract(detail,'$.entryId')=?")
      .get(initial.entryId)).toEqual({n:2});
  }
  expect(core.memoryRules(f.handle,f.view)).toEqual(rules);
},120000);
it('rolls back the actual uncommitted child write after SIGKILL and survives reopening',async()=>{
  const f=memoryFixture(), draft={...f.draft('candidate','Before crash'),source:{kind:'host' as const,ref:'fixture:race'}};
  const entry=core.writeMemory(f.handle,draft),before=f.rows();
  await race.crashMemoryWrite(f.dbPath,{...draft,commandId:'crash',entryId:entry.entryId,expectedRevision:1,body:'uncommitted'});
  const reopened=core.openDb(f.dbPath);
  try {
    expect(reopened.prepare('SELECT * FROM memory_entries ORDER BY id').all()).toEqual(before.entries);
    expect(reopened.prepare('SELECT * FROM memory_revisions ORDER BY entry_id,revision').all()).toEqual(before.revisions);
    expect(reopened.prepare("SELECT * FROM events WHERE action LIKE 'memory_%' ORDER BY id").all()).toEqual(before.events);
    expect(core.memoryEntry(core.openController(reopened),f.view,entry.entryId).body).toBe('Before crash');
  } finally { reopened.close(); }
});
