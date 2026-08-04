// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { FilesTab } from '../src/web/components/FilesTab';
import type { FileRow } from '../src/web/api';

const row = (over: Partial<FileRow> = {}): FileRow => ({
  id: 7, task_id: 1, sha256: 'abc', ext: 'png', original_name: 'shot.png',
  mime_type: 'image/png', size_bytes: 2048, description: null,
  created_at: 1700000000, ...over,
});

// vitest не подключён с globals:true, поэтому автo-cleanup RTL себя не находит —
// как и в соседних *.test.tsx, гасим DOM между тестами вручную.
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('FilesTab', () => {
  it('показывает имя, размер и описание', () => {
    render(<FilesTab taskId={1} files={[row({ description: 'красная кнопка' })]} onChanged={() => {}} />);
    expect(screen.getByText('shot.png')).toBeTruthy();
    expect(screen.getByText(/2\.0 KB/)).toBeTruthy();
    expect(screen.getByText('красная кнопка')).toBeTruthy();
  });

  it('пустой список говорит, как приложить файл', () => {
    render(<FilesTab taskId={1} files={[]} onChanged={() => {}} />);
    expect(screen.getByText(/drop a file/i)).toBeTruthy();
  });

  it('удаление дёргает DELETE и сообщает наверх', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const onChanged = vi.fn();
    render(<FilesTab taskId={1} files={[row()]} onChanged={onChanged} />);
    screen.getByTitle('Detach').click();
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/api\/files\/7/);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'DELETE' });
  });

  // M9: allSettled, не all — один отбитый файл в пачке не должен прятать те, что реально
  // загрузились. onChanged обязан позвать, а отказ — попасть тостом, а не молчанием.
  it('один отказ в пачке не топит остальные — onChanged всё равно вызывается, отказ идёт тостом', async () => {
    let call = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      call++;
      return Promise.resolve(call === 1
        ? new Response(JSON.stringify(row()), { status: 200 })
        : new Response(JSON.stringify({ error: 'too big' }), { status: 400 }));
    });
    const errorSpy = vi.spyOn(toast, 'error').mockImplementation(() => '');
    const onChanged = vi.fn();
    render(<FilesTab taskId={1} files={[]} onChanged={onChanged} />);
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    const a = new File(['A'], 'a.png', { type: 'image/png' });
    const b = new File(['B'], 'b.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [a, b] } });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(errorSpy).toHaveBeenCalledWith('too big');
  });
});
