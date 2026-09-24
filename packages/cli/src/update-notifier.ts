import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVersions, kddHome, kddVersion } from '@kddkit/core';

export type UpdateCache = { latest: string | null; checkedAt: number };

export function readUpdateCache(path: string): UpdateCache | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object') return null;
    const { latest, checkedAt } = value as Record<string, unknown>;
    if (latest !== null && (typeof latest !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(latest))) return null;
    if (typeof checkedAt !== 'number' || !Number.isFinite(checkedAt) || checkedAt < 0) return null;
    return { latest, checkedAt };
  } catch {
    return null;
  }
}

export function shouldRefresh(cache: UpdateCache | null, now: number): boolean {
  if (!cache || cache.checkedAt > now) return true;
  return now - cache.checkedAt >= (cache.latest ? 24 * 60 * 60_000 : 5 * 60_000);
}

export function eligible(argv: string[], env: NodeJS.ProcessEnv): boolean {
  if (env.CI || env.NO_UPDATE_NOTIFIER || env.CLAUDECODE === '1' || env.CODEX_SESSION_ID
    || env.CODEX_THREAD_ID || env.KDD_ACTOR === 'ai' || env.npm_command === 'exec') return false;
  if (argv.some((arg) => ['--json', '--help', '-h', '--version', '-V'].includes(arg))) return false;
  return !['update', 'worker', 'help'].includes(argv[0] ?? '');
}

export function noticeOnStartup(
  argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env,
): void {
  if (!eligible(argv, env)) return;
  const path = join(kddHome(), 'update-check.json');
  const cache = readUpdateCache(path);
  if (cache?.latest && compareVersions(cache.latest, kddVersion()) > 0)
    process.stderr.write(`kdd: v${cache.latest} available; run kdd update\n`);
  if (!shouldRefresh(cache, Date.now())) return;

  try {
    const worker = fileURLToPath(new URL('./update-check-worker.js', import.meta.url));
    const child = spawn(process.execPath, [worker], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch { /* Update checks never delay or fail the CLI command. */ }
}
