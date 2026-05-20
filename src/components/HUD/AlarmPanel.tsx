// AlarmPanel — Operator Alarms HUD (spec §4).
//
// Sits at the top of the right HUD column. Owns the 7 state branches
// (initial / loading-refresh / ok-stream / ok-empty / error-network /
// error-auth / error-other) and dispatches each branch to its
// dedicated header copy + body renderer. The single-active accordion
// expansion state is local — rows are pure presentational.
//
// All visuals reference `colors_and_type.css` tokens via CSS variables
// (`var(--bg-panel)`, `var(--glow-cyan)`, etc.). No hex literals. The
// existing `.nx-panel` / `.nx-panel__head` / `.nx-panel__title`
// dashboard classes provide the outer chrome to keep the right column
// visually homogeneous with SystemHealthPanel / TapePanel.

import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';

import { useAlarms } from '../../hooks/useAlarms';
import type { AlarmDTO, ProblemDetail } from '../../types/api';
import { PROBLEM_TYPE } from '../../types/api';

import { AlarmRow } from './AlarmRow';

const AGE_TICK_MS    = 1000;
const SKELETON_ROWS  = 3;

type PanelState =
  | 'initial'
  | 'loading-refresh'
  | 'ok-stream'
  | 'ok-empty'
  | 'error-network'
  | 'error-auth'
  | 'error-other';

export interface AlarmPanelProps {
  /** Optional override of the fetch base URL (testing / staging). */
  baseUrl?: string;
}

