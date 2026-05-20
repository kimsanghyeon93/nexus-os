// useAlarms — polling hook for `GET /v1/alarms`.
//
// Cadence (spec §4):
//   - Base interval 4_000ms (4s). Faster than SystemHealthPanel's 10s
//     but slower than TapePanel's 1s — operator alarms are mid-tier hot.
//   - Each tick uses an AbortController. If a previous request is still
//     in flight when the interval fires, it gets cancelled — the next
//     request always claims the response slot.
//   - On NETWORK failure (PROBLEM_TYPE.NETWORK), back off exponentially
//     4 → 8 → 16 → 32 → 60s and cap at 60s. The first successful 200
//     resets back to 4s. Non-network errors (4xx/5xx with a proper
//     RFC 7807 body) do NOT trigger backoff — they are usually
//     deterministic and would either keep firing forever or recover on
//     their own. The hook keeps polling at 4s in those cases.
//
// Return shape: `{ data, problem, isLoading, isRefreshing, lastReceivedAt }`.
//   - `data` holds the most recent successful AlarmListDTO. It is NOT
//     cleared on subsequent failures — the AlarmPanel's `error-network`
//     branch wants to show the last good frame while the channel is
//     down (spec §4 state table).
//   - `problem` is the most recent failure (or null if the latest tick
//     succeeded). It IS cleared on the next success.
//   - `isLoading` is true while the very first request is in flight
//     (the `initial` state in the spec). Subsequent polls do not set
//     it back to true — those map to `loading-refresh` which the
//     component renders without disturbing the existing data frame.
//   - `isRefreshing` is true whenever ANY fetch is in flight, including
//     the first one. After the very first response arrives the panel
//     uses this flag to render the spec §4 `loading-refresh` state
//     (header `⟶` glyph fade) without surfacing skeletons. Toggles on
//     every poll cycle so the glyph fades in/out per request.
//   - `lastReceivedAt` is the wall-clock ms-since-epoch of the last
//     successful 200, or null if none yet. Drives the
//     `CHANNEL LOST — last frame {n}s ago. retrying…` age chip.

import { useEffect, useRef, useState, useCallback } from 'react';

import { fetchAlarms, type FetchAlarmsOptions } from '../services/alarmsApi';
import { PROBLEM_TYPE } from '../types/api';
import type { AlarmListDTO, ProblemDetail } from '../types/api';

/** Base polling interval. Exported so tests can reference the canonical
 *  value rather than re-typing the literal `4_000`. */
export const ALARMS_POLL_INTERVAL_MS = 4_000;

/** Backoff ladder for consecutive NETWORK failures. Spec §4 reads
 *  "4 → 8 → 16 → 32 → 60s, cap 60s". The hook indexes by
 *  `min(failureStreak, ladder.length - 1)`. */
export const ALARMS_BACKOFF_LADDER_MS: ReadonlyArray<number> = [
  4_000,
  8_000,
  16_000,
  32_000,
  60_000,
];

export interface UseAlarmsState {
  /** Latest successful envelope, or null until the first 200 arrives.
   *  Survives subsequent failures so the panel can render last-known
   *  rows while the channel is down. */
  data:            AlarmListDTO | null;
  /** Latest failure ProblemDetail, or null after a successful tick.
   *  The AlarmPanel branches on `problem.type` for the auth / network
   *  / other-error renders. */
  problem:         ProblemDetail | null;
  /** True only during the very first inflight request — the spec's
   *  `initial` state. Subsequent polls leave this false so the panel
   *  renders `loading-refresh` (heading glyph fade) instead of
   *  flashing skeletons. */
  isLoading:       boolean;
  /** True for every in-flight fetch (including the first). Toggles on
   *  each poll cycle: set true when the request leaves, set false when
   *  the response (or failure) lands. AlarmPanel's `loading-refresh`
   *  branch keys off this — combined with `data !== null` so the very
   *  first inflight stays on `initial`, and only subsequent polls
   *  surface the `⟶` glyph fade. */
  isRefreshing:    boolean;
  /** ms-since-epoch (Date.now()) of the last 200 response. */
  lastReceivedAt:  number | null;
}

export interface UseAlarmsOptions extends Omit<FetchAlarmsOptions, 'signal'> {
  /** Override the base poll interval (ms). Defaults to ALARMS_POLL_INTERVAL_MS.
   *  Tests inject a smaller value to keep timer-driven flows fast. */
  intervalMs?: number;
  /** Override the backoff ladder (ms). Tests inject a tighter ladder
   *  to verify the transition logic without burning real seconds. */
  backoffLadderMs?: ReadonlyArray<number>;
}

export interface UseAlarmsResult extends UseAlarmsState {
  /** Imperative refresh — cancels any in-flight request and fires a
   *  new one immediately. Resets the backoff streak on success. */
  refresh: () => void;
}

