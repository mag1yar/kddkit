import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { updateDisposition, type UpdateChannel } from '@kddkit/core';
import { parse } from 'smol-toml';
import { preflightGitPlugin } from './update-git.js';
import type { ComponentResult, Runner } from './update.js';

type Source = { source: string; ref?: string; sparsePaths: string[] };
type Plugin = { pluginId: string; version: string; installed: boolean; enabled: boolean;
  marketplaceSource: { sourceType: string; source: string } };
type Marketplace = { name: string; marketplaceSource: { sourceType: string; source: string } };
const outcome = (status: ComponentResult['status'], detail: string): ComponentResult => ({ name: 'codex', status, detail });
const errorText = (r: ReturnType<Runner>) => (r.stderr.trim() || r.error?.message || r.stdout.trim() || 'unknown error').slice(0, 500);
const configPath = () => join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml');

export function readCodexSource(file: string): Source | null {
  try {
    const doc = parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const market = (doc.marketplaces as Record<string, unknown> | undefined)?.kddkit as Record<string, unknown> | undefined;
    if (!market || market.source_type !== 'git' || typeof market.source !== 'string'
      || (market.ref !== undefined && typeof market.ref !== 'string')
      || (market.ref_name !== undefined && typeof market.ref_name !== 'string')
      || (market.ref !== undefined && market.ref_name !== undefined && market.ref !== market.ref_name)
      || (market.sparse_paths !== undefined && (!Array.isArray(market.sparse_paths)
        || market.sparse_paths.some((path: unknown) => typeof path !== 'string')))) return null;
    const ref = (market.ref ?? market.ref_name) as string | undefined;
    return { source: market.source, ...(ref !== undefined ? { ref } : {}),
      sparsePaths: (market.sparse_paths as string[] | undefined) ?? [] };
  } catch { return null; }
}

