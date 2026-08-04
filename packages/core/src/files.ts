import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { CAPS, capText } from './caps.js';
import { now } from './db.js';
import { KddError } from './errors.js';
import { appendEvent, mustGetTask } from './ops.js';
import type { Actor } from './state.js';
import type { FileRow } from './types.js';

// mime по расширению: своя карта вместо зависимости — список короткий и меняется раз в год.
// Чего тут нет, то и не угадываем: mime_type останется null, а отдача уйдёт как octet-stream.
const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon',
  tif: 'image/tiff', tiff: 'image/tiff', svg: 'image/svg+xml',
  pdf: 'application/pdf', zip: 'application/zip', json: 'application/json',
  csv: 'text/csv', md: 'text/markdown', txt: 'text/plain', log: 'text/plain',
};

// Инлайном отдаём ТОЛЬКО растровые изображения. image/svg+xml отсутствует намеренно: SVG
// исполняет скрипт, а доска отдала бы его с того же origin, что и API с токеном, — это XSS
// в один шаг. Всё, чего тут нет, уходит как octet-stream + Content-Disposition: attachment.
const INLINE = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'image/bmp', 'image/x-icon', 'image/tiff',
]);

export const isInlineMime = (m: string | null): boolean => m !== null && INLINE.has(m);

// Стор вложений — рядом с базой, то есть вне репозитория: файл это состояние задачи,
// а не durable-знание, и его место там же, где мутабельное состояние.
// In-memory доска (':memory:') вложений не имеет по определению — dirname(':memory:') был бы
// '.', и файлы тихо легли бы в cwd процесса. Падаем явно, чтобы будущий тест с записью
// заорал сразу, а не насорил в репозиторий, из которого его запустили.
export const filesDir = (dbPath: string): string => {
  if (dbPath === ':memory:') throw new KddError('attachments need a real board file, not :memory:');
  return join(dirname(dbPath), 'files');
};

export const filePath = (dbPath: string, f: FileRow): string =>
  join(filesDir(dbPath), `${f.sha256}.${f.ext}`);

export function listFiles(db: Database.Database, taskId: number): FileRow[] {
  return db.prepare(`SELECT * FROM files WHERE task_id = ? ORDER BY id`).all(taskId) as FileRow[];
}

// По id, а не по задаче: GET /api/files/:id (и вообще любая отдача байтов) не знает task_id
// заранее — только глобальный file id из ссылки/img в теле.
export function getFile(db: Database.Database, id: number): FileRow | undefined {
  return db.prepare(`SELECT * FROM files WHERE id = ?`).get(id) as FileRow | undefined;
}

