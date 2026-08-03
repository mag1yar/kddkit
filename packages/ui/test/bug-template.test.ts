import { describe, it, expect } from 'vitest';
import { BUG_BODY_TEMPLATE as core, KINDS as coreKinds } from '@kddkit/core';
import { BUG_BODY_TEMPLATE as web, KINDS as webKinds } from '../src/web/api';

// Дубликат по уже задокументированной в api.ts конвенции (ядро тянет better-sqlite3 и в
// браузер не идёт). Расхождение означало бы, что баг, заведённый из UI и из CLI, выглядит
// по-разному — этот тест единственное, что об этом скажет.
describe('bug body template', () => {
  it('is identical in core and in the web bundle', () => {
    expect(web).toBe(core);
  });
});

// KINDS — тот же дубликат, но с худшим отказом: забытый пятый kind в core делает
// KIND_ICON[kind] в Board.tsx undefined, и React рушит всю доску на "Element type is
// invalid" вместо неправильного бейджа. coreKinds типизирован как Kind[], webKinds — as
// const, поэтому сравниваем содержимое, а не типы.
describe('task kind vocabulary', () => {
  it('is identical in core and in the web bundle', () => {
    expect([...webKinds]).toEqual(coreKinds);
  });
});
