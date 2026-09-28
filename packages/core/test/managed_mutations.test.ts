import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import * as core from '../src/index.js';

let root: string, db: Database.Database, protectedId: number, legacyId: number, criterionId: number, fileId: number, trackId: number, source: string;
const user = { type: 'user' } as const;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kdd-managed-')); db = core.openDb(join(root, 'board.db'), root);
  trackId = core.createTrack(db, { name: 'shared' }).id;
  protectedId = core.addTask(db, { title: 'protected', track_id: trackId, criteria: ['prove it'], priority: 'high' }, user).id;
  legacyId = core.addTask(db, { title: 'legacy', track_id: trackId, criteria: ['legacy'] }, user).id;
  criterionId = core.listCriteria(db, protectedId)[0].id;
  source = join(root, 'input.txt'); writeFileSync(source, 'original blob');
  fileId = core.attachFile(db, db.name, protectedId, source, {}, user).id;
  core.protectTask(core.openController(db), protectedId);
});
afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
function snapshot() {
  return { rows: ['tasks', 'criteria', 'comments', 'events', 'task_links', 'files', 'tracks', 'managed_task_policy', 'run_authorities', 'agent_events']
    .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
  blobs: readdirSync(core.filesDir(db.name)).sort().map(name => [name, readFileSync(join(core.filesDir(db.name), name)).toString('hex')]) };
}
it('refuses every legacy task writer, including no-ops and hidden owners, without row/blob effects', () => {
  const actors: core.Actor[] = [user, { type: 'ai', id: 'worker' }, { type: 'ai', id: 'owner', manualSession: { client: 'codex', cwd: root, sessionId: 'forged' } }];
  for (const actor of actors) {
    const attempts: (() => unknown)[] = [
      () => core.editTask(db, protectedId, { title: 'changed' }, actor),
      () => core.commentTask(db, protectedId, 'report', actor),
      () => core.moveTask(db, protectedId, 'in_progress', actor, 'user approved'),
      () => core.placeTask(db, protectedId, 'new', [protectedId], actor),
      () => core.placeTask(db, legacyId, 'new', [legacyId, protectedId], actor),
      () => core.blockTask(db, protectedId, 'needs human', actor),
      () => core.unblockTask(db, protectedId, actor),
      () => core.archiveTask(db, protectedId, actor), () => core.unarchiveTask(db, protectedId, actor),
      () => core.linkTasks(db, legacyId, protectedId, 'depends', actor),
      () => core.linkTasks(db, protectedId, legacyId, 'depends', actor),
      () => core.addCriterion(db, protectedId, 'new criterion', actor),
      () => core.setCriterionChecked(db, protectedId, criterionId, true, actor, 'proof'),
      () => core.setCriterionChecked(db, protectedId, criterionId, false, actor),
      () => core.setCriterionChecked(db, legacyId, criterionId, true, actor),
      () => core.removeCriterion(db, legacyId, criterionId, actor),
      () => core.removeCriterion(db, protectedId, criterionId, actor),
      () => core.attachFile(db, db.name, protectedId, source, { description: 'new' }, actor),
      () => core.attachFile(db, db.name, protectedId, join(root, 'missing'), {}, actor),
      () => core.detachFile(db, db.name, fileId, actor),
      () => core.deleteTrack(db, trackId),
      () => core.recordFailedAttempt(db, protectedId, actor, 'fail'),
      () => core.releaseClaim(db, protectedId, actor, 'release'),
      () => core.claimTask(db, protectedId, actor),
      () => core.renewClaim(db, protectedId, actor),
    ];
    for (const attempt of attempts) {
      const before = snapshot(); expect(attempt).toThrow(/managed/); expect(snapshot()).toEqual(before);
    }
  }
});
it('excludes managed tasks from claimNext, reclaim, reap and stop, including process effects', () => {
  const worker = { type: 'ai', id: 'tick:fixture' } as const;
  expect(core.claimNext(db, worker, 60, { reclaim: false })?.id).toBe(legacyId);
  db.prepare("UPDATE tasks SET status='in_progress',claimed_by='ai:tick:managed',claim_expires=0 WHERE id=?").run(protectedId);
  db.prepare('UPDATE tasks SET claim_expires=0 WHERE id=?').run(legacyId);
  const beforeProtected = db.prepare('SELECT * FROM tasks WHERE id=?').get(protectedId);
  const killed: number[] = [];
  const kill: core.KillFn = ids => { killed.push(...ids); return new Map(ids.map(id => [id, 'gone'])); };
  expect(core.expiredLeases(db).map(row => row.id)).toEqual([legacyId]);
  expect(core.reapExpired(db, kill).reclaimed.map(row => row.id)).toEqual([legacyId]);
  expect(killed).toEqual([legacyId]);
  expect(core.reclaimExpired(db)).toEqual([]);
  expect(core.stopWorkers(db, kill)).toEqual({ killed: 0, released: 0, stuck: 0 });
  expect(db.prepare('SELECT * FROM tasks WHERE id=?').get(protectedId)).toEqual(beforeProtected);
  expect(core.claimNext(db, user, 60, { reclaim: false })?.id).toBe(legacyId);
});
it('rejects a direct managed claim before reaping any unrelated expired worker', () => {
  db.prepare("UPDATE tasks SET status='in_progress',claimed_by='ai:tick:legacy',claim_expires=0 WHERE id=?").run(legacyId);
  const before = snapshot(); let called = false;
  expect(() => core.claimTask(db, protectedId, user, 60, { kill: () => { called = true; return new Map(); } })).toThrow(/managed/);
  expect(called).toBe(false); expect(snapshot()).toEqual(before);
});
it('rejects unknown SQL patch keys instead of letting a legacy target alter a protected row', () => {
  const before = snapshot();
  const key = `title = CASE WHEN id=${protectedId} THEN 'hacked' ELSE ? END WHERE id IN (${protectedId},${legacyId}) AND ? AND ? --`;
  expect(() => core.editTask(db, legacyId, { [key]: 'legacy' } as never, user)).toThrow();
  expect(snapshot()).toEqual(before);
});
it('protects an idle handoff through the common legacy guard without creating a managed marker',()=>{
  const handle=core.openController(db),ref={projectId:core.projectOf(db).project_id,taskId:legacyId};
  core.beginHandoff(handle,{commandId:'idle-mode',task:ref,expectedMode:'manual',targetMode:'orchestrated',expectedOwners:[]});
  const before=snapshot();
  for(const attempt of [()=>core.moveTask(db,legacyId,'done',user,'user approved'),()=>core.commentTask(db,legacyId,'ready',user),
    ()=>core.editTask(db,legacyId,{body:'changed'},user),()=>core.claimTask(db,legacyId,user),
    ()=>core.placeTask(db,legacyId,'new',[legacyId],user),()=>core.addCriterion(db,legacyId,'new',user)]) {
    expect(attempt).toThrow(/handoff/);expect(snapshot()).toEqual(before);
  }
  expect(core.taskBrief(db,join(root,'decisions'),legacyId).next_action.kind).toBe('await_controller');
});
