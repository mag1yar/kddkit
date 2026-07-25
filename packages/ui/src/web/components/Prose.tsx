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
      {/* react-markdown отдаёт голый <a href>. Доска — единственная вкладка с открытым
          диалогом и ?project=<hash> в URL: переход по ссылке из тела релиза или комментария
          терял бы это состояние и утекал бы хэш проекта в Referer. */}
      <Markdown
        components={{
          a: ({ node: _node, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer" />
          ),
        }}
      >
        {children}
      </Markdown>
    </div>
  );
}
