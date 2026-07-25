import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface PackageJson {
  version?: string;
  repository?: { url?: string } | string;
}

let pkgCache: PackageJson | null = null;

// dist/index.js → ../package.json: путь одинаков и в монорепо, и в установленном пакете,
// потому что tsup кладёт dist/ рядом с package.json. Читаем один раз.
function pkg(): PackageJson {
  if (pkgCache) return pkgCache;
  try {
    pkgCache = JSON.parse(
      readFileSync(join(import.meta.dirname, '../package.json'), 'utf8'),
    ) as PackageJson;
  } catch {
    pkgCache = {};
  }
  return pkgCache;
}

/** Версия kdd. Все пакеты бампаются в локстепе (bumpp --all), поэтому версия core — общая. */
export function kddVersion(): string {
  return pkg().version ?? '0.0.0';
}

/** Слаг выводим из package.json, а не хардкодим: форк не должен поллить апстрим. */
export function repoSlug(): { owner: string; repo: string } | null {
  const r = pkg().repository;
  const url = typeof r === 'string' ? r : r?.url ?? '';
  const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}

function parse(v: string): { core: [number, number, number]; pre: string } {
  const [core, ...rest] = v.replace(/^v/, '').split('-');
  const n = core.split('.').map((x) => Number.parseInt(x, 10) || 0);
  return { core: [n[0] ?? 0, n[1] ?? 0, n[2] ?? 0], pre: rest.join('-') };
}

/**
 * >0 если a новее b. Хватает MAJOR.MINOR.PATCH[-PRERELEASE] — полный semver не нужен,
 * зависимость ради этого не тянем.
 */
export function compareVersions(a: string, b: string): number {
  const A = parse(a);
  const B = parse(b);
  for (let i = 0; i < 3; i++) if (A.core[i] !== B.core[i]) return A.core[i] - B.core[i];
  if (!A.pre && B.pre) return 1; // релиз старше prerelease при равном ядре
  if (A.pre && !B.pre) return -1;
  return A.pre < B.pre ? -1 : A.pre > B.pre ? 1 : 0;
}

export interface Release {
  version: string;
  url: string;
  body: string;
  publishedAt: string;
  prerelease: boolean;
}

export interface ReleaseInfo {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  releases: Release[];
  repoUrl: string | null;
  error: string | null;
}

interface GhRelease {
  tag_name?: string;
  html_url?: string;
  body?: string;
  published_at?: string;
  draft?: boolean;
  prerelease?: boolean;
}

const OK_TTL = 60 * 60 * 1000;
const ERR_TTL = 5 * 60 * 1000;

let cache: { at: number; info: ReleaseInfo } | null = null;

/** Только для тестов: сбросить кэш между кейсами. */
export function _resetCache(): void {
  cache = null;
}

/**
 * Список релизов с GitHub + вывод «есть ли апдейт». Никогда не бросает: любой отказ
 * сводится к error-строке, current при этом на месте (читается локально).
 *
 * Кэш в памяти обязателен, а не желателен: лимит GitHub без токена — 60 запросов в час
 * на IP, а UI открыт постоянно. Ошибку кэшируем тоже, иначе ретраи выжигают лимит быстрее
 * успехов. fetch пробрасывается параметром — так тесты идут без сети.
 */
export async function releaseInfo(
  opts: { fetch?: typeof globalThis.fetch } = {},
): Promise<ReleaseInfo> {
  const now = Date.now();
  // cache.info — синглтон, общий на все вызовы. Отдаём клон и на хите, и при записи:
  // UI кладёт releases прямо в React state и может .sort()/.reverse() их на месте —
  // без клона такая мутация тихо портит кэш для всех последующих вызовов до истечения TTL.
  if (cache && now - cache.at < (cache.info.error ? ERR_TTL : OK_TTL)) {
    return structuredClone(cache.info);
  }

  const current = kddVersion();
  const slug = repoSlug();
  const repoUrl = slug ? `https://github.com/${slug.owner}/${slug.repo}` : null;

  const store = (info: ReleaseInfo): ReleaseInfo => {
    cache = { at: now, info };
    return structuredClone(info);
  };

  const fail = (error: string): ReleaseInfo => store({
    current, latest: null, hasUpdate: false, releases: [], repoUrl, error,
  });

  if (!slug) return fail('no repository url in package.json');

  try {
    const f = opts.fetch ?? globalThis.fetch;
    // /releases, а не /releases/latest: последний выкидывает prerelease и отдаёт 404,
    // когда стабильных релизов ещё нет.
    const res = await f(
      `https://api.github.com/repos/${slug.owner}/${slug.repo}/releases?per_page=10`,
      {
        headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) return fail(`GitHub API ${res.status} ${res.statusText}`);

    const rows = (await res.json()) as GhRelease[];
    if (!Array.isArray(rows)) return fail('unexpected GitHub response');

    const releases: Release[] = rows
      .filter((r) => !r.draft && r.tag_name)
      .map((r) => ({
        version: (r.tag_name as string).replace(/^v/, ''),
        url: r.html_url ?? `${repoUrl}/releases`,
        body: r.body ?? '',
        publishedAt: r.published_at ?? '',
        prerelease: Boolean(r.prerelease),
      }));
    if (releases.length === 0) return fail('no published releases');

    // latest — старший стабильный. prerelease в баннер не идут: до переключателя канала
    // стабильному пользователю не должно прилетать «обновись на 0.6.0-next.3».
    const latest = releases
      .filter((r) => !r.prerelease)
      .reduce<string | null>(
        (m, r) => (m === null || compareVersions(r.version, m) > 0 ? r.version : m), null);

    return store({
      current,
      latest,
      hasUpdate: latest !== null && compareVersions(latest, current) > 0,
      releases,
      repoUrl,
      error: null,
    });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}
