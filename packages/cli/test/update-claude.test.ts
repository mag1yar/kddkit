import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { updateClaude } from '../src/update-claude.js';
import type { Runner } from '../src/update.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(options: { ref?: string; version?: string; enabled?: boolean; failAdd?: boolean;
  failInstall?: boolean; failRestore?: boolean; extraScope?: boolean;
  extraOwnedScope?: boolean; pluginScope?: 'user' | 'project';
  extraDeclaration?: boolean; wrongTargetSource?: boolean; source?: 'github' | 'directory' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kdd-claude-update-'));
  dirs.push(dir);
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  const settings = join(dir, 'settings.json');
  const cwd = options.extraDeclaration || options.extraOwnedScope || options.pluginScope === 'project'
    ? join(dir, 'project') : process.cwd();
  if (cwd !== process.cwd()) {
    mkdirSync(cwd, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd });
  }
  const source = options.source ?? 'github';
  const initial = { source: source === 'github'
    ? { source: 'github', repo: 'mag1yar/kddkit', ...(options.ref ? { ref: options.ref } : {}) }
    : { source: 'directory', path: '/local/kddkit' } };
  writeFileSync(settings, JSON.stringify({ extraKnownMarketplaces: { kddkit: initial } }));
  if (options.extraDeclaration) {
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(join(cwd, '.claude/settings.local.json'), JSON.stringify({ extraKnownMarketplaces: { kddkit: initial } }));
  }
  let ref = options.ref;
  let version = options.version ?? '0.8.0';
  const foreignVersion = version;
  let enabled = options.enabled ?? true;
  let present = true;
  let installed = true;
  let failAdd = options.failAdd ?? false;
  let failInstall = options.failInstall ?? false;
  const calls: [string, string[]][] = [];
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const fail = (stderr: string) => ({ status: 1, stdout: '', stderr });
  const sync = () => writeFileSync(settings, JSON.stringify({ extraKnownMarketplaces: present
    ? { kddkit: { source: source === 'github'
      ? { source: 'github', repo: 'mag1yar/kddkit', ...(ref ? { ref } : {}) }
      : { source: 'directory', path: '/local/kddkit' } } } : {} }));
  const run: Runner = (file, args) => {
    calls.push([file, args]);
    if (file === 'git' && args[0] === 'clone') {
      const dest = args.at(-1)!;
      mkdirSync(join(dest, '.claude-plugin'), { recursive: true });
      writeFileSync(join(dest, '.claude-plugin/marketplace.json'), JSON.stringify({ name: 'kddkit', plugins: [{ name: 'kddkit' }] }));
      writeFileSync(join(dest, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'kddkit',
        version: args[4] === 'master' ? '0.8.0' : '0.9.0-next.1' }));
      return ok();
    }
    if (file !== 'claude') throw new Error(`unexpected ${file}`);
    if (args.join(' ') === 'plugin list --json') return ok(JSON.stringify(installed ? [{
      id: 'kddkit@kddkit', version, scope: options.pluginScope ?? 'user', enabled,
      ...(options.pluginScope === 'project' ? { projectPath: cwd } : {}),
      installPath: '/plugin', installedAt: '2026-01-01', lastUpdated: '2026-01-01',
    }, ...(options.extraOwnedScope ? [{ id: 'kddkit@kddkit', version, scope: 'project', enabled,
      projectPath: cwd, installPath: '/plugin', installedAt: '2026-01-01', lastUpdated: '2026-01-01' }] : []),
    ...(options.extraScope ? [{ id: 'kddkit@kddkit', version: foreignVersion, scope: 'project', enabled,
      projectPath: '/another/repo', installPath: '/plugin', installedAt: '2026-01-01', lastUpdated: '2026-01-01' }] : [])] : []));
    if (args.join(' ') === 'plugin marketplace list --json') return ok(JSON.stringify(present
      ? [{ name: 'kddkit', source, ...(source === 'github' ? { repo: options.wrongTargetSource && ref === 'next'
        ? 'other/repo' : 'mag1yar/kddkit', ...(ref ? { ref } : {}) } : { path: '/local/kddkit' }) }] : []));
    if (args[1] === 'marketplace' && args[2] === 'remove') { present = false; installed = false; sync(); return ok(); }
    if (args[1] === 'marketplace' && args[2] === 'add') {
      if (failAdd && args[3].endsWith('@next')) { failAdd = false; return fail('target add failed'); }
      if (options.failRestore && args[3].endsWith('@master')) return fail('restore failed');
      ref = args[3].split('@')[1]; present = true; sync(); return ok();
    }
    if (args[1] === 'marketplace' && args[2] === 'update') return ok();
    if (args[1] === 'install') {
      if (failInstall && ref === 'next') { failInstall = false; return fail('approval required; pass -y'); }
      installed = true; version = ref === 'next' ? '0.9.0-next.1' : '0.8.0'; enabled = true; return ok();
    }
    if (args[1] === 'update') { version = ref === 'next' ? '0.9.0-next.1' : '0.8.0'; return ok(); }
    if (args[1] === 'disable') { enabled = false; return ok(); }
    throw new Error(args.join(' '));
  };
  const restore = () => {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = before;
  };
  return { run, calls, settings, cwd, restore };
}

