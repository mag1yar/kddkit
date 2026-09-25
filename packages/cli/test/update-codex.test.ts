import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readCodexSource, updateCodex } from '../src/update-codex.js';
import type { Runner } from '../src/update.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('reads a quoted TOML key, escaped URL, ref and sparse paths; rejects malformed data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kdd-codex-config-'));
  dirs.push(dir);
  const file = join(dir, 'config.toml');
  writeFileSync(file, `[marketplaces."kddkit"]\nsource_type = "git"\nsource = "https://github.com/mag1yar/kddkit.git"\nref_name = "next"\nsparse_paths = [".agents/plugins", "integrations/codex-plugin"]\n`);
  expect(readCodexSource(file)).toEqual({ source: 'https://github.com/mag1yar/kddkit.git',
    ref: 'next', sparsePaths: ['.agents/plugins', 'integrations/codex-plugin'] });
  writeFileSync(file, `[marketplaces.kddkit]\nsource_type = "git"\nsource = "https://github.com/mag1yar/kddkit.git"\nref = "next"\n`);
  expect(readCodexSource(file)).toEqual({ source: 'https://github.com/mag1yar/kddkit.git',
    ref: 'next', sparsePaths: [] });
  writeFileSync(file, `[marketplaces.kddkit]\nsource_type = "git"\nsource = "https://github.com/mag1yar/kddkit\\u002egit"\nref = "next"\n`);
  expect(readCodexSource(file)?.source).toBe('https://github.com/mag1yar/kddkit.git');
  writeFileSync(file, '[marketplaces.kddkit]\nsource_type = "git"\nsource = "https://github.com/mag1yar/kddkit.git"\n');
  expect(readCodexSource(file)).toEqual({ source: 'https://github.com/mag1yar/kddkit.git', sparsePaths: [] });
  writeFileSync(file, '[marketplaces.kddkit\n');
  expect(readCodexSource(file)).toBeNull();
});

