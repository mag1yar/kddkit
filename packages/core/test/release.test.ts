import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  _resetCache, compareVersions, kddVersion, releaseInfo, repoSlug, type Release,
} from '../src/release.js';

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

// Фейковый GitHub: отдаёт заданные строки и считает вызовы. Не мок-библиотека —
// тот же явный проброс зависимости, что и db первым аргументом в остальном core.
function ghStub(rows: unknown, init: { status?: number; statusText?: string } = {}) {
  const calls = { n: 0 };
  const fetchImpl = (async () => {
    calls.n++;
    return new Response(JSON.stringify(rows), {
      status: init.status ?? 200,
      statusText: init.statusText ?? 'OK',
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

const row = (over: Record<string, unknown> = {}) => ({
  tag_name: 'v0.9.0',
  html_url: 'https://github.com/mag1yar/kddkit/releases/tag/v0.9.0',
  body: '### Features\n- thing',
  published_at: '2026-07-25T10:00:00Z',
  draft: false,
  prerelease: false,
  ...over,
});

describe('releaseInfo', () => {
  beforeEach(() => { _resetCache(); });

  it('maps GitHub rows and strips the leading v', async () => {
    const { fetchImpl } = ghStub([row()]);
    const info = await releaseInfo({ fetch: fetchImpl });
    expect(info.error).toBeNull();
    expect(info.releases).toHaveLength(1);
    const r = info.releases[0] as Release;
    expect(r.version).toBe('0.9.0');
    expect(r.body).toBe('### Features\n- thing');
    expect(r.publishedAt).toBe('2026-07-25T10:00:00Z');
    expect(info.repoUrl).toBe('https://github.com/mag1yar/kddkit');
  });

  it('passes html_url through as the release url', async () => {
    const { fetchImpl } = ghStub([row({ html_url: 'https://github.com/mag1yar/kddkit/releases/tag/v0.9.0' })]);
    const info = await releaseInfo({ fetch: fetchImpl });
    expect(info.releases[0]?.url).toBe('https://github.com/mag1yar/kddkit/releases/tag/v0.9.0');
  });

  it('falls back to repoUrl/releases when html_url is absent', async () => {
    const { fetchImpl } = ghStub([row({ html_url: undefined })]);
    const info = await releaseInfo({ fetch: fetchImpl });
    expect(info.releases[0]?.url).toBe('https://github.com/mag1yar/kddkit/releases');
  });

  it('reports an update when the newest stable release is ahead', async () => {
    const { fetchImpl } = ghStub([row({ tag_name: 'v99.0.0' })]);
    const info = await releaseInfo({ fetch: fetchImpl });
    expect(info.latest).toBe('99.0.0');
    expect(info.hasUpdate).toBe(true);
    expect(info.current).toBe(kddVersion());
  });

  it('keeps prereleases in the list but never in latest', async () => {
    const { fetchImpl } = ghStub([
      row({ tag_name: 'v99.1.0-next.1', prerelease: true }),
      row({ tag_name: 'v0.1.0' }),
    ]);
    const info = await releaseInfo({ fetch: fetchImpl });
    expect(info.releases.map((r) => r.version)).toEqual(['99.1.0-next.1', '0.1.0']);
    expect(info.latest).toBe('0.1.0');
  });

  it('leaves latest null and error null when every release is a prerelease', async () => {
    const { fetchImpl } = ghStub([row({ tag_name: 'v99.1.0-next.1', prerelease: true })]);
    const info = await releaseInfo({ fetch: fetchImpl });
    expect(info.releases).toHaveLength(1);
    expect(info.latest).toBeNull();
    expect(info.hasUpdate).toBe(false);
    expect(info.error).toBeNull();
  });

  it('drops drafts', async () => {
    const { fetchImpl } = ghStub([row({ tag_name: 'v99.0.0', draft: true }), row()]);
    const info = await releaseInfo({ fetch: fetchImpl });
    expect(info.releases.map((r) => r.version)).toEqual(['0.9.0']);
  });

  it('reports no published releases on an empty list', async () => {
    const { fetchImpl } = ghStub([]);
    const info = await releaseInfo({ fetch: fetchImpl });
    expect(info.error).toBe('no published releases');
    expect(info.current).toBe(kddVersion());
    expect(info.releases).toEqual([]);
  });

  it('reports the HTTP status and still returns the local version', async () => {
    const { fetchImpl } = ghStub({}, { status: 403, statusText: 'rate limit exceeded' });
    const info = await releaseInfo({ fetch: fetchImpl });
    expect(info.error).toBe('GitHub API 403 rate limit exceeded');
    expect(info.current).toBe(kddVersion());
    expect(info.hasUpdate).toBe(false);
  });

  it('reports an unexpected response when GitHub returns a 200 non-array body', async () => {
    const { fetchImpl } = ghStub({ message: 'not an array' });
    const info = await releaseInfo({ fetch: fetchImpl });
    expect(info.error).toBe('unexpected GitHub response');
    expect(info.current).toBe(kddVersion());
    expect(info.releases).toEqual([]);
  });

  it('swallows a thrown fetch into error', async () => {
    const boom = (async () => { throw new Error('getaddrinfo ENOTFOUND'); }) as
      unknown as typeof globalThis.fetch;
    const info = await releaseInfo({ fetch: boom });
    expect(info.error).toBe('getaddrinfo ENOTFOUND');
  });

  it('serves the second call from cache', async () => {
    const { fetchImpl, calls } = ghStub([row()]);
    await releaseInfo({ fetch: fetchImpl });
    await releaseInfo({ fetch: fetchImpl });
    expect(calls.n).toBe(1);
  });
});
