// useBalance — polling hook for `GET /v1/balance`.
//
// Cadence (default 30s):
//   - Fetches immediately on mount.
//   - Re-fetches every `intervalMs` (default 30_000ms) via setInterval.
//   - `refresh()` triggers an immediate re-fetch AND resets the interval
//     timer, so the next auto-refresh is `intervalMs` from the manual call.
//   - On unmount: clears the interval and aborts any inflight request.
//
// Return shape: `{ data, loading, error, refresh, lastUpdated }`.
//   - `data` holds the last successful BalanceDTO (not cleared on failure).
//   - `loading` is true while any fetch is in flight.
//   - `error` is the failure message string, or null after a success.
//   - `lastUpdated` is the Date of the last successful fetch, null until
//     the first success.

import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchBalance } from '../services/balanceApi';
import type { BalanceDTO } from '../types/api';

export interface UseBalanceResult {
  data:        BalanceDTO | null;
  loading:     boolean;
  error:       string | null;
  refresh:     () => void;
  lastUpdated: Date | null;
}

export function useBalance(intervalMs = 30_000): UseBalanceResult {
  const [data,        setData]        = useState<BalanceDTO | null>(null);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  // Interval handle — kept in a ref so cleanup and refresh() can clear it
  // without capturing a stale closure value.
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // AbortController for the most recent in-flight request so we can cancel
  // it on unmount or when refresh() supersedes it.
  const ctrlRef = useRef<AbortController | null>(null);
  // Tracks whether the component is still mounted — prevents state updates
  // after unmount (AbortError path already silences those, but non-abort
  // branches need the guard too).
  const mountedRef = useRef(true);

  // Core fetch function — creates a fresh AbortController, calls fetchBalance,
  // and updates state based on the ApiResult discriminated union.
  const fetchOnce = useCallback(async () => {
    // Abort any previous inflight request before starting a new one.
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;

    setLoading(true);

    const result = await fetchBalance({ signal: ctrl.signal });

    // Ignore updates after unmount or if this request was aborted.
    if (!mountedRef.current || ctrl.signal.aborted) return;

    setLoading(false);

    if (result.ok) {
      setData(result.data);
      setError(null);
      setLastUpdated(new Date());
    } else {
      setError(
        result.problem?.detail ??
        result.problem?.title  ??
        'Balance fetch failed',
      );
    }
  }, []);

  // Schedules (or re-schedules) the polling interval. Exposed via `refresh`
  // so the caller can reset the timer after a manual trigger.
  const scheduleInterval = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
    }
    intervalRef.current = setInterval(() => {
      void fetchOnce();
    }, intervalMs);
  }, [fetchOnce, intervalMs]);

  // Mount: fetch immediately and start the auto-refresh interval.
  useEffect(() => {
    mountedRef.current = true;

    void fetchOnce();
    scheduleInterval();

    return () => {
      mountedRef.current = false;
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      ctrlRef.current?.abort();
    };
    // fetchOnce and scheduleInterval are stable (useCallback with no deps
    // that change after mount under normal use). intervalMs is intentionally
    // NOT in the dep array here because we manage the interval manually —
    // callers that change intervalMs should remount the hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // `refresh()` — triggers an immediate fetch and resets the interval so
  // the next auto-refresh is `intervalMs` from now.
  const refresh = useCallback(() => {
    void fetchOnce();
    scheduleInterval();
  }, [fetchOnce, scheduleInterval]);

  return { data, loading, error, refresh, lastUpdated };
}
