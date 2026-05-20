// useSecurities — polling hook for the securities master + relations.
//
// Cadence (spec §5 frontend AC):
//   - Mount: fire both /v1/securities AND /v1/securities/relations once
//     (in parallel — they're independent).
//   - Steady state: re-poll every 60s. The master is static-ish (KIS seed
//     today, daily refresh in Sprint B) so a tight cadence would just
//     spam the backend with no observable change. The live metrics path
//     (last_price / change_pct) is the tick stream, not this hook.
//   - Filter changes (market/sector/search/limit) re-fire immediately.
//
// Return shape mirrors `useAlarms`: keep last good frame across failures
// so the canvas can keep rendering the old graph while the channel is
// flapping. `stale` is true when (a) `data_source === 'cached'` (backend
// is serving a snapshot because upstream is down) OR (b) the youngest
// `updated_at` in the response is > 24h old. RadarCanvas overlay reads
// it to flip the `◆ STALE · {age}` amber chip.

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';

import {
  fetchSecurities,
  fetchRelations,
  type FetchSecuritiesOptions,
  type FetchSecurityRelationsOptions,
} from '../services/securitiesApi';
import type {
  ProblemDetail,
  SecurityDTO,
  SecurityListDTO,
  SecurityRelationDTO,
} from '../types/api';

/** Base polling interval (60s — static master data, see header). */
export const SECURITIES_POLL_INTERVAL_MS = 60_000;

/** Stale threshold — `updated_at` older than this fires the ◆ STALE
 *  amber chip even when `data_source` claims fresh. */
export const SECURITIES_STALE_AGE_MS = 24 * 60 * 60 * 1000;

export interface UseSecuritiesOptions {
  /** Filter forwarded to GET /v1/securities. */
  market?: string;
  sector?: string;
  limit?:  number;
  search?: string;
  /** Filter forwarded to GET /v1/securities/relations. CSV of kinds. */
  relationKinds?: string;
  /** Minimum edge weight to load. Default 0.0. */
  minWeight?: number;
  /** Override base URL for staging / mocks. */
  baseUrl?: string;
  /** Override interval (tests). */
  intervalMs?: number;
}

export interface UseSecuritiesState {
  /** Latest master row set. null until the first response lands. */
  securities: SecurityDTO[];
  /** Latest relations array. null = same. Empty array = no relations
   *  for the active filter (distinct from null = haven't fetched yet). */
  relations:  SecurityRelationDTO[];
  /** `total` from the master envelope — may be > securities.length when
   *  `limit` truncated the result. Drives the `SHOWING N OF total` chip. */
  total:      number;
  /** True only during the very first parallel fetch. Subsequent polls
   *  do not flip it back to true so the canvas doesn't blink. */
  loading:    boolean;
  /** Latest ProblemDetail or null after a successful tick. */
  error:      ProblemDetail | null;
  /** True when `data_source === 'cached'` OR youngest updated_at >
   *  SECURITIES_STALE_AGE_MS. */
  stale:      boolean;
  /** ISO-8601 server_time from the most recent successful envelope.
   *  null until the first 200 arrives. */
  serverTime: string | null;
}

export interface UseSecuritiesResult extends UseSecuritiesState {
  /** Imperative refresh — cancels in-flight, fires both endpoints again. */
  refresh: () => void;
}

/** Determine the `stale` flag from a response envelope. Exported so tests
 *  and the canvas overlay can compute the same answer without
 *  re-implementing the rule. */
export function isSecuritiesEnvelopeStale(env: SecurityListDTO): boolean {
  if (env.items.length === 0) return false;
  for (const item of env.items) {
    if (item.data_source === 'cached') return true;
  }
  // Youngest update_at across the set — anything older than 24h is stale
  // even if the source claims fresh. `Date.parse` returns NaN on garbage
  // input; we treat NaN as "stale" so a malformed wire format degrades
  // safely to the amber chip rather than pretending the data is fresh.
  let youngest = -Infinity;
  for (const item of env.items) {
    const t = Date.parse(item.updated_at);
    if (Number.isNaN(t)) return true;
    if (t > youngest) youngest = t;
  }
  if (youngest === -Infinity) return false;
  return Date.now() - youngest > SECURITIES_STALE_AGE_MS;
}

