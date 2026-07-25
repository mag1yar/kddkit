import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareVersions, kddVersion, repoSlug } from '../src/release.js';

describe('kddVersion', () => {
  it('matches version in packages/core/package.json', () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, '../package.json'), 'utf8')) as { version: string };
    expect(kddVersion()).toBe(pkg.version);
  });
});

describe('repoSlug', () => {
  it('derives owner/repo from repository.url', () => {
    expect(repoSlug()).toEqual({ owner: 'mag1yar', repo: 'kddkit' });
  });
});

describe('compareVersions', () => {
  it('compares numerically, not lexicographically', () => {
    expect(compareVersions('0.10.0', '0.4.0')).toBeGreaterThan(0);
    expect(compareVersions('0.4.0', '0.10.0')).toBeLessThan(0);
  });

  it('ignores a leading v', () => {
    expect(compareVersions('v0.4.0', '0.4.0')).toBe(0);
  });

  it('ranks a release above a prerelease with the same core', () => {
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
  });

  it('orders prereleases lexicographically', () => {
    expect(compareVersions('1.0.0-rc.2', '1.0.0-rc.1')).toBeGreaterThan(0);
  });

  it('treats missing and non-numeric parts as zero', () => {
    expect(compareVersions('1', '1.0.0')).toBe(0);
    expect(compareVersions('junk', '0.0.0')).toBe(0);
  });
});
