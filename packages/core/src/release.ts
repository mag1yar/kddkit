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