function fixture(options: { ref?: string; version?: string; autoInstall?: boolean; failAdd?: boolean;
  failPluginAdd?: boolean; failRestore?: boolean; source?: string; configSource?: string;
  enabled?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kdd-codex-update-'));
  dirs.push(dir);
  const before = process.env.CODEX_HOME;
  process.env.CODEX_HOME = dir;
  const config = join(dir, 'config.toml');
  const source = options.source ?? 'https://github.com/mag1yar/kddkit.git';
  let ref = options.ref ?? 'master';
  let version = options.version ?? '0.8.0';
  let installed = true;
  let present = true;
  let failAdd = options.failAdd ?? false;
  let failPluginAdd = options.failPluginAdd ?? false;
  const sparse = ['.agents/plugins', 'integrations/codex-plugin'];
  const sync = () => writeFileSync(config, present ? `[marketplaces.kddkit]\nsource_type = "git"\nsource = "${options.configSource ?? source}"\nref = "${ref}"\nsparse_paths = [".agents/plugins", "integrations/codex-plugin"]\n` : '');
  sync();
  const calls: [string, string[]][] = [];
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const fail = (stderr: string) => ({ status: 1, stdout: '', stderr });
  const run: Runner = (file, args) => {
    calls.push([file, args]);
    if (file === 'git' && args[0] === 'clone') {
      const dest = args.at(-1)!;
      mkdirSync(join(dest, '.agents/plugins'), { recursive: true });
      mkdirSync(join(dest, 'integrations/codex-plugin/.codex-plugin'), { recursive: true });
      writeFileSync(join(dest, '.agents/plugins/marketplace.json'), JSON.stringify({ name: 'kddkit', plugins: [{ name: 'kddkit' }] }));
      writeFileSync(join(dest, 'integrations/codex-plugin/.codex-plugin/plugin.json'), JSON.stringify({ name: 'kddkit',
        version: args[4] === 'next' ? '0.9.0-next.1' : '0.8.0' }));
      return ok();
    }
    if (file !== 'codex') throw new Error(file);
    if (args.join(' ') === 'plugin list --json') return ok(JSON.stringify({ installed: installed ? [{
      pluginId: 'kddkit@kddkit', name: 'kddkit', marketplaceName: 'kddkit', version,
      installed: true, enabled: options.enabled ?? true, source: { source: 'local', path: '/snapshot' },
      marketplaceSource: { sourceType: 'git', source }, installPolicy: 'AVAILABLE', authPolicy: 'ON_INSTALL',
    }] : [], available: [] }));
    if (args.join(' ') === 'plugin marketplace list --json') return ok(JSON.stringify({ marketplaces: present
      ? [{ name: 'kddkit', root: '/snapshot', marketplaceSource: { sourceType: 'git', source } }] : [] }));
    if (args.join(' ') === 'plugin marketplace remove kddkit') { present = false; installed = false; sync(); return ok(); }
    if (args.join(' ') === 'plugin marketplace upgrade kddkit') {
      version = ref === 'next' ? '0.9.0-next.1' : '0.8.0'; return ok();
    }
    if (args[1] === 'marketplace' && args[2] === 'add') {
      if (failAdd && args.includes('next')) { failAdd = false; return fail('target add failed'); }
      if (options.failRestore && args.includes('master')) return fail('restore failed');
      ref = args[args.indexOf('--ref') + 1]; present = true;
      if (options.autoInstall) { installed = true; version = ref === 'next' ? '0.9.0-next.1' : '0.8.0'; }
      sync(); return ok();
    }
    if (args.join(' ') === 'plugin add kddkit@kddkit') {
      if (failPluginAdd && ref === 'next') { failPluginAdd = false; return fail('plugin add failed'); }
      installed = true; version = ref === 'next' ? '0.9.0-next.1' : '0.8.0'; return ok();
    }
    throw new Error(args.join(' '));
  };
  const restore = () => { if (before === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = before; };
  return { run, calls, config, sparse, restore };
}

it('switches Git ref with exact source and sparse paths, then verifies installed plugin', () => {
  const f = fixture();
  try {
    expect(updateCodex('0.9.0-next.1', 'next', f.run).status).toBe('updated');
    expect(f.calls).toContainEqual(['codex', ['plugin', 'marketplace', 'add',
      'https://github.com/mag1yar/kddkit.git', '--ref', 'next', '--sparse', '.agents/plugins',
      '--sparse', 'integrations/codex-plugin']]);
    expect(f.calls).toContainEqual(['codex', ['plugin', 'add', 'kddkit@kddkit']]);
  } finally { f.restore(); }
});

it('rolls back target add and plugin add failures with the original ref and plugin', () => {
  for (const options of [{ failAdd: true }, { failPluginAdd: true }]) {
    const f = fixture(options);
    try {
      const result = updateCodex('0.9.0-next.1', 'next', f.run);
      expect(result.status).toBe('failed');
      expect(result.detail).toContain('restored');
      expect(readFileSync(f.config, 'utf8')).toContain('ref = "master"');
      expect(f.calls).toContainEqual(['codex', ['plugin', 'marketplace', 'add',
        'https://github.com/mag1yar/kddkit.git', '--ref', 'master', '--sparse', '.agents/plugins',
        '--sparse', 'integrations/codex-plugin']]);
    } finally { f.restore(); }
  }
});

it('skips config/CLI mismatch before removal and reports critical rollback failure', () => {
  const mismatch = fixture({ configSource: 'https://github.com/other/repo.git' });
  try {
    expect(updateCodex('0.9.0-next.1', 'next', mismatch.run).status).toBe('skipped');
    expect(mismatch.calls.some(([, args]) => args.includes('remove'))).toBe(false);
  } finally { mismatch.restore(); }
  const broken = fixture({ failAdd: true, failRestore: true });
  try {
    const result = updateCodex('0.9.0-next.1', 'next', broken.run);
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('CRITICAL');
    expect(result.detail).toContain('https://github.com/mag1yar/kddkit.git');
  } finally { broken.restore(); }
});

it('returns preview to stable but rejects a stale preview and corrects equal-version ref', () => {
  const stable = fixture({ ref: 'next', version: '0.9.0-next.1' });
  try { expect(updateCodex('0.8.0', 'stable', stable.run).status).toBe('updated'); }
  finally { stable.restore(); }
  const ahead = fixture({ ref: 'master', version: '1.0.0' });
  try {
    expect(updateCodex('0.9.0-next.1', 'next', ahead.run).status).toBe('current');
    expect(ahead.calls.some(([, args]) => args.includes('remove'))).toBe(false);
  } finally { ahead.restore(); }
  const equal = fixture({ ref: 'next', version: '0.8.0' });
  try { expect(updateCodex('0.8.0', 'stable', equal.run).status).toBe('updated'); }
  finally { equal.restore(); }
});

it('skips missing config and a known local marketplace before removal', () => {
  const missing = fixture();
  try {
    rmSync(missing.config);
    expect(updateCodex('0.9.0-next.1', 'next', missing.run).status).toBe('skipped');
    expect(missing.calls.some(([, args]) => args.includes('remove'))).toBe(false);
  } finally { missing.restore(); }
  const local = fixture();
  try {
    const run: Runner = (file, args, cwd) => {
      const response = local.run(file, args, cwd);
      if (file === 'codex' && args.join(' ') === 'plugin list --json') {
        const data = JSON.parse(response.stdout);
        data.installed[0].marketplaceSource.sourceType = 'local';
        return { ...response, stdout: JSON.stringify(data) };
      }
      return response;
    };
    expect(updateCodex('0.9.0-next.1', 'next', run).status).toBe('skipped');
    expect(local.calls.some(([, args]) => args.includes('remove'))).toBe(false);
  } finally { local.restore(); }
});

it('updates a pinned ref and reports failure if rollback cannot restore the old version', () => {
  const same = fixture({ ref: 'next', version: '0.9.0-next.0' });
  try {
    expect(updateCodex('0.9.0-next.1', 'next', same.run).status).toBe('updated');
    expect(same.calls).toContainEqual(['codex', ['plugin', 'marketplace', 'upgrade', 'kddkit']]);
    expect(same.calls.some(([, args]) => args.includes('remove'))).toBe(false);
  } finally { same.restore(); }
  const stale = fixture({ version: '0.7.0', failAdd: true });
  try {
    const result = updateCodex('0.9.0-next.1', 'next', stale.run);
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('CRITICAL');
    expect(result.detail).toContain('0.7.0');
  } finally { stale.restore(); }
});

it('skips disabled Codex plugins because its manager would re-enable them', () => {
  const f = fixture({ enabled: false });
  try {
    expect(updateCodex('0.9.0-next.1', 'next', f.run).status).toBe('skipped');
    expect(f.calls.some(([, args]) => args.includes('remove'))).toBe(false);
  } finally { f.restore(); }
});

it('rejects a target plugin whose marketplace source changed after add', () => {
  const f = fixture({ autoInstall: true });
  try {
    const run: Runner = (file, args, cwd) => {
      const response = f.run(file, args, cwd);
      if (file === 'codex' && args.join(' ') === 'plugin list --json'
        && readFileSync(f.config, 'utf8').includes('ref = "next"')) {
        const data = JSON.parse(response.stdout);
        data.installed[0].marketplaceSource.source = 'https://github.com/other/repo.git';
        return { ...response, stdout: JSON.stringify(data) };
      }
      return response;
    };
    const result = updateCodex('0.9.0-next.1', 'next', run);
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('restored');
  } finally { f.restore(); }
});
