import { statSync } from 'node:fs';
import type Database from 'better-sqlite3';
import {
  CAPS, capText, boardData, taskDetail, taskDetailCapped, recall, editTask, moveTask,
  commentTask, mustGetTask, listTracks, attachFile, detachFile, listFiles, KddError,
  type Actor, type Priority, type Status, type Kind, type TaskDetailCapped,
} from '@kddkit/core';

export interface TaskRow {
  id: number;
  title: string;
  status: string;
  kind: string;
  priority: string;
  blocked: boolean;
  ready: boolean;
  criteria: { checked: number; total: number };
}

// Перегрузки, а не просто union: без них каждый вызывающий (тест включительно) был бы обязан
// сужать тип сам, хотя литерал full ЗДЕСЬ, в аргументе, уже решает, какая ветка вернётся.
// Третья, общая — для server.ts: там full приходит из zod как `boolean | undefined`, не
// литерал, и ни одна из узких перегрузок ему не подходит; она обязана идти ПОСЛЕДНЕЙ, иначе
// перекрыла бы узкое сужение для литеральных вызовов (порядок объявления решает, какая матчится).
export function getTask(db: Database.Database, id: number, full?: false): TaskDetailCapped;
export function getTask(db: Database.Database, id: number, full: true): ReturnType<typeof taskDetail>;
export function getTask(
  db: Database.Database, id: number, full?: boolean,
): TaskDetailCapped | ReturnType<typeof taskDetail>;
export function getTask(db: Database.Database, id: number, full = false) {
  // капы — в core taskDetailCapped (та же политика, что kdd show); full — escape hatch
  return full ? taskDetail(db, id) : taskDetailCapped(db, id);
}

export function listTracksTool(db: Database.Database) {
  // все track-и, включая done: routing → active; done = завершённый пласт работы (контекст)
  return listTracks(db, {}).map((t) => ({
    id: t.id, name: t.name,
    description: t.description === null ? null : capText(t.description, CAPS.trackDescChars),
    status: t.status, open_tasks: t.open_tasks,
  }));
}

export function listTasks(
  db: Database.Database,
  filter: { status?: Status; area?: string; track_id?: number; ready?: boolean; kind?: Kind } = {},
): { tasks: Record<string, TaskRow[]>; omitted?: Record<string, number> } {
  const board = boardData(db, filter);
  const tasks: Record<string, TaskRow[]> = {};
  const omitted: Record<string, number> = {};
  for (const [status, rows] of Object.entries(board)) {
    if (rows.length > CAPS.listRows) omitted[status] = rows.length - CAPS.listRows;
    tasks[status] = rows.slice(0, CAPS.listRows).map((t) => ({
      id: t.id, title: t.title, status: t.status, kind: t.kind,
      priority: t.priority, blocked: !!t.blocked, ready: !!t.ready,
      criteria: { checked: t.criteria_checked, total: t.criteria_total },
    }));
  }
  return Object.keys(omitted).length ? { tasks, omitted } : { tasks };
}

export function recallTool(
  db: Database.Database, dir: string, query: string,
  opts: { k?: number; kind?: 'decision' | 'task' } = {},
) {
  return recall(db, dir, query, opts);
}

export interface UpdateInput {
  id: number;
  edit?: { title?: string; body?: string; priority?: Priority; area?: string; track_id?: number | null; kind?: Kind };
  move?: { to: string; reason?: string };
  comment?: string;
  attach?: { path: string; description?: string };
  detach?: number;
}

export function updateTask(db: Database.Database, input: UpdateInput, actor: Actor) {
  if (!input.edit && !input.move && !input.comment && !input.attach && input.detach === undefined) {
    throw new KddError('nothing to update');
  }
  mustGetTask(db, input.id); // validate the task exists before any attach/detach side effect touches disk
  // Исходник проверяем ДО транзакции, хотя прикладываем после неё: attachFile отбивает
  // несуществующий путь сам, но к тому моменту move уже закоммичен, и вызывающий получил бы
  // ошибку про файл на задаче, которая тем временем уехала. Дёшево отбить обе половины разом.
  if (input.attach) {
    try {
      statSync(input.attach.path);
    } catch (e) {
      throw new KddError(`cannot read ${input.attach.path}: ${(e as Error).message}`);
    }
  }
  if (input.edit || input.move || input.comment) {
    db.transaction(() => {
      if (input.edit) editTask(db, input.id, input.edit, actor);
      if (input.move) moveTask(db, input.id, input.move.to, actor, input.move.reason);
      if (input.comment) commentTask(db, input.id, input.comment, actor);
    })();
  }
  // attach/detach — ВНЕ общей транзакции: они пишут на диск, а откат транзакции файл не вернёт.
  // Каждая из них транзакционна сама по себе (см. core/files.ts), так что журнал целостен.
  // И ПОСЛЕ неё: move гейтится (checkMove, критерии, self-accept), а отказ гейта должен
  // отменять весь вызов целиком. Иначе `{attach, move}` при незакрытых критериях возвращал бы
  // ошибку — но файл был бы уже прикреплён, и вызывающий об этом ниоткуда не узнал бы.
  if (input.attach) {
    attachFile(db, db.name, input.id, input.attach.path,
      { description: input.attach.description }, actor);
  }
  if (input.detach !== undefined) {
    // detachFile сам по себе не знает про task_id вызывающего — id файла и так уникален
    // глобально. Гейт "файл действительно висит на этой задаче" — забота адаптера, раз
    // схема тула обещает "file id from get_task files[]" (т.е. файл этой задачи).
    if (!listFiles(db, input.id).some((f) => f.id === input.detach)) {
      throw new KddError(`file ${input.detach} is not attached to task ${input.id}`);
    }
    detachFile(db, db.name, input.detach, actor);
  }
  return mustGetTask(db, input.id);
}
