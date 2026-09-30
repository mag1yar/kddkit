// Actual Codex tools; the local provider replaces model responses only.
import assert from 'node:assert/strict';
import { spawn, execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync, linkSync, symlinkSync, lstatSync, readdirSync, readlinkSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import { tmpdir, networkInterfaces } from 'node:os';
import { createServer as createSocketServer, type Server as SocketServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import * as zlib from 'node:zlib';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { openController, revokeRunAuthority, openRunContext, runOperations, type RunOperation } from './authority.js';
import { assertWritableRoots, spawnCheckedNative, withNativeControllerLock, fixedCodexConfig, fixedCodexArguments, closedCodexCatalog, type NativeProbeResult, type CodexBrokerBinding } from './codex_permissions.js';


interface NativeTool { name?: string; type: string; namespace?: string; tools?: NativeTool[] }
interface ProbeInput { type: string; call_id?: string; tools?: NativeTool[]; output?: unknown }
interface NativeCase {
  id: string; tool: 'exec_command' | 'apply_patch' | 'get_context' | 'submit_report' | 'request_question' | 'read_skill_file' | 'list_mcp_resources' | 'list_mcp_resource_templates' | 'read_mcp_resource'; command?: string; patch?: string;
  payload?: Record<string, unknown>; revoke?: boolean; unavailable?: boolean;
  controlRoot?: string; phase?: 'start' | 'resume'; failureCode?: number; matchedControl?: NativeObservation;
}
export interface NativeObservation extends NativeProbeResult {
  mode: 'readonly' | 'workspace'; control: boolean; phase: 'start' | 'resume';
  exitCode: number | null; output: unknown; timedOut: boolean; providerError?: string;
  requests: unknown[]; tools: NativeTool[]; permissionHash: string; configHash: string;
  firstRequestBytes: number;
  challengeHash?: string; protectedHashes: { path: string; before: string; after: string }[];
  diagnostic?: string; failure?: string; matchedControl?: string;
}
interface NativeFailure { caseId?: string; mode?: string; reason?: string; failure?: string }
interface NativeRefusal { caseId: string; phase: 'start' | 'resume'; outcome: 'denied'; executed: false }
interface NetworkControl { caseId: string; role: string; exitCode: number; commandHash: string; output: string }
export function brokerOperationNames(binding: CodexBrokerBinding): readonly RunOperation[] {
  const db = new Database(binding.dbPath, { fileMustExist: true });
  try { return runOperations(openRunContext(db, JSON.parse(readFileSync(binding.configPath, 'utf8')).token)); }
  finally { db.close(); }
}
export interface NativeEvidence {
  version: string; model: string; executableHash: string; scriptHash: string; guardHash: string;
  applicable: boolean; rawDiagnostic: boolean; preflight: NativeRefusal[]; networkControls: NetworkControl[];
  attempted: number; executed: number; failures: NativeFailure[]; observations: NativeObservation[];
  operations: readonly RunOperation[];
}

/** Actual Codex tools; the deterministic provider supplies model responses only. */
export async function observeCodexNative(executablePath: string, rawDiagnostic = false, model = 'fixture-codex', broker?: CodexBrokerBinding, brokerOnly = false): Promise<NativeEvidence> {
  const executable = realpathSync(executablePath);
  const version = execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim();
  assert.equal(version, 'codex-cli 0.159.0');
  assert.equal(process.platform, 'darwin');
  const executableHash = createHash('sha256').update(readFileSync(executable)).digest('hex');
  const scriptHash = createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
  const guardHash = scriptHash;
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kdd-native-')));
  const observations: NativeObservation[] = [];
  const failures: NativeFailure[] = [];
  const preflight: NativeRefusal[] = [];
  const networkControls: NetworkControl[] = [];
  let tcpServer: HttpServer | undefined; let unixServer: SocketServer | undefined;
  let brokerDb: Database.Database | undefined;
  let operations: readonly RunOperation[] = [];
  let brokerSkill = 'Probe';
  const brokerPayload = (operation: RunOperation, body: string) => {
    if (operation === 'get_context') return {};
    if (operation === 'read_skill_file') return { skill: brokerSkill, path: 'SKILL.md', offset: 0 };
    return { body };
  };
  try {
  if (broker) {
    const original = new Database(broker.dbPath, { fileMustExist: true });
    const probeDbPath = join(root, 'broker.db');
    try { await original.backup(probeDbPath); }
    finally { original.close(); }
    const probeConfigPath = join(root, 'broker.json');
    writeFileSync(probeConfigPath, JSON.stringify({ dbPath: probeDbPath,
      token: JSON.parse(readFileSync(broker.configPath, 'utf8')).token }), { mode: 0o600 });
    broker = { ...broker, dbPath: probeDbPath, configPath: probeConfigPath };
    brokerDb = new Database(broker.dbPath, { fileMustExist: true });
    const token = JSON.parse(readFileSync(broker.configPath, 'utf8')).token as string;
    operations = runOperations(openRunContext(brokerDb, token));
    const pin = brokerDb.prepare(`SELECT json_extract(grant_json,'$.role.roleId') role_id,
      json_extract(grant_json,'$.role.revision') revision FROM run_authorities WHERE token_hash=?`)
      .get(createHash('sha256').update(token).digest('hex')) as { role_id: string; revision: number } | undefined;
    const selected = pin && brokerDb.prepare(`SELECT skill_name FROM role_skill_files WHERE role_id=? AND revision=?
      AND relative_path='SKILL.md' ORDER BY skill_name LIMIT 1`).get(pin.role_id, pin.revision) as { skill_name: string } | undefined;
    if (selected) brokerSkill = selected.skill_name;
  }
  const workspace = join(root, 'workspace');
  const scratch = join(root, 'scratch');
  const protectedDir = join(root, 'protected');
  const source = join(root, 'source'); const sibling = join(root, 'sibling'); const clone = join(root, 'clone');
  for (const path of [scratch, protectedDir, source, sibling]) mkdirSync(path);
  writeFileSync(join(protectedDir, 'marker.txt'), 'private-fixture\n');
  for (const name of ['store.db', 'registry.db', 'config.toml', 'credential.json']) writeFileSync(join(protectedDir, name), 'private-fixture\n');
  writeFileSync(join(sibling, 'marker.txt'), 'private-fixture\n');
  const controlDir = join(protectedDir, 'controller'); mkdirSync(controlDir);
  const backend = join(root, 'backend');
  mkdirSync(backend); writeFileSync(join(backend, 'marker.txt'), 'backend-original\n');
  const git = (cwd: string, ...args: string[]) => execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  writeFileSync(join(source, 'existing.txt'), 'original\n');
  git(source, 'init', '-q'); git(source, 'add', 'existing.txt');
  git(source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'seed');
  git(root, 'clone', '--no-hardlinks', '-q', source, clone);
  git(clone, 'worktree', 'add', '-q', '-b', 'fixture-worktree', workspace);
  mkdirSync(join(workspace, '.codex'));
  const gitDir = git(workspace, 'rev-parse', '--absolute-git-dir');
  const commonDir = git(workspace, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const foreign = join(backend, 'marker.txt');
  if (rawDiagnostic) linkSync(foreign, join(workspace, 'hardlink.txt'));
  symlinkSync(foreign, join(workspace, 'symlink.txt'));
  const catalogPath = join(root, 'model-catalog.json');
  writeFileSync(catalogPath, closedCodexCatalog(model));
  let tcpRequests = 0; let unixRequests = 0;
  tcpServer = createServer((req, res) => { tcpRequests++; res.end('ack'); });
  await new Promise<void>(resolve => tcpServer!.listen(0, '0.0.0.0', resolve));
  const tcpPort = (tcpServer.address() as AddressInfo).port;
  const socketPath = join(scratch, 'listener.sock');
  unixServer = createSocketServer(socket => socket.once('data', () => { unixRequests++; socket.end('ack'); }));
  await new Promise<void>(resolve => unixServer!.listen(socketPath, resolve));
  const lanAddress = Object.values(networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal)?.address;
  let tcpBaseline = 0; let unixBaseline = 0;
  const networkCases = [
    ...[['loopback','127.0.0.1'], ...(lanAddress ? [['lan', lanAddress]] : [])].map(([name, host]) => ({
      id: `network-${name}`, command: `/usr/bin/curl --disable --max-time 2 --silent --show-error -d native http://${host}:${tcpPort}/attempt`, failureCode: 7,
    })),
    { id: 'network-unix', command: `/bin/sh -c "echo native | /usr/bin/nc -U -w 1 '${socketPath}'"`, failureCode: 1 },
  ];
  async function checkNetworkControls() {
    for (const testCase of networkCases) {
      const output = await new Promise<string>((resolve, reject) => execFile('/bin/sh', ['-c', testCase.command],
        { timeout: 4000, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: scratch, LANG: 'en_US.UTF-8' } },
        (error, stdout) => error ? reject(error) : resolve(stdout)));
      assert.equal(String(output).trim(), 'ack');
      networkControls.push({ caseId: testCase.id, role: 'host-control', exitCode: 0, commandHash: digest(testCase.command), output });
    }
    assert.equal(tcpRequests, lanAddress ? 2 : 1); assert.equal(unixRequests, 1);
    tcpBaseline = tcpRequests; unixBaseline = unixRequests;
  }

  const sse = (type: string, fields: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
  function findTool(tools: NativeTool[] | undefined, name: string, namespace?: string): NativeTool | undefined {
    for (const tool of tools ?? []) {
      if (tool.name === name && ['function', 'custom'].includes(tool.type)) return { ...tool, namespace };
      const found = findTool(tool.tools, name, tool.type === 'namespace' ? tool.name : namespace);
      if (found) return found;
    }
  }
  async function runCase(testCase: NativeCase, writable: boolean): Promise<NativeObservation> {
    let calls = 0;
    let output: unknown;
    let registry: NativeTool[] | undefined;
    let providerError: string | undefined;
    let firstRequestBytes = 0;
    const requests: unknown[] = [];
    const server = createServer(async (req, res) => {
      try {
        if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        let bytes = Buffer.concat(chunks);
        if (req.headers['content-encoding'] === 'zstd') {
          if (typeof zlib.zstdDecompressSync !== 'function') throw new Error('native fixture zstd unavailable');
          bytes = zlib.zstdDecompressSync(bytes);
        }
        const body = JSON.parse(bytes.toString()) as { tools?: NativeTool[]; input?: ProbeInput[] };
        if (calls === 0) firstRequestBytes = bytes.length;
        requests.push({ path: req.url, keys: Object.keys(body), tools: body.tools?.map(t => ({ type: t.type, name: t.name })), input: body.input?.map(i => ({ type: i.type, call_id: i.call_id, keys: i.type === 'additional_tools' ? Object.keys(i) : undefined })) });
        const callId = 'probe_call';
        if (calls++ === 0) {
          registry = body.tools ?? body.input?.find(item => item.type === 'additional_tools')?.tools;
          const mcp = ['get_context', 'submit_report', 'request_question', 'read_skill_file'].includes(testCase.tool);
          let tool = findTool(registry, testCase.tool);
          if (testCase.unavailable) {
            if (tool) throw new Error(`ungranted native tool advertised: ${testCase.tool}`);
            tool = { name: testCase.tool, type: 'function', namespace: 'mcp__kdd_run' };
          }
          if (!tool) throw new Error(`native tool missing: ${testCase.tool}`);
          if (mcp && tool.namespace !== 'mcp__kdd_run') throw new Error('unexpected MCP namespace');
          if (testCase.revoke) {
            const token = JSON.parse(readFileSync(broker!.configPath, 'utf8')).token as string;
            const authority = brokerDb!.prepare('SELECT authority_id FROM run_authorities WHERE token_hash=?').get(digest(token)) as { authority_id: string };
            revokeRunAuthority(openController(brokerDb!), authority.authority_id);
          }
          const item: Record<string, unknown> = tool.type === 'custom'
            ? { type: 'custom_tool_call', id: 'probe_item', call_id: callId, name: tool.name, input: testCase.patch }
            : { type: 'function_call', id: 'probe_item', call_id: callId, name: tool.name,
                arguments: JSON.stringify(mcp || /mcp_resource/.test(testCase.tool) ? testCase.payload ?? {} : testCase.tool === 'apply_patch' ? { patch: testCase.patch } : { cmd: testCase.command, max_output_tokens: 1000 }) };
          if (tool.namespace) item.namespace = tool.namespace;
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(sse('response.created', { response: { id: 'probe_response' } }));
          res.write(sse('response.output_item.done', { item }));
          const items = [item];
          if (testCase.revoke) {
            for (const operation of operations.filter(operation => operation !== testCase.tool)) {
              const granted = findTool(registry, operation);
              if (!granted) throw new Error(`native tool missing: ${operation}`);
              const second = { type: 'function_call', id: `probe_${operation}`, call_id: `probe_${operation}`, name: granted.name,
                ...(granted.namespace ? { namespace: granted.namespace } : {}),
                arguments: JSON.stringify(brokerPayload(operation, 'late proposal')) };
              items.push(second); res.write(sse('response.output_item.done', { item: second }));
            }
          }
          res.end(sse('response.completed', { response: { id: 'probe_response', output: items } }));
        } else {
          output = body.input?.find(item => item.call_id === callId && /call_output$/.test(item.type))?.output;
          if (output === undefined) throw new Error('actual native call output missing');
          if (testCase.revoke) {
            output = Object.fromEntries(operations.map(operation => {
              const id = operation === testCase.tool ? callId : `probe_${operation}`;
              const value = body.input?.find(item => item.call_id === id && /call_output$/.test(item.type))?.output;
              if (value === undefined) throw new Error(`actual revoked ${operation} output missing`);
              return [operation, value];
            }));
          }
          const item = { type: 'message', id: 'final', role: 'assistant', content: [{ type: 'output_text', text: 'Probe complete.' }] };
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(sse('response.output_item.done', { item }));
          res.end(sse('response.completed', { response: { id: 'final_response', output: [item] } }));
        }
      } catch (error) { providerError ??= (error as Error).message; res.writeHead(500); res.end('Fixture protocol error'); child.kill('SIGKILL'); }
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const filesystem: Record<string, 'read' | 'write' | 'deny'> = { ':minimal': 'read', [workspace]: writable ? 'write' : 'read', [scratch]: 'write', [backend]: 'read', [source]: 'deny', [sibling]: 'deny', [clone]: 'deny', [protectedDir]: 'deny', [join(workspace, '.git')]: 'read', [commonDir]: 'read', [gitDir]: 'read', [catalogPath]: 'deny', [join(workspace, '.codex')]: 'read' };
    if (broker) for (const path of [broker.configPath, broker.entryPath, broker.dbPath, `${broker.dbPath}-wal`, `${broker.dbPath}-shm`]) filesystem[path] = 'deny';
    // Positive controls are separate fixture policies, never candidates for a managed run.
    if (testCase.controlRoot) filesystem[testCase.controlRoot] = 'write';
    const config = [
      ...fixedCodexConfig(filesystem, catalogPath, broker, undefined, broker ? operations : undefined),
      // Only the model response service changes; native tools use the shared production policy.
      `openai_base_url=${JSON.stringify(`http://127.0.0.1:${port}/v1`)}`,
    ];
    const args = [...fixedCodexArguments(workspace, model, config), 'Execute the supplied fixture tool call.'];
    let stdout = ''; let stderr = ''; let timedOut = false;
    // Only the deterministic model service uses this public fixture key/URL; native shell inherits none.
    const env = { HOME: process.env.HOME ?? '', PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin', TMPDIR: scratch, LANG: 'en_US.UTF-8',
      CODEX_API_KEY: 'fixture-preflight-not-a-secret' };
    let child: ChildProcess;
    try {
      child = rawDiagnostic
        ? spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'] }) // Intentional raw reproduction of the old failure.
        : await spawnCheckedNative({ controlDir, executable, args, env, cwd: workspace,
            writableRoots: [scratch, ...(writable ? [workspace] : []), ...(testCase.controlRoot ? [testCase.controlRoot] : [])],
            phase: testCase.phase ?? 'start' });
    } catch (error) {
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); throw error;
    }
    child.stdout!.on('data', data => stdout += data);
    child.stderr!.on('data', data => stderr += data);
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 20000);
    try {
      const exitCode = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      const observation: NativeObservation = { tools: [], protectedHashes: [], outcome: 'inconclusive', unchangedProtectedBytes: true, caseId: testCase.id, mode: writable ? 'workspace' : 'readonly', tool: testCase.tool, exitCode,
        control: !!testCase.controlRoot, phase: testCase.phase ?? 'start',
        executed: output !== undefined, timedOut, providerError, output, requests,
        firstRequestBytes,
        permissionHash: createHash('sha256').update(JSON.stringify({ executableHash, version, model, filesystem, config })).digest('hex'),
        configHash: createHash('sha256').update(JSON.stringify({ executableHash, version, filesystem, config })).digest('hex') };
      if (output === undefined) observation.diagnostic = (stderr + stdout).slice(-3000);
      if (broker) {
        const token = JSON.parse(readFileSync(broker.configPath, 'utf8')).token as string;
        const safe = (text: string) => text.replaceAll(token, '[redacted]').replaceAll(digest(token), '[redacted]');
        if (observation.output !== undefined) observation.output = JSON.parse(safe(JSON.stringify(observation.output)));
        if (observation.diagnostic) observation.diagnostic = safe(observation.diagnostic);
      }
      if (registry) observation.tools = flattenTools(registry);
      observation.unchangedProtectedBytes = readFileSync(foreign, 'utf8') === 'backend-original\n';
      observations.push(observation);
      return observation;
    } finally { clearTimeout(timer); child.kill('SIGKILL'); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }

  function flattenTools(tools: NativeTool[] | undefined, namespace?: string): NativeTool[] {
    return (tools ?? []).flatMap(t => t.type === 'namespace'
      ? flattenTools(t.tools, t.name) : [{ name: t.name, namespace, type: t.type }]);
  }
  const patchCreate = (path: string) => `*** Begin Patch\n*** Add File: ${path}\n+created\n*** End Patch`;
  const patchUpdate = (path: string) => `*** Begin Patch\n*** Update File: ${path}\n@@\n-original\n+changed\n*** End Patch`;
  const patchDelete = (path: string) => `*** Begin Patch\n*** Delete File: ${path}\n*** End Patch`;
  const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
  function fingerprint(path: string): string {
    if (!existsSync(path)) return 'missing';
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return digest(readlinkSync(path));
    if (!stat.isDirectory()) return digest(readFileSync(path));
    return digest(JSON.stringify(readdirSync(path).sort().map(name => [name, fingerprint(join(path, name))])));
  }
  const protectedPaths = [backend, source, sibling, protectedDir, commonDir, join(workspace, '.git'), join(workspace, '.codex'),
    ...(broker ? [broker.configPath, broker.entryPath] : [])];
  const storeTables = ['tasks', 'criteria', 'comments', 'task_links', 'files', 'tracks', 'project', 'repositories', 'repository_bindings',
    'decisions', 'search_index', 'managed_task_policy', 'run_authorities', 'role_profiles', 'role_revisions', 'role_skill_files'];
  const storeSnapshot = (revoking = false) => brokerDb ? digest(JSON.stringify(storeTables.filter(table => !revoking || table !== 'run_authorities')
    .map(table => brokerDb!.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()))) : 'none';
  async function check(testCase: NativeCase, writable: boolean, expected: NativeProbeResult['outcome'], effect?: () => void) {
    const unchangedPaths = protectedPaths.filter(path => path !== testCase.controlRoot);
    const before = unchangedPaths.map(fingerprint);
    const storeBefore = storeSnapshot(testCase.revoke);
    const eventsBefore = brokerDb?.prepare('SELECT * FROM events ORDER BY id').all();
    const observation = await runCase(testCase, writable);
    const text = typeof observation.output === 'string' ? observation.output : JSON.stringify(observation.output) ?? '';
    observation.challengeHash = digest(JSON.stringify([testCase.tool, testCase.patch ?? testCase.command]));
    observation.protectedHashes = unchangedPaths.map((path, i) => ({ path, before: before[i], after: fingerprint(path) }));
    observation.outcome = 'inconclusive';
    const allowed = observation.executed && /(?:Process exited with code|Exit code:) 0/.test(text);
    const denied = observation.executed && /Operation not permitted|Permission denied|patch rejected/.test(text);
    if (allowed) observation.outcome = 'allowed';
    else if (denied) observation.outcome = 'denied';
    else if (testCase.unavailable && observation.executed && text.includes(testCase.tool)
      && /unsupported|unknown|unrecognized|not found/i.test(text)) observation.outcome = 'denied';
    else if (['get_context', 'submit_report', 'request_question', 'read_skill_file'].includes(testCase.tool)) {
      if (text.includes('run operation denied') || /["\\]isError["\\]*\s*:\s*true/.test(text)) observation.outcome = 'denied';
      else if (text.includes('taskId') || text.includes('eventId') || text.includes('contentBase64')) observation.outcome = 'allowed';
    }
    else if (/mcp_resource/.test(testCase.tool) && observation.executed) {
      if (/resources\/(?:read|list|templates\/list) failed:/.test(text) && /unknown|not found|not support|Method not found|capability/i.test(text)) observation.outcome = 'denied';
      else if (testCase.tool.startsWith('list_') && /"(?:resources|resourceTemplates)"\s*:\s*\[\s*\]/.test(text)) observation.outcome = 'allowed';
    }
    else if (testCase.failureCode && observation.executed
      && new RegExp(`Process exited with code ${testCase.failureCode}\\b`).test(text)
      && networkControls.some(control => control.caseId === testCase.id && control.exitCode === 0 && control.commandHash === digest(testCase.command!))) {
      observation.outcome = 'denied';
      observation.matchedControl = `host:${testCase.id}`;
    }
    else if (testCase.matchedControl && observation.executed && /Exit code: 1/.test(text) && /Failed to write file/.test(text)
      && testCase.matchedControl.outcome === 'allowed' && !testCase.matchedControl.failure
      && testCase.matchedControl.challengeHash === observation.challengeHash
      && observation.protectedHashes.every(path => path.before === path.after)) {
      observation.outcome = 'denied';
      observation.matchedControl = testCase.matchedControl.caseId;
    }
    try {
      assert.equal(observation.timedOut, false);
      assert.equal(observation.providerError, undefined);
      assert.equal(observation.outcome, expected, `expected ${expected}, got ${observation.outcome}`);
      if (testCase.revoke) {
        const outputs = observation.output as Record<string, unknown>;
        for (const operation of operations) assert.ok(JSON.stringify(outputs[operation]).includes('run operation denied'), `revoked ${operation} was accepted`);
      }
      if (!testCase.controlRoot) assert.equal(observation.unchangedProtectedBytes, true, 'foreign hardlink bytes changed');
      assert.ok(observation.protectedHashes.every(path => path.before === path.after), 'protected tree changed');
      for (const tool of observation.tools) {
        const name = tool.namespace ? `${tool.namespace}__${tool.name}` : tool.name;
        assert.ok(name && ['exec_command','write_stdin','apply_patch',
          ...(broker ? [...operations.map(operation => `mcp__kdd_run__${operation}`),
            'list_mcp_resources','list_mcp_resource_templates','read_mcp_resource'] : [])].includes(name), `unexpected surface: ${name}`);
      }
      if (broker) {
        assert.equal(storeSnapshot(testCase.revoke), storeBefore, 'protected board rows changed');
      }
      if (broker && !testCase.revoke) {
        if (testCase.unavailable || (testCase.tool !== 'submit_report' && testCase.tool !== 'request_question')) assert.deepEqual(brokerDb!.prepare('SELECT * FROM events ORDER BY id').all(), eventsBefore);
      }
      effect?.();
    } catch (error) { observation.failure = (error as Error).message; failures.push({ caseId: testCase.id, mode: observation.mode, reason: (error as Error).message }); }
    // Reset only fixture markers, after recording every actual side effect.
    await withNativeControllerLock(controlDir, () => {
      writeFileSync(foreign, 'backend-original\n');
      writeFileSync(join(workspace, 'existing.txt'), 'original\n');
      rmSync(join(workspace, 'created.txt'), { force: true });
    });
    if (observation.failure && !rawDiagnostic) throw new Error(`native probe failed: ${observation.mode}:${testCase.id}: ${observation.failure}`);
    return observation;
  }
  async function guardChecks() {
    const marker = join(workspace, 'unexpected-child');
    const input = (phase: 'start' | 'resume') => ({ controlDir, executable: process.execPath, args: ['-e', 'require("node:fs").writeFileSync("unexpected-child","started")'],
      env: { PATH: '/usr/bin:/bin' }, cwd: workspace, writableRoots: [workspace, scratch], phase });
    async function refused(id: string, phase: 'start' | 'resume', pattern: RegExp) {
      try {
        await assert.rejects(spawnCheckedNative(input(phase)), pattern);
        assert.equal(existsSync(marker), false);
        preflight.push({ caseId: id, phase, outcome: 'denied', executed: false });
      } catch (error) { failures.push({ caseId: id, reason: (error as Error).message }); }
    }
    for (const writable of [workspace, scratch]) {
      const deep = join(writable, 'unsafe-deep'); mkdirSync(deep);
      linkSync(foreign, join(deep, 'alias'));
      await refused(`existing-hardlink-${writable === workspace ? 'workspace' : 'scratch'}`, 'start', /hardlink/);
      rmSync(deep, { recursive: true });
    }
    symlinkSync(foreign, join(scratch, 'first-symlink'));
    linkSync(join(scratch, 'first-symlink'), join(scratch, 'linked-symlink'));
    await refused('linked-symlink-inode', 'start', /hardlink/);
    rmSync(join(scratch, 'first-symlink')); rmSync(join(scratch, 'linked-symlink'));
    assertWritableRoots([workspace, scratch]);
    linkSync(foreign, join(scratch, 'late-hardlink'));
    await refused('fresh-resume-after-safe-preflight', 'resume', /hardlink/);
    rmSync(join(scratch, 'late-hardlink'));
    await withNativeControllerLock(controlDir, async () => {
      assertWritableRoots([workspace, scratch]);
      const moduleUrl = import.meta.url;
      const command = `const core=await import(process.argv[1]);const fs=await import('node:fs');try {await core.withNativeControllerLock(process.argv[2],()=>fs.writeFileSync(process.argv[3],'changed'));process.exit(3)}catch(e){if(!/busy/.test(e.message))throw e}`;
      execFileSync(process.execPath, ['--input-type=module', '-e', command, moduleUrl, controlDir, marker]);
      assert.equal(existsSync(marker), false);
      await refused('cross-process-controller-exclusion', 'start', /busy/);
    });
  }
  await checkNetworkControls();
    if (rawDiagnostic) {
      for (let iteration = 1; iteration <= 3; iteration++) {
        await check({ id: `hardlink-shell-${iteration}`, tool: 'exec_command', command: '/bin/sh -c "echo changed > hardlink.txt"' }, true, 'denied', () => {});
        await check({ id: `hardlink-patch-${iteration}`, tool: 'apply_patch', patch: '*** Begin Patch\n*** Update File: hardlink.txt\n@@\n-backend-original\n+changed\n*** End Patch' }, true, 'denied', () => {});
      }
    } else {
      await guardChecks();
      if (!lanAddress) failures.push({ caseId: 'network-lan', reason: 'LAN positive control unavailable' });
      if (!brokerOnly) for (const writable of [false, true]) {
      const read = await check({ id: 'read', tool: 'exec_command', command: '/bin/cat existing.txt' }, writable, 'allowed', () => {});
      if (!(JSON.stringify(read.output) ?? '').includes('original')) throw new Error('positive native read incomplete');
      await check({ id: 'protected-read', tool: 'exec_command', command: `/bin/cat '${join(protectedDir, 'marker.txt')}'` }, writable, 'denied', () => {});
      const projectConfig = join(workspace, '.codex/config.toml');
      await check({ id: 'project-config-shell', tool: 'exec_command', command: `/bin/sh -c "echo changed > '${projectConfig}'"` }, writable, 'denied', () => assert.equal(existsSync(projectConfig), false));
      await check({ id: 'project-config-patch', tool: 'apply_patch', patch: patchCreate(projectConfig) }, writable, 'denied', () => assert.equal(existsSync(projectConfig), false));
      const expected = writable ? 'allowed' : 'denied';
      for (let iteration = 1; iteration <= (writable ? 1 : 3); iteration++) {
        for (const operation of ['create','update','delete'] as const) {
          for (const tool of ['exec_command','apply_patch'] as const) {
            const command = { create: '/bin/sh -c "echo created > created.txt"', update: '/bin/sh -c "echo changed > existing.txt"', delete: '/bin/rm existing.txt' }[operation];
            const patch = { create: patchCreate('created.txt'), update: patchUpdate('existing.txt'), delete: patchDelete('existing.txt') }[operation];
            await check({ id: `${operation}-${iteration}`, tool, command, patch }, writable, expected, () => {
              if (operation === 'create') assert.equal(existsSync(join(workspace, 'created.txt')), writable);
              if (operation === 'update') assert.equal(readFileSync(join(workspace, 'existing.txt'), 'utf8'), writable ? 'changed\n' : 'original\n');
              if (operation === 'delete') assert.equal(existsSync(join(workspace, 'existing.txt')), !writable);
            });
          }
        }
      }
      const symlinkPatch = '*** Begin Patch\n*** Update File: symlink.txt\n@@\n-backend-original\n+changed\n*** End Patch';
      for (let iteration = 1; iteration <= 3; iteration++) {
        // Readonly rejects the patch before IO; the inconclusive IO case exists only in workspace mode.
        const control = writable ? await check({ id: `symlink-positive-control-${iteration}`, tool: 'apply_patch', patch: symlinkPatch, controlRoot: backend }, writable, 'allowed', () => {
          assert.equal(readFileSync(foreign, 'utf8'), 'changed\n');
        }) : undefined;
        await check({ id: `symlink-patch-${iteration}`, tool: 'apply_patch', patch: symlinkPatch, matchedControl: control }, writable, 'denied');
        await check({ id: `symlink-shell-${iteration}`, tool: 'exec_command', command: '/bin/sh -c "echo changed > symlink.txt"' }, writable, 'denied');
      }
      for (const destination of [workspace, scratch]) {
        for (const [name, target] of [['readonly', foreign], ['denied', join(protectedDir, 'marker.txt')]]) {
          const newLink = join(destination, `new-link-${name}`);
          await check({ id: `create-hardlink-${name}-${destination === workspace ? 'workspace' : 'scratch'}`, tool: 'exec_command', command: `/bin/ln '${target}' '${newLink}'` }, writable, 'denied', () => assert.equal(existsSync(newLink), false));
          rmSync(newLink, { force: true });
        }
      }
      await check({ id: 'backend-write', tool: 'exec_command', command: `/bin/sh -c "echo changed > '${foreign}'"` }, writable, 'denied', () => {});
      const backendPatch = '*** Begin Patch\n*** Update File: ' + foreign + '\n@@\n-backend-original\n+changed\n*** End Patch';
      const backendControl = await check({ id: 'backend-positive-control', tool: 'apply_patch', patch: backendPatch, controlRoot: backend }, writable, 'allowed', () => assert.equal(readFileSync(foreign, 'utf8'), 'changed\n'));
      await check({ id: 'backend-patch', tool: 'apply_patch', patch: backendPatch, matchedControl: backendControl }, writable, 'denied');
      for (const path of [join(source, 'existing.txt'), join(sibling, 'marker.txt'), ...['store.db','registry.db','config.toml','credential.json'].map(name => join(protectedDir, name))]) {
        await check({ id: `protected-read-${path.split('/').slice(-2).join('-')}`, tool: 'exec_command', command: `/bin/cat '${path}'` }, writable, 'denied');
        await check({ id: `protected-write-${path.split('/').slice(-2).join('-')}`, tool: 'exec_command', command: `/bin/sh -c "echo changed > '${path}'"` }, writable, 'denied');
        await check({ id: `protected-patch-${path.split('/').slice(-2).join('-')}`, tool: 'apply_patch', patch: patchDelete(path) }, writable, 'denied');
      }
      await check({ id: 'rename-outside', tool: 'exec_command', command: `/bin/mv existing.txt '${join(backend, 'renamed.txt')}'` }, writable, 'denied', () => assert.equal(existsSync(join(backend, 'renamed.txt')), false));
      await check({ id: 'patch-move-outside', tool: 'apply_patch', patch: `*** Begin Patch\n*** Update File: existing.txt\n*** Move to: ${join(protectedDir, 'moved.txt')}\n@@\n-original\n+changed\n*** End Patch` }, writable, 'denied', () => assert.equal(existsSync(join(protectedDir, 'moved.txt')), false));
      await check({ id: 'git-ref', tool: 'exec_command', command: '/usr/bin/git update-ref refs/heads/forbidden HEAD' }, writable, 'denied', () => {
        assert.equal(git(workspace, 'for-each-ref', 'refs/heads/forbidden'), '');
      });
      await check({ id: 'git-object', tool: 'exec_command', command: `/bin/sh -c "echo new-object | /usr/bin/git hash-object -w --stdin"` }, writable, 'denied');
      for (const [id, path] of [['git-pointer', join(workspace, '.git')], ['git-worktree-head', join(gitDir, 'HEAD')], ['git-common-config', join(commonDir, 'config')]]) {
        await check({ id, tool: 'exec_command', command: `/bin/sh -c "echo changed > '${path}'"` }, writable, 'denied');
        await check({ id: `${id}-patch`, tool: 'apply_patch', patch: patchDelete(path) }, writable, 'denied');
      }
      await check({ id: 'scratch-write', tool: 'exec_command', command: `/bin/sh -c "echo scratch > '${join(scratch, 'allowed.txt')}'"` }, writable, 'allowed', () => assert.equal(readFileSync(join(scratch, 'allowed.txt'), 'utf8'), 'scratch\n'));
      await check({ id: 'scratch-patch', tool: 'apply_patch', patch: patchCreate(join(scratch, 'patch-allowed.txt')) }, writable, 'allowed', () => assert.equal(readFileSync(join(scratch, 'patch-allowed.txt'), 'utf8'), 'created\n'));
      rmSync(join(scratch, 'patch-allowed.txt'));
      await check({ id: 'fresh-resume-read', tool: 'exec_command', command: '/bin/cat existing.txt', phase: 'resume' }, writable, 'allowed');
      for (const testCase of networkCases) {
        await check({ ...testCase, tool: 'exec_command' }, writable, 'denied', () => {
          assert.equal(tcpRequests, tcpBaseline); assert.equal(unixRequests, unixBaseline);
        });
      }
      }
      if (broker) {
        for (const writable of [false, true]) {
          for (const tool of ['list_mcp_resources', 'list_mcp_resource_templates'] as const) {
            await check({ id: `broker-${tool}-empty`, tool, payload: {} }, writable, 'allowed');
            await check({ id: `broker-${tool}-foreign`, tool, payload: { server: 'foreign' } }, writable, 'denied');
          }
          for (const server of ['kdd_run', 'foreign']) await check({ id: `broker-resource-read-${server}`, tool: 'read_mcp_resource', payload: { server, uri: `file://${broker.configPath}` } }, writable, 'denied');
          for (const [operation, id] of [['get_context', 'context'], ['submit_report', 'report'],
            ['request_question', 'question'], ['read_skill_file', 'skill']] as const) {
            const granted = operations.includes(operation);
            const before = brokerDb!.prepare('SELECT COUNT(*) n FROM events').get() as { n: number };
            await check({ id: `broker-${id}`, tool: operation, unavailable: !granted,
              payload: brokerPayload(operation, 'native broker proof') }, writable, granted ? 'allowed' : 'denied', () => {
              const writes = granted && operation !== 'get_context' && operation !== 'read_skill_file';
              assert.deepEqual(brokerDb!.prepare('SELECT COUNT(*) n FROM events').get(), { n: before.n + (writes ? 1 : 0) });
              if (writes) {
                const event = brokerDb!.prepare('SELECT actor_type,action,detail FROM events ORDER BY id DESC LIMIT 1').get() as { actor_type: string; action: string; detail: string };
                assert.equal(event.actor_type, 'ai'); assert.equal(event.action, operation === 'submit_report' ? 'run_report' : 'run_question');
                assert.equal(JSON.parse(event.detail).untrusted, true);
              }
            });
          }
          for (const path of [broker.configPath, broker.dbPath]) {
            await check({ id: `broker-read-${path === broker.configPath ? 'config' : 'store'}`, tool: 'exec_command', command: `/bin/cat '${path}'` }, writable, 'denied');
            await check({ id: `broker-patch-${path === broker.configPath ? 'config' : 'store'}`, tool: 'apply_patch', patch: patchDelete(path) }, writable, 'denied');
          }
          const cli = fileURLToPath(new URL('../../cli/dist/index.js', import.meta.url));
          assert.ok(existsSync(cli), 'raw CLI fixture executable unavailable');
          await check({ id: 'broker-raw-cli-user', tool: 'exec_command', command: `/bin/sh -c "KDD_DB='${broker.dbPath}' KDD_ACTOR=user '${broker.nodePath}' '${cli}' show 1 --json"` }, writable, 'denied');
        }
        const eventsBeforeRevoke = brokerDb!.prepare('SELECT COUNT(*) n FROM events').get() as { n: number };
        await check({ id: 'broker-live-revoke-operations', tool: operations[0], revoke: true,
          payload: brokerPayload(operations[0], 'late proposal') }, true, 'denied', () => {
          assert.deepEqual(brokerDb!.prepare('SELECT COUNT(*) n FROM events').get(), { n: eventsBeforeRevoke.n + 1 });
        });
      }
    }
  } catch (error) { failures.push({ failure: (error as Error).message }); }
  finally {
    brokerDb?.close();
    tcpServer?.closeAllConnections();
    if (tcpServer?.listening) await new Promise<void>(resolve => tcpServer!.close(() => resolve()));
    if (unixServer?.listening) await new Promise<void>(resolve => unixServer!.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
return { version, model, executableHash, scriptHash, guardHash, applicable: failures.length === 0 && observations.length > 0,
    rawDiagnostic, preflight, networkControls,
    attempted: observations.length, executed: observations.filter(o => o.executed).length, failures, observations, operations };
}
