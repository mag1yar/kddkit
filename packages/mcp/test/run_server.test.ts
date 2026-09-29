import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import * as core from '../../core/src/index.js';
import { createRunServer, startRunServer } from '../src/run_server.js';

// Exercise real DB authority over SDK transport; native proof is checked separately on macOS.
vi.mock('@kddkit/core', () => import('../../core/src/index.js'));
const proved = vi.hoisted(() => new WeakSet<object>());
vi.mock('../../core/src/codex_permissions.js', async original => ({
  ...await original<typeof import('../../core/src/codex_permissions.js')>(),
  assertVerifiedCodexPackage(packet: object) { if (!proved.has(packet)) throw new Error('unverified'); },
}));
let root: string, db: ReturnType<typeof core.openDb>, input: core.IssueRunInput, saved: NodeJS.ProcessEnv;
const clients: Client[] = [];
const user = { type: 'user' } as const;
beforeEach(() => {
  saved = { ...process.env }; root = realpathSync(mkdtempSync(join(tmpdir(), 'kdd-run-mcp-')));
  process.env.KDD_HOME = join(root, 'home'); delete process.env.KDD_DB; delete process.env.KDD_DECISIONS_DIR;
  const source = join(root, 'source'), workspace = join(root, 'workspace'); mkdirSync(source);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  git(source, 'init', '-q'); git(source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture');
  git(root, 'clone', '--no-hardlinks', '-q', source, workspace);
  mkdirSync(join(root, 'scratch'));
  const resolved = core.resolveDbPath(source); db = core.openDb(resolved.dbPath, resolved.projectPath, source);
  const repoId = core.projectOf(db).primary_repo_id!;
  core.bindRepository(db, db.name, process.env.KDD_HOME, { cwd: workspace, repoId, kind: 'managed' }, user);
  const native: core.VerifiedCodexPackage = { executable: '/fixture/codex', version: 'fixture', cwd: workspace,
    controlDir: join(root, 'home'), readableRoots: [workspace], writableRoot: workspace, scratchDir: join(root, 'scratch'),
    protectedPaths: [join(root, 'home')], argv: [], env: {}, results: [], configHash: 'fixture' }; proved.add(native);
  input = { taskId: core.addTask(db, { title: 'own context', criteria: ['proof'] }, user).id,
    workItemId: 'work', runId: 'run', expectedGeneration: 0, expiresAt: core.now() + 60,
    operations: ['get_context', 'submit_report', 'request_question'], repositories: [{ repoId, checkoutPath: workspace, write: true }], native };
});
afterEach(async () => { for (const client of clients.splice(0)) await client.close(); db.close(); process.env = saved; rmSync(root, { recursive: true, force: true }); });
async function connect(operations = input.operations) {
  const controller = core.openController(db), issued = core.issueRunAuthority(controller, { ...input, operations });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await createRunServer(core.openRunContext(db, issued.token)).connect(serverT);
  const client = new Client({ name: 'scope-test', version: '0' }); clients.push(client); await client.connect(clientT);
  return { client, controller, issued };
}
it('advertises exactly the granted tools and rejects forged inputs and global methods', async () => {
  const { client } = await connect();
  expect((await client.listTools()).tools.map(t => t.name).sort()).toEqual(['get_context', 'request_question', 'submit_report']);
  const snapshot = await client.callTool({ name: 'get_context', arguments: {} });
  expect(snapshot.isError).not.toBe(true); expect(JSON.stringify(snapshot)).toContain('own context');
  const before = db.prepare('SELECT * FROM events').all();
  for (const [name, args] of [
    ['get_context', { id: input.taskId + 1 }], ['get_context', { project: root }],
    ['submit_report', { body: 'forged', actor: 'user' }], ['request_question', { body: 'q', owner: true }],
    ['submit_report', { body: { nested: 'data' } }], ['update_task', { id: input.taskId, comment: 'bypass' }],
  ] as const) expect((await client.callTool({ name, arguments: args })).isError).toBe(true);
  expect(db.prepare('SELECT * FROM events').all()).toEqual(before);
});
it('revalidates credentials after initialize and two-connection revocation', async () => {
  const { client, issued } = await connect();
  const taskBefore = core.mustGetTask(db, input.taskId);
  expect((await client.callTool({ name: 'submit_report', arguments: { body: `result ${issued.token}` } })).isError).not.toBe(true);
  expect(core.mustGetTask(db, input.taskId)).toEqual(taskBefore);
  expect(JSON.stringify(db.prepare('SELECT detail FROM events').all())).not.toContain(issued.token);
  const other = core.openDb(db.name);
  try { core.revokeRunAuthority(core.openController(other), issued.authorityId); } finally { other.close(); }
  const before = db.prepare('SELECT * FROM events').all();
  for (const name of ['get_context', 'submit_report', 'request_question']) {
    const result = await client.callTool({ name, arguments: name === 'get_context' ? {} : { body: 'late' } });
    expect(result.isError).toBe(true); expect(JSON.stringify(result)).not.toContain(issued.token);
  }
  expect(db.prepare('SELECT * FROM events').all()).toEqual(before);
});
it('hides missing operations and refuses direct calls to them', async () => {
  const { client } = await connect(['get_context']);
  expect((await client.listTools()).tools.map(t => t.name)).toEqual(['get_context']);
  expect((await client.callTool({ name: 'submit_report', arguments: { body: 'hidden' } })).isError).toBe(true);
});
it('starts the built scoped broker on the current schema without migration', async () => {
  const issued = core.issueRunAuthority(core.openController(db), { ...input, operations: ['get_context'] });
  const path = join(root, 'current-broker.json');
  writeFileSync(path, JSON.stringify({ dbPath: db.name, token: issued.token }), { mode: 0o600 });
  const client = new Client({ name: 'current-schema', version: '0' }); clients.push(client);
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../dist/run_main.js', import.meta.url)), '--config', path],
    env: { ...process.env } as Record<string, string>, stderr: 'pipe' }));
  expect((await client.listTools()).tools.map(t => t.name)).toEqual(['get_context']);
  expect((await client.callTool({ name: 'get_context', arguments: {} })).isError).not.toBe(true);
  expect(db.pragma('user_version', { simple: true })).toBe(core.MIGRATIONS.length);
  await client.close();
  try {
    for (const version of [core.MIGRATIONS.length - 1, core.MIGRATIONS.length + 1]) {
      db.pragma(`user_version=${version}`);
      const denied = new Client({ name: 'wrong-schema', version: '0' }); clients.push(denied);
      await expect(denied.connect(new StdioClientTransport({ command: process.execPath,
        args: [fileURLToPath(new URL('../dist/run_main.js', import.meta.url)), '--config', path],
        env: { ...process.env } as Record<string, string>, stderr: 'pipe' }))).rejects.toThrow(/Connection closed/);
      expect(db.pragma('user_version', { simple: true })).toBe(version);
    }
  } finally { db.pragma(`user_version=${core.MIGRATIONS.length}`); }
});
it('refuses unsafe startup configs without exposing credentials or migrating the store', async () => {
  const path = join(root, 'broker.json'), token = 'a'.repeat(64);
  for (const config of [
    { dbPath: db.name, token, project: root }, { dbPath: 'relative', token }, { dbPath: db.name, token: 'bad' },
  ]) {
    writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
    await expect(startRunServer(path)).rejects.toThrow(/^run broker startup denied$/);
  }
  writeFileSync(path, JSON.stringify({ dbPath: db.name, token })); chmodSync(path, 0o644);
  await expect(startRunServer(path)).rejects.toThrow(/^run broker startup denied$/);
  chmodSync(path, 0o600); db.pragma('user_version=13');
  await expect(startRunServer(path)).rejects.toThrow(/^run broker startup denied$/);
  expect(db.pragma('user_version', { simple: true })).toBe(13);
});
it('keeps modeled ownership private from scoped MCP and reports untrusted',async()=>{
  const handle=core.openController(db),task={projectId:core.projectOf(db).project_id,taskId:input.taskId};
  const item=core.createWorkItem(handle,{task,definition:{kind:'implementation',repoId:input.repositories[0].repoId,sourceTasks:[],outputs:[]},dependencies:[]});
  const owner=core.reserveWorkItem(handle,{ref:item.ref,expectedRevision:1,expectedFence:0,expectedMode:'manual',ownerId:'host',write:true});
  input={...input,workItemId:item.ref.workItemId,ownership:owner.ref};
  const {client}=await connect();
  expect((await client.listTools()).tools.map(t=>t.name).sort()).toEqual(['get_context','request_question','submit_report']);
  const before=db.prepare('SELECT * FROM events').all();
  for(const name of ['create_subtasks','publish_result','reserve_work_item','begin_handoff']) {
    expect((await client.callTool({name,arguments:{verified:true,actor:'user'}})).isError).toBe(true);
  }
  expect(db.prepare('SELECT * FROM events').all()).toEqual(before);
  expect((await client.callTool({name:'submit_report',arguments:{body:'{"verified":true,"completed":true}'}})).isError).not.toBe(true);
  expect(db.prepare('SELECT count(*) n FROM work_item_results').get()).toEqual({n:0});
  expect(core.workItem(handle,item.ref).state).toBe('pending');
  expect(core.ownership(handle,owner.ref).releasedAt).toBeNull();
});
it('returns byte-identical saved inputs over MCP after reopen and refuses stale input reads',async()=>{
  const {client,controller,issued}=await connect(['get_context']);
  const first=await client.callTool({name:'get_context',arguments:{}}),content=first.content as {type:string;text:string}[];
  const payload=JSON.parse(content[0].text),ref={projectId:core.projectOf(db).project_id,authorityId:issued.authorityId};
  expect(payload.inputs.inputHash).toBe(core.runInputSnapshot(controller,ref).inputHash);
  const other=core.openDb(db.name);
  try{expect(core.readRunContext(core.openRunContext(other,issued.token))).toEqual(payload);}finally{other.close();}
  db.prepare("UPDATE tasks SET status='in_progress' WHERE id=?").run(input.taskId);
  db.prepare('UPDATE criteria SET checked_at=1 WHERE task_id=?').run(input.taskId);
  expect(await client.callTool({name:'get_context',arguments:{}})).toEqual(first);
  expect(JSON.stringify(first)).not.toContain(input.native.scratchDir);
  expect(JSON.stringify(first)).not.toContain(issued.token);
  db.prepare('UPDATE tasks SET body=? WHERE id=?').run('changed',input.taskId);
  expect((await client.callTool({name:'get_context',arguments:{}})).isError).toBe(true);
  expect(core.runInputSnapshot(controller,ref).response).toEqual(payload);
  expect(core.checkRunInputs(controller,ref).status).toBe('update_required');
});
