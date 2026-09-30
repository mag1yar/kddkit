import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

// Isolate the slow runtime matrix; Git resolution, package stamps and launch guards stay real.
vi.mock('../src/codex_native_probe.js', () => ({
  observeCodexNative: async () => ({ applicable: true, rawDiagnostic: false, executed: 129,
    observations: Array.from({ length: 129 }, (_, i) => ({ caseId: String(i), mode: 'workspace',
      tool: 'exec_command', outcome: 'denied', executed: true, unchangedProtectedBytes: true })) }),
}));
import { assertVerifiedCodexPackage, preflightCodex, spawnCheckedNative, withNativeControllerLock } from '../src/codex_permissions.js';

it.skipIf(process.platform !== 'darwin')('refuses start and resume when a linked worktree changes its common-dir', async () => {
  const previousHome = process.env.HOME;
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kdd-git-binding-')));
  try {
    const clone = join(root, 'clone'), workspace = join(root, 'workspace');
    const scratch = join(root, 'scratch'), controlDir = join(root, 'control'), executable = join(root, 'codex-fixture');
    for (const path of [clone, scratch, controlDir]) mkdirSync(path);
    writeFileSync(executable, `#!/usr/bin/env node
if (process.argv[2] === '--version') { console.log('codex-cli 0.159.0'); process.exit(0); }
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === 1) console.log(JSON.stringify({ id: 1, result: {} }));
  if (request.method === 'model/list') console.log(JSON.stringify({ id: request.id, result: {
    data: [{ model: 'gpt-6-sol', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }], nextCursor: null } }));
});
`, { mode: 0o755 });
    process.env.HOME = root; mkdirSync(join(root, '.codex'));
    writeFileSync(join(root, '.codex/models_cache.json'), JSON.stringify({ client_version: '0.159.0',
      fetched_at: new Date().toISOString(), models: [{ slug: 'gpt-6-sol', context_window: 100000,
        effective_context_window_percent: 95 }] }));
    const git = (cwd: string, ...args: string[]) => execFileSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
    git(clone, 'init', '-q');
    git(clone, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'seed');
    git(clone, 'worktree', 'add', '-q', '-b', 'fixture', workspace);
    const packet = await preflightCodex({ executable, cwd: workspace, readableRoots: [workspace], writableRoot: workspace,
      scratchDir: scratch, controlDir, model: 'gpt-6-sol', effort: 'high', protectedPaths: [clone] });
    expect(() => assertVerifiedCodexPackage(packet)).not.toThrow();
    const pointer = join(git(workspace, 'rev-parse', '--absolute-git-dir'), 'commondir'), original = readFileSync(pointer);
    const replacement = join(workspace, 'replacement-common');
    await withNativeControllerLock(controlDir, () => {
      cpSync(git(workspace, 'rev-parse', '--path-format=absolute', '--git-common-dir'), replacement, { recursive: true });
      writeFileSync(pointer, replacement + '\n');
    });
    expect(() => assertVerifiedCodexPackage(packet)).toThrow(/binding/);
    for (const phase of ['start', 'resume'] as const) {
      await expect(spawnCheckedNative({ executable, args: [...packet.argv, 'fixture'], cwd: workspace, env: packet.env,
        controlDir, writableRoots: [scratch, workspace], phase, verified: packet })).rejects.toThrow(/binding/);
    }
    await withNativeControllerLock(controlDir, () => { writeFileSync(pointer, original); rmSync(replacement, { recursive: true }); });
    expect(() => assertVerifiedCodexPackage(packet)).not.toThrow();
  } finally { process.env.HOME = previousHome; rmSync(root, { recursive: true, force: true }); }
});
