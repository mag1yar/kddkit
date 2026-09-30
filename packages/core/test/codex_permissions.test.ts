import { mkdtempSync, mkdirSync, writeFileSync, linkSync, existsSync, rmSync, symlinkSync, chmodSync, rmdirSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as probe from '../src/codex_native_probe.js';
import * as core from '../src/index.js';
import { codexBrokerBinding, fixedCodexConfig } from '../src/codex_permissions.js';
import { runInputFixture } from './run_inputs_fixture.js';
import { cleanupFixtures } from './execution_fixture.js';

const api = core;
let root: string; let workspace: string; let scratch: string; let controlDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kdd-native-guard-'));
  workspace = join(root, 'workspace'); scratch = join(root, 'scratch'); controlDir = join(root, 'control');
  for (const path of [workspace, scratch, controlDir]) mkdirSync(path);
  writeFileSync(join(root, 'foreign'), 'foreign');
});
afterEach(() => { cleanupFixtures(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });
const input = (phase: 'start' | 'resume') => ({
  controlDir, writableRoots: [workspace, scratch], executable: process.execPath,
  args: ['-e', 'require("node:fs").writeFileSync("started","yes")'],
  cwd: workspace, env: { PATH: process.env.PATH ?? '' }, phase,
});
function fixtureModelExecutable(path: string): void {
  writeFileSync(path, `#!/usr/bin/env node
if (process.argv[2] === '--version') { console.log('codex-cli 0.159.0'); process.exit(0); }
const reader = require('node:readline').createInterface({ input: process.stdin });
reader.on('line', line => { const request = JSON.parse(line);
  if (request.id === 1) console.log(JSON.stringify({ id: 1, result: {} }));
  if (request.method === 'model/list') console.log(JSON.stringify({ id: request.id, result: {
    data: [{ model: 'fixture-codex', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }], nextCursor: null } }));
});
`, { mode: 0o755 });
  mkdirSync(join(root, '.codex'));
  writeFileSync(join(root, '.codex/models_cache.json'), JSON.stringify({ client_version: '0.159.0',
    fetched_at: new Date().toISOString(), models: [{ slug: 'fixture-codex', context_window: 100000,
      effective_context_window_percent: 95 }] }));
}

it('rejects fabricated native proof instead of accepting serialized evidence', () => {
  expect(() => api.assertVerifiedCodexPackage({})).toThrow(/unverified/);
  expect(() => api.assertVerifiedCodexPackage({ executable: process.execPath, results: [{ outcome: 'allowed' }] })).toThrow(/unverified/);
});
it.runIf(process.platform === 'darwin')('admits only the installed Codex version to native proof', async () => {
  execFileSync('/usr/bin/git', ['init', '-q', workspace]);
  const executable = join(root, 'fixture-codex');
  const previousHome = process.env.HOME; process.env.HOME = root;
  const candidate = { executable, cwd: workspace, readableRoots: [workspace], writableRoot: workspace,
    scratchDir: scratch, controlDir, model: 'fixture-codex', effort: 'high', protectedPaths: [join(root, 'foreign')] };
  fixtureModelExecutable(executable);
  vi.spyOn(probe, 'observeCodexNative').mockResolvedValue({ version: 'fixture', model: 'fixture',
    executableHash: 'fixture', scriptHash: 'fixture', guardHash: 'fixture', applicable: true, rawDiagnostic: false,
    attempted: 0, executed: 0, failures: [], observations: [], operations: [], preflight: [], networkControls: [] });
  try {
    await expect(api.preflightCodex(candidate)).rejects.toThrow('Codex native enforcement unverified');
    for (const version of ['0.157.0', '0.160.0']) {
      writeFileSync(executable, `#!/bin/sh\nprintf "codex-cli ${version}\\n"\n`, { mode: 0o755 });
      await expect(api.preflightCodex(candidate)).rejects.toThrow('unsupported Codex version');
    }
  } finally { process.env.HOME = previousHome; }
});
it.runIf(process.platform === 'darwin')('pins a discovered model and effort in the verified package', async () => {
  execFileSync('/usr/bin/git', ['init', '-q', workspace]);
  const executable = join(root, 'fixture-codex');
  writeFileSync(executable, `#!/usr/bin/env node
if (process.argv[2] === '--version') { console.log('codex-cli 0.159.0'); process.exit(0); }
const reader = require('node:readline').createInterface({ input: process.stdin });
reader.on('line', line => { const request = JSON.parse(line);
  if (request.id === 1) console.log(JSON.stringify({ id: 1, result: {} }));
  if (request.method === 'model/list') console.log(JSON.stringify({ id: request.id, result: {
    data: [{ model: 'gpt-6-sol', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }], nextCursor: null } }));
});
`, { mode: 0o755 });
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  mkdirSync(join(root, '.codex'));
  writeFileSync(join(root, '.codex/models_cache.json'), JSON.stringify({ client_version: '0.159.0',
    fetched_at: new Date().toISOString(), models: [{ slug: 'gpt-6-sol', context_window: 100000,
      effective_context_window_percent: 95 }] }));
  vi.spyOn(probe, 'observeCodexNative').mockResolvedValue({ version: 'fixture', model: 'fixture',
    executableHash: 'fixture', scriptHash: 'fixture', guardHash: 'fixture', applicable: true, rawDiagnostic: false,
    attempted: 129, executed: 129, failures: [], operations: [], preflight: [], networkControls: [],
    observations: Array.from({ length: 129 }, (_, i) => ({ caseId: String(i), mode: 'readonly',
      tool: 'exec_command', outcome: 'denied', executed: true, unchangedProtectedBytes: true,
      control: false, phase: 'start', exitCode: 0, output: {}, timedOut: false, requests: [], tools: [],
      permissionHash: 'fixture', configHash: 'fixture', firstRequestBytes: 1024, protectedHashes: [] })) });
  try {
    const candidate = { executable, cwd: workspace, readableRoots: [workspace], writableRoot: workspace,
      scratchDir: scratch, controlDir, model: 'gpt-6-sol', effort: 'high', protectedPaths: [join(root, 'foreign')] };
    const packet = await api.preflightCodex(candidate);
    expect({ model: packet.model, effort: packet.effort }).toEqual({ model: 'gpt-6-sol', effort: 'high' });
    expect(packet.argv.join(' ')).toContain('model_reasoning_effort');
    await expect(api.preflightCodex({ ...candidate, effort: 'ultra' })).rejects.toThrow(/effort/);
    writeFileSync(join(root, '.codex/models_cache.json'), JSON.stringify({ client_version: '0.159.0',
      fetched_at: new Date().toISOString(), models: [{ slug: 'gpt-6-sol', context_window: 120000,
        effective_context_window_percent: 95 }] }));
    expect(() => api.assertVerifiedCodexPackage(packet)).not.toThrow(); // Later cache writers cannot rewrite the captured model limit.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 86400001);
    expect(() => api.assertVerifiedCodexPackage(packet)).toThrow(/binding/);
  } finally { process.env.HOME = previousHome; }
});
it.runIf(process.platform === 'darwin')('reports bounded matrix diagnostics while refusing incomplete native evidence', async () => {
  // Unit fixture only: no real native proof or branded package is created.
  const executable = join(root, 'fixture-codex');
  const previousHome = process.env.HOME; process.env.HOME = root;
  fixtureModelExecutable(executable);
  execFileSync('/usr/bin/git', ['init', '-q', workspace]);
  vi.spyOn(probe, 'observeCodexNative').mockResolvedValue({ version: 'fixture', model: 'fixture',
    executableHash: 'fixture', scriptHash: 'fixture', guardHash: 'fixture', applicable: true, rawDiagnostic: false,
    attempted: 0, executed: 0, failures: [], observations: [], operations: [], preflight: [], networkControls: [] });
  try {
    await expect(api.preflightCodex({ executable, cwd: workspace, readableRoots: [workspace], writableRoot: workspace,
      scratchDir: scratch, controlDir, model: 'fixture-codex', effort: 'high', protectedPaths: [join(root, 'foreign')] }))
      .rejects.toMatchObject({ message: 'Codex native enforcement unverified',
        cause: { expected: 129, attempted: 0, executed: 0, applicable: true, observations: [] } });
  } finally { process.env.HOME = previousHome; }
});
it.runIf(process.platform === 'darwin')('keeps the bound package valid when a broker credential rotates to the issued run', async () => {
  const f = runInputFixture();
  const executable = join(root, 'fixture-codex'); fixtureModelExecutable(executable);
  writeFileSync(join(root, '.codex/models_cache.json'), JSON.stringify({ client_version: '0.159.0',
    fetched_at: new Date().toISOString(), models: [{ slug: 'fixture-codex', context_window: 500000,
      effective_context_window_percent: 95 }] }));
  const previousHome = process.env.HOME; process.env.HOME = root;
  const skillRoot = join(f.root, 'rotation-skill'); mkdirSync(join(skillRoot, 'guide'), { recursive: true });
  writeFileSync(join(skillRoot, 'guide', 'SKILL.md'), '# Probe guide\n');
  const operations = ['get_context', 'read_skill_file'] as const;
  const skills = [{ name: 'ProbeGuide', mode: 'Always' as const, description: 'Pinned guide',
    source: { kind: 'local' as const, root: skillRoot, path: 'guide' } }];
  const role = core.saveRoleRevision(f.handle, { expectedRevision: 0, commandId: 'native-rotation-role', definition: {
    name: 'Rotation', prompt: 'Read context.', runtime: 'codex', model: 'fixture-codex', effort: 'high',
    access: 'workspace-write', operations, skills,
  } });
  const probeRole = core.saveRoleRevision(f.handle, { expectedRevision: 0, commandId: 'native-probe-role', definition: {
    name: 'Probe', prompt: 'Read context.', runtime: 'codex', model: 'fixture-codex', effort: 'high',
    access: 'read', operations, skills,
  } });
  const entry = join(f.home, 'run_main.js'), config = join(f.home, 'broker.json');
  writeFileSync(entry, '// native fixture');
  vi.spyOn(probe, 'observeCodexNative').mockImplementation(async (_executable, _diagnostic, _model, broker) => {
    const count = broker ? 160 : 129;
    return { version: 'fixture', model: 'fixture', executableHash: 'fixture', scriptHash: 'fixture', guardHash: 'fixture',
      applicable: true, rawDiagnostic: false, attempted: count, executed: count, failures: [], operations: [], preflight: [], networkControls: [],
      observations: Array.from({ length: count }, (_, i) => ({ caseId: String(i), mode: 'workspace' as const,
        tool: 'exec_command', outcome: 'denied' as const, executed: true, unchangedProtectedBytes: true,
        control: false, phase: 'start' as const, exitCode: 0, output: {}, timedOut: false, requests: [], tools: [],
        permissionHash: 'fixture', configHash: 'fixture', firstRequestBytes: 1024, protectedHashes: [] })) };
  });
  try {
    const candidate = { executable, cwd: f.workspace, readableRoots: [f.workspace], writableRoot: f.workspace,
      scratchDir: f.scratch, controlDir: f.home, model: 'fixture-codex', effort: 'high', protectedPaths: [f.repo, f.home] };
    const bootstrap = await core.preflightCodex({ ...candidate, writableRoot: undefined });
    const first = core.issueRunAuthority(f.handle, { ...f.input, taskId: f.task('probe').id,
      workItemId: 'native-probe', repositories: [{ repoId: f.repoId, checkoutPath: f.workspace, write: false }],
      native: bootstrap, role: probeRole, operations, probeBootstrap: true });
    writeFileSync(config, JSON.stringify({ dbPath: f.dbPath, token: first.token }), { mode: 0o600 });
    const bound = await core.preflightCodex({ ...candidate, brokerConfigPath: config, brokerEntryPath: entry });
    const second = core.issueRunAuthority(f.handle, { ...f.input, runId: 'rotation-2', native: bound, role, operations });
    writeFileSync(config, JSON.stringify({ dbPath: f.dbPath, token: second.token }));
    expect(() => core.assertVerifiedCodexPackage(bound)).not.toThrow();
    expect(core.prepareRoleLaunch(f.handle, { projectId: f.projectId, authorityId: second.authorityId, native: bound }).model)
      .toBe('fixture-codex');
  } finally { process.env.HOME = previousHome; }
}, 15_000);
it('binds only a private fixed broker config, independently of credential rotation', () => {
  const config = join(controlDir, 'broker.json'), entry = join(controlDir, 'run_main.js'), db = join(controlDir, 'board.db');
  writeFileSync(entry, '// fixture'); writeFileSync(db, 'fixture');
  writeFileSync(config, JSON.stringify({ dbPath: realpathSync(db), token: 'a'.repeat(64) }), { mode: 0o600 });
  const binding = codexBrokerBinding(config, entry);
  const overrides = fixedCodexConfig({ ':minimal': 'read' }, config, binding);
  expect(JSON.stringify(overrides)).not.toContain('a'.repeat(64));
  expect(overrides.join('\n')).toContain('mcp_servers={kdd_run=');
  expect(overrides.join('\n')).not.toContain('read_skill_file');
  expect(fixedCodexConfig({ ':minimal': 'read' }, config, binding, 'high', ['get_context', 'read_skill_file']).join('\n'))
    .toContain('enabled_tools=["get_context","read_skill_file"]');
  writeFileSync(config, JSON.stringify({ dbPath: realpathSync(db), token: 'b'.repeat(64) }));
  expect(codexBrokerBinding(config, entry)).toEqual(binding);
  linkSync(config, join(workspace, 'credential-alias'));
  expect(() => codexBrokerBinding(config, entry)).toThrow(/binding/);
  rmSync(join(workspace, 'credential-alias')); chmodSync(config, 0o644);
  expect(() => codexBrokerBinding(config, entry)).toThrow(/config/);
  writeFileSync(config, '{"token":"secret-fixture", invalid JSON');
  expect(() => codexBrokerBinding(config, entry)).toThrow(/^native broker binding unavailable$/);
  chmodSync(config, 0o600); writeFileSync(config, JSON.stringify({ dbPath: db, token: 'c'.repeat(64), command: 'arbitrary' }));
  expect(() => codexBrokerBinding(config, entry)).toThrow(/config/);
});

it('does not issue a native package for another executable or overlapping writable roots', async () => {
  const candidate = { executable: process.execPath, cwd: workspace, readableRoots: [workspace], writableRoot: workspace,
    scratchDir: scratch, controlDir, model: 'fixture-codex', effort: 'high', protectedPaths: [join(root, 'foreign')] };
  await expect(api.preflightCodex(candidate)).rejects.toThrow(/unsupported|Codex/);
  await expect(api.preflightCodex({ ...candidate, scratchDir: workspace })).rejects.toThrow(/overlap/);
  await expect(api.preflightCodex({ ...candidate, protectedPaths: [workspace] })).rejects.toThrow(/overlap/);
  await expect(api.preflightCodex({ ...candidate, controlDir: scratch })).rejects.toThrow(/control|overlap/);
  await expect(api.preflightCodex({ ...candidate, protectedPaths: ['relative-private'] })).rejects.toThrow(/absolute/);
});

it('refuses a project overlay before execution, including a config appearing in an ancestor', async () => {
  const candidate = { executable: process.execPath, cwd: workspace, readableRoots: [workspace], writableRoot: workspace,
    scratchDir: scratch, controlDir, model: 'fixture-codex', effort: 'high', protectedPaths: [join(root, 'foreign')] };
  for (const location of [workspace, root]) {
    mkdirSync(join(location, '.codex'));
    writeFileSync(join(location, '.codex/config.toml'), 'sandbox_mode="danger-full-access"');
    await expect(api.preflightCodex(candidate)).rejects.toThrow(/overlay/);
    rmSync(join(location, '.codex'), { recursive: true });
  }
});

it('does not treat an explicit fabricated launch package as a trusted-host probe', async () => {
  await expect(api.spawnCheckedNative({ ...input('start'), verified: {} as core.VerifiedCodexPackage })).rejects.toThrow(/unverified/);
  expect(existsSync(join(workspace, 'started'))).toBe(false);
});

it('rejects deep pre-existing hardlinks in every writable root before spawning', async () => {
  for (const writable of [workspace, scratch]) {
    const deep = join(writable, 'deep'); mkdirSync(deep);
    linkSync(join(root, 'foreign'), join(deep, 'alias'));
    expect(() => api.assertWritableRoots([workspace, scratch])).toThrow(/hardlink/);
    await expect(api.spawnCheckedNative(input('start'))).rejects.toThrow(/hardlink/);
    expect(existsSync(join(workspace, 'started'))).toBe(false);
    rmSync(deep, { recursive: true });
  }
});

it('rechecks writable roots before resume instead of trusting a previous scan', async () => {
  api.assertWritableRoots([workspace, scratch]);
  linkSync(join(root, 'foreign'), join(scratch, 'late-alias'));
  await expect(api.spawnCheckedNative(input('resume'))).rejects.toThrow(/hardlink/);
  expect(existsSync(join(workspace, 'started'))).toBe(false);
});

it('rejects unknown roots and refuses symlink roots', () => {
  expect(() => api.assertWritableRoots([])).toThrow(/unknown/);
  expect(() => api.assertWritableRoots([join(root, 'missing')])).toThrow(/root/);
  const alias = join(root, 'root-alias'); symlinkSync(workspace, alias);
  expect(() => api.assertWritableRoots([alias])).toThrow(/root/);
});

it('refuses an unreadable tree and a root replaced with a symlink after an earlier scan', async () => {
  const deep = join(scratch, 'unreadable'); mkdirSync(deep); chmodSync(deep, 0);
  try { await expect(api.spawnCheckedNative(input('resume'))).rejects.toThrow(/incomplete/); }
  finally { chmodSync(deep, 0o700); }
  api.assertWritableRoots([workspace, scratch]);
  rmSync(scratch, { recursive: true }); symlinkSync(workspace, scratch);
  await expect(api.spawnCheckedNative(input('resume'))).rejects.toThrow(/root/);
  expect(existsSync(join(workspace, 'started'))).toBe(false);
});

it('checks symlink inodes without following readonly foreign targets', () => {
  symlinkSync(join(root, 'foreign'), join(workspace, 'foreign-symlink'));
  expect(api.assertWritableRoots([workspace, scratch])).toHaveLength(2);
  linkSync(join(workspace, 'foreign-symlink'), join(workspace, 'linked-symlink'));
  expect(() => api.assertWritableRoots([workspace, scratch])).toThrow(/hardlink/);
});

it('blocks other controller operations until the current holder releases its lock', async () => {
  let touched = false;
  await api.withNativeControllerLock(controlDir, async () => {
    await expect(api.withNativeControllerLock(controlDir, () => { touched = true; }))
      .rejects.toThrow(/busy/);
    await expect(api.spawnCheckedNative(input('start'))).rejects.toThrow(/busy/);
  });
  expect(touched).toBe(false);
  await api.withNativeControllerLock(controlDir, () => { touched = true; });
  expect(touched).toBe(true);
});

it('excludes another OS process and refuses an abandoned lock without stealing it', async () => {
  const attempt = `const fs=require('node:fs');try {fs.mkdirSync(process.argv[1]);process.exit(3)}catch(e){if(e.code!=='EEXIST')throw e}`;
  const lock = join(controlDir, 'native-launch.lock');
  await api.withNativeControllerLock(controlDir, () => {
    execFileSync(process.execPath, ['-e', attempt, lock]);
    expect(existsSync(lock)).toBe(true);
  });
  execFileSync(process.execPath, ['-e', "require('node:fs').mkdirSync(process.argv[1])", lock]);
  await expect(api.spawnCheckedNative(input('resume'))).rejects.toThrow(/busy/);
  expect(existsSync(lock)).toBe(true);
  rmdirSync(lock); // Only the trusted fixture owner recovers its abandoned lock.
  await expect(api.withNativeControllerLock(controlDir, () => 'released')).resolves.toBe('released');
});

it('rejects a writable control directory and releases its own lock after failed spawn', async () => {
  await expect(api.spawnCheckedNative({ ...input('start'), controlDir: scratch })).rejects.toThrow(/control/);
  await expect(api.spawnCheckedNative({ ...input('start'), executable: join(root, 'absent') })).rejects.toThrow();
  await expect(api.withNativeControllerLock(controlDir, () => 'released')).resolves.toBe('released');
});

it('starts a real process after successful fresh checks', async () => {
  const child = await api.spawnCheckedNative(input('start'));
  const code = await new Promise(resolve => child.once('close', resolve));
  expect(code).toBe(0);
  expect(existsSync(join(workspace, 'started'))).toBe(true);
  await expect(api.withNativeControllerLock(controlDir, () => 'released')).resolves.toBe('released');
});
