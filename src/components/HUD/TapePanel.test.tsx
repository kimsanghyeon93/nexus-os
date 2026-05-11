// TapePanel tests — covers the forensic tape stream, pause/resume
// freeze logic, and click-to-select propagation.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

import { TapePanel } from './TapePanel';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function entry(overrides: Partial<{
  ts: string; symbol: string; price: number; volume: number;
  side: 'buy' | 'sell';
}> = {}) {
  return {
    ts:     '2026-05-11T00:00:00Z',
    symbol: '005930',
    price:  79100,
    volume: 100,
    side:   'buy' as const,
    ...overrides,
  };
}

describe('TapePanel', () => {
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

  it('returns null when symbol list is empty', () => {
    const { container } = render(<TapePanel symbols={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders one row per fetched entry, newest-first', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({
      entries: [
        entry({ ts: '2026-05-11T00:00:02Z', symbol: '005930', price: 79100 }),
        entry({ ts: '2026-05-11T00:00:01Z', symbol: '000660', price: 197000, side: 'sell' }),
      ],
    }));
    render(<TapePanel symbols={['005930', '000660']} />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    const rows = screen.getAllByTestId('tape-row');
    expect(rows).toHaveLength(2);
    // First row (newest) shows 005930
    expect(rows[0]!.textContent).toContain('005930');
    expect(rows[1]!.textContent).toContain('000660');
  });

  it('shows empty hint when no entries returned', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ entries: [] }));
    render(<TapePanel symbols={['005930']} />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    expect(screen.getByText(/no ticks recorded/i)).toBeInTheDocument();
  });

  it('LIVE label switches to PAUSED when toggle is pressed', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ entries: [entry()] }));
    render(<TapePanel symbols={['005930']} />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    expect(screen.getByText(/TAPE · LIVE/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('tape-pause-toggle'));
    expect(screen.getByText(/TAPE · PAUSED/)).toBeInTheDocument();
  });

  it('does not fetch while paused', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ entries: [entry()] }));
    render(<TapePanel symbols={['005930']} />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    const initialCalls = fetchSpy.mock.calls.length;

    fireEvent.click(screen.getByTestId('tape-pause-toggle'));

    // Advance 5s — paused, no new fetches
    await act(async () => {
      vi.advanceTimersByTime(5000);
      await vi.runOnlyPendingTimersAsync();
    });
    expect(fetchSpy.mock.calls.length).toBe(initialCalls);
  });

  it('row click fires onSelect with the symbol', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({
      entries: [entry({ symbol: '000660' })],
    }));
    const onSelect = vi.fn();
    render(<TapePanel symbols={['000660']} onSelect={onSelect} />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    fireEvent.click(screen.getByTestId('tape-row'));
    expect(onSelect).toHaveBeenCalledWith('000660');
  });

  it('renders side glyph: ▲ for buy, ▼ for sell', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({
      entries: [
        entry({ side: 'buy', symbol: '005930' }),
        entry({ side: 'sell', symbol: '000660' }),
      ],
    }));
    render(<TapePanel symbols={['005930', '000660']} />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    const rows = screen.getAllByTestId('tape-row');
    expect(rows[0]!.textContent).toContain('▲');
    expect(rows[1]!.textContent).toContain('▼');
  });
});
