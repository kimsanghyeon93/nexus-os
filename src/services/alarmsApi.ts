// alarmsApi — read-side wrapper around `GET /v1/alarms`.
//
// Mirrors the shape of `marketApi.ts` / `auditApi.ts` so the three
// fetchers share the same ApiResult<T> + RFC 7807 contract. The
// AlarmPanel polls this at 4s, so all of the per-request guards
// (timeout, abort signal, fault-tolerant 5xx retry inside httpFetch)
// have to be in place — a stuck request would block the next poll
// from sliding into the response slot.
//
// snake_case wire format on the request side too: the spec accepts
// `since`, `severity`, `status`, `source` as CSV / ISO-8601 — we do
// not re-case any of them. The TS option keys *can* be camelCase
// (frontend convention) since they're local to this module; the URL
// query string is built explicitly from those values so there's no
// JSON-key serialization step that would matter.

import type {
  AlarmListDTO,
  AlarmSeverity,
  AlarmStatus,
  ApiResult,
  ProblemDetail,
} from '../types/api';
import { PROBLEM_TYPE } from '../types/api';
import { defaultBackendHttpUrl, httpFetch } from './httpFetch';

const FETCH_TIMEOUT_MS = 8000;

export interface FetchAlarmsOptions {
  /** Override the backend base URL (e.g. for staging / production). */
  baseUrl?: string;
  /** Max rows. Backend enforces 1..200; out-of-range is short-circuited
   *  to a local validation problem so the operator sees the same
   *  ProblemDetail shape as a server-side reject. */
  limit?: number;
  /** ISO-8601 UTC lower bound. Omit to let the server default to 24h
   *  lookback (returned as `window_since` in the envelope). */
  since?: string;
  /** Filter alarms by severity. Empty array = no filter (all severities). */
  severities?: ReadonlyArray<AlarmSeverity>;
  /** Filter alarms by lifecycle status. Omit / empty = backend defaults
   *  to `['active']` per spec §2. */
  statuses?: ReadonlyArray<AlarmStatus>;
  /** Filter alarms by source (kebab-case component id). Empty = no
   *  filter. Spec caps at 20 tokens × 64 chars each. */
  sources?: ReadonlyArray<string>;
  /** Optional AbortSignal — the polling hook fires one of these per
   *  tick so an in-flight request from the previous interval is
   *  cancelled before the next dispatch. */
  signal?: AbortSignal;
}

/** Fetch the alarm envelope. Returns ApiResult<T> so the hook can
 *  branch on success/failure without try/catch noise. Any fetch error
 *  is synthesized as a NETWORK ProblemDetail with the same shape as
 *  the backend's RFC 7807 bodies — the UI's error branch doesn't have
 *  to distinguish "browser-side network down" from "server returned
 *  503", only the `type` URI matters. */
export async function fetchAlarms(
  opts: FetchAlarmsOptions = {},
): Promise<ApiResult<AlarmListDTO>> {
  const limit = opts.limit ?? 50;
  if (limit < 1 || limit > 200) {
    return {
      ok:        false,
      requestId: '-',
      problem: {
        type:       PROBLEM_TYPE.VALIDATION,
        title:      'Validation Error',
        status:     422,
        detail:     `limit out of range: ${limit}`,
        request_id: '-',
      },
    };
  }

  const base   = opts.baseUrl ?? defaultBackendHttpUrl();
  const params = new URLSearchParams({ limit: String(limit) });
  if (opts.since)                            params.set('since',    opts.since);
  if (opts.severities && opts.severities.length > 0) params.set('severity', opts.severities.join(','));
  if (opts.statuses   && opts.statuses.length   > 0) params.set('status',   opts.statuses.join(','));
  if (opts.sources    && opts.sources.length    > 0) params.set('source',   opts.sources.join(','));
  const url = `${base}/v1/alarms?${params.toString()}`;

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
    const data = await response.json() as AlarmListDTO;
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

/** AbortSignal.any() polyfill — same chain as auditApi/marketApi.
 *  Safari < 17 still doesn't ship the native helper. */
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
