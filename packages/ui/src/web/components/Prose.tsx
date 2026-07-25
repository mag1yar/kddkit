import Markdown from 'react-markdown';
import { cn } from '@/lib/utils';

export function Prose({ children }: { children: string }) {
  // prose даёт светло-серый body по умолчанию — принудительно foreground + видимый inline-code
  return (
    <div
      className={cn(
        'prose prose-sm max-w-none text-foreground',
        'prose-headings:text-foreground prose-strong:text-foreground prose-a:text-foreground',
        'prose-p:my-1 prose-p:text-foreground prose-li:text-foreground prose-li:my-0.5',
        'prose-blockquote:text-muted-foreground prose-pre:my-1',
        'prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:text-foreground',
        'prose-code:before:content-[""] prose-code:after:content-[""]',
        // code внутри pre — без inline-рамки (иначе бокс-в-боксе)
        '[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-inherit',
      )}
    >
      <Markdown>{children}</Markdown>
    </div>
  );
}
