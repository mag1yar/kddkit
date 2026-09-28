import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import * as core from '../src/index.js';

// Only the slow external matrix is isolated; actual Git, package branding and SQLite stay real.
vi.mock('../src/codex_native_probe.js', () => ({
  observeCodexNative: async () => ({ applicable: true, rawDiagnostic: false, executed: 129,
    observations: Array.from({ length: 129 }, (_, i) => ({ caseId: String(i), mode: 'workspace',
      tool: 'exec_command', outcome: 'denied', executed: true, unchangedProtectedBytes: true })) }),
}));

it.skipIf(process.platform !== 'darwin').each([false, true])('refuses a store in writable scratch before marker/grant (workspace write=%s)', async writable => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kdd-store-scope-'))), saved = { ...process.env };
  let db: ReturnType<typeof core.openDb> | undefined;
  try {
    const source = join(root, 'source'), workspace = join(root, 'workspace'), scratch = join(root, 'scratch');
    const controlDir = join(root, 'control'), executable = join(root, 'codex-fixture');
    for (const path of [source, scratch, controlDir]) mkdirSync(path);
    const git = (cwd: string, ...args: string[]) => execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
    git(source, 'init', '-q'); git(source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'seed');
    git(root, 'clone', '--no-hardlinks', '-q', source, workspace);
    process.env.KDD_HOME = controlDir; delete process.env.KDD_DB; delete process.env.KDD_DECISIONS_DIR;
    db = core.openDb(join(scratch, 'board.db'), core.canonicalCommonDir(source), source);
    const user = { type: 'user' } as const, repoId = core.projectOf(db).primary_repo_id!;
    core.bindRepository(db, db.name, controlDir, { cwd: workspace, repoId, kind: 'managed' }, user);
    const task = core.addTask(db, { title: 'private store' }, user);
    writeFileSync(executable, '#!/bin/sh\nprintf "codex-cli 0.157.0\\n"\n', { mode: 0o755 });
    const native = await core.preflightCodex({ executable, cwd: workspace, readableRoots: [workspace],
      writableRoot: writable ? workspace : undefined, scratchDir: scratch, controlDir, model: 'fixture-codex', protectedPaths: [source] });
    const before = ['managed_task_policy', 'run_authorities', 'events'].map(table => db!.prepare(`SELECT * FROM ${table}`).all());
    expect(() => core.issueRunAuthority(core.openController(db!), { taskId: task.id, workItemId: 'work', runId: 'run',
      expectedGeneration: 0, expiresAt: core.now() + 60, operations: ['get_context'], native,
      repositories: [{ repoId, checkoutPath: workspace, write: writable }] })).toThrow(/store|scope/);
    expect(['managed_task_policy', 'run_authorities', 'events'].map(table => db!.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
  } finally { db?.close(); process.env = saved; rmSync(root, { recursive: true, force: true }); }
});
