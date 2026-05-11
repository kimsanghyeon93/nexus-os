// SystemHealthPanel — Sprint 5q observability HUD.
//
// Three-section compact panel that answers "is the pipeline alive and
// behaving?" in one glance. Designed for 24h unmanned operation —
// operator can glance at the right column and know whether to walk
// away or investigate.
//
// Section 1: ALIVE strip
//   • Last decision age ("12s AGO" / "JUST NOW" / "STALLED 3m"
//     when nothing for >60s)
//   • Current decisions/min (latest closed minute bucket)
//   • Color: lime when ALIVE+ticking, amber when STALLED
//
// Section 2: Decisions/min sparkline (last 30 minutes)
//   • One bar per minute, height = n_total
//   • Bar color by dominant mode in that minute:
//     - lime if any executed (live fill happened that minute)
//     - amber if any blocked (guardrail fired)
//     - cyan otherwise (steady noop/shadow)
//
// Section 3: Blocked-reason breakdown (last 60 minutes)
//   • One horizontal bar per guard_id, sorted desc
//   • Width = n_blocked / max — operator sees dominant rate-limiter
//   • Hidden entirely when total_blocked is 0 (clean panel during quiet)

import { useEffect, useState } from 'react';

import { fetchDecisionRate, fetchBlockedReasons } from '../../services/metricsApi';
import type {
  BlockedReasonsDTO,
  DecisionBucket,
  DecisionRateDTO,
} from '../../types/api';

const DECISIONS_POLL_MS   = 10_000;   // every 10s — buckets are 1-min granularity
const BLOCKED_POLL_MS     = 15_000;   // 15s — distribution moves slower
const DECISIONS_WINDOW_M  = 30;
const BLOCKED_WINDOW_M    = 60;
// > this since last bucket's START → STALLED state. The aggregate is
// minute-truncated server-side, so "12:30 bucket exists" can mean the
// LAST decision was at 12:30:00 or 12:30:59 — up to 60s of uncertainty
// either way. Threshold of 90s gives a one-minute margin past the
// bucket's worst-case start so the panel doesn't flicker into
// STALLED at every minute boundary during steady operation.
const STALLED_THRESHOLD_S = 90;
const RENDER_TICK_MS      = 1000;     // re-render for "Ns AGO" chip without refetch

