import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const source = new URL('../integrations/codex-plugin/', import.meta.url);
const temp = mkdtempSync(join(tmpdir(), 'kdd-codex-plugin-'));
const plugin = join(temp, 'plugin');
let child;

function waitForClose(process, timeout) {
  return new Promise((resolve) => {
    const finish = (closed) => {
      clearTimeout(timer);
      process.removeListener('close', done);
      process.removeListener('error', done);
      resolve(closed);
    };
    const done = () => finish(true);
    const timer = setTimeout(() => finish(false), timeout);
    process.once('close', done);
    process.once('error', done);
  });
}

async function stopChild(process) {
  if (process.exitCode !== null || process.signalCode !== null) return;
  const closing = waitForClose(process, 5_000);
  try { process.kill(); } catch { /* already gone */ }
  if (await closing) return;
  const forced = waitForClose(process, 5_000);
  try { process.kill('SIGKILL'); } catch { /* already gone */ }
  if (!await forced) throw new Error('MCP child did not close after SIGKILL');
}

function rpc(child, request) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('MCP response timed out')), 15_000);
    const onData = (chunk) => {
      output += chunk;
      const line = output.split('\n').find((value) => value.trim().startsWith('{'));
      if (!line) return;
      try {
        const message = JSON.parse(line);
        if (message.id === request.id) { clearTimeout(timer); resolve(message); }
      } catch { /* wait for full line */ }
    };
    child.stdout.on('data', onData);
    child.once('error', reject);
    child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

try {
  cpSync(source, plugin, { recursive: true, dereference: true, filter: (path) => !path.endsWith('node_modules') });
  mkdirSync(join(temp, 'data'));
  execFileSync(process.execPath, ['hooks/smart-install.mjs'], {
    cwd: plugin,
    env: { ...process.env, PLUGIN_DATA: join(temp, 'data') },
    stdio: 'inherit',
  });
  const installError = join(temp, 'data', 'kdd-install-error.log');
  if (existsSync(installError)) throw new Error(readFileSync(installError, 'utf8'));
  const require = createRequire(join(plugin, 'package.json'));
  if (!existsSync(join(plugin, 'node_modules', 'better-sqlite3')))
    throw new Error(`smart-install left no local better-sqlite3; require resolves ${require.resolve('better-sqlite3')}`);
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
  const core = await import(pathToFileURL(join(plugin, 'runtime/core.js')).href);
  const dbPath = join(temp, 'hook.db');
  const db = core.openDb(dbPath, plugin);
  const actor = { type: 'ai', id: 'codex:full-codex-session' };
  core.addTask(db, { title: 'hook task' }, { type: 'user' });
  core.moveTask(db, 1, 'in_progress', actor);
  const criterion = core.addCriterion(db, 1, 'smoke passes', actor);
  core.setCriterionChecked(db, 1, criterion.id, true, actor);
  db.close();
  const hookEnv = { ...process.env, KDD_DB: dbPath, PLUGIN_DATA: join(temp, 'data') };
  const start = execFileSync(process.execPath, ['hooks/session-start.mjs'], {
    cwd: plugin, env: hookEnv, input: '{}', encoding: 'utf8',
  });
  const startJson = JSON.parse(start);
  if (Object.keys(startJson).length !== 1 || typeof startJson.systemMessage !== 'string') {
    throw new Error(`invalid SessionStart output: ${start}`);
  }
  const diagnostics = join(temp, 'diagnostics');
  const brokenEnv = { ...hookEnv, KDD_DB: plugin, PLUGIN_DATA: diagnostics };
  execFileSync(process.execPath, ['hooks/session-start.mjs'], {
    cwd: plugin, env: brokenEnv, input: '{}', encoding: 'utf8',
  });
  execFileSync(process.execPath, ['hooks/stop.mjs'], {
    cwd: plugin, env: brokenEnv, input: JSON.stringify({ session_id: 'broken', cwd: plugin }), encoding: 'utf8',
  });
  const diagnostic = readFileSync(join(diagnostics, 'kdd-hook-error.log'), 'utf8');
  if (!diagnostic.includes('codex-session-start') || !diagnostic.includes('codex-stop')) {
    throw new Error(`missing Codex hook diagnostics: ${diagnostic}`);
  }
  const stopInput = JSON.stringify({ session_id: 'full-codex-session', cwd: plugin });
  const firstStop = execFileSync(process.execPath, ['hooks/stop.mjs'], {
    cwd: plugin, env: hookEnv, input: stopInput, encoding: 'utf8',
  });
  const stopJson = JSON.parse(firstStop);
  if (stopJson.decision !== 'block' || !stopJson.reason || stopJson.hookSpecificOutput) {
    throw new Error(`invalid Stop output: ${firstStop}`);
  }
  const secondStop = execFileSync(process.execPath, ['hooks/stop.mjs'], {
    cwd: plugin, env: hookEnv, input: stopInput, encoding: 'utf8',
  });
  if (secondStop) throw new Error(`Stop was not deduplicated: ${secondStop}`);
  const overrideActor = { type: 'ai', id: 'tick:override' };
  const overrideDb = core.openDb(dbPath, plugin);
  core.addTask(overrideDb, { title: 'override hook task' }, { type: 'user' });
  core.moveTask(overrideDb, 2, 'in_progress', overrideActor);
  const overrideCriterion = core.addCriterion(overrideDb, 2, 'override smoke passes', overrideActor);
  core.setCriterionChecked(overrideDb, 2, overrideCriterion.id, true, overrideActor);
  overrideDb.close();
  const overrideStop = execFileSync(process.execPath, ['hooks/stop.mjs'], {
    cwd: plugin,
    env: { ...hookEnv, KDD_SESSION: 'tick:override' },
    input: JSON.stringify({ session_id: 'different-codex-session', cwd: plugin }),
    encoding: 'utf8',
  });
  const overrideStopJson = JSON.parse(overrideStop);
  if (overrideStopJson.decision !== 'block' || !overrideStopJson.reason?.includes('#2')) {
    throw new Error(`Stop ignored KDD_SESSION actor: ${overrideStop}`);
  }
  child = spawn(process.execPath, ['runtime/mcp.js'], { cwd: plugin, stdio: ['pipe', 'pipe', 'pipe'] });
  const initialize = await rpc(child, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } },
  });
  if (!initialize.result?.serverInfo?.name) throw new Error(`initialize failed: ${JSON.stringify(initialize)}`);
  const tools = await rpc(child, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  if (tools.result?.tools?.length !== 6) throw new Error(`tools/list failed: ${JSON.stringify(tools)}`);
  console.log(`fresh install SQLite OK; MCP initialize=${initialize.result.serverInfo.name}; tools=${tools.result.tools.length}; Codex hooks valid`);
} finally {
  if (child) await stopChild(child);
  rmSync(temp, { recursive: true, force: true });
}
