// AlarmPanel + AlarmRow component tests — render the 7 state branches,
// verify severity → glyph + sentinel + border mapping, and exercise the
// row expansion toggle. fetch is mocked at the global level so the
// hook drives realistic state transitions through the polling effect.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';

import { AlarmPanel } from './AlarmPanel';
import { AlarmRow, severityVisualFor } from './AlarmRow';
import { PROBLEM_TYPE, type AlarmDTO } from '../../types/api';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function envelope(items: AlarmDTO[], unack = items.length): unknown {
  return {
    items,
    total:                items.length,
    unacknowledged_count: unack,
    window_since:         '2026-05-12T08:42:11.314Z',
    server_time:          '2026-05-13T08:42:11.500Z',
  };
}

function makeAlarm(overrides: Partial<AlarmDTO> = {}): AlarmDTO {
  return {
    id:              'a-1',
    severity:        'anomaly',
    status:          'active',
    source:          'trading-coordinator',
    code:            'VOLATILITY_BREAKER_TRIPPED',
    title:           'VOLATILITY BREAKER TRIPPED',
    message:         'SMH 6 sigma in 30s window.',
    entity_id:       'SMH',
    occurred_at:     '2026-05-13T08:42:11.314Z',
    acknowledged_at: null,
    resolved_at:     null,
    metadata:        { symbol: 'SMH', sigma: 6.1 },
    ...overrides,
  };
}

