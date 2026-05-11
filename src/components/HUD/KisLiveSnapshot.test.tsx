// KisLiveSnapshot tests — component behavior with mocked fetch.
// Focus on rendering branches + the two-slot price memory delta
// lifecycle, since that's the trickiest code in the component.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

import { KisLiveSnapshot } from './KisLiveSnapshot';
import type { NexusEntity } from '../../types/nexus';

// ── fixtures ──────────────────────────────────────────────────────────

function makeEntity(id: string, label: string): NexusEntity {
  return {
    id, label,
    type:        'kr_equity',
    cluster:     'KRX',
    clusterColor: 'purple',
    x: 0, y: 0, baseX: 0, baseY: 0,
    orbitR: 0, orbitSpeed: 0, orbitPhase: 0,
    isHub: false,
    jurisdiction: 'KR',
    founded: null,
    anomaly: 0.1,
    sanctioned: false,
    txVol: 1000,
    mark: 'hexagon',
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const ENTITY_MAP = new Map([
  ['005930', makeEntity('005930', 'Samsung Electronics')],
  ['000660', makeEntity('000660', 'SK Hynix')],
]);

describe('KisLiveSnapshot', () => {
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
    const { container } = render(
      <KisLiveSnapshot symbols={[]} entityMap={ENTITY_MAP} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders one row per requested symbol with labels from entityMap', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({
      requested: ['005930', '000660'],
      snapshots: [
        { symbol: '005930', ts: '2026-05-11T00:00:00Z', price: 79100, volume: 100, side: 'buy' },
        { symbol: '000660', ts: '2026-05-11T00:00:00Z', price: 197000, volume: 50, side: 'sell' },
      ],
    }));
    render(<KisLiveSnapshot symbols={['005930', '000660']} entityMap={ENTITY_MAP} />);
    // Let the initial fetch resolve
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    expect(screen.getByText('Samsung Electronics')).toBeInTheDocument();
    expect(screen.getByText('SK Hynix')).toBeInTheDocument();
    expect(screen.getAllByTestId('kis-snapshot-row')).toHaveLength(2);
  });

  it('falls back to symbol id when entity label is missing', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ requested: ['UNKNOWN'], snapshots: [] }));
    render(<KisLiveSnapshot symbols={['UNKNOWN']} entityMap={new Map()} />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    expect(screen.getByText('UNKNOWN')).toBeInTheDocument();
  });

  it('computes positive % delta after two polls with rising price', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({
        requested: ['005930'],
        snapshots: [{ symbol: '005930', ts: '2026-05-11T00:00:00Z', price: 100, volume: 1, side: 'buy' }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        requested: ['005930'],
        snapshots: [{ symbol: '005930', ts: '2026-05-11T00:00:02Z', price: 110, volume: 1, side: 'buy' }],
      }));
    render(<KisLiveSnapshot symbols={['005930']} entityMap={ENTITY_MAP} />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    // After the second poll the prev slot should hold 100 and the
    // current slot 110 → +10% delta.
    await act(async () => {
      vi.advanceTimersByTime(2000);
      await vi.runOnlyPendingTimersAsync();
    });
    expect(screen.getByText(/\+10\.00%/)).toBeInTheDocument();
  });

  it('shows · placeholder when no previous price exists yet', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({
      requested: ['005930'],
      snapshots: [{ symbol: '005930', ts: '2026-05-11T00:00:00Z', price: 100, volume: 1, side: 'buy' }],
    }));
    render(<KisLiveSnapshot symbols={['005930']} entityMap={ENTITY_MAP} />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    // First load: cur slot filled, prev slot empty → delta = 0 → '·'
    const rows = screen.getAllByTestId('kis-snapshot-row');
    expect(rows[0]!.textContent).toContain('·');
  });

  it('fires onSelect when a row is clicked', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({
      requested: ['005930'],
      snapshots: [{ symbol: '005930', ts: '2026-05-11T00:00:00Z', price: 79100, volume: 1, side: 'buy' }],
    }));
    const onSelect = vi.fn();
    render(
      <KisLiveSnapshot
        symbols={['005930']}
        entityMap={ENTITY_MAP}
        onSelect={onSelect}
      />
    );
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    fireEvent.click(screen.getByTestId('kis-snapshot-row'));
    expect(onSelect).toHaveBeenCalledWith('005930');
  });

  it('highlights the selected row', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({
      requested: ['005930', '000660'],
      snapshots: [
        { symbol: '005930', ts: '2026-05-11T00:00:00Z', price: 1, volume: 1, side: 'buy' },
      ],
    }));
    render(
      <KisLiveSnapshot
        symbols={['005930', '000660']}
        entityMap={ENTITY_MAP}
        selectedId="000660"
      />
    );
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    const rows = screen.getAllByTestId('kis-snapshot-row');
    // selectedId='000660' is the SECOND row (after 005930)
    const styles = window.getComputedStyle(rows[1]!);
    // inline background is rgba(0, 191, 255, 0.10)
    expect(rows[1]!.getAttribute('style')).toContain('191');
  });
});
