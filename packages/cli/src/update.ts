import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { compareVersions } from '@kddkit/core';

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
  latest: string, run: Runner, cliFile: string, nodePath: string,
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
  if (compareVersions(current, latest) >= 0) return {
    name, status: 'current', detail: `CLI is already ${current}.`,
  };
  // npm can omit resolved for both registry and local tarball global installs.
  if (source === undefined && !replaceUnknownSource) return {
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
  return { name, status: 'updated', detail: `${current} → ${latest}; ${source === undefined ? 'unknown source replaced explicitly; ' : ''}kdd --version verified.` };
}

type RunResult = ReturnType<Runner>;
type ClaudeRow = { id: string; version: string; scope: string; projectPath?: string };
type CodexRow = {
  pluginId: string; version: string; installed: boolean;
  marketplaceSource: { sourceType: string };
};

function missingExecutable(result: RunResult): boolean {
  return (result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function commandError(result: RunResult): string {
  return (result.stderr.trim() || result.error?.message || result.stdout.trim() || 'unknown error').slice(0, 500);
}

function validVersion(version: unknown): version is string {
  return typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version);
}

function inspectClaude(run: Runner, cwd: string): { rows: ClaudeRow[] } | { error: ComponentResult } {
  const listed = run('claude', ['plugin', 'list', '--json'], cwd);
  if (missingExecutable(listed)) return {
    error: { name: 'claude', status: 'skipped', detail: 'Claude Code CLI is not installed.' },
  };
  if (listed.status !== 0) return {
    error: { name: 'claude', status: 'failed', detail: `claude plugin list failed: ${commandError(listed)}` },
  };
  try {
    const parsed: unknown = JSON.parse(listed.stdout);
    if (!Array.isArray(parsed)) throw new Error('expected an array');
    const rows = parsed.filter((item) => item?.id === 'kddkit@kddkit') as ClaudeRow[];
    if (rows.some((row) => !validVersion(row.version) || typeof row.scope !== 'string'))
      throw new Error('invalid kddkit row');
    return { rows };
  } catch {
    return { error: { name: 'claude', status: 'failed', detail: 'claude plugin list returned invalid JSON or plugin data.' } };
  }
}

function gitRoot(cwd: string): string | null {
  try {
    return realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim());
  } catch { return null; }
}

function sameProject(path: string | undefined, root: string | null): boolean {
  if (!root || !path) return false;
  try { return realpathSync(path) === root; } catch { return false; }
}

export function updateClaude(latest: string, run: Runner, cwd: string): ComponentResult[] {
  const first = inspectClaude(run, cwd);
  if ('error' in first) return [first.error];
  if (first.rows.length === 0) return [{ name: 'claude', status: 'skipped', detail: 'kddkit is not installed in Claude Code.' }];
  const root = gitRoot(cwd);
  let refresh: RunResult | null = null;
  return first.rows.map((row) => {
    const scope = row.scope;
    const label = `Claude ${scope} scope`;
    if (scope === 'managed') return {
      name: 'claude', status: 'skipped', detail: `${label} is managed by policy.`,
    };
    if (scope !== 'user' && !(scope === 'project' || scope === 'local')) return {
      name: 'claude', status: 'skipped', detail: `${label} is not an updatable scope.`,
    };
    if (scope !== 'user' && !sameProject(row.projectPath, root)) return {
      name: 'claude', status: 'skipped', detail: `${label} belongs to another project or no Git repository is active.`,
    };
    if (compareVersions(row.version, latest) >= 0) return {
      name: 'claude', status: 'current', detail: `${label} is already ${row.version}.`,
    };

    refresh ??= run('claude', ['plugin', 'marketplace', 'update', 'kddkit'], cwd);
    if (refresh.status !== 0) return {
      name: 'claude', status: 'failed', detail: `${label}: marketplace refresh failed: ${commandError(refresh)}`,
    };
    const args = ['plugin', 'update', 'kddkit@kddkit', '--scope', scope];
    const updated = run('claude', args, cwd);
    if (updated.status !== 0) {
      const approval = /confirm|approv|\btty\b|-y\b/i.test(`${updated.stderr} ${updated.stdout}`);
      return {
        name: 'claude', status: 'failed',
        detail: approval
          ? `${label}: interactive approval required; run claude ${args.join(' ')} in a terminal.`
          : `${label}: update failed: ${commandError(updated)}`,
      };
    }
    const checked = inspectClaude(run, cwd);
    if ('error' in checked) return {
      name: 'claude', status: 'failed', detail: `${label}: could not verify update: ${checked.error.detail}`,
    };
    const observed = checked.rows.find((item) => item.scope === scope
      && (scope === 'user' || item.projectPath === row.projectPath));
    if (!observed || compareVersions(observed.version, latest) < 0) return {
      name: 'claude', status: 'failed',
      detail: `${label}: expected ${latest}, observed ${observed?.version ?? 'absent'} after update.`,
    };
    return { name: 'claude', status: 'updated', detail: `${label}: ${row.version} → ${observed.version}; verified.` };
  });
}

