import { useEffect, useState, type ReactNode } from 'react';
import { Ban, Link2, ListPlus, Pencil, Send, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { AgentFeed } from './AgentFeed';
import { History } from './History';
import { MarkdownEditor } from './MarkdownEditor';
import { Prose } from './Prose';
import {
  PRIORITIES, STATUSES, addComment, addCriterion, blockTask, editTask, getTask, moveTask,
  removeCriterion, setCriterionChecked, unblockTask,
  type Criterion, type Priority, type Status, type Task, type TaskDetail,
  type Track,
} from '../api';

const STATUS_LABEL: Record<Status, string> = {
  backlog: 'Backlog', new: 'New', in_progress: 'In Progress', review: 'Review', done: 'Done',
};
const fmtDate = (ts: number) => new Date(ts * 1000).toLocaleString();

export function TaskDialog({ id, version, tracks, onClose, onChanged }: {
  id: number | null; version: number; tracks: Track[];
  onClose: () => void; onChanged: () => void;
}) {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [comment, setComment] = useState('');
  // черновик критерия живёт здесь, а не в CriteriaList: закрытие диалога обязано о нём знать
  const [criterion, setCriterion] = useState('');
  const [discard, setDiscard] = useState(false);
  const [tab, setTab] = useState<'comments' | 'history' | 'activity'>('comments');

  const reload = () => getTask(id!).then(setDetail).catch((e: Error) => toast.error(e.message));
  useEffect(() => {
    if (id === null) { setDetail(null); setEditing(false); return; }
    getTask(id).then(setDetail).catch((e: Error) => toast.error(e.message));
  }, [id, version]); // version: изменения из CLI подтягиваются в открытый диалог

  // Черновики принадлежат задаче: без сброса текст, набранный в одной, всплывал в следующей.
  // Отдельный эффект — на id, НЕ на version: version дёргает каждая галочка в чеклисте,
  // и общий эффект стирал бы недописанный комментарий на ровном месте.
  useEffect(() => { setComment(''); setCriterion(''); setDiscard(false); }, [id]);
  // Правка черновика снимает разрешение выбросить его: «закрыть ещё раз» относится
  // к тому тексту, о котором предупредили, а не к следующему.
  useEffect(() => { setDiscard(false); }, [comment, criterion]);

  if (id === null || !detail) return null;
  const { task, criteria, comments, events, links, agent_runs_total } = detail;
  const after = () => { onChanged(); return reload(); };

  const submitComment = () => {
    if (!comment.trim()) return;
    addComment(task.id, comment)
      .then(() => { setComment(''); return after(); })
      .catch((e: Error) => toast.error(e.message));
  };
  const changeStatus = (to: Status) => {
    if (to === task.status) return;
    moveTask(task.id, to).then(after).catch((e: Error) => toast.error(e.message));
  };

  // Набранный, но не отправленный текст пропадал молча — критерий без Enter выглядел
  // добавленным, пока задачу не откроют снова. Первое закрытие с черновиком не закрывает,
  // а называет причину; повторное — закрывает (отказ от текста тоже должен быть в один жест).
  const draft = comment.trim() || criterion.trim();
  const tryClose = () => {
    if (!draft || discard) { onClose(); return; }
    setDiscard(true);
    toast.warning('Unsaved text', { description: 'Send it, or close again to discard.' });
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) tryClose(); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="text-muted-foreground">#{task.id}</span>
            <span className="truncate">{task.title}</span>
            {task.blocked === 1 && <Badge variant="destructive">blocked</Badge>}
          </DialogTitle>
        </DialogHeader>

        <div className="grid gap-6 sm:grid-cols-[1fr_13rem]">
          {/* main */}
          <div className="flex min-w-0 flex-col gap-4">
            {editing ? (
              <EditForm
                task={task}
                onSaved={() => { setEditing(false); return after(); }}
                onCancel={() => setEditing(false)}
              />
            ) : (
              <div className="flex flex-col gap-2">
                <Prose>{task.body ?? '_no description_'}</Prose>
                <div>
                  <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                    <Pencil /> Edit
                  </Button>
                </div>
              </div>
            )}

            <CriteriaList
              taskId={task.id} criteria={criteria} onChanged={after}
              text={criterion} setText={setCriterion}
            />

            <Tabs
              value={tab}
              onValueChange={(v) => setTab(v as 'comments' | 'history' | 'activity')}
              className="border-t pt-3"
            >
              <TabsList variant="line">
                <TabsTrigger value="comments">Comments <span className="text-muted-foreground">{comments.length}</span></TabsTrigger>
                <TabsTrigger value="history">History <span className="text-muted-foreground">{events.length}</span></TabsTrigger>
                <TabsTrigger value="activity">Activity <span className="text-muted-foreground">{agent_runs_total}</span></TabsTrigger>
              </TabsList>

              <TabsContent value="comments" className="flex flex-col gap-2 pt-2">
                {comments.map((c) => (
                  <div
                    key={c.id}
                    className={cn('rounded-md border p-2 text-sm', c.author !== 'user' && 'bg-muted')}
                  >
                    <div className="flex items-center gap-2 pb-1 text-xs text-muted-foreground">
                      {c.author !== 'user' && <Badge variant="outline">ai</Badge>}
                      <span>{c.author}</span>
                      <span>{fmtDate(c.created_at)}</span>
                    </div>
                    <Prose>{c.body}</Prose>
                  </div>
                ))}
                <div className="overflow-hidden rounded-md border focus-within:ring-1 focus-within:ring-ring">
                  <MarkdownEditor
                    value={comment}
                    onChange={setComment}
                    onEnterSubmit={submitComment}
                    placeholder="Comment... (Enter to send, Shift+Enter newline)"
                    minHeight="40px"
                    maxHeight="192px"
                  />
                  <div className="flex justify-end p-1.5 pt-0">
                    <Button size="sm" onClick={submitComment}><Send /> Send</Button>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="history" className="pt-2">
                <History events={events} />
              </TabsContent>

              <TabsContent value="activity" className="pt-2">
                <AgentFeed taskId={task.id} />
              </TabsContent>
            </Tabs>
          </div>

          {/* details rail */}
          <aside className="flex flex-col gap-4 text-sm">
            <Field label="Status">
              <Select value={task.status} onValueChange={(v) => changeStatus(v as Status)}>
                <SelectTrigger className="h-8 w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {STATUSES.map((s) => <SelectItem key={s} value={s}>{STATUS_LABEL[s]}</SelectItem>)}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>

            <Field label="Priority">
              <Select
                value={task.priority}
                onValueChange={(v) => editTask(task.id, { priority: v as Priority })
                  .then(after).catch((e: Error) => toast.error(e.message))}
              >
                <SelectTrigger className="h-8 w-full capitalize"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {PRIORITIES.map((p) => (
                      <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>

            <BlockedField task={task} onChanged={after} />

            {tracks.length > 0 && (
              <Field label="Track">
                <Select
                  value={task.track_id === null ? 'none' : String(task.track_id)}
                  onValueChange={(v) =>
                    editTask(task.id, { track_id: v === 'none' ? null : Number(v) })
                      .then(after).catch((e: Error) => toast.error(e.message))}
                >
                  <SelectTrigger className="h-8 w-full">
                    <SelectValue placeholder="No track">
                      {(v) => (v === 'none' ? 'No track'
                        : tracks.find((t) => t.id === Number(v))?.name ?? '')}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No track</SelectItem>
                    {tracks.map((t) => (
                      <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}

            {task.area && <Field label="Area"><span>{task.area}</span></Field>}

            <Field label="Related">
              {links.length === 0
                ? <span className="text-muted-foreground">none</span>
                : (
                  <ul className="flex flex-col gap-1">
                    {links.map((l) => (
                      <li key={l.id} className="flex items-center gap-1 truncate">
                        <Link2 className="size-3 shrink-0 text-muted-foreground" />
                        <span className="text-muted-foreground">#{l.id}</span>
                        <span className="truncate">{l.title}</span>
                      </li>
                    ))}
                  </ul>
                )}
            </Field>

            <Field label="Created"><span className="text-muted-foreground">{fmtDate(task.created_at)}</span></Field>
            <Field label="Updated"><span className="text-muted-foreground">{fmtDate(task.updated_at)}</span></Field>
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CriteriaList({ taskId, criteria, onChanged, text, setText }: {
  taskId: number; criteria: Criterion[]; onChanged: () => void;
  text: string; setText: (v: string) => void;
}) {
  // взведённое удаление; одно на список — взвести второй критерий значит отпустить первый
  const [armed, setArmed] = useState<number | null>(null);
  const err = (e: Error) => toast.error(e.message);
  const done = criteria.filter((c) => c.checked_at !== null).length;
  const add = () => {
    if (!text.trim()) return;
    addCriterion(taskId, text).then(() => { setText(''); onChanged(); }).catch(err);
  };
  return (
    // увели мышь со списка — взвод снят: подтверждение не должно ждать вечно
    <div className="flex flex-col gap-1.5" onMouseLeave={() => setArmed(null)}>
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Criteria{criteria.length > 0 && ` ${done}/${criteria.length}`}
      </span>
      {criteria.map((c) => (
        <div key={c.id} className="group flex items-center gap-2 text-sm">
          <Checkbox
            checked={c.checked_at !== null}
            onCheckedChange={(v) =>
              setCriterionChecked(taskId, c.id, v === true).then(onChanged).catch(err)}
          />
          <span className={cn('flex-1', c.checked_at !== null && 'text-muted-foreground line-through')}>
            {c.text}
          </span>
          {/* Удаление критерия необратимо — undo на доске нет, текст не восстановить.
              Поэтому первый клик взводит, второй удаляет. Раскрывается и по фокусу, а не
              только по hover: invisible-кнопка ловила таб и оставалась невидимой. */}
          <button
            type="button"
            aria-label={armed === c.id ? 'Confirm remove criterion' : 'Remove criterion'}
            className={cn(
              'flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs opacity-0 transition',
              'group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none',
              armed === c.id
                ? 'bg-destructive/10 text-destructive opacity-100'
                : 'text-muted-foreground hover:text-destructive',
            )}
            onBlur={() => setArmed(null)}
            onClick={() => {
              if (armed !== c.id) { setArmed(c.id); return; }
              removeCriterion(taskId, c.id)
                .then(() => { setArmed(null); onChanged(); }).catch(err);
            }}
          >
            <Trash2 className="size-3.5" />
            {armed === c.id && <span>Remove?</span>}
          </button>
        </div>
      ))}
      {/* Кнопка в поле, а не только Enter: без неё набранный критерий выглядел добавленным —
          поле молчит одинаково и с отправленным текстом, и с забытым. Внутри, а не рядом:
          соседняя кнопка отъедала бы ширину у строки критерия на всей высоте списка.
          pr под её ширину — иначе длинный текст уезжает под кнопку. */}
      <div className="relative">
        <Input
          value={text} placeholder="Add criterion..." className="h-8 pr-[4.25rem]"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
        />
        <Button
          size="sm" variant={text.trim() ? 'default' : 'ghost'}
          className="absolute top-1 right-1 h-6 gap-1 px-2 text-xs [&_svg]:size-3"
          disabled={!text.trim()} onClick={add}
        >
          <ListPlus /> Add
        </Button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function BlockedField({ task, onChanged }: { task: Task; onChanged: () => void }) {
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState(false);
  const block = () => {
    if (!reason.trim()) return;
    blockTask(task.id, reason).then(() => { setReason(''); setOpen(false); onChanged(); })
      .catch((e: Error) => toast.error(e.message));
  };
  return (
    <Field label="Blocked">
      {task.blocked === 1 ? (
        <div className="flex flex-col gap-1">
          <span className="text-destructive">{task.block_reason}</span>
          <Button
            size="sm" variant="outline"
            onClick={() => unblockTask(task.id).then(onChanged).catch((e: Error) => toast.error(e.message))}
          >
            Unblock
          </Button>
        </div>
      ) : open ? (
        <div className="flex flex-col gap-1">
          <Input
            autoFocus value={reason} placeholder="reason" className="h-8"
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') block(); }}
          />
          <div className="flex gap-1">
            <Button size="sm" onClick={block}>Block</Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}><Ban /> Block</Button>
      )}
    </Field>
  );
}

function EditForm({ task, onSaved, onCancel }: {
  task: Task; onSaved: () => void; onCancel: () => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [body, setBody] = useState(task.body ?? '');
  const save = () => {
    editTask(task.id, { title, body })
      .then(onSaved)
      .catch((e: Error) => toast.error(e.message));
  };
  return (
    <div className="flex flex-col gap-2">
      <Input value={title} onChange={(e) => setTitle(e.target.value)} />
      <MarkdownEditor
        value={body} placeholder="markdown body" minHeight="192px" maxHeight="384px" autoFocus
        onChange={setBody}
        className="overflow-hidden rounded-md border focus-within:ring-1 focus-within:ring-ring"
      />
      <div className="flex gap-2">
        <Button size="sm" onClick={save}>Save</Button>
        <Button size="sm" variant="outline" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
