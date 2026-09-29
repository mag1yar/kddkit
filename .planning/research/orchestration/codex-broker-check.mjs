// Isolated actual Codex/MCP observations. Calibration SQL never creates production native proof.
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, linkSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from '../../../packages/core/node_modules/better-sqlite3/lib/index.js';
import * as core from '../../../packages/core/dist/index.js';
import { Client } from '../../../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../../../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

const args = process.argv.slice(2);
assert.ok(args.every(arg => ['--calibrate', '--context-only'].includes(arg)) && new Set(args).size === args.length);
const calibrate = args.includes('--calibrate');
const operations = args.includes('--context-only') ? ['get_context'] : ['get_context', 'submit_report', 'request_question'];
const root = realpathSync(mkdtempSync(join(tmpdir(), 'kdd-native-broker-'))), saved = { ...process.env };
let db;
try {
  const home = join(root, 'private'), source = join(root, 'source'), workspace = join(root, 'workspace');
  const scratch = join(root, 'scratch'), controlDir = join(home, 'controller'), configPath = join(controlDir, 'broker.json');
  const backend = join(root, 'backend'), clone = join(root, 'clone');
  for (const path of [source, backend, scratch, controlDir]) mkdirSync(path, { recursive: true });
  const git = (cwd, ...args) => execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  for (const cwd of [source, backend]) {
    git(cwd, 'init', '-q'); git(cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture');
  }
  git(root, 'clone', '--no-hardlinks', '-q', source, clone);
  git(clone, 'worktree', 'add', '-q', '-b', 'fixture', workspace);
  process.env.KDD_HOME = home; delete process.env.KDD_DB; delete process.env.KDD_DECISIONS_DIR;
  const resolved = core.resolveDbPath(source); db = core.openDb(resolved.dbPath, resolved.projectPath, source);
  const user = { type: 'user' }, controller = core.openController(db), repoId = core.projectOf(db).primary_repo_id;
  core.bindRepository(db, db.name, home, { cwd: workspace, repoId, kind: 'managed' }, user);
  const backendId = core.addRepository(db, db.name, home, { cwd: backend, purpose: 'backend', access: 'context_only' }, user).repository.repo_id;
  const parent=core.addTask(db,{title:'Native parent',body:'original requirements'},user);
  const taskRef={projectId:core.projectOf(db).project_id,taskId:parent.id};
  const children=core.createSubtasks(controller,{parent:taskRef,expectedParentHash:core.taskContractHash(controller,taskRef),
    source:{kind:'manual',sourceTask:taskRef,instructionRef:'fixture:owner'},
    children:[{key:'own',title:'Native broker fixture',criteria:['prove scope']},{key:'sibling',title:'Private sibling',criteria:['ready']}]});
  const task=children.own;
  const work=core.createWorkItem(controller,{task:{...taskRef,taskId:task.id},
    definition:{kind:'implementation',repoId,sourceTasks:[],outputs:[]},dependencies:[]});
  const owner=core.reserveWorkItem(controller,{ref:work.ref,expectedRevision:1,expectedFence:0,expectedMode:'manual',ownerId:'fixture',write:true});
  const entryPath = realpathSync(fileURLToPath(new URL('../../../packages/mcp/dist/run_main.js', import.meta.url)));
  const executable = process.env.KDD_CODEX_EXECUTABLE || '/opt/homebrew/bin/codex';
  const repositories = [{ repoId, checkoutPath: workspace, write: true }, { repoId: backendId, checkoutPath: backend, write: false }];
  const nativeInput = { executable, model: 'fixture-codex', cwd: workspace, readableRoots: [workspace, backend],
    writableRoot: workspace, scratchDir: scratch, controlDir, protectedPaths: [source, home, clone] };
  const input = { taskId: task.id, workItemId: work.ref.workItemId, runId: 'fixture-run', expectedGeneration: 0,
    expiresAt: core.now() + 7200, operations, repositories, ownership:owner.ref };
  let issued;
  if (calibrate) {
    // Trusted fixture data only, used to debug the real tool protocol before the full gate.
    core.protectTask(controller, task.id);
    const token = randomBytes(32).toString('hex'), authorityId = randomBytes(16).toString('hex');
    const grant = { projectId: core.projectOf(db).project_id, ...input, generation: 1,
      repositories: repositories.map(repo => ({ repoId: repo.repoId, checkoutPath: repo.checkoutPath,
        commonDir: core.canonicalCommonDir(repo.checkoutPath), write: repo.write })),
      native: { readableRoots: [workspace, backend], writableRoot: workspace, scratchDir: scratch, configHash: 'calibration-only' } };
    db.prepare('INSERT INTO run_authorities(authority_id,task_id,work_item_id,run_id,generation,expires_at,token_hash,grant_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(authorityId, task.id, input.workItemId, input.runId, 1, input.expiresAt, createHash('sha256').update(token).digest('hex'), JSON.stringify(grant), core.now());
    issued = { token, authorityId, generation: 1 };
  } else {
    process.stderr.write('initial native preflight started\n');
    const initial = await core.preflightCodex(nativeInput);
    process.stderr.write(`initial native preflight passed: ${initial.results.length} observations\n`);
    issued = core.issueRunAuthority(controller, { ...input, native: initial });
  }
  const memoryChecks=[];
  if(!calibrate) {
    const canonical=value=>JSON.stringify(order(value));
    function order(value){return Array.isArray(value)?value.map(order):value && typeof value==='object'?
      Object.fromEntries(Object.keys(value).sort().map(key=>[key,order(value[key])])):value;}
    const draft=taskId=>({commandId:`fixture-memory-${taskId}`,entryId:null,expectedRevision:0,
      scope:{projectId:taskRef.projectId,taskId},applicability:{repoId:null,commit:null},kind:'rule',status:'active',
      title:'Fixture policy',body:'Preserve scoped memory',source:{kind:'user',ref:'fixture:explicit instruction'},author:{type:'user',id:null}});
    const own=draft(task.id),{commandId,entryId,expectedRevision,...payload}=own;
    const request={operation:'create',entryId,expectedRevision,origin:'user',scope:own.scope,applicability:own.applicability,
      payloadHash:createHash('sha256').update(canonical(payload)).digest('hex'),source:own.source};
    const receiptPath=join(home,'memory-fixture-receipt.json');
    writeFileSync(receiptPath,JSON.stringify({request,origin:'user',verdict:'pass',observedAt:core.now(),expiresAt:null}),{mode:0o600});
    core.writeMemory(controller,own,{observe:incoming=>{const receipt=JSON.parse(readFileSync(receiptPath,'utf8'));
      return canonical(incoming)===canonical(receipt.request)?receipt:null;}});
    const sibling=core.writeMemory(controller,{...draft(children.sibling.id),kind:'candidate',
      source:{kind:'host',ref:'fixture:proposal'}});
    const context=core.openRunContext(db,issued.token),snapshot=core.readRunContext(context);
    assert.deepEqual(core.readRunMemory(context).map(row=>row.body),['Preserve scoped memory']);
    assert.equal(core.recallRunMemory(context,'memory',{k:1}).length,1);
    assert.equal(core.runMemoryRules(context).length,1);
    assert.deepEqual(core.readRunContext(context),snapshot);memoryChecks.push('memory-own-scope');
    assert.throws(()=>core.readRunMemory(context,{entryId:sibling.entryId,candidates:true}),/unavailable/);
    assert.throws(()=>core.readRunMemory({...context}),/authority/);memoryChecks.push('memory-sibling-refused');
    let proposal;
    if(operations.includes('submit_report')) {
      proposal={...draft(task.id),commandId:'fixture-run-proposal',kind:'candidate',author:{type:'ai',id:input.runId},
        source:{kind:'run',task:{...taskRef,taskId:task.id},authority:{authorityId:issued.authorityId,workItemId:input.workItemId,
          runId:input.runId,generation:issued.generation},reportEventId:core.submitRunReport(context,'Memory candidate')}};
      core.writeMemory(controller,proposal);memoryChecks.push('memory-run-candidate');
      const before=db.prepare("SELECT * FROM events WHERE action LIKE 'memory_%'").all();
      for(const patch of [{scope:{...proposal.scope,taskId:null}},{kind:'rule'},
        {entryId:core.readRunMemory(context)[0].entryId,expectedRevision:1}])assert.throws(()=>core.writeMemory(controller,{...proposal,commandId:'candidate-cannot-publish-policy',...patch}));
      assert.deepEqual(db.prepare("SELECT * FROM events WHERE action LIKE 'memory_%'").all(),before);
      memoryChecks.push('memory-run-policy-refused');
    }else {assert.throws(()=>core.submitRunReport(context,'not granted'),/authority/);memoryChecks.push('memory-report-operation-refused');}
    db.prepare('UPDATE run_authorities SET expires_at=1 WHERE authority_id=?').run(issued.authorityId);
    assert.throws(()=>core.readRunMemory(context),/authority/);
    if(proposal)assert.throws(()=>core.writeMemory(controller,proposal),/authority/);
    db.prepare('UPDATE run_authorities SET expires_at=? WHERE authority_id=?').run(input.expiresAt,issued.authorityId);
    memoryChecks.push('memory-expired-refused');
    core.editTask(db,parent.id,{body:'changed requirements'},user);
    const before=db.prepare("SELECT * FROM events WHERE action LIKE 'memory_%'").all();
    for(const call of [()=>core.readRunMemory(context),()=>core.recallRunMemory(context,'memory'),()=>core.runMemoryRules(context)])assert.throws(call,/authority/);
    if(proposal)assert.throws(()=>core.writeMemory(controller,proposal),/authority/);
    assert.deepEqual(db.prepare("SELECT * FROM events WHERE action LIKE 'memory_%'").all(),before);
    memoryChecks.push('memory-current-inputs-refused');
    core.editTask(db,parent.id,{body:'original requirements'},user);
    assert.equal(core.readRunMemory(context).length,1);
  }
  writeFileSync(configPath, JSON.stringify({ dbPath: db.name, token: issued.token }), { mode: 0o600 });
  core.readRunContext(core.openRunContext(db, issued.token));
  const host = new Client({ name: 'host-control', version: '0' });
  const hostTransport = new StdioClientTransport({ command: process.execPath, args: [entryPath, '--config', configPath], stderr: 'pipe',
    env: { HOME: process.env.HOME, PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin', TMPDIR: scratch } });
  try {
    await host.connect(hostTransport);
    const context = await host.callTool({ name: 'get_context', arguments: {} });
    assert.equal(context.isError, undefined);
    assert.ok(JSON.stringify(context).includes('Native broker fixture'));
  } finally { await host.close(); }
  const binding = { configPath, entryPath, dbPath: db.name, nodePath: realpathSync(process.execPath) };
  if (calibrate) {
    const evidence = await core.observeCodexNative(executable, false, 'fixture-codex', binding, true);
    process.stdout.write(JSON.stringify({ calibrationOnly: true, ...evidence }, null, 2) + '\n');
    if (!evidence.applicable) process.exitCode = 1;
  } else {
    process.stderr.write('bound native preflight started\n');
    const packet = await core.preflightCodex({ ...nativeInput, brokerConfigPath: configPath, brokerEntryPath: entryPath });
    process.stderr.write(`bound native preflight passed: ${packet.results.length} observations\n`);
    core.assertVerifiedCodexPackage(packet);
    const next = core.issueRunAuthority(controller, { ...input, expectedGeneration: 1, runId: 'fixture-final', native: packet });
    const finalContext=core.openRunContext(db,next.token);
    assert.equal(core.readRunMemory(finalContext).length,1);
    await core.withNativeControllerLock(controlDir, () => writeFileSync(configPath, JSON.stringify({ dbPath: db.name, token: next.token })));
    core.assertVerifiedCodexPackage(packet); // Public binding stays fixed across private credential rotation.
    assert.throws(() => core.openRunContext(db, issued.token), /authority/);
    process.stderr.write('final native broker matrix started\n');
    const final = await core.observeCodexNative(executable, false, 'fixture-codex', binding, true);
    process.stderr.write(`final native broker matrix: ${final.executed}/${final.attempted}, applicable=${final.applicable}\n`);
    assert.equal(final.applicable, true);
    assert.throws(() => core.openRunContext(db, next.token), /authority/); // Actual native live-revoke case revoked it.
    for(const call of [()=>core.readRunMemory(finalContext),()=>core.recallRunMemory(finalContext,'memory'),()=>core.runMemoryRules(finalContext)])assert.throws(call,/authority/);
    memoryChecks.push('memory-live-revoke-refused');
    const exposedPath = join(scratch, 'exposed.db');
    await core.withNativeControllerLock(controlDir, () => db.backup(exposedPath));
    const exposed = new Database(exposedPath);
    try {
      const own = core.addTask(exposed, { title: 'Scratch store must refuse authority' }, user);
      const {ownership,...scratchInput}=input;
      const before = ['managed_task_policy', 'run_authorities', 'events'].map(table => exposed.prepare(`SELECT * FROM ${table}`).all());
      assert.throws(() => core.issueRunAuthority(core.openController(exposed), { ...scratchInput, taskId: own.id, workItemId:'scratch-work', native: packet }), /store|scope/);
      assert.deepEqual(['managed_task_policy', 'run_authorities', 'events'].map(table => exposed.prepare(`SELECT * FROM ${table}`).all()), before);
    } finally { exposed.close(); for (const path of [exposedPath, `${exposedPath}-wal`, `${exposedPath}-shm`]) rmSync(path, { force: true }); }
    assert.throws(() => core.assertVerifiedCodexPackage(JSON.parse(JSON.stringify(packet))), /unverified/);
    const otherDb = join(controlDir, 'other.db'); writeFileSync(otherDb, 'fixture');
    writeFileSync(configPath, JSON.stringify({ dbPath: otherDb, token: next.token }));
    assert.throws(() => core.assertVerifiedCodexPackage(packet), /binding/);
    writeFileSync(configPath, JSON.stringify({ dbPath: db.name, token: next.token }));
    core.assertVerifiedCodexPackage(packet);
    const launch = { controlDir, writableRoots: [scratch, workspace], executable: packet.executable, cwd: workspace,
      args: [...packet.argv, 'fixture'], env: packet.env, phase: 'start', verified: packet };
    await assert.rejects(core.spawnCheckedNative({ ...launch, args: [...packet.argv.slice(0, -1), '--sandbox', 'danger-full-access', '--', 'fixture'] }), /differs/);
    linkSync(configPath, join(scratch, 'late-private-alias'));
    await assert.rejects(core.spawnCheckedNative({ ...launch, phase: 'resume' }), /binding|hardlink/);
    rmSync(join(scratch, 'late-private-alias')); core.assertVerifiedCodexPackage(packet);
    const pointer = join(git(workspace, 'rev-parse', '--absolute-git-dir'), 'commondir'), original = readFileSync(pointer);
    const replacement = join(workspace, 'replacement-common');
    await core.withNativeControllerLock(controlDir, () => {
      cpSync(git(workspace, 'rev-parse', '--path-format=absolute', '--git-common-dir'), replacement, { recursive: true });
      writeFileSync(pointer, replacement + '\n');
    });
    // The real packet must fail before either native child can start.
    assert.throws(() => core.assertVerifiedCodexPackage(packet), /binding/);
    for (const phase of ['start', 'resume']) await assert.rejects(core.spawnCheckedNative({ ...launch, phase }), /binding/);
    await core.withNativeControllerLock(controlDir, () => { writeFileSync(pointer, original); rmSync(replacement, { recursive: true }); });
    core.assertVerifiedCodexPackage(packet);
    process.stdout.write(JSON.stringify({ version: packet.version, configHash: packet.configHash,
      checks: ['actual-package', 'generation-2', 'private-token-rotation', 'old-token-refused', 'final-native-broker', 'live-revoke-refused',
        'json-copy-refused', 'public-broker-binding-change-refused', 'legacy-sandbox-override-refused', 'late-private-alias-resume-refused',
        'git-common-dir-start-resume-refused', 'scratch-store-issue-refused-before-marker',...memoryChecks],
      memoryEvidence:'core library calls with genuine production-issued credential; fixture user receipt, no new MCP tools',
      results: packet.results, final }, null, 2) + '\n');
  }
} finally { db?.close(); process.env = saved; rmSync(root, { recursive: true, force: true }); }
