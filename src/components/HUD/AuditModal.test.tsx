// AuditModal tests — covers the four UI states (loading / data /
// empty / error), the 3s auto-refresh, the pause toggle, and the
// silent-refresh discipline (poll failure shouldn't flip the modal
// into the error state).

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

import { AuditModal } from './AuditModal';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function row(overrides: Partial<{
  ts: string; symbol: string; mode: string; executed: boolean;
  intended_action: string; intended_quantity: number;
  order_id: string | null; blocked_by: string | null; reason: string | null;
  signal_action: string; signal_confidence: number; signal_score: number;
  signal_rationale: Array<unknown>;
}> = {}) {
  return {
    ts:                '2026-05-11T00:00:00Z',
    symbol:            '005930',
    mode:              'noop',
    executed:          false,
    intended_action:   'hold',
    intended_quantity: 0,
    order_id:          null,
    blocked_by:        null,
    reason:            null,
    signal_action:     'hold',
    signal_confidence: 0,
    signal_score:      0,
    signal_rationale:  [],
    ...overrides,
  };
}

describe('AuditModal', () => {
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

  it('returns null when symbol prop is null', () => {
    const { container } = render(<AuditModal symbol={null} onClose={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders loading spinner before initial fetch resolves', () => {
    // Hang the fetch so we can observe the intermediate state
    fetchSpy.mockImplementation(() => new Promise(() => {}));
    render(<AuditModal symbol="005930" onClose={() => {}} />);
    expect(screen.getByTestId('audit-loading')).toBeInTheDocument();
  });

  it('renders data state after fetch resolves with rows', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({
      symbol: '005930',
      rows: [row(), row({ mode: 'shadow', signal_confidence: 0.65 })],
    }));
    render(<AuditModal symbol="005930" label="Samsung" onClose={() => {}} />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    expect(screen.getAllByTestId('audit-row')).toHaveLength(2);
    expect(screen.getByText(/AUDIT TRAIL · Samsung/)).toBeInTheDocument();
  });

  it('renders empty state when fetch returns zero rows', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({
      symbol: 'OBSIDIAN',
      rows: [],
    }));
    render(<AuditModal symbol="OBSIDIAN" onClose={() => {}} />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    expect(screen.getByTestId('audit-empty')).toBeInTheDocument();
  });

  it('renders error state on initial-fetch failure with Retry', async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<AuditModal symbol="005930" onClose={() => {}} />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    expect(screen.getByTestId('audit-error')).toBeInTheDocument();
    expect(screen.getByTestId('audit-retry')).toBeInTheDocument();
  });

  it('Retry triggers another fetch + transitions back to data state', async () => {
    fetchSpy
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(jsonResponse({ symbol: '005930', rows: [row()] }));
    render(<AuditModal symbol="005930" onClose={() => {}} />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    expect(screen.getByTestId('audit-error')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('audit-retry'));
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    expect(screen.getByTestId('audit-rows')).toBeInTheDocument();
  });

  it('ESC key fires onClose', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ symbol: '005930', rows: [row()] }));
    const onClose = vi.fn();
    render(<AuditModal symbol="005930" onClose={onClose} />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('auto-refresh toggle pauses polling', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ symbol: '005930', rows: [row()] }));
    render(<AuditModal symbol="005930" onClose={() => {}} />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    // Initial fetch
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Pause
    fireEvent.click(screen.getByTestId('audit-modal-auto-toggle'));
    expect(screen.getByTestId('audit-modal-auto-toggle').textContent).toContain('PAUSED');

    // Advance 5s → no additional fetch while paused
    await act(async () => {
      vi.advanceTimersByTime(5000);
      await vi.runOnlyPendingTimersAsync();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('silent-refresh failure keeps last good frame visible', async () => {
    // First poll succeeds; second poll fails. The modal should still
    // show audit-rows from the first poll (not flip to error).
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ symbol: '005930', rows: [row()] }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<AuditModal symbol="005930" onClose={() => {}} />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    expect(screen.getByTestId('audit-rows')).toBeInTheDocument();
    // Trigger auto-refresh tick
    await act(async () => {
      vi.advanceTimersByTime(3000);
      await vi.runOnlyPendingTimersAsync();
    });
    // Still in data state, not error
    expect(screen.queryByTestId('audit-error')).toBeNull();
    expect(screen.getByTestId('audit-rows')).toBeInTheDocument();
  });
});