function inspectCodex(run: Runner): { row: CodexRow | null } | { error: ComponentResult } {
  const listed = run('codex', ['plugin', 'list', '--json']);
  if (missingExecutable(listed)) return {
    error: { name: 'codex', status: 'skipped', detail: 'Codex CLI is not installed.' },
  };
  if (listed.status !== 0) return {
    error: { name: 'codex', status: 'failed', detail: `codex plugin list failed: ${commandError(listed)}` },
  };
  try {
    const parsed: unknown = JSON.parse(listed.stdout);
    if (!parsed || typeof parsed !== 'object' || !('installed' in parsed)
      || !Array.isArray(parsed.installed)) throw new Error('expected installed array');
    const row = parsed.installed.find((item) => item?.pluginId === 'kddkit@kddkit') as CodexRow | undefined;
    if (row && (!validVersion(row.version) || row.installed !== true
      || typeof row.marketplaceSource?.sourceType !== 'string')) throw new Error('invalid kddkit row');
    return { row: row ?? null };
  } catch {
    return { error: { name: 'codex', status: 'failed', detail: 'codex plugin list returned invalid JSON or plugin data.' } };
  }
}

export function updateCodex(latest: string, run: Runner): ComponentResult {
  const first = inspectCodex(run);
  if ('error' in first) return first.error;
  if (!first.row) return { name: 'codex', status: 'skipped', detail: 'kddkit is not installed in Codex.' };
  const current = first.row.version;
  if (first.row.marketplaceSource.sourceType !== 'git') return {
    name: 'codex', status: 'skipped',
    detail: `Codex marketplace is ${first.row.marketplaceSource.sourceType}; update its source manually.`,
  };
  if (compareVersions(current, latest) >= 0) return {
    name: 'codex', status: 'current', detail: `Codex plugin is already ${current}.`,
  };

  const upgraded = run('codex', ['plugin', 'marketplace', 'upgrade', 'kddkit']);
  if (upgraded.status !== 0) return {
    name: 'codex', status: 'failed', detail: `Codex marketplace upgrade failed: ${commandError(upgraded)}`,
  };
  const refreshed = inspectCodex(run);
  if ('error' in refreshed) return { name: 'codex', status: 'failed', detail: `Could not verify Codex refresh: ${refreshed.error.detail}` };
  if (!refreshed.row) return { name: 'codex', status: 'failed', detail: 'Codex plugin disappeared after marketplace refresh.' };
  let observed = refreshed.row.version;
  if (compareVersions(observed, latest) < 0) {
    const added = run('codex', ['plugin', 'add', 'kddkit@kddkit']);
    if (added.status !== 0) return {
      name: 'codex', status: 'failed', detail: `Codex plugin add failed: ${commandError(added)}`,
    };
    const checked = inspectCodex(run);
    if ('error' in checked) return { name: 'codex', status: 'failed', detail: `Could not verify Codex update: ${checked.error.detail}` };
    observed = checked.row?.version ?? 'absent';
  }
  if (!validVersion(observed) || compareVersions(observed, latest) < 0) return {
    name: 'codex', status: 'failed', detail: `Codex plugin stayed at ${observed}; expected ${latest}.`,
  };
  return { name: 'codex', status: 'updated', detail: `${current} → ${observed}; verified.` };
}
