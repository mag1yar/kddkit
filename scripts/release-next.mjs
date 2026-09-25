import { previewVersion, requirePreview, run } from './next-release-common.mjs';

try {
  const before = previewVersion();
  if (!/^\d+\.\d+\.\d+(?:-next\.\d+)?$/.test(before)) throw new Error(`invalid starting version: ${before}`);
  const files = ['package.json', 'packages/*/package.json', '.claude-plugin/plugin.json',
    'integrations/codex-plugin/.codex-plugin/plugin.json'];
  const gates = 'pnpm build && pnpm test && pnpm typecheck && pnpm test:codex-plugin';
  run('pnpm', ['exec', 'bumpp', ...files, '--release', 'prerelease', '--preid', 'next',
    '--all', '--no-push', '--execute', gates], true);
  const version = previewVersion();
  requirePreview(version);
  if (version === before) throw new Error('bumpp did not advance the preview version');
  if (run('git', ['tag', '--list', `v${version}`]) !== `v${version}`)
    throw new Error(`bumpp did not create v${version}`);
  run('npx', ['-y', 'changelogithub@14', '--dry'], true);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
