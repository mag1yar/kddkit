// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import App from '../src/web/App';
import { STATUSES, projectHref, type Board, type Task } from '../src/web/api';

const task = (over: Partial<Task> = {}): Task => ({
  id: 1, title: 'do a thing', body: null, status: 'new', blocked: 0, block_reason: null,
  priority: 'medium', kind: 'feature', area: null, track_id: null, ready: 1,
  criteria_checked: 0, criteria_total: 0, created_at: 0, updated_at: 0, ...over,
});

// Единственный мок здесь — сетевая граница (fetch), ровно как в серверных тестах единственная
// подмена — путь к базе. Всё остальное настоящее: настоящий App, настоящие хуки, настоящий DOM.
function stubFetch(): Map<string, number> {
  const calls = new Map<string, number>();
  const board = Object.fromEntries(STATUSES.map((s) => [s, []])) as unknown as Board;
  board.new.push(
    task({ id: 1, title: 'fix login bug' }),
    task({ id: 2, title: 'write docs' }),
  );
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

// Фильтр обязан переживать перезагрузку и уезжать в ссылку — иначе им нельзя поделиться,
// а «пустая доска» после F5 читается как потеря задач.
describe('filter in the URL', () => {
  it('starts filtered when the address bar says so', async () => {
    stubFetch();
    await act(async () => {
      window.history.replaceState({}, '', '/?project=abc123&kind=bug');
      render(<App />);
    });
    expect(screen.getByRole('button', { name: 'Kind: bug' })).toBeTruthy();
  });

  it('mirrors the filter into the address bar and keeps the project there', async () => {
    vi.useFakeTimers();
    stubFetch();
    await act(async () => { mount(); });
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: 'воркер' } });
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    const q = new URLSearchParams(location.search);
    expect(q.get('q')).toBe('воркер');
    expect(q.get('project')).toBe('abc123');
  });

  // Ревью: replaceState на каждую букву. Firefox и Safari режут примерно на 100 вызовах
  // за 30 секунд — при быстром наборе браузер начинает глотать обновления, и перезагрузка
  // воспроизводит устаревший фильтр. Дебаунсится ТОЛЬКО запись в URL: сама доска обязана
  // фильтроваться на каждой букве, иначе поиск ощущается сломанным.
  it('writes the URL once for a burst of keystrokes while filtering on every one', async () => {
    vi.useFakeTimers();
    stubFetch();
    await act(async () => { mount(); });
    const spy = vi.spyOn(history, 'replaceState');
    const input = screen.getByPlaceholderText('Search…');
    for (const v of ['l', 'lo', 'log']) {
      await act(async () => { fireEvent.change(input, { target: { value: v } }); });
    }
    expect(screen.queryByText('write docs')).toBeNull(); // отфильтровалось сразу
    expect(screen.getByText('fix login bug')).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();                  // а запись отложена

    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(new URLSearchParams(location.search).get('q')).toBe('log');
  });

  // Ревью: ничего не падает, если fullBoard[to] и board[to] в Board.tsx перепутаны местами —
  // нужен тест, который реально прячет карточку через фильтр из URL, а не просто читает JSON.
  it('a URL filter hides the non-matching card and keeps the matching one', async () => {
    stubFetch();
    await act(async () => {
      window.history.replaceState({}, '', '/?project=abc123&q=login');
      render(<App />);
    });
    expect(screen.getByText('fix login bug')).toBeTruthy();
    expect(screen.queryByText('write docs')).toBeNull();
  });
});
