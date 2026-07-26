// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import App from '../src/web/App';
import { STATUSES, projectHref, type Board } from '../src/web/api';

// Единственный мок здесь — сетевая граница (fetch), ровно как в серверных тестах единственная
// подмена — путь к базе. Всё остальное настоящее: настоящий App, настоящие хуки, настоящий DOM.
function stubFetch(): Map<string, number> {
  const calls = new Map<string, number>();
  const board = Object.fromEntries(STATUSES.map((s) => [s, []])) as unknown as Board;
  const body = (path: string): unknown => {
    if (path.startsWith('/api/version')) return { version: 1 };
    if (path.startsWith('/api/releases')) {
      return { current: '0.5.0', latest: '0.5.0', hasUpdate: false, releases: [], repoUrl: null, error: null };
    }
    if (path.startsWith('/api/autotick')) {
      return { enabled: false, intervalSec: 60, maxWorkers: 3, maxWorkersEnvLocked: false,
        last: null, nextAt: null, running: false };
    }
    if (path.startsWith('/api/ping')) return { kdd: true, default: 'abc123def4567890', needsToken: true };
    if (path.startsWith('/api/board')) return board;
    return []; // /api/projects, /api/tracks
  };
  vi.stubGlobal('fetch', (input: string) => {
    const path = String(input).split('?')[0];
    calls.set(path, (calls.get(path) ?? 0) + 1);
    return Promise.resolve(
      { ok: true, status: 200, json: () => Promise.resolve(body(path)) } as Response);
  });
  return calls;
}

// ?project в URL: без него App делает location.replace на дефолт сервера, а в jsdom это
// не навигация, а шумная заглушка — тест проверял бы поведение окружения, не приложения.
const mount = () => {
  window.history.replaceState({}, '', '/?project=abc123');
  return render(<App />);
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('App', () => {
  it('mounts and renders the board columns', async () => {
    stubFetch();
    await act(async () => { mount(); });
    expect(screen.getByText('In Progress')).toBeTruthy();
  });

  // Инвариант панели релизов: /api/releases — ОДИН запрос на монтирование. Рядом useVersion
  // поллит /api/version каждые 2 с, и лишняя зависимость в useEffect'е useReleases превратила
  // бы часовой серверный кэш в поллер к GitHub: 60 запросов в час на IP выгорают молча.
  it('fetches /api/releases exactly once while /api/version keeps polling', async () => {
    vi.useFakeTimers();
    const calls = stubFetch();
    await act(async () => { mount(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); }); // ~10 тиков версии

    expect(calls.get('/api/releases')).toBe(1);
    expect(calls.get('/api/version')).toBeGreaterThan(5);
  });
});

// Ревью: App переписывал location на голый `?project=<hash>`, теряя токен, — после чего
// каждый запрос отвечал 401 и вкладка застревала на пустой доске с тостами ошибок. Проверяем
// сам построитель ссылки: подменить location.replace в jsdom нельзя (свойство unforgeable),
// а оба места в App теперь зовут именно его.
describe('projectHref', () => {
  it('keeps the token while switching project', () => {
    window.history.replaceState({}, '', '/?project=old&token=s3cret');
    const q = new URLSearchParams(projectHref('new'));
    expect(q.get('project')).toBe('new');
    expect(q.get('token')).toBe('s3cret');
  });

  it('adds nothing that was not in the URL', () => {
    window.history.replaceState({}, '', '/');
    expect(projectHref('abc')).toBe('?project=abc');
  });
});
