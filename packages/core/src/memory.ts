import type Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { controllerDb, type ControllerHandle } from './controller.js';
import { now } from './db.js';
import { KddError } from './errors.js';
import { appendEvent } from './ops.js';
import { projectOf, bindingsOf, canonicalCommonDir } from './project_store.js';
import { shape, text, integer, scopedTask, checkRepo, canonical, digest, newId,
  type TaskRef, type AuthorityBinding } from './execution.js';
import { CAPS } from './caps.js';
import { redact } from './agent_events.js';
import { readMemoryDocument } from './memory_import.js';
import { assertRunMemorySource } from './authority.js';

export type MemoryKind = 'fact' | 'decision' | 'rule' | 'candidate';
export type MemoryStatus = 'active' | 'withdrawn';
export interface MemoryScope { projectId: string; taskId: number | null }
export interface MemoryApplicability { repoId: string | null; commit: string | null }
export interface MemoryRepoVersion { repoId: string; checkoutPath: string; commit: string }
export interface MemoryView { scope: MemoryScope; repositories: readonly MemoryRepoVersion[] }
export interface MemoryRevisionRef { projectId: string; entryId: string; revision: number }
export interface MemoryAuthor { type: 'user' | 'ai'; id: string | null }
export type MemorySource =
  | { kind: 'user'; ref: string }
  | { kind: 'host'; ref: string }
  | { kind: 'run'; task: TaskRef; authority: AuthorityBinding; reportEventId: number }
  | { kind: 'git'; repoId: string; commit: string; path: string; sha256: string;
      documentStatus: 'active' | 'superseded' | 'unknown' | null }
  | { kind: 'revision'; ref: MemoryRevisionRef; hash: string };
export interface MemoryDraft {
  scope: MemoryScope; applicability: MemoryApplicability; kind: MemoryKind; status: MemoryStatus;
  title: string; body: string; source: MemorySource; author: MemoryAuthor;
}
export interface MemoryWriteInput extends MemoryDraft { commandId: string; entryId: string | null; expectedRevision: number }
export type MemoryOperation = 'create' | 'revise' | 'withdraw' | 'accept' | 'import';
export interface MemoryEvidenceRequest {
  operation: MemoryOperation; entryId: string | null; expectedRevision: number; origin: 'user' | 'host';
  scope: MemoryScope; applicability: MemoryApplicability; payloadHash: string; source: MemorySource;
}
export interface MemoryEvidenceObservation {
  request: MemoryEvidenceRequest; origin: 'user' | 'host'; verdict: 'pass' | 'fail' | 'inconclusive';
  observedAt: number; expiresAt: number | null;
}
export interface MemoryObservers { observe?: (request: MemoryEvidenceRequest) => MemoryEvidenceObservation | null }
export interface MemoryReceipt {
  entryId: string; revision: number; currentRevision: number; hash: string;
  created: boolean; effectiveStatus: MemoryStatus | 'superseded';
}
export interface MemoryRecord extends MemoryDraft {
  entryId: string; revision: number; currentRevision: number; predecessor: number | null;
  hash: string; createdAt: number; evidence: readonly MemoryEvidenceObservation[];
  effectiveStatus: MemoryStatus | 'superseded';
}
export interface MemoryReadOptions { candidates?: boolean; withdrawn?: boolean }
export interface MemoryRecallOptions extends MemoryReadOptions { k?: number }
export interface MemoryHit {
  ref: MemoryRevisionRef; hash: string; kind: MemoryKind; status: MemoryStatus;
  effectiveStatus: MemoryStatus | 'superseded'; title: string; snippet: string;
  source: MemorySource; scope: MemoryScope; applicability: MemoryApplicability;
}