function plugin(run: Runner): Plugin | null | ComponentResult {
  const listed = run('codex', ['plugin', 'list', '--json']);
  if ((listed.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return outcome('skipped', 'Codex CLI is not installed.');
  if (listed.status !== 0) return outcome('failed', `codex plugin list failed: ${errorText(listed)}`);
  try {
    const parsed = JSON.parse(listed.stdout) as { installed?: Plugin[] };
    if (!Array.isArray(parsed?.installed)) throw new Error('invalid list');
    const rows = parsed.installed.filter((row) => row?.pluginId === 'kddkit@kddkit');
    if (rows.length > 1 || rows.some((row) => !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(row.version)
      || row.installed !== true || typeof row.enabled !== 'boolean'
      || typeof row.marketplaceSource?.sourceType !== 'string'
      || typeof row.marketplaceSource?.source !== 'string')) throw new Error('invalid plugin');
    return rows[0] ?? null;
  } catch { return outcome('failed', 'codex plugin list returned invalid plugin data.'); }
}

function marketplace(run: Runner): Marketplace | null | ComponentResult {
  const listed = run('codex', ['plugin', 'marketplace', 'list', '--json']);
  if (listed.status !== 0) return outcome('failed', `codex marketplace list failed: ${errorText(listed)}`);
  try {
    const parsed = JSON.parse(listed.stdout) as { marketplaces?: Marketplace[] };
    if (!Array.isArray(parsed?.marketplaces)) throw new Error('invalid list');
    const rows = parsed.marketplaces.filter((row) => row?.name === 'kddkit');
    if (rows.length > 1) throw new Error('ambiguous marketplace');
    return rows[0] ?? null;
  } catch { return outcome('failed', 'codex marketplace list returned invalid data.'); }
}

function addArgs(source: Source, ref?: string): string[] {
  return ['plugin', 'marketplace', 'add', source.source,
    ...(ref ? ['--ref', ref] : []), ...source.sparsePaths.flatMap((path) => ['--sparse', path])];
}

function sameSource(a: Source | null, b: Source, ref?: string): boolean {
  return !!a && a.source === b.source && a.ref === ref
    && a.sparsePaths.length === b.sparsePaths.length
    && a.sparsePaths.every((path, i) => path === b.sparsePaths[i]);
}

function observed(run: Runner, source: Source, ref: string | undefined, version: string,
  enabled: boolean): boolean {
  const row = plugin(run);
  const market = marketplace(run);
  return !!row && 'pluginId' in row && row.version === version && row.enabled === enabled
    && row.marketplaceSource.sourceType === 'git' && row.marketplaceSource.source === source.source
    && !!market && !('status' in market) && market.marketplaceSource?.sourceType === 'git'
    && market.marketplaceSource.source === source.source
    && sameSource(readCodexSource(configPath()), source, ref);
}

export function updateCodex(target: string, channel: UpdateChannel, run: Runner): ComponentResult {
  const first = plugin(run);
  if (first === null) return outcome('skipped', 'kddkit is not installed in Codex.');
  if ('status' in first) return first;
  if (!first.enabled) return outcome('skipped', 'Codex plugin is disabled; its manager would re-enable it during reinstall.');
  if (first.marketplaceSource.sourceType !== 'git') return outcome('skipped',
    `Codex marketplace is ${first.marketplaceSource.sourceType}; update its source manually.`);
  const source = readCodexSource(configPath());
  if (!source || !/^(https:\/\/github\.com\/mag1yar\/kddkit(?:\.git)?|git@github\.com:mag1yar\/kddkit(?:\.git)?)$/.test(source.source))
    return outcome('skipped', 'Codex Git marketplace config is absent, invalid, or unrelated.');
  const market = marketplace(run);
  if (!market || 'status' in market || market.marketplaceSource?.sourceType !== 'git'
    || market.marketplaceSource.source !== source.source || first.marketplaceSource.source !== source.source)
    return outcome('skipped', 'Codex marketplace source disagrees with config or plugin.');
  const ref = channel === 'stable' ? 'master' : 'next';
  const disposition = updateDisposition(first.version, target, channel);
  if (disposition === 'ahead') return outcome('current', `Codex plugin ${first.version} is ahead of ${target}.`);
  if (disposition === 'current' && source.ref === ref) return outcome('current', `Codex plugin is already ${target} on ${ref}.`);
  const preflight = preflightGitPlugin(source.source, ref, target, 'codex', run);
  if (preflight) return outcome('failed', preflight);

  if (source.ref === ref) {
    const upgraded = run('codex', ['plugin', 'marketplace', 'upgrade', 'kddkit']);
    if (upgraded.status !== 0) return outcome('failed', `Codex marketplace upgrade failed: ${errorText(upgraded)}`);
    if (!observed(run, source, ref, target, first.enabled)) {
      const added = run('codex', ['plugin', 'add', 'kddkit@kddkit']);
      if (added.status !== 0) return outcome('failed', `Codex plugin add failed: ${errorText(added)}`);
    }
    return observed(run, source, ref, target, first.enabled)
      ? outcome('updated', `${first.version} → ${target}; verified.`)
      : outcome('failed', `Codex plugin did not reach ${target} on ${ref}.`);
  }

  const removed = run('codex', ['plugin', 'marketplace', 'remove', 'kddkit']);
  if (removed.status !== 0) return outcome('failed', `Codex marketplace remove failed: ${errorText(removed)}`);
  let problem: string | null = null;
  const added = run('codex', addArgs(source, ref));
  if (added.status !== 0) problem = `target marketplace add failed: ${errorText(added)}`;
  else if (!observed(run, source, ref, target, first.enabled)) {
    const installed = run('codex', ['plugin', 'add', 'kddkit@kddkit']);
    if (installed.status !== 0) problem = `target plugin add failed: ${errorText(installed)}`;
  }
  if (!problem && !observed(run, source, ref, target, first.enabled))
    problem = `Codex plugin did not reach ${target} on ${ref}`;
  if (!problem) return outcome('updated', `${first.version} → ${target} on ${ref}; verified.`);

  const partial = marketplace(run);
  if (partial && !('status' in partial)) run('codex', ['plugin', 'marketplace', 'remove', 'kddkit']);
  const restored = run('codex', addArgs(source, source.ref));
  if (restored.status === 0) {
    if (!observed(run, source, source.ref, first.version, first.enabled))
      run('codex', ['plugin', 'add', 'kddkit@kddkit']);
    if (observed(run, source, source.ref, first.version, first.enabled))
      return outcome('failed', `${problem}; original Codex plugin restored.`);
  }
  return outcome('failed', `${problem}; CRITICAL: rollback failed. Restore ${source.source} ref ${source.ref ?? '(default)'} with sparse paths ${source.sparsePaths.join(', ')} and plugin ${first.version} manually.`);
}
