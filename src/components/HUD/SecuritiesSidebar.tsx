// SecuritiesSidebar — left-rail search + filter surface for the
// securities ontology. Spec §4.5.
//
// Layout:
//   - Search input (debounced 150ms) — matches ticker / name_ko /
//     name_en / aliases via simple prefix-first scoring.
//   - Sector filter checkboxes (live list from incoming SecurityDTO[])
//     — selecting any subset narrows the visible nodes.
//   - Market toggle row — 4 mini-buttons (KRX / KOSDAQ / NASDAQ / NYSE).
//   - `{matched}/{total} MATCHED` counter at top-right.
//
// Outputs (via callbacks) — the parent owns the actual canvas dimming
// state so the sidebar stays stateless apart from input drafts.
//
// Visuals — NEXUS tokens only. No hex literals.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

import type {
  SecurityDTO,
  SecurityMarket,
} from '../../types/api';

export interface SecuritiesSidebarProps {
  securities: SecurityDTO[];
  /** Notified when the operator commits a new search query (after the
   *  150ms debounce). Empty string = no filter. */
  onSearchChange: (query: string) => void;
  /** Notified when the operator toggles sectors. Empty set = all. */
  onSectorsChange: (sectors: ReadonlySet<string>) => void;
  /** Notified when the operator toggles markets. Empty set = all. */
  onMarketsChange: (markets: ReadonlySet<SecurityMarket>) => void;
  /** Number of nodes currently matched (computed by the parent based
   *  on the filter results). Drives the counter. */
  matchedCount: number;
}

const MARKETS: ReadonlyArray<SecurityMarket> = ['KRX', 'KOSDAQ', 'NASDAQ', 'NYSE'];

/** Debounce in ms — spec §4.3 calls for 150ms after the operator stops
 *  typing before recomputing the match set. */
const SEARCH_DEBOUNCE_MS = 150;

