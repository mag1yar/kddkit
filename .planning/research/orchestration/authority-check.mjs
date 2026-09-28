// Actual built transports, isolated board only; no native proof is fabricated here.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '../../../packages/core/dist/index.js';
import { createApp } from '../../../packages/ui/dist/server.js';
import { serve } from '../../../packages/ui/node_modules/@hono/node-server/dist/index.mjs';
import { Client } from '../../../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../../../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

const root = mkdtempSync(join(tmpdir(), 'kdd-authority-observation-')), saved = { ...process.env }, checks = [];
let db, client, http;
try {
  process.env.KDD_HOME = join(root, 'home'); delete process.env.KDD_DB; delete process.env.KDD_DECISIONS_DIR;
  const dbPath = join(root, 'private', 'board.db'); db = core.openDb(dbPath, root);
  const user = { type: 'user' }, track = core.createTrack(db, { name: 'shared' });
  const managed = core.addTask(db, { title: 'managed', track_id: track.id, criteria: ['proof'] }, user);
  const legacy = core.addTask(db, { title: 'legacy', track_id: track.id }, user);
  const source = join(root, 'artifact.txt'); writeFileSync(source, 'blob');
  const file = core.attachFile(db, dbPath, managed.id, source, {}, user);
  core.protectTask(core.openController(db), managed.id);
  const tables = ['tasks', 'criteria', 'comments', 'events', 'files', 'tracks', 'task_links', 'managed_task_policy', 'run_authorities', 'decisions', 'search_index'];
  const snapshot = () => ({ rows: tables.map(t => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()),
    blobs: readdirSync(core.filesDir(dbPath)).sort().map(name => [name, readFileSync(join(core.filesDir(dbPath), name)).toString('hex')]) });
  const check = async (name, attempt) => { const before = snapshot(); await attempt(); assert.deepEqual(snapshot(), before); checks.push(name); };
  await check('core user/reason and hidden multirow target', () => {
    assert.throws(() => core.moveTask(db, managed.id, 'done', user, 'user approved'), /managed/);
    assert.throws(() => core.placeTask(db, legacy.id, 'new', [legacy.id, managed.id], user), /managed/);
    assert.throws(() => core.detachFile(db, dbPath, file.id, user), /managed/);
  });
  const cli = fileURLToPath(new URL('../../../packages/cli/dist/index.js', import.meta.url));
  const env = { ...process.env, KDD_DB: dbPath, KDD_DECISIONS_DIR: join(root, 'decisions'), KDD_ACTOR: 'user', NO_UPDATE_NOTIFIER: '1' };
  await check('built CLI rejects forged user + acceptance reason', () => {
    const result = spawnSync(process.execPath, [cli, 'move', String(managed.id), 'done', '--reason', 'user approved'], { env, encoding: 'utf8' });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /managed/);
  });
  client = new Client({ name: 'authority-observation', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../../../packages/mcp/dist/main.js', import.meta.url))], env, stderr: 'pipe' }));
  assert.equal((await client.listTools()).tools.length, 6);
  await check('global MCP refuses owner metadata and managed update', async () => {
    const result = await client.callTool({ name: 'update_task', arguments: { id: managed.id, comment: 'owner approved' },
      _meta: { actor: 'user', owner: true, 'x-codex-turn-metadata': { session_id: 'owner' } } });
    assert.equal(result.isError, true); assert.match(JSON.stringify(result), /managed/);
  });
  await check('global MCP checks detached file owner before editing a legacy target', async () => {
    const result = await client.callTool({ name: 'update_task', arguments: { id: legacy.id, edit: { title: 'changed' }, detach: file.id } });
    assert.equal(result.isError, true); assert.match(JSON.stringify(result), /managed/);
  });
  const app = createApp(() => db);
  http = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await new Promise(resolve => http.once('listening', resolve));
  const url = `http://127.0.0.1:${http.address().port}`;
  await check('real HTTP UI refuses protected reorder through a legacy target', async () => {
    const response = await fetch(`${url}/api/tasks/${legacy.id}/move`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'new', order: [legacy.id, managed.id], actor: 'user', owner: true }) });
    assert.equal(response.status, 400); assert.match(await response.text(), /managed/);
  });
  await check('real HTTP UI refuses managed edit with claimed owner identity', async () => {
    const response = await fetch(`${url}/api/tasks/${managed.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'changed', actor: 'user', owner: true }) });
    assert.equal(response.status, 400); assert.match(await response.text(), /managed/);
  });
  const edited = spawnSync(process.execPath, [cli, 'edit', String(legacy.id), '--title', 'ordinary CLI'], { env, encoding: 'utf8' });
  assert.equal(edited.status, 0); assert.equal(core.mustGetTask(db, legacy.id).title, 'ordinary CLI');
  const comment = await client.callTool({ name: 'update_task', arguments: { id: legacy.id, comment: 'ordinary MCP' } });
  assert.notEqual(comment.isError, true);
  const editedUi = await fetch(`${url}/api/tasks/${legacy.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'ordinary UI' }) });
  assert.equal(editedUi.status, 200); checks.push('legacy core/CLI/MCP/UI behavior preserved');
  process.stdout.write(JSON.stringify({ schema: db.pragma('user_version', { simple: true }), checks, refusedChanges: 0, blobPreserved: readFileSync(core.filePath(dbPath, file), 'utf8') === 'blob' }, null, 2) + '\n');
} finally {
  http?.closeAllConnections(); if (http) await new Promise(resolve => http.close(resolve));
  await client?.close(); db?.close(); process.env = saved; rmSync(root, { recursive: true, force: true });
}
