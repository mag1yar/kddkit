import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { updateCli, updateClaude, updateCodex, type Runner } from '../src/update.js';
import { BIN } from './run.js';

let dir: string;
let nodePath: string;
let npmCli: string;
let npmRoot: string;
let runningBundle: string;
let previousNpmCommand: string | undefined;

beforeEach(() => {
  previousNpmCommand = process.env.npm_command;
  delete process.env.npm_command;
  dir = mkdtempSync(join(tmpdir(), 'kdd-update-'));
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
  rmSync(dir, { recursive: true, force: true });
});

function fixture(options: { resolved?: string | null; pathVersion?: string; lsStatus?: number } = {}) {
  const calls: [string, string[]][] = [];
  const resolved = options.resolved === undefined
    ? 'https://registry.npmjs.org/@kddkit/cli/-/cli-0.8.0.tgz' : options.resolved;
  const run: Runner = (file, args) => {
    calls.push([file, args]);
    if (args.slice(1).join(' ') === 'root -g') return { status: 0, stdout: `${npmRoot}\n`, stderr: '' };
    if (args.slice(1).join(' ') === 'ls -g @kddkit/cli --json --long') return {
      status: options.lsStatus ?? 0,
      stdout: JSON.stringify({ dependencies: { '@kddkit/cli': {
        version: '0.8.0', ...(resolved === null ? {} : { resolved }), path: join(npmRoot, '@kddkit/cli'),
      } } }),
      stderr: '',
    };
    if (args.slice(1).join(' ') === 'install -g @kddkit/cli@0.9.0')
      return { status: 0, stdout: 'installed', stderr: '' };
    if (file === 'kdd' && args.join(' ') === '--version')
      return { status: 0, stdout: `${options.pathVersion ?? '0.9.0'}\n`, stderr: '' };
    throw new Error(`unexpected ${file} ${args.join(' ')}`);
  };
  return { run, calls };
}