export function attachFile(
  db: Database.Database, dbPath: string, taskId: number, srcPath: string,
  opts: { description?: string }, actor: Actor,
): FileRow {
  let data: Buffer;
  try {
    const stat = statSync(srcPath);
    if (stat.isDirectory()) throw new KddError(`${srcPath} is a directory`);
    // Кап по stat.size, ДО readFileSync: иначе многогиговый файл целиком лёг бы в память
    // ради проверки, которая его и отбивает, — кап тогда защищает диск, но не память.
    if (stat.size > CAPS.fileBytes) {
      throw new KddError(`file is ${stat.size} bytes, the limit is ${CAPS.fileBytes}`);
    }
    data = readFileSync(srcPath);
  } catch (e) {
    if (e instanceof KddError) throw e;
    throw new KddError(`cannot read ${srcPath}: ${(e as Error).message}`);
  }
  mustGetTask(db, taskId); // гард до записи на диск: иначе сирота ради заведомо провальной вставки

  const sha256 = createHash('sha256').update(data).digest('hex');
  const ext = (extname(srcPath).slice(1) || 'bin').toLowerCase();
  const target = join(filesDir(dbPath), `${sha256}.${ext}`);

  // immediate, а не дефолтный deferred: deferred берёт write-lock на ПЕРВОЙ записи, то есть
  // уже после existsSync ниже, и между проверкой и вставкой успевал бы вклиниться чужой
  // detachFile — снести блоб под нулевым refcount и оставить нашу строку без байтов.
  // Здесь блокировка берётся на BEGIN, так что «проверить блоб и вставить строку» неделимо
  // относительно любого другого писателя доски (WAL: один писатель за раз).
  return db.transaction(() => {
    // Байты ДО строки. Порядок выбран по тому, какая половина сбоя вреднее: осиротевший blob
    // безвреден (он же дедуп-кэш и будет переиспользован), а строка без байтов — 404 на доске.
    if (!existsSync(target)) {
      mkdirSync(filesDir(dbPath), { recursive: true });
      // Пишем во ВРЕМЕННОЕ имя рядом и переименовываем: rename атомарен в пределах каталога,
      // прямая запись в target — нет. Смерть процесса посреди writeFileSync оставила бы здесь
      // усечённые байты НАВСЕГДА: следующий attach тех же байт увидел бы existsSync(target) и
      // переиспользовал бы порченный файл как дедуп-кэш, молча. Тот же приём, что у
      // backupBeforeMigrate в db.ts — свой tmp на pid, чужой недописанный файл гонка не тронет.
      const tmp = `${target}.${process.pid}.tmp`;
      writeFileSync(tmp, data);
      renameSync(tmp, target);
    }
    // INSERT ... ON CONFLICT DO NOTHING + re-select вместо SELECT-затем-INSERT: между чтением
    // и записью в раздельных запросах был бы зазор для гонки (два attach одних байт на одну
    // задачу почти одновременно), которая всплыла бы наружу как сырой SqliteError вместо
    // KddError. UNIQUE(task_id, sha256) уже в схеме — ON CONFLICT просто её использует.
    const name = capText(basename(srcPath), CAPS.fileNameChars);
    const r = db.prepare(
      `INSERT INTO files (task_id, sha256, ext, original_name, mime_type, size_bytes,
                          description, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id, sha256) DO NOTHING`,
    ).run(taskId, sha256, ext, name, MIME[ext] ?? null, data.length,
      opts.description ?? null, now());
    const row = db.prepare(`SELECT * FROM files WHERE task_id = ? AND sha256 = ?`)
      .get(taskId, sha256) as FileRow;
    // changes === 0 — строка уже была (идемпотентный повторный attach): не пишем второе
    // событие и не трогаем updated_at ради того, что фактически не изменилось.
    if (r.changes === 0) {
      // Кроме описания: байты те же, а текст — новый ввод. Молча его терять нельзя, второй
      // вызов с --desc это единственный способ дописать описание к уже приложенному файлу
      // (редактора описаний в UI нет, DO NOTHING проглотил бы его без единого признака).
      if (opts.description && opts.description !== row.description) {
        db.prepare(`UPDATE files SET description = ? WHERE id = ?`).run(opts.description, row.id);
        appendEvent(db, taskId, actor, 'file_attached', { id: row.id, name, described: true });
        db.prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`).run(now(), taskId);
        return { ...row, description: opts.description };
      }
      return row;
    }
    appendEvent(db, taskId, actor, 'file_attached', { id: row.id, name });
    db.prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`).run(now(), taskId);
    return row;
  }).immediate();
}

export function detachFile(
  db: Database.Database, dbPath: string, fileId: number, actor: Actor,
): void {
  const f = getFile(db, fileId);
  if (!f) throw new KddError(`file #${fileId} not found`);
  // Байты сносим, только когда на них не осталось ни одной строки: тот же файл может висеть
  // на другой задаче — дедуп сделал их одним блобом. И refcount, и само удаление байтов —
  // ВНУТРИ транзакции: после коммита между COUNT(*) и rmSync успел бы вклиниться конкурентный
  // attachFile — увидел бы блоб на диске (existsSync), пропустил запись байтов, вставил свою
  // строку, — и мы снесли бы файл из-под неё. WAL держит одного писателя за раз, а attachFile
  // берёт тот же лок с BEGIN (immediate), так что внутри транзакции этой щели нет. Остаётся
  // обратный хвост: упавший COMMIT после rmSync оставит строку без байтов — это уже штатный
  // 404 + запись в errors на отдаче, а не молча удалённый чужой файл, поэтому меняем щель на
  // неё сознательно.
  db.transaction(() => {
    db.prepare(`DELETE FROM files WHERE id = ?`).run(fileId);
    appendEvent(db, f.task_id, actor, 'file_detached', { id: fileId, name: f.original_name });
    db.prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`).run(now(), f.task_id);
    // Считаем по (sha256, ext), а не по одному sha256: имя блоба на диске строится из ОБОИХ
    // (filePath), и одни и те же байты под двумя расширениями — это два файла. Счёт по одному
    // хешу видел бы чужую строку как ссылку на наш блоб и не удалял бы его никогда.
    const left = (db.prepare(`SELECT COUNT(*) AS c FROM files WHERE sha256 = ? AND ext = ?`)
      .get(f.sha256, f.ext) as { c: number }).c;
    if (left === 0) rmSync(filePath(dbPath, f), { force: true });
  })();
}