describe('AlarmPanel', () => {
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

  it('renders the initial state with skeleton rows before the first response', () => {
    fetchSpy.mockImplementation(() => new Promise(() => { /* never resolves */ }));
    render(<AlarmPanel />);
    const panel = screen.getByTestId('alarm-panel');
    expect(panel.getAttribute('data-state')).toBe('initial');
    expect(screen.getByTestId('alarm-skeleton')).toBeInTheDocument();
  });

  it('renders ok-stream with one row per alarm', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(envelope([
      makeAlarm({ id: 'a-1', severity: 'anomaly' }),
      makeAlarm({ id: 'a-2', severity: 'critical', title: 'BREAK' }),
    ], 2)));
    render(<AlarmPanel />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });

    const panel = screen.getByTestId('alarm-panel');
    expect(panel.getAttribute('data-state')).toBe('ok-stream');
    expect(screen.getAllByTestId('alarm-row')).toHaveLength(2);
    expect(screen.getByTestId('alarm-unack-counter').textContent).toContain('2 UNACK');
  });

  it('renders ok-empty with the exact spec copy', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(envelope([], 0)));
    render(<AlarmPanel />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });

    const panel = screen.getByTestId('alarm-panel');
    expect(panel.getAttribute('data-state')).toBe('ok-empty');
    expect(screen.getByTestId('alarm-empty').textContent).toBe(
      'NO ALARMS IN SCOPE — system nominal.'
    );
  });

  it('renders error-auth with the exact spec copy', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({
      type:       PROBLEM_TYPE.AUTH,
      title:      'Unauthorized',
      status:     401,
      detail:     'missing or invalid bearer token',
      request_id: 'req-401',
    }, 401));
    render(<AlarmPanel />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });

    const panel = screen.getByTestId('alarm-panel');
    expect(panel.getAttribute('data-state')).toBe('error-auth');
    expect(screen.getByTestId('alarm-error').textContent).toBe(
      'UNAUTHORIZED — re-issue bearer.'
    );
  });

  it('renders error-other with the ProblemDetail title + detail', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({
      type:       'https://nexus-os.local/problems/upstream-error',
      title:      'Alarm store unavailable',
      status:     503,
      detail:     'alarm repository ping failed — retry',
      request_id: 'req-503',
    }, 503));
    render(<AlarmPanel />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });

    const panel = screen.getByTestId('alarm-panel');
    expect(panel.getAttribute('data-state')).toBe('error-other');
    expect(screen.getByTestId('alarm-error').textContent).toContain('Alarm store unavailable');
    expect(screen.getByTestId('alarm-error').textContent).toContain('alarm repository ping failed');
  });

  it('renders error-network and keeps the last good frame', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(envelope([
        makeAlarm({ id: 'a-1', title: 'KEEP ME' }),
      ], 1)))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));

    render(<AlarmPanel />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    expect(screen.getAllByTestId('alarm-row')).toHaveLength(1);

    await act(async () => {
      vi.advanceTimersByTime(4_000);
      await vi.runOnlyPendingTimersAsync();
    });

    const panel = screen.getByTestId('alarm-panel');
    expect(panel.getAttribute('data-state')).toBe('error-network');
    expect(screen.getByTestId('alarm-error').textContent).toContain('CHANNEL LOST');
    // Last-known frame preserved.
    expect(screen.getAllByTestId('alarm-row')).toHaveLength(1);
    expect(screen.getByText('KEEP ME')).toBeInTheDocument();
    // The row list is marked stale.
    expect(screen.getByTestId('alarm-list').getAttribute('data-stale')).toBe('true');
  });

  it('expands a row on click and collapses on re-click (single-active)', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(envelope([
      makeAlarm({ id: 'a-1' }),
      makeAlarm({ id: 'a-2', title: 'SECOND' }),
    ], 2)));
    render(<AlarmPanel />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });

    const rows = screen.getAllByTestId('alarm-row');
    const [first, second] = rows;

    // Start collapsed.
    expect(first!.getAttribute('data-expanded')).toBe('false');
    expect(second!.getAttribute('data-expanded')).toBe('false');

    // Expand first.
    fireEvent.click(first!);
    expect(first!.getAttribute('data-expanded')).toBe('true');
    expect(second!.getAttribute('data-expanded')).toBe('false');

    // Click second → first collapses (single active).
    fireEvent.click(second!);
    expect(first!.getAttribute('data-expanded')).toBe('false');
    expect(second!.getAttribute('data-expanded')).toBe('true');

    // Click second again → collapse.
    fireEvent.click(second!);
    expect(second!.getAttribute('data-expanded')).toBe('false');
  });

  it('renders the loading-refresh ⟶ glyph during a polling cycle after the first response', async () => {
    // First fetch resolves immediately to seed `data`. The second fetch
    // is left pending so the panel sits in `loading-refresh` while we
    // assert the glyph is rendered.
    let resolveSecond: ((res: Response) => void) | null = null;
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(envelope([
        makeAlarm({ id: 'a-1' }),
      ], 1)))
      .mockImplementationOnce(() => new Promise<Response>(res => {
        resolveSecond = res;
      }));

    render(<AlarmPanel />);
    // Initial cycle: resolves to ok-stream.
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    expect(screen.getByTestId('alarm-panel').getAttribute('data-state')).toBe('ok-stream');
    expect(screen.queryByTestId('alarm-refresh-glyph')).toBeNull();

    // Advance past the base interval — pull() fires, isRefreshing flips
    // true, and panel state moves to `loading-refresh` while body still
    // shows the existing row.
    await act(async () => {
      vi.advanceTimersByTime(4_000);
      await Promise.resolve();
    });

    const panel = screen.getByTestId('alarm-panel');
    expect(panel.getAttribute('data-state')).toBe('loading-refresh');
    const glyph = screen.getByTestId('alarm-refresh-glyph');
    expect(glyph.textContent).toBe('\u27F6');
    // Body still shows the last frame rows.
    expect(screen.getAllByTestId('alarm-row')).toHaveLength(1);

    // Resolve the pending second fetch — state returns to ok-stream and
    // the glyph disappears.
    await act(async () => {
      resolveSecond?.(jsonResponse(envelope([makeAlarm({ id: 'a-1' })], 1)));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId('alarm-panel').getAttribute('data-state')).toBe('ok-stream');
    expect(screen.queryByTestId('alarm-refresh-glyph')).toBeNull();
  });

  it('surfaces a 400 invalid-input ProblemDetail as error-other with title and detail', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({
      type:       PROBLEM_TYPE.INVALID_INPUT,
      title:      'Invalid query parameter',
      status:     400,
      detail:     "severity 'foo' is not one of info|warn|anomaly|critical",
      request_id: 'req-400',
    }, 400));

    render(<AlarmPanel />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });

    const panel = screen.getByTestId('alarm-panel');
    expect(panel.getAttribute('data-state')).toBe('error-other');
    const err = screen.getByTestId('alarm-error');
    expect(err.textContent).toContain('Invalid query parameter');
    expect(err.textContent).toContain("severity 'foo'");
  });

  it('sorts metadata keys alphabetically inside the expanded grid', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(envelope([
      makeAlarm({
        id:       'a-1',
        metadata: { zeta: 1, alpha: 'A', mid: 'M' },
      }),
    ], 1)));
    render(<AlarmPanel />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });

    fireEvent.click(screen.getByTestId('alarm-row'));
    const grid = screen.getByTestId('alarm-expanded');
    // Get all dt elements that look like metadata keys (uppercased).
    const keys = Array.from(grid.querySelectorAll('dt')).map(el => el.textContent ?? '');
    const alphaIdx = keys.indexOf('ALPHA');
    const midIdx   = keys.indexOf('MID');
    const zetaIdx  = keys.indexOf('ZETA');
    expect(alphaIdx).toBeGreaterThan(-1);
    expect(midIdx).toBeGreaterThan(alphaIdx);
    expect(zetaIdx).toBeGreaterThan(midIdx);
  });
});