export function SecuritiesSidebar({
  securities,
  onSearchChange,
  onSectorsChange,
  onMarketsChange,
  matchedCount,
}: SecuritiesSidebarProps) {
  // Input draft (controlled). Committed to onSearchChange after debounce.
  const [draft, setDraft] = useState('');
  const [sectors, setSectors] = useState<ReadonlySet<string>>(new Set());
  const [markets, setMarkets] = useState<ReadonlySet<SecurityMarket>>(new Set());

  // Distinct sectors, sorted by frequency desc then name asc so the
  // most populated sector floats to the top. Stable across renders
  // unless the underlying SecurityDTO list changes shape.
  const sectorOptions = useMemo(() => {
    const counts = new Map<string, { label: string; count: number }>();
    for (const s of securities) {
      const cur = counts.get(s.sector);
      if (cur) {
        cur.count += 1;
      } else {
        counts.set(s.sector, { label: s.sector_label, count: 1 });
      }
    }
    return [...counts.entries()]
      .map(([id, { label, count }]) => ({ id, label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }, [securities]);

  // Debounce the search-draft commit. Reset the timer on every keystroke
  // so the parent only sees the value after the operator pauses for
  // SEARCH_DEBOUNCE_MS.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      onSearchChange(draft.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, [draft, onSearchChange]);

  const toggleSector = (id: string) => {
    const next = new Set(sectors);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSectors(next);
    onSectorsChange(next);
  };

  const toggleMarket = (m: SecurityMarket) => {
    const next = new Set(markets);
    if (next.has(m)) next.delete(m); else next.add(m);
    setMarkets(next);
    onMarketsChange(next);
  };

  return (
    <aside style={SIDEBAR} data-testid="securities-sidebar">
      <header style={HEADER}>
        <span className="nx-label">SECURITIES UNIVERSE</span>
        <span style={COUNT_TEXT} data-testid="securities-count">
          {matchedCount}/{securities.length} MATCHED
        </span>
      </header>

      <input
        type="text"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        // i18n: 'graph.search.placeholder' — fallback string lives here
        // until the en/ko bundles ship.
        placeholder="종목명 또는 티커 검색 — 005930, 삼성, Samsung…"
        style={INPUT}
        data-testid="securities-search"
        spellCheck={false}
        autoComplete="off"
      />

      {/* Market toggle — 4 mini-buttons. Active state uses --border-hi
          + --cyan glow; idle = --border + --fg-dim text. */}
      <div style={MARKET_ROW}>
        {MARKETS.map(m => {
          const active = markets.has(m);
          return (
            <button
              key={m}
              type="button"
              onClick={() => toggleMarket(m)}
              style={marketButtonStyle(active)}
              data-testid={`securities-market-${m}`}
              data-active={active}
            >
              {m}
            </button>
          );
        })}
      </div>

      {/* Sector checkboxes — scrollable list. */}
      <div style={SECTOR_LIST}>
        {sectorOptions.map(opt => {
          const active = sectors.has(opt.id);
          return (
            <label
              key={opt.id}
              style={sectorRowStyle(active)}
              data-testid={`securities-sector-${opt.id}`}
            >
              <input
                type="checkbox"
                checked={active}
                onChange={() => toggleSector(opt.id)}
                style={CHECKBOX}
              />
              <span style={SECTOR_LABEL}>{opt.label}</span>
              <span style={SECTOR_COUNT}>{opt.count}</span>
            </label>
          );
        })}
      </div>
    </aside>
  );
}

// ── shared simple fuzzy match helper — exposed for reuse ───────────────
//
// score ∈ [0, 1]; ≥ 0.5 counts as a match. Strategy:
//   - exact (case-insensitive) prefix on ticker / name_ko / name_en /
//     alias → 1.0
//   - case-insensitive substring match → 0.7
//   - leading-token-of-name (split on space/hyphen/middle-dot) → 0.6
//   - no match → 0.0
// Cheap enough to call O(N) per keystroke for N ≤ 1000.

export function fuzzyScoreSecurity(s: SecurityDTO, query: string): number {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return 1; // empty query = matches everything

  let best = 0;
  for (const candidate of [s.ticker, s.name_ko, s.name_en, ...s.aliases]) {
    if (!candidate) continue;
    const c = candidate.toLowerCase();
    if (c === q || c.startsWith(q)) best = Math.max(best, 1.0);
    else if (c.includes(q))         best = Math.max(best, 0.7);
    else {
      // token-prefix on space / hyphen / middle dot.
      const tokens = c.split(/[\s\-·]/);
      if (tokens.some(t => t.startsWith(q))) best = Math.max(best, 0.6);
    }
  }
  return best;
}

// ── styles (NEXUS tokens only) ─────────────────────────────────────────

const SIDEBAR: CSSProperties = {
  display:        'flex',
  flexDirection:  'column',
  gap:            'var(--s-2)',
  padding:        'var(--s-3)',
  background:     'var(--bg-panel)',
  borderRight:    '1px solid var(--border)',
  width:          'var(--col-left)',
  minHeight:      0,
  color:          'var(--fg)',
};

const HEADER: CSSProperties = {
  display:        'flex',
  alignItems:     'center',
  justifyContent: 'space-between',
};

const COUNT_TEXT: CSSProperties = {
  font:           'var(--type-mono)',
  color:          'var(--fg-dim)',
  fontVariantNumeric: 'tabular-nums',
};

const INPUT: CSSProperties = {
  font:           'var(--type-mono)',
  color:          'var(--fg)',
  background:     'var(--bg-panel-hi)',
  border:         '1px solid var(--border)',
  borderRadius:   'var(--r-1)',
  padding:        '6px 8px',
  outline:        'none',
  width:          '100%',
  transition:     'border-color var(--dur-1) var(--ease-out)',
};

const MARKET_ROW: CSSProperties = {
  display:        'grid',
  gridTemplateColumns: 'repeat(4, 1fr)',
  gap:            'var(--s-1)',
};

function marketButtonStyle(active: boolean): CSSProperties {
  return {
    font:           'var(--type-label)',
    letterSpacing:  'var(--track-label)',
    textTransform:  'uppercase',
    color:          active ? 'var(--cyan)' : 'var(--fg-dim)',
    background:     'transparent',
    border:         active
      ? '1px solid var(--border-hi)'
      : '1px solid var(--border)',
    borderRadius:   'var(--r-1)',
    padding:        '6px 8px',
    cursor:         'pointer',
    boxShadow:      active ? 'var(--glow-soft)' : 'none',
    transition:     'all var(--dur-1) var(--ease-out)',
  };
}

const SECTOR_LIST: CSSProperties = {
  display:        'flex',
  flexDirection:  'column',
  gap:            '2px',
  overflowY:      'auto',
  flex:           1,
  marginTop:      'var(--s-2)',
};

function sectorRowStyle(active: boolean): CSSProperties {
  return {
    display:        'grid',
    gridTemplateColumns: 'auto 1fr auto',
    alignItems:     'center',
    gap:            'var(--s-2)',
    padding:        '4px 6px',
    cursor:         'pointer',
    background:     active ? 'var(--bg-glass-hi)' : 'transparent',
    borderRadius:   'var(--r-1)',
    transition:     'background var(--dur-1) var(--ease-out)',
  };
}

const CHECKBOX: CSSProperties = {
  accentColor:    'var(--cyan)',
  width:          '12px',
  height:         '12px',
};

const SECTOR_LABEL: CSSProperties = {
  font:           'var(--type-mono)',
  color:          'var(--fg)',
  overflow:       'hidden',
  textOverflow:   'ellipsis',
  whiteSpace:     'nowrap',
};

const SECTOR_COUNT: CSSProperties = {
  font:           'var(--type-mono)',
  color:          'var(--fg-dim)',
  fontVariantNumeric: 'tabular-nums',
};
