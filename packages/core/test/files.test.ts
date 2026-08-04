import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { addTask } from '../src/ops.js';
import { attachFile, detachFile, filePath, filesDir, isInlineMime, listFiles } from '../src/files.js';
import { CAPS } from '../src/caps.js';
import { KddError } from '../src/errors.js';

const user = { type: 'user' as const };
let dir: string;
let dbPath: string;
let db: Database.Database;

// Настоящий файл базы, не ':memory:': стор вложений — это dirname(dbPath)/files,
// и у in-memory базы такого каталога нет.
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kdd-files-'));
  dbPath = join(dir, 'kdd.db');
  db = openDb(dbPath, dir);
  addTask(db, { title: 'первая' }, user);  // #1
  addTask(db, { title: 'вторая' }, user);  // #2
});

const src = (name: string, body: string): string => {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
};

describe('attachFile', () => {
  it('кладёт байты на диск и строку в базу', () => {
    const f = attachFile(db, dbPath, 1, src('shot.png', 'PNGDATA'), { description: 'красная кнопка' }, user);
    expect(f.task_id).toBe(1);
    expect(f.original_name).toBe('shot.png');
    expect(f.ext).toBe('png');
    expect(f.mime_type).toBe('image/png');
    expect(f.size_bytes).toBe(7);
    expect(f.description).toBe('красная кнопка');
    expect(existsSync(filePath(dbPath, f))).toBe(true);
    expect(listFiles(db, 1).map((r) => r.id)).toEqual([f.id]);
  });

  it('дедуп: те же байты на двух задачах — один файл на диске, две строки', () => {
    const a = attachFile(db, dbPath, 1, src('a.png', 'SAME'), {}, user);
    const b = attachFile(db, dbPath, 2, src('b.png', 'SAME'), {}, user);
    expect(a.id).not.toBe(b.id);
    expect(a.sha256).toBe(b.sha256);
    expect(readdirSync(filesDir(dbPath))).toHaveLength(1);
  });

  it('повторный attach того же файла на ту же задачу идемпотентен', () => {
    const a = attachFile(db, dbPath, 1, src('a.png', 'ONE'), {}, user);
    const b = attachFile(db, dbPath, 1, src('a.png', 'ONE'), {}, user);
    expect(b.id).toBe(a.id);
    expect(listFiles(db, 1)).toHaveLength(1);
  });

  // Идемпотентность про БАЙТЫ, а не про текст: второй вызов с --desc — единственный способ
  // дописать описание к уже приложенному файлу, редактора описаний в UI нет.
  it('повторный attach дописывает описание, а не проглатывает его', () => {
    const a = attachFile(db, dbPath, 1, src('a.png', 'ONE'), {}, user);
    const b = attachFile(db, dbPath, 1, src('a.png', 'ONE'), { description: 'красная кнопка' }, user);
    expect(b.id).toBe(a.id);
    expect(b.description).toBe('красная кнопка');
    expect(listFiles(db, 1)[0]!.description).toBe('красная кнопка');
    expect(listFiles(db, 1)).toHaveLength(1);
  });

  it('пишет событие file_attached', () => {
    const f = attachFile(db, dbPath, 1, src('a.png', 'X'), {}, user);
    const e = db.prepare(
      `SELECT action, detail FROM events WHERE task_id = 1 ORDER BY id DESC LIMIT 1`,
    ).get() as { action: string; detail: string };
    expect(e.action).toBe('file_attached');
    expect(JSON.parse(e.detail)).toMatchObject({ id: f.id, name: 'a.png' });
  });

  it('без расширения — ext bin и mime null; неизвестное расширение — mime null', () => {
    const a = attachFile(db, dbPath, 1, src('Makefile', 'all:'), {}, user);
    expect(a.ext).toBe('bin');
    expect(a.mime_type).toBeNull();
    const b = attachFile(db, dbPath, 1, src('dump.qqq', 'x'), {}, user);
    expect(b.ext).toBe('qqq');
    expect(b.mime_type).toBeNull();
  });

  // M10: original_name приходит из клиентского multipart-имени — единственная некапнутая
  // строка в renderShow/get_task до этой правки. Капаем на ЗАПИСИ, не на чтении, чтобы база
  // никогда не держала абсурдное имя вовсе.
  it('original_name режется капом на записи, а не остаётся сырым от клиента', () => {
    const longName = `${'а'.repeat(CAPS.fileNameChars + 50)}.png`;
    const f = attachFile(db, dbPath, 1, src(longName, 'X'), {}, user);
    expect(f.original_name.length).toBeLessThan(longName.length);
    expect(f.original_name).toMatch(/… \[\+\d+ chars\]$/);
  });

  it('файл больше капа отбивается ДО записи на диск', () => {
    const big = src('big.bin', 'x'.repeat(CAPS.fileBytes + 1));
    expect(() => attachFile(db, dbPath, 1, big, {}, user)).toThrow(KddError);
    expect(existsSync(filesDir(dbPath))).toBe(false);
  });

  it('нет исходника или это каталог — KddError, а не ENOENT наружу', () => {
    expect(() => attachFile(db, dbPath, 1, join(dir, 'нет.png'), {}, user)).toThrow(KddError);
    expect(() => attachFile(db, dbPath, 1, dir, {}, user)).toThrow(/directory/);
  });

  it('несуществующая задача — KddError, файл на диске не остаётся сиротой без причины', () => {
    expect(() => attachFile(db, dbPath, 999, src('a.png', 'X'), {}, user)).toThrow(/not found/);
    expect(existsSync(filesDir(dbPath))).toBe(false);
  });
});

