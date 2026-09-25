import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { kddVersion } from '@kddkit/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { preflightTarget, updateCli, updateCodex, type Runner } from '../src/update.js';
import { BIN } from './run.js';

let dir: string;
let nodePath: string;
let npmCli: string;
let npmRoot: string;
let runningBundle: string;
let previousNpmCommand: string | undefined;
let previousKddHome: string | undefined;

beforeEach(() => {
  previousNpmCommand = process.env.npm_command;
  previousKddHome = process.env.KDD_HOME;
  delete process.env.npm_command;
  dir = mkdtempSync(join(tmpdir(), 'kdd-update-'));
  process.env.KDD_HOME = join(dir, 'home');
  nodePath = join(dir, 'prefix/bin/node');
  npmCli = join(dir, 'prefix/lib/node_modules/npm/bin/npm-cli.js');
  npmRoot = join(dir, 'prefix/lib/node_modules');
  runningBundle = join(npmRoot, '@kddkit/cli/dist/index.js');
  for (const path of [nodePath, npmCli, runningBundle]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'fixture');
  }
});

afterEach(() => {
  if (previousNpmCommand === undefined) delete process.env.npm_command;
  else process.env.npm_command = previousNpmCommand;
  if (previousKddHome === undefined) delete process.env.KDD_HOME;
  else process.env.KDD_HOME = previousKddHome;
  rmSync(dir, { recursive: true, force: true });
});

function fixture(options: { resolved?: string | null; pathVersion?: string; lsStatus?: number;
  currentVersion?: string; installStatus?: number } = {}) {
  const calls: [string, string[]][] = [];
  const currentVersion = options.currentVersion ?? '0.8.0';
  const resolved = options.resolved === undefined
    ? `https://registry.npmjs.org/@kddkit/cli/-/cli-${currentVersion}.tgz` : options.resolved;
  const run: Runner = (file, args) => {
    calls.push([file, args]);
    if (args.slice(1).join(' ') === 'root -g') return { status: 0, stdout: `${npmRoot}\n`, stderr: '' };
    if (args.slice(1).join(' ') === 'ls -g @kddkit/cli --json --long') return {
      status: options.lsStatus ?? 0,
      stdout: JSON.stringify({ dependencies: { '@kddkit/cli': {
        version: currentVersion, ...(resolved === null ? {} : { resolved }), path: join(npmRoot, '@kddkit/cli'),
      } } }),
      stderr: '',
    };
    if (args.slice(1).join(' ').startsWith('install -g @kddkit/cli@'))
      return { status: options.installStatus ?? 0, stdout: 'installed', stderr: options.installStatus ? 'install failed' : '' };
    if (file === 'kdd' && args.join(' ') === '--version')
      return { status: 0, stdout: `${options.pathVersion ?? '0.9.0'}\n`, stderr: '' };
    throw new Error(`unexpected ${file} ${args.join(' ')}`);
  };
  return { run, calls };
}

