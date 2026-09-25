import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Runner } from './update.js';

export function preflightGitPlugin(
  url: string, ref: string, version: string, client: 'claude' | 'codex', run: Runner, cwd?: string,
): string | null {
  const dir = mkdtempSync(join(tmpdir(), 'kdd-update-ref-'));
  const checkout = join(dir, 'checkout');
  try {
    const cloned = run('git', ['clone', '--depth', '1', '--branch', ref, url, checkout], cwd);
    if (cloned.status !== 0) return `Git ref ${ref} is unavailable: ${cloned.stderr.trim() || cloned.error?.message || cloned.stdout.trim()}`;
    const marketplacePath = client === 'claude' ? '.claude-plugin/marketplace.json' : '.agents/plugins/marketplace.json';
    const manifestPath = client === 'claude' ? '.claude-plugin/plugin.json'
      : 'integrations/codex-plugin/.codex-plugin/plugin.json';
    const marketplace = JSON.parse(readFileSync(join(checkout, marketplacePath), 'utf8')) as Record<string, unknown>;
    const manifest = JSON.parse(readFileSync(join(checkout, manifestPath), 'utf8')) as Record<string, unknown>;
    if (marketplace.name !== 'kddkit' || !Array.isArray(marketplace.plugins)
      || !marketplace.plugins.some((plugin) => plugin?.name === 'kddkit')
      || manifest.name !== 'kddkit' || manifest.version !== version)
      return `Git ref ${ref} does not contain kddkit ${version} for ${client}.`;
    return null;
  } catch (error) {
    return `Could not verify Git ref ${ref}: ${error instanceof Error ? error.message : error}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
