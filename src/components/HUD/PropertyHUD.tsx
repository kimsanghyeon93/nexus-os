// PropertyHUD — right column skeleton.
// Renders the currently selected entity's properties in a JARVIS-style
// inspector. Purple-tinted accents for AI-derived metrics; cyan for hard
// telemetry. When no selection exists, shows a "no target locked" state.

import { useEffect, useRef, useState } from 'react';
import type { NexusEdge, NexusEntity } from '../../types/nexus';
import type { EntityDelta } from '../../utils/diff';
import { fetchRecentAudit } from '../../services/auditApi';
import type { AuditRow } from '../../types/api';

export interface PropertyHUDProps {
  entity: NexusEntity | null;
  transactions: NexusEdge[];
  onSelect?: ((id: string) => void) | undefined;
  /** When in diff mode, the per-entity deltas. Presence of an entry for the
   *  selected entity flips the metrics readout from absolutes to "+X%" deltas. */
  diffMap?: ReadonlyMap<string, EntityDelta> | null;
}

export function PropertyHUD({ entity, transactions, onSelect, diffMap }: PropertyHUDProps) {
  return (
    <aside className="nx-panel nx-prop" aria-label="Property HUD">
      <header className="nx-panel__head">
        <div className="nx-panel__title">
          <span className="nx-dot nx-dot--purple nx-dot--pulse" />
          <span>PROPERTIES</span>
        </div>
        <span className="nx-panel__chev">▸</span>
      </header>

      {entity ? (
        <EntityCard
          entity={entity}
          transactions={transactions}
          onSelect={onSelect}
          delta={diffMap?.get(entity.id) ?? null}
        />
      ) : (
        <NoTarget />
      )}

      <footer className="nx-panel__foot nx-mono-dim" style={{ fontSize: 9 }}>
        AI · DERIVED · CONFIDENCE 94%
      </footer>
    </aside>
  );
}

function NoTarget() {
  return (
    <section className="nx-prop__empty">
      <div className="nx-label" style={{ color: 'var(--purple-soft)' }}>
        NO TARGET LOCKED
      </div>
      <div className="nx-mono-dim" style={{ fontSize: 10, marginTop: 6, lineHeight: 1.5 }}>
        Click any node on the radar to inspect its ontology, flow, and risk
        signal.
      </div>
    </section>
  );
}

interface EntityCardProps {
  entity: NexusEntity;
  transactions: NexusEdge[];
  onSelect?: ((id: string) => void) | undefined;
  delta: EntityDelta | null;
}

