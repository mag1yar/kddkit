import { mkdtempSync, mkdirSync, writeFileSync, linkSync, existsSync, rmSync, symlinkSync, chmodSync, rmdirSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import * as core from '../src/index.js';
import { codexBrokerBinding, fixedCodexConfig } from '../src/codex_permissions.js';

const api = core;
let root: string; let workspace: string; let scratch: string; let controlDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kdd-native-guard-'));
  workspace = join(root, 'workspace'); scratch = join(root, 'scratch'); controlDir = join(root, 'control');
  for (const path of [workspace, scratch, controlDir]) mkdirSync(path);
  writeFileSync(join(root, 'foreign'), 'foreign');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const input = (phase: 'start' | 'resume') => ({
  controlDir, writableRoots: [workspace, scratch], executable: process.execPath,
  args: ['-e', 'require("node:fs").writeFileSync("started","yes")'],
  cwd: workspace, env: { PATH: process.env.PATH ?? '' }, phase,
});

it('rejects fabricated native proof instead of accepting serialized evidence', () => {
  expect(() => api.assertVerifiedCodexPackage({})).toThrow(/unverified/);
  expect(() => api.assertVerifiedCodexPackage({ executable: process.execPath, results: [{ outcome: 'allowed' }] })).toThrow(/unverified/);
});
it('binds only a private fixed broker config, independently of credential rotation', () => {
  const config = join(controlDir, 'broker.json'), entry = join(controlDir, 'run_main.js'), db = join(controlDir, 'board.db');
  writeFileSync(entry, '// fixture'); writeFileSync(db, 'fixture');
  writeFileSync(config, JSON.stringify({ dbPath: realpathSync(db), token: 'a'.repeat(64) }), { mode: 0o600 });
  const binding = codexBrokerBinding(config, entry);
  const overrides = fixedCodexConfig({ ':minimal': 'read' }, config, binding);
  expect(JSON.stringify(overrides)).not.toContain('a'.repeat(64));
  expect(overrides.join('\n')).toContain('mcp_servers={kdd_run=');
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
    scratchDir: scratch, controlDir, model: 'fixture-codex', protectedPaths: [join(root, 'foreign')] };
  await expect(api.preflightCodex(candidate)).rejects.toThrow(/unsupported|Codex/);
  await expect(api.preflightCodex({ ...candidate, scratchDir: workspace })).rejects.toThrow(/overlap/);
  await expect(api.preflightCodex({ ...candidate, protectedPaths: [workspace] })).rejects.toThrow(/overlap/);
  await expect(api.preflightCodex({ ...candidate, controlDir: scratch })).rejects.toThrow(/control|overlap/);
  await expect(api.preflightCodex({ ...candidate, protectedPaths: ['relative-private'] })).rejects.toThrow(/absolute/);
});

it('refuses a project overlay before execution, including a config appearing in an ancestor', async () => {
  const candidate = { executable: process.execPath, cwd: workspace, readableRoots: [workspace], writableRoot: workspace,
    scratchDir: scratch, controlDir, model: 'fixture-codex', protectedPaths: [join(root, 'foreign')] };
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