it('switches master to next and reinstalls the removed plugin without auto-approval', () => {
  const f = fixture({ ref: 'master' });
  try {
    expect(updateClaude('0.9.0-next.1', 'next', f.run, process.cwd())[0].status).toBe('updated');
    expect(f.calls).toContainEqual(['claude', ['plugin', 'marketplace', 'remove', 'kddkit', '--scope', 'user']]);
    expect(f.calls).toContainEqual(['claude', ['plugin', 'marketplace', 'add', 'mag1yar/kddkit@next', '--scope', 'user']]);
    expect(f.calls).toContainEqual(['claude', ['plugin', 'install', 'kddkit@kddkit', '--scope', 'user']]);
    expect(f.calls.some(([, args]) => args.includes('-y'))).toBe(false);
  } finally { f.restore(); }
});

it('switches a user marketplace with a project-scoped plugin and restores its scope on failure', () => {
  const f = fixture({ ref: 'master', pluginScope: 'project' });
  try {
    expect(updateClaude('0.9.0-next.1', 'next', f.run, f.cwd)[0].status).toBe('updated');
    expect(f.calls).toContainEqual(['claude', ['plugin', 'marketplace', 'remove', 'kddkit', '--scope', 'user']]);
    expect(f.calls).toContainEqual(['claude', ['plugin', 'install', 'kddkit@kddkit', '--scope', 'project']]);
  } finally { f.restore(); }
  const failed = fixture({ ref: 'master', pluginScope: 'project', failAdd: true });
  try {
    expect(updateClaude('0.9.0-next.1', 'next', failed.run, failed.cwd)[0].detail).toContain('restored');
    expect(failed.calls).toContainEqual(['claude', ['plugin', 'install', 'kddkit@kddkit', '--scope', 'project']]);
  } finally { failed.restore(); }
});

it('reinstalls all owned plugin scopes after switching a shared user marketplace', () => {
  const f = fixture({ ref: 'master', extraOwnedScope: true });
  try {
    expect(updateClaude('0.9.0-next.1', 'next', f.run, f.cwd).every((result) => result.status === 'updated')).toBe(true);
    expect(f.calls).toContainEqual(['claude', ['plugin', 'install', 'kddkit@kddkit', '--scope', 'user']]);
    expect(f.calls).toContainEqual(['claude', ['plugin', 'install', 'kddkit@kddkit', '--scope', 'project']]);
  } finally { f.restore(); }
  const failed = fixture({ ref: 'master', extraOwnedScope: true, failAdd: true });
  try {
    expect(updateClaude('0.9.0-next.1', 'next', failed.run, failed.cwd)[0].detail).toContain('restored');
    expect(failed.calls).toContainEqual(['claude', ['plugin', 'install', 'kddkit@kddkit', '--scope', 'user']]);
    expect(failed.calls).toContainEqual(['claude', ['plugin', 'install', 'kddkit@kddkit', '--scope', 'project']]);
  } finally { failed.restore(); }
});

it('updates an owned scope on the same ref while leaving another project installed', () => {
  const f = fixture({ ref: 'next', version: '0.9.0-next.0', extraScope: true });
  try {
    const result = updateClaude('0.9.0-next.1', 'next', f.run, f.cwd);
    expect(result.some((item) => item.status === 'updated')).toBe(true);
    expect(f.calls).toContainEqual(['claude', ['plugin', 'update', 'kddkit@kddkit', '--scope', 'user']]);
    expect(f.calls.some(([, args]) => args.includes('remove'))).toBe(false);
  } finally { f.restore(); }
});