describe('npm-owned CLI update', () => {
  it('uses the same Node/npm and verifies the invoked kdd version', () => {
    const { run, calls } = fixture();
    expect(updateCli('0.9.0', run, runningBundle, nodePath)).toMatchObject({
      name: 'cli', status: 'updated',
    });
    expect(calls).toContainEqual([nodePath, [npmCli, 'install', '-g', '@kddkit/cli@0.9.0']]);
    expect(calls).toContainEqual(['kdd', ['--version']]);
  });

  it('skips a package when npm ls omits its source', () => {
    const { run, calls } = fixture({ resolved: null });
    expect(updateCli('0.9.0', run, runningBundle, nodePath)).toMatchObject({
      status: 'skipped', detail: expect.stringContaining('source'),
    });
    expect(calls.some(([, args]) => args.includes('install'))).toBe(false);
  });

  it('replaces an unknown-source CLI only when explicitly requested', () => {
    const { run, calls } = fixture({ resolved: null });
    expect(updateCli('0.9.0', run, runningBundle, nodePath, true)).toMatchObject({
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
    expect(updateCli('0.8.0', run, installedBundle, process.execPath)).toMatchObject({
      status: 'current', detail: expect.stringContaining('0.8.0'),
    });
    expect(updateCli('0.8.0', run, installedBundle, process.execPath, true).status).toBe('current');
    expect(calls.some((args) => args.includes('install'))).toBe(false);
    expect(updateCli('0.9.0', run, installedBundle, process.execPath).status).toBe('skipped');
    expect(calls.some((args) => args.includes('install'))).toBe(false);
    expect(updateCli('0.9.0', run, installedBundle, process.execPath, true).status).toBe('failed');
    expect(calls.some((args) => args.includes('install'))).toBe(true);
  });

  it('fails when npm succeeds but PATH still invokes the old kdd', () => {
    const { run } = fixture({ pathVersion: '0.8.0' });
    expect(updateCli('0.9.0', run, runningBundle, nodePath)).toMatchObject({
      name: 'cli', status: 'failed', detail: expect.stringContaining('kdd --version'),
    });
  });

  it('skips a file-linked global package', () => {
    const { run, calls } = fixture({ resolved: 'file:../../source' });
    expect(updateCli('0.9.0', run, runningBundle, nodePath, true).status).toBe('skipped');
    expect(calls.some(([, args]) => args.includes('install'))).toBe(false);
  });

  it('skips a direct HTTPS tarball outside the package registry', () => {
    const { run, calls } = fixture({ resolved: 'https://example.com/kddkit-cli-0.8.0.tgz' });
    expect(updateCli('0.9.0', run, runningBundle, nodePath, true).status).toBe('skipped');
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
    expect(updateCli('0.9.0', run, runningBundle, nodePath, true).status).toBe('skipped');
  });

  it('skips a global package whose dist directory is symlinked', () => {
    const dist = join(npmRoot, '@kddkit/cli/dist');
    const source = join(dir, 'source-dist');
    mkdirSync(source);
    writeFileSync(join(source, 'index.js'), 'fixture');
    rmSync(dist, { recursive: true });
    symlinkSync(source, dist, 'dir');
    const { run, calls } = fixture({ resolved: null });
    expect(updateCli('0.9.0', run, runningBundle, nodePath, true).status).toBe('skipped');
    expect(calls.some(([, args]) => args.includes('install'))).toBe(false);
  });

  it('skips a bundle owned by another npm prefix', () => {
    const other = join(dir, 'other/dist/index.js');
    mkdirSync(dirname(other), { recursive: true });
    writeFileSync(other, 'fixture');
    const { run, calls } = fixture();
    expect(updateCli('0.9.0', run, other, nodePath, true).status).toBe('skipped');
    expect(calls.some(([, args]) => args.includes('install'))).toBe(false);
  });

  it('skips a source checkout even when that npm has no global kddkit package', () => {
    const source = join(dir, 'source/dist/index.js');
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, 'fixture');
    const { run, calls } = fixture({ lsStatus: 1 });
    expect(updateCli('0.9.0', run, source, nodePath, true).status).toBe('skipped');
    expect(calls.some(([, args]) => args.includes('ls'))).toBe(false);
  });

  it('skips when this Node has no npm CLI', () => {
    rmSync(npmCli);
    const { run, calls } = fixture();
    expect(updateCli('0.9.0', run, runningBundle, nodePath).status).toBe('skipped');
    expect(calls).toEqual([]);
  });

  it('never upgrades a global CLI during npm exec', () => {
    const previous = process.env.npm_command;
    process.env.npm_command = 'exec';
    try {
      const { run, calls } = fixture();
      expect(updateCli('0.9.0', run, runningBundle, nodePath, true).status).toBe('skipped');
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
    expect(updateCli('0.9.0', run, runningBundle, nodePath).status).toBe('updated');
    expect(calls).toContainEqual([nodePath, [realpathSync(sharedNpm), 'install', '-g', '@kddkit/cli@0.9.0']]);
  });

  it('treats a failed inspection as an error, not an absent installation', () => {
    const { run, calls } = fixture({ lsStatus: 1 });
    expect(updateCli('0.9.0', run, runningBundle, nodePath).status).toBe('failed');
    expect(calls.some(([, args]) => args.includes('install'))).toBe(false);
  });
});

const project = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: process.cwd(), encoding: 'utf8',
}).trim();

function claudeRow(scope: string, version = '0.8.0', projectPath?: string) {
  return {
    id: 'kddkit@kddkit', version, scope, enabled: true,
    installPath: `/plugins/kddkit/${version}`, installedAt: '2026-01-01T00:00:00Z',
    lastUpdated: '2026-01-01T00:00:00Z', ...(projectPath ? { projectPath } : {}),
  };
}

function codexRow(version = '0.8.0', sourceType = 'git') {
  return {
    pluginId: 'kddkit@kddkit', name: 'kddkit', marketplaceName: 'kddkit',
    version, installed: true, enabled: true,
    source: { source: 'local', path: '/plugin' },
    marketplaceSource: { sourceType, source: '/marketplace' },
    installPolicy: 'AVAILABLE', authPolicy: 'ON_INSTALL',
  };
}

