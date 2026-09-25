import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { kddHome, updateDisposition, type UpdateChannel } from '@kddkit/core';

export type ComponentResult = {
  name: 'cli' | 'claude' | 'codex';
  status: 'updated' | 'current' | 'skipped' | 'failed';
  detail: string;
};

export type Runner = (
  file: string, args: string[], cwd?: string,
) => { status: number | null; stdout: string; stderr: string; error?: Error };

export const runCommand: Runner = (file, args, cwd) => {
  const result = spawnSync(file, args, {
    cwd, encoding: 'utf8', timeout: 5 * 60_000, maxBuffer: 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error ? { error: result.error } : {}),
  };
};

export function preflightTarget(target: string, channel: UpdateChannel, run: Runner): string | null {
  const tag = channel === 'stable' ? 'latest' : 'next';
  const result = run('npm', ['view', '@kddkit/cli', 'dist-tags', '--json', '--registry=https://registry.npmjs.org']);
  if (result.status !== 0) return `npm dist-tags check failed: ${result.stderr.trim() || result.error?.message || result.stdout.trim()}`;
  try {
    const tags = JSON.parse(result.stdout) as Record<string, unknown>;
    if (!tags || typeof tags !== 'object' || typeof tags[tag] !== 'string')
      return `npm dist-tags has no ${tag} version.`;
    if (tags[tag] !== target) return `npm ${tag}=${tags[tag]} disagrees with GitHub Release ${target}.`;
    return null;
  } catch {
    return 'npm dist-tags returned invalid JSON.';
  }
}

type CliReceipt = { cliPath: string; npmRoot: string; version: string; channel: UpdateChannel };

function receiptPath(): string { return join(kddHome(), 'update-cli-receipt.json'); }

function readReceipt(): CliReceipt | null {
  try {
    const path = receiptPath();
    if (statSync(path).size > 4096) return null;
    const value = JSON.parse(readFileSync(path, 'utf8')) as CliReceipt;
    return value && typeof value.cliPath === 'string' && typeof value.npmRoot === 'string'
      && typeof value.version === 'string' && (value.channel === 'stable' || value.channel === 'next')
      ? value : null;
  } catch { return null; }
}

function writeReceipt(receipt: CliReceipt): void {
  const path = receiptPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(receipt), { mode: 0o600, flag: 'wx' });
    renameSync(tmp, path);
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}

function npmCliFor(nodePath: string): string | null {
  const candidates = [nodePath];
  try { candidates.push(realpathSync(nodePath)); } catch { /* original path may still work */ }
  for (const executable of candidates) {
    for (const path of [
      join(dirname(dirname(executable)), 'lib/node_modules/npm/bin/npm-cli.js'),
      join(dirname(executable), 'node_modules/npm/bin/npm-cli.js'),
    ]) if (existsSync(path)) return path;
    try {
      const sibling = realpathSync(join(dirname(executable), 'npm'));
      if (basename(sibling) === 'npm-cli.js' && basename(dirname(dirname(sibling))) === 'npm')
        return sibling;
    } catch { /* no npm shim beside this Node */ }
  }
  return null;
}

