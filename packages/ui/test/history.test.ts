import { describe, expect, it } from 'vitest';
import { fmtEvent, groupHistory, type RawEvent } from '../src/web/lib/history.js';

// день фиксируем локальным полднем: dayKey считает локальную дату, UTC-полночь уехала бы в сосед
const day = (y: number, m: number, d: number, hh = 12, mm = 0, ss = 0) =>
  Math.floor(new Date(y, m - 1, d, hh, mm, ss).getTime() / 1000);

const ev = (o: Partial<RawEvent> & { id: number; action: string }): RawEvent => ({
  actor_type: 'user', actor_id: null, detail: null, created_at: day(2026, 7, 25),
  type: null, level: 'info', ...o,
});

describe('fmtEvent', () => {
  it('names lease actions instead of printing the raw column value', () => {
    expect(fmtEvent(ev({ id: 1, action: 'claim_renewed' }))).toBe('claim renewed');
    expect(fmtEvent(ev({ id: 2, action: 'reclaimed', detail: '{"former":"ai:tick:1-0"}' })))
      .toBe('lease expired, reclaimed from ai:tick:1-0');
    expect(fmtEvent(ev({ id: 3, action: 'released', detail: '{"reason":"spawn failed"}' })))
      .toBe('released: spawn failed');
  });
  it('edited lists the changed fields', () => {
    expect(fmtEvent(ev({ id: 1, action: 'edited', detail: '{"fields":["title","priority"]}' })))
      .toBe('edited title, priority');
    expect(fmtEvent(ev({ id: 2, action: 'edited' }))).toBe('edited');
  });
  it('unknown action falls back to its own name, broken detail does not throw', () => {
    expect(fmtEvent(ev({ id: 1, action: 'teleported' }))).toBe('teleported');
    expect(fmtEvent(ev({ id: 2, action: 'moved', detail: 'not json{' }))).toBe('moved undefined → undefined');
  });
});

describe('groupHistory', () => {
  it('splits by day and by actor, keeping order', () => {
    const days = groupHistory([
      ev({ id: 1, action: 'created' }),
      ev({ id: 2, action: 'claimed', actor_type: 'ai', actor_id: 'tick:1-0', type: 'claim' }),
      ev({ id: 3, action: 'commented', created_at: day(2026, 7, 26) }),
    ]);
    expect(days).toHaveLength(2);
    expect(days[0].groups.map((g) => g.actorId)).toEqual([null, 'tick:1-0']);
    expect(days[1].groups[0].rows[0].text).toBe('commented');
  });

  it('the same actor across midnight still starts a new day block', () => {
    const days = groupHistory([
      ev({ id: 1, action: 'created', created_at: day(2026, 7, 25, 23, 59) }),
      ev({ id: 2, action: 'edited', created_at: day(2026, 7, 26, 0, 1) }),
    ]);
    expect(days).toHaveLength(2);
    expect(days[1].groups).toHaveLength(1);
  });

  it('collapses consecutive identical rows, counting them', () => {
    const renew = (id: number) => ev({
      id, action: 'claim_renewed', actor_type: 'ai', actor_id: 'w', type: 'claim',
      created_at: day(2026, 7, 25, 12, id),
    });
    const [d] = groupHistory([renew(1), renew(2), renew(3)]);
    expect(d.groups[0].rows).toHaveLength(1);
    expect(d.groups[0].rows[0]).toMatchObject({ count: 3, at: day(2026, 7, 25, 12, 1) });
  });

  it('same action with different text stays separate rows', () => {
    const crit = (id: number, text: string) =>
      ev({ id, action: 'criterion_added', detail: JSON.stringify({ text }) });
    const [d] = groupHistory([crit(1, 'a'), crit(2, 'b')]);
    expect(d.groups[0].rows.map((r) => r.count)).toEqual([1, 1]);
  });

  it('lease bookkeeping is mechanical, a блок-по-провалам is not', () => {
    const [d] = groupHistory([
      ev({ id: 1, action: 'claimed', type: 'claim' }),
      ev({ id: 2, action: 'blocked', type: 'claim', level: 'error', detail: '{"reason":"3 failed attempts"}' }),
    ]);
    expect(d.groups[0].rows.map((r) => r.mechanical)).toEqual([true, false]);
  });

  it('empty input yields no days', () => {
    expect(groupHistory([])).toEqual([]);
  });
});
