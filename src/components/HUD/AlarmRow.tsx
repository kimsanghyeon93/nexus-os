// AlarmRow — one row inside the AlarmPanel.
//
// Severity drives both the leading glyph + label and the left 4px
// "sentinel" sidebar color. The row is collapsed by default; clicking
// (or pressing Enter/Space) toggles an inline metadata grid that lists
// the alarm's domain attributes plus any `metadata` keys (alphabetized,
// per spec §4 — operators want deterministic ordering for diffing
// successive alarms).
//
// Visuals follow NEXUS tokens only — `var(--*)` references resolve
// against `colors_and_type.css`. No hex literals. `prefers-reduced-
// motion: reduce` zeroes the fade/scale transitions (handled at the
// AlarmPanel level via a wrapper class — this component still requests
// the transitions; the parent stylesheet overrides them).

import { useMemo } from 'react';
import type { CSSProperties } from 'react';

import type { AlarmDTO, AlarmSeverity } from '../../types/api';

/** Severity → glyph + token mapping. Tokens are the CSS variable names
 *  from `colors_and_type.css`. The glyph string is rendered as-is in
 *  the row header (mono); the `glow` variable name controls the
 *  expanded-row's box-shadow. */
interface SeverityVisual {
  glyph:     string;
  color:     string;   // css var() for foreground
  glow:      string;   // css var() for box-shadow
  border:    string;   // css var() for left sentinel
}

const SEVERITY_TABLE: Record<AlarmSeverity, SeverityVisual> = {
  info:     { glyph: '\u25C7',         color: 'var(--cyan)',    glow: 'var(--glow-cyan)',   border: 'var(--cyan)'    }, // ◇
  warn:     { glyph: '\u25B2 WARN',    color: 'var(--amber)',   glow: 'var(--glow-amber)',  border: 'var(--amber)'   }, // ▲ WARN
  anomaly:  { glyph: '\u25C6 ANOMALY', color: 'var(--lime)',    glow: 'var(--glow-lime)',   border: 'var(--lime)'    }, // ◆ ANOMALY
  critical: { glyph: '\u25A0 CRIT',    color: 'var(--crimson)', glow: 'var(--glow-cyan)',   border: 'var(--crimson)' }, // ■ CRIT
};

export function severityVisualFor(severity: AlarmSeverity): SeverityVisual {
  return SEVERITY_TABLE[severity];
}

export interface AlarmRowProps {
  alarm:      AlarmDTO;
  /** True when this row is the panel's currently-expanded row. The
   *  panel owns single-active state — the row is stateless and just
   *  reports clicks. */
  expanded:   boolean;
  onToggle:   (id: string) => void;
}

