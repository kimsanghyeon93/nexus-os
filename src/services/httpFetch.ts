// httpFetch — Sprint 5q+ shared fetch wrapper with transient-5xx retry.
//
// Symptom we're absorbing: on cold-start of the backend container,
// frontend mounts faster than the FastAPI lifespan completes. The
// first wave of GETs (audit/recent, ticks/*, metrics/*) hits a window
// where the request is dispatched but readyz is still false →
// asyncpg pool not initialized → 503 Service Unavailable from FastAPI.
// Within ~1-2s lifespan finishes and the next poll succeeds, but the
// 8 simultaneous failures land in the browser console as red noise.
//
// Mitigation here: on the FIRST 5xx (502/503/504) response, wait
// `retryDelayMs` and try once more. 4xx errors don't retry — those
// are client-side contract violations and a retry would just repeat
// the same failure. Network errors (fetch rejecting) also don't
// retry — the existing per-fetcher problem-synthesis path already
// covers that, and a retry that times out twice burns the whole
// budget.
//
// Caller signal is honored at every step — if the parent aborts
// between attempts, the retry short-circuits with the original abort.

export interface HttpFetchOptions extends RequestInit {
  /** Wait before retrying on a transient 5xx. Default 800ms — long
   *  enough to clear the typical FastAPI lifespan window, short
   *  enough not to feel like a hang to a user who refreshes during
   *  steady-state. */
  retryDelayMs?: number;
  /** Disable retry entirely (e.g. for non-idempotent operations
   *  where we don't want to risk a double-submit). Default false
   *  i.e. retry enabled for our current read-only surface. */
  noRetry?: boolean;
}

/** Returns true when the status code represents a transient upstream
 *  hiccup we'd want to retry. 500 is intentionally EXCLUDED — that's
 *  usually a real server bug, not a startup race. */
function isTransient5xx(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

export async function httpFetch(
  url: string,
  init: HttpFetchOptions = {},
): Promise<Response> {
  const { retryDelayMs = 800, noRetry, ...fetchInit } = init;
  const signal = fetchInit.signal ?? undefined;

  const first = await fetch(url, fetchInit);
  if (noRetry) return first;
  if (!isTransient5xx(first.status)) return first;
  if (signal && signal.aborted) return first;

  // Transient — wait and try once more. We do NOT drain `first.body`
  // here; the caller's existing problem-parsing path will read it if
  // the retry also fails (in which case we return the retry's
  // response, not the first). The first response is left for GC.
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, retryDelayMs);
    if (signal) {
      // Abort during the wait → resolve immediately so the retry
      // attempt sees the cancelled signal and short-circuits.
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });

  if (signal && signal.aborted) return first;
  return fetch(url, fetchInit);
}
