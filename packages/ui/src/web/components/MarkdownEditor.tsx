import { useEffect, useRef } from 'react';
import OverType, { type OverTypeInstance, type Theme } from 'overtype';

// цвета редактора из shadcn-переменных — тема всегда совпадает с приложением
const KDD_THEME: Theme = {
  name: 'kdd',
  colors: {
    bgPrimary: 'var(--color-background)',
    bgSecondary: 'var(--color-background)',
    text: 'var(--color-foreground)',
    cursor: 'var(--color-foreground)',
    placeholder: 'var(--color-muted-foreground)',
    h1: 'var(--color-foreground)',
    h2: 'var(--color-foreground)',
    h3: 'var(--color-foreground)',
    strong: 'var(--color-foreground)',
    em: 'var(--color-foreground)',
    link: 'var(--color-primary)',
    code: 'var(--color-foreground)',
    codeBg: 'var(--color-muted)',
    blockquote: 'var(--color-muted-foreground)',
    syntaxMarker: 'var(--color-muted-foreground)',
    listMarker: 'var(--color-muted-foreground)',
    hr: 'var(--color-border)',
    border: 'var(--color-border)',
  },
};

export function MarkdownEditor({
  value, onChange, placeholder, minHeight = '64px', maxHeight, autoFocus, onEnterSubmit,
  onUpload, className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** только px: overtype делает parseInt, rem/em молча превращаются в мусор */
  minHeight?: string;
  maxHeight?: string;
  autoFocus?: boolean;
  /** Enter отправляет, Shift+Enter — перенос строки */
  onEnterSubmit?: () => void;
  /** вставка/drop файла — резолвится в markdown-сниппет, который дописывается в конец */
  onUpload?: (file: File) => Promise<string>;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<OverTypeInstance | null>(null);
  const cb = useRef({ onChange, onEnterSubmit, onUpload });
  cb.current = { onChange, onEnterSubmit, onUpload };

  useEffect(() => {
    const [ed] = new OverType(host.current!, {
      value,
      placeholder,
      autofocus: autoFocus,
      toolbar: false,
      autoResize: true,
      minHeight,
      maxHeight: maxHeight ?? null,
      smartLists: true,
      fontSize: '0.8125rem',
      theme: KDD_THEME,
      onChange: (v) => cb.current.onChange(v),
      onKeydown: (e) => {
        if (e.key === 'Enter' && !e.shiftKey && cb.current.onEnterSubmit) {
          e.preventDefault();
          cb.current.onEnterSubmit();
        }
      },
    });
    editor.current = ed;
    return () => { ed.destroy(); editor.current = null; };
    // init один раз: value дальше синхронится эффектом ниже
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // внешний сброс (setComment('') после отправки и т.п.)
  useEffect(() => {
    const ed = editor.current;
    if (ed && ed.getValue() !== value) ed.setValue(value);
  }, [value]);

  // Вставка картинки из буфера и перетаскивание файла. overtype своих хуков на это не даёт,
  // поэтому слушаем сам контейнер в фазе всплытия — редактор уже обработал событие, и мы
  // дописываем результат к тому, что в нём лежит.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const take = (files: FileList | null, e: Event): void => {
      const list = [...(files ?? [])];
      if (!list.length || !cb.current.onUpload) return;
      e.preventDefault();
      const upload = cb.current.onUpload;
      // allSettled, не all: при пачке из двух картинок, где одна мимо капа, Promise.all
      // выбрасывал бы и снипет уцелевшей — файл прикреплён и виден во вкладке Files, а в тексте
      // ссылки на него нет и никакого признака этого тоже нет. Отказ озвучивает onUpload
      // вызывающего (он тостит и пробрасывает), нам остаётся вставить то, что доехало.
      Promise.allSettled(list.map(upload)).then((results) => {
        const snippets = results
          .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled')
          .map((r) => r.value);
        const ed = editor.current;
        if (!ed || !snippets.length) return;
        // Пустой редактор — не пустая строка: `${''}\n\n...` вставлял бы два пустых абзаца
        // ПЕРЕД первым же вложением.
        const body = ed.getValue();
        const next = `${body ? `${body}\n\n` : ''}${snippets.join('\n\n')}\n`;
        ed.setValue(next);
        cb.current.onChange(next);
      });
    };
    const onPaste = (e: ClipboardEvent): void => take(e.clipboardData?.files ?? null, e);
    const onDrop = (e: DragEvent): void => take(e.dataTransfer?.files ?? null, e);
    const onDragOver = (e: DragEvent): void => { if (cb.current.onUpload) e.preventDefault(); };
    el.addEventListener('paste', onPaste);
    el.addEventListener('drop', onDrop);
    el.addEventListener('dragover', onDragOver);
    return () => {
      el.removeEventListener('paste', onPaste);
      el.removeEventListener('drop', onDrop);
      el.removeEventListener('dragover', onDragOver);
    };
  }, []);

  return <div ref={host} className={className} />;
}