describe('detachFile', () => {
  it('снимает строку; байты живут, пока на них есть другая строка', () => {
    const a = attachFile(db, dbPath, 1, src('a.png', 'SAME'), {}, user);
    const b = attachFile(db, dbPath, 2, src('b.png', 'SAME'), {}, user);
    detachFile(db, dbPath, a.id, user);
    expect(listFiles(db, 1)).toEqual([]);
    expect(existsSync(filePath(dbPath, b))).toBe(true);
    detachFile(db, dbPath, b.id, user);
    expect(existsSync(filePath(dbPath, b))).toBe(false);
  });

  // Имя блоба — `<sha256>.<ext>`, значит одни и те же байты под двумя расширениями это ДВА
  // файла на диске. Refcount по одному sha256 считал бы чужую строку ссылкой на наш блоб и
  // не удалял бы его никогда — стор тёк бы молча.
  it('refcount по (sha256, ext): те же байты под другим расширением не держат наш блоб', () => {
    const png = attachFile(db, dbPath, 1, src('diagram.png', 'SAME'), {}, user);
    const bin = attachFile(db, dbPath, 2, src('diagram.bin', 'SAME'), {}, user);
    expect(png.sha256).toBe(bin.sha256);
    expect(readdirSync(filesDir(dbPath))).toHaveLength(2); // разный ext — разные файлы
    detachFile(db, dbPath, png.id, user);
    expect(existsSync(filePath(dbPath, png))).toBe(false);
    expect(existsSync(filePath(dbPath, bin))).toBe(true);
  });

  it('пишет событие file_detached', () => {
    const f = attachFile(db, dbPath, 1, src('a.png', 'X'), {}, user);
    detachFile(db, dbPath, f.id, user);
    const e = db.prepare(
      `SELECT action FROM events WHERE task_id = 1 ORDER BY id DESC LIMIT 1`,
    ).get() as { action: string };
    expect(e.action).toBe('file_detached');
  });

  it('неизвестный id — KddError', () => {
    expect(() => detachFile(db, dbPath, 999, user)).toThrow(/not found/);
  });
});

describe('isInlineMime', () => {
  it('растровые изображения — да, svg и всё прочее — нет', () => {
    expect(isInlineMime('image/png')).toBe(true);
    expect(isInlineMime('image/webp')).toBe(true);
    expect(isInlineMime('image/svg+xml')).toBe(false);
    expect(isInlineMime('application/pdf')).toBe(false);
    expect(isInlineMime(null)).toBe(false);
  });
});