export function AlarmRow({ alarm, expanded, onToggle }: AlarmRowProps) {
  const visual = severityVisualFor(alarm.severity);

  const metaGrid = useMemo(
    () => buildMetadataEntries(alarm),
    [alarm],
  );

  const handleClick = () => onToggle(alarm.id);
  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onToggle(alarm.id);
    }
  };

  return (
    <li
      role="listitem"
      data-testid="alarm-row"
      data-severity={alarm.severity}
      data-status={alarm.status}
      data-expanded={expanded ? 'true' : 'false'}
      aria-expanded={expanded}
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKey}
      style={rowStyle(visual, expanded)}
    >
      {/* Left 4px sentinel — severity-colored vertical bar. Drawn as a
       *  border-left so it remains crisp at any zoom (CSS pixels, no
       *  subpixel). */}
      <span style={sentinelStyle(visual)} aria-hidden="true" />

      <div style={ROW_BODY}>
        <div style={ROW_HEAD}>
          <span style={{ ...GLYPH_TEXT, color: visual.color }} data-testid="alarm-glyph">
            {visual.glyph}
          </span>
          <span style={TITLE_TEXT}>{alarm.title}</span>
          <span
            className={'nx-dot ' + statusDotClass(alarm.severity, alarm.status)}
            aria-label={`status ${alarm.status}`}
            data-testid="alarm-status-dot"
          />
        </div>

        <div style={MESSAGE_TEXT}>{alarm.message}</div>

        <div style={META_LINE}>
          {formatTime(alarm.occurred_at)}
          {' \u00B7 '}
          {alarm.source}
          {' \u00B7 '}
          {alarm.code}
        </div>

        {expanded && (
          <dl style={EXPANDED_GRID} data-testid="alarm-expanded">
            {metaGrid.map(([k, v]) => (
              <div key={k} style={EXPANDED_ROW}>
                <dt style={EXPANDED_KEY}>{k}</dt>
                <dd style={EXPANDED_VAL}>{v}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </li>
  );
}

// ── helpers ───────────────────────────────────────────────────────────

/** Build the ALL-CAPS keyed entries shown in the expanded row.
 *  Domain attributes come first in spec order (OCCURRED, STATUS,
 *  ENTITY, ACKNOWLEDGED, RESOLVED); `metadata` keys follow,
 *  alphabetized — per spec §4 they must be deterministically ordered
 *  so operators can diff successive alarms visually. */
function buildMetadataEntries(alarm: AlarmDTO): ReadonlyArray<[string, string]> {
  const entries: Array<[string, string]> = [];
  entries.push(['OCCURRED', formatIsoFull(alarm.occurred_at)]);
  entries.push(['STATUS',   alarm.status.toUpperCase()]);
  if (alarm.entity_id) {
    // Sprint 5s+ — when the backend joined a security display_name
    // onto the entity_id (i.e. entity_id is a ticker in the securities
    // master), render both together so the operator sees "Samsung
    // Electronics · 005930" instead of a bare 6-digit code. Falls back
    // to entity_id alone for ontology nodes (HUB_*, sector aggregators)
    // that have no security row.
    const display = alarm.entity_display;
    entries.push([
      'ENTITY',
      display ? `${display} · ${alarm.entity_id}` : alarm.entity_id,
    ]);
  }
  if (alarm.acknowledged_at) entries.push(['ACKNOWLEDGED', formatIsoFull(alarm.acknowledged_at)]);
  if (alarm.resolved_at)     entries.push(['RESOLVED',     formatIsoFull(alarm.resolved_at)]);

  if (alarm.metadata) {
    const keys = Object.keys(alarm.metadata).sort();
    for (const k of keys) {
      const raw = alarm.metadata[k];
      const display = raw === null
        ? 'null'
        : typeof raw === 'string'
          ? raw
          : JSON.stringify(raw);
      entries.push([k.toUpperCase(), display]);
    }
  }
  return entries;
}

function statusDotClass(severity: AlarmSeverity, status: AlarmDTO['status']): string {
  if (status === 'resolved')     return 'nx-dot--ok';
  if (status === 'acknowledged') return 'nx-dot--cyan';
  // status === 'active' — color the dot by severity.
  if (severity === 'critical')   return 'nx-dot--crit';
  if (severity === 'warn')       return 'nx-dot--amber';
  if (severity === 'anomaly')    return 'nx-dot--crit';
  return 'nx-dot--cyan';
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatIsoFull(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // Render as "YYYY-MM-DD HH:MM:SS" (operator-readable, locale-stable).
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
         `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
}

// ── styles (NEXUS tokens only — no hex literals) ──────────────────────

function rowStyle(visual: SeverityVisual, expanded: boolean): CSSProperties {
  return {
    position:       'relative',
    display:        'grid',
    gridTemplateColumns: '4px 1fr',
    alignItems:     'stretch',
    cursor:         'pointer',
    background:     expanded ? 'var(--bg-glass-hi)' : 'transparent',
    borderBottom:   '1px solid var(--border)',
    transition:     'background var(--dur-1) var(--ease-out), box-shadow var(--dur-2) var(--ease-out)',
    boxShadow:      expanded ? visual.glow : 'none',
    outline:        'none',
  };
}

function sentinelStyle(visual: SeverityVisual): CSSProperties {
  return {
    width:        '4px',
    background:   visual.border,
    boxShadow:    `0 0 8px ${visual.border}`,
  };
}

const ROW_BODY: CSSProperties = {
  display:        'flex',
  flexDirection:  'column',
  gap:            '2px',
  padding:        'var(--s-2) var(--s-3)',
  minWidth:       0,
};

const ROW_HEAD: CSSProperties = {
  display:        'flex',
  alignItems:     'center',
  gap:            'var(--s-2)',
};

const GLYPH_TEXT: CSSProperties = {
  font:           'var(--type-mono-hi)',
  letterSpacing:  'var(--track-mono)',
  whiteSpace:     'nowrap',
};

const TITLE_TEXT: CSSProperties = {
  font:           'var(--type-mono-hi)',
  color:          'var(--fg)',
  flex:           1,
  overflow:       'hidden',
  textOverflow:   'ellipsis',
  whiteSpace:     'nowrap',
  textTransform:  'uppercase',
  letterSpacing:  '0.04em',
};

const MESSAGE_TEXT: CSSProperties = {
  font:           'var(--type-mono)',
  color:          'var(--fg-dim)',
  // Operators can read 2 lines of context inline; longer messages clip.
  display:        '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow:       'hidden',
};

const META_LINE: CSSProperties = {
  font:           'var(--type-mono)',
  color:          'var(--fg-dim)',
  opacity:        0.7,
  fontVariantNumeric: 'tabular-nums',
};

const EXPANDED_GRID: CSSProperties = {
  display:        'grid',
  gridTemplateColumns: 'auto 1fr',
  columnGap:      'var(--s-3)',
  rowGap:         '2px',
  margin:         'var(--s-2) 0 0',
  paddingTop:     'var(--s-2)',
  borderTop:      '1px solid var(--border)',
};

const EXPANDED_ROW: CSSProperties = {
  display:        'contents',
};

const EXPANDED_KEY: CSSProperties = {
  font:           'var(--type-label)',
  letterSpacing:  'var(--track-label)',
  color:          'var(--fg-dim)',
  textTransform:  'uppercase',
  margin:         0,
};

const EXPANDED_VAL: CSSProperties = {
  font:           'var(--type-mono)',
  color:          'var(--fg)',
  margin:         0,
  overflow:       'hidden',
  textOverflow:   'ellipsis',
  whiteSpace:     'nowrap',
};
