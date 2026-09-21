import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { addTask, moveTask, blockTask, archiveTask } from '../src/ops.js';
import {
  boardData, decisionDetail, exportBoard, statusDigest, syncedTaskDetail,
  taskDetail, taskDetailCapped, unsubmitted,
} from '../src/queries.js';
import { linkTasks } from '../src/ops.js';
import { addDecision } from '../src/decisions.js';
import { addCriterion, setCriterionChecked } from '../src/criteria.js';
import { attachFile } from '../src/files.js';
import { CAPS } from '../src/caps.js';

let db: Database.Database;
const user = { type: 'user' as const };
beforeEach(() => {
  db = openDb(':memory:', 'p');
  addTask(db, { title: 'срочная', priority: 'urgent', area: 'договор' }, user); // #1
  addTask(db, { title: 'обычная', area: 'клиент' }, user);                      // #2
  addTask(db, { title: 'в работе' }, user);                                     // #3
  moveTask(db, 3, 'in_progress', user);
});

describe('boardData', () => {
  it('groups by status, urgent first, has all 5 keys', () => {
    const b = boardData(db);
    expect(Object.keys(b)).toEqual(['backlog', 'new', 'in_progress', 'review', 'done']);
    expect(b.new.map((t) => t.title)).toEqual(['срочная', 'обычная']);
    expect(b.in_progress).toHaveLength(1);
  });

  it('filters by area and hides archived by default', () => {
    archiveTask(db, 2, user);
    expect(boardData(db, { area: 'договор' }).new.map((t) => t.id)).toEqual([1]);
    expect(boardData(db).new.map((t) => t.id)).toEqual([1]);
    expect(boardData(db, { archived: true }).new.map((t) => t.id)).toEqual([2]);
  });

  it('marks only unblocked new tasks ready', () => {
    moveTask(db, 2, 'backlog', user);        // #2 new → backlog
    blockTask(db, 1, 'жду', user);           // #1 new but blocked
    const b = boardData(db);
    expect(b.new.find((t) => t.id === 1)?.ready).toBe(0);   // blocked
    expect(b.backlog.find((t) => t.id === 2)?.ready).toBe(0); // backlog
    expect(b.in_progress[0].ready).toBe(0);                  // in_progress
  });

  it('regression: urgent backlog task is not ready', () => {
    moveTask(db, 1, 'backlog', user);        // #1 urgent, now backlog
    expect(boardData(db).backlog[0].ready).toBe(0);
  });

  it('ready filter returns exactly the ready set', () => {
    // #1, #2 are unblocked new → ready; #3 in_progress → not
    expect(boardData(db, { ready: true }).new.map((t) => t.id)).toEqual([1, 2]);
    expect(boardData(db, { ready: true }).in_progress).toEqual([]);
    expect(boardData(db, { ready: false }).in_progress.map((t) => t.id)).toEqual([3]);
  });

  it('counts checked/total criteria per row', () => {
    const c1 = addCriterion(db, 1, 'a', user);
    addCriterion(db, 1, 'b', user);
    setCriterionChecked(db, 1, c1.id, true, user);
    const row = boardData(db).new.find((t) => t.id === 1);
    expect(row?.criteria_checked).toBe(1);
    expect(row?.criteria_total).toBe(2);
  });
});