describe('Claude plugin update', () => {
  it('updates only user and current-project scopes, then verifies each version', () => {
    const rows = [
      claudeRow('user'), claudeRow('project', '0.8.0', project),
      claudeRow('project', '0.8.0', '/another/repo'), claudeRow('managed'),
    ];
    const calls: [string, string[]][] = [];
    const run: Runner = (file, args) => {
      calls.push([file, args]);
      if (args.join(' ') === 'plugin list --json')
        return { status: 0, stdout: JSON.stringify(rows), stderr: '' };
      if (args.join(' ') === 'plugin marketplace update kddkit')
        return { status: 0, stdout: '', stderr: '' };
      if (args[1] === 'update') {
        const scope = args[4];
        const row = rows.find((item) => item.scope === scope && (scope !== 'project' || item.projectPath === project));
        if (row) row.version = '0.9.0';
        return { status: 0, stdout: '', stderr: '' };
      }
      throw new Error(args.join(' '));
    };
    const result = updateClaude('0.9.0', run, process.cwd());
    expect(result.map((row) => row.status)).toEqual(['updated', 'updated', 'skipped', 'skipped']);
    expect(calls).toContainEqual(['claude', ['plugin', 'update', 'kddkit@kddkit', '--scope', 'user']]);
    expect(calls).toContainEqual(['claude', ['plugin', 'update', 'kddkit@kddkit', '--scope', 'project']]);
    expect(calls.filter(([, args]) => args[1] === 'marketplace')).toHaveLength(1);
    expect(calls.some(([, args]) => args.includes('-y'))).toBe(false);
  });

  it('updates only user scope outside a Git repository', () => {
    const rows = [claudeRow('user', '0.9.0'), claudeRow('project', '0.8.0', project)];
    const run: Runner = (_file, args) => args[1] === 'list'
      ? { status: 0, stdout: JSON.stringify(rows), stderr: '' }
      : { status: 0, stdout: '', stderr: '' };
    expect(updateClaude('0.9.0', run, dir).map((row) => row.status)).toEqual(['current', 'skipped']);
  });

  it('reports interactive approval instead of using -y in a non-TTY call', () => {
    const calls: string[][] = [];
    const run: Runner = (_file, args) => {
      calls.push(args);
      if (args[1] === 'list') return { status: 0, stdout: JSON.stringify([claudeRow('user')]), stderr: '' };
      if (args[1] === 'marketplace') return { status: 0, stdout: '', stderr: '' };
      return { status: 1, stdout: '', stderr: 'Confirmation required when stdin is not a TTY; pass -y.' };
    };
    expect(updateClaude('0.9.0', run, project)[0]).toMatchObject({
      name: 'claude', status: 'failed',
      detail: expect.stringContaining('claude plugin update kddkit@kddkit --scope user'),
    });
    expect(calls.some((args) => args.includes('-y'))).toBe(false);
  });

  it('recognizes the short -y approval hint without confirmation wording', () => {
    const run: Runner = (_file, args) => {
      if (args[1] === 'list') return { status: 0, stdout: JSON.stringify([claudeRow('user')]), stderr: '' };
      if (args[1] === 'marketplace') return { status: 0, stdout: '', stderr: '' };
      return { status: 1, stdout: '', stderr: 'Use -y to continue.' };
    };
    expect(updateClaude('0.9.0', run, project)[0].detail)
      .toContain('claude plugin update kddkit@kddkit --scope user');
  });

  it('treats invalid list data as failure and a missing Claude binary as skipped', () => {
    const malformed: Runner = () => ({ status: 0, stdout: '{', stderr: '' });
    expect(updateClaude('0.9.0', malformed, project)[0].status).toBe('failed');
    const missing: Runner = () => ({
      status: null, stdout: '', stderr: '', error: Object.assign(new Error('not found'), { code: 'ENOENT' }),
    });
    expect(updateClaude('0.9.0', missing, project)[0].status).toBe('skipped');
  });
});

