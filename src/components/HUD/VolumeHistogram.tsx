// VolumeHistogram — Sprint 5p-H right-column panel.
//
// One horizontal bar per KIS symbol, width = total_volume / max in
// window. Operator picks "which subscriptions are hot right now" at
// a glance — heaviest-traded symbols visually dominate. Click any
// row to select the entity in the canvas + PropertyHUD.
//
// Polls /v1/ticks/volume at 10s (longer than tape/snapshot because
// volume aggregates change slowly compared to per-tick rates — there's
// nothing to react to in under 10s, and a SUM(volume) GROUP BY on
// market_tick is more expensive per call than DISTINCT ON snapshot).

import { useEffect, useState } from 'react';

import { fetchVolumeWindow } from '../../services/marketApi';
import type { MarketVolumeBucket } from '../../types/api';
import type { NexusEntity } from '../../types/nexus';

const POLL_INTERVAL_MS = 10_000;
const WINDOW_MINUTES   = 60;

export interface VolumeHistogramProps {
  symbols:    ReadonlyArray<string>;
  entityMap:  ReadonlyMap<string, NexusEntity>;
  onSelect?:  ((id: string) => void) | undefined;
  selectedId?: string | null;
}

export function VolumeHistogram({
  symbols, entityMap, onSelect, selectedId,
}: VolumeHistogramProps) {
  const [buckets, setBuckets] = useState<MarketVolumeBucket[]>([]);

  useEffect(() => {
    if (symbols.length === 0) return;
    let mounted = true;
    let ctrl: AbortController | null = null;

    const pull = async () => {
      ctrl?.abort();
      ctrl = new AbortController();
      const result = await fetchVolumeWindow(symbols, {
        windowMinutes: WINDOW_MINUTES,
        signal:        ctrl.signal,
      });
      if (!mounted) return;
      if (result.ok) setBuckets(result.data.buckets);
    };

    pull();
    const id = setInterval(pull, POLL_INTERVAL_MS);
    return () => {
      mounted = false;
      clearInterval(id);
      ctrl?.abort();
    };
  }, [symbols]);

  if (symbols.length === 0) return null;

  // Sort by volume descending so the heaviest row sits on top — eye
  // naturally lands there and reads "what's hot" without scanning.
  // Then fall back to the operator's request order for ties.
  const sorted = [...buckets].sort((a, b) => {
    if (b.total_volume !== a.total_volume) {
      return b.total_volume - a.total_volume;
    }
    return symbols.indexOf(a.symbol) - symbols.indexOf(b.symbol);
  });

  const maxVol = sorted.reduce((m, b) => Math.max(m, b.total_volume), 0);

  return (
    <section
      className="nx-panel"
      aria-label="Volume Histogram"
      data-testid="volume-histogram"
      style={PANEL}
    >
      <header className="nx-panel__head">
        <div className="nx-panel__title">
          <span className="nx-dot nx-dot--cyan" />
          <span>VOLUME · {WINDOW_MINUTES}M</span>
        </div>
        <span className="nx-mono-dim" style={{ fontSize: 9 }}>
          SORTED · DESC
        </span>
      </header>

      <ul style={LIST}>
        {sorted.length === 0 && (
          <li style={EMPTY_HINT}>— acquiring volume —</li>
        )}
        {sorted.map(b => {
          const entity = entityMap.get(b.symbol);
          const label  = entity?.label ?? b.symbol;
          const pct    = maxVol > 0 ? (b.total_volume / maxVol) : 0;
          const isSelected = b.symbol === selectedId;
          return (
            <li
              key={b.symbol}
              data-testid="volume-row"
              role="button"
              tabIndex={0}
              onClick={() => onSelect?.(b.symbol)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect?.(b.symbol);
                }
              }}
              style={{
                ...ROW,
                ...(isSelected ? ROW_SELECTED : null),
              }}
            >
              <div style={LABEL_ROW}>
                <span style={SYM_TEXT}>{b.symbol}</span>
                <span style={LABEL_TEXT} title={label}>{label}</span>
                <span style={VOL_TEXT}>{formatVol(b.total_volume)}</span>
              </div>
              <div style={BAR_TRACK}>
                <div
                  style={{
                    ...BAR_FILL,
                    width: `${Math.max(1.5, pct * 100)}%`,
                  }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ── helpers / styles ───────────────────────────────────────────────────

function formatVol(v: number): string {
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(2) + 'M';
  if (v >= 1_000)     return (v / 1_000).toFixed(1) + 'K';
  return v.toString();
}

const PANEL: React.CSSProperties = {
  marginTop: 8,
};

const LIST: React.CSSProperties = {
  listStyle: 'none',
  margin:    0,
  padding:   '4px 12px 8px',
  display:   'flex',
  flexDirection: 'column',
  gap:       3,
};

const ROW: React.CSSProperties = {
  padding:       '3px 6px',
  borderRadius:  2,
  fontFamily:    '"JetBrains Mono", ui-monospace, monospace',
  fontSize:      10,
  cursor:        'pointer',
  background:    'transparent',
};

const ROW_SELECTED: React.CSSProperties = {
  background: 'rgba(0, 191, 255, 0.10)',
};

const LABEL_ROW: React.CSSProperties = {
  display:       'grid',
  gridTemplateColumns: '56px 1fr auto',
  alignItems:    'center',
  gap:           8,
  marginBottom:  2,
};

const SYM_TEXT: React.CSSProperties = {
  color:         '#DEFF9A',
  fontWeight:    500,
  letterSpacing: '0.04em',
};

const LABEL_TEXT: React.CSSProperties = {
  color:         '#8A93A8',
  whiteSpace:    'nowrap',
  overflow:      'hidden',
  textOverflow:  'ellipsis',
};

const VOL_TEXT: React.CSSProperties = {
  color:         '#E8ECF5',
  fontVariantNumeric: 'tabular-nums',
  fontSize:      9,
};

const BAR_TRACK: React.CSSProperties = {
  height:        4,
  background:    'rgba(0, 191, 255, 0.10)',
  borderRadius:  2,
  overflow:      'hidden',
};

const BAR_FILL: React.CSSProperties = {
  height:     '100%',
  background: 'linear-gradient(90deg, rgba(0, 191, 255, 0.6) 0%, rgba(0, 191, 255, 0.9) 100%)',
  transition: 'width 400ms ease-out',
};

const EMPTY_HINT: React.CSSProperties = {
  padding:       '20px 6px',
  color:         '#4A5066',
  fontSize:      10,
  textAlign:     'center',
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
};
