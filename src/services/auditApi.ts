// auditApi — Sprint 5o-C-3 read-side wrapper around `/v1/audit/recent`.
//
// One HTTP call, no WebSocket, no shared state. Returns ApiResult<T> so
// the modal can branch cleanly on success/failure without try/catch
// noise. The wrapper synthesizes a NETWORK problem when fetch() itself
// throws (the browser surfaces TypeError on CORS / DNS / offline) so
// the modal's error path renders consistent text regardless of where
// the failure happened.
//
// The backend host is paired with `BackendStreamer`'s default — both
// default to localhost:8001 because docker-compose.override.yml maps
// host 8001 → container 8000. To override (production / cloud-hosted),
// pass an explicit baseUrl into the helper or set NEXUS_BACKEND_URL
// at build-time via Vite's import.meta.env.

import type {
  ApiResult,
  AuditRecentDTO,
  ProblemDetail,
} from '../types/api';
import { PROBLEM_TYPE } from '../types/api';
import { defaultBackendHttpUrl, httpFetch } from './httpFetch';

/** Default REST base — sibling of BackendStreamer's WS URL. Mirroring
 *  the override-via-constructor pattern would require threading config
 *  through useMarketData; for now a module-level default keeps the
 *  modal call site one-liner. */
// Sprint 5s+ loop iteration: was a duplicated literal here +
// marketApi.ts + metricsApi.ts. Now sourced from httpFetch.ts so
// VITE_BACKEND_HTTP_URL overrides all three fetchers at once.

const FETCH_TIMEOUT_MS = 8000;

export interface FetchAuditOptions {
  /** Override the backend base URL (e.g. for staging / production). */
  baseUrl?: string;
  /** Newest-first row cap. Backend enforces 1..200; out-of-range values
   *  are rejected before the request goes out so the user sees a
   *  validation error instead of a 422 round-trip. */
  limit?: number;
  /** Optional AbortSignal — lets the modal cancel a stale request when
   *  the operator presses ⌘L for a different symbol mid-flight. */
  signal?: AbortSignal;
}

/** Symbol-targeted audit lookup. Surfaces every coordinator decision
 *  for the symbol newest-first; the modal renders an empty state when
 *  the array is empty (no decisions yet vs DB hiccup are indistinguish-
 *  able to the operator — both produce []. The repo logs the latter
 *  for ops). */
export async function fetchRecentAudit(
  symbol: string,
  opts: FetchAuditOptions = {},
): Promise<ApiResult<AuditRecentDTO>> {
  const limit = opts.limit ?? 20;
  if (!symbol || limit < 1 || limit > 200) {
    return {
      ok:        false,
      requestId: '-',
      problem: {
        type:       PROBLEM_TYPE.VALIDATION,
        title:      'Validation Error',
        status:     422,
        detail:     `Invalid params (symbol="${symbol}", limit=${limit})`,
        request_id: '-',
      },
    };
  }

  const base   = opts.baseUrl ?? defaultBackendHttpUrl();
  const params = new URLSearchParams({ symbol, limit: String(limit) });
  const url    = `${base}/v1/audit/recent?${params.toString()}`;

  // Compose a shared abort signal: caller's signal AND a local timeout.
  // Either firing aborts the fetch; we synthesize an appropriate problem
  // based on which one tripped.
  const internalCtrl = new AbortController();
  const timer = setTimeout(() => internalCtrl.abort(), FETCH_TIMEOUT_MS);
  const signals: AbortSignal[] = [internalCtrl.signal];
  if (opts.signal) signals.push(opts.signal);
  const signal = signals.length === 1
    ? signals[0]
    : anyAbortSignal(signals);

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
    const detail = aborted
      ? `Request timed out after ${FETCH_TIMEOUT_MS}ms`
      : (err instanceof Error ? err.message : 'fetch failed');
    return {
      ok:        false,
      requestId: '-',
      problem: {
        type:       PROBLEM_TYPE.NETWORK,
        title:      aborted ? 'Request Timeout' : 'Network Error',
        status:     aborted ? 504 : 0,
        detail,
        request_id: '-',
      },
    };
  }
  clearTimeout(timer);

  const requestId = response.headers.get('x-request-id') ?? '-';

  // Non-2xx → parse the RFC 7807 body if it's there. Defensive — a
  // misconfigured proxy might return text/html on 502 etc.
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

  // 2xx — parse + return.
  try {
    const data = await response.json() as AuditRecentDTO;
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

/** AbortSignal.any() polyfill — Safari < 17 still doesn't ship it.
 *  Chains the inputs into one signal that aborts as soon as any source
 *  aborts. */
function anyAbortSignal(signals: AbortSignal[]): AbortSignal {
  // Guard for runtime support; falls through to manual chaining otherwise.
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
