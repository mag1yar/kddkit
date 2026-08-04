import { useRef, useState } from 'react';
import { Paperclip, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { deleteFile, fileHref, isInlineImage, uploadFile, type FileRow } from '../api';

const fmtSize = (n: number): string =>
  n < 1024 ? `${n} B`
    : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1024 / 1024).toFixed(1)} MB`;

export function FilesTab({ taskId, files, onChanged }: {
  taskId: number; files: FileRow[]; onChanged: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const send = (list: FileList | null) => {
    if (!list?.length) return;
    // allSettled, не all: один отбитый файл в пачке (мимо капа, мимо чего угодно) не должен
    // прятать те, что реально загрузились, — onChanged должен позвать их на экран в любом случае.
    Promise.allSettled([...list].map((f) => uploadFile(taskId, f))).then((results) => {
      onChanged();
      for (const r of results) {
        if (r.status === 'rejected') toast.error((r.reason as Error).message);
      }
    });
  };

  const detach = (id: number) => {
    deleteFile(id).then(onChanged).catch((e: Error) => toast.error(e.message));
  };

  // Drop-цель — весь таб, а подсвечивается только пунктирная зона внизу: перетаскивая файл
  // ПОВЕРХ списка, человек всё равно видит, куда он упадёт, но список при этом не мигает.
  return (
    <div
      className="flex flex-col gap-2"
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); send(e.dataTransfer.files); }}
    >
      {files.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {files.map((f) => (
            // Карточка на файл — та же форма, что у комментария в соседней вкладке.
            <li key={f.id} className="flex gap-2 rounded-md border p-2 text-xs">
              {/* Превью слева: имя файла о содержимом скриншота не говорит ничего.
                  Это не thumbnail-конвейер (он остаётся не-целью) — тот же байт-в-байт файл,
                  ужатый браузером в 36px. ponytail: для личной доски с десятком вложений
                  дешевле пары строк кода; если станет больно, тут появится ?w=72 на роуте. */}
              <a
                href={fileHref(f.id)} target="_blank" rel="noreferrer"
                className="shrink-0" title={f.original_name}
              >
                {isInlineImage(f.mime_type) ? (
                  <img
                    src={fileHref(f.id)} alt="" loading="lazy"
                    className="size-9 rounded border bg-muted object-cover"
                  />
                ) : (
                  <span className="flex size-9 items-center justify-center rounded border bg-muted">
                    <Paperclip className="size-3.5 text-muted-foreground" />
                  </span>
                )}
              </a>
              <div className="min-w-0 flex-1">
                {/* items-center на ОДНОЙ строке (имя, размер, корзина), а описание — отдельной
                    строкой под ней. Пока корзина стояла в одном ряду с блоком «имя + описание»,
                    она центрировалась по всему блоку и висела ниже имени. */}
                <div className="flex items-center gap-2">
                  <a
                    href={fileHref(f.id)} target="_blank" rel="noreferrer" title={f.original_name}
                    className="min-w-0 flex-1 truncate underline underline-offset-2 hover:text-primary"
                  >
                    {f.original_name}
                  </a>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {fmtSize(f.size_bytes)}
                  </span>
                  <Button
                    variant="ghost" size="icon-xs" title="Detach"
                    className="-mr-1 shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={() => detach(f.id)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
                {f.description && <p className="mt-1 text-muted-foreground">{f.description}</p>}
              </div>
            </li>
          ))}
        </ul>
      )}
      <div
        className={cn(
          'rounded-md border border-dashed p-2 text-center text-xs transition-colors',
          over ? 'border-primary bg-muted/50 text-foreground' : 'border-border text-muted-foreground',
        )}
      >
        Drop a file here, or{' '}
        <button type="button" className="underline" onClick={() => input.current?.click()}>
          choose one
        </button>
      </div>
      <input
        ref={input} type="file" multiple className="hidden"
        onChange={(e) => { send(e.target.files); e.target.value = ''; }}
      />
    </div>
  );
}
