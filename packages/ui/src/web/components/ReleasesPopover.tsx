import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { ReleaseInfo } from '../api';
import { Prose } from './Prose';

export function ReleasesPopover({ info }: { info: ReleaseInfo | null }) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            // акцент ровно при hasUpdate; ошибка и «нет данных» выглядят как обычная версия,
            // а не как поломка — оффлайн не должен мигать красным
            title={info?.error ?? 'Releases'}
            className={cn(
              'rounded px-1.5 py-0.5 font-mono text-xs transition-colors',
              info?.hasUpdate
                ? 'bg-primary/15 text-primary hover:bg-primary/25'
                : 'text-muted-foreground hover:bg-muted',
            )}
          >
            {info ? `v${info.current}` : 'v…'}{info?.hasUpdate ? ' ↑' : ''}
          </button>
        }
      />
      <PopoverContent align="start" className="max-h-[60vh] w-96 overflow-y-auto">
        {info?.hasUpdate && (
          <p className="text-xs text-primary">
            Update available: {info.current} → {info.latest}
          </p>
        )}
        {!info?.releases.length ? (
          <p className="text-xs text-muted-foreground">
            {info?.error ?? 'No releases yet'}
          </p>
        ) : (
          info.releases.map((r) => (
            <div key={r.version} className="border-b pb-2 last:border-0 last:pb-0">
              <div className="flex items-baseline justify-between gap-2">
                <a
                  href={r.url} target="_blank" rel="noreferrer"
                  className="font-medium hover:underline"
                >
                  v{r.version}{r.prerelease ? ' (pre)' : ''}
                </a>
                <span className="text-xs text-muted-foreground">
                  {r.publishedAt.slice(0, 10)}
                </span>
              </div>
              {/* changelogithub оборачивает short sha в <samp> — react-markdown не рендерит raw HTML,
                  теги остались бы видны буквально; rehype-raw это тело с GitHub не стоит превращать
                  в живой HTML, поэтому просто вырезаем теги, текст внутри (sha) остаётся */}
              <Prose>{r.body.replace(/<\/?[a-z][^>]*>/gi, '')}</Prose>
            </div>
          ))
        )}
      </PopoverContent>
    </Popover>
  );
}