/** Polls /v1/alarms at 4s with NETWORK backoff. Caller-supplied filters
 *  are forwarded to every request. Changing any filter value re-creates
 *  the polling effect and resets the streak. */
export function useAlarms(opts: UseAlarmsOptions = {}): UseAlarmsResult {
  const {
    intervalMs       = ALARMS_POLL_INTERVAL_MS,
    backoffLadderMs  = ALARMS_BACKOFF_LADDER_MS,
    limit,
    since,
    severities,
    statuses,
    sources,
    baseUrl,
  } = opts;

  const [state, setState] = useState<UseAlarmsState>({
    data:           null,
    problem:        null,
    isLoading:      true,
    isRefreshing:   false,
    lastReceivedAt: null,
  });

  // Mutable streak counter — kept in a ref so back-to-back NETWORK
  // failures inside a single render cycle still accumulate correctly.
  const failureStreakRef = useRef(0);
  // Token bumped to force a refresh; the polling effect depends on it.
  const [refreshToken, setRefreshToken] = useState(0);
  const refresh = useCallback(() => {
    failureStreakRef.current = 0;
    setRefreshToken(t => t + 1);
  }, []);

  // Stable JSON-tag of filter values so the effect dep-array only
  // restarts when the operator actually changes a filter, not on every
  // render's fresh array literal.
  const filterKey = JSON.stringify({
    limit, since,
    severities: severities ? [...severities] : undefined,
    statuses:   statuses   ? [...statuses]   : undefined,
    sources:    sources    ? [...sources]    : undefined,
    baseUrl,
    intervalMs,
    backoffLadder: backoffLadderMs,
  });

  useEffect(() => {
    let mounted = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let ctrl: AbortController | null = null;
    let firstTick = true;

    const ladder = backoffLadderMs.length > 0
      ? backoffLadderMs
      : [intervalMs];

    const pickDelay = (): number => {
      const streak = failureStreakRef.current;
      if (streak <= 0) return intervalMs;
      const idx = Math.min(streak - 1, ladder.length - 1);
      return ladder[idx] ?? intervalMs;
    };

    const pull = async (): Promise<void> => {
      ctrl?.abort();
      ctrl = new AbortController();
      const signal = ctrl.signal;

      // Flip `isRefreshing` true at the START of every cycle (including
      // the first). AlarmPanel keys the `⟶` header glyph off this. We
      // do NOT touch `isLoading` here — that stays true only until the
      // first response (success or fail) lands.
      setState(prev => prev.isRefreshing ? prev : { ...prev, isRefreshing: true });

      const result = await fetchAlarms({
        ...(limit      !== undefined ? { limit }      : {}),
        ...(since      !== undefined ? { since }      : {}),
        ...(severities !== undefined ? { severities } : {}),
        ...(statuses   !== undefined ? { statuses }   : {}),
        ...(sources    !== undefined ? { sources }    : {}),
        ...(baseUrl    !== undefined ? { baseUrl }    : {}),
        signal,
      });

      if (!mounted) return;
      if (signal.aborted) return;

      if (result.ok) {
        failureStreakRef.current = 0;
        setState({
          data:           result.data,
          problem:        null,
          isLoading:      false,
          isRefreshing:   false,
          lastReceivedAt: Date.now(),
        });
      } else {
        // Only NETWORK failures count toward the backoff streak. 4xx /
        // 5xx with a proper body are usually deterministic — backing
        // off would only delay the operator's visibility into them.
        // INVALID_INPUT (400) and UPSTREAM_ERROR (503) are surfaced via
        // the `problem` field unchanged; AlarmPanel routes them to the
        // `error-other` branch which renders `{title} — {detail}` from
        // the ProblemDetail. No message-string matching anywhere.
        if (result.problem.type === PROBLEM_TYPE.NETWORK) {
          failureStreakRef.current += 1;
        } else {
          failureStreakRef.current = 0;
        }
        // Preserve `data` (last good frame) — the network-error UI
        // branch displays last-known rows with an amber border.
        setState(prev => ({
          data:           prev.data,
          problem:        result.problem,
          isLoading:      false,
          isRefreshing:   false,
          lastReceivedAt: prev.lastReceivedAt,
        }));
      }

      if (!mounted) return;
      const delay = pickDelay();
      timer = setTimeout(pull, delay);
    };

    // First tick fires immediately — the panel must not sit on
    // `initial` for the full 4s if the network is healthy. Subsequent
    // ticks are scheduled at the end of each `pull()`.
    if (firstTick) {
      firstTick = false;
      void pull();
    }

    return () => {
      mounted = false;
      if (timer !== null) clearTimeout(timer);
      ctrl?.abort();
    };
    // filterKey covers all option-derived deps; refreshToken forces a
    // restart on imperative refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, refreshToken]);

  return { ...state, refresh };
}
