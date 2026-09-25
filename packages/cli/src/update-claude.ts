import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { updateDisposition, type UpdateChannel } from '@kddkit/core';
import { preflightGitPlugin } from './update-git.js';
import type { ComponentResult, Runner } from './update.js';

type Scope = 'user' | 'project' | 'local';
type Plugin = { id: string; version: string; scope: string; enabled: boolean; projectPath?: string };
type Source = { kind: 'github' | 'git'; base: string; ref?: string; scope: Scope };
type Marketplace = { name: string; source: string; repo?: string; url?: string; ref?: string };

const outcome = (status: ComponentResult['status'], detail: string): ComponentResult => ({ name: 'claude', status, detail });
const errorText = (r: ReturnType<Runner>) => (r.stderr.trim() || r.error?.message || r.stdout.trim() || 'unknown error').slice(0, 500);

function gitRoot(cwd: string): string | null {
  try { return realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()); }
  catch { return null; }
}

function pluginRows(run: Runner, cwd: string): Plugin[] | ComponentResult {
  const listed = run('claude', ['plugin', 'list', '--json'], cwd);
  if ((listed.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return outcome('skipped', 'Claude Code CLI is not installed.');
  if (listed.status !== 0) return outcome('failed', `claude plugin list failed: ${errorText(listed)}`);
  try {
    const parsed: unknown = JSON.parse(listed.stdout);
    if (!Array.isArray(parsed)) throw new Error('invalid list');
    const rows = parsed.filter((row) => row?.id === 'kddkit@kddkit') as Plugin[];
    if (rows.some((row) => typeof row.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(row.version)
      || typeof row.scope !== 'string' || typeof row.enabled !== 'boolean')) throw new Error('invalid plugin');
    return rows;
  } catch { return outcome('failed', 'claude plugin list returned invalid plugin data.'); }
}

function marketplaceRows(run: Runner, cwd: string): Marketplace[] | ComponentResult {
  const listed = run('claude', ['plugin', 'marketplace', 'list', '--json'], cwd);
  if (listed.status !== 0) return outcome('failed', `claude marketplace list failed: ${errorText(listed)}`);
  try {
    const parsed: unknown = JSON.parse(listed.stdout);
    if (!Array.isArray(parsed)) throw new Error('invalid list');
    return parsed.filter((row) => row?.name === 'kddkit') as Marketplace[];
  } catch { return outcome('failed', 'claude marketplace list returned invalid data.'); }
}

function declarations(root: string | null): Source[] {
  const config = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  const files: [Scope, string][] = [['user', join(config, 'settings.json')]];
  if (root) files.push(['project', join(root, '.claude/settings.json')],
    ['local', join(root, '.claude/settings.local.json')]);
  const out: Source[] = [];
  for (const [scope, file] of files) {
    let data: unknown;
    try { data = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
    const s = (data as { extraKnownMarketplaces?: { kddkit?: { source?: Record<string, unknown> } } })
      ?.extraKnownMarketplaces?.kddkit?.source;
    if (!s) continue;
    if (s.source === 'github' && s.repo === 'mag1yar/kddkit'
      && (s.ref === undefined || typeof s.ref === 'string'))
      out.push({ kind: 'github', base: s.repo, ref: s.ref as string | undefined, scope });
    else if (s.source === 'git' && typeof s.url === 'string'
      && /^(https:\/\/github\.com\/mag1yar\/kddkit(?:\.git)?|git@github\.com:mag1yar\/kddkit(?:\.git)?)$/.test(s.url)
      && (s.ref === undefined || typeof s.ref === 'string'))
      out.push({ kind: 'git', base: s.url, ref: s.ref as string | undefined, scope });
    else out.push({ kind: 'git', base: '', scope });
  }
  return out;
}

function sourceArg(s: Source, ref?: string): string {
  return `${s.base}${ref ? `${s.kind === 'github' ? '@' : '#'}${ref}` : ''}`;
}

function matchesSource(s: Source, market: Marketplace[]): boolean {
  return market.length === 1 && market[0].source === s.kind
    && (s.kind === 'github' ? market[0].repo === s.base : market[0].url === s.base)
    && market[0].ref === s.ref;
}

function matchesPlugins(rows: Plugin[], original: Plugin[], version?: string): boolean {
  return rows.length === original.length && original.every((old) => rows.some((row) =>
    row.scope === old.scope && row.enabled === old.enabled && row.version === (version ?? old.version)
    && (old.scope === 'user' || row.projectPath === old.projectPath)));
}

function realPath(path: string): string | null {
  try { return realpathSync(path); } catch { return null; }
}

export function updateClaude(target: string, channel: UpdateChannel, run: Runner, cwd: string): ComponentResult[] {
  const first = pluginRows(run, cwd);
  if (!Array.isArray(first)) return [first];
  if (!first.length) return [outcome('skipped', 'kddkit is not installed in Claude Code.')];
  const root = gitRoot(cwd);
  if (new Set(first.map((row) => `${row.scope}:${row.projectPath ?? ''}`)).size !== first.length)
    return [outcome('skipped', 'Claude plugin has duplicate scope declarations.')];
  const owned = first.filter((row) => ['user', 'project', 'local'].includes(row.scope)
    && (row.scope === 'user' || (!!root && !!row.projectPath && realPath(row.projectPath) === root)));
  if (!owned.length) return [outcome('skipped', 'Claude plugin is managed or belongs to another project.')];
  const skipped = owned.length === first.length ? []
    : [outcome('skipped', 'Claude plugin scopes outside this project were left unchanged.')];
  const sources = declarations(root);
  if (sources.length !== 1 || !sources[0].base)
    return [outcome('skipped', 'Claude marketplace source or declaration scope is ambiguous or unsupported.')];
  const source = sources[0];
  const market = marketplaceRows(run, cwd);
  if (!Array.isArray(market)) return [market];
  if (!matchesSource(source, market)) return [outcome('skipped', 'Claude marketplace list disagrees with its declaration.')];
  const ref = channel === 'stable' ? 'master' : 'next';
  if (source.ref !== ref && skipped.length) return [outcome('skipped',
    'Claude marketplace ref switch would uninstall a plugin scope outside this project.')];
  const active = source.ref === ref ? owned : first;
  const dispositions = active.map((row) => updateDisposition(row.version, target, channel));
  if (dispositions.includes('ahead')) return [...skipped, outcome('current', `At least one Claude plugin is ahead of ${target}; no scope was changed.`)];
  if (dispositions.every((value) => value === 'current') && source.ref === ref)
    return [...skipped, outcome('current', `Claude plugin is already ${target} on ${ref}.`)];
  const url = source.kind === 'github' ? `https://github.com/${source.base}.git` : source.base;
  const preflight = preflightGitPlugin(url, ref, target, 'claude', run, cwd);
  if (preflight) return [outcome('failed', preflight)];
  const label = `Claude ${active.map((row) => row.scope).join(', ')} scope${active.length > 1 ? 's' : ''}`;
  if (source.ref === ref) {
    const refresh = run('claude', ['plugin', 'marketplace', 'update', 'kddkit'], cwd);
    if (refresh.status !== 0) return [outcome('failed', `${label}: marketplace refresh failed: ${errorText(refresh)}`)];
    for (const row of active) {
      if (updateDisposition(row.version, target, channel) === 'current') continue;
      const args = ['plugin', 'update', 'kddkit@kddkit', '--scope', row.scope];
      const updated = run('claude', args, cwd);
      if (updated.status !== 0) return [...skipped, outcome('failed', /confirm|approv|\btty\b|-y\b/i.test(errorText(updated))
        ? `${label}: interactive approval required; run claude ${args.join(' ')} in a terminal.`
        : `${label}: update failed: ${errorText(updated)}`)];
    }
    const checked = pluginRows(run, cwd);
    const expected = first.map((row) => active.includes(row) ? { ...row, version: target } : row);
    if (!Array.isArray(checked) || !matchesPlugins(checked, expected))
      return [...skipped, outcome('failed', `${label}: expected ${target} after update.`)];
    return [...skipped, outcome('updated', `${label}: updated to ${target}; verified.`)];
  }

  const removed = run('claude', ['plugin', 'marketplace', 'remove', 'kddkit', '--scope', source.scope], cwd);
  if (removed.status !== 0) return [outcome('failed', `${label}: marketplace remove failed: ${errorText(removed)}`)];
  let problem: string | null = null;
  const added = run('claude', ['plugin', 'marketplace', 'add', sourceArg(source, ref), '--scope', source.scope], cwd);
  if (added.status !== 0) problem = `target marketplace add failed: ${errorText(added)}`;
  else for (const row of first) {
    const installedResult = run('claude', ['plugin', 'install', 'kddkit@kddkit', '--scope', row.scope], cwd);
    if (installedResult.status !== 0) problem = /confirm|approv|\btty\b|-y\b/i.test(errorText(installedResult))
      ? `interactive approval required; run claude plugin install kddkit@kddkit --scope ${row.scope} in a terminal`
      : `target plugin install failed in ${row.scope}: ${errorText(installedResult)}`;
    else if (!row.enabled) {
      const disabled = run('claude', ['plugin', 'disable', 'kddkit@kddkit', '--scope', row.scope], cwd);
      if (disabled.status !== 0) problem = `could not restore ${row.scope} disabled state: ${errorText(disabled)}`;
    }
    if (problem) break;
  }
  if (!problem) {
    const checked = pluginRows(run, cwd);
    const nextMarket = marketplaceRows(run, cwd);
    if (!Array.isArray(checked) || !Array.isArray(nextMarket) || !matchesPlugins(checked, first, target)
      || !matchesSource({ ...source, ref }, nextMarket))
      problem = `expected ${target} on ${ref} after switch`;
  }
  if (!problem) return [outcome('updated', `${label}: updated to ${target} on ${ref}; verified.`)];

  const partial = marketplaceRows(run, cwd);
  if (Array.isArray(partial) && partial.length)
    run('claude', ['plugin', 'marketplace', 'remove', 'kddkit', '--scope', source.scope], cwd);
  const restored = run('claude', ['plugin', 'marketplace', 'add', sourceArg(source, source.ref), '--scope', source.scope], cwd);
  if (restored.status === 0) {
    for (const row of first) {
      const reinstalled = run('claude', ['plugin', 'install', 'kddkit@kddkit', '--scope', row.scope], cwd);
      if (reinstalled.status === 0 && !row.enabled)
        run('claude', ['plugin', 'disable', 'kddkit@kddkit', '--scope', row.scope], cwd);
    }
    const checked = pluginRows(run, cwd);
    const oldMarket = marketplaceRows(run, cwd);
    if (Array.isArray(checked) && Array.isArray(oldMarket) && matchesPlugins(checked, first)
      && matchesSource(source, oldMarket))
      return [outcome('failed', `${label}: ${problem}; original plugin restored.`)];
  }
  return [outcome('failed', `${label}: ${problem}; CRITICAL: rollback failed. Restore ${sourceArg(source, source.ref)} in ${source.scope} scope and the original plugin scopes/versions manually.`)];
}
