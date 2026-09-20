// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { CriteriaList } from '../src/web/components/CriteriaList.js';
import type { Criterion } from '../src/web/api.js';

afterEach(cleanup);

describe('criterion verification snapshot', () => {
  it('shows evidence, checker and verification time in task detail', () => {
    const checkedAt = 1_700_000_000;
    const criterion: Criterion = {
      id: 1, task_id: 1, text: 'tests green', checked_at: checkedAt, position: 0,
      evidence: 'pnpm test', checked_by: 'ai:s7',
    };

    render(<CriteriaList
      taskId={1} criteria={[criterion]} onChanged={() => {}} text="" setText={() => {}}
    />);

    expect(screen.getByText('evidence: pnpm test')).toBeTruthy();
    expect(screen.getByText(/^checked by ai:s7 · .+/)).toBeTruthy();
  });
});
