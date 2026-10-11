import type { Db } from './db.js';

function readMeta(db: Db, key: string): string | undefined {
  return (db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
    { value: string } | undefined)?.value;
}

function writeMeta(db: Db, key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

// Сколько сессий держим в дедупе одновременно — старейшая (по очереди записи) вылетает первой.
// Параллельных сессий на одном репо — единицы, десяти хватает с запасом.
const MAX_REMINDED_SESSIONS = 10;

/**
 * Дедуп Stop-напоминаний (#119): одно напоминание на задачу за сессию. `Stop` срабатывает на
 * каждом ходу, и хук, повторяющий одно и то же, читается как шум.
 *
 * Строка одна на всю базу, но внутри — список пар session/ids, а не одна пара: store keyed по
 * git-common-dir, так что все сессии одного репо делят этот `meta`-ключ. Одна пара на всех
 * значила бы, что вторая параллельная сессия при каждом ходе стирает дедуп первой — и обе
 * напоминают на каждом ходу вечно, ровно тот шум, для которого дедуп существует. Список с
 * потолком в MAX_REMINDED_SESSIONS держит строку одной и ограниченной без отдельной таблицы.
 */
export function getReminded(db: Db, session: string): number[] {
  return readReminded(db).find(([s]) => s === session)?.[1] ?? [];
}

export function setReminded(db: Db, session: string, ids: number[]): void {
  db.transaction(() => {
    const kept = readReminded(db).filter(([s]) => s !== session);
    kept.push([session, ids]); // недавняя сессия — в конец
    writeMeta(db, 'stop_reminded',
      JSON.stringify(kept.slice(Math.max(0, kept.length - MAX_REMINDED_SESSIONS))));
  })();
}

/**
 * Список пар, а не объект: у объекта числоподобный ключ («7») JS всегда сортирует впереди всех
 * прочих, сколько его ни перезаписывай, — такая сессия вылетала бы по потолку сразу после
 * записи. У массива порядок это и есть порядок. Всё, что не список пар (легаси-формат
 * {session, ids}, карта, мусор), читается как «пусто», а не чинится: дедуп восстановится сам
 * на следующей записи, а вот угадывать чужой формат нечем.
 */
function readReminded(db: Db): [string, number[]][] {
  try {
    const raw = JSON.parse(readMeta(db, 'stop_reminded') ?? 'null') as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((e): e is [string, number[]] =>
      Array.isArray(e) && typeof e[0] === 'string' && Array.isArray(e[1]));
  } catch {
    return [];
  }
}
