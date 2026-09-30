import { execFileSync } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import * as core from '../src/index.js';

const roots: string[] = [];
let saved: NodeJS.ProcessEnv;
beforeEach(() => { saved = { ...process.env }; });
afterEach(() => { process.env = saved; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kdd-roles-'))); roots.push(root);
  process.env.KDD_HOME = join(root, 'home'); delete process.env.KDD_DB; delete process.env.KDD_DECISIONS_DIR;
  const repo = join(root, 'repo'), skills = join(root, 'skills'), guide = join(skills, 'guide');
  mkdirSync(repo); mkdirSync(guide, { recursive: true });
  const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'seed');
  writeFileSync(join(guide, 'SKILL.md'), '# Original\n');
  writeFileSync(join(guide, 'reference.txt'), 'pinned reference\n');
  const db = core.openDb(join(root, 'board.db'), core.canonicalCommonDir(repo), repo);
  const handle = core.openController(db);
  const definition = (source: { kind: 'local'; root: string; path: string } | { kind: 'repo'; repoId: string; checkoutPath: string; commit: string; path: string }) => ({
    name: 'Builder', prompt: 'Review the work', runtime: 'codex' as const, model: 'gpt-6-sol', effort: 'high',
    access: 'read' as const, operations: ['get_context'] as const,
    skills: [{ name: 'Guide', mode: 'Always' as const, description: 'Project guide', source }],
  });
  return { root, repo, skills, guide, git, db, handle, definition,
    local: { kind: 'local' as const, root: skills, path: 'guide' } };
}

it('stores immutable revisions and exact pinned skill bytes across source changes and reopen', () => {
  const f = fixture();
  const first = core.saveRoleRevision(f.handle, { expectedRevision: 0, commandId: 'create-builder', definition: f.definition(f.local) });
  expect(first).toMatchObject({ revision: 1 });
  const oldRows = f.db.prepare('SELECT relative_path,bytes FROM role_skill_files WHERE role_id=? AND revision=1 ORDER BY relative_path')
    .all(first.roleId) as { relative_path: string; bytes: Buffer }[];
  expect(oldRows.map(row => [row.relative_path, row.bytes.toString()])).toEqual([
    ['SKILL.md', '# Original\n'], ['reference.txt', 'pinned reference\n'],
  ]);
  expect(() => f.db.prepare('UPDATE role_skill_files SET bytes=? WHERE role_id=? AND revision=1 AND relative_path=?')
    .run(Buffer.from('changed'), first.roleId, 'SKILL.md')).toThrow(/immutable/);
  expect(() => f.db.prepare('DELETE FROM role_revisions WHERE role_id=? AND revision=1').run(first.roleId)).toThrow();
  writeFileSync(join(f.guide, 'SKILL.md'), '# Updated\n');
  const second = core.saveRoleRevision(f.handle, { roleId: first.roleId, expectedRevision: 1,
    commandId: 'revise-builder', definition: { ...f.definition(f.local), prompt: 'Updated role' } });
  expect(second).toMatchObject({ roleId: first.roleId, revision: 2 });
  expect(first.hash).not.toBe(second.hash);
  expect(first.manifestHash).not.toBe(second.manifestHash);
  expect(core.roleRevision(f.handle, { roleId: first.roleId, revision: 1 }).prompt).toBe('Review the work');
  expect(core.roleRevision(f.handle, { roleId: first.roleId, revision: 2 }).prompt).toBe('Updated role');
  expect(core.currentRoleRevision(f.handle, first.roleId).revision).toBe(2);
  expect((f.db.prepare('SELECT bytes FROM role_skill_files WHERE role_id=? AND revision=1 AND relative_path=?')
    .get(first.roleId, 'SKILL.md') as { bytes: Buffer }).bytes.toString()).toBe('# Original\n');
  f.db.close();
  const reopened = core.openDb(join(f.root, 'board.db'));
  expect(core.roleRevision(core.openController(reopened), { roleId: first.roleId, revision: 1 }).manifestHash).toBe(first.manifestHash);
  expect(core.currentRoleRevision(core.openController(reopened), first.roleId).hash).toBe(second.hash);
  reopened.close();
});

