// marketApi — Sprint 5p-C read-side wrapper around `/v1/ticks/recent`.
//
// Mirrors the shape of `services/auditApi.ts` so both endpoints share
// the same ApiResult<T> contract + RFC 7807 problem handling. Kept as
// a sibling module (not a folded export) because the audit and tick
// surfaces have completely independent caching / error semantics —
// merging them into one "apiClient" would hide that.

import type {
  ApiResult,
  MarketTickRecentDTO,
  MarketTickSnapshotsDTO,
  MarketTickTapeDTO,
  MarketVolumeWindowDTO,
  ProblemDetail,
} from '../types/api';
import { PROBLEM_TYPE } from '../types/api';
import { httpFetch } from './httpFetch';

const DEFAULT_BASE_URL = 'http://localhost:8001';
const FETCH_TIMEOUT_MS = 8000;

export interface FetchTicksOptions {
  baseUrl?: string;
  /** Backend clamps to 1..500. The HUD sparkline draws 60–120 by default. */
  limit?:   number;
  /** Cancel inflight on symbol change / unmount. */
  signal?:  AbortSignal;
}

export async function fetchRecentTicks(
  symbol: string,
  opts: FetchTicksOptions = {},
): Promise<ApiResult<MarketTickRecentDTO>> {
  const limit = opts.limit ?? 60;
  if (!symbol || limit < 1 || limit > 500) {
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

  const base   = opts.baseUrl ?? DEFAULT_BASE_URL;
  const params = new URLSearchParams({ symbol, limit: String(limit) });
  const url    = `${base}/v1/ticks/recent?${params.toString()}`;

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
    const data = await response.json() as MarketTickRecentDTO;
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

// ──────────────────────────────────────────────────────────────────────
//  Multi-symbol snapshot — Sprint 5p-D
// ──────────────────────────────────────────────────────────────────────

export interface FetchSnapshotOptions {
  baseUrl?: string;
  signal?:  AbortSignal;
}

/** Last-tick snapshot for many symbols in one round-trip. Drives the
 *  right-column KisLiveSnapshot grid; the backend coalesces with
 *  DISTINCT ON so we don't pay 12 separate fetches. */
export async function fetchTickSnapshot(
  symbols: ReadonlyArray<string>,
  opts: FetchSnapshotOptions = {},
): Promise<ApiResult<MarketTickSnapshotsDTO>> {
  const clean = symbols.map(s => s.trim()).filter(s => s.length > 0);
  if (clean.length === 0) {
    return {
      ok:        true,
      requestId: '-',
      data:      { requested: [], snapshots: [] },
    };
  }

  const base   = opts.baseUrl ?? DEFAULT_BASE_URL;
  const params = new URLSearchParams({ symbols: clean.join(',') });
  const url    = `${base}/v1/ticks/snapshot?${params.toString()}`;

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
    const data = await response.json() as MarketTickSnapshotsDTO;
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

// ──────────────────────────────────────────────────────────────────────
//  Cross-symbol tape — Sprint 5p-E (forensic stream)
// ──────────────────────────────────────────────────────────────────────

export interface FetchTapeOptions {
  baseUrl?: string;
  /** Backend clamps to 1..500. TapePanel renders 50–100 by default. */
  limit?:   number;
  signal?:  AbortSignal;
}

/** Newest-first tape of ticks across many symbols. */
export async function fetchTickTape(
  symbols: ReadonlyArray<string>,
  opts: FetchTapeOptions = {},
): Promise<ApiResult<MarketTickTapeDTO>> {
  const clean = symbols.map(s => s.trim()).filter(s => s.length > 0);
  const limit = opts.limit ?? 100;
  if (clean.length === 0) {
    return { ok: true, requestId: '-', data: { entries: [] } };
  }
  if (limit < 1 || limit > 500) {
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

  const base   = opts.baseUrl ?? DEFAULT_BASE_URL;
  const params = new URLSearchParams({
    symbols: clean.join(','),
    limit:   String(limit),
  });
  const url    = `${base}/v1/ticks/tape?${params.toString()}`;

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
    const data = await response.json() as MarketTickTapeDTO;
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

// ──────────────────────────────────────────────────────────────────────
//  Volume aggregate — Sprint 5p-H (histogram source)
// ──────────────────────────────────────────────────────────────────────

export interface FetchVolumeOptions {
  baseUrl?:       string;
  /** Backend clamps to 1..1440 minutes. Default = 60. */
  windowMinutes?: number;
  signal?:        AbortSignal;
}

/** Per-symbol SUM(volume) over a recent window. Empty/whitespace input
 *  short-circuits before issuing the request. */
export async function fetchVolumeWindow(
  symbols: ReadonlyArray<string>,
  opts: FetchVolumeOptions = {},
): Promise<ApiResult<MarketVolumeWindowDTO>> {
  const clean = symbols.map(s => s.trim()).filter(s => s.length > 0);
  const windowMinutes = opts.windowMinutes ?? 60;
  if (clean.length === 0) {
    return {
      ok:        true,
      requestId: '-',
      data:      { window_minutes: windowMinutes, buckets: [] },
    };
  }
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
  const params = new URLSearchParams({
    symbols:        clean.join(','),
    window_minutes: String(windowMinutes),
  });
  const url    = `${base}/v1/ticks/volume?${params.toString()}`;

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
    const data = await response.json() as MarketVolumeWindowDTO;
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
