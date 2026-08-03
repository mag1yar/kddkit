import { useCallback, useEffect, useState } from 'react';
import { Toaster, toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ExternalLink } from 'lucide-react';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  STATUSES, deleteTrack, getBoard, getPing, getProjects, getTracks, moveTask, projectHref, setTrackDone,
  type Board as BoardData, type Project, type Status, type Track,
} from './api';
import { AutoTickPopover } from './components/AutoTickPopover';
import { Board } from './components/Board';
import { FilterBar } from './components/FilterBar';
import { NewTaskDialog } from './components/NewTaskDialog';
import { NewTrackDialog } from './components/NewTrackDialog';
import { ReleasesPopover } from './components/ReleasesPopover';
import { TaskDialog } from './components/TaskDialog';
import { useAutoTick } from './useAutoTick';
import { useReleases } from './useReleases';
import { useVersion } from './useVersion';
import {
  FILTER_KEYS, applyFilters, parseFilters, serializeFilters, stripFilterKeys, type Filters,
} from './filters';

// git-common-dir оканчивается на /.git — показываем имя репо.
const projectName = (path: string) =>
  path.replace(/[/\\]\.git[/\\]?$/, '').split(/[/\\]/).filter(Boolean).slice(-1)[0] ?? path;

export default function App() {
  const [board, setBoard] = useState<BoardData | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [creatingTrack, setCreatingTrack] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [filters, setFilters] = useState<Filters>(
    () => parseFilters(new URLSearchParams(location.search)));
  const current = new URLSearchParams(location.search).get('project') ?? '';
  const version = useVersion();
  const releases = useReleases();
  const autoTick = useAutoTick();

  const loadTracks = useCallback(
    () => getTracks().then(setTracks).catch((e: Error) => toast.error(e.message)), []);
  useEffect(() => {
    getProjects().then(setProjects).catch((e: Error) => toast.error(e.message));
    void loadTracks();
    // нет ?project в URL → берём дефолт сервера и фиксируем в URL (select + доска синхронны)
    if (!current) getPing().then((p) => { if (p.default) location.replace(projectHref(p.default)); }).catch(() => {});
  }, [current, loadTracks]);

  // replaceState, а не push: иначе каждая буква в поиске добавляла бы запись в историю
  // и «назад» переставало работать. project/token сохраняются — их пишет не фильтр.
  useEffect(() => {
    const p = new URLSearchParams(location.search);
    for (const key of FILTER_KEYS) p.delete(key);
    for (const [key, value] of serializeFilters(filters)) p.set(key, value);
    const qs = p.toString();
    history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}`);
  }, [filters]);

  const trackName = new Map(tracks.map((t) => [t.id, t.name]));
  const markDone = (id: number) => { // like a gsd milestone complete: задачи остаются, track → done
    setTrackDone(id).then(() => { setFilters((f) => ({ ...f, track: [] })); return loadTracks(); })
      .catch((e: Error) => toast.error(e.message));
  };
  const removeTrack = (id: number) => {
    const name = tracks.find((t) => t.id === id)?.name;
    if (!window.confirm(`Delete track "${name}"? Tasks stay, only the grouping is removed.`)) return;
    deleteTrack(id).then(() => { setFilters((f) => ({ ...f, track: [] })); return loadTracks(); })
      .catch((e: Error) => toast.error(e.message));
  };
  const refetch = useCallback(() => {
    getBoard().then(setBoard)
      .catch((e: Error) => toast.error(e.message));
  }, []);
  useEffect(() => { refetch(); void loadTracks(); }, [refetch, version, loadTracks]); // поллинг: version растёт → рефетч доски + счётчиков треков (UI-04)

  const onMove = (taskId: number, to: Status, order: number[]) => {
    setBoard((b) => { // оптимистично: карточка в новой колонке + порядок как order
      if (!b) return b;
      const task = STATUSES.flatMap((s) => b[s]).find((t) => t.id === taskId);
      if (!task) return b;
      const next = Object.fromEntries(
        STATUSES.map((s) => [s, b[s].filter((t) => t.id !== taskId)]),
      ) as BoardData;
      const rank = new Map(order.map((id, i) => [id, i]));
      next[to] = [...next[to], { ...task, status: to }]
        .sort((a, c) => (rank.get(a.id) ?? 0) - (rank.get(c.id) ?? 0));
      return next;
    });
    moveTask(taskId, to, order)
      .catch((e: Error) => toast.error(e.message)) // refetch в finally откатит
      .finally(refetch);
  };

  if (!board) return null;
  const visible = applyFilters(board, filters);
  const total = STATUSES.reduce((n, s) => n + board[s].length, 0);
  const shown = STATUSES.reduce((n, s) => n + visible[s].length, 0);
  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-semibold">kdd</h1>
          <ReleasesPopover info={releases} />
          <Select
            value={current}
            onValueChange={(id) => {
              // track id per-database: тащить фильтр в другой проект значило бы фильтровать
              // по чужому track и увидеть "0 / N" без причины.
              if (id) location.assign(stripFilterKeys(projectHref(id)));
            }}
          >
            <SelectTrigger size="sm" className="w-52">
              <SelectValue placeholder="Project">
                {(v) => projectName(projects.find((p) => p.id === v)?.path ?? '')}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>{projectName(p.path)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <AutoTickPopover
            state={autoTick.state} patch={autoTick.patch} refresh={autoTick.refresh}
            error={autoTick.error} clearError={autoTick.clearError}
          />
          {releases?.repoUrl && (
            <Button
              size="sm" variant="ghost"
              // текстовая кнопка, а не иконка-логотип: в lucide-react v1 брендовых иконок нет
              render={<a href={releases.repoUrl} target="_blank" rel="noreferrer" />}
            >
              GitHub <ExternalLink />
            </Button>
          )}
          <Button size="sm" onClick={() => setCreating(true)}>New task</Button>
        </div>
      </header>
      <FilterBar
        filters={filters} onChange={setFilters} board={board}
        visibleCount={shown} totalCount={total} tracks={tracks}
        onNewTrack={() => setCreatingTrack(true)}
        onTrackDone={markDone} onTrackDelete={removeTrack}
      />
      {/* overflow-y-hidden: вертикально скроллит каждая колонка сама (Board), не страница —
          иначе колонки нельзя растянуть на всю высоту */}
      <main className="flex-1 overflow-x-auto overflow-y-hidden">
        {/* бейдж трека на карточке — шум, когда доска и так сужена до одного трека */}
        <Board
          board={visible} fullBoard={board}
          trackName={filters.track.length === 1 ? new Map() : trackName}
          onMove={onMove} onOpen={setOpenId}
        />
      </main>
      <TaskDialog
        id={openId} version={version} tracks={tracks}
        onClose={() => setOpenId(null)} onChanged={refetch}
      />
      <NewTaskDialog
        open={creating} tracks={tracks}
        defaultTrack={filters.track.length === 1 ? filters.track[0] : null}
        onClose={() => setCreating(false)} onCreated={refetch}
      />
      <NewTrackDialog
        open={creatingTrack}
        onClose={() => setCreatingTrack(false)}
        onCreated={(t) => { setFilters((f) => ({ ...f, track: [t.id] })); void loadTracks(); }} // фильтруем на новый track
      />
      <Toaster position="bottom-right" />
    </div>
  );
}
