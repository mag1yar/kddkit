import { previewVersion, publicPackages, requireCleanTag, requirePreview, run } from './next-release-common.mjs';

function tags(name) {
  const value = JSON.parse(run('npm', ['view', name, 'dist-tags', '--json', '--registry=https://registry.npmjs.org']));
  if (!value || typeof value !== 'object') throw new Error(`invalid npm dist-tags for ${name}`);
  return value;
}

try {
  const version = previewVersion();
  requirePreview(version);
  requireCleanTag(version);
  const before = Object.fromEntries(publicPackages.map((name) => [name, tags(name)]));
  if (publicPackages.some((name) => typeof before[name].latest !== 'string'))
    throw new Error('npm latest dist-tag is missing');
  run('pnpm', ['-r', 'publish', '--tag', 'next', '--no-git-checks'], true);
  for (const name of publicPackages) {
    const after = tags(name);
    if (after.latest !== before[name].latest || after.next !== version)
      throw new Error(`${name} dist-tags disagree after publish: latest=${after.latest}, next=${after.next}`);
  }
  console.log(`Verified npm next=${version}; latest unchanged for all public packages.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