describe('Codex plugin update', () => {
  function runWithVersions(afterUpgrade: string, afterAdd = afterUpgrade) {
    const calls: [string, string[]][] = [];
    let version = '0.8.0';
    const run: Runner = (file, args) => {
      calls.push([file, args]);
      if (args.join(' ') === 'plugin list --json') return {
        status: 0, stdout: JSON.stringify({ installed: [codexRow(version)], available: [] }), stderr: '',
      };
      if (args.join(' ') === 'plugin marketplace upgrade kddkit') version = afterUpgrade;
      else if (args.join(' ') === 'plugin add kddkit@kddkit') version = afterAdd;
      else throw new Error(args.join(' '));
      return { status: 0, stdout: '', stderr: '' };
    };
    return { run, calls };
  }

  it('accepts a Git marketplace even when the plugin source is local; skips add if refreshed', () => {
    const { run, calls } = runWithVersions('0.9.0');
    expect(updateCodex('0.9.0', run)).toMatchObject({ name: 'codex', status: 'updated' });
    expect(calls).toContainEqual(['codex', ['plugin', 'marketplace', 'upgrade', 'kddkit']]);
    expect(calls.some(([, args]) => args[1] === 'add')).toBe(false);
  });

  it('runs add only when refresh leaves the installed version old', () => {
    const { run, calls } = runWithVersions('0.8.0', '0.9.0');
    expect(updateCodex('0.9.0', run).status).toBe('updated');
    expect(calls).toContainEqual(['codex', ['plugin', 'add', 'kddkit@kddkit']]);
  });

  it('fails when both manager calls succeed but the installed version stays old', () => {
    const { run } = runWithVersions('0.8.0');
    expect(updateCodex('0.9.0', run)).toMatchObject({
      status: 'failed', detail: expect.stringContaining('0.8.0'),
    });
  });

  it('skips a genuinely local marketplace', () => {
    const calls: string[][] = [];
    const run: Runner = (_file, args) => {
      calls.push(args);
      return { status: 0, stdout: JSON.stringify({ installed: [codexRow('0.8.0', 'local')], available: [] }), stderr: '' };
    };
    expect(updateCodex('0.9.0', run).status).toBe('skipped');
    expect(calls).toHaveLength(1);
  });

  it('treats invalid list data as a failure', () => {
    const run: Runner = () => ({ status: 0, stdout: '[]', stderr: '' });
    expect(updateCodex('0.9.0', run).status).toBe('failed');
  });
});

describe('built kdd command', () => {
  function environment() {
    const preloader = join(dir, 'release.mjs');
    writeFileSync(preloader, `globalThis.fetch = async () => new Response(JSON.stringify([{
      tag_name: 'v0.9.0', html_url: 'https://github.com/mag1yar/kddkit/releases/tag/v0.9.0',
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
    };
  }

  it('adds update help and shows a cached notice only on a later human invocation', async () => {
    const env = environment();
    const help = spawnSync(process.execPath, [BIN, '--help'], { env, encoding: 'utf8' });
    expect(help.stdout).toMatch(/\bupdate\b/);
    expect(help.stderr).not.toContain('available; run kdd update');
    const updateHelp = spawnSync(process.execPath, [BIN, 'update', '--help'], { env, encoding: 'utf8' });
    expect(updateHelp.stdout).toContain('--replace-cli-from-registry');

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
    expect(JSON.parse(readFileSync(cacheFile, 'utf8')).latest).toBe('0.9.0');

    const human = spawnSync(process.execPath, [BIN, 'status'], { env, encoding: 'utf8' });
    expect(human.stderr.match(/available; run kdd update/g)).toHaveLength(1);
    expect(human.stderr).toContain('kdd: v0.9.0 available; run kdd update');
  });

  it('runs outside Git, reports a failed component, and continues to the others', () => {
    const env = environment();
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const claude = join(bin, 'claude');
    const codex = join(bin, 'codex');
    writeFileSync(claude, `#!/bin/sh
if [ "$2" = list ]; then
  printf '%s\\n' '[{"id":"kddkit@kddkit","version":"0.8.0","scope":"user","enabled":true,"installPath":"/plugin","installedAt":"2026-01-01","lastUpdated":"2026-01-01"}]'
elif [ "$2" = marketplace ]; then
  exit 0
else
  echo 'Use -y to continue.' >&2
  exit 1
fi
`);
    writeFileSync(codex, `#!/bin/sh
printf '%s\\n' '{"installed":[],"available":[]}'
`);
    chmodSync(claude, 0o755);
    chmodSync(codex, 0o755);
    env.PATH = `${bin}:${env.PATH}`;
    const result = spawnSync(process.execPath, [BIN, 'update'], {
      cwd: dir, env, encoding: 'utf8', timeout: 10_000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('claude: failed');
    expect(result.stdout).toContain('codex: skipped');
    expect(result.stdout).toContain('claude plugin update kddkit@kddkit --scope user');
    expect(existsSync(env.KDD_DB)).toBe(false);
  });
});
