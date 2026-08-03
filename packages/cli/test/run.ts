import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BIN = fileURLToPath(new URL('../dist/index.js', import.meta.url));

export function makeEnv(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), 'kdd-cli-'));
  return {
    ...process.env,
    KDD_DB: join(dir, 'kdd.db'),
    KDD_DECISIONS_DIR: join(dir, 'decisions'),
    KDD_ACTOR: '',
    // Иначе тесты, запущенные из-под Claude Code, унаследовали бы CLAUDECODE=1 и получили
    // ai-актора там, где проверяется поведение человека (см. getActor).
    CLAUDECODE: '',
  };
}

export function kdd(env: NodeJS.ProcessEnv, ...args: string[]): string {
  return execFileSync('node', [BIN, ...args], { env, encoding: 'utf8' });
}

export function kddFail(env: NodeJS.ProcessEnv, ...args: string[]): { code: number; stderr: string } {
  try {
    execFileSync('node', [BIN, ...args], { env, encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, stderr: '' };
  } catch (e: any) {
    return { code: e.status, stderr: String(e.stderr) };
  }
}
