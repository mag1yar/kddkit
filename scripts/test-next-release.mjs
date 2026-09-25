import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('../', import.meta.url).pathname;
const names = ['@kddkit/core', '@kddkit/cli', '@kddkit/ui'];
const version = '0.9.0-next.2';

function command(cwd, name, args = [], env = process.env) {
  return spawnSync(name, args, { cwd, env, encoding: 'utf8' });
}

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'kdd-next-release-'));
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'bin'));
  for (const file of ['next-release-common.mjs', 'release-next.mjs', 'publish-next.mjs'])
    cpSync(join(root, 'scripts', file), join(dir, 'scripts', file));
  const manifest = (path, name, privatePackage = false) => {
    mkdirSync(join(dir, path), { recursive: true });
    writeFileSync(join(dir, path, 'package.json'), JSON.stringify({ name, version, private: privatePackage }));
  };
  manifest('.', 'kddkit-monorepo', true);
  for (const name of names) manifest(`packages/${name.split('/')[1]}`, name);
  manifest('packages/mcp', '@kddkit/mcp', true);
  mkdirSync(join(dir, '.claude-plugin'));
  mkdirSync(join(dir, 'integrations/codex-plugin/.codex-plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin/plugin.json'), JSON.stringify({ version }));
  writeFileSync(join(dir, 'integrations/codex-plugin/.codex-plugin/plugin.json'), JSON.stringify({ version }));
  assert.equal(command(dir, 'git', ['init', '-q', '-b', 'next']).status, 0);
  const state = join(dir, '.git', 'state.json');
  writeFileSync(state, JSON.stringify({ before: true, mode: 'normal' }));
  const npm = `#!/usr/bin/env node
const fs = require('node:fs');
const s = JSON.parse(fs.readFileSync(process.env.PROBE_STATE, 'utf8'));
const tags = { latest: s.mode === 'move-latest' && !s.before ? '0.9.0' : '0.8.0' };
if (!s.before && s.mode !== 'missing-next') tags.next = '${version}';
process.stdout.write(JSON.stringify(tags));
`;
  const pnpm = `#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
const s = JSON.parse(fs.readFileSync(process.env.PROBE_STATE, 'utf8'));
s.before = false;
fs.writeFileSync(process.env.PROBE_STATE, JSON.stringify(s));
fs.writeFileSync(process.env.PROBE_ARGS, JSON.stringify(process.argv.slice(2)));
if (s.mode === 'prepare' && process.argv[2] === 'exec' && process.argv[3] === 'bumpp') {
  for (const file of ['package.json', 'packages/core/package.json', 'packages/cli/package.json',
    'packages/ui/package.json', 'packages/mcp/package.json', '.claude-plugin/plugin.json',
    'integrations/codex-plugin/.codex-plugin/plugin.json']) {
    const row = JSON.parse(fs.readFileSync(file, 'utf8'));
    row.version = '0.9.0-next.3';
    fs.writeFileSync(file, JSON.stringify(row));
  }
  cp.execFileSync('git', ['add', '.']);
  cp.execFileSync('git', ['-c', 'user.name=Probe', '-c', 'user.email=probe@example.com',
    'commit', '-qm', 'next preview']);
  cp.execFileSync('git', ['tag', 'v0.9.0-next.3']);
}
`;
  const npx = `#!/usr/bin/env node\nprocess.exit(0);\n`;
  for (const [name, body] of [['npm', npm], ['pnpm', pnpm], ['npx', npx]]) {
    writeFileSync(join(dir, 'bin', name), body, { mode: 0o755 });
  }
  assert.equal(command(dir, 'git', ['add', '.']).status, 0);
  assert.equal(command(dir, 'git', ['-c', 'user.name=Probe', '-c', 'user.email=probe@example.com', 'commit', '-qm', 'preview']).status, 0);
  assert.equal(command(dir, 'git', ['tag', `v${version}`]).status, 0);
  const env = { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, PROBE_STATE: state, PROBE_ARGS: join(dir, '.git', 'args.json') };
  return { dir, env, state };
}