describe('npm-owned CLI update', () => {
  it('allows preview to stable but rejects an older target in either channel', () => {
    const preview = fixture({ currentVersion: '1.0.0-next.10', pathVersion: '0.9.0' });
    expect(updateCli('0.9.0', 'stable', preview.run, runningBundle, nodePath).status).toBe('updated');
    expect(preview.calls).toContainEqual([nodePath, [npmCli, 'install', '-g', '@kddkit/cli@0.9.0']]);
    const behind = fixture({ currentVersion: '1.0.0-next.10' });
    expect(updateCli('1.0.0-next.9', 'next', behind.run, runningBundle, nodePath).status).toBe('current');
    const stable = fixture({ currentVersion: '1.0.0' });
    expect(updateCli('1.0.0-next.9', 'next', stable.run, runningBundle, nodePath).status).toBe('current');
    expect(stable.calls.some(([, args]) => args.includes('install'))).toBe(false);
  });

  it('uses a verified receipt as continuing consent, but never for a known local source', () => {
    const receipt = join(process.env.KDD_HOME!, 'update-cli-receipt.json');
    const first = fixture({ resolved: null });
    expect(updateCli('0.9.0', 'stable', first.run, runningBundle, nodePath).status).toBe('skipped');
    expect(existsSync(receipt)).toBe(false);
    expect(updateCli('0.9.0', 'stable', first.run, runningBundle, nodePath, true).status).toBe('updated');
    expect(JSON.parse(readFileSync(receipt, 'utf8'))).toMatchObject({
      cliPath: realpathSync(runningBundle), npmRoot, version: '0.9.0', channel: 'stable',
    });
    const next = fixture({ resolved: null, currentVersion: '0.9.0', pathVersion: '1.0.0-next.1' });
    expect(updateCli('1.0.0-next.1', 'next', next.run, runningBundle, nodePath).status).toBe('updated');
    expect(next.calls.some(([, args]) => args.includes('install'))).toBe(true);
    const local = fixture({ resolved: 'file:local.tgz', currentVersion: '1.0.0-next.1' });
    expect(updateCli('1.0.0-next.2', 'next', local.run, runningBundle, nodePath).status).toBe('skipped');
  });

  it('rejects a stale or invalid receipt and writes none after failed verification', () => {
    const receipt = join(process.env.KDD_HOME!, 'update-cli-receipt.json');
    mkdirSync(dirname(receipt), { recursive: true });
    writeFileSync(receipt, '{bad');
    const unknown = fixture({ resolved: null });
    expect(updateCli('0.9.0', 'stable', unknown.run, runningBundle, nodePath).status).toBe('skipped');
    writeFileSync(receipt, JSON.stringify({ cliPath: runningBundle, npmRoot: '/other', version: '0.8.0', channel: 'stable' }));
    expect(updateCli('0.9.0', 'stable', unknown.run, runningBundle, nodePath).status).toBe('skipped');
    const failed = fixture({ resolved: null, pathVersion: '0.8.0' });
    expect(updateCli('0.9.0', 'stable', failed.run, runningBundle, nodePath, true).status).toBe('failed');
    expect(JSON.parse(readFileSync(receipt, 'utf8')).npmRoot).toBe('/other');
  });

  it('checks the selected npm dist-tag before installation', () => {
    const run: Runner = (_file, args) => ({ status: 0, stderr: '', stdout: args.includes('dist-tags')
      ? JSON.stringify({ latest: '0.9.0', next: '1.0.0-next.2' }) : '' });
    expect(preflightTarget('1.0.0-next.2', 'next', run)).toBeNull();
    expect(preflightTarget('1.0.0-next.3', 'next', run)).toContain('next');
    expect(preflightTarget('0.9.0', 'stable', run)).toBeNull();
    expect(preflightTarget('0.9.0', 'stable', () => ({ status: 0, stdout: '{', stderr: '' }))).toContain('dist-tags');
  });
  it('uses the same Node/npm and verifies the invoked kdd version', () => {
    const { run, calls } = fixture();
    expect(updateCli('0.9.0', 'stable', run, runningBundle, nodePath)).toMatchObject({
      name: 'cli', status: 'updated',
    });
    expect(calls).toContainEqual([nodePath, [npmCli, 'install', '-g', '@kddkit/cli@0.9.0']]);
    expect(calls).toContainEqual(['kdd', ['--version']]);
  });

  it('skips a package when npm ls omits its source', () => {
    const { run, calls } = fixture({ resolved: null });
    expect(updateCli('0.9.0', 'stable', run, runningBundle, nodePath)).toMatchObject({
      status: 'skipped', detail: expect.stringContaining('source'),
    });
    expect(calls.some(([, args]) => args.includes('install'))).toBe(false);
  });

  it('replaces an unknown-source CLI only when explicitly requested', () => {
    const { run, calls } = fixture({ resolved: null });
    expect(updateCli('0.9.0', 'stable', run, runningBundle, nodePath, true)).toMatchObject({
      status: 'updated', detail: expect.stringContaining('explicit'),
    });
    expect(calls).toContainEqual([nodePath, [npmCli, 'install', '-g', '@kddkit/cli@0.9.0']]);
    expect(calls).toContainEqual(['kdd', ['--version']]);
  });

  it('skips a local tarball by default and requires explicit replacement', () => {
    const source = join(dir, 'tarball-source');
    const prefix = join(dir, 'tarball-prefix');
    const env = { ...process.env, npm_config_prefix: prefix, npm_config_cache: join(dir, 'npm-cache') };
    mkdirSync(join(source, 'dist'), { recursive: true });
    writeFileSync(join(source, 'package.json'), JSON.stringify({
      name: '@kddkit/cli', version: '0.8.0', bin: { kdd: 'dist/index.js' },
    }));
    writeFileSync(join(source, 'dist/index.js'), '#!/usr/bin/env node\n');
    const tarball = execFileSync('npm', ['pack', '--silent', '--pack-destination', dir], {
      cwd: source, env, encoding: 'utf8',
    }).trim();
    execFileSync('npm', ['install', '-g', '--offline', '--ignore-scripts', join(dir, tarball)], {
      env, stdio: 'pipe',
    });

    const listed = JSON.parse(execFileSync('npm', ['ls', '-g', '@kddkit/cli', '--json', '--long'], {
      env, encoding: 'utf8',
    })) as { dependencies: Record<string, { resolved?: string }> };
    expect(listed.dependencies['@kddkit/cli'].resolved).toBeUndefined();

    const calls: string[][] = [];
    const run: Runner = (file, args, cwd) => {
      calls.push(args);
      if (args.includes('install')) return { status: 99, stdout: '', stderr: 'unexpected install' };
      const result = spawnSync(file, args, { cwd, env, encoding: 'utf8' });
      return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '',
        ...(result.error ? { error: result.error } : {}) };
    };
    const installedBundle = join(prefix, 'lib/node_modules/@kddkit/cli/dist/index.js');
    expect(updateCli('0.8.0', 'stable', run, installedBundle, process.execPath)).toMatchObject({
      status: 'current', detail: expect.stringContaining('0.8.0'),
    });
    expect(updateCli('0.8.0', 'stable', run, installedBundle, process.execPath, true).status).toBe('current');
    expect(calls.some((args) => args.includes('install'))).toBe(false);
    expect(updateCli('0.9.0', 'stable', run, installedBundle, process.execPath).status).toBe('skipped');
    expect(calls.some((args) => args.includes('install'))).toBe(false);
    const receipt = join(process.env.KDD_HOME!, 'update-cli-receipt.json');
    mkdirSync(dirname(receipt), { recursive: true });
    writeFileSync(receipt, JSON.stringify({
      cliPath: realpathSync(installedBundle), npmRoot: join(prefix, 'lib/node_modules'),
      version: '0.8.0', channel: 'stable',
    }));
    expect(updateCli('0.9.0', 'stable', run, installedBundle, process.execPath).status).toBe('failed');
    expect(calls.some((args) => args.includes('install'))).toBe(true);
    expect(updateCli('0.9.0', 'stable', run, installedBundle, process.execPath, true).status).toBe('failed');
    expect(calls.some((args) => args.includes('install'))).toBe(true);
  }, 20_000);

  it('fails when npm succeeds but PATH still invokes the old kdd', () => {
    const { run } = fixture({ pathVersion: '0.8.0' });
    expect(updateCli('0.9.0', 'stable', run, runningBundle, nodePath)).toMatchObject({
      name: 'cli', status: 'failed', detail: expect.stringContaining('kdd --version'),
    });
  });

  it('skips a file-linked global package', () => {
    const { run, calls } = fixture({ resolved: 'file:../../source' });
    expect(updateCli('0.9.0', 'stable', run, runningBundle, nodePath, true).status).toBe('skipped');
    expect(calls.some(([, args]) => args.includes('install'))).toBe(false);
  });

  it('skips a direct HTTPS tarball outside the package registry', () => {
    const { run, calls } = fixture({ resolved: 'https://example.com/kddkit-cli-0.8.0.tgz' });
    expect(updateCli('0.9.0', 'stable', run, runningBundle, nodePath, true).status).toBe('skipped');
    expect(calls.some(([, args]) => args.includes('install'))).toBe(false);
  });

  it('skips a symlinked global package', () => {
    const packageDir = join(npmRoot, '@kddkit/cli');
    const source = join(dir, 'source');
    mkdirSync(join(source, 'dist'), { recursive: true });
    writeFileSync(join(source, 'dist/index.js'), 'fixture');
    rmSync(packageDir, { recursive: true });
    symlinkSync(source, packageDir, 'dir');
    const { run } = fixture();
    expect(updateCli('0.9.0', 'stable', run, runningBundle, nodePath, true).status).toBe('skipped');
  });

  it('skips a global package whose dist directory is symlinked', () => {
    const dist = join(npmRoot, '@kddkit/cli/dist');
    const source = join(dir, 'source-dist');
    mkdirSync(source);
    writeFileSync(join(source, 'index.js'), 'fixture');
    rmSync(dist, { recursive: true });
    symlinkSync(source, dist, 'dir');
    const { run, calls } = fixture({ resolved: null });
    expect(updateCli('0.9.0', 'stable', run, runningBundle, nodePath, true).status).toBe('skipped');
    expect(calls.some(([, args]) => args.includes('install'))).toBe(false);
  });

  it('skips a bundle owned by another npm prefix', () => {
    const other = join(dir, 'other/dist/index.js');
    mkdirSync(dirname(other), { recursive: true });
    writeFileSync(other, 'fixture');
    const { run, calls } = fixture();
    expect(updateCli('0.9.0', 'stable', run, other, nodePath, true).status).toBe('skipped');
    expect(calls.some(([, args]) => args.includes('install'))).toBe(false);
  });

  it('skips a source checkout even when that npm has no global kddkit package', () => {
    const source = join(dir, 'source/dist/index.js');
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, 'fixture');
    const { run, calls } = fixture({ lsStatus: 1 });
    expect(updateCli('0.9.0', 'stable', run, source, nodePath, true).status).toBe('skipped');
    expect(calls.some(([, args]) => args.includes('ls'))).toBe(false);
  });

  it('skips when this Node has no npm CLI', () => {
    rmSync(npmCli);
    const { run, calls } = fixture();
    expect(updateCli('0.9.0', 'stable', run, runningBundle, nodePath).status).toBe('skipped');
    expect(calls).toEqual([]);
  });

  it('never upgrades a global CLI during npm exec', () => {
    const previous = process.env.npm_command;
    process.env.npm_command = 'exec';
    try {
      const { run, calls } = fixture();
      expect(updateCli('0.9.0', 'stable', run, runningBundle, nodePath, true).status).toBe('skipped');
      expect(calls).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.npm_command;
      else process.env.npm_command = previous;
    }
  });

  it('finds npm through a sibling shim when Homebrew keeps its script in another prefix', () => {
    rmSync(npmCli);
    const sharedNpm = join(dir, 'shared/lib/node_modules/npm/bin/npm-cli.js');
    mkdirSync(dirname(sharedNpm), { recursive: true });
    writeFileSync(sharedNpm, 'fixture');
    symlinkSync(sharedNpm, join(dirname(nodePath), 'npm'));
    const { run, calls } = fixture();
    expect(updateCli('0.9.0', 'stable', run, runningBundle, nodePath).status).toBe('updated');
    expect(calls).toContainEqual([nodePath, [realpathSync(sharedNpm), 'install', '-g', '@kddkit/cli@0.9.0']]);
  });

  it('treats a failed inspection as an error, not an absent installation', () => {
    const { run, calls } = fixture({ lsStatus: 1 });
    expect(updateCli('0.9.0', 'stable', run, runningBundle, nodePath).status).toBe('failed');
    expect(calls.some(([, args]) => args.includes('install'))).toBe(false);
  });
});

