import Markdown from 'react-markdown';
import { cn } from '@/lib/utils';
import { withProject } from '../api';

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
          // Не-картиночное вложение (TaskDialog вставляет его как обычную ссылку) — тот же
          // /api/files/<id>, что и у img ниже, и без ?project/?token открылась бы чужая доска
          // или 401 на выставленном наружу сервере — та же дыра, что была у img.
          a: ({ node: _node, href, ...props }) => (
            <a
              {...props}
              href={typeof href === 'string' && href.startsWith('/api/files/') ? withProject(href) : href}
              target="_blank" rel="noreferrer"
            />
          ),
          // В теле задачи вложение стоит как /api/files/<id> — без хвоста запроса. <img>
          // ходит в сеть сам, мимо req(), поэтому ?project и ?token дописываем здесь: иначе
          // картинка тянулась бы из чужой доски, а на выставленном наружу сервере — из 401.
          // Хранить их в самом markdown нельзя: токен утёк бы в базу и в git-экспорт.
          img: ({ node: _node, src, ...props }) => (
            <img
              {...props}
              src={typeof src === 'string' && src.startsWith('/api/files/') ? withProject(src) : src}
            />
          ),
        }}
      >
        {children}
      </Markdown>
    </div>
  );
}
