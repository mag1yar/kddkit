import { useState } from 'react';
import { ListPlus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  addCriterion, removeCriterion, setCriterionChecked, type Criterion,
} from '../api.js';

const fmtDate = (ts: number) => new Date(ts * 1000).toLocaleString();

export function CriteriaList({ taskId, criteria, onChanged, text, setText }: {
  taskId: number; criteria: Criterion[]; onChanged: () => void;
  text: string; setText: (v: string) => void;
}) {
  // взведённое удаление; одно на список — взвести второй критерий значит отпустить первый
  const [armed, setArmed] = useState<number | null>(null);
  const err = (e: Error) => toast.error(e.message);
  const done = criteria.filter((c) => c.checked_at !== null).length;
  const add = () => {
    if (!text.trim()) return;
    addCriterion(taskId, text).then(() => { setText(''); onChanged(); }).catch(err);
  };
  return (
    // увели мышь со списка — взвод снят: подтверждение не должно ждать вечно
    <div className="flex flex-col gap-1.5" onMouseLeave={() => setArmed(null)}>
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Criteria{criteria.length > 0 && ` ${done}/${criteria.length}`}
      </span>
      {criteria.map((c) => (
        <div key={c.id} className="group flex items-start gap-2 text-sm">
          <Checkbox
            className="mt-0.5"
            checked={c.checked_at !== null}
            onCheckedChange={(v) =>
              setCriterionChecked(taskId, c.id, v === true).then(onChanged).catch(err)}
          />
          <div className="min-w-0 flex-1">
            <div className={cn(c.checked_at !== null && 'text-muted-foreground line-through')}>
              {c.text}
            </div>
            {c.evidence && (
              <div className="break-words text-xs text-muted-foreground">evidence: {c.evidence}</div>
            )}
            {c.checked_at && c.checked_by && (
              <div className="text-xs text-muted-foreground">
                {`checked by ${c.checked_by} · ${fmtDate(c.checked_at)}`}
              </div>
            )}
          </div>
          {/* Удаление критерия необратимо — undo на доске нет, текст не восстановить.
              Поэтому первый клик взводит, второй удаляет. Раскрывается и по фокусу, а не
              только по hover: invisible-кнопка ловила таб и оставалась невидимой. */}
          <button
            type="button"
            aria-label={armed === c.id ? 'Confirm remove criterion' : 'Remove criterion'}
            className={cn(
              'flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs opacity-0 transition',
              'group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none',
              armed === c.id
                ? 'bg-destructive/10 text-destructive opacity-100'
                : 'text-muted-foreground hover:text-destructive',
            )}
            onBlur={() => setArmed(null)}
            onClick={() => {
              if (armed !== c.id) { setArmed(c.id); return; }
              removeCriterion(taskId, c.id)
                .then(() => { setArmed(null); onChanged(); }).catch(err);
            }}
          >
            <Trash2 className="size-3.5" />
            {armed === c.id && <span>Remove?</span>}
          </button>
        </div>
      ))}
      {/* Кнопка в поле, а не только Enter: без неё набранный критерий выглядел добавленным —
          поле молчит одинаково и с отправленным текстом, и с забытым. Внутри, а не рядом:
          соседняя кнопка отъедала бы ширину у строки критерия на всей высоте списка.
          pr под её ширину — иначе длинный текст уезжает под кнопку. */}
      <div className="relative">
        <Input
          value={text} placeholder="Add criterion..." className="h-8 pr-[4.25rem]"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
        />
        <Button
          size="sm" variant={text.trim() ? 'default' : 'ghost'}
          className="absolute top-1 right-1 h-6 gap-1 px-2 text-xs [&_svg]:size-3"
          disabled={!text.trim()} onClick={add}
        >
          <ListPlus /> Add
        </Button>
      </div>
    </div>
  );
}
