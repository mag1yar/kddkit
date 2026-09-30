import type Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { controllerDb, type ControllerHandle } from './controller.js';
import { now } from './db.js';
import { KddError } from './errors.js';
import { canonical, digest, newId, shape } from './execution.js';
import type { RunOperation } from './authority.js';
import { redact } from './agent_events.js';
import { appendEvent } from './ops.js';
import { CAPS } from './caps.js';
import { bindingsOf, canonicalCommonDir, projectOf, repositoriesOf } from './project_store.js';

export type SkillSource =
  | { kind: 'local'; root: string; path: string }
  | { kind: 'repo'; repoId: string; checkoutPath: string; commit: string; path: string };
export interface RoleDefinition {
  name: string; prompt: string; runtime: 'codex'; model: string; effort: string;
  access: 'read' | 'workspace-write'; operations: readonly RunOperation[];
  skills: readonly { name: string; mode: 'Always' | 'Available'; description: string; source: SkillSource }[];
}
export interface RoleRef { roleId: string; revision: number }
export interface RoleReceipt extends RoleRef { hash: string; manifestHash: string }
interface SkillFile { skill: string; path: string; bytes: Buffer; sha256: string; mime: string }
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const denied = (reason: string) => new KddError(`role revision denied: ${reason}`);

export function validSkillPath(path: unknown): path is string {
  return typeof path === 'string' && !!path && !isAbsolute(path) && !path.includes('\\') && !path.includes('\0')
    && !path.split('/').some(part => !part || part === '.' || part === '..');
}
function relativeSourcePath(path: string): string {
  if (!validSkillPath(path)) throw denied('invalid skill path');
  return path;
}
function cleanText(value: unknown, label: string, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || redact(value) !== value) throw denied(`invalid ${label}`);
  return value;
}
function mime(path: string): string {
  if (path.endsWith('.md')) return 'text/markdown';
  if (path.endsWith('.txt')) return 'text/plain';
  if (path.endsWith('.json')) return 'application/json';
  if (path.endsWith('.sh')) return 'text/x-shellscript';
  return 'application/octet-stream';
}
function filesForLocal(source: Extract<SkillSource, { kind: 'local' }>): { path: string; bytes: Buffer }[] {
  if (!isAbsolute(source.root) || source.root !== realpathSync(source.root)) throw denied('source root must be canonical');
  const root = source.root, path = relativeSourcePath(source.path);
  const folder = join(root, path);
  if (relative(root, folder).startsWith('..')) throw denied('skill escaped source root');
  for (let cursor = root, parts = path.split('/'), i = 0; i < parts.length; i++) {
    cursor = join(cursor, parts[i]);
    if (!lstatSync(cursor).isDirectory()) throw denied('skill directory unavailable');
  }
  const files: { path: string; bytes: Buffer }[] = [];
  const visit = (directory: string, prefix: string): void => {
    const before = lstatSync(directory);
    if (!before.isDirectory()) throw denied('special skill directory');
    for (const name of readdirSync(directory).sort()) {
      if (name === '.' || name === '..' || name.includes('/') || name.includes('\\')) throw denied('invalid skill entry');
      const full = join(directory, name), path = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(full);
      if (stat.isDirectory()) { visit(full, path); continue; }
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > CAPS.skillFileBytes) throw denied('unsafe skill file');
      const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      try {
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) throw denied('skill file changed');
        bytes = readFileSync(fd);
        const after = fstatSync(fd), current = lstatSync(full);
        if (bytes.length > CAPS.skillFileBytes || after.dev !== opened.dev || after.ino !== opened.ino
          || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
          || current.dev !== opened.dev || current.ino !== opened.ino) throw denied('skill file changed');
      } finally { closeSync(fd); }
      files.push({ path, bytes });
      if (files.length > CAPS.skillFileCount) throw denied('too many skill files');
    }
    const after = lstatSync(directory);
    if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs) throw denied('skill directory changed');
  };
  visit(folder, '');
  return files;
}
function filesForRepo(db: Database.Database, source: Extract<SkillSource, { kind: 'repo' }>): { path: string; bytes: Buffer }[] {
  const path = relativeSourcePath(source.path);
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(source.commit)) throw denied('invalid source commit');
  const checkout = realpathSync(source.checkoutPath), common = canonicalCommonDir(checkout);
  const repo = repositoriesOf(db).find(row => row.repo_id === source.repoId);
  const bound = bindingsOf(db).some(row => row.repo_id === source.repoId && row.common_dir === common && row.checkout_path === checkout);
  if (!repo || !bound) throw denied('unbound source repository');
  const git = (args: string[], maxBuffer = 2 * 1024 * 1024) => execFileSync('/usr/bin/git', ['--no-replace-objects', '-C', checkout, ...args],
    { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer });
  if (git(['cat-file', '-t', source.commit]).toString().trim() !== 'commit'
    || git(['rev-parse', source.commit]).toString().trim() !== source.commit) throw denied('source commit unavailable');
  const tree = git(['ls-tree', '-r', '-z', '--full-tree', source.commit, '--', path]);
  const entries = tree.toString('utf8').split('\0').filter(Boolean);
  if (!entries.length || entries.length > CAPS.skillFileCount) throw denied('skill tree empty or too large');
  return entries.map(entry => {
    const match = /^(\d{6}) blob ([0-9a-f]{40,64})\t(.+)$/.exec(entry);
    if (!match || match[1] !== '100644' && match[1] !== '100755' || !match[3].startsWith(`${path}/`)) throw denied('unsafe Git skill entry');
    const relativePath = relativeSourcePath(match[3].slice(path.length + 1));
    const size = Number(git(['cat-file', '-s', match[2]]).toString());
    if (!Number.isSafeInteger(size) || size > CAPS.skillFileBytes) throw denied('skill file too large');
    const bytes = git(['cat-file', 'blob', match[2]], CAPS.skillFileBytes + 1024);
    if (bytes.length !== size) throw denied('Git skill blob changed');
    return { path: relativePath, bytes };
  });
}
function importSkill(db: Database.Database, skill: RoleDefinition['skills'][number]): SkillFile[] {
  const source = skill.source;
  const raw = source.kind === 'local' ? filesForLocal(source) : filesForRepo(db, source);
  if (!raw.some(file => file.path === 'SKILL.md') || raw.reduce((n, file) => n + file.bytes.length, 0) > CAPS.skillTotalBytes) {
    throw denied('skill body missing or too large');
  }
  const body = raw.find(file => file.path === 'SKILL.md')!.bytes;
  try { if (!new TextDecoder('utf-8', { fatal: true }).decode(body).trim()) throw new Error('empty body'); }
  catch { throw denied('invalid SKILL.md'); }
  return raw.map(file => {
    if (redact(file.bytes.toString('utf8')) !== file.bytes.toString('utf8')) throw denied('skill contains credentials');
    return { skill: skill.name, path: file.path, bytes: file.bytes, sha256: hash(file.bytes), mime: mime(file.path) };
  }).sort((a, b) => a.path.localeCompare(b.path));
}
function validateDefinition(value: RoleDefinition): RoleDefinition {
  shape(value, ['name', 'prompt', 'runtime', 'model', 'effort', 'access', 'operations', 'skills']);
  const name = cleanText(value.name, 'name', 80), prompt = cleanText(value.prompt, 'prompt', 262144);
  if (/[\\/\x00-\x1f]/.test(name) || value.runtime !== 'codex'
    || typeof value.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(value.model)
    || typeof value.effort !== 'string' || !/^[a-z]+$/.test(value.effort)
    || !['read', 'workspace-write'].includes(value.access)
    || !Array.isArray(value.operations) || !value.operations.length || new Set(value.operations).size !== value.operations.length
    || value.operations.some(operation => !['get_context', 'submit_report', 'request_question', 'read_skill_file'].includes(operation))
    || !Array.isArray(value.skills)) throw denied('invalid definition');
  const names = new Set<string>();
  const skills = value.skills.map(skill => {
    shape(skill, ['name', 'mode', 'description', 'source']);
    const skillName = cleanText(skill.name, 'skill name', 80), description = cleanText(skill.description, 'skill description', 1000);
    const folded = skillName.normalize('NFKC').toLowerCase();
    if (/[\\/\x00-\x1f]/.test(skillName) || names.has(folded) || !['Always', 'Available'].includes(skill.mode)) throw denied('duplicate or invalid skill');
    names.add(folded);
    if (!skill.source || !['local', 'repo'].includes(skill.source.kind)) throw denied('invalid source');
    if (skill.source.kind === 'local') shape(skill.source, ['kind', 'root', 'path']);
    else shape(skill.source, ['kind', 'repoId', 'checkoutPath', 'commit', 'path']);
    relativeSourcePath(skill.source.path);
    return { name: skillName, description, mode: skill.mode, source: structuredClone(skill.source) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const definition = { name, prompt, runtime: 'codex' as const, model: value.model, effort: value.effort,
    access: value.access, operations: [...value.operations].sort(), skills };
  if (redact(canonical(definition)) !== canonical(definition)) throw denied('definition contains credentials');
  return definition;
}
function manifestHash(definition: RoleDefinition, files: readonly SkillFile[]): string {
  return digest({ skills: definition.skills.map(skill => ({ name: skill.name, mode: skill.mode, source: skill.source })),
    files: [...files].sort((a, b) => {
      if (a.skill !== b.skill) return a.skill < b.skill ? -1 : 1;
      if (a.path !== b.path) return a.path < b.path ? -1 : 1;
      return 0;
    })
      .map(file => ({ skill: file.skill, path: file.path, sha256: file.sha256, mime: file.mime, size: file.bytes.length })) });
}
export function roleFilesDb(db: Database.Database, ref: RoleRef): SkillFile[] {
  return (db.prepare('SELECT skill_name,relative_path,bytes,sha256,mime FROM role_skill_files WHERE role_id=? AND revision=? ORDER BY skill_name,relative_path')
    .all(ref.roleId, ref.revision) as { skill_name: string; relative_path: string; bytes: Buffer; sha256: string; mime: string }[])
    .map(row => {
      if (hash(row.bytes) !== row.sha256) throw denied('stored skill bytes changed');
      return { skill: row.skill_name, path: row.relative_path, bytes: row.bytes, sha256: row.sha256, mime: row.mime };
    });
}
export function roleRevisionDb(db: Database.Database, ref: RoleRef): { definition: RoleDefinition; receipt: RoleReceipt } {
  if (!ref || typeof ref.roleId !== 'string' || !Number.isSafeInteger(ref.revision) || ref.revision < 1) throw denied('invalid role ref');
  const row = db.prepare('SELECT p.project_id,r.definition_json,r.hash,r.manifest_hash FROM role_revisions r JOIN role_profiles p ON p.id=r.role_id WHERE r.role_id=? AND r.revision=?')
    .get(ref.roleId, ref.revision) as { project_id: string; definition_json: string; hash: string; manifest_hash: string } | undefined;
  if (!row || row.project_id !== projectOf(db).project_id) throw denied('unknown role revision');
  const definition = JSON.parse(row.definition_json) as RoleDefinition;
  const files = roleFilesDb(db, ref), manifest = manifestHash(definition, files);
  if (manifest !== row.manifest_hash || digest({ definition, manifestHash: manifest }) !== row.hash) throw denied('role revision changed');
  return { definition, receipt: { ...ref, hash: row.hash, manifestHash: manifest } };
}
export function roleRevision(handle: ControllerHandle, ref: RoleRef): RoleDefinition & RoleReceipt {
  const { definition, receipt } = roleRevisionDb(controllerDb(handle), ref);
  return { ...definition, ...receipt };
}
export function currentRoleRevision(handle: ControllerHandle, roleId: string): RoleDefinition & RoleReceipt {
  const db = controllerDb(handle);
  if (typeof roleId !== 'string' || !/^[0-9a-f]{32}$/.test(roleId)) throw denied('invalid role ref');
  const row = db.prepare('SELECT current_revision FROM role_profiles WHERE id=? AND project_id=?')
    .get(roleId, projectOf(db).project_id) as { current_revision: number } | undefined;
  if (!row) throw denied('unknown role');
  return roleRevision(handle, { roleId, revision: row.current_revision });
}
export function roleActiveDb(db: Database.Database, roleId: string): boolean {
  return !!db.prepare('SELECT 1 FROM role_profiles WHERE id=? AND project_id=? AND revoked_at IS NULL')
    .get(roleId, projectOf(db).project_id);
}
export function revokeRole(handle: ControllerHandle, roleId: string): void {
  const db = controllerDb(handle);
  if (typeof roleId !== 'string' || !/^[0-9a-f]{32}$/.test(roleId)) throw denied('invalid role ref');
  db.transaction(() => {
    const row = db.prepare('SELECT project_id,revoked_at FROM role_profiles WHERE id=?')
      .get(roleId) as { project_id: string; revoked_at: number | null } | undefined;
    if (!row || row.project_id !== projectOf(db).project_id) throw denied('unknown role');
    if (row.revoked_at !== null) return;
    db.prepare('UPDATE role_profiles SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(now(), roleId);
    appendEvent(db, null, { type: 'ai', id: 'controller' }, 'role_revoked', { roleId });
  }).immediate();
}
export function saveRoleRevision(handle: ControllerHandle, input: {
  roleId?: string; expectedRevision: number; commandId: string; definition: RoleDefinition;
}): RoleReceipt {
  const db = controllerDb(handle);
  if (!input || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
    || typeof input.commandId !== 'string' || !input.commandId.trim() || input.commandId.length > 200
    || input.roleId !== undefined && !/^[0-9a-f]{32}$/.test(input.roleId)) throw denied('invalid command');
  const definition = validateDefinition(input.definition);
  const commandHash = digest({ roleId: input.roleId ?? null, expectedRevision: input.expectedRevision, definition });
  const replay = () => db.prepare('SELECT role_id,revision,hash,manifest_hash,command_hash FROM role_revisions WHERE command_id=?')
    .get(input.commandId) as { role_id: string; revision: number; hash: string; manifest_hash: string; command_hash: string } | undefined;
  const prior = replay();
  if (prior) {
    if (prior.command_hash !== commandHash) throw denied('command replay changed');
    return { roleId: prior.role_id, revision: prior.revision, hash: prior.hash, manifestHash: prior.manifest_hash };
  }
  const files = definition.skills.flatMap(skill => importSkill(db, skill));
  const manifest = manifestHash(definition, files), roleHash = digest({ definition, manifestHash: manifest });
  return db.transaction(() => {
    const raced = replay();
    if (raced) {
      if (raced.command_hash !== commandHash) throw denied('command replay changed');
      return { roleId: raced.role_id, revision: raced.revision, hash: raced.hash, manifestHash: raced.manifest_hash };
    }
    const projectId = projectOf(db).project_id, roleId = input.roleId ?? newId(), revision = input.expectedRevision + 1;
    if (input.roleId === undefined) {
      if (input.expectedRevision !== 0) throw denied('new role revision must start at one');
      db.prepare('INSERT INTO role_profiles(id,project_id,name,current_revision) VALUES(?,?,?,1)')
        .run(roleId, projectId, definition.name);
    } else {
      const current = db.prepare('SELECT project_id,name,current_revision,revoked_at FROM role_profiles WHERE id=?')
        .get(roleId) as { project_id: string; name: string; current_revision: number; revoked_at: number | null } | undefined;
      if (current && current.revoked_at !== null) throw denied('role revoked');
      if (!current || current.project_id !== projectId || current.current_revision !== input.expectedRevision
        || current.name !== definition.name) throw denied('role revision fence changed');
    }
    db.prepare('INSERT INTO role_revisions(role_id,revision,definition_json,hash,manifest_hash,created_at,command_id,command_hash) VALUES(?,?,?,?,?,?,?,?)')
      .run(roleId, revision, canonical(definition), roleHash, manifest, now(), input.commandId, commandHash);
    const insert = db.prepare('INSERT INTO role_skill_files(role_id,revision,skill_name,relative_path,sha256,mime,bytes) VALUES(?,?,?,?,?,?,?)');
    for (const file of files) insert.run(roleId, revision, file.skill, file.path, file.sha256, file.mime, file.bytes);
    if (input.roleId !== undefined) db.prepare('UPDATE role_profiles SET current_revision=? WHERE id=? AND current_revision=?')
      .run(revision, roleId, input.expectedRevision);
    appendEvent(db, null, { type: 'ai', id: 'controller' }, 'role_revision', { roleId, revision, hash: roleHash, manifestHash: manifest });
    return { roleId, revision, hash: roleHash, manifestHash: manifest };
  }).immediate();
}
