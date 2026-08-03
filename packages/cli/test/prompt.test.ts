import { describe, it, expect } from 'vitest';
import { workerPrompt } from '../src/prompt.js';

describe('workerPrompt commit type', () => {
  it('maps every kind to its conventional type', () => {
    expect(workerPrompt('feature', null)).toContain('`feat: ');
    expect(workerPrompt('bug', null)).toContain('`fix: ');
    expect(workerPrompt('chore', null)).toContain('`chore: ');
    expect(workerPrompt('research', null)).toContain('`docs: ');
  });

  it('uses area as the commit scope', () => {
    expect(workerPrompt('bug', 'cli')).toContain('`fix(cli): ');
  });

  // Пробел или двоеточие в scope ломают разбор conventional-субъекта — и коммит молча
  // выпадает из changelog, то есть ровно та беда, от которой этот маппинг и заведён.
  it('drops a scope that would not survive a conventional subject', () => {
    expect(workerPrompt('bug', 'web ui')).toContain('`fix: ');
    expect(workerPrompt('bug', 'web ui')).not.toContain('(web ui)');
  });
});

describe('workerPrompt instruction body', () => {
  it('tells a bug worker to reproduce first and fix the cause', () => {
    const p = workerPrompt('bug', null);
    expect(p).toMatch(/reproduce/i);
    expect(p).toMatch(/cause, not the symptom/i);
  });

  // SWE-Doctor (arXiv 2607.00990): один падающий тест как ЦЕЛЬ покрывает одно проявление
  // и даёт частичную заплату. Промпт обязан требовать причину, а не зелёный тест.
  it('never phrases the bug goal as making a failing test pass', () => {
    expect(workerPrompt('bug', null)).not.toMatch(/make the failing test pass/i);
  });

  it('sends a feature worker to the acceptance criteria', () => {
    expect(workerPrompt('feature', null)).toMatch(/acceptance criteria/i);
  });

  // Decisions are human-gated (skills/kdd/SKILL.md): the worker proposes the outcome in its
  // summary comment, it must NOT be told to run `kdd decide` itself — addDecision has no actor
  // gate, so a worker literally following that instruction would write the decision file itself.
  it('tells a research worker to propose a decision in the summary, not write it itself', () => {
    const p = workerPrompt('research', null);
    expect(p).toMatch(/propose the outcome/i);
    expect(p).not.toContain('kdd decide "<title>"');
  });

  it('keeps the shared tail on every kind', () => {
    for (const k of ['feature', 'bug', 'chore', 'research'] as const) {
      expect(workerPrompt(k, null)).toContain('kdd comment $KDD_TASK_ID');
      expect(workerPrompt(k, null)).toContain('kdd move $KDD_TASK_ID review');
      expect(workerPrompt(k, null)).toContain('kdd criteria check $KDD_TASK_ID');
    }
  });
});