describe('taskDetail', () => {
  it('returns task with comments, events and links both ways', () => {
    linkTasks(db, 2, 1, 'relates_to', user);
    const d1 = taskDetail(db, 1);
    expect(d1.links).toEqual([{ id: 2, title: 'обычная', kind: 'relates_to' }]);
    expect(d1.events.map((e) => e.action)).toEqual(['created']);
  });

  it('returns decision backlinks in full and capped detail', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kdd-query-decisions-'));
    const decision = addDecision(db, dir, {
      title: 'linked decision', decision: 'x', sourceTasks: [1],
    });
    expect(taskDetail(db, 1).decisions).toEqual([{
      slug: decision.slug, title: 'linked decision', created: expect.any(String), superseded_by: null,
    }]);
    expect(taskDetailCapped(db, 1).decisions).toEqual(taskDetail(db, 1).decisions);
  });

  it('caps decision backlinks with an honest total', () => {
    const insert = db.prepare(
      `INSERT INTO decisions
         (slug, title, path, content_hash, created, superseded_by, source_tasks)
       VALUES (?, ?, ?, ?, ?, NULL, '[1]')`,
    );
    for (let i = 0; i < 21; i++) {
      insert.run(`decision-${String(i).padStart(2, '0')}`, `${'d'.repeat(100)}-${i}`,
        `/tmp/decision-${i}.md`, `hash-${i}`, '2026-09-20');
    }

    const capped = taskDetailCapped(db, 1);
    expect(capped.decisions).toHaveLength(20);
    expect(capped.decisions_total).toBe(21);
    expect(capped.decisions[0].title).toContain('chars]');
  });

  it('uses one synchronized path for full and capped task detail', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kdd-query-sync-'));
    writeFileSync(join(dir, '2026-09-20-manual.md'),
      '---\ncreated: 2026-09-20\nstatus: active\nsuperseded_by:\nsource_tasks: [1]\n---\n' +
      '# manual\n\n## Decision\nx\n');
    expect(syncedTaskDetail(db, dir, 1, false).decisions[0].slug)
      .toBe('2026-09-20-manual');
    expect(syncedTaskDetail(db, dir, 1, true).decisions[0].slug)
      .toBe('2026-09-20-manual');
  });

  it('returns the current source task state from decision detail', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kdd-query-decision-detail-'));
    const decision = addDecision(db, dir, {
      title: 'linked decision', decision: 'x', sourceTasks: [1],
    });
    expect(decisionDetail(db, dir, decision.slug)).toMatchObject({
      slug: decision.slug,
      title: 'linked decision',
      status: 'active',
      source_tasks: [{ id: 1, title: 'срочная', status: 'new', archived_at: null }],
    });
  });

  it('refreshes the indexed path when the decisions directory moves', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kdd-query-decision-move-'));
    const decision = addDecision(db, dir, { title: 'movable', decision: 'x' });
    const movedDir = `${dir}-moved`;
    renameSync(dir, movedDir);
    expect(decisionDetail(db, movedDir, decision.slug)).toMatchObject({
      path: join(movedDir, `${decision.slug}.md`),
      title: 'movable',
    });
  });
});

describe('statusDigest', () => {
  it('collects in_progress, review, blocked and recent events', () => {
    blockTask(db, 2, 'жду', user);
    const d = statusDigest(db);
    expect(d.in_progress.map((t) => t.id)).toEqual([3]);
    expect(d.blocked.map((t) => t.id)).toEqual([2]);
    expect(d.recent.length).toBeLessThanOrEqual(5);
  });
});

describe('exportBoard', () => {
  it('dumps everything including archived', () => {
    archiveTask(db, 1, user);
    const dump = exportBoard(db);
    expect(dump.tasks).toHaveLength(3);
    expect(dump.events.length).toBeGreaterThan(3);
  });
});