export function useSecurities(opts: UseSecuritiesOptions = {}): UseSecuritiesResult {
  const {
    market,
    sector,
    limit,
    search,
    relationKinds,
    minWeight,
    baseUrl,
    intervalMs = SECURITIES_POLL_INTERVAL_MS,
  } = opts;

  const [state, setState] = useState<UseSecuritiesState>({
    securities: [],
    relations:  [],
    total:      0,
    loading:    true,
    error:      null,
    stale:      false,
    serverTime: null,
  });

  const [refreshToken, setRefreshToken] = useState(0);
  const refresh = useCallback(() => setRefreshToken(n => n + 1), []);

  // Stable JSON-tag of all filter values — same trick as useAlarms.
  const filterKey = JSON.stringify({
    market, sector, limit, search,
    relationKinds, minWeight, baseUrl, intervalMs,
  });

  // Mounted guard so a late-arriving response after unmount doesn't
  // setState into a stale tree.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let ctrl: AbortController | null = null;

    const pull = async (): Promise<void> => {
      ctrl?.abort();
      ctrl = new AbortController();
      const signal = ctrl.signal;

      const secOpts: FetchSecuritiesOptions = { signal };
      if (market    !== undefined) secOpts.market = market;
      if (sector    !== undefined) secOpts.sector = sector;
      if (limit     !== undefined) secOpts.limit  = limit;
      if (search    !== undefined) secOpts.search = search;
      if (baseUrl   !== undefined) secOpts.baseUrl = baseUrl;

      const relOpts: FetchSecurityRelationsOptions = { signal };
      if (relationKinds !== undefined) relOpts.kind       = relationKinds;
      if (minWeight     !== undefined) relOpts.min_weight = minWeight;
      if (baseUrl       !== undefined) relOpts.baseUrl    = baseUrl;

      const [secResult, relResult] = await Promise.all([
        fetchSecurities(secOpts),
        fetchRelations(relOpts),
      ]);

      if (!mountedRef.current || signal.aborted) return;

      // Either failure surfaces the problem; we don't lose the previous
      // good frame. Prefer the master endpoint's problem over relations
      // since the former is the primary feed.
      if (!secResult.ok) {
        setState(prev => ({
          ...prev,
          loading: false,
          error:   secResult.problem,
        }));
      } else if (!relResult.ok) {
        // Master succeeded — keep its data, surface relation problem.
        const env = secResult.data;
        setState(prev => ({
          securities: env.items,
          // Reuse previous relations rather than wiping — partial graph
          // beats empty graph for the operator.
          relations:  prev.relations,
          total:      env.total,
          loading:    false,
          error:      relResult.problem,
          stale:      isSecuritiesEnvelopeStale(env),
          serverTime: env.server_time,
        }));
      } else {
        const env = secResult.data;
        setState({
          securities: env.items,
          relations:  relResult.data,
          total:      env.total,
          loading:    false,
          error:      null,
          stale:      isSecuritiesEnvelopeStale(env),
          serverTime: env.server_time,
        });
      }

      if (!mountedRef.current) return;
      timer = setTimeout(() => { void pull(); }, intervalMs);
    };

    void pull();

    return () => {
      if (timer !== null) clearTimeout(timer);
      ctrl?.abort();
    };
    // filterKey covers all option-derived deps; refreshToken forces restart.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, refreshToken]);

  // Index by ticker — convenience for downstream consumers that want
  // O(1) lookup (e.g. AlarmRow joining entity_id → display_name client-
  // side when the backend hasn't populated entity_display yet). Memoized
  // so the reference is stable across renders that don't change the set.
  return useMemo(() => ({ ...state, refresh }), [state, refresh]);
}
