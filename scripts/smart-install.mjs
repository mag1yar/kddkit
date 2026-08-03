// Ensures the native better-sqlite3 binary in the plugin root works under THIS node.
// Idempotent; exits 0 even on failure (failure logged to a fallback file).
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, sep } from 'node:path';

const VERSION = '^12.11.1'; // must match @kddkit/core
const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// Prod: installed into pluginRoot/node_modules (base = this script).
// Dev: pnpm keeps it in a nested store, unhoisted — resolve from packages/core,
// where it is linked. Порядок тот же, в котором модуль найдёт рантайм.
const BASES = [import.meta.url, join(pluginRoot, 'packages/core/index.js')];

/**
 * Здоровье модуля — это открытая база, а не найденный файл. better-sqlite3 подтягивает
 * нативный аддон лениво, при первом `new Database`: под чужим ABI и resolve, и require
 * проходят успешно, падает только конструктор. Прежняя проверка резолвом поэтому
 * не срабатывала ровно на той поломке, ради которой написана.
 * @returns {{ok: true} | {ok: false, dir?: string}} dir — каталог пакета под пересборку
 */
function probe() {
  for (const base of BASES) {
    const require = createRequire(base);
    let entry;
    try { entry = require.resolve('better-sqlite3'); } catch { continue; }
    try {
      new (require('better-sqlite3'))(':memory:').close();
      return { ok: true };
    } catch {
      // Резолвится, но не открывает базу — почти всегда ABI-mismatch. Чинится пересборкой
      // НА МЕСТЕ: под pnpm пакет лежит в .pnpm-сторе и затеняет любую копию в корне.
      const marker = `${sep}node_modules${sep}better-sqlite3${sep}`;
      const at = entry.lastIndexOf(marker);
      return at < 0 ? { ok: false } : { ok: false, dir: entry.slice(0, at + marker.length - 1) };
    }
  }
  return { ok: false };
}

/**
 * npm, живущий рядом с ЭТИМ node. Нативный модуль собирается под ABI того node, которым
 * крутится npm, — чужой npm из PATH собрал бы ровно ту поломку, которую мы чиним. Плюс
 * realpath: `node` часто оказывается симлинком в чужой каталог, где npm рядом уже нет.
 */
function npmCli() {
  const candidates = [process.execPath];
  try { candidates.push(realpathSync(process.execPath)); } catch { /* symlink is fine as-is */ }
  for (const exe of candidates) {
    const cli = join(dirname(dirname(exe)), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (existsSync(cli)) return cli;
  }
  return null;
}

function repair(dir) {
  // rebuild — когда пакет есть, но собран под другой ABI; install — когда его нет вовсе.
  const args = dir
    ? ['rebuild']
    : ['install', `better-sqlite3@${VERSION}`, '--prefix', pluginRoot];
  // Таймаут меньше бюджета хука (300с в hooks.json): без него node-gyp без тулчейна съедает
  // весь бюджет, Claude Code убивает всю цепочку — и не остаётся ни лога, ни session-start,
  // только пятиминутная пауза на каждом старте сессии.
  const opts = { stdio: 'ignore', cwd: dir ?? pluginRoot, timeout: 120_000 };
  const cli = npmCli();
  if (cli) execFileSync(process.execPath, [cli, ...args], opts);
  else execFileSync('npm', args, { ...opts, shell: process.platform === 'win32' });
}

const first = probe();
if (!first.ok) {
  try {
    repair(first.dir);
    // Пересборка могла не помочь (нет тулчейна, нет сети) — записываем это сейчас,
    // иначе единственным следом останется молча умирающий MCP-сервер.
    if (!probe().ok) throw new Error('better-sqlite3 still unusable after repair');
  } catch (e) {
    try {
      appendFileSync(join(pluginRoot, '.kdd-install-error.log'),
        `${new Date().toISOString()} node ${process.version} ${String(e)}\n`);
    } catch { /* ignore */ }
  }
}
process.exit(0);
