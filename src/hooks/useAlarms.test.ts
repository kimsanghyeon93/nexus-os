// useAlarms tests — verify the polling cadence, the NETWORK
// backoff ladder, and the 7-state transition behavior.
//
// Strategy: stub global fetch and use fake timers. The hook polls via
// `setTimeout` (re-scheduled at the end of each pull), so advancing
// timers + flushing micro-tasks deterministically reproduces every
// transition in the spec.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

import {
  useAlarms,
  ALARMS_POLL_INTERVAL_MS,
  ALARMS_BACKOFF_LADDER_MS,
} from './useAlarms';
import { PROBLEM_TYPE } from '../types/api';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function envelope(overrides: Partial<{ unack: number; items: unknown[] }> = {}): unknown {
  return {
    items:                overrides.items ?? [],
    total:                (overrides.items ?? []).length,
    unacknowledged_count: overrides.unack ?? 0,
    window_since:         '2026-05-12T08:42:11.314Z',
    server_time:          '2026-05-13T08:42:11.500Z',
  };
}

describe('useAlarms', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('exposes the documented poll interval + backoff ladder constants', () => {
    expect(ALARMS_POLL_INTERVAL_MS).toBe(4_000);
    expect(ALARMS_BACKOFF_LADDER_MS).toEqual([4_000, 8_000, 16_000, 32_000, 60_000]);
  });

  it('starts in initial state (isLoading=true, data=null)', () => {
    fetchSpy.mockImplementation(() => new Promise(() => { /* never resolves */ }));
    const { result } = renderHook(() => useAlarms());
    expect(result.current.isLoading).toBe(true);
    expect(result.current.data).toBeNull();
    expect(result.current.problem).toBeNull();
  });

  it('flips isRefreshing true while a fetch is in flight and false when it resolves', async () => {
    // Hand-controlled promise so we can observe the in-flight window.
    let resolveFetch: ((res: Response) => void) | null = null;
    fetchSpy.mockImplementationOnce(() => new Promise<Response>(res => {
      resolveFetch = res;
    }));
    const { result } = renderHook(() => useAlarms());

    // Effect runs synchronously on mount; the `setState(prev => ...)` that
    // flips isRefreshing fires inside pull() before await fetchAlarms.
    await act(async () => {
      // Let microtasks settle so the setState batch lands.
      await Promise.resolve();
    });
    expect(result.current.isRefreshing).toBe(true);

    // Resolve the in-flight fetch.
    await act(async () => {
      resolveFetch?.(jsonResponse(envelope({ unack: 0 })));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.isRefreshing).toBe(false);
    expect(result.current.data).not.toBeNull();
  });

  it('re-arms isRefreshing on each subsequent poll cycle', async () => {
    // Stage two resolvable fetches so we can step poll → poll.
    const pending: Array<(res: Response) => void> = [];
    fetchSpy.mockImplementation(() => new Promise<Response>(res => {
      pending.push(res);
    }));
    const { result } = renderHook(() => useAlarms());

    // First cycle: in flight → resolve.
    await act(async () => { await Promise.resolve(); });
    expect(result.current.isRefreshing).toBe(true);
    await act(async () => {
      pending[0]?.(jsonResponse(envelope({ unack: 0 })));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.isRefreshing).toBe(false);

    // Advance to next poll tick.
    await act(async () => {
      vi.advanceTimersByTime(ALARMS_POLL_INTERVAL_MS);
      await Promise.resolve();
    });
    // Second cycle: in flight again.
    expect(result.current.isRefreshing).toBe(true);

    await act(async () => {
      pending[1]?.(jsonResponse(envelope({ unack: 0 })));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.isRefreshing).toBe(false);
  });

  it('surfaces a 400 invalid-input ProblemDetail unchanged', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({
      type:       PROBLEM_TYPE.INVALID_INPUT,
      title:      'Invalid query parameter',
      status:     400,
      detail:     "severity 'foo' is not one of info|warn|anomaly|critical",
      request_id: 'req-400',
    }, 400));

    const { result } = renderHook(() => useAlarms());
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });

    expect(result.current.problem).not.toBeNull();
    expect(result.current.problem?.type).toBe(PROBLEM_TYPE.INVALID_INPUT);
    expect(result.current.problem?.status).toBe(400);
    expect(result.current.problem?.title).toBe('Invalid query parameter');
    expect(result.current.problem?.detail).toContain("severity 'foo'");
  });

  it('transitions to ok-stream on first 200 and records lastReceivedAt', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(envelope({ unack: 3, items: [{
      id:              'a-1',
      severity:        'warn',
      status:          'active',
      source:          'trading-coordinator',
      code:            'X',
      title:           'X',
      message:         'm',
      entity_id:       null,
      occurred_at:     '2026-05-13T08:42:11.314Z',
      acknowledged_at: null,
      resolved_at:     null,
      metadata:        null,
    }] })));
    const { result } = renderHook(() => useAlarms());

    await act(async () => { await vi.runOnlyPendingTimersAsync(); });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.data?.items).toHaveLength(1);
    expect(result.current.data?.unacknowledged_count).toBe(3);
    expect(result.current.problem).toBeNull();
    expect(result.current.lastReceivedAt).not.toBeNull();
  });

  it('polls at the base interval after success', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(envelope()));
    renderHook(() => useAlarms());

    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Advance by one base interval — the second poll fires.
    await act(async () => {
      vi.advanceTimersByTime(ALARMS_POLL_INTERVAL_MS);
      await vi.runOnlyPendingTimersAsync();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // And again.
    await act(async () => {
      vi.advanceTimersByTime(ALARMS_POLL_INTERVAL_MS);
      await vi.runOnlyPendingTimersAsync();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('preserves last good data when subsequent poll fails with NETWORK', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(envelope({ unack: 7 })))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { result } = renderHook(() => useAlarms());

    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    expect(result.current.data?.unacknowledged_count).toBe(7);
    expect(result.current.problem).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(ALARMS_POLL_INTERVAL_MS);
      await vi.runOnlyPendingTimersAsync();
    });

    // Data preserved, problem now set to NETWORK.
    expect(result.current.data?.unacknowledged_count).toBe(7);
    expect(result.current.problem?.type).toBe(PROBLEM_TYPE.NETWORK);
  });

  it('applies exponential backoff after consecutive NETWORK failures', async () => {
    // Tight custom ladder for deterministic assertions: 100, 200, 400.
    const ladder = [100, 200, 400];
    fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));

    renderHook(() => useAlarms({ intervalMs: 100, backoffLadderMs: ladder }));

    // First request fires immediately.
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Streak=1 → next delay = ladder[0] = 100ms.
    await act(async () => {
      vi.advanceTimersByTime(100);
      await vi.runOnlyPendingTimersAsync();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Streak=2 → next delay = ladder[1] = 200ms. 100ms should NOT fire.
    await act(async () => {
      vi.advanceTimersByTime(100);
      await vi.runOnlyPendingTimersAsync();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    await act(async () => {
      vi.advanceTimersByTime(100);
      await vi.runOnlyPendingTimersAsync();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    // Streak=3 → next delay = ladder[2] = 400ms.
    await act(async () => {
      vi.advanceTimersByTime(300);
      await vi.runOnlyPendingTimersAsync();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    await act(async () => {
      vi.advanceTimersByTime(100);
      await vi.runOnlyPendingTimersAsync();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it('resets backoff streak on a successful response', async () => {
    const ladder = [100, 200, 400];
    fetchSpy
      .mockRejectedValueOnce(new TypeError('fail-1'))
      .mockRejectedValueOnce(new TypeError('fail-2'))
      .mockResolvedValueOnce(jsonResponse(envelope()))
      .mockRejectedValueOnce(new TypeError('fail-3'));

    renderHook(() => useAlarms({ intervalMs: 100, backoffLadderMs: ladder }));

    // First request (immediate) — fail.
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Streak=1 → 100ms wait then fail.
    await act(async () => {
      vi.advanceTimersByTime(100);
      await vi.runOnlyPendingTimersAsync();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Streak=2 → 200ms wait, then succeeds — streak resets to 0.
    await act(async () => {
      vi.advanceTimersByTime(200);
      await vi.runOnlyPendingTimersAsync();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    // After success, next delay should be base interval (100ms), NOT 400ms.
    await act(async () => {
      vi.advanceTimersByTime(100);
      await vi.runOnlyPendingTimersAsync();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it('does NOT backoff on non-network errors (4xx/5xx with body)', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({
      type:       PROBLEM_TYPE.AUTH,
      title:      'Unauthorized',
      status:     401,
      detail:     'no token',
      request_id: 'req-x',
    }, 401));

    renderHook(() => useAlarms({ intervalMs: 100 }));

    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Still at base interval after a 401.
    await act(async () => {
      vi.advanceTimersByTime(100);
      await vi.runOnlyPendingTimersAsync();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    await act(async () => {
      vi.advanceTimersByTime(100);
      await vi.runOnlyPendingTimersAsync();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('caps backoff at the final ladder entry', async () => {
    const ladder = [100, 200];
    fetchSpy.mockRejectedValue(new TypeError('fail'));

    renderHook(() => useAlarms({ intervalMs: 100, backoffLadderMs: ladder }));

    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // 1st fail → streak=1 → ladder[0] = 100ms.
    await act(async () => {
      vi.advanceTimersByTime(100);
      await vi.runOnlyPendingTimersAsync();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // 2nd fail → streak=2 → ladder[1] = 200ms.
    await act(async () => {
      vi.advanceTimersByTime(200);
      await vi.runOnlyPendingTimersAsync();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    // 3rd fail → streak=3 → capped at ladder[1] = 200ms (idx clamp).
    await act(async () => {
      vi.advanceTimersByTime(200);
      await vi.runOnlyPendingTimersAsync();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it('cancels in-flight requests on unmount', async () => {
    const aborts: AbortSignal[] = [];
    fetchSpy.mockImplementation((_url, init: RequestInit) => {
      if (init.signal) aborts.push(init.signal);
      return new Promise(() => { /* never resolves */ });
    });
    const { unmount } = renderHook(() => useAlarms());
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    expect(aborts.length).toBeGreaterThan(0);
    unmount();
    // After unmount, the AbortController inside the effect's cleanup
    // aborts the signal.
    expect(aborts.some(s => s.aborted)).toBe(true);
  });
});
