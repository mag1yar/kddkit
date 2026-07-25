import { describe, expect, it } from 'vitest';
import { fmtInput, fmtOutput, groupRuns, lastWord, mergeFeed, toolSummary, type ToolItem } from '../src/web/lib/feed.js';

const ev = (id: number, kind = 'text') => ({ id, kind, task_id: 1, worker_id: 'w', name: null, detail: null, created_at: id }) as any;

const raw = (id: number, kind: string, detail?: object, name?: string, at = id) =>
  ({ id, kind, name: name ?? null, detail: detail ? JSON.stringify(detail) : null, created_at: at });
const tools = (r: { items: any[] }) => r.items.filter((i) => i.kind === 'tool') as ToolItem[];

describe('mergeFeed', () => {
  it('appends only strictly-newer rows, keeps order, dedups by id', () => {
    const base = [ev(1), ev(2)];
    expect(mergeFeed(base, [ev(2), ev(3)]).map((e) => e.id)).toEqual([1, 2, 3]);
  });
  it('empty incoming keeps prev', () => {
    expect(mergeFeed([ev(1)], []).map((e) => e.id)).toEqual([1]);
  });
});

describe('fmtOutput', () => {
  it('passes strings through unchanged', () => {
    expect(fmtOutput('hi')).toBe('hi');
  });
  it('joins array-of-text-blocks with \\n', () => {
    expect(fmtOutput([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\nb');
  });
  it('mixed content (e.g. Read of image/PDF): joins the text blocks, ignores non-text', () => {
    expect(fmtOutput([{ type: 'text', text: 'ok' }, { type: 'image', source: { data: 'x' } }])).toBe('ok');
  });
  it('array with no text blocks at all falls back to JSON', () => {
    expect(fmtOutput([{ type: 'image', source: { data: 'x' } }])).toBe('[{"type":"image","source":{"data":"x"}}]');
  });
  it('JSON-stringifies plain objects', () => {
    expect(fmtOutput({ foo: 1 })).toBe('{"foo":1}');
  });
  it('renders nullish as empty string', () => {
    expect(fmtOutput(null)).toBe('');
    expect(fmtOutput(undefined)).toBe('');
  });
});

describe('groupRuns', () => {
  it('folds a result into its own call and marks the run committed', () => {
    const runs = groupRuns([
      raw(1, 'run_start', { head: 'aaa' }),
      raw(2, 'text', { text: 'hi' }),
      raw(3, 'tool_start', { id: 't1', input: { command: 'ls' } }, 'Bash'),
      raw(4, 'tool_finish', { id: 't1', output: 'a\nb', isError: false }),
      raw(5, 'run_end', { exitCode: 0, head: 'bbb' }),
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0].items).toHaveLength(2); // текст + ОДНА карточка вызова, не две строки
    expect(tools(runs[0])[0]).toMatchObject({ name: 'Bash', output: 'a\nb', done: true, isError: false });
    expect(runs[0]).toMatchObject({ ended: true, exitCode: 0, committed: true, endHead: 'bbb' });
  });

  it('pairs parallel calls by tool_use_id, not by arrival order', () => {
    // claude присылает их пачкой start,start,finish,finish — и второй результат приезжает первым
    const runs = groupRuns([
      raw(1, 'run_start', { head: 'aaa' }),
      raw(2, 'tool_start', { id: 'a', input: { command: 'one' } }, 'Bash'),
      raw(3, 'tool_start', { id: 'b', input: { query: 'two' } }, 'ToolSearch'),
      raw(4, 'tool_finish', { id: 'b', output: 'B' }),
      raw(5, 'tool_finish', { id: 'a', output: 'A' }),
    ]);
    expect(tools(runs[0]).map((t) => [t.name, t.output])).toEqual([['Bash', 'A'], ['ToolSearch', 'B']]);
  });

  it('falls back to FIFO order for old events without tool_use_id', () => {
    const runs = groupRuns([
      raw(1, 'run_start'),
      raw(2, 'tool_start', { input: { command: 'one' } }, 'Bash'),
      raw(3, 'tool_start', { input: { command: 'two' } }, 'Bash'),
      raw(4, 'tool_finish', { output: 'A' }),
      raw(5, 'tool_finish', { output: 'B' }),
    ]);
    expect(tools(runs[0]).map((t) => t.output)).toEqual(['A', 'B']);
  });

  it('splits runs and never appends to an ended one', () => {
    const runs = groupRuns([
      raw(1, 'run_start'), raw(2, 'run_end', { exitCode: 0 }),
      raw(3, 'run_start'), raw(4, 'text', { text: 'second' }),
    ]);
    expect(runs).toHaveLength(2);
    expect(runs[1].items).toHaveLength(1);
  });

  it('a result whose call is missing becomes its own card', () => {
    const runs = groupRuns([raw(1, 'tool_finish', { output: 'orphan', isError: true })]);
    expect(tools(runs[0])[0]).toMatchObject({ name: 'result', output: 'orphan', isError: true });
  });

  it('a run with no end is still open; missing heads say nothing about commits', () => {
    const runs = groupRuns([raw(1, 'run_start', { head: 'aaa' }), raw(2, 'text', { text: 'x' })]);
    expect(runs[0]).toMatchObject({ ended: false, committed: null });
  });

  it('unchanged head means the agent talked but did not commit', () => {
    const runs = groupRuns([
      raw(1, 'run_start', { head: 'aaa' }), raw(2, 'run_end', { exitCode: 0, head: 'aaa' }),
    ]);
    expect(runs[0].committed).toBe(false);
  });
});

describe('lastWord', () => {
  it('takes the agent last reply, collapsed to one line', () => {
    const [run] = groupRuns([
      raw(1, 'run_start'), raw(2, 'text', { text: 'first' }),
      raw(3, 'tool_start', { input: { command: 'ls' } }, 'Bash'),
      raw(4, 'text', { text: 'done.\n\n- committed abc' }),
    ]);
    expect(lastWord(run)).toBe('done. - committed abc');
  });
  it('ignores blank replies and a run that never spoke', () => {
    const [run] = groupRuns([
      raw(1, 'run_start'), raw(2, 'text', { text: 'said' }), raw(3, 'text', { text: '  ' }),
    ]);
    expect(lastWord(run)).toBe('said');
    expect(lastWord(groupRuns([raw(1, 'run_start')])[0])).toBe('');
  });
});

describe('toolSummary / fmtInput', () => {
  it('prefers the description the agent wrote itself', () => {
    expect(toolSummary({ command: 'ls -la', description: 'List files' })).toBe('List files');
  });
  it('falls back to the command, collapsed to one line', () => {
    expect(toolSummary({ command: 'a\n  b' })).toBe('a b');
  });
  it('shows the basename for paths, the query for searches', () => {
    expect(toolSummary({ file_path: '/long/path/LICENSE' })).toBe('LICENSE');
    expect(toolSummary({ query: 'kdd recall' })).toBe('kdd recall');
  });
  it('no known field: first non-empty string, else empty', () => {
    expect(toolSummary({ whatever: 'value' })).toBe('value');
    expect(toolSummary(null)).toBe('');
  });
  it('fmtInput prints commands and file content raw, everything else as JSON', () => {
    expect(fmtInput({ command: 'git log\n--oneline' })).toBe('git log\n--oneline');
    expect(fmtInput({ file_path: '/a/b', content: 'line1\nline2' })).toBe('/a/b\n\nline1\nline2');
    expect(fmtInput({ pattern: 'x' })).toBe('{\n  "pattern": "x"\n}');
  });
});
