import { useCallback, useEffect, useRef, useState } from 'react';
import { getAutoTick, patchAutoTick, type AutoTickState } from './api';

// 5с — индикатор живёт на минутной шкале, чаще незачем; отдельный поллер, а не
// прицеп к useVersion (2с): у того своя задача — ловить мутации доски.
export function useAutoTick(intervalMs = 5000): {
  state: AutoTickState | null;
  patch: (b: Partial<Pick<AutoTickState, 'enabled' | 'intervalSec' | 'maxWorkers'>>) => void;
  refresh: () => void;
  error: string | null;
  clearError: () => void;
} {
  const [state, setState] = useState<AutoTickState | null>(null);
  const [error, setError] = useState<string | null>(null);
  // patch() и poll() оба зовут setState — без порядка более медленный GET, начатый
  // до клика, может прилететь после PATCH и откатить чекбокс/селект на глазах.
  // patchSeq считает выданные patch(); inFlight — сколько из них ещё не осели.
  // Ответ patch() побеждает всегда: снимок poll фильтруется по обоим счётчикам.
  const patchSeq = useRef(0);
  const inFlight = useRef(0);

  const poll = useCallback((): void => {
    const seenAt = patchSeq.current;
    getAutoTick()
      .then((s) => {
        if (patchSeq.current === seenAt && inFlight.current === 0) setState(s);
      })
      .catch(() => { /* сервер перезапускается — продолжаем поллить */ });
  }, []);

  useEffect(() => {
    poll();
    const t = setInterval(poll, intervalMs);
    return () => clearInterval(t);
  }, [intervalMs, poll]);

  const patch = useCallback((b: Partial<Pick<AutoTickState, 'enabled' | 'intervalSec' | 'maxWorkers'>>) => {
    setError(null);
    patchSeq.current += 1;
    inFlight.current += 1;
    patchAutoTick(b)
      .then((s) => { inFlight.current -= 1; setState(s); })
      .catch((e: Error) => { inFlight.current -= 1; setError(e.message); });
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { state, patch, refresh: poll, error, clearError };
}
