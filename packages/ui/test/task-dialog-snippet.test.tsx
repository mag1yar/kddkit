// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { attachmentSnippet } from '../src/web/components/TaskDialog';

// I3: вставка non-image файла как ![]() рендерилась бы Prose в <img>, а отдача pdf/octet-stream
// под <img src> — это битая картинка. image/* остаётся ![]() (рендерится инлайн), всё
// остальное — обычная [name](href) ссылка, та же, что в FilesTab.
describe('attachmentSnippet', () => {
  it('картинка вставляется как ![]()', () => {
    expect(attachmentSnippet({ id: 7, original_name: 'shot.png', mime_type: 'image/png' }))
      .toBe('![shot.png](/api/files/7)');
  });

  it('не-картинка (pdf) вставляется как обычная ссылка, а не битый ![]()', () => {
    expect(attachmentSnippet({ id: 8, original_name: 'report.pdf', mime_type: 'application/pdf' }))
      .toBe('[report.pdf](/api/files/8)');
  });

  // svg — это image/*, но сервер отдаёт его как octet-stream + attachment (он исполняет скрипт
  // с нашего origin), поэтому <img src> на него был бы битым. Проверка идёт по allowlist
  // инлайн-отдачи, а не по префиксу mime.
  it('svg — ссылка, хотя mime начинается с image/', () => {
    expect(attachmentSnippet({ id: 10, original_name: 'schema.svg', mime_type: 'image/svg+xml' }))
      .toBe('[schema.svg](/api/files/10)');
  });

  // `screenshot [1].png` — обычное имя (macOS и загрузки браузера плодят такие сами).
  // Незаэкранированная `[` обрывает подпись, и вместо картинки в Prose встаёт голый текст.
  it('скобки в имени экранируются, разметка не разваливается', () => {
    expect(attachmentSnippet({ id: 11, original_name: 'screenshot [1].png', mime_type: 'image/png' }))
      .toBe('![screenshot \\[1\\].png](/api/files/11)');
  });

  it('mime_type null (неизвестное расширение) — тоже ссылка, не img', () => {
    expect(attachmentSnippet({ id: 9, original_name: 'dump.qqq', mime_type: null }))
      .toBe('[dump.qqq](/api/files/9)');
  });
});