describe('built kdd command', () => {
  function environment(releaseVersion = '0.9.0') {
    const preloader = join(dir, 'release.mjs');
    writeFileSync(preloader, `globalThis.fetch = async () => new Response(process.env.KDD_TEST_RELEASES || JSON.stringify([{
      tag_name: 'v${releaseVersion}', html_url: 'https://github.com/mag1yar/kddkit/releases/tag/v${releaseVersion}',
      body: '', published_at: '2026-09-23T00:00:00Z', draft: false, prerelease: false,
    }]), { status: 200 });\n`);
    return {
      ...process.env,
      KDD_HOME: join(dir, 'home'), KDD_DB: join(dir, 'kdd.db'),
      KDD_DECISIONS_DIR: join(dir, 'decisions'),
      PATH: process.env.PATH,
      NO_UPDATE_NOTIFIER: '', CI: '', CLAUDECODE: '', CODEX_SESSION_ID: '',
      CODEX_THREAD_ID: '', KDD_ACTOR: 'user', npm_command: '',
      NODE_OPTIONS: `--import=${preloader}`,
    } as NodeJS.ProcessEnv & { KDD_HOME: string; KDD_DB: string };
  }

  it('adds update help and shows a cached notice only on a later human invocation', async () => {
    const newer = `${Number(kddVersion().split('.')[0]) + 1}.0.0`;
    const env = environment(newer);
    const help = spawnSync(process.execPath, [BIN, '--help'], { env, encoding: 'utf8' });
    expect(help.stdout).toMatch(/\bupdate\b/);
    expect(help.stderr).not.toContain('available; run kdd update');
    const updateHelp = spawnSync(process.execPath, [BIN, 'update', '--help'], { env, encoding: 'utf8' });
    expect(updateHelp.stdout).toContain('--replace-cli-from-registry');
    expect(updateHelp.stdout).toContain('--next');
    expect(updateHelp.stdout).toContain('update-cli-receipt.json');

    const json = spawnSync(process.execPath, [BIN, 'status', '--json'], { env, encoding: 'utf8' });
    expect(json.status).toBe(0);
    expect(() => JSON.parse(json.stdout)).not.toThrow();
    expect(json.stderr).not.toContain('available; run kdd update');

    const started = Date.now();
    const first = spawnSync(process.execPath, [BIN, 'status'], { env, encoding: 'utf8' });
    expect(first.status).toBe(0);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(first.stderr).not.toContain('available; run kdd update');
    const cacheFile = join(env.KDD_HOME, 'update-check.json');
    for (let i = 0; i < 80 && !existsSync(cacheFile); i++)
      await new Promise((resolve) => setTimeout(resolve, 25));
    expect(JSON.parse(readFileSync(cacheFile, 'utf8')).latest).toBe(newer);

    const human = spawnSync(process.execPath, [BIN, 'status'], { env, encoding: 'utf8' });
    expect(human.stderr.match(/available; run kdd update/g)).toHaveLength(1);
    expect(human.stderr).toContain(`kdd: v${newer} available; run kdd update`);
  });

  it('runs outside Git, reports a failed component, and continues to the others', () => {
    const env = environment();
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const claude = join(bin, 'claude');
    const codex = join(bin, 'codex');
    writeFileSync(join(bin, 'npm'), '#!/bin/sh\nprintf "%s" "$KDD_TEST_TAGS"\n');
    writeFileSync(claude, '#!/bin/sh\necho "simulated Claude failure" >&2\nexit 1\n');
    writeFileSync(codex, `#!/bin/sh
printf '%s\\n' '{"installed":[],"available":[]}'
`);
    chmodSync(claude, 0o755);
    chmodSync(codex, 0o755);
    chmodSync(join(bin, 'npm'), 0o755);
    env.PATH = `${bin}:${env.PATH}`;
    env.KDD_TEST_TAGS = JSON.stringify({ latest: '0.9.0' });
    env.NO_UPDATE_NOTIFIER = '1';
    const result = spawnSync(process.execPath, [BIN, 'update'], {
      cwd: dir, env, encoding: 'utf8', timeout: 10_000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('claude: failed');
    expect(result.stdout).toContain('codex: skipped');
    expect(result.stdout).toContain('simulated Claude failure');
    expect(existsSync(env.KDD_DB)).toBe(false);
  });

  it('selects next only explicitly and stops before managers when npm tag disagrees', () => {
    const env = environment();
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const calls = join(dir, 'manager-calls');
    writeFileSync(join(bin, 'npm'), '#!/bin/sh\nprintf "%s" "$KDD_TEST_TAGS"\n');
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\necho claude >> "$KDD_TEST_CALLS"\nexit 1\n');
    writeFileSync(join(bin, 'codex'), '#!/bin/sh\necho codex >> "$KDD_TEST_CALLS"\nexit 1\n');
    for (const name of ['npm', 'claude', 'codex']) chmodSync(join(bin, name), 0o755);
    env.PATH = `${bin}:${env.PATH}`;
    env.KDD_TEST_CALLS = calls;
    env.NO_UPDATE_NOTIFIER = '1';
    env.KDD_TEST_RELEASES = JSON.stringify([
      { tag_name: 'v1.0.0-next.2', prerelease: true, draft: false },
      { tag_name: 'v0.9.0', prerelease: false, draft: false },
    ]);
    env.KDD_TEST_TAGS = JSON.stringify({ latest: '0.9.0', next: '1.0.0-next.2' });
    const next = spawnSync(process.execPath, [BIN, 'update', '--next'], { cwd: dir, env, encoding: 'utf8' });
    expect(next.status).toBe(1); // fake clients fail, but both were attempted
    expect(next.stdout).toContain('next 1.0.0-next.2');
    expect(existsSync(calls)).toBe(true);
    expect(readFileSync(calls, 'utf8')).toContain('claude');
    expect(readFileSync(calls, 'utf8')).toContain('codex');
    rmSync(calls);
    const stable = spawnSync(process.execPath, [BIN, 'update'], { cwd: dir, env, encoding: 'utf8' });
    expect(stable.stdout).toContain('stable 0.9.0');
    rmSync(calls);
    env.KDD_TEST_TAGS = JSON.stringify({ latest: '0.9.0', next: '1.0.0-next.1' });
    const mismatch = spawnSync(process.execPath, [BIN, 'update', '--next'], { cwd: dir, env, encoding: 'utf8' });
    expect(mismatch.status).toBe(1);
    expect(mismatch.stderr).toContain('disagrees');
    expect(existsSync(calls)).toBe(false);
  });

  it('rejects an old preview after stable promotion before invoking managers', () => {
    const env = environment();
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const calls = join(dir, 'manager-calls');
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\necho called >> "$KDD_TEST_CALLS"\n');
    chmodSync(join(bin, 'claude'), 0o755);
    env.PATH = `${bin}:${env.PATH}`;
    env.KDD_TEST_CALLS = calls;
    env.NO_UPDATE_NOTIFIER = '1';
    env.KDD_TEST_RELEASES = JSON.stringify([
      { tag_name: 'v1.0.0', prerelease: false, draft: false },
      { tag_name: 'v1.0.0-next.9', prerelease: true, draft: false },
    ]);
    const result = spawnSync(process.execPath, [BIN, 'update', '--next'], { cwd: dir, env, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no newer preview');
    expect(existsSync(calls)).toBe(false);
  });
});
