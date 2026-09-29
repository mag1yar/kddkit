import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import * as core from '../src/index.js';
import { memoryFixture, cleanupFixtures, fixtureHash } from './memory_fixture.js';
afterEach(cleanupFixtures);

it('upgrades a populated v15 WAL store without rewriting any old rows', () => {
  const f = memoryFixture(), path = join(f.home, 'legacy.db'), raw = new Database(path);
  process.env.KDD_HOME = join(f.root, 'legacy-home');
  let upgraded: Database.Database | undefined, backup: Database.Database | undefined;
  try {
    raw.pragma('foreign_keys=ON'); raw.pragma('journal_mode=WAL'); raw.pragma('wal_autocheckpoint=0');
    for (const sql of core.MIGRATIONS.slice(0, 15)) raw.exec(sql);
    raw.pragma('user_version=15');
    const repoId = 'a'.repeat(32), work = 'b'.repeat(32), consumer = 'c'.repeat(32);
    raw.prepare('INSERT INTO repositories VALUES(?,?,?,?,?)').run(repoId, 'primary', 'implementation', null, 1);
    raw.prepare('UPDATE project SET primary_repo_id=?,legacy_decisions_dir=?').run(repoId, join(f.repo, '.planning', 'decisions'));
    raw.prepare('INSERT INTO repository_bindings VALUES(?,?,?,?,?)').run(core.canonicalCommonDir(f.repo), repoId, f.repo, 'source', 1);
    raw.prepare("INSERT INTO meta VALUES('project_path',?)").run(core.canonicalCommonDir(f.repo));
    raw.prepare("INSERT INTO meta VALUES('project_toplevel',?)").run(f.repo);
    raw.exec(`INSERT INTO tracks VALUES(8,'retained','keep','active',1);
      INSERT INTO tasks(id,title,status,created_at,updated_at,track_id) VALUES(41,'old','new',1,1,8),(42,'child','new',1,1,8);
      UPDATE tasks SET parent_id=41 WHERE id=42;
      INSERT INTO criteria(id,task_id,text,checked_at,created_at,evidence,checked_by) VALUES(9,41,'keep',2,1,'keep','user');
      INSERT INTO comments VALUES(7,41,'user','keep comment',1);
      INSERT INTO events(id,task_id,actor_type,action,detail,created_at) VALUES(6,41,'user','created','{"keep":true}',1);
      INSERT INTO task_links VALUES(42,41,'depends_on');
      INSERT INTO agent_events VALUES(4,41,'old','text',NULL,'keep',1);
      INSERT INTO errors VALUES(2,'old','keep',1);
      INSERT INTO managed_task_policy VALUES(41,1,'old');
      INSERT INTO run_authorities VALUES('old-authority',41,'external-work','old-run',1,1,NULL,'old-hash','{"keep":true}',1);`);
    raw.prepare('INSERT INTO decisions VALUES(?,?,?,?,?,?,?)').run('keep','Keep','old.md','old-hash','2026-01-01',null,'[41]');
    raw.prepare('INSERT INTO search_index VALUES(?,?,?,?)').run('decision','keep','Keep','retainedtoken');
    raw.transaction(() => {
      for (const id of [work, consumer]) {
        raw.prepare('INSERT INTO work_items(id,task_id,current_revision,created_at) VALUES(?,41,1,1)').run(id);
        raw.prepare('INSERT INTO work_item_revisions VALUES(?,1,?,?,?,1)').run(id,
          JSON.stringify({ kind: 'analysis', repoId: null, sourceTasks: [], outputs: [] }), '[]', 'd'.repeat(64));
      }
      raw.prepare("INSERT INTO work_item_results VALUES('old-result','old-command','old-hash',?,1,'api','contract','{}','{}',1,NULL,NULL,NULL)").run(work);
      raw.prepare("INSERT INTO work_item_dependencies VALUES(?,1,'api',?,1,'contract','api','{}','old-result')").run(consumer, work);
      raw.prepare("INSERT INTO execution_handoffs VALUES('old-handoff','old-handoff-command',41,'manual','orchestrated','{}',1,NULL,NULL)").run();
      raw.prepare("INSERT INTO work_item_owners VALUES(?,1,1,'old-owner','manual',0,'[]',NULL,NULL,1,NULL,NULL)").run(work);
    }).immediate();
    const tables = ['tasks','criteria','comments','events','tracks','task_links','decisions','search_index','agent_events','errors','meta','project','repositories','repository_bindings','managed_task_policy','run_authorities',
      'files','work_items','work_item_revisions','work_item_results','work_item_dependencies','work_item_owners','execution_handoffs'];
    const snapshot = (db: Database.Database) => tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const before = snapshot(raw);
    expect(statSync(path + '-wal').size).toBeGreaterThan(0);
    upgraded = core.openDb(path, core.canonicalCommonDir(f.repo), f.repo);
    expect(upgraded.pragma('user_version', { simple: true })).toBe(16);
    expect(snapshot(upgraded)).toEqual(before);
    expect(upgraded.prepare('SELECT count(*) n FROM memory_entries').get()).toEqual({ n: 0 });
    backup = new Database(path + '.v15.bak', { readonly: true });
    expect(backup.pragma('user_version', { simple: true })).toBe(15);
    expect(snapshot(backup)).toEqual(before);
    expect(upgraded.pragma('foreign_key_check')).toEqual([]);
    upgraded.close(); upgraded = core.openDb(path);
    expect(snapshot(upgraded)).toEqual(before);
    expect(upgraded.prepare('SELECT count(*) n FROM memory_revisions').get()).toEqual({ n: 0 });
  } finally { backup?.close(); upgraded?.close(); raw.close(); }
});

