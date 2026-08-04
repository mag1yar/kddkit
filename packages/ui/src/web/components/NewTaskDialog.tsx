import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  BUG_BODY_TEMPLATE, KINDS, PRIORITIES, createTask, type Kind, type Priority, type Track,
} from '../api';
import { trackLabel, trackOptions } from '../filters';
import { MarkdownEditor } from './MarkdownEditor';

export function NewTaskDialog({ open, tracks, defaultTrack, onClose, onCreated }: {
  open: boolean; tracks: Track[]; defaultTrack: number | null;
  onClose: () => void; onCreated: () => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [priority, setPriority] = useState<Priority>('medium');
  const [kind, setKind] = useState<Kind>('feature');
  const [track, setTrack] = useState<number | null>(defaultTrack);

  // диалог не размонтируется → синхроним с фильтром доски при открытии
  useEffect(() => { if (open) setTrack(defaultTrack); }, [open, defaultTrack]);

  // Скелет repro — подсказка о форме готовности в момент, когда её ещё можно заполнить.
  // Только в пустое тело: написанное человеком не трогаем. Обратное переключение типа
  // текст не забирает — редактор принадлежит автору, а не селекту.
  const pickKind = (k: Kind) => {
    setKind(k);
    if (k === 'bug' && body === '') setBody(BUG_BODY_TEMPLATE);
  };

  const create = () => {
    createTask({ title, body: body || undefined, priority, kind, track_id: track ?? undefined })
      .then(() => {
        setTitle(''); setBody(''); setPriority('medium'); setKind('feature');
        onCreated(); onClose();
      })
      .catch((e: Error) => toast.error(e.message));
  };

  const options = trackOptions(tracks, defaultTrack);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>New task</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-2">
          <Input value={title} placeholder="Title" onChange={(e) => setTitle(e.target.value)} />
          <MarkdownEditor
            value={body} placeholder="markdown body (optional)" minHeight="144px" maxHeight="320px"
            onChange={setBody}
            className="overflow-hidden rounded-md border focus-within:ring-1 focus-within:ring-ring"
          />
          <div className="flex gap-2">
            <Select value={kind} onValueChange={(v) => pickKind(v as Kind)}>
              <SelectTrigger className="w-40 capitalize"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {KINDS.map((k) => (
                    <SelectItem key={k} value={k} className="capitalize">{k}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Select value={priority} onValueChange={(v) => setPriority(v as Priority)}>
              <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {PRIORITIES.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                </SelectGroup>
              </SelectContent>
            </Select>
            {options.length > 0 && (
              <Select
                value={track === null ? 'none' : String(track)}
                onValueChange={(v) => setTrack(v === 'none' ? null : Number(v))}
              >
                <SelectTrigger className="w-48">
                  <SelectValue placeholder="No track">
                    {(v) => {
                      if (v === 'none') return 'No track';
                      const t = options.find((o) => o.id === Number(v));
                      return t ? trackLabel(t) : '';
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No track</SelectItem>
                  {options.map((t) => (
                    <SelectItem key={t.id} value={String(t.id)}>{trackLabel(t)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div>
            <Button size="sm" onClick={create}>Create</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
