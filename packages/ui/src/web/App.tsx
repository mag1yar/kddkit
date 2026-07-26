import { useCallback, useEffect, useState } from 'react';
import { Toaster, toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Check, ExternalLink, Plus, Settings, Trash2 } from 'lucide-react';
import {
  Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  STATUSES, deleteTrack, getBoard, getPing, getProjects, getTracks, moveTask, projectHref, setTrackDone,
  type Board as BoardData, type Project, type Status, type Track,
} from './api';
import { AutoTickPopover } from './components/AutoTickPopover';
import { Board } from './components/Board';
import { NewTaskDialog } from './components/NewTaskDialog';
import { NewTrackDialog } from './components/NewTrackDialog';
import { ReleasesPopover } from './components/ReleasesPopover';
import { TaskDialog } from './components/TaskDialog';
import { useAutoTick } from './useAutoTick';
import { useReleases } from './useReleases';
import { useVersion } from './useVersion';

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
  const [track, setTrack] = useState<number | null>(null); // фильтр доски по track (all=null)
  const [trackMenu, setTrackMenu] = useState(false); // popover действий над текущим треком
  const current = new URLSearchParams(location.search).get('project') ?? '';
  const version = useVersion();
  const releases = useReleases();
  const autoTick = useAutoTick();

  const loadTracks = useCallback(
    () => getTracks().then(setTracks).catch((e: Error) => toast.error(e.message)), []);
  useEffect(() => {
    getProjects().then(setProjects).catch((e: Error) => toast.error(e.message));
    void loadTracks();
    setTrack(null); // смена проекта → сброс фильтра track
    // нет ?project в URL → берём дефолт сервера и фиксируем в URL (select + доска синхронны)
    if (!current) getPing().then((p) => { if (p.default) location.replace(projectHref(p.default)); }).catch(() => {});
  }, [current, loadTracks]);

  const trackName = new Map(tracks.map((t) => [t.id, t.name]));
  const currentTrack = tracks.find((t) => t.id === track);
  const markDone = () => { // like a gsd milestone complete: задачи остаются, track → done
    if (track === null) return;
    setTrackDone(track).then(() => { setTrack(null); return loadTracks(); })
      .catch((e: Error) => toast.error(e.message));
  };
  const removeTrack = () => {
    if (track === null || !window.confirm(`Delete track "${currentTrack?.name}"? Tasks stay, only the grouping is removed.`)) return;
    deleteTrack(track).then(() => { setTrack(null); return loadTracks(); })
      .catch((e: Error) => toast.error(e.message));
  };
  const refetch = useCallback(() => {
    getBoard(track ?? undefined).then(setBoard)
      .catch((e: Error) => toast.error(e.message));
  }, [track]);
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
  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-semibold">kdd</h1>
          <ReleasesPopover info={releases} />
          <Select value={current} onValueChange={(id) => { if (id) location.assign(projectHref(id)); }}>
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
          {/* Select + иконка-действий сшиты вручную (rounded-r-none/-l-none): shadcn-вид без хрупкого ButtonGroup */}
          <div className="flex items-center">
            <Select
              value={track === null ? 'all' : String(track)}
              onValueChange={(v) => {
                if (v === '__new__') { setCreatingTrack(true); return; } // не меняем фильтр
                setTrack(v === 'all' ? null : Number(v));
              }}
            >
              <SelectTrigger
                size="sm"
                // ширина по контенту (база w-fit) с потолком → длинное имя обрезается ellipsis, а не рубится;
                // rounded-r-none! : перебить data-[size=sm]:rounded-[…] в базе триггера (вариант выше специфичности)
                className={
                  track === null
                    ? 'min-w-40 max-w-64'
                    : 'min-w-40 max-w-64 rounded-r-none! border-r-0!'
                }
              >
                <SelectValue className="min-w-0" placeholder="All tracks">
                  {(v) => (v === 'all' ? 'All tracks' : trackName.get(Number(v)) ?? '')}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All tracks</SelectItem>
                {tracks.map((t) => (
                  <SelectItem key={t.id} value={String(t.id)}>
                    {t.name} ({t.open_tasks})
                  </SelectItem>
                ))}
                <SelectSeparator />
                <SelectItem value="__new__">
                  <Plus className="size-3.5" /> New track
                </SelectItem>
              </SelectContent>
            </Select>
            {track !== null && (
              <Popover open={trackMenu} onOpenChange={setTrackMenu}>
                <PopoverTrigger
                  render={
                    <Button size="sm" variant="outline" title="Track actions" className="rounded-l-none!">
                      <Settings className="size-3.5" />
                    </Button>
                  }
                />
                <PopoverContent align="end" sideOffset={4} className="w-44 gap-1 p-1">
                  <Button
                    size="sm" variant="ghost" className="w-full justify-start"
                    onClick={() => { markDone(); setTrackMenu(false); }}
                  >
                    <Check className="size-3.5" /> Mark done
                  </Button>
                  <Button
                    size="sm" variant="ghost"
                    className="w-full justify-start text-destructive hover:text-destructive"
                    onClick={() => { removeTrack(); setTrackMenu(false); }}
                  >
                    <Trash2 className="size-3.5" /> Delete track
                  </Button>
                </PopoverContent>
              </Popover>
            )}
          </div>
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
      <main className="flex-1 overflow-auto">
        {/* бейдж трека на карточке — только в режиме all tracks: внутри трека он шум */}
        <Board board={board} trackName={track == null ? trackName : new Map()}
          onMove={onMove} onOpen={setOpenId} />
      </main>
      <TaskDialog
        id={openId} version={version} tracks={tracks}
        onClose={() => setOpenId(null)} onChanged={refetch}
      />
      <NewTaskDialog
        open={creating} tracks={tracks} defaultTrack={track}
        onClose={() => setCreating(false)} onCreated={refetch}
      />
      <NewTrackDialog
        open={creatingTrack}
        onClose={() => setCreatingTrack(false)}
        onCreated={(t) => { setTrack(t.id); void loadTracks(); }} // фильтруем на новый track
      />
      <Toaster position="bottom-right" />
    </div>
  );
}