it('requires exact user evidence and leaves historical payload and proof immutable', () => {
  const f = memoryFixture(), input = f.draft('rule', 'Keep history'), before = f.rows();
  expect(() => core.writeMemory(f.handle, input)).toThrow(); expect(f.rows()).toEqual(before);
  const first = core.writeMemory(f.handle, input, f.proof(input, 'create', 'user'));
  const next = { ...input, commandId: 'second', entryId: first.entryId, expectedRevision: 1, body: 'Use revisions' };
  expect(() => core.writeMemory(f.handle, next, f.proof(input, 'create', 'user'))).toThrow();
  const second = core.writeMemory(f.handle, next, f.proof(next, 'revise', 'user'));
  expect(second).toMatchObject({ revision: 2, currentRevision: 2, created: true });
  expect(first.hash).toBe(fixtureHash(input));
  const row = f.db.prepare('SELECT body,content_hash,evidence_json FROM memory_revisions WHERE entry_id=? AND revision=1').get(first.entryId) as {body:string;content_hash:string;evidence_json:string};
  expect(row.body).toBe('Keep history'); expect(row.content_hash).toBe(first.hash);
  expect(JSON.parse(row.evidence_json)[0]).toMatchObject({ origin:'user', verdict:'pass' });
  for (const sql of ['DELETE FROM memory_revisions WHERE entry_id=?', "UPDATE memory_revisions SET body='erase' WHERE entry_id=?", 'DELETE FROM memory_entries WHERE id=?', 'UPDATE memory_entries SET task_id=99 WHERE id=?', 'UPDATE memory_entries SET current_revision=1 WHERE id=?'])
    expect(() => f.db.prepare(sql).run(first.entryId)).toThrow();
});
it('stores the verified payload even when a host observer mutates the original request object',()=>{
  const f=memoryFixture(),input=f.draft('rule','Verified body'),confirmed=f.proof(input,'create','user');
  const expected=fixtureHash(input);
  const result=core.writeMemory(f.handle,input,{observe:request=>{
    const receipt=confirmed.observe!(request);
    input.body='Unconfirmed replacement';input.scope.taskId=f.task('different scope').id;
    return receipt;
  }});
  const stored=core.memoryEntry(f.handle,f.view,result.entryId);
  expect(stored.body).toBe('Verified body');expect(stored.scope.taskId).toBeNull();expect(stored.hash).toBe(expected);
  expect(stored.evidence[0].request.payloadHash).toBe(stored.hash);
});