describe('AlarmRow severity mapping', () => {
  // The visual contract is a hard one (spec §4) — assert against the
  // mapping helper directly so a refactor of the row's internals can't
  // silently drift the glyph or color.
  it('maps info → ◇ + cyan', () => {
    const v = severityVisualFor('info');
    expect(v.glyph).toBe('\u25C7');
    expect(v.color).toBe('var(--cyan)');
    expect(v.border).toBe('var(--cyan)');
  });
  it('maps warn → ▲ WARN + amber', () => {
    const v = severityVisualFor('warn');
    expect(v.glyph).toBe('\u25B2 WARN');
    expect(v.color).toBe('var(--amber)');
  });
  it('maps anomaly → ◆ ANOMALY + lime', () => {
    const v = severityVisualFor('anomaly');
    expect(v.glyph).toBe('\u25C6 ANOMALY');
    expect(v.color).toBe('var(--lime)');
  });
  it('maps critical → ■ CRIT + crimson', () => {
    const v = severityVisualFor('critical');
    expect(v.glyph).toBe('\u25A0 CRIT');
    expect(v.color).toBe('var(--crimson)');
  });

  it('renders severity glyph text and per-severity data-attribute', () => {
    const alarm: AlarmDTO = {
      id:              'r-1',
      severity:        'critical',
      status:          'active',
      source:          'system-monitor',
      code:            'BREAKER_TRIPPED',
      title:           'BREAKER TRIPPED',
      message:         'something is wrong',
      entity_id:       null,
      occurred_at:     '2026-05-13T08:42:11.314Z',
      acknowledged_at: null,
      resolved_at:     null,
      metadata:        null,
    };

    render(
      <ul>
        <AlarmRow alarm={alarm} expanded={false} onToggle={() => {}} />
      </ul>
    );

    const row = screen.getByTestId('alarm-row');
    expect(row.getAttribute('data-severity')).toBe('critical');
    expect(within(row).getByTestId('alarm-glyph').textContent).toBe('\u25A0 CRIT');
  });

  it('reports clicks through onToggle', () => {
    const toggle = vi.fn();
    const alarm: AlarmDTO = {
      id:              'r-2',
      severity:        'info',
      status:          'resolved',
      source:          'news-provider',
      code:            'INFO_NOTE',
      title:           'INFO NOTE',
      message:         'note',
      entity_id:       null,
      occurred_at:     '2026-05-13T08:42:11.314Z',
      acknowledged_at: '2026-05-13T08:43:00.000Z',
      resolved_at:     '2026-05-13T08:44:00.000Z',
      metadata:        null,
    };
    render(
      <ul>
        <AlarmRow alarm={alarm} expanded={false} onToggle={toggle} />
      </ul>
    );
    fireEvent.click(screen.getByTestId('alarm-row'));
    expect(toggle).toHaveBeenCalledWith('r-2');
  });
});