// #119: «работа закончена, статус нет» — все критерии закрыл этот автор, задача всё ещё в работе.
describe('unsubmitted', () => {
  const ai = { type: 'ai' as const, id: 's1' };
  // задача #1 в работе, один критерий, закрыт агентом s1
  const setup = (actor: { type: 'ai'; id: string } | { type: 'user' } = ai) => {
    // guard: setup runs twice on task #1 in one test (второй критерий сценарий) — moveTask на
    // тот же статус кидает (checkMove: from === to), поэтому двигаем только если ещё не в работе.
    const t = db.prepare(`SELECT status FROM tasks WHERE id = 1`).get() as { status: string };
    if (t.status !== 'in_progress') moveTask(db, 1, 'in_progress', user);
    const c = addCriterion(db, 1, 'тест зелёный', user);
    return setCriterionChecked(db, 1, c.id, true, actor);
  };

  it('возвращает задачу, у которой этот автор закрыл последний критерий', () => {
    setup();
    expect(unsubmitted(db, 'ai:s1')).toEqual([1]);
  });

  it('молчит, пока хоть один критерий не проставлен', () => {
    setup();
    addCriterion(db, 1, 'документация', user);
    expect(unsubmitted(db, 'ai:s1')).toEqual([]);
  });

  it('молчит, когда критериев нет вовсе: сигнала «работа закончена» нет', () => {
    moveTask(db, 1, 'in_progress', user);
    expect(unsubmitted(db, 'ai:s1')).toEqual([]);
  });

  it('молчит, когда последнюю галку поставил кто-то другой', () => {
    setup(user);
    expect(unsubmitted(db, 'ai:s1')).toEqual([]);
    setup({ type: 'ai', id: 's2' }); // второй критерий, закрыт другой сессией
    expect(unsubmitted(db, 'ai:s1')).toEqual([]);
    expect(unsubmitted(db, 'ai:s2')).toEqual([1]);
  });

  it('молчит про задачу под чужим ai-lease: checkMove её всё равно не отдаст', () => {
    setup();
    const lease = (by: string | null) =>
      db.prepare(`UPDATE tasks SET claimed_by = ? WHERE id = 1`).run(by);
    lease('ai:s2');
    expect(unsubmitted(db, 'ai:s1')).toEqual([]);
    lease('ai:s1'); // свой lease не мешает
    expect(unsubmitted(db, 'ai:s1')).toEqual([1]);
    lease('user'); // человек держит — fence по нему не бьёт
    expect(unsubmitted(db, 'ai:s1')).toEqual([1]);
    lease(null);
    expect(unsubmitted(db, 'ai:s1')).toEqual([1]);
  });

  it('молчит, когда задача не в работе или в архиве', () => {
    const c = setup();
    moveTask(db, 1, 'review', user);
    expect(unsubmitted(db, 'ai:s1')).toEqual([]);
    moveTask(db, 1, 'in_progress', user);
    expect(unsubmitted(db, 'ai:s1')).toEqual([1]); // вернулась в работу — снова видна
    archiveTask(db, 1, user);
    expect(unsubmitted(db, 'ai:s1')).toEqual([]);
    expect(c.checked_at).not.toBeNull(); // галка всё это время стоит
  });
});

// #122: вложения видны обоим читателям детали — полному (kdd show --json) и капнутому.
describe('files in task detail', () => {
  it('taskDetail отдаёт вложения, capped режет список и описание с честным total', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kdd-qfiles-'));
    const dbPath = join(dir, 'kdd.db');
    const fdb = openDb(dbPath, dir);
    addTask(fdb, { title: 'со вложениями' }, user); // #1
    const src = join(dir, 'shot.png');
    let first: number | undefined;
    for (let i = 0; i <= CAPS.files; i++) {
      writeFileSync(src, `bytes-${i}`);
      const f = attachFile(fdb, dbPath, 1, src, { description: 'о'.repeat(CAPS.fileDescChars + 50) }, user);
      first ??= f.id;
    }
    expect(taskDetail(fdb, 1).files).toHaveLength(CAPS.files + 1);
    const capped = taskDetailCapped(fdb, 1);
    expect(capped.files).toHaveLength(CAPS.files);
    expect(capped.files_total).toBe(CAPS.files + 1);
    expect(capped.files[0].description!.length).toBeLessThan(CAPS.fileDescChars + 50);
    // режем список с НАЧАЛА (id-порядок = время прикрепления): первый вернувшийся файл — это
    // первый приложенный, а не последний. Одинаковые description на всех файлах раньше не
    // отличали head-slice от tail-slice — эта проверка отличает.
    expect(capped.files[0].id).toBe(first);
  });
});