const w = workspace();
const run = (script) => command(w.dir, process.execPath, [`scripts/${script}.mjs`], w.env);
assert.notEqual(run('release-next').status, 0, 'bumpp must advance the preview version');
assert.equal(command(w.dir, 'git', ['checkout', '-qb', 'wrong']).status, 0);
assert.notEqual(run('publish-next').status, 0, 'wrong branch must stop');
assert.notEqual(run('release-next').status, 0, 'preview preparation must refuse wrong branch');
assert.equal(command(w.dir, 'git', ['checkout', '-q', 'next']).status, 0);

writeFileSync(join(w.dir, 'packages/cli/package.json'), JSON.stringify({ name: '@kddkit/cli', version: '0.9.0' }));
assert.notEqual(run('publish-next').status, 0, 'mismatched manifests must stop');
assert.equal(command(w.dir, 'git', ['checkout', '--', 'packages/cli/package.json']).status, 0);

const published = run('publish-next');
assert.equal(published.status, 0, `valid preview must publish: ${published.stderr}`);
assert.deepEqual(JSON.parse(readFileSync(join(w.dir, '.git', 'args.json'), 'utf8')).slice(0, 5),
  ['-r', 'publish', '--tag', 'next', '--no-git-checks']);
for (const mode of ['move-latest', 'missing-next']) {
  writeFileSync(w.state, JSON.stringify({ before: true, mode }));
  assert.notEqual(run('publish-next').status, 0, `${mode} must fail postcheck`);
}
writeFileSync(w.state, JSON.stringify({ before: true, mode: 'normal' }));
assert.equal(run('publish-next').status, 0, 'retry with skipped package must still verify tags');
for (const file of ['packages/core/package.json', 'packages/cli/package.json',
  'packages/ui/package.json', 'packages/mcp/package.json']) {
  const path = join(w.dir, file);
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...pkg, version: '0.9.0' }));
}
for (const file of ['.claude-plugin/plugin.json', 'integrations/codex-plugin/.codex-plugin/plugin.json'])
  writeFileSync(join(w.dir, file), JSON.stringify({ version: '0.9.0' }));
assert.notEqual(run('publish-next').status, 0, 'stable version must never use preview publisher');
for (const file of ['packages/core/package.json', 'packages/cli/package.json',
  'packages/ui/package.json', 'packages/mcp/package.json',
  '.claude-plugin/plugin.json', 'integrations/codex-plugin/.codex-plugin/plugin.json']) {
  const path = join(w.dir, file);
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...pkg, version: 'broken-version' }));
}
assert.notEqual(run('release-next').status, 0, 'invalid starting version must stop before bumpp');
const prepared = workspace();
writeFileSync(prepared.state, JSON.stringify({ before: true, mode: 'prepare' }));
const preview = command(prepared.dir, process.execPath, ['scripts/release-next.mjs'], prepared.env);
assert.equal(preview.status, 0, `preview preparation must advance the tag: ${preview.stderr}`);
assert.equal(JSON.parse(readFileSync(join(prepared.dir, 'packages/cli/package.json'), 'utf8')).version,
  '0.9.0-next.3');
const bumpArgs = JSON.parse(readFileSync(prepared.env.PROBE_ARGS, 'utf8'));
assert.deepEqual(bumpArgs.slice(0, 2), ['exec', 'bumpp']);
assert.deepEqual(bumpArgs.slice(bumpArgs.indexOf('--release'), bumpArgs.indexOf('--all')),
  ['--release', 'prerelease', '--preid', 'next']);
assert.equal(command(prepared.dir, 'git', ['tag', '--list', 'v0.9.0-next.3']).stdout.trim(), 'v0.9.0-next.3');
console.log('next release guards: passed');
