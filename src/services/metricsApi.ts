// metricsApi — Sprint 5q observability fetchers.
//
// Read-side wrappers around `/v1/metrics/decisions` and
// `/v1/metrics/blocked`. Same ApiResult<T> contract as auditApi /
// marketApi — silent on failure (caller decides UI), RFC 7807 problem
// parsing, 8s timeout, AbortController cancellation.
//
// Kept as a sibling module rather than folded into auditApi because
// metrics queries have different caching characteristics (longer poll
// intervals, larger windows) and the SystemHealthPanel consumer
// shouldn't have to know which endpoint family the helper lives in.

import type {
  ApiResult,
  BlockedReasonsDTO,
  DecisionRateDTO,
  ProblemDetail,
} from '../types/api';
import { PROBLEM_TYPE } from '../types/api';
import { httpFetch } from './httpFetch';

const DEFAULT_BASE_URL = 'http://localhost:8001';
const FETCH_TIMEOUT_MS = 8000;

export interface FetchMetricsOptions {
  baseUrl?:       string;
  /** Backend clamps to 1..1440 minutes. */
  windowMinutes?: number;
  signal?:        AbortSignal;
}

/** Per-minute decision-rate buckets over the trailing window. */
export async function fetchDecisionRate(
  opts: FetchMetricsOptions = {},
): Promise<ApiResult<DecisionRateDTO>> {
  return _fetchMetric<DecisionRateDTO>(
    '/v1/metrics/decisions',
    opts.windowMinutes ?? 30,
    opts,
  );
}

/** Distribution of guardrail blocks over the trailing window. */
export async function fetchBlockedReasons(
  opts: FetchMetricsOptions = {},
): Promise<ApiResult<BlockedReasonsDTO>> {
  return _fetchMetric<BlockedReasonsDTO>(
    '/v1/metrics/blocked',
    opts.windowMinutes ?? 60,
    opts,
  );
}

// ── shared plumbing ───────────────────────────────────────────────────

async function _fetchMetric<T>(
  path: string,
  windowMinutes: number,
  opts: FetchMetricsOptions,
): Promise<ApiResult<T>> {
  if (windowMinutes < 1 || windowMinutes > 1440) {
    return {
      ok:        false,
      requestId: '-',
      problem: {
        type:       PROBLEM_TYPE.VALIDATION,
        title:      'Validation Error',
        status:     422,
        detail:     `window_minutes out of range: ${windowMinutes}`,
        request_id: '-',
      },
    };
  }

  const base   = opts.baseUrl ?? DEFAULT_BASE_URL;
  const params = new URLSearchParams({ window_minutes: String(windowMinutes) });
  const url    = `${base}${path}?${params.toString()}`;

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
    const data = await response.json() as T;
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
    if (s.aborted) { ctrl.abort(); break; }
    s.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  return ctrl.signal;
}
