// balanceApi — KIS Balance Panel read-side wrapper around `/v1/balance`.
//
// Mirrors the shape of `services/marketApi.ts` and `services/metricsApi.ts`
// so all endpoints share the same ApiResult<T> contract + RFC 7807 problem
// handling. Kept as a sibling module because balance queries have independent
// caching / error semantics.

import type { ApiResult, BalanceDTO, ProblemDetail } from '../types/api';
import { PROBLEM_TYPE } from '../types/api';
import { defaultBackendHttpUrl, httpFetch } from './httpFetch';

// Sprint 5s+ loop iteration: was duplicated across auditApi/marketApi/
// metricsApi. Now sourced from httpFetch.ts so VITE_BACKEND_HTTP_URL
// overrides all three fetchers in lockstep.
const FETCH_TIMEOUT_MS = 8000;

export interface FetchBalanceOptions {
  baseUrl?: string;
  /** Cancel inflight on unmount. */
  signal?:  AbortSignal;
}

/** KIS balance summary and holdings. */
export async function fetchBalance(
  opts: FetchBalanceOptions = {},
): Promise<ApiResult<BalanceDTO>> {
  const base = opts.baseUrl ?? defaultBackendHttpUrl();
  const url  = `${base}/v1/balance`;

  const internalCtrl = new AbortController();
  const timer = setTimeout(() => internalCtrl.abort(), FETCH_TIMEOUT_MS);
  const signals: AbortSignal[] = [internalCtrl.signal];
  if (opts.signal) signals.push(opts.signal);
  const signal = signals.length === 1 ? signals[0] : anyAbortSignal(signals);

  let response: Response;
  try {
    response = await httpFetch(url, {
      method:  'GET',
      headers: { 'Accept': 'application/json' },
      ...(signal !== undefined ? { signal } : {}),
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = err instanceof DOMException && err.name === 'AbortError';
    return {
      ok:        false,
      requestId: '-',
      problem: {
        type:       PROBLEM_TYPE.NETWORK,
        title:      aborted ? 'Request Timeout' : 'Network Error',
        status:     aborted ? 504 : 0,
        detail:     aborted
                    ? `Request timed out after ${FETCH_TIMEOUT_MS}ms`
                    : (err instanceof Error ? err.message : 'fetch failed'),
        request_id: '-',
      },
    };
  }
  clearTimeout(timer);

  const requestId = response.headers.get('x-request-id') ?? '-';
  if (!response.ok) {
    let problem: ProblemDetail;
    try {
      const body = await response.json() as Partial<ProblemDetail>;
      problem = {
        type:       body.type   ?? PROBLEM_TYPE.INTERNAL,
        title:      body.title  ?? `HTTP ${response.status}`,
        status:     body.status ?? response.status,
        detail:     body.detail,
        instance:   body.instance,
        request_id: body.request_id ?? requestId,
        ...(body.errors !== undefined ? { errors: body.errors } : {}),
      };
    } catch {
      problem = {
        type:       PROBLEM_TYPE.INTERNAL,
        title:      `HTTP ${response.status}`,
        status:     response.status,
        detail:     'Response body was not valid JSON',
        request_id: requestId,
      };
    }
    return { ok: false, requestId, problem };
  }

  try {
    const data = await response.json() as BalanceDTO;
    return { ok: true, requestId, data };
  } catch (err) {
    return {
      ok:        false,
      requestId,
      problem: {
        type:       PROBLEM_TYPE.INTERNAL,
        title:      'Bad Response',
        status:     502,
        detail:     err instanceof Error ? err.message : 'invalid JSON',
        request_id: requestId,
      },
    };
  }
}

function anyAbortSignal(signals: AbortSignal[]): AbortSignal {
  type AnyFn = (signals: AbortSignal[]) => AbortSignal;
  const native = (AbortSignal as unknown as { any?: AnyFn }).any;
  if (typeof native === 'function') {
    return native(signals);
  }
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ctrl.abort();
      break;
    }
    s.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  return ctrl.signal;
}
