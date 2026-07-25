import { useCallback, useEffect, useState } from 'react';
import { getAutoTick, patchAutoTick, type AutoTickState } from './api';

// 5с — индикатор живёт на минутной шкале, чаще незачем; отдельный поллер, а не
// прицеп к useVersion (2с): у того своя задача — ловить мутации доски.
export function useAutoTick(intervalMs = 5000): {
  state: AutoTickState | null;
  patch: (b: Partial<Pick<AutoTickState, 'enabled' | 'intervalSec' | 'maxWorkers'>>) => void;
  error: string | null;
} {
  const [state, setState] = useState<AutoTickState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = (): void => {
      getAutoTick()
        .then((s) => { if (alive) setState(s); })
        .catch(() => { /* сервер перезапускается — продолжаем поллить */ });
    };
    poll();
    const t = setInterval(poll, intervalMs);
    return () => { alive = false; clearInterval(t); };
  }, [intervalMs]);

  const patch = useCallback((b: Partial<Pick<AutoTickState, 'enabled' | 'intervalSec' | 'maxWorkers'>>) => {
    setError(null);
    patchAutoTick(b)
      .then(setState)
      .catch((e: Error) => setError(e.message));
  }, []);

  return { state, patch, error };
}
