import { describe, expect, it } from 'vitest';
import { openDb, parseClaudeStreamLine, appendAgentEvent, listAgentEvents, taskDetail, addTask, runProduced, lastAgentEventKind } from '../src/index.js';

function db() {
  const d = openDb(':memory:');
  addTask(d, { title: 't' }, { type: 'user' });
  return d;
}

describe('parseClaudeStreamLine', () => {
  it('assistant text block → text event', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } });
    expect(parseClaudeStreamLine(line)).toEqual([{ kind: 'text', detail: { text: 'hello' } }]);
  });

  it('assistant tool_use block → tool_start with name+input', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [
      { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } });
    expect(parseClaudeStreamLine(line)).toEqual([{ kind: 'tool_start', name: 'Bash', detail: { input: { command: 'ls' } } }]);
  });

  it('keeps tool_use_id on both sides so the ui can pair parallel calls', () => {
    const call = JSON.stringify({ type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }] } });
    expect(parseClaudeStreamLine(call)[0].detail).toEqual({ id: 'toolu_1', input: { command: 'ls' } });
    const result = JSON.stringify({ type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'a' }] } });
    expect(parseClaudeStreamLine(result)[0].detail).toEqual({ id: 'toolu_1', output: 'a', isError: false });
  });

  it('assistant multi-block → multiple events, thinking skipped', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [
      { type: 'thinking', thinking: 'hmm' },
      { type: 'text', text: 'ok' },
      { type: 'tool_use', name: 'Read', input: { file: 'a' } }] } });
    expect(parseClaudeStreamLine(line)).toEqual([
      { kind: 'text', detail: { text: 'ok' } },
      { kind: 'tool_start', name: 'Read', detail: { input: { file: 'a' } } },
    ]);
  });

  it('user tool_result → tool_finish with isError', () => {
    const line = JSON.stringify({ type: 'user', message: { content: [
      { type: 'tool_result', content: 'boom', is_error: true }] } });
    expect(parseClaudeStreamLine(line)).toEqual([{ kind: 'tool_finish', detail: { output: 'boom', isError: true } }]);
  });

  it('system / result / malformed → []', () => {
    expect(parseClaudeStreamLine(JSON.stringify({ type: 'system', subtype: 'init' }))).toEqual([]);
    expect(parseClaudeStreamLine(JSON.stringify({ type: 'result', result: 'Hi.' }))).toEqual([]);
    expect(parseClaudeStreamLine('not json{')).toEqual([]);
    expect(parseClaudeStreamLine('')).toEqual([]);
  });
});

describe('append / list agent_events', () => {
  it('round-trips and orders by id', () => {
    const d = db();
    appendAgentEvent(d, 1, 'tick:1-0', 'run_start');
    appendAgentEvent(d, 1, 'tick:1-0', 'text', { detail: { text: 'hi' } });
    const rows = listAgentEvents(d, 1);
    expect(rows.map((r) => r.kind)).toEqual(['run_start', 'text']);
    expect(rows[0].worker_id).toBe('tick:1-0');
    expect(JSON.parse(rows[1].detail!)).toEqual({ text: 'hi' });
  });

  it('sinceId returns only newer, limit caps', () => {
    const d = db();
    const a = appendAgentEvent(d, 1, 'w', 'text', { detail: { text: '1' } });
    appendAgentEvent(d, 1, 'w', 'text', { detail: { text: '2' } });
    const rows = listAgentEvents(d, 1, { sinceId: a });
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].detail!)).toEqual({ text: '2' });
    expect(listAgentEvents(d, 1, { limit: 1 })).toHaveLength(1);
  });

  it('agent_events never leak into the audit events path (isolation)', () => {
    const d = db();
    appendAgentEvent(d, 1, 'w', 'tool_start', { name: 'Bash', detail: { input: {} } });
    expect(taskDetail(d, 1).events.some((e) => e.action === 'tool_start')).toBe(false);
  });
});

describe('runProduced', () => {
  it('committed=true when before/after head differ', () => {
    const d = db();
    appendAgentEvent(d, 1, 'w1', 'run_start', { detail: { head: 'aaa' } });
    appendAgentEvent(d, 1, 'w1', 'run_end', { detail: { exitCode: 0, head: 'bbb' } });
    expect(runProduced(d, 1)).toEqual({ before: 'aaa', after: 'bbb', committed: true });
  });

  it('committed=false when head unchanged', () => {
    const d = db();
    appendAgentEvent(d, 1, 'w1', 'run_start', { detail: { head: 'aaa' } });
    appendAgentEvent(d, 1, 'w1', 'run_end', { detail: { exitCode: 0, head: 'aaa' } });
    expect(runProduced(d, 1)).toEqual({ before: 'aaa', after: 'aaa', committed: false });
  });

  it('null when no run_end (killed / in-flight)', () => {
    const d = db();
    appendAgentEvent(d, 1, 'w1', 'run_start', { detail: { head: 'aaa' } });
    expect(runProduced(d, 1)).toBeNull();
  });

  it('null when a head is missing (old events)', () => {
    const d = db();
    appendAgentEvent(d, 1, 'w1', 'run_start');
    appendAgentEvent(d, 1, 'w1', 'run_end', { detail: { exitCode: 0 } });
    expect(runProduced(d, 1)).toBeNull();
  });

  it('uses the LAST run, pairs run_start before that run_end', () => {
    const d = db();
    appendAgentEvent(d, 1, 'w1', 'run_start', { detail: { head: 'aaa' } });
    appendAgentEvent(d, 1, 'w1', 'run_end', { detail: { head: 'bbb' } });
    appendAgentEvent(d, 1, 'w2', 'run_start', { detail: { head: 'bbb' } });
    appendAgentEvent(d, 1, 'w2', 'run_end', { detail: { head: 'bbb' } });
    expect(runProduced(d, 1)).toEqual({ before: 'bbb', after: 'bbb', committed: false });
  });

  // регресс: убитый воркер (run_start без run_end) ПОВЕРХ завершённого рана не должен
  // вернуть старый ран — иначе #10 reset откатит ветку к устаревшему before, потеряв работу.
  it('null when a newer run was killed (dangling run_start over a completed run)', () => {
    const d = db();
    appendAgentEvent(d, 1, 'w1', 'run_start', { detail: { head: 'aaa' } });
    appendAgentEvent(d, 1, 'w1', 'run_end', { detail: { head: 'bbb' } });
    appendAgentEvent(d, 1, 'w2', 'run_start', { detail: { head: 'bbb' } }); // committed ccc, then SIGKILL — no run_end
    expect(runProduced(d, 1)).toBeNull();
  });
});

describe('lastAgentEventKind', () => {
  it('returns the newest kind for a (task, worker) pair', () => {
    const d = db();
    appendAgentEvent(d, 1, 'w1', 'run_start', { detail: { head: 'aaa' } });
    appendAgentEvent(d, 1, 'w1', 'text', { detail: { text: 'hi' } });
    expect(lastAgentEventKind(d, 1, 'w1')).toBe('text');
  });

  it('null when the worker has no events', () => {
    const d = db();
    expect(lastAgentEventKind(d, 1, 'w1')).toBeNull();
  });

  it('scopes to the given worker_id', () => {
    const d = db();
    appendAgentEvent(d, 1, 'w1', 'run_end', { detail: { exitCode: 0 } });
    expect(lastAgentEventKind(d, 1, 'w2')).toBeNull(); // другой воркер — не видит w1
  });
});
