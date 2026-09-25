import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export const publicPackages = ['@kddkit/core', '@kddkit/cli', '@kddkit/ui'];
const manifests = ['packages/core/package.json', 'packages/cli/package.json',
  'packages/ui/package.json', 'packages/mcp/package.json',
  '.claude-plugin/plugin.json', 'integrations/codex-plugin/.codex-plugin/plugin.json'];

export function run(binary, args, inherit = false) {
  const result = spawnSync(binary, args, { encoding: 'utf8', stdio: inherit ? 'inherit' : 'pipe' });
  if (result.error || result.status !== 0) {
    throw new Error(`${binary} ${args.join(' ')} failed: ${result.stderr?.trim() || result.error?.message || result.status}`);
  }
  return result.stdout?.trim() ?? '';
}

export function previewVersion() {
  if (run('git', ['branch', '--show-current']) !== 'next') throw new Error('preview release requires the next branch');
  const versions = manifests.map((file) => JSON.parse(readFileSync(file, 'utf8')).version);
  if (versions.some((version) => version !== versions[0])) throw new Error('package and plugin versions are not in lockstep');
  return versions[0];
}

export function requirePreview(version) {
  if (!/^\d+\.\d+\.\d+-next\.\d+$/.test(version)) throw new Error(`invalid next version: ${version}`);
}

export function requireCleanTag(version) {
  if (run('git', ['status', '--porcelain'])) throw new Error('working tree is not clean');
  if (run('git', ['tag', '--list', `v${version}`]) !== `v${version}`) throw new Error(`missing local tag v${version}`);
  if (run('git', ['rev-list', '-n', '1', `v${version}`]) !== run('git', ['rev-parse', 'HEAD']))
    throw new Error('preview tag does not point to HEAD');
}
