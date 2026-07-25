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

/**
 * Разбор `repository.url`. Суффикс `.git` снимаем отдельным шагом, а не запретом точек
 * в имени: имя репозитория точки содержать может (`acme/kddkit.dev.git`), и запрет резал
 * его до `kddkit` — форк уходил в вечный 404 ровно в том сценарии, ради которого слаг
 * вообще выводится из package.json.
 */
export function parseRepoUrl(url: string): { owner: string; repo: string } | null {
  const m = url.replace(/\.git\/?$/i, '').match(/github\.com[/:]([^/]+)\/([^/]+)/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** Слаг выводим из package.json, а не хардкодим: форк не должен поллить апстрим. */
export function repoSlug(): { owner: string; repo: string } | null {
  const r = pkg().repository;
  return parseRepoUrl(typeof r === 'string' ? r : r?.url ?? '');
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

// Тело релиза — не только вывод changelogithub (<samp> вокруг short sha): заметку
// правят руками на github.com, и оттуда приезжают <details>/<summary>/<br>/<img>.
// Поэтому вместо одного тега режем белый список имён, а не «что угодно похожее на тег»:
// открытый паттерн съедал бы markdown-автоссылки (<https://...>, <me@example.com>).
// Однобуквенных имён (a, b, i, p, s, u) в списке нет намеренно: '<b and c>' в прозе
// синтаксически неотличим от тега <b> с атрибутами, и отличить их регуляркой нельзя.
const TAG_STRIP_RE =
  /<\/?(?:details|summary|br|hr|img|picture|source|video|audio|div|span|table|thead|tbody|tfoot|tr|td|th|caption|ul|ol|li|dl|dt|dd|h[1-6]|blockquote|pre|code|kbd|samp|var|sub|sup|em|strong|small|del|ins|mark|abbr|center|font)\b[^>]*>/gi;

// Внутри code-фенсов и inline-кода теги — это текст, который автор показывает читателю.
// split с группой захвата кладёт разделители на нечётные индексы, их и пропускаем нетронутыми.
function stripHtml(md: string): string {
  return md
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(TAG_STRIP_RE, '')))
    .join('');
}

const OK_TTL = 60 * 60 * 1000;
const ERR_TTL = 5 * 60 * 1000;

let cache: { until: number; info: ReleaseInfo } | null = null;
let inflight: Promise<ReleaseInfo> | null = null;

/** Только для тестов: сбросить кэш между кейсами. */
export function _resetCache(): void {
  cache = null;
  inflight = null;
}

/** Только для тестов: момент истечения кэша — чтобы проверять, каким TTL накрыт кейс. */
export function _cacheUntil(): number | null {
  return cache?.until ?? null;
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
  // cache.info — синглтон, общий на все вызовы. Отдаём клон и на хите, и при записи:
  // сегодня единственный вызывающий — Hono-роут, который сразу JSON.stringify'ит
  // результат, так что мутировать общий объект in-process некому. Клон — дешёвая
  // страховка на будущего consumer (CLI), который может держать ссылку дольше
  // одного запроса, а не защита от существующего бага.
  if (cache && Date.now() < cache.until) return structuredClone(cache.info);

  // Держим сам промис, а не только осевший результат: кэш пишется после await, поэтому
  // без этого N вкладок, открытых одновременно, промахивались бы мимо гарда и тратили
  // N запросов из 60 в час. Обещание «один фетч на процесс» держится именно здесь.
  inflight ??= load(opts).finally(() => { inflight = null; });
  return structuredClone(await inflight);
}

async function load(opts: { fetch?: typeof globalThis.fetch }): Promise<ReleaseInfo> {
  const current = kddVersion();
  const slug = repoSlug();
  const repoUrl = slug ? `https://github.com/${slug.owner}/${slug.repo}` : null;

  // until отсчитываем от момента ответа, а не от входа в функцию: медленный ответ
  // иначе ложился бы в кэш уже подстаревшим.
  const store = (info: ReleaseInfo, ttl: number): ReleaseInfo => {
    cache = { until: Date.now() + ttl, info };
    return info;
  };

  const fail = (error: string, ttl = ERR_TTL): ReleaseInfo => store({
    current, latest: null, hasUpdate: false, releases: [], repoUrl, error,
  }, ttl);

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

    // Битую строку пропускаем, а не роняем на ней весь фид: GitHub отдаёт JSON без
    // схемы, и один null или tag_name не-строкой стоил бы пользователю всего списка —
    // да ещё и с кэшированием этой «ошибки» на пять минут.
    // String(...) на трёх полях ниже по той же причине: не-строка в body/published_at/
    // html_url уронила бы .replace() уже в клиенте (ErrorBoundary в packages/ui нет).
    const releases: Release[] = rows.flatMap((r) => (
      r && typeof r === 'object' && typeof r.tag_name === 'string' && !r.draft
        ? [{
          version: r.tag_name.replace(/^v/, ''),
          url: String(r.html_url ?? `${repoUrl}/releases`),
          body: stripHtml(String(r.body ?? '')),
          publishedAt: String(r.published_at ?? ''),
          prerelease: Boolean(r.prerelease),
        }]
        : []
    ));
    // Не поломка, а состояние свежесозданного репозитория — состояние стабильное,
    // поэтому живёт под успешным TTL: под ошибочным форк без релизов ходил бы
    // в GitHub двенадцать раз в час вечно.
    if (releases.length === 0) return fail('no published releases', OK_TTL);

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
    }, OK_TTL);
  } catch (e) {
    // Наружу — стабильная строка: e.message может оказаться внутренним TypeError,
    // и в тултипе чипа он ничего не объясняет, зато раскрывает детали реализации.
    // Причину пишем в stderr процесса: без неё TLS-прокси, DNS-блок, пятисекундный
    // таймаут и неразобранное тело неотличимы друг от друга, а неверный диагноз
    // ещё и кэшируется на пять минут. Формулировка нейтральная — «не дошли до GitHub»
    // враньё для случая, когда GitHub ответил, но телом, которое не разобрать.
    console.error('[kdd] release check failed:', e);
    return fail('release check failed');
  }
}