it('replays the original command after acceptance and withdrawal without restoring its head', () => {
  const f = memoryFixture(), input = f.draft('candidate', 'proposal');
  const first = core.writeMemory(f.handle, input, f.proof(input, 'create', 'user'));
  const accepted = { ...input, commandId:'accepted', entryId:first.entryId, expectedRevision:1, kind:'rule' as const };
  core.writeMemory(f.handle, accepted, f.proof(accepted, 'accept', 'user'));
  const withdrawn = { ...accepted, commandId:'withdrawn', expectedRevision:2, status:'withdrawn' as const };
  core.writeMemory(f.handle, withdrawn, f.proof(withdrawn, 'withdraw', 'user'));
  const before = f.rows();
  expect(core.writeMemory(f.handle, input, f.proof(input, 'create', 'user'))).toMatchObject({ revision:1,currentRevision:3,effectiveStatus:'superseded',created:false });
  expect(core.writeMemory(f.handle, accepted, f.proof(accepted, 'accept', 'user'))).toMatchObject({ revision:2,currentRevision:3,effectiveStatus:'superseded',created:false });
  expect(core.writeMemory(f.handle, withdrawn, f.proof(withdrawn, 'withdraw', 'user'))).toMatchObject({ revision:3,currentRevision:3,effectiveStatus:'withdrawn',created:false });
  expect(f.rows()).toEqual(before);
  const altered = { ...input, body:'changed' };
  expect(() => core.writeMemory(f.handle, altered, f.proof(altered,'create','user'))).toThrow(/command/);
  expect(f.rows()).toEqual(before);
});

it.each(['missing','fail','inconclusive','hash','origin','scope','operation','future','expired','throw'])(
  'rejects %s evidence without a partial revision or audit event', mode => {
    const f = memoryFixture(), input = f.draft('rule','Verified only'), before = f.rows();
    const good = f.proof(input,'create','user');
    const observers: core.MemoryObservers = { observe: request => {
      if (mode === 'throw') throw new Error('private callback detail');
      if (mode === 'missing') return null;
      const observation = structuredClone(good.observe!(request)!);
      if (mode === 'fail' || mode === 'inconclusive') observation.verdict = mode;
      if (mode === 'hash') observation.request.payloadHash = '0'.repeat(64);
      if (mode === 'origin') observation.origin = 'host';
      if (mode === 'scope') observation.request.scope.taskId = 999;
      if (mode === 'operation') observation.request.operation = 'revise';
      if (mode === 'future') observation.observedAt = core.now()+60;
      if (mode === 'expired') observation.expiresAt = core.now()-1;
      return observation;
    } };
    expect(() => core.writeMemory(f.handle,input,observers)).toThrow();
    expect(f.rows()).toEqual(before);
  });

it('requires host fact evidence independently of user source attribution', () => {
  const f = memoryFixture(), input = { ...f.draft('fact','Environment ready'), source:{kind:'user' as const,ref:'fixture:answer'} };
  for (const origin of ['user','host'] as const) expect(() => core.writeMemory(f.handle,input,f.proof(input,'create',origin))).toThrow();
  expect(core.writeMemory(f.handle,input,f.proof(input,'create',['user','host']))).toMatchObject({ revision:1 });
});

it('denies forged handles, foreign projects and invalid scope or immutable identity', () => {
  const f = memoryFixture(), input = f.draft('candidate','scope'), first = core.writeMemory(f.handle,input,f.proof(input,'create','user'));
  const before = f.rows();
  expect(() => core.writeMemory(JSON.parse(JSON.stringify(f.handle)),input,f.proof(input,'create','user'))).toThrow();
  for (const changed of [{ scope:{projectId:'e'.repeat(32),taskId:null} }, { scope:{...f.scope,taskId:999} },
    { applicability:{repoId:'f'.repeat(32),commit:null} }, { applicability:{repoId:null,commit:'main'} },
    { author:{type:'owner' as never,id:null} }, { source:{kind:'host' as const,ref:''} }]) {
    const bad = { ...input,commandId:'bad',...changed };
    expect(() => core.writeMemory(f.handle,bad,f.proof(bad,'create','user'))).toThrow();
  }
  const changed = { ...input,commandId:'immutable',entryId:first.entryId,expectedRevision:1,scope:{...f.scope,taskId:f.task('other').id} };
  expect(() => core.writeMemory(f.handle,changed,f.proof(changed,'revise','user'))).toThrow();
  expect(f.rows()).toEqual(before);
});