function EntityCard({ entity, transactions, onSelect, delta }: EntityCardProps) {
  const tone = entity.anomaly > 0.7 ? 'lime' : entity.clusterColor;
  const isDiff = delta !== null;
  const inflow = transactions
    .filter(t => t.to === entity.id)
    .sort((a, b) => b.usd - a.usd)
    .slice(0, 5);
  const outflow = transactions
    .filter(t => t.from === entity.id)
    .sort((a, b) => b.usd - a.usd)
    .slice(0, 5);
  const anomalyHistory = useAnomalyHistory(entity);

  return (
    <section className="nx-prop__body">
      <div className={`nx-prop__id nx-prop__id--${tone}`}>
        <div className="nx-mono-dim" style={{ fontSize: 9 }}>ID</div>
        <div className="nx-prop__idval">{entity.id}</div>
      </div>

      <div className="nx-prop__name">
        <div className="nx-mono" style={{ fontSize: 13, color: 'var(--fg)' }}>
          {entity.label}
        </div>
        <div className="nx-mono-dim" style={{ fontSize: 10 }}>
          {entity.type.replace(/_/g, ' ').toUpperCase()} · {entity.jurisdiction}
        </div>
      </div>

      <Sparkline values={anomalyHistory} tone={tone} />

      {isDiff ? (
        <div className="nx-prop__metrics nx-prop__metrics--diff">
          <Metric
            label="ANOMALY Δ"
            value={signedPct(delta.anomalyDelta)}
            tone={diffTone(delta.tone)}
          />
          <Metric
            label="VOLUME Δ"
            value={signedCompact(delta.txVolDelta) + 'M'}
            tone={diffTone(delta.txVolDelta > 0 ? 'up' : delta.txVolDelta < 0 ? 'down' : 'flat')}
          />
          <Metric
            label="LIVE / SNAP"
            value={(delta.liveAnomaly * 100).toFixed(0) + '% / ' + (delta.replayAnomaly * 100).toFixed(0) + '%'}
            tone="purple"
          />
          <Metric
            label="DEGREE"
            value={String(entity.degree ?? 0)}
            tone="purple"
          />
        </div>
      ) : (
        <div className="nx-prop__metrics">
          <Metric label="ANOMALY" value={(entity.anomaly * 100).toFixed(0) + '%'} tone={tone} barFraction={entity.anomaly} />
          <Metric label="VOLUME" value={'$' + formatCompact(entity.txVol) + 'M'} tone="cyan" />
          <Metric label="EIGEN"  value={(entity.eigen ?? 0).toFixed(3)} tone="purple" />
          <Metric label="DEGREE" value={String(entity.degree ?? 0)} tone="purple" />
        </div>
      )}

      {entity.sanctioned && (
        <div className="nx-prop__sanction">
          ◆ SANCTIONED · OFAC list
        </div>
      )}

      <FlowList title="INBOUND" edges={inflow} onSelect={onSelect} dir="in" />
      <FlowList title="OUTBOUND" edges={outflow} onSelect={onSelect} dir="out" />
      <RecentDecisions symbol={entity.id} />
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  RecentDecisions — ambient awareness of the last 3 audit rows     */
/* ------------------------------------------------------------------ */
//  Compact pull from /v1/audit/recent so the operator can see the
//  coordinator's latest verdicts inline without opening the ⌘L modal.
//  Polls at 5s — slower than the modal's 3s because this is "peripheral
//  vision", not a deep dive. The panel renders NOTHING when the entity
//  has no audit history (synthetic non-KIS nodes), so the right column
//  stays compact for entities the live pipeline doesn't drive.
//
//  Error handling is intentionally silent: a fetch failure shows the
//  last known rows or hides the panel. Reasoning — the ⌘L modal is the
//  authoritative surface for errors; an inline error chip here would
//  add noise without changing what the operator can do about it.

interface RecentDecisionsProps {
  symbol: string;
}

const RECENT_LIMIT          = 3;
const RECENT_POLL_INTERVAL  = 5000;

function RecentDecisions({ symbol }: RecentDecisionsProps) {
  const [rows, setRows] = useState<AuditRow[] | null>(null);

  useEffect(() => {
    let mounted = true;
    let ctrl: AbortController | null = null;

    const pull = async () => {
      ctrl?.abort();
      ctrl = new AbortController();
      const result = await fetchRecentAudit(symbol, {
        limit:  RECENT_LIMIT,
        signal: ctrl.signal,
      });
      if (!mounted) return;
      if (result.ok) setRows(result.data.rows);
      // Silent on failure — keep last known frame, next poll retries.
    };

    // Reset on symbol change so the previous entity's rows don't flash
    // before the new fetch resolves.
    setRows(null);
    pull();
    const id = setInterval(pull, RECENT_POLL_INTERVAL);
    return () => {
      mounted = false;
      clearInterval(id);
      ctrl?.abort();
    };
  }, [symbol]);

  // No data yet OR explicitly empty (synthetic entity) → hide the panel
  // entirely so the right column stays compact.
  if (!rows || rows.length === 0) return null;

  return (
    <div className="nx-prop__flows" data-testid="property-hud-recent-decisions">
      <div className="nx-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>RECENT DECISIONS</span>
        <span className="nx-mono-dim" style={{ fontSize: 8, letterSpacing: '0.06em' }}>
          ⌘L FOR FULL TRAIL
        </span>
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {rows.map((r, i) => (
          <li key={`${r.ts}-${i}`} style={miniRowStyle(r)}>
            <span style={miniBadgeStyle(r)}>
              {r.executed
                ? 'FILLED'
                : r.blocked_by
                  ? 'BLOCKED'
                  : r.mode.toUpperCase()}
            </span>
            <span style={{ fontSize: 9, color: 'var(--fg-low, #4A5066)' }}>
              {formatMiniTs(r.ts)}
            </span>
            <span style={{ fontSize: 10, color: 'var(--fg, #E8ECF5)', flex: 1, textAlign: 'right' }}>
              {r.signal_action.toUpperCase()} · {(r.signal_confidence * 100).toFixed(0)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function miniRowStyle(_r: AuditRow): React.CSSProperties {
  return {
    display:    'flex',
    alignItems: 'center',
    gap:        8,
    padding:    '3px 0',
    fontFamily: '"JetBrains Mono", ui-monospace, monospace',
  };
}

function miniBadgeStyle(r: AuditRow): React.CSSProperties {
  const color = r.executed   ? '#DEFF9A'
              : r.blocked_by ? '#FFB200'
              : r.mode === 'shadow' ? '#00BFFF'
              : '#8A93A8';
  return {
    color,
    border:        `0.8px solid ${color}`,
    padding:       '0 5px',
    fontSize:      8,
    letterSpacing: '0.08em',
    borderRadius:  2,
    minWidth:      48,
    textAlign:     'center',
  };
}

function formatMiniTs(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

interface MetricProps {
  label: string;
  value: string;
  tone: 'cyan' | 'lime' | 'amber' | 'purple';
  barFraction?: number;
}
function Metric({ label, value, tone, barFraction }: MetricProps) {
  return (
    <div className="nx-prop__metric">
      <div className="nx-prop__mhead">
        <span className="nx-label">{label}</span>
        <span className={`nx-prop__mval nx-prop__mval--${tone}`}>{value}</span>
      </div>
      {barFraction != null && (
        <div className="nx-prop__bar">
          <span
            className={`nx-prop__bar-fill nx-prop__bar-fill--${tone}`}
            style={{ width: `${Math.max(0, Math.min(1, barFraction)) * 100}%` }}
          />
        </div>
      )}
    </div>
  );
}

interface FlowListProps {
  title: string;
  edges: NexusEdge[];
  onSelect?: ((id: string) => void) | undefined;
  dir: 'in' | 'out';
}
function FlowList({ title, edges, onSelect, dir }: FlowListProps) {
  if (edges.length === 0) return null;
  return (
    <div className="nx-prop__flows">
      <div className="nx-label">{title}</div>
      <ul>
        {edges.map((e, i) => {
          const peerId = dir === 'in' ? e.from : e.to;
          const isAnomaly = e.anomaly > 0.7;
          return (
            <li
              key={i}
              className={`nx-prop__flow ${isAnomaly ? 'nx-prop__flow--anomaly' : ''}`}
              onClick={() => onSelect?.(peerId)}
              role="button"
              tabIndex={0}
            >
              <span className="nx-prop__flow-peer">{peerId}</span>
              <span className="nx-prop__flow-usd">${formatCompact(e.usd / 1e6)}M</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function formatCompact(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toFixed(0);
}

function signedPct(delta: number): string {
  // delta is in 0..1 anomaly units; render as percentage with explicit sign.
  const pct = delta * 100;
  const sign = pct > 0 ? '+' : pct < 0 ? '' : '±';
  return `${sign}${pct.toFixed(1)}%`;
}

function signedCompact(n: number): string {
  const abs = Math.abs(n);
  const body = abs >= 1000 ? (abs / 1000).toFixed(1) + 'K' : abs.toFixed(0);
  const sign = n > 0 ? '+' : n < 0 ? '−' : '±';
  return `${sign}${body}`;
}

function diffTone(t: 'up' | 'down' | 'flat'): 'amber' | 'cyan' | 'purple' {
  // Spec: increased = amber/red, decreased = cyan/green. Flat → muted purple.
  return t === 'up' ? 'amber' : t === 'down' ? 'cyan' : 'purple';
}

/* ------------------------------------------------------------------ */
/*  Sparkline — live anomaly trace                                     */
/* ------------------------------------------------------------------ */

const SPARK_BUFFER = 20;
const SPARK_INTERVAL_MS = 250;

/** Samples entity.anomaly every 250ms into a sliding length-20 buffer.
 *  Buffer resets when the entity changes so the trace always reflects
 *  the current target rather than the previous one. */
function useAnomalyHistory(entity: NexusEntity): number[] {
  const [hist, setHist] = useState<number[]>([]);
  // Keep latest entity in a ref so the interval can read it without
  // re-arming the timer on every prop change.
  const ref = useRef(entity);
  ref.current = entity;

  useEffect(() => {
    setHist([entity.anomaly]);
    const id = setInterval(() => {
      setHist(prev => {
        const next = [...prev, ref.current.anomaly];
        return next.length > SPARK_BUFFER ? next.slice(-SPARK_BUFFER) : next;
      });
    }, SPARK_INTERVAL_MS);
    return () => clearInterval(id);
  }, [entity.id, entity.anomaly]);

  return hist;
}

interface SparklineProps {
  values: number[];
  tone: 'cyan' | 'lime' | 'amber' | 'purple';
}

function Sparkline({ values, tone }: SparklineProps) {
  const W = 240;
  const H = 36;
  const stroke = TONE_TO_STROKE[tone];

  if (values.length < 2) {
    return (
      <div className="nx-prop__spark">
        <div className="nx-label">ANOMALY · LIVE</div>
        <div className="nx-prop__spark-empty">— acquiring signal —</div>
      </div>
    );
  }

  // anomaly is normalised 0..1 — clamp to keep the line inside the chart
  const points = values
    .map((v, i) => {
      const x = (i / (SPARK_BUFFER - 1)) * W;
      const y = H - Math.max(0, Math.min(1, v)) * H;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  // 0.7 line marks the lime danger threshold for visual reference
  const dangerY = H - 0.7 * H;
  const last = values[values.length - 1] ?? 0;
  const lastX = ((values.length - 1) / (SPARK_BUFFER - 1)) * W;
  const lastY = H - Math.max(0, Math.min(1, last)) * H;

  return (
    <div className="nx-prop__spark">
      <div className="nx-prop__spark-head">
        <span className="nx-label">ANOMALY · LIVE</span>
        <span className="nx-mono-dim" style={{ fontSize: 9 }}>
          {SPARK_BUFFER * SPARK_INTERVAL_MS / 1000}s window
        </span>
      </div>
      <svg
        width="100%"
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ display: 'block' }}
      >
        {/* danger threshold (0.7 = lime) */}
        <line
          x1={0}
          y1={dangerY}
          x2={W}
          y2={dangerY}
          stroke="var(--lime)"
          strokeWidth={0.5}
          strokeDasharray="2 3"
          opacity={0.45}
        />
        <polyline
          points={points}
          fill="none"
          stroke={stroke}
          strokeWidth={1}
          strokeLinejoin="round"
          strokeLinecap="round"
          opacity={0.95}
          style={{ filter: `drop-shadow(0 0 3px ${stroke})` }}
        />
        {/* current sample marker */}
        <circle
          cx={lastX}
          cy={lastY}
          r={1.6}
          fill={stroke}
          style={{ filter: `drop-shadow(0 0 4px ${stroke})` }}
        />
      </svg>
    </div>
  );
}

const TONE_TO_STROKE: Record<SparklineProps['tone'], string> = {
  cyan:   'var(--cyan)',
  lime:   'var(--lime)',
  amber:  'var(--amber)',
  purple: 'var(--purple-soft)',
};