it('restores the original ref and plugin after a target add failure', () => {
  const f = fixture({ ref: 'master', failAdd: true, enabled: false });
  try {
    const result = updateClaude('0.9.0-next.1', 'next', f.run, process.cwd())[0];
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('restored');
    expect(JSON.parse(readFileSync(f.settings, 'utf8')).extraKnownMarketplaces.kddkit.source.ref).toBe('master');
    expect(f.calls).toContainEqual(['claude', ['plugin', 'disable', 'kddkit@kddkit', '--scope', 'user']]);
  } finally { f.restore(); }
});

it('rolls back an approval failure and skips ambiguous or local marketplace sources', () => {
  const f = fixture({ ref: 'master', failInstall: true });
  try {
    expect(updateClaude('0.9.0-next.1', 'next', f.run, process.cwd())[0]).toMatchObject({ status: 'failed',
      detail: expect.stringContaining('approval') });
    expect(JSON.parse(readFileSync(f.settings, 'utf8')).extraKnownMarketplaces.kddkit.source.ref).toBe('master');
  } finally { f.restore(); }
  for (const options of [{ extraScope: true }, { extraDeclaration: true }, { source: 'directory' as const }]) {
    const x = fixture(options);
    try {
      expect(updateClaude('0.9.0-next.1', 'next', x.run, x.cwd)[0].status).toBe('skipped');
      expect(x.calls.some(([, args]) => args.includes('remove'))).toBe(false);
    } finally { x.restore(); }
  }
});

it('returns from a newer preview to stable and reports unrecoverable rollback with source', () => {
  const stable = fixture({ ref: 'next', version: '0.9.0-next.1' });
  try {
    expect(updateClaude('0.8.0', 'stable', stable.run, process.cwd())[0].status).toBe('updated');
    expect(stable.calls).toContainEqual(['claude', ['plugin', 'marketplace', 'add', 'mag1yar/kddkit@master', '--scope', 'user']]);
  } finally { stable.restore(); }
  const broken = fixture({ ref: 'master', failAdd: true, failRestore: true });
  try {
    const result = updateClaude('0.9.0-next.1', 'next', broken.run, process.cwd())[0];
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('CRITICAL');
    expect(result.detail).toContain('mag1yar/kddkit@master');
  } finally { broken.restore(); }
});

it('updates an already pinned marketplace without removal, and skips absent plugin', () => {
  const current = fixture({ ref: 'master', version: '0.8.0' });
  try {
    expect(updateClaude('0.8.0', 'stable', current.run, process.cwd())[0].status).toBe('current');
    expect(current.calls.some(([, args]) => args.includes('remove'))).toBe(false);
  } finally { current.restore(); }
  const ahead = fixture({ ref: 'master', version: '1.0.0' });
  try {
    expect(updateClaude('0.8.0', 'stable', ahead.run, process.cwd())[0].status).toBe('current');
    expect(ahead.calls.some(([, args]) => args.includes('remove'))).toBe(false);
  } finally { ahead.restore(); }
});

it('refreshes the current ref and corrects an equal-version wrong ref', () => {
  const same = fixture({ ref: 'next', version: '0.9.0-next.0' });
  try {
    expect(updateClaude('0.9.0-next.1', 'next', same.run, same.cwd)[0].status).toBe('updated');
    expect(same.calls).toContainEqual(['claude', ['plugin', 'marketplace', 'update', 'kddkit']]);
    expect(same.calls.some(([, args]) => args.includes('remove'))).toBe(false);
  } finally { same.restore(); }
  const wrong = fixture({ ref: 'next', version: '0.8.0' });
  try {
    expect(updateClaude('0.8.0', 'stable', wrong.run, wrong.cwd)[0].status).toBe('updated');
    expect(wrong.calls).toContainEqual(['claude', ['plugin', 'marketplace', 'add', 'mag1yar/kddkit@master', '--scope', 'user']]);
  } finally { wrong.restore(); }
});

it('rejects a target marketplace that resolves to another repository and restores the original', () => {
  const f = fixture({ ref: 'master', wrongTargetSource: true });
  try {
    const result = updateClaude('0.9.0-next.1', 'next', f.run, f.cwd)[0];
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('restored');
    expect(JSON.parse(readFileSync(f.settings, 'utf8')).extraKnownMarketplaces.kddkit.source.ref).toBe('master');
  } finally { f.restore(); }
});