export function SystemHealthPanel() {
  const [rate, setRate]       = useState<DecisionRateDTO | null>(null);
  const [blocked, setBlocked] = useState<BlockedReasonsDTO | null>(null);
  const [, setNowTick]        = useState(0);

  // Decision-rate poll.
  useEffect(() => {
    let mounted = true;
    let ctrl: AbortController | null = null;
    const pull = async () => {
      ctrl?.abort();
      ctrl = new AbortController();
      const result = await fetchDecisionRate({
        windowMinutes: DECISIONS_WINDOW_M,
        signal:        ctrl.signal,
      });
      if (!mounted) return;
      if (result.ok) setRate(result.data);
    };
    pull();
    const id = setInterval(pull, DECISIONS_POLL_MS);
    return () => { mounted = false; clearInterval(id); ctrl?.abort(); };
  }, []);

  // Blocked-reason poll.
  useEffect(() => {
    let mounted = true;
    let ctrl: AbortController | null = null;
    const pull = async () => {
      ctrl?.abort();
      ctrl = new AbortController();
      const result = await fetchBlockedReasons({
        windowMinutes: BLOCKED_WINDOW_M,
        signal:        ctrl.signal,
      });
      if (!mounted) return;
      if (result.ok) setBlocked(result.data);
    };
    pull();
    const id = setInterval(pull, BLOCKED_POLL_MS);
    return () => { mounted = false; clearInterval(id); ctrl?.abort(); };
  }, []);

  // 1Hz render tick — drives the "Ns AGO" / "STALLED Nm" age chip
  // without forcing a refetch.
  useEffect(() => {
    const id = setInterval(() => setNowTick(n => n + 1), RENDER_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const lastBucket = rate?.buckets?.[0];
  const ageSec     = lastBucket
    ? Math.floor((Date.now() - new Date(lastBucket.bucket).getTime()) / 1000)
    : null;
  const isStalled  = ageSec !== null && ageSec > STALLED_THRESHOLD_S;
  const isAlive    = ageSec !== null && ageSec <= STALLED_THRESHOLD_S;

  return (
    <section
      className="nx-panel"
      aria-label="System Health"
      data-testid="system-health-panel"
      style={PANEL}
    >
      <header className="nx-panel__head">
        <div className="nx-panel__title">
          <span
            className={'nx-dot ' + (
              isStalled ? 'nx-dot--amber' :
              isAlive   ? 'nx-dot--lime nx-dot--pulse' :
                          'nx-dot--cyan'
            )}
          />
          <span>SYSTEM · {
            isStalled ? 'STALLED' : isAlive ? 'ALIVE' : 'PENDING'
          }</span>
        </div>
        <span style={agePill(isStalled)}>{formatAge(ageSec)}</span>
      </header>

      <div style={STRIP}>
        <div style={CHIP_GROUP}>
          <span style={CHIP_LABEL}>DEC/MIN</span>
          <span style={CHIP_VALUE_LIME}>{lastBucket?.n_total ?? '—'}</span>
        </div>
        <div style={CHIP_GROUP}>
          <span style={CHIP_LABEL}>NOOP</span>
          <span style={CHIP_VALUE}>{lastBucket?.n_noop ?? 0}</span>
        </div>
        <div style={CHIP_GROUP}>
          <span style={CHIP_LABEL}>BLK</span>
          <span style={lastBucket && lastBucket.n_blocked > 0 ? CHIP_VALUE_AMBER : CHIP_VALUE}>
            {lastBucket?.n_blocked ?? 0}
          </span>
        </div>
        <div style={CHIP_GROUP}>
          <span style={CHIP_LABEL}>FILL</span>
          <span style={lastBucket && lastBucket.n_live > 0 ? CHIP_VALUE_LIME : CHIP_VALUE}>
            {lastBucket?.n_live ?? 0}
          </span>
        </div>
      </div>

      {rate && rate.buckets.length > 0 && (
        <DecisionRateSparkline buckets={rate.buckets} window={DECISIONS_WINDOW_M} />
      )}

      {blocked && blocked.total_blocked > 0 && (
        <BlockedBreakdown data={blocked} />
      )}
    </section>
  );
}

// ── Decisions/min sparkline ───────────────────────────────────────────

interface SparkProps {
  buckets: ReadonlyArray<DecisionBucket>;
  window:  number;
}

function DecisionRateSparkline({ buckets, window: windowMinutes }: SparkProps) {
  // API returns newest-first; reverse so the chart reads
  // oldest → newest left-to-right.
  const ordered = [...buckets].reverse();
  const W = 240;
  const H = 26;
  const slice = ordered.length > 1 ? W / (ordered.length - 1) : W;
  const barW  = Math.max(1, slice - 0.4);
  const maxN  = ordered.reduce((m, b) => Math.max(m, b.n_total), 0) || 1;

  return (
    <div style={SECTION}>
      <div style={SECTION_HEAD}>
        <span className="nx-label">RATE · {windowMinutes}M</span>
        <span className="nx-mono-dim" style={{ fontSize: 9 }}>
          MAX {maxN}/MIN
        </span>
      </div>
      <svg
        width="100%"
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ display: 'block' }}
      >
        {ordered.map((b, i) => {
          const x = i * slice;
          const h = Math.max(0.5, (b.n_total / maxN) * H);
          const y = H - h;
          // Color: lime if any live fill, amber if any blocked, cyan otherwise.
          const fill = b.n_live    > 0 ? '#DEFF9A'
                     : b.n_blocked > 0 ? '#FFB200'
                     :                    '#00BFFF';
          return (
            <rect
              key={`r-${i}`}
              x={x}
              y={y}
              width={barW}
              height={h}
              fill={fill}
              opacity={0.85}
            />
          );
        })}
      </svg>
    </div>
  );
}

// ── Blocked-reason breakdown ──────────────────────────────────────────

function BlockedBreakdown({ data }: { data: BlockedReasonsDTO }) {
  const maxN = data.reasons.reduce((m, r) => Math.max(m, r.n_blocked), 0) || 1;
  return (
    <div style={SECTION}>
      <div style={SECTION_HEAD}>
        <span className="nx-label">BLOCKED · {data.window_minutes}M</span>
        <span className="nx-mono-dim" style={{ fontSize: 9 }}>
          TOTAL {data.total_blocked}
        </span>
      </div>
      <ul style={REASON_LIST} data-testid="blocked-reasons">
        {data.reasons.map(r => {
          const pct = (r.n_blocked / maxN) * 100;
          return (
            <li key={r.guard_id} style={REASON_ROW}>
              <span style={REASON_LABEL}>{r.guard_id}</span>
              <div style={REASON_TRACK}>
                <div style={{
                  ...REASON_BAR,
                  width: `${Math.max(2, pct)}%`,
                }} />
              </div>
              <span style={REASON_COUNT}>{r.n_blocked}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ── helpers / styles ───────────────────────────────────────────────────

function formatAge(s: number | null): string {
  if (s === null) return '—';
  if (s < 2)    return 'JUST NOW';
  if (s < 60)   return `${s}s AGO`;
  const m = Math.floor(s / 60);
  if (m < 60)   return `${m}m AGO`;
  return `${Math.floor(m / 60)}h AGO`;
}

function agePill(stalled: boolean): React.CSSProperties {
  return {
    color:         stalled ? '#FFB200' : '#8A93A8',
    fontSize:      9,
    letterSpacing: '0.08em',
    fontFamily:    '"JetBrains Mono", ui-monospace, monospace',
  };
}

const PANEL: React.CSSProperties = {
  marginTop: 8,
};

const STRIP: React.CSSProperties = {
  display:       'grid',
  gridTemplateColumns: 'repeat(4, 1fr)',
  gap:           8,
  padding:       '6px 12px 4px',
};

const CHIP_GROUP: React.CSSProperties = {
  display:       'flex',
  flexDirection: 'column',
  alignItems:    'center',
  justifyContent: 'center',
  gap:           1,
  fontFamily:    '"JetBrains Mono", ui-monospace, monospace',
};

const CHIP_LABEL: React.CSSProperties = {
  color:         '#4A5066',
  fontSize:      8,
  letterSpacing: '0.10em',
};

const CHIP_VALUE: React.CSSProperties = {
  color:         '#E8ECF5',
  fontSize:      14,
  fontVariantNumeric: 'tabular-nums',
};

const CHIP_VALUE_LIME: React.CSSProperties = {
  ...CHIP_VALUE,
  color: '#DEFF9A',
};

const CHIP_VALUE_AMBER: React.CSSProperties = {
  ...CHIP_VALUE,
  color: '#FFB200',
};

const SECTION: React.CSSProperties = {
  padding: '6px 12px',
};

const SECTION_HEAD: React.CSSProperties = {
  display:        'flex',
  justifyContent: 'space-between',
  alignItems:     'center',
  marginBottom:   4,
};

const REASON_LIST: React.CSSProperties = {
  listStyle: 'none',
  margin:    0,
  padding:   0,
  display:   'flex',
  flexDirection: 'column',
  gap:       2,
};

const REASON_ROW: React.CSSProperties = {
  display:       'grid',
  gridTemplateColumns: '88px 1fr auto',
  alignItems:    'center',
  gap:           6,
  fontFamily:    '"JetBrains Mono", ui-monospace, monospace',
  fontSize:      9,
};

const REASON_LABEL: React.CSSProperties = {
  color:         '#FFB200',
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  whiteSpace:    'nowrap',
  overflow:      'hidden',
  textOverflow:  'ellipsis',
};

const REASON_TRACK: React.CSSProperties = {
  height:       4,
  background:   'rgba(255, 178, 0, 0.10)',
  borderRadius: 2,
  overflow:     'hidden',
};

const REASON_BAR: React.CSSProperties = {
  height:     '100%',
  background: 'linear-gradient(90deg, rgba(255, 178, 0, 0.6) 0%, rgba(255, 178, 0, 0.9) 100%)',
  transition: 'width 400ms ease-out',
};

const REASON_COUNT: React.CSSProperties = {
  color:         '#E8ECF5',
  fontVariantNumeric: 'tabular-nums',
  fontSize:      9,
  minWidth:      24,
  textAlign:     'right',
};
