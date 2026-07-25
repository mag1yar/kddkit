import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  _cacheUntil, _resetCache, compareVersions, kddVersion, parseRepoUrl, releaseInfo, repoSlug,
  type Release,
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

  // точка в имени репозитория легальна; форк на kddkit.dev резался до kddkit и уходил в 404
  it.each([
    ['https://github.com/acme/name.dev.git', 'name.dev'],
    ['https://github.com/acme/name.git', 'name'],
    ['https://github.com/acme/name', 'name'],
    ['git+https://github.com/acme/name.dev.git', 'name.dev'],
    ['git@github.com:acme/name.git', 'name'],
  ])('parses %s', (url, repo) => {
    expect(parseRepoUrl(url)).toEqual({ owner: 'acme', repo });
  });

  it('returns null when the url is not a GitHub one', () => {
    expect(parseRepoUrl('https://gitlab.com/acme/name.git')).toBeNull();
    expect(parseRepoUrl('')).toBeNull();
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

  // репозиторий без релизов — стабильное состояние, а не сбой: под ошибочным TTL
  // форк долбился бы в GitHub двенадцать раз в час вечно
  it('caches an empty release list under the success TTL, not the error one', async () => {
    const { fetchImpl } = ghStub([]);
    await releaseInfo({ fetch: fetchImpl });
    expect((_cacheUntil() ?? 0) - Date.now()).toBeGreaterThan(10 * 60 * 1000);
  });

  it('caches a genuine failure under the short TTL', async () => {
    const { fetchImpl } = ghStub({}, { status: 403, statusText: 'rate limit exceeded' });
    await releaseInfo({ fetch: fetchImpl });
    expect((_cacheUntil() ?? 0) - Date.now()).toBeLessThan(10 * 60 * 1000);
  });

  it('skips a malformed row instead of losing the whole feed', async () => {
    const good = Array.from({ length: 9 }, (_, i) => row({ tag_name: `v0.${i}.0` }));
    const { fetchImpl } = ghStub([good[0], null, ...good.slice(1)]);
    const info = await releaseInfo({ fetch: fetchImpl });
    expect(info.releases).toHaveLength(9);
    expect(info.error).toBeNull();
  });

  it('skips a row whose tag_name is not a string', async () => {
    const { fetchImpl } = ghStub([row({ tag_name: 42 }), row()]);
    const info = await releaseInfo({ fetch: fetchImpl });
    expect(info.releases.map((r) => r.version)).toEqual(['0.9.0']);
    expect(info.error).toBeNull();
  });

  // N вкладок, открытых разом, обязаны стоить один запрос из 60 в час
  it('shares one fetch between concurrent callers', async () => {
    const { fetchImpl, calls } = ghStub([row()]);
    const [a, b] = await Promise.all([
      releaseInfo({ fetch: fetchImpl }),
      releaseInfo({ fetch: fetchImpl }),
    ]);
    expect(calls.n).toBe(1);
    expect(a).toEqual(b);
    expect(a).not.toBe(b); // каждый получает свой клон
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

  it('swallows a thrown fetch into a fixed error, not the raw exception message', async () => {
    // сообщение исключения (стектрейс, внутренние детали) не должно всплывать в UI
    // как будто это диагноз; сама причина уходит в stderr процесса
    const boom = (async () => { throw new Error('getaddrinfo ENOTFOUND'); }) as
      unknown as typeof globalThis.fetch;
    const info = await releaseInfo({ fetch: boom });
    expect(info.error).toBe('release check failed');
  });

  // Таблица вырезания HTML: слева — что приезжает из GitHub, справа — что видит попап.
  it.each([
    ['Fixed in <samp>(cc674)</samp>.', 'Fixed in (cc674).'],
    ['[<samp>(cc674)</samp>](https://x.dev)', '[(cc674)](https://x.dev)'],
    ['<details><summary>x</summary>body</details>', 'xbody'],
    ['one<br>two', 'onetwo'],
    ['<img src="https://x.dev/a.png" alt="a">shot', 'shot'],
    ['<https://example.com>', '<https://example.com>'],
    ['<me@example.com>', '<me@example.com>'],
    ['a<b and c>d', 'a<b and c>d'],
    ['```html\n<details>keep</details>\n```', '```html\n<details>keep</details>\n```'],
    ['inline `<br>` stays', 'inline `<br>` stays'],
  ])('strips %j', async (body, want) => {
    const { fetchImpl } = ghStub([row({ body })]);
    const info = await releaseInfo({ fetch: fetchImpl });
    expect(info.releases[0]?.body).toBe(want);
  });

  it('coerces non-string GitHub fields instead of propagating them as objects', async () => {
    const { fetchImpl } = ghStub([
      row({ body: { a: 1 }, published_at: null, html_url: 42 }),
    ]);
    const info = await releaseInfo({ fetch: fetchImpl });
    const r = info.releases[0] as Release;
    expect(typeof r.body).toBe('string');
    expect(typeof r.publishedAt).toBe('string');
    expect(typeof r.url).toBe('string');
  });

  it('serves the second call from cache', async () => {
    const { fetchImpl, calls } = ghStub([row()]);
    await releaseInfo({ fetch: fetchImpl });
    await releaseInfo({ fetch: fetchImpl });
    expect(calls.n).toBe(1);
  });
});