it('replays the same command but rejects changed payload and a stale revision without new rows', () => {
  const f = fixture(), input = { expectedRevision: 0, commandId: 'create-builder', definition: f.definition(f.local) };
  const first = core.saveRoleRevision(f.handle, input);
  expect(core.saveRoleRevision(f.handle, input)).toEqual(first);
  expect(() => core.saveRoleRevision(f.handle, { ...input, definition: { ...input.definition, prompt: 'Changed' } })).toThrow(/command|replay/i);
  const secondConnection = core.openDb(join(f.root, 'board.db'));
  expect(() => core.saveRoleRevision(core.openController(secondConnection), { roleId: first.roleId,
    expectedRevision: 0, commandId: 'stale', definition: input.definition })).toThrow(/revision|fence/i);
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM role_revisions').get()).toEqual({ n: 1 });
  secondConnection.close(); f.db.close();
});

it('revokes a role for future revisions while retaining historical reads', () => {
  const f = fixture();
  const first = core.saveRoleRevision(f.handle, { expectedRevision: 0, commandId: 'create-builder',
    definition: f.definition(f.local) });
  core.revokeRole(f.handle, first.roleId);
  expect(core.roleRevision(f.handle, { roleId: first.roleId, revision: 1 }).hash).toBe(first.hash);
  expect(() => f.db.prepare('UPDATE role_profiles SET revoked_at=NULL WHERE id=?').run(first.roleId)).toThrow();
  expect(() => core.saveRoleRevision(f.handle, { roleId: first.roleId, expectedRevision: 1,
    commandId: 'after-revoke', definition: f.definition(f.local) })).toThrow(/revoked/i);
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM role_revisions').get()).toEqual({ n: 1 });
  f.db.close();
});

it('rejects duplicate names across modes and unsafe local files without saving a revision', () => {
  const f = fixture();
  const base = f.definition(f.local);
  expect(() => core.saveRoleRevision(f.handle, { expectedRevision: 0, commandId: 'duplicate', definition: {
    ...base, skills: [...base.skills, { ...base.skills[0], name: 'guide', mode: 'Available' as const }],
  } })).toThrow(/duplicate|skill/i);
  const outside = join(f.root, 'outside'); writeFileSync(outside, 'outside');
  for (const [name, make] of [
    ['symlink', () => symlinkSync(outside, join(f.guide, 'alias'))],
    ['hardlink', () => linkSync(outside, join(f.guide, 'alias'))],
    ['oversize', () => writeFileSync(join(f.guide, 'alias'), Buffer.alloc(1048577))],
    ['special', () => execFileSync('/usr/bin/mkfifo', [join(f.guide, 'alias')])],
  ] as const) {
    make();
    expect(() => core.saveRoleRevision(f.handle, { expectedRevision: 0, commandId: name,
      definition: base })).toThrow();
    rmSync(join(f.guide, 'alias'));
  }
  expect(() => core.saveRoleRevision(f.handle, { expectedRevision: 0, commandId: 'traversal',
    definition: f.definition({ kind: 'local', root: f.skills, path: '../outside' }) })).toThrow();
  const rootAlias = join(f.root, 'skills-alias'); symlinkSync(f.skills, rootAlias);
  expect(() => core.saveRoleRevision(f.handle, { expectedRevision: 0, commandId: 'root-alias',
    definition: f.definition({ kind: 'local', root: rootAlias, path: 'guide' }) })).toThrow();
  const parentAlias = join(f.root, 'parent-alias'); symlinkSync(f.root, parentAlias);
  expect(() => core.saveRoleRevision(f.handle, { expectedRevision: 0, commandId: 'parent-alias',
    definition: f.definition({ kind: 'local', root: join(parentAlias, 'skills'), path: 'guide' }) })).toThrow();
  expect(() => core.saveRoleRevision(f.handle, { expectedRevision: 0, commandId: 'dotdot-root',
    definition: f.definition({ kind: 'local', root: `${f.skills}/../skills`, path: 'guide' }) })).toThrow();
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM role_revisions').get()).toEqual({ n: 0 });
  f.db.close();
});

