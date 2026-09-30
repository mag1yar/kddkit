import type Database from 'better-sqlite3';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { controllerDb, type ControllerHandle } from './controller.js';
import { KddError } from './errors.js';
import { appendEvent } from './ops.js';
import { projectOf } from './project_store.js';
import { roleActiveDb, roleFilesDb, roleRevisionDb } from './roles.js';
import { readRunInputSnapshotDb, type RunInputSnapshot } from './run_inputs.js';
import { assertRunAuthorityBinding } from './authority.js';
import { assertVerifiedCodexPackage, closedCodexCatalog, spawnCheckedNative, type VerifiedCodexPackage } from './codex_permissions.js';

const denied = () => new KddError('role launch denied');
const sha = (value: string) => createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');
const outputReserve = 8192;
// Preflight refuses this package when any full first-turn request exceeds this byte bound.
const framingReserve = 131072;

export function rolePromptDb(db: Database.Database, snapshot: RunInputSnapshot): string {
  const inputs = snapshot.response.inputs;
  if (inputs.schemaVersion !== 2) throw denied();
  const { definition, receipt } = roleRevisionDb(db, inputs.role);
  if (receipt.hash !== inputs.role.hash || receipt.manifestHash !== inputs.role.manifestHash) throw denied();
  const files = roleFilesDb(db, inputs.role);
  const always = definition.skills.filter(skill => skill.mode === 'Always').map(skill => {
    const body = files.find(file => file.skill === skill.name && file.path === 'SKILL.md');
    if (!body) throw denied();
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(body.bytes); }
    catch { throw denied(); }
    if (!text.trim()) throw denied();
    return `=== SKILL ${JSON.stringify(skill.name)} (Always) ===\n${text}\n=== END SKILL ===`;
  });
  const available = definition.skills.filter(skill => skill.mode === 'Available')
    .map(skill => `${JSON.stringify(skill.name)}: ${skill.description}\nRead pinned bytes with read_skill_file({skill:${JSON.stringify(skill.name)},path:"SKILL.md",offset:0}).`);
  return [
    `=== ROLE ${JSON.stringify(definition.name)} ===\n${definition.prompt}\n=== END ROLE ===`,
    ...always,
    `=== RUN INPUTS ${snapshot.inputHash} ===\n${JSON.stringify(inputs)}\n=== END RUN INPUTS ===`,
    `=== AVAILABLE SKILLS ===\n${available.join('\n')}\n=== END AVAILABLE SKILLS ===`,
  ].join('\n\n');
}

export function assertRolePromptBudget(prompt: string, native: VerifiedCodexPackage, reserve = outputReserve): void {
  assertVerifiedCodexPackage(native);
  if (!Number.isSafeInteger(native.contextWindow) || native.contextWindow < 1
    || !Number.isSafeInteger(reserve) || reserve < outputReserve) throw denied();
  const explicit = Buffer.byteLength(prompt, 'utf8') + Buffer.byteLength(JSON.stringify(native.argv), 'utf8')
    + Buffer.byteLength(closedCodexCatalog(native.model), 'utf8');
  if (explicit + framingReserve + reserve > native.contextWindow) throw new KddError('role prompt exceeds verified model context');
}

export interface RoleLaunchPermit {
  readonly prompt: string; readonly promptHash: string; readonly model: string; readonly effort: string;
  readonly native: VerifiedCodexPackage;
}
const permits = new WeakMap<object, { handle: ControllerHandle; projectId: string; authorityId: string;
  promptHash: string; native: VerifiedCodexPackage; reserve: number }>();

