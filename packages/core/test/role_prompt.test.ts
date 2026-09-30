import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as core from '../src/index.js';
import { runInputFixture } from './run_inputs_fixture.js';
import { cleanupFixtures } from './execution_fixture.js';

const proved = vi.hoisted(() => new WeakSet<object>());
vi.mock('../src/codex_permissions.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/codex_permissions.js')>();
  return { ...actual, assertVerifiedCodexPackage(packet: object) {
    if (!proved.has(packet)) throw new core.KddError('unverified native package');
  } };
});
afterEach(() => { cleanupFixtures(); vi.restoreAllMocks(); });

function prepared() {
  const f = runInputFixture(packet => proved.add(packet), ['get_context', 'read_skill_file']);
  const skillRoot = join(f.root, 'skills');
  for (const name of ['always', 'available']) mkdirSync(join(skillRoot, name), { recursive: true });
  writeFileSync(join(skillRoot, 'always', 'SKILL.md'), 'ALWAYS-UNIQUE-7fd2\nFull instructions.\n');
  writeFileSync(join(skillRoot, 'available', 'SKILL.md'), 'AVAILABLE-UNIQUE-a6e9\nRead later.\n');
  writeFileSync(join(skillRoot, 'available', 'empty.bin'), Buffer.alloc(0));
  const definition: core.RoleDefinition = { name: 'Pinned', prompt: 'Execute the scoped task.', runtime: 'codex',
    model: 'gpt-6-sol', effort: 'high', access: 'workspace-write', operations: ['get_context', 'read_skill_file'],
    skills: [
      { name: 'AlwaysGuide', mode: 'Always', description: 'Primary guide', source: { kind: 'local', root: skillRoot, path: 'always' } },
      { name: 'AvailableGuide', mode: 'Available', description: 'Secondary guide', source: { kind: 'local', root: skillRoot, path: 'available' } },
    ] };
  const role = core.saveRoleRevision(f.handle, { expectedRevision: 0, commandId: randomUUID(), definition });
  const issued = core.issueRunAuthority(f.handle, { ...f.input, role, operations: ['get_context', 'read_skill_file'] });
  writeFileSync(f.input.native.brokerConfigPath!, JSON.stringify({ token: issued.token }));
  const ref = { projectId: f.projectId, authorityId: issued.authorityId };
  return { ...f, definition, role, issued, ref, skillRoot };
}

it('delivers complete Always and mandatory inputs from pinned bytes, while Available remains on demand', () => {
  const f = prepared();
  const permit = core.prepareRoleLaunch(f.handle, { ...f.ref, native: f.input.native });
  const snapshot = core.runInputSnapshot(f.handle, f.ref);
  expect(permit.prompt.split('ALWAYS-UNIQUE-7fd2')).toHaveLength(2);
  expect(permit.prompt).toContain(JSON.stringify(snapshot.response.inputs));
  expect(permit.prompt).toContain('AvailableGuide');
  expect(permit.prompt).not.toContain('AVAILABLE-UNIQUE-a6e9');
  expect(permit.promptHash).toBe(createHash('sha256').update(Buffer.from(permit.prompt, 'utf8')).digest('hex'));
  const context = core.openRunContext(f.db, f.issued.token);
  expect(Buffer.from(core.readSkillFile(context, { skill: 'AvailableGuide', path: 'SKILL.md', offset: 0 }).contentBase64, 'base64').toString())
    .toContain('AVAILABLE-UNIQUE-a6e9');
  expect(core.readSkillFile(context, { skill: 'AvailableGuide', path: 'empty.bin', offset: 0 }))
    .toMatchObject({ length: 0, size: 0, contentBase64: '' });
  writeFileSync(join(f.skillRoot, 'always', 'SKILL.md'), 'CHANGED-SOURCE');
  const next = core.saveRoleRevision(f.handle, { roleId: f.role.roleId, expectedRevision: 1, commandId: randomUUID(),
    definition: { ...f.definition, prompt: 'New role prompt.' } });
  expect(next.revision).toBe(2);
  expect(core.prepareRoleLaunch(f.handle, { ...f.ref, native: f.input.native }).prompt).toBe(permit.prompt);
});

it('refuses overflow before authority writes and rejects fabricated or changed launch permits', async () => {
  const f = prepared();
  const tables = ['managed_task_policy', 'run_authorities', 'run_input_snapshots', 'events'];
  const narrow = Object.freeze({ ...f.input.native, contextWindow: 1000 }); proved.add(narrow);
  const task = f.task('too large');
  const before = tables.map(table => f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get());
  expect(() => core.issueRunAuthority(f.handle, { ...f.input, taskId: task.id,
    workItemId: 'narrow', runId: 'narrow', role: f.role, native: narrow,
    operations: ['get_context', 'read_skill_file'] })).toThrow(/context/);
  const noRead = Object.freeze({ ...f.input.native, brokerTools: ['get_context'] as const }); proved.add(noRead);
  expect(() => core.issueRunAuthority(f.handle, { ...f.input, taskId: task.id,
    workItemId: 'missing-read', runId: 'missing-read', role: f.role, native: noRead, operations: ['get_context'] })).toThrow(/read operation/);
  expect(tables.map(table => f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get())).toEqual(before);
  const permit = core.prepareRoleLaunch(f.handle, { ...f.ref, native: f.input.native });
  await expect(core.spawnCheckedRoleRun({ ...permit })).rejects.toThrow(/denied/);
  await expect(core.spawnCheckedRoleRun(JSON.parse(JSON.stringify({ prompt: permit.prompt, promptHash: permit.promptHash,
    model: permit.model, effort: permit.effort })))).rejects.toThrow(/denied/);
  expect(() => core.prepareRoleLaunch(f.handle, { ...f.ref, native: narrow })).toThrow(/denied/);
  const wrongTools = Object.freeze({ ...f.input.native, brokerTools: ['get_context'] as const }); proved.add(wrongTools);
  expect(() => core.prepareRoleLaunch(f.handle, { ...f.ref, native: wrongTools })).toThrow(/denied/);
  writeFileSync(f.input.native.brokerConfigPath!, JSON.stringify({ token: '0'.repeat(64) }));
  expect(() => core.prepareRoleLaunch(f.handle, { ...f.ref, native: f.input.native })).toThrow(/denied/);
  writeFileSync(f.input.native.brokerConfigPath!, JSON.stringify({ token: f.issued.token }));
  core.revokeRole(f.handle, f.role.roleId);
  expect(() => core.prepareRoleLaunch(f.handle, { ...f.ref, native: f.input.native })).toThrow();
  await expect(core.spawnCheckedRoleRun(permit)).rejects.toThrow();
});
