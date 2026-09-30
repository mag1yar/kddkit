// Process-local proof, exercised against actual Codex tools; never the development board.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, realpathSync, linkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preflightCodex, assertVerifiedCodexPackage, spawnCheckedNative } from '../../../packages/core/dist/index.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'kdd-package-')));
const checks = [];
try {
  const workspace = join(root, 'workspace'), scratch = join(root, 'scratch'), controlDir = join(root, 'controller');
  const source = join(root, 'source'), backend = join(root, 'backend'), privateFile = join(controlDir, 'private');
  for (const path of [scratch, controlDir, source, backend]) mkdirSync(path);
  writeFileSync(privateFile, 'fixture-private');
  writeFileSync(join(backend, 'marker'), 'backend-original');
  writeFileSync(join(source, 'product'), 'product-original');
  const git = (cwd, ...args) => execFileSync('/usr/bin/git', args, { cwd, stdio: 'pipe' });
  git(source, 'init', '-q'); git(source, 'add', 'product');
  git(source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
  git(root, 'clone', '--no-hardlinks', '-q', source, workspace);
  git(backend, 'init', '-q');
  const packet = await preflightCodex({ executable: '/opt/homebrew/bin/codex', model: 'gpt-6-sol', effort: 'high', cwd: workspace,
    controlDir, readableRoots: [workspace, backend], writableRoot: workspace, scratchDir: scratch, protectedPaths: [source, privateFile] });
  assertVerifiedCodexPackage(packet); checks.push('actual-package-issued');
  assert.ok(Object.isFrozen(packet) && Object.isFrozen(packet.argv) && Object.isFrozen(packet.env)
    && Object.isFrozen(packet.results) && packet.results.every(Object.isFrozen)); checks.push('immutable');
  assert.ok(packet.results.every(result => result.executed && result.outcome !== 'inconclusive' && result.unchangedProtectedBytes));
  assert.throws(() => assertVerifiedCodexPackage(JSON.parse(JSON.stringify(packet))), /unverified/); checks.push('json-copy-refused');
  assert.throws(() => assertVerifiedCodexPackage({ ...packet }), /unverified/); checks.push('object-copy-refused');
  const launch = { controlDir, writableRoots: [scratch, workspace], executable: packet.executable, cwd: workspace,
    args: [...packet.argv, 'fixture'], env: packet.env, phase: 'start', verified: packet };
  await assert.rejects(spawnCheckedNative({ ...launch, args: [...packet.argv.slice(0, -1), '--add-dir', backend, '--', 'fixture'] }), /differs/);
  await assert.rejects(spawnCheckedNative({ ...launch, env: { ...packet.env, CODEX_API_KEY: 'fixture-injection' } }), /differs/);
  checks.push('argv-env-expansion-refused-before-child');
  linkSync(join(backend, 'marker'), join(scratch, 'late-link'));
  assert.throws(() => assertVerifiedCodexPackage(packet), /binding/);
  await assert.rejects(spawnCheckedNative({ ...launch, phase: 'resume' }), /binding|hardlink/);
  rmSync(join(scratch, 'late-link')); checks.push('late-hardlink-resume-refused');
  mkdirSync(join(workspace, '.codex')); writeFileSync(join(workspace, '.codex/config.toml'), '# fixture');
  assert.throws(() => assertVerifiedCodexPackage(packet), /binding/);
  rmSync(join(workspace, '.codex'), { recursive: true }); checks.push('late-project-config-refused');
  const catalog = join(controlDir, readdirSync(controlDir).find(name => name.startsWith('codex-catalog-')));
  const bytes = readFileSync(catalog); writeFileSync(catalog, '{}');
  assert.throws(() => assertVerifiedCodexPackage(packet), /binding/);
  writeFileSync(catalog, bytes); checks.push('changed-catalog-refused');
  renameSync(privateFile, join(controlDir, 'old-private')); writeFileSync(privateFile, 'fixture-private');
  assert.throws(() => assertVerifiedCodexPackage(packet), /binding/);
  rmSync(privateFile); renameSync(join(controlDir, 'old-private'), privateFile); checks.push('replaced-protected-file-refused');
  renameSync(scratch, join(root, 'old-scratch')); mkdirSync(scratch);
  assert.throws(() => assertVerifiedCodexPackage(packet), /binding/);
  rmSync(scratch, { recursive: true }); renameSync(join(root, 'old-scratch'), scratch); checks.push('replaced-root-refused');
  assertVerifiedCodexPackage(packet);
  process.stdout.write(JSON.stringify({ version: packet.version, configHash: packet.configHash, checks, results: packet.results }, null, 2) + '\n');
} finally { rmSync(root, { recursive: true, force: true }); }
