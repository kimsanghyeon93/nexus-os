// securitiesApi — read-side wrapper for the Sprint 5s+ securities master.
//
// Mirrors `alarmsApi.ts` / `marketApi.ts` so the four fetchers share the
// same ApiResult<T> + RFC 7807 contract. Three endpoints today:
//   GET /v1/securities              → SecurityListDTO
//   GET /v1/securities/{ticker}     → SecurityDTO        (404 on miss)
//   GET /v1/securities/relations    → SecurityRelationDTO[]  (no envelope)
//
// snake_case on the wire for every parameter the spec uses: `market`,
// `sector`, `kind`, `min_weight`, `tickers`. Option keys on this side may
// be camelCase since they're locals — the URL query string is assembled
// explicitly so there is no JSON-key serialization step.

import type {
  ApiResult,
  ProblemDetail,
  SecurityDTO,
  SecurityListDTO,
  SecurityRelationDTO,
} from '../types/api';
import { PROBLEM_TYPE } from '../types/api';
import { defaultBackendHttpUrl, httpFetch } from './httpFetch';

const FETCH_TIMEOUT_MS = 8000;

export interface FetchSecuritiesOptions {
  baseUrl?: string;
  /** CSV of `KRX|KOSDAQ|NASDAQ|NYSE|OTHER`. Empty / undefined = no filter. */
  market?: string;
  /** CSV of sector ids (≤32 chars / token, ≤20 tokens per spec). */
  sector?: string;
  /** Max rows. Backend caps at 1000; spec default 500. */
  limit?: number;
  /** Free-text search — ticker / name_ko / name_en / aliases fuzzy. */
  search?: string;
  signal?: AbortSignal;
}

export interface FetchSecurityRelationsOptions {
  baseUrl?: string;
  /** CSV of relation kinds. Empty / undefined = backend defaults
   *  (currently `sector` only). */
  kind?: string;
  /** 0.0..1.0 — drop edges below this weight. */
  min_weight?: number;
  /** CSV ticker list (≤50 tokens) — restrict to relations that touch
   *  at least one of these tickers. */
  tickers?: string;
  signal?: AbortSignal;
}

/** Fetch the master security list. Returns ApiResult<T> so the hook can
 *  branch on ok/!ok without try/catch noise. */
export async function fetchSecurities(
  opts: FetchSecuritiesOptions = {},
): Promise<ApiResult<SecurityListDTO>> {
  const base   = opts.baseUrl ?? defaultBackendHttpUrl();
  const params = new URLSearchParams();
  if (opts.market)         params.set('market', opts.market);
  if (opts.sector)         params.set('sector', opts.sector);
  if (opts.limit != null)  params.set('limit',  String(opts.limit));
  if (opts.search)         params.set('search', opts.search);
  const qs = params.toString();
  const url = qs ? `${base}/v1/securities?${qs}` : `${base}/v1/securities`;
  return await httpJson<SecurityListDTO>(url, opts.signal);
}

/** Single security by ticker. 404 surfaces as `security-not-found`
 *  ProblemDetail; callers should branch on `result.problem.type` rather
 *  than message strings. */
export async function fetchSecurity(
  ticker: string,
  opts: { baseUrl?: string; signal?: AbortSignal } = {},
): Promise<ApiResult<SecurityDTO>> {
  const base = opts.baseUrl ?? defaultBackendHttpUrl();
  const url  = `${base}/v1/securities/${encodeURIComponent(ticker)}`;
  return await httpJson<SecurityDTO>(url, opts.signal);
}

/** Relations master. Backend returns a plain array (no envelope) per
 *  spec §2 — we keep the shape and let the hook count them locally. */
export async function fetchRelations(
  opts: FetchSecurityRelationsOptions = {},
): Promise<ApiResult<SecurityRelationDTO[]>> {
  const base   = opts.baseUrl ?? defaultBackendHttpUrl();
  const params = new URLSearchParams();
  if (opts.kind)               params.set('kind',       opts.kind);
  if (opts.min_weight != null) params.set('min_weight', String(opts.min_weight));
  if (opts.tickers)            params.set('tickers',    opts.tickers);
  const qs = params.toString();
  const url = qs
    ? `${base}/v1/securities/relations?${qs}`
    : `${base}/v1/securities/relations`;
  return await httpJson<SecurityRelationDTO[]>(url, opts.signal);
}

// ── shared GET-and-parse helper ────────────────────────────────────────
//
// Three callsites, one body. Returns ApiResult<T> with the same
// ProblemDetail synthesis (NETWORK on fetch reject / abort, INTERNAL on
// JSON parse fail) that alarmsApi.ts uses, so the AppErrorBoundary
// branches behave identically regardless of which surface raised it.

async function httpJson<T>(
  url: string,
  callerSignal: AbortSignal | undefined,
): Promise<ApiResult<T>> {
  const internalCtrl = new AbortController();
  const timer = setTimeout(() => internalCtrl.abort(), FETCH_TIMEOUT_MS);
  const signal = callerSignal
    ? anyAbortSignal([internalCtrl.signal, callerSignal])
    : internalCtrl.signal;

  let response: Response;
  try {
    response = await httpFetch(url, {
      method:  'GET',
      headers: { Accept: 'application/json' },
      signal,
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

/** AbortSignal.any() polyfill — Safari < 17 doesn't ship the native
 *  helper. Identical to the copy in alarmsApi.ts; not pulled into a
 *  shared module yet because the count is still small. */
function anyAbortSignal(signals: AbortSignal[]): AbortSignal {
  type AnyFn = (signals: AbortSignal[]) => AbortSignal;
  const native = (AbortSignal as unknown as { any?: AnyFn }).any;
  if (typeof native === 'function') return native(signals);
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) { ctrl.abort(); break; }
    s.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  return ctrl.signal;
}