export function AlarmPanel({ baseUrl }: AlarmPanelProps = {}) {
  const { data, problem, isLoading, isRefreshing, lastReceivedAt } = useAlarms(
    baseUrl !== undefined ? { baseUrl } : {},
  );

  // Single-active expansion. Clicking the same row toggles off.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const toggleExpanded = (id: string) =>
    setExpandedId(prev => (prev === id ? null : id));

  // 1Hz tick to refresh the "last frame {n}s ago" copy without
  // triggering a re-fetch. Identical pattern to SystemHealthPanel.
  const [, setNowTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setNowTick(n => n + 1), AGE_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const state: PanelState = resolveState({ data, problem, isLoading, isRefreshing });
  const items: ReadonlyArray<AlarmDTO> = data?.items ?? [];
  const unackCount = data?.unacknowledged_count ?? 0;

  return (
    <section
      className="nx-panel"
      aria-label="Operator Alarms"
      data-testid="alarm-panel"
      data-state={state}
      style={PANEL_OUTER}
    >
      <header className="nx-panel__head">
        <div className="nx-panel__title">
          <HeaderGlyph state={state} />
          <span style={HEADER_LABEL}>ALARMS // OPERATOR</span>
        </div>
        <div style={HEADER_RIGHT}>
          {unackCount > 0 && state !== 'error-auth' && (
            <span style={UNACK_COUNTER} data-testid="alarm-unack-counter">
              {unackCount} UNACK
            </span>
          )}
          {state === 'loading-refresh' && (
            <span
              className="nx-alarm-refresh-glyph"
              style={REFRESH_GLYPH}
              data-testid="alarm-refresh-glyph"
              aria-hidden="true"
            >
              {'\u27F6'}
            </span>
          )}
        </div>
      </header>

      <div style={BODY}>
        <PanelBody
          state={state}
          items={items}
          expandedId={expandedId}
          onToggle={toggleExpanded}
          problem={problem}
          lastReceivedAt={lastReceivedAt}
        />
      </div>

      <style>{REDUCED_MOTION_CSS}</style>
    </section>
  );
}

// ── state machine ─────────────────────────────────────────────────────

function resolveState(args: {
  data:         AlarmDTO[] extends never ? never : (ReturnType<typeof useAlarms>['data']);
  problem:      ProblemDetail | null;
  isLoading:    boolean;
  isRefreshing: boolean;
}): PanelState {
  const { data, problem, isLoading, isRefreshing } = args;

  if (isLoading && data === null) return 'initial';

  if (problem) {
    if (problem.type === PROBLEM_TYPE.NETWORK)              return 'error-network';
    if (problem.type === PROBLEM_TYPE.AUTH || problem.status === 401) return 'error-auth';
    return 'error-other';
  }

  if (data) {
    if (data.items.length === 0) return 'ok-empty';
    // A poll cycle is in flight on top of an existing data frame — the
    // spec §4 `loading-refresh` state. The body stays on the last
    // frame; the header surfaces the `⟶` glyph fade.
    if (isRefreshing) return 'loading-refresh';
    return 'ok-stream';
  }

  // No data, no problem, not initial loading — treat as initial
  // (defensive; should be unreachable in practice).
  return 'initial';
}

// ── body renderer ─────────────────────────────────────────────────────

interface BodyProps {
  state:          PanelState;
  items:          ReadonlyArray<AlarmDTO>;
  expandedId:     string | null;
  onToggle:       (id: string) => void;
  problem:        ProblemDetail | null;
  lastReceivedAt: number | null;
}

function PanelBody({
  state, items, expandedId, onToggle, problem, lastReceivedAt,
}: BodyProps) {
  if (state === 'initial') {
    return <SkeletonRows count={SKELETON_ROWS} />;
  }

  if (state === 'error-auth') {
    return (
      <div style={ERROR_LINE_CRIT} data-testid="alarm-error">
        UNAUTHORIZED — re-issue bearer.
      </div>
    );
  }

  if (state === 'error-other') {
    const title  = problem?.title  ?? 'Unknown';
    const detail = problem?.detail ?? 'unspecified';
    return (
      <div style={ERROR_LINE_CRIT} data-testid="alarm-error">
        {title} — {detail}
      </div>
    );
  }

  if (state === 'error-network') {
    // Last frame age in seconds, computed against wall clock; falls
    // back to "—" when no successful frame has ever landed.
    const ageS = lastReceivedAt
      ? Math.max(0, Math.floor((Date.now() - lastReceivedAt) / 1000))
      : null;
    const ageText = ageS === null ? '—' : `${ageS}`;
    return (
      <div>
        <div style={ERROR_LINE_AMBER} data-testid="alarm-error">
          CHANNEL LOST — last frame {ageText}s ago. retrying…
        </div>
        {items.length > 0 && (
          // Render last-known frame so the operator keeps continuity.
          <RowList
            items={items}
            expandedId={expandedId}
            onToggle={onToggle}
            stale={true}
          />
        )}
      </div>
    );
  }

  if (state === 'ok-empty') {
    return (
      <div style={EMPTY_LINE} data-testid="alarm-empty">
        NO ALARMS IN SCOPE — system nominal.
      </div>
    );
  }

  // ok-stream
  return (
    <RowList
      items={items}
      expandedId={expandedId}
      onToggle={onToggle}
      stale={false}
    />
  );
}

interface RowListProps {
  items:      ReadonlyArray<AlarmDTO>;
  expandedId: string | null;
  onToggle:   (id: string) => void;
  stale:      boolean;
}

function RowList({ items, expandedId, onToggle, stale }: RowListProps) {
  return (
    <ul
      role="list"
      data-testid="alarm-list"
      data-stale={stale ? 'true' : 'false'}
      style={LIST}
    >
      {items.map(alarm => (
        <AlarmRow
          key={alarm.id}
          alarm={alarm}
          expanded={expandedId === alarm.id}
          onToggle={onToggle}
        />
      ))}
    </ul>
  );
}

function SkeletonRows({ count }: { count: number }) {
  const rows = useMemo(() => Array.from({ length: count }, (_, i) => i), [count]);
  return (
    <ul style={LIST} data-testid="alarm-skeleton">
      {rows.map(i => (
        <li key={i} style={SKELETON_ROW}>
          <span style={SKELETON_SENTINEL} aria-hidden="true" />
          <div style={SKELETON_BODY}>
            <div style={SKELETON_BAR_60} />
            <div style={SKELETON_BAR_40} />
          </div>
        </li>
      ))}
    </ul>
  );
}

// ── header glyph dispatcher ───────────────────────────────────────────

function HeaderGlyph({ state }: { state: PanelState }) {
  // Map state → glyph + color. ALL CAPS labels per NEXUS brand —
  // glyphs come straight from the spec §4 table.
  if (state === 'initial')
    return <GlyphChip glyph={'\u25C7'} text="CONNECTING\u2026" color="var(--fg-dim)" />;
  if (state === 'loading-refresh')
    return <GlyphChip glyph={'\u25CF'} text="LIVE"             color="var(--cyan)" />;
  if (state === 'ok-stream')
    return <GlyphChip glyph={'\u25CF'} text="LIVE"             color="var(--cyan)" />;
  if (state === 'ok-empty')
    return <GlyphChip glyph={'\u25CF'} text="NOMINAL"          color="var(--ok)" />;
  if (state === 'error-network')
    return <GlyphChip glyph={'\u25CB'} text="STANDBY"          color="var(--amber)" />;
  if (state === 'error-auth')
    return <GlyphChip glyph={'\u25C6'} text="HALT"             color="var(--crimson)" />;
  // error-other
  return <GlyphChip glyph={'\u25C6'} text="ANOMALY"            color="var(--crimson)" />;
}

function GlyphChip({ glyph, text, color }: { glyph: string; text: string; color: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', color }}>
      <span style={{ font: 'var(--type-mono-hi)' }} aria-hidden="true">{glyph}</span>
      <span style={{ font: 'var(--type-label)', letterSpacing: 'var(--track-label)' }}>{text}</span>
    </span>
  );
}

// ── styles (tokens only) ──────────────────────────────────────────────

const PANEL_OUTER: CSSProperties = {
  background:    'var(--bg-panel)',
  border:        '1px solid var(--border)',
  borderRadius:  'var(--r-2)',
  marginBottom:  'var(--s-2)',
};

const HEADER_LABEL: CSSProperties = {
  font:          'var(--type-label)',
  letterSpacing: 'var(--track-label)',
  color:         'var(--fg-dim)',
  textTransform: 'uppercase',
};

const HEADER_RIGHT: CSSProperties = {
  display:       'flex',
  alignItems:    'center',
  gap:           'var(--s-2)',
};

const UNACK_COUNTER: CSSProperties = {
  font:          'var(--type-mono-hi)',
  color:         'var(--lime)',
  letterSpacing: '0.06em',
  fontVariantNumeric: 'tabular-nums',
};

const REFRESH_GLYPH: CSSProperties = {
  font:          'var(--type-mono)',
  color:         'var(--fg-dim)',
  opacity:       0.7,
  // Inline `transition` covers the mount → visible fade-in for browsers
  // that ignore the keyframe animation block (defensive). The actual
  // fade in/out comes from the keyframes declared in REFRESH_GLYPH_CSS
  // below so we can author the in→hold→out curve cleanly.
  transition:    'opacity var(--dur-2) var(--ease-out)',
  animation:     'nx-alarm-refresh-fade var(--dur-2, 220ms) var(--ease-out) 1',
};

const BODY: CSSProperties = {
  display:       'flex',
  flexDirection: 'column',
};

const LIST: CSSProperties = {
  listStyle:     'none',
  margin:        0,
  padding:       0,
  display:       'flex',
  flexDirection: 'column',
};

const EMPTY_LINE: CSSProperties = {
  padding:       'var(--s-3) var(--s-4)',
  font:          'var(--type-mono)',
  color:         'var(--fg-dim)',
  letterSpacing: '0.04em',
};

const ERROR_LINE_CRIT: CSSProperties = {
  padding:       'var(--s-3) var(--s-4)',
  font:          'var(--type-mono)',
  color:         'var(--crimson)',
  letterSpacing: '0.04em',
};

const ERROR_LINE_AMBER: CSSProperties = {
  padding:       'var(--s-3) var(--s-4)',
  font:          'var(--type-mono)',
  color:         'var(--amber)',
  letterSpacing: '0.04em',
  borderBottom:  '1px solid var(--amber-dim, var(--border))',
};

const SKELETON_ROW: CSSProperties = {
  display:        'grid',
  gridTemplateColumns: '4px 1fr',
  alignItems:     'stretch',
  borderBottom:   '1px solid var(--border)',
};

const SKELETON_SENTINEL: CSSProperties = {
  width:          '4px',
  background:     'var(--slate-low)',
};

const SKELETON_BODY: CSSProperties = {
  display:        'flex',
  flexDirection:  'column',
  gap:            '6px',
  padding:        'var(--s-2) var(--s-3)',
};

const SKELETON_BAR_60: CSSProperties = {
  height:         '10px',
  width:          '60%',
  background:     'var(--bone-dim, var(--fg-dim))',
  opacity:        0.12,
  borderRadius:   'var(--r-1)',
};

const SKELETON_BAR_40: CSSProperties = {
  height:         '8px',
  width:          '40%',
  background:     'var(--bone-dim, var(--fg-dim))',
  opacity:        0.08,
  borderRadius:   'var(--r-1)',
};

// Keyframe + reduced-motion CSS, scoped to `[data-testid="alarm-panel"]`
// so neither leaks to neighboring HUD surfaces.
//
// The keyframe drives the spec §4 `loading-refresh` glyph: fade in over
// the first ~30 %, hold near full opacity, then fade out over the last
// ~50 %. The total duration is `--dur-2` (220ms). The animation runs
// once when the `<span>` mounts; if the poll resolves quickly the next
// mount re-runs the cycle (toggles `⟶` in / out per poll). The
// `prefers-reduced-motion: reduce` branch disables BOTH `transition`
// and `animation` so the glyph appears instantly and disappears
// instantly with no fade.
const REDUCED_MOTION_CSS = `
@keyframes nx-alarm-refresh-fade {
  0%   { opacity: 0; }
  30%  { opacity: 0.7; }
  60%  { opacity: 0.7; }
  100% { opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  [data-testid="alarm-panel"] *,
  [data-testid="alarm-panel"] *::before,
  [data-testid="alarm-panel"] *::after {
    transition: none !important;
    animation:  none !important;
  }
  [data-testid="alarm-panel"] .nx-alarm-refresh-glyph {
    opacity: 0.7 !important;
  }
}
`;