export function updateCli(
  latest: string, channel: UpdateChannel, run: Runner, cliFile: string, nodePath: string,
  replaceUnknownSource = false,
): ComponentResult {
  const name = 'cli';
  if (process.env.npm_command === 'exec') return {
    name, status: 'skipped', detail: 'This is an npm exec/npx run; update the installed CLI separately.',
  };
  const npmCli = npmCliFor(nodePath);
  if (!npmCli) return {
    name, status: 'skipped',
    detail: `This Node has no npm CLI; use its package manager to install @kddkit/cli@${latest}.`,
  };

  const root = run(nodePath, [npmCli, 'root', '-g']);
  const npmRoot = root.stdout.trim();
  if (root.status !== 0 || !isAbsolute(npmRoot)) return {
    name, status: 'failed', detail: `npm root -g failed: ${root.stderr.trim() || root.error?.message || root.stdout.trim()}`,
  };

  const scopeDir = join(npmRoot, '@kddkit');
  const packageDir = join(scopeDir, 'cli');
  const distDir = join(packageDir, 'dist');
  const expectedFile = join(distDir, 'index.js');
  try {
    if ([scopeDir, packageDir, distDir, expectedFile].some((path) => lstatSync(path).isSymbolicLink())
      || realpathSync(cliFile) !== realpathSync(expectedFile)) return {
      name, status: 'skipped',
      detail: `This kdd is not the CLI owned by npm at ${npmRoot}; update its source or owning installation manually.`,
    };
  } catch {
    return {
      name, status: 'skipped',
      detail: `This kdd is outside npm's global root ${npmRoot}; update its source or owning installation manually.`,
    };
  }

  const listed = run(nodePath, [npmCli, 'ls', '-g', '@kddkit/cli', '--json', '--long']);
  if (listed.status !== 0) return {
    name, status: 'failed', detail: `npm ls -g @kddkit/cli failed: ${listed.stderr.trim() || listed.error?.message || listed.stdout.trim()}`,
  };

  let installed: Record<string, unknown>;
  try {
    const tree = JSON.parse(listed.stdout) as { dependencies?: Record<string, unknown> };
    const row = tree?.dependencies?.['@kddkit/cli'];
    if (!row || typeof row !== 'object') throw new Error('package missing');
    installed = row as Record<string, unknown>;
  } catch {
    return { name, status: 'failed', detail: 'npm ls -g @kddkit/cli returned invalid installation data.' };
  }

  const current = installed.version;
  const source = installed.resolved;
  if (typeof current !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(current)
    || (source !== undefined && typeof source !== 'string')) return {
    name, status: 'failed', detail: 'npm ls -g @kddkit/cli returned invalid version or source data.',
  };
  const disposition = updateDisposition(current, latest, channel);
  if (disposition !== 'install') return { name, status: 'current',
    detail: disposition === 'ahead' ? `CLI ${current} is ahead of ${latest}; no downgrade within this channel.`
      : `CLI is already ${current}.` };
  // npm can omit resolved for both registry and local tarball global installs.
  const receipt = readReceipt();
  const consent = receipt?.cliPath === realpathSync(cliFile) && receipt.npmRoot === npmRoot
    && receipt.version === current;
  if (source === undefined && !consent && !replaceUnknownSource) return {
    name, status: 'skipped',
    detail: 'npm did not report this CLI installation source; use --replace-cli-from-registry only if you want to replace it from npm.',
  };
  if (source !== undefined && source !== `https://registry.npmjs.org/@kddkit/cli/-/cli-${current}.tgz`) return {
    name, status: 'skipped',
    detail: 'This CLI source is not the published npm registry tarball; update its source manually.',
  };
  const install = run(nodePath, [npmCli, 'install', '-g', `@kddkit/cli@${latest}`]);
  if (install.status !== 0) return {
    name, status: 'failed', detail: `npm install failed: ${install.stderr.trim() || install.error?.message || install.stdout.trim()}`,
  };

  const invoked = run('kdd', ['--version']);
  const observed = invoked.stdout.trim() || invoked.stderr.trim() || invoked.error?.message || '(unavailable)';
  if (invoked.status !== 0 || observed !== latest) return {
    name, status: 'failed',
    detail: `npm installed ${latest} from ${current}, but kdd --version reports ${observed}; check your PATH and npm prefix.`,
  };
  try {
    writeReceipt({ cliPath: realpathSync(cliFile), npmRoot, version: latest, channel });
  } catch (error) {
    return { name, status: 'failed',
      detail: `kdd --version verified ${latest}, but could not save update consent receipt: ${error instanceof Error ? error.message : error}` };
  }
  return { name, status: 'updated', detail: `${current} → ${latest}; ${source === undefined ? 'unknown source replaced explicitly or by receipt; ' : ''}kdd --version verified.` };
}

export { updateClaude } from './update-claude.js';

export { updateCodex } from './update-codex.js';