function checkedPrompt(handle: ControllerHandle, projectId: string, authorityId: string, native: VerifiedCodexPackage): string {
  const db = controllerDb(handle);
  return db.transaction(() => {
    if (projectId !== projectOf(db).project_id || !/^[0-9a-f]{32}$/.test(authorityId)) throw denied();
    const row = db.prepare('SELECT task_id,work_item_id,run_id,generation,grant_json,token_hash FROM run_authorities WHERE authority_id=?')
      .get(authorityId) as { task_id: number; work_item_id: string; run_id: string; generation: number; grant_json: string; token_hash: string } | undefined;
    if (!row) throw denied();
    assertRunAuthorityBinding(db, row.task_id, { authorityId, workItemId: row.work_item_id,
      runId: row.run_id, generation: row.generation });
    const grant = JSON.parse(row.grant_json) as { role?: { roleId: string; revision: number }; operations: string[]; native: { configHash: string } };
    const snapshot = readRunInputSnapshotDb(db, authorityId), pin = snapshot.response.inputs;
    if (!native.brokerConfigPath || JSON.stringify(native.brokerTools) !== JSON.stringify(grant.operations)) throw denied();
    let brokerToken: string;
    try { brokerToken = JSON.parse(readFileSync(native.brokerConfigPath, 'utf8')).token; }
    catch { throw denied(); }
    if (typeof brokerToken !== 'string' || sha(brokerToken) !== row.token_hash) throw denied();
    if (pin.schemaVersion !== 2 || !grant.role || !roleActiveDb(db, grant.role.roleId)
      || pin.role.roleId !== grant.role.roleId || pin.role.revision !== grant.role.revision
      || pin.role.model !== native.model || pin.role.effort !== native.effort
      || pin.role.contextWindow !== native.contextWindow || pin.role.nativeConfigHash !== native.configHash
      || grant.native.configHash !== native.configHash) throw denied();
    return rolePromptDb(db, snapshot);
  }).immediate();
}

export function prepareRoleLaunch(handle: ControllerHandle, input: {
  projectId: string; authorityId: string; native: VerifiedCodexPackage; outputReserveTokens?: number;
}): RoleLaunchPermit {
  assertVerifiedCodexPackage(input.native);
  const prompt = checkedPrompt(handle, input.projectId, input.authorityId, input.native);
  const reserve = input.outputReserveTokens ?? outputReserve;
  assertRolePromptBudget(prompt, input.native, reserve);
  const promptHash = sha(prompt);
  const permit = Object.freeze({ prompt, promptHash, model: input.native.model, effort: input.native.effort, native: input.native });
  permits.set(permit, { handle, projectId: input.projectId, authorityId: input.authorityId,
    promptHash, native: input.native, reserve });
  const db = controllerDb(handle);
  db.transaction(() => {
    const row = db.prepare('SELECT task_id FROM run_authorities WHERE authority_id=?').get(input.authorityId) as { task_id: number };
    appendEvent(db, row.task_id, { type: 'ai', id: 'controller' }, 'role_prompt_prepared', { authorityId: input.authorityId, promptHash });
  }).immediate();
  return permit;
}

export async function spawnCheckedRoleRun(permit: RoleLaunchPermit): Promise<ChildProcess> {
  const stored = typeof permit === 'object' && permit !== null ? permits.get(permit) : undefined;
  if (!stored || permit.promptHash !== stored.promptHash || permit.native !== stored.native
    || permit.model !== stored.native.model || permit.effort !== stored.native.effort
    || sha(permit.prompt) !== stored.promptHash) throw denied();
  assertVerifiedCodexPackage(stored.native);
  const prompt = checkedPrompt(stored.handle, stored.projectId, stored.authorityId, stored.native);
  if (sha(prompt) !== stored.promptHash) throw denied();
  assertRolePromptBudget(prompt, stored.native, stored.reserve);
  const native = stored.native;
  return spawnCheckedNative({ controlDir: native.controlDir, writableRoots: [native.scratchDir, ...(native.writableRoot ? [native.writableRoot] : [])],
    executable: native.executable, args: [...native.argv, prompt], cwd: native.cwd, env: native.env, phase: 'start', verified: native,
    beforeSpawn: () => {
      const current = checkedPrompt(stored.handle, stored.projectId, stored.authorityId, native);
      if (sha(current) !== stored.promptHash) throw denied();
      assertRolePromptBudget(current, native, stored.reserve);
    } });
}
