// Native dependencies are local to the installed Codex plugin, never the monorepo.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const diagnostic = join(process.env.PLUGIN_DATA || root, 'kdd-install-error.log');

function npmCli() {
  const candidates = [process.execPath];
  try { candidates.push(realpathSync(process.execPath)); } catch { /* use original */ }
  for (const executable of candidates) {
    const cli = join(dirname(dirname(executable)), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (existsSync(cli)) return cli;
  }
}

function healthy() {
  try {
    const require = createRequire(import.meta.url);
    const Database = require('better-sqlite3');
    new Database(':memory:').close();
    return true;
  } catch { return false; }
}

try {
  if (!healthy()) {
    const cli = npmCli();
    const args = ['ci', '--omit=dev'];
    if (cli) execFileSync(process.execPath, [cli, ...args], { cwd: root, stdio: 'ignore', timeout: 120_000 });
    else if (process.platform === 'win32') {
      // cmd owns .cmd resolution; the fixed command is one /c argument, so paths in cwd need no quoting.
      execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm.cmd ci --omit=dev'],
        { cwd: root, stdio: 'ignore', timeout: 120_000 });
    } else execFileSync('npm', args, { cwd: root, stdio: 'ignore', timeout: 120_000 });
    if (!healthy()) throw new Error('better-sqlite3 is unusable after npm ci');
  }
} catch (error) {
  try { appendFileSync(diagnostic, `${new Date().toISOString()} ${String(error)}\n`); } catch { /* no writable diagnostics */ }
}