it('does not let an agent candidate replace an active rule', () => {
  const f = memoryFixture(), input = f.draft('rule','Owner rule'), first = core.writeMemory(f.handle,input,f.proof(input,'create','user'));
  const candidate = { ...input,commandId:'replacement',entryId:first.entryId,expectedRevision:1,kind:'candidate' as const,
    source:{kind:'host' as const,ref:'fixture:proposal'},author:{type:'ai' as const,id:'agent'} };
  const before = f.rows(); expect(() => core.writeMemory(f.handle,candidate)).toThrow(); expect(f.rows()).toEqual(before);
  const independent = { ...candidate,commandId:'separate',entryId:null,expectedRevision:0,
    source:{kind:'revision' as const,ref:{projectId:f.projectId,entryId:first.entryId,revision:1},hash:first.hash} };
  const proposal = core.writeMemory(f.handle,independent);
  expect(proposal.entryId).not.toBe(first.entryId);
  expect(f.db.prepare('SELECT current_revision FROM memory_entries WHERE id=?').get(first.entryId)).toEqual({current_revision:1});
});

it('rejects secrets and overflow and rolls back a failed audit write', () => {
  const f = memoryFixture(), input = f.draft('candidate','safe'), before = f.rows();
  for (const body of ['sk-proj-' + 'x'.repeat(40),'x'.repeat(core.CAPS.bodyChars+1)]) {
    const bad = { ...input,body };
    expect(() => core.writeMemory(f.handle,bad,f.proof(bad,'create','user'))).toThrow();
  }
  f.db.exec("CREATE TRIGGER reject_memory_event BEFORE INSERT ON events WHEN NEW.action='memory_revision' BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END");
  expect(() => core.writeMemory(f.handle,input,f.proof(input,'create','user'))).toThrow(/audit/);
  expect(f.rows()).toEqual(before);
});
it.each(['repository','uncloneable'] as const)('does not echo private values in %s payloads',mode=>{
  const f=memoryFixture(),secret='sk-proj-'+'x'.repeat(40);
  const input={...f.draft('candidate','safe'),source:{kind:'host' as const,ref:'fixture:proposal'}};
  core.writeMemory(f.handle,input);const before=f.rows();
  const patch=mode==='repository' ? {applicability:{repoId:secret,commit:null}} :
    {body:new Function(`return '${secret}'`) as never};
    let error:Error|undefined;
    try{core.writeMemory(f.handle,{...input,commandId:'invalid-private',...patch});}catch(e){error=e as Error;}
    expect(error).toBeDefined();expect(error!.message).not.toContain(secret);expect(f.rows()).toEqual(before);
});
it('rejects malformed Unicode before SQLite can replace bytes covered by the hash',()=>{
  const f=memoryFixture(),input={...f.draft('candidate','valid 🧠'),title:'valid 🚀',
    source:{kind:'host' as const,ref:'fixture:proposal'}},before=f.rows();
  for(const field of ['title','body'])for(const malformed of ['\uD800','\uDC00'])
    expect(()=>core.writeMemory(f.handle,{...input,[field]:malformed})).toThrow(/text/);
  expect(f.rows()).toEqual(before);
  const receipt=core.writeMemory(f.handle,input),stored=core.memoryEntry(f.handle,{scope:input.scope,repositories:[]},receipt.entryId);
  expect(stored.title).toBe(input.title);expect(stored.body).toBe(input.body);expect(stored.hash).toBe(fixtureHash(input));
});
