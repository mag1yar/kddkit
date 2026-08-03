import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS, openDb } from '../src/db.js';
import { addTask, editTask, BUG_BODY_TEMPLATE } from '../src/ops.js';
import { KINDS } from '../src/state.js';
import { claimNext, claimTask } from '../src/claim.js';
import { addCriterion } from '../src/criteria.js';
import { boardData } from '../src/queries.js';

let db: Database.Database;
beforeEach(() => { db = openDb(':memory:', 'p'); });
const user = { type: 'user' as const };

describe('kind on a task', () => {
  it('defaults to feature and round-trips the value it was given', () => {
    expect(addTask(db, { title: 'a' }, user).kind).toBe('feature');
    expect(addTask(db, { title: 'b', kind: 'bug' }, user).kind).toBe('bug');
    expect(addTask(db, { title: 'c', kind: 'research' }, user).kind).toBe('research');
  });

  it('rejects a value outside the vocabulary before touching the db', () => {
    expect(() => addTask(db, { title: 't', kind: 'epic' as any }, user))
      .toThrow(/invalid kind/);
    expect(db.prepare(`SELECT COUNT(*) c FROM tasks`).get()).toEqual({ c: 0 });
  });

  it('is editable, and the edit is validated too', () => {
    addTask(db, { title: 'a' }, user);
    expect(editTask(db, 1, { kind: 'chore' }, user).kind).toBe('chore');
    expect(() => editTask(db, 1, { kind: 'nope' as any }, user)).toThrow(/invalid kind/);
    expect(db.prepare(`SELECT kind FROM tasks WHERE id=1`).get()).toEqual({ kind: 'chore' });
  });

  // CHECK — не декорация: он единственный, кто держит словарь закрытым для прямых UPDATE
  // (миграции, ручной sqlite3, чужой клиент). Валидация в ops его не заменяет.
  it('is held closed by a CHECK constraint at the sql level', () => {
    addTask(db, { title: 'a' }, user);
    expect(() => db.prepare(`UPDATE tasks SET kind='epic' WHERE id=1`).run()).toThrow(/CHECK/);
  });

  it('the vocabulary is exactly the four agreed values', () => {
    expect(KINDS).toEqual(['feature', 'bug', 'chore', 'research']);
  });

  // Старая доска не должна начать врать: дефолт молчаливый, и на карточке он не рисуется.
  it('migrates an older board in place, backfilling every existing row with feature', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'kdd-kind-')), 'kdd.db');
    const raw = new Database(p);
    for (let i = 0; i < MIGRATIONS.length - 1; i++) raw.exec(MIGRATIONS[i]); // всё, кроме нашей
    raw.pragma(`user_version = ${MIGRATIONS.length - 1}`);
    raw.prepare(
      `INSERT INTO tasks (title, status, created_at, updated_at) VALUES ('old','backlog',0,0)`,
    ).run();
    raw.close();

    const up = openDb(p, 'x');
    expect(up.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(up.prepare(`SELECT kind FROM tasks WHERE title='old'`).get()).toEqual({ kind: 'feature' });
    up.close();
  });

  it('exports a bug body template with the three repro headings', () => {
    expect(BUG_BODY_TEMPLATE).toContain('## Steps');
    expect(BUG_BODY_TEMPLATE).toContain('## Expected');
    expect(BUG_BODY_TEMPLATE).toContain('## Actual');
  });
});

// research — работа, результат которой не код: агент её брать не должен, а вся агентская
// механика (claim → критерии → коммит) заточена ровно под «сделал и закоммитил».
describe('research is out of the agent queue', () => {
  const ready = (kind: 'feature' | 'research') => {
    const t = addTask(db, { title: kind, kind }, user);
    addCriterion(db, t.id, 'done when done', user);
    return t;
  };

  it('claimNext walks past a research task and takes the next one', () => {
    const r = ready('research');
    const f = ready('feature');
    const got = claimNext(db, { type: 'ai', id: 's1' }, 600);
    expect(got?.id).toBe(f.id);
    expect(got?.id).not.toBe(r.id);
  });

  it('claimNext returns null when research is all that is left', () => {
    ready('research');
    expect(claimNext(db, { type: 'ai', id: 's1' }, 600)).toBeNull();
  });

  it('an explicit claim of a research task is refused, and says why', () => {
    const r = ready('research');
    const res = claimTask(db, r.id, { type: 'ai', id: 's1' }, 600);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/research/);
    expect(db.prepare(`SELECT status FROM tasks WHERE id=?`).get(r.id))
      .toEqual({ status: 'new' });
  });

  // Человек не гейтится: доска — субстрат, а не надзиратель. Ему research брать можно.
  it('does not stop a human from claiming it', () => {
    const r = ready('research');
    expect(claimTask(db, r.id, user, 600).ok).toBe(true);
  });
});

describe('boardData kind filter', () => {
  it('narrows to one kind and leaves the other columns empty', () => {
    addTask(db, { title: 'f' }, user);
    const b = addTask(db, { title: 'b', kind: 'bug' }, user);
    const only = boardData(db, { kind: 'bug' });
    expect(only.new.map((t) => t.id)).toEqual([b.id]);
  });

  it('is unset by default — every kind comes back', () => {
    addTask(db, { title: 'f' }, user);
    addTask(db, { title: 'b', kind: 'bug' }, user);
    expect(boardData(db).new).toHaveLength(2);
  });

  // READY_SQL и CLAIMABLE_SQL (core/claim.ts) должны исключать research одинаково — иначе
  // ready=1 врёт: board --ready её покажет и карточка выглядит takeable, хотя claimNext её
  // никогда не отдаст. Заводим research с критериями специально: без них она и так не ready
  // по другой причине, а тут причина должна быть именно kind.
  it('READY_SQL excludes research even with criteria, so ready stays in sync with claimable', () => {
    const r = addTask(db, { title: 'r', kind: 'research' }, user);
    addCriterion(db, r.id, 'done when done', user);
    const rows = boardData(db).new;
    const row = rows.find((t) => t.id === r.id)!;
    expect(row.ready).toBe(0);
    expect(boardData(db, { ready: true }).new.map((t) => t.id)).not.toContain(r.id);
  });
});