it('rolls back profile, files and audit together if a skill row cannot be stored', () => {
  const f = fixture();
  f.db.exec(`CREATE TRIGGER fail_role_file BEFORE INSERT ON role_skill_files
    WHEN NEW.relative_path='reference.txt' BEGIN SELECT RAISE(ABORT,'fixture failure'); END`);
  const events = (f.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
  expect(() => core.saveRoleRevision(f.handle, { expectedRevision: 0, commandId: 'incomplete',
    definition: f.definition(f.local) })).toThrow(/fixture failure/);
  for (const table of ['role_profiles', 'role_revisions', 'role_skill_files']) {
    expect(f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
  }
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: events });
  f.db.close();
});

it('refuses missing or credential-bearing SKILL.md and a skill above its total byte cap', () => {
  const f = fixture(), body = join(f.guide, 'SKILL.md');
  rmSync(body);
  expect(() => core.saveRoleRevision(f.handle, { expectedRevision: 0, commandId: 'missing-body',
    definition: f.definition(f.local) })).toThrow(/body|SKILL/i);
  writeFileSync(body, `# Key\nsk-${'a'.repeat(20)}\n`);
  expect(() => core.saveRoleRevision(f.handle, { expectedRevision: 0, commandId: 'credential',
    definition: f.definition(f.local) })).toThrow(/credential/i);
  writeFileSync(body, '# Safe\n');
  for (let i = 0; i < 9; i++) writeFileSync(join(f.guide, `part-${i}.bin`), Buffer.alloc(1048576));
  expect(() => core.saveRoleRevision(f.handle, { expectedRevision: 0, commandId: 'total-cap',
    definition: f.definition(f.local) })).toThrow(/large/i);
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM role_revisions').get()).toEqual({ n: 0 });
  f.db.close();
});

it('rejects undeclared role and source fields before writing a revision', () => {
  const f = fixture(), base = f.definition(f.local);
  expect(() => core.saveRoleRevision(f.handle, { expectedRevision: 0, commandId: 'extra-server',
    definition: { ...base, mcpServers: ['foreign'] } as never })).toThrow();
  expect(() => core.saveRoleRevision(f.handle, { expectedRevision: 0, commandId: 'extra-source',
    definition: { ...base, skills: [{ ...base.skills[0], source: { ...f.local, token: 'private' } }] } as never })).toThrow();
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM role_revisions').get()).toEqual({ n: 0 });
  f.db.close();
});

it('imports repo skill bytes from the pinned commit instead of a changed checkout', () => {
  const f = fixture();
  const path = join(f.repo, 'skill'); mkdirSync(path);
  writeFileSync(join(path, 'SKILL.md'), '# Committed\n');
  f.git('add', 'skill/SKILL.md'); f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'skill');
  const commit = f.git('rev-parse', 'HEAD');
  writeFileSync(join(path, 'SKILL.md'), '# Uncommitted\n');
  const receipt = core.saveRoleRevision(f.handle, { expectedRevision: 0, commandId: 'git-source',
    definition: f.definition({ kind: 'repo', repoId: core.projectOf(f.db).primary_repo_id!,
      checkoutPath: f.repo, commit, path: 'skill' }) });
  const pinned = f.db.prepare('SELECT bytes FROM role_skill_files WHERE role_id=? AND relative_path=?')
    .get(receipt.roleId, 'SKILL.md') as { bytes: Buffer };
  expect(pinned.bytes.toString()).toBe('# Committed\n');
  expect(readFileSync(join(path, 'SKILL.md'), 'utf8')).toBe('# Uncommitted\n');
  f.git('add', 'skill/SKILL.md'); f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'replacement');
  f.git('replace', commit, f.git('rev-parse', 'HEAD'));
  const replaced = core.saveRoleRevision(f.handle, { expectedRevision: 0, commandId: 'git-replace-source',
    definition: f.definition({ kind: 'repo', repoId: core.projectOf(f.db).primary_repo_id!,
      checkoutPath: f.repo, commit, path: 'skill' }) });
  expect((f.db.prepare('SELECT bytes FROM role_skill_files WHERE role_id=? AND relative_path=?')
    .get(replaced.roleId, 'SKILL.md') as { bytes: Buffer }).bytes.toString()).toBe('# Committed\n');
  f.db.close();
});
