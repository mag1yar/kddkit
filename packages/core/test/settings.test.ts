import { describe, it, expect } from 'vitest';
import type { Db } from '../src/db.js';
import { getReminded, openDb, setReminded } from '../src/index.js';

const mk = (): Db => openDb(':memory:', 'x');

describe('stop reminders', () => {
  it('на чистой базе ничего не напомнено', () => {
    expect(getReminded(mk(), 'cc:abcdef12')).toEqual([]);
  });

  it('читает записанное этой же сессией', () => {
    const db = mk();
    setReminded(db, 'cc:abcdef12', [119, 121]);
    expect(getReminded(db, 'cc:abcdef12')).toEqual([119, 121]);
  });

  it('чужая сессия не видит чужого списка, но своя выживает: meta не растёт', () => {
    const db = mk();
    setReminded(db, 'cc:abcdef12', [119]);
    expect(getReminded(db, 'cc:99999999')).toEqual([]);
    setReminded(db, 'cc:99999999', [7]);
    // до Fix 2 вторая запись стирала первую целиком; теперь обе сессии живут в одной строке.
    expect(getReminded(db, 'cc:abcdef12')).toEqual([119]);
    expect(getReminded(db, 'cc:99999999')).toEqual([7]);
    expect(db.prepare(`SELECT COUNT(*) c FROM meta WHERE key = 'stop_reminded'`).get())
      .toEqual({ c: 1 });
  });

  it('две сессии чередуют записи и каждая хранит свой список', () => {
    const db = mk();
    setReminded(db, 'cc:aaaaaaaa', [1]);
    setReminded(db, 'cc:bbbbbbbb', [2]);
    setReminded(db, 'cc:aaaaaaaa', [1, 3]);
    setReminded(db, 'cc:bbbbbbbb', [2, 4]);
    expect(getReminded(db, 'cc:aaaaaaaa')).toEqual([1, 3]);
    expect(getReminded(db, 'cc:bbbbbbbb')).toEqual([2, 4]);
    expect(db.prepare(`SELECT COUNT(*) c FROM meta WHERE key = 'stop_reminded'`).get())
      .toEqual({ c: 1 });
  });

  it('потолок в 10 сессий: старейшая выпадает первой', () => {
    const db = mk();
    for (let i = 0; i < 11; i++) setReminded(db, `cc:sess${String(i).padStart(2, '0')}`, [i]);
    expect(getReminded(db, 'cc:sess00')).toEqual([]); // вытеснена
    expect(getReminded(db, 'cc:sess01')).toEqual([1]); // старейшая из оставшихся выжила
    expect(getReminded(db, 'cc:sess10')).toEqual([10]); // самая свежая на месте
  });

  // Числоподобный ключ объекта JS сортирует впереди всех прочих, сколько его ни перезаписывай:
  // на карте такая сессия вылетала бы по потолку сразу после записи. Порядок хранится списком.
  it('сессия из одних цифр вытесняется по очереди записи, а не первой', () => {
    const db = mk();
    for (let i = 0; i < 9; i++) setReminded(db, `cc:sess${i}`, [i]);
    setReminded(db, '7', [77]); // самая свежая, десятая
    setReminded(db, 'cc:last', [99]); // одиннадцатая — выпадает старейшая
    expect(getReminded(db, 'cc:sess0')).toEqual([]);
    expect(getReminded(db, '7')).toEqual([77]);
  });

  it('старый формат-объект читается как «ничего не напомнено», а запись его чинит', () => {
    const db = mk();
    db.prepare(`INSERT INTO meta (key, value) VALUES ('stop_reminded', ?)`)
      .run(JSON.stringify({ session: 'cc:abcdef12', ids: [119] }));
    expect(getReminded(db, 'cc:abcdef12')).toEqual([]);
    setReminded(db, 'cc:abcdef12', [119]);
    expect(getReminded(db, 'cc:abcdef12')).toEqual([119]);
  });

  it('битое значение читается как «ничего не напомнено», а не бросает', () => {
    const db = mk();
    db.prepare(`INSERT INTO meta (key, value) VALUES ('stop_reminded', 'not json{')`).run();
    expect(getReminded(db, 'cc:abcdef12')).toEqual([]);
  });
});