// Internal helpers; the barrel exports only operations requiring opaque authority.
export function memoryScope(db: Database.Database, scope: MemoryScope): void {
  shape(scope, ['projectId','taskId']);
  if (scope.projectId !== projectOf(db).project_id) throw new KddError('foreign project reference');
  if (scope.taskId !== null) scopedTask(db, { projectId: scope.projectId, taskId: scope.taskId });
}
export function memoryHex(value: unknown, sizes: readonly number[]): asserts value is string {
  if (typeof value !== 'string' || !sizes.includes(value.length) || !/^[0-9a-f]+$/.test(value)) throw new KddError('invalid memory hash or id');
}
export function safeMemoryText(value: unknown, cap: number): asserts value is string {
  text(value);
  if (value.length > cap) throw new KddError(`memory field exceeds limit ${cap}`);
  // SQLite stores UTF-8; hashing must not precede a lossy encoding conversion.
  if (Buffer.from(value,'utf8').toString('utf8') !== value) throw new KddError('memory requires well-formed text');
  if (redact(value) !== value) throw new KddError('memory contains private credentials');
}
export function memoryPrivatePath(value: string): boolean {
  return /(?:^|[\/\\])(?:\.git|\.codex|\.claude|\.kdd|\.kdd-runtime|\.superpowers|\.npmrc|\.git-credentials|\.netrc|\.env(?:\.[^\/\\]*)?|credentials(?:\.[^\/\\]*)?|id_rsa|id_ed25519)(?:[\/\\]|$)/i.test(value)
    || /(?:^|[\/\\])\.planning[\/\\]runs(?:[\/\\]|$)/i.test(value)
    || /(?:^|[\/\\])(?:\.mcp\.json|config\.toml|settings\.local\.json)(?:$)/i.test(value)
    || /\.(?:pem|key)$/i.test(value);
}
export function memoryCheckout(db: Database.Database, repoId: string, checkoutPath?: string): string {
  checkRepo(db, repoId);
  const candidates = checkoutPath === undefined ? bindingsOf(db).filter(b => b.repo_id === repoId).map(b => b.checkout_path) : [checkoutPath];
  for (const path of candidates) {
    try {
      if (!isAbsolute(path) || realpathSync(path) !== path) continue;
      const common = canonicalCommonDir(path);
      if (bindingsOf(db).some(b => b.repo_id === repoId && b.common_dir === common)) return path;
    } catch { /* a moved binding cannot establish repository identity */ }
  }
  throw new KddError('memory repository binding denied');
}
export function memoryCommit(db: Database.Database, repoId: string, commit: string, checkoutPath?: string): string {
  memoryHex(commit, [40,64]); checkRepo(db,repoId);
  const candidates = checkoutPath === undefined ? bindingsOf(db).filter(b=>b.repo_id===repoId).map(b=>b.checkout_path) : [checkoutPath];
  for (const candidate of candidates) {
    try {
      const path = memoryCheckout(db,repoId,candidate);
      const options = { cwd: path, encoding: 'utf8' as const, stdio: 'pipe' as const, maxBuffer: 4096 };
      if (execFileSync('/usr/bin/git', ['--no-replace-objects','cat-file','-t',commit], options).trim() === 'commit'
        && execFileSync('/usr/bin/git', ['--no-replace-objects','rev-parse','--verify','--end-of-options',`${commit}^{commit}`], options).trim() === commit) return path;
    } catch { /* only an actual commit in a registered binding establishes this version */ }
  }
  throw new KddError('unknown memory repository version or binding');
}
function validateDraft(db: Database.Database, draft: MemoryDraft): void {
  memoryScope(db, draft.scope); shape(draft.applicability,['repoId','commit']);
  const { repoId, commit } = draft.applicability;
  checkRepo(db, repoId);
  if (repoId !== null) memoryHex(repoId,[32]);
  if (commit !== null) {
    if (repoId === null) throw new KddError('memory commit requires repository');
    memoryCommit(db,repoId,commit);
  }
  if (!['fact','decision','rule','candidate'].includes(draft.kind) || !['active','withdrawn'].includes(draft.status)) throw new KddError('invalid memory kind or status');
  if (draft.kind === 'fact' && repoId !== null && commit === null) throw new KddError('code fact requires exact commit');
  safeMemoryText(draft.title,CAPS.agentFieldChars); safeMemoryText(draft.body,CAPS.bodyChars);
  shape(draft.author,['type','id']);
  if (!['user','ai'].includes(draft.author.type)) throw new KddError('invalid memory author');
  if (draft.author.id !== null) safeMemoryText(draft.author.id,CAPS.agentFieldChars);
  for (const field of [draft.source,draft.author]) {
    const json = canonical(field);
    if (Buffer.byteLength(json) > CAPS.agentDetailBytes) throw new KddError(`memory metadata exceeds limit ${CAPS.agentDetailBytes}`);
    if (redact(json) !== json) throw new KddError('memory contains private credentials');
  }
  const source = draft.source;
  if (!source || typeof source !== 'object') throw new KddError('invalid memory source');
  if (source.kind === 'user' || source.kind === 'host') {
    shape(source,['kind','ref']); safeMemoryText(source.ref,CAPS.agentFieldChars);
    if (memoryPrivatePath(source.ref)) throw new KddError('private memory source denied');
  } else if (source.kind === 'revision') {
    shape(source,['kind','ref','hash']); shape(source.ref,['projectId','entryId','revision']);
    if (source.ref.projectId !== draft.scope.projectId) throw new KddError('foreign memory source');
    memoryHex(source.ref.entryId,[32]); integer(source.ref.revision); memoryHex(source.hash,[64]);
    const record = memoryRecordDb(db,source.ref.entryId,source.ref.revision);
    if (record.hash !== source.hash) throw new KddError('memory source hash mismatch');
    if (draft.kind === 'fact' && record.applicability.repoId !== null
      && canonical(record.applicability) !== canonical(draft.applicability)) throw new KddError('code fact source version mismatch');
  } else if (source.kind === 'git') {
    shape(source,['kind','repoId','commit','path','sha256','documentStatus']);
    const document = readMemoryDocument(db,{repoId:source.repoId,commit:source.commit,path:source.path,
      sha256:source.sha256,checkoutPath:memoryCommit(db,source.repoId,source.commit)});
    if (canonical(source) !== canonical(document.source)) throw new KddError('memory Git source mismatch');
    if (draft.kind === 'fact' && (draft.applicability.repoId !== source.repoId || draft.applicability.commit !== source.commit)) throw new KddError('code fact source version mismatch');
  } else if (source.kind === 'run') {
    if (draft.kind !== 'candidate') throw new KddError('run memory requires candidate kind');
    assertRunMemorySource(db,draft.scope,draft.applicability,source,draft.author);
  } else {
    throw new KddError('invalid memory source');
  }
}
export function memoryDraftHash(draft: MemoryDraft): string {
  const { scope,applicability,kind,status,title,body,source,author } = draft;
  return digest({scope,applicability,kind,status,title,body,source,author});
}
export function memoryRecordDb(db: Database.Database, entryId: string, revision?: number): MemoryRecord {
  memoryHex(entryId,[32]); if (revision !== undefined) integer(revision);
  const row = db.prepare(`SELECT e.task_id,e.repo_id,e.applicable_commit,e.current_revision,r.*
    FROM memory_entries e JOIN memory_revisions r ON r.entry_id=e.id
    WHERE e.id=? AND r.revision=${revision === undefined ? 'e.current_revision' : '?'}`)
    .get(...(revision === undefined ? [entryId] : [entryId,revision])) as {
      entry_id:string; revision:number; predecessor:number|null; current_revision:number;
      task_id:number|null; repo_id:string|null; applicable_commit:string|null;
      kind:MemoryKind; status:MemoryStatus; title:string; body:string; source_json:string;
      author_json:string; evidence_json:string; content_hash:string; created_at:number;
    } | undefined;
  if (!row) throw new KddError('memory record unavailable');
  return { entryId:row.entry_id,revision:row.revision,currentRevision:row.current_revision,
    predecessor:row.predecessor,hash:row.content_hash,createdAt:row.created_at,
    kind:row.kind,status:row.status,title:row.title,body:row.body,
    source:JSON.parse(row.source_json),author:JSON.parse(row.author_json),evidence:JSON.parse(row.evidence_json),
    scope:{projectId:projectOf(db).project_id,taskId:row.task_id},
    applicability:{repoId:row.repo_id,commit:row.applicable_commit},
    effectiveStatus:row.revision === row.current_revision ? row.status : 'superseded' };
}
export function resolveMemoryView(db: Database.Database, view: MemoryView): MemoryView {
  shape(view,['scope','repositories']); memoryScope(db,view.scope);
  if (!Array.isArray(view.repositories)) throw new KddError('invalid memory repositories');
  const seen = new Set<string>();
  const repositories = view.repositories.map(version => {
    shape(version,['repoId','checkoutPath','commit']); memoryHex(version.repoId,[32]);
    if (seen.has(version.repoId)) throw new KddError('duplicate memory repository');
    seen.add(version.repoId);
    return { repoId:version.repoId,commit:version.commit,
      checkoutPath:memoryCommit(db,version.repoId,version.commit,version.checkoutPath) };
  });
  return { scope:{projectId:view.scope.projectId,taskId:view.scope.taskId},repositories };
}
export function memoryReadOptions(options: MemoryReadOptions): void {
  shape(options,[],['candidates','withdrawn']);
  for (const flag of [options.candidates,options.withdrawn]) if (flag !== undefined && typeof flag !== 'boolean') throw new KddError('invalid memory read option');
}
export function selectMemory(db: Database.Database, view: MemoryView, options: MemoryReadOptions = {},
  historyEntryId?: string, revision?: number | null): MemoryRecord[] {
  if (!db.inTransaction) throw new KddError('memory read requires transaction');
  memoryReadOptions(options);
  const resolved = resolveMemoryView(db,view), taskIds: number[] = [];
  if (resolved.scope.taskId !== null) {
    const task = scopedTask(db,{projectId:resolved.scope.projectId,taskId:resolved.scope.taskId});
    taskIds.push(task.id); if (task.parent_id !== null) taskIds.push(task.parent_id);
  }
  const clauses = [`(e.task_id IS NULL${taskIds.length ? ` OR e.task_id IN (${taskIds.map(()=>'?').join(',')})` : ''})`];
  const parameters: (number|string)[] = [...taskIds];
  clauses.push(`(e.repo_id IS NULL${resolved.repositories.map(version => {
    parameters.push(version.repoId,version.commit);
    return ' OR (e.repo_id=? AND (e.applicable_commit IS NULL OR e.applicable_commit=?))';
  }).join('')})`);
  if (historyEntryId !== undefined) { memoryHex(historyEntryId,[32]); clauses.push('e.id=?'); parameters.push(historyEntryId); }
  else if (revision !== undefined) throw new KddError('memory revision requires entry');
  if (revision !== undefined && revision !== null) integer(revision);
  if (historyEntryId === undefined || revision === null) clauses.push('r.revision=e.current_revision');
  else if (revision !== undefined) { clauses.push('r.revision=?'); parameters.push(revision); }
  if (!options.candidates) clauses.push("r.kind<>'candidate'");
  if (!options.withdrawn) clauses.push("r.status='active'");
  const rows = db.prepare(`SELECT e.id,r.revision FROM memory_entries e
    JOIN memory_revisions r ON r.entry_id=e.id WHERE ${clauses.join(' AND ')} ORDER BY e.id,r.revision`).all(...parameters) as {id:string;revision:number}[];
  if (historyEntryId !== undefined && !rows.length) throw new KddError('memory record unavailable');
  return rows.map(row => memoryRecordDb(db,row.id,row.revision));
}
function evidence(input: MemoryWriteInput, operation: MemoryOperation, previous: MemoryRecord | null,
  observers: MemoryObservers): MemoryEvidenceObservation[] {
  const origins = new Set<'user'|'host'>();
  if (input.source.kind === 'user' || ['rule','decision'].includes(input.kind)
    || previous && ['rule','decision'].includes(previous.kind)) origins.add('user');
  if (input.kind === 'fact' || previous?.kind === 'fact') origins.add('host');
  return [...origins].map(origin => {
    const request: MemoryEvidenceRequest = { operation,entryId:input.entryId,expectedRevision:input.expectedRevision,
      origin,scope:input.scope,applicability:input.applicability,payloadHash:memoryDraftHash(input),source:input.source };
    const expected = canonical(request);
    try {
      const observed = observers.observe?.(structuredClone(request));
      shape(observed,['request','origin','verdict','observedAt','expiresAt']);
      if (!observed || canonical(observed.request) !== expected || observed.origin !== origin || observed.verdict !== 'pass'
        || !Number.isFinite(observed.observedAt) || observed.observedAt < 0 || observed.observedAt > now()
        || observed.expiresAt !== null && (!Number.isFinite(observed.expiresAt) || observed.expiresAt <= now() || observed.expiresAt <= observed.observedAt)) throw new Error();
      const json = canonical(observed);
      if (Buffer.byteLength(json) > CAPS.agentDetailBytes || redact(json) !== json) throw new Error();
      return JSON.parse(json) as MemoryEvidenceObservation;
    } catch { throw new KddError('memory evidence not verified'); }
  });
}
function receipt(record: MemoryRecord, created: boolean): MemoryReceipt {
  return { entryId:record.entryId,revision:record.revision,currentRevision:record.currentRevision,
    hash:record.hash,created,effectiveStatus:record.effectiveStatus };
}
export function writeMemoryDb(db: Database.Database, input: MemoryWriteInput, observers: MemoryObservers,
  importKey?: string): MemoryReceipt {
  if (!db.inTransaction) throw new KddError('memory write requires transaction');
  // Host callbacks must not change the payload between validation, evidence and persistence.
  try { input = structuredClone(input); }
  catch { throw new KddError('invalid memory payload'); }
  shape(input,['commandId','entryId','expectedRevision','scope','applicability','kind','status','title','body','source','author']);
  safeMemoryText(input.commandId,CAPS.agentFieldChars); integer(input.expectedRevision,0);
  if (input.entryId === null ? input.expectedRevision !== 0 : input.expectedRevision === 0) throw new KddError('invalid memory expected revision');
  if (input.entryId !== null) memoryHex(input.entryId,[32]);
  if (importKey !== undefined) memoryHex(importKey,[64]);
  validateDraft(db,input);
  const commandHash = digest(input);
  const actor = { type: input.author.type, id: input.author.id ?? undefined };
  const command = db.prepare('SELECT entry_id,revision,command_hash FROM memory_revisions WHERE command_id=?').get(input.commandId) as
    {entry_id:string;revision:number;command_hash:string} | undefined;
  const alias = command ? undefined : db.prepare("SELECT detail FROM events WHERE action='memory_import_replay' AND json_extract(detail,'$.commandId')=?").get(input.commandId) as {detail:string}|undefined;
  const bound = command ?? (alias ? (() => { const detail = JSON.parse(alias.detail); return { entry_id:detail.entryId,revision:detail.revision,command_hash:detail.commandHash }; })() : undefined);
  if (bound && bound.command_hash !== commandHash) throw new KddError('memory command conflict');
  const imported = !bound && importKey ? db.prepare('SELECT id FROM memory_entries WHERE import_key=?').get(importKey) as {id:string}|undefined : undefined;
  const replay = bound ? memoryRecordDb(db,bound.entry_id,bound.revision) : imported ? memoryRecordDb(db,imported.id,1) : null;
  if (imported && replay?.hash !== memoryDraftHash(input)) throw new KddError('memory import publication conflict');
  const previous = replay ? (replay.predecessor === null ? null : memoryRecordDb(db,replay.entryId,replay.predecessor))
    : input.entryId === null ? null : memoryRecordDb(db,input.entryId,input.expectedRevision);
  const existing = input.entryId === null ? null : memoryRecordDb(db,input.entryId);
  if (existing && (canonical(existing.scope) !== canonical(input.scope) || canonical(existing.applicability) !== canonical(input.applicability))) throw new KddError('immutable memory identity');
  if (previous && input.kind !== previous.kind && (previous.kind !== 'candidate' || input.kind === 'candidate')) throw new KddError('immutable memory kind');
  const originalImport = replay && replay.revision === 1 && db.prepare('SELECT import_key FROM memory_entries WHERE id=?').get(replay.entryId) as {import_key:string|null}|false|null;
  const operation: MemoryOperation = importKey || originalImport && originalImport.import_key ? 'import'
    : !previous ? 'create' : input.status === 'withdrawn' ? 'withdraw' : input.kind !== previous.kind ? 'accept' : 'revise';
  const observations = evidence(input,operation,previous,observers);
  if (Buffer.byteLength(canonical(observations)) > CAPS.agentDetailBytes) throw new KddError(`memory evidence exceeds limit ${CAPS.agentDetailBytes}`);
  if (replay) {
    if (imported) appendEvent(db,input.scope.taskId,actor,'memory_import_replay',
      {commandId:input.commandId,commandHash,entryId:replay.entryId,revision:replay.revision});
    return receipt(replay,false);
  }
  if (existing && existing.currentRevision !== input.expectedRevision) throw new KddError('stale memory revision');
  const entryId = input.entryId ?? newId(), revision = input.expectedRevision+1;
  integer(revision);
  if (!existing) db.prepare('INSERT INTO memory_entries VALUES(?,?,?,?,?,?,?)')
    .run(entryId,input.scope.taskId,input.applicability.repoId,input.applicability.commit,importKey ?? null,revision,now());
  db.prepare('INSERT INTO memory_revisions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(entryId,revision,previous?.revision ?? null,
    input.kind,input.status,input.title,input.body,canonical(input.source),canonical(input.author),canonical(observations),memoryDraftHash(input),input.commandId,commandHash,now());
  if (existing && db.prepare('UPDATE memory_entries SET current_revision=? WHERE id=? AND current_revision=?')
    .run(revision,entryId,input.expectedRevision).changes !== 1) throw new KddError('stale memory revision');
  appendEvent(db,input.scope.taskId,actor,'memory_revision',
    {entryId,revision,predecessor:previous?.revision ?? null,kind:input.kind,status:input.status,
      source:input.source,hash:memoryDraftHash(input),operation});
  return receipt(memoryRecordDb(db,entryId,revision),true);
}
export function writeMemory(handle: ControllerHandle, input: MemoryWriteInput, observers: MemoryObservers = {}): MemoryReceipt {
  const db = controllerDb(handle);
  return db.transaction(() => writeMemoryDb(db,input,observers)).immediate();
}
