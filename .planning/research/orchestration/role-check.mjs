// Isolated real-provider delivery check. No production board or skill source is modified.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '../../../packages/core/dist/index.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'kdd-role-check-'))), saved = { ...process.env };
const evidence = { version: null, model: 'gpt-6-sol', effort: 'high', modes: [], failures: [] };
let db;
try {
  const home = join(root, 'private'), source = join(root, 'source'), workspace = join(root, 'workspace');
  const scratch = join(root, 'scratch'), controlDir = join(home, 'controller');
  const configPath = join(controlDir, 'broker.json'), skills = join(root, 'skills');
  for (const path of [source, scratch, controlDir, join(skills, 'always'), join(skills, 'available', 'references'),
    join(skills, 'available', 'scripts'), join(skills, 'available', 'assets')]) mkdirSync(path, { recursive: true });
  const git = (cwd, ...args) => execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  git(source, 'init', '-q'); git(source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--allow-empty', '-qm', 'fixture');
  git(root, 'clone', '--no-hardlinks', '-q', source, workspace);
  const alwaysMarker = 'ALWAYS-MARKER-f4698b2c', availableMarker = 'AVAILABLE-MARKER-28c7e3ab';
  const sources = {
    'always/SKILL.md': `# Always guide\nThe exact marker is ${alwaysMarker}.\n`,
    'available/SKILL.md': `# Available guide\nThe exact marker is ${availableMarker}.\n`,
    'available/references/detail.md': 'Pinned reference body.\n',
    'available/scripts/check.sh': 'printf pinned-script\\n\n',
    'available/assets/payload.bin': Buffer.from([0, 1, 2, 3, 4, 255]),
  };
  for (const [path, body] of Object.entries(sources)) writeFileSync(join(skills, path), body);
  const hashes = Object.fromEntries(Object.entries(sources).map(([path, body]) => [path, sha(body)]));
  const availableBodyBase64 = Buffer.from(sources['available/SKILL.md']).toString('base64');
  process.env.KDD_HOME = home; delete process.env.KDD_DB; delete process.env.KDD_DECISIONS_DIR;
  const resolved = core.resolveDbPath(source); db = core.openDb(resolved.dbPath, resolved.projectPath, source);
  const controller = core.openController(db), projectId = core.projectOf(db).project_id, repoId = core.projectOf(db).primary_repo_id;
  core.bindRepository(db, db.name, home, { cwd: workspace, repoId, kind: 'managed' }, { type: 'user' });
  const task = core.addTask(db, { title: 'Observe pinned role delivery', body: 'Isolated delivery fixture' }, { type: 'user' });
  const probeTask = core.addTask(db, { title: 'Bootstrap native broker proof' }, { type: 'user' });
  const operations = ['get_context', 'read_skill_file'];
  const definition = access => ({ name: `Observed ${access}`, runtime: 'codex', model: 'gpt-6-sol', effort: 'high', access,
    operations, prompt: `First call get_context for the scoped task. Report the exact marker from the Always guide. Then call read_skill_file for AvailableGuide SKILL.md, references/detail.md, scripts/check.sh and assets/payload.bin. Report the Available marker and the SHA-256 values returned by the tool. Do not run scripts or write files.`,
    skills: [
      { name: 'AlwaysGuide', mode: 'Always', description: 'Always marker', source: { kind: 'local', root: skills, path: 'always' } },
      { name: 'AvailableGuide', mode: 'Available', description: 'Read pinned guide and resources', source: { kind: 'local', root: skills, path: 'available' } },
    ] });
  const writeRole = core.saveRoleRevision(controller, { expectedRevision: 0, commandId: 'write-role', definition: definition('workspace-write') });
  const readRole = core.saveRoleRevision(controller, { expectedRevision: 0, commandId: 'read-role', definition: definition('read') });
  const entryPath = realpathSync(fileURLToPath(new URL('../../../packages/mcp/dist/run_main.js', import.meta.url)));
  const executable = process.env.KDD_CODEX_EXECUTABLE || '/opt/homebrew/bin/codex';
  const base = { executable, model: 'gpt-6-sol', effort: 'high', cwd: workspace, readableRoots: [workspace],
    scratchDir: scratch, controlDir, protectedPaths: [source, home] };
  const run = async (permit, mode, repetition) => {
    const child = await core.spawnCheckedRoleRun(permit);
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 4_000_000) child.kill('SIGKILL'); });
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 1_000_000) child.kill('SIGKILL'); });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 180_000);
    const code = await new Promise(resolve => child.once('close', resolve)); clearTimeout(timer);
    const events = stdout.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const credential = JSON.parse(readFileSync(configPath, 'utf8')).token;
    const safe = value => value.replaceAll(credential, '[redacted]').replaceAll(sha(credential), '[redacted]');
    const firstRead = events.findIndex(event => JSON.stringify(event).includes('read_skill_file'));
    const before = firstRead < 0 ? stdout : events.slice(0, firstRead).map(JSON.stringify).join('\n');
    const result = { mode, repetition, code, timedOut, eventCount: events.length,
      firstReadEvent: firstRead, contextCalled: stdout.includes('get_context'), alwaysObserved: stdout.includes(alwaysMarker),
      availableAbsentBeforeRead: !before.includes(availableMarker) && !before.includes(availableBodyBase64),
      availableObservedAfterRead: firstRead >= 0 && stdout.includes(availableBodyBase64),
      availableDecodedByModel: stdout.includes(availableMarker),
      resourceHashesObserved: Object.fromEntries(Object.entries(hashes).filter(([path]) => path.startsWith('available/'))
        .map(([path, hash]) => [path, stdout.includes(hash)])),
      stderr: code === 0 ? undefined : safe(stderr.slice(-1500)) };
    if (code !== 0 || timedOut || !result.contextCalled || !result.alwaysObserved || !result.availableAbsentBeforeRead || !result.availableObservedAfterRead
      || !result.availableDecodedByModel
      || Object.values(result.resourceHashesObserved).some(value => !value)) evidence.failures.push(result);
    return result;
  };
  const issue = (native, role, generation, writable, bootstrap = false) => core.issueRunAuthority(controller, {
    taskId: bootstrap ? probeTask.id : task.id, workItemId: 'role-observation', runId: `role-${generation}`, expectedGeneration: generation,
    expiresAt: core.now() + 7200, role, operations, native,
    repositories: [{ repoId, checkoutPath: workspace, write: writable }],
    ...(bootstrap ? { probeBootstrap: true } : {}),
  });
  process.stderr.write('role bootstrap preflight started\n');
  const bootstrap = await core.preflightCodex(base);
  evidence.version = bootstrap.version;
  let grant = issue(bootstrap, readRole, 0, false, true);
  writeFileSync(configPath, JSON.stringify({ dbPath: db.name, token: grant.token }), { mode: 0o600 });
  for (const [mode, writable, role] of [['workspace-write', true, writeRole], ['read', false, readRole]]) {
    process.stderr.write(`${mode} bound preflight started\n`);
    const native = await core.preflightCodex({ ...base, ...(writable ? { writableRoot: workspace } : {}),
      brokerConfigPath: configPath, brokerEntryPath: entryPath });
    grant = issue(native, role, mode === 'workspace-write' ? 0 : 1, writable);
    await core.withNativeControllerLock(controlDir, () => writeFileSync(configPath, JSON.stringify({ dbPath: db.name, token: grant.token })));
    const permit = core.prepareRoleLaunch(controller, { projectId, authorityId: grant.authorityId, native });
    assert.ok(permit.prompt.includes(alwaysMarker) && !permit.prompt.includes(availableMarker));
    const modeEvidence = { mode, manifestHash: role.manifestHash, promptHash: permit.promptHash, configHash: native.configHash,
      executableHash: sha(readFileSync(native.executable)), observations: native.results.length,
      maxFirstRequestBytes: Math.max(...native.results.map(result => result.firstRequestBytes ?? 0)), runs: [] };
    for (let repetition = 1; repetition <= 3; repetition++) {
      process.stderr.write(`${mode} provider run ${repetition}/3\n`);
      modeEvidence.runs.push(await run(permit, mode, repetition));
    }
    evidence.modes.push(modeEvidence);
  }
  evidence.hashes = hashes;
  evidence.passed = evidence.failures.length === 0;
} catch (error) {
  evidence.failures.push({ stage: 'setup-or-preflight', message: String(error), cause: error?.cause });
  evidence.passed = false;
} finally {
  db?.close(); process.env = saved; rmSync(root, { recursive: true, force: true });
  process.stdout.write(JSON.stringify(evidence, null, 2) + '\n');
  if (!evidence.passed) process.exitCode = 1;
}
