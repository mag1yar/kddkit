// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MarkdownEditor } from '../src/web/components/MarkdownEditor';

afterEach(() => { cleanup(); });

// M15: paste/drop — заголовочное взаимодействие фичи, и оно не было покрыто вовсе: только
// рендер картинки (Prose) был под тестом, сама вставка — нет. onPaste/onDrop слушают host
// в фазе всплытия (см. комментарий в MarkdownEditor), поэтому диспатч прямо на host уже их будит.
describe('MarkdownEditor paste', () => {
  it('вставка файла из буфера обмена заливает его и дописывает сниппет в onChange', async () => {
    const file = new File(['PNGDATA'], 'shot.png', { type: 'image/png' });
    const onUpload = vi.fn().mockResolvedValue('![shot.png](/api/files/7)');
    const onChange = vi.fn();
    const { container } = render(
      <MarkdownEditor value="" onChange={onChange} onUpload={onUpload} />,
    );
    const host = container.firstElementChild as HTMLElement;
    onChange.mockClear(); // overtype зовёт onChange один раз при инициализации, с пустым значением

    // jsdom не реализует ни ClipboardEvent, ни DataTransfer — обработчику из них нужно только
    // e.clipboardData.files (итерируется как `[...files]`) и e.preventDefault(), которые есть
    // у обычного Event; настоящий тип события тут не участвует в логике take().
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: { files: [file] } });
    host.dispatchEvent(paste);

    // list.map(upload) передаёт (file, index, array) — Array.prototype.map, не сама take().
    expect(onUpload.mock.calls[0][0]).toBe(file);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange).toHaveBeenLastCalledWith('![shot.png](/api/files/7)\n');
  });
});
