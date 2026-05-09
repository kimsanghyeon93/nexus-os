// TopBar — global system bar with brand, nav tabs, live API telemetry,
// SSO session indicator, T+ counter and operator ID.

import { useEffect, useState } from 'react';
import type { ApiTelemetry, SsoSession } from '../../types/nexus';
import type { ConnectionState } from '../../types/streamer';

interface SparklineProps {
  values: number[];
  color?: string;
  w?: number;
  h?: number;
}

function Sparkline({ values, color = '#00BFFF', w = 56, h = 14 }: SparklineProps) {
  if (!values.length) return null;
  const max = Math.max(...values, 1);
  const pts = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = h - (v / max) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth="1"
        opacity="0.85"
        style={{ filter: `drop-shadow(0 0 3px ${color})` }}
      />
    </svg>
  );
}

interface TopBarProps {
  telemetry: ApiTelemetry;
  sso: SsoSession;
  connectionState?: ConnectionState;
  operator?: string;
  /** Human-readable source label rendered as a small badge next to the
   *  connection pill (e.g. 'BACKEND · LIVE', 'SYNTHETIC'). Omit to hide. */
  sourceLabel?: string;
  /** Origin classification. 'remote' renders cyan (data from nexus-backend),
   *  'local' renders grey (synthetic / mock / offline adapter). */
  sourceKind?: 'remote' | 'local';
}

/* ------------------------------------------------------------------ */
/*  Status Pill — transport connection state                           */
/* ------------------------------------------------------------------ */

interface StatusPillSpec {
  label: string;
  /** Strict tone — lime is reserved for market anomaly only, never errors. */
  tone: 'cyan' | 'amber' | 'purple' | 'low';
  /** 'pulse' = slow heartbeat; 'blink' = fast attention. */
  motion: 'pulse' | 'blink' | 'none';
}

const STATE_VISUALS: Record<ConnectionState, StatusPillSpec> = {
  connected:      { label: 'LIVE',   tone: 'cyan',   motion: 'pulse' },
  authenticating:{ label: 'AUTH',   tone: 'amber',  motion: 'blink' },
  connecting:     { label: 'LINK',   tone: 'amber',  motion: 'blink' },
  reconnecting:   { label: 'RETRY',  tone: 'purple', motion: 'blink' },
  failed:         { label: 'FAILED', tone: 'amber',  motion: 'none'  },
  disconnected:   { label: 'OFF',    tone: 'low',    motion: 'none'  },
  // Replay = operator-induced freeze. Amber communicates "out of real-time"
  // without the urgency of failed; the slow blink reads as "paused, waiting".
  replay:         { label: 'REPLAY', tone: 'amber',  motion: 'blink' },
};

interface StatusPillProps { state: ConnectionState }

function StatusPill({ state }: StatusPillProps) {
  const spec = STATE_VISUALS[state];
  return (
    <div
      className={`nx-conn-pill nx-conn-pill--${spec.tone}`}
      title={`Transport: ${state}`}
      aria-label={`Connection state: ${state}`}
    >
      <span className={`nx-conn-pill__dot nx-conn-pill__dot--${spec.motion}`} />
      <span className="nx-conn-pill__txt">{spec.label}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Source Pill — origin badge (BACKEND · LIVE vs SYNTHETIC etc.)      */
/* ------------------------------------------------------------------ */

interface SourcePillProps {
  label: string;
  kind: 'remote' | 'local';
}

function SourcePill({ label, kind }: SourcePillProps) {
  // 'remote' = network-fed data from nexus-backend → cyan (matches LIVE pill).
  // 'local'  = synthetic / mock / offline adapter → low/grey (no glow).
  const tone = kind === 'remote' ? 'cyan' : 'low';
  return (
    <div
      className={`nx-source-pill nx-source-pill--${tone}`}
      title={`Data source: ${label}${kind === 'remote' ? ' (nexus-backend WebSocket)' : ' (in-process)'}`}
      aria-label={`Data source: ${label}`}
    >
      <span className="nx-source-pill__prefix">SRC</span>
      <span className="nx-source-pill__txt">{label}</span>
    </div>
  );
}


export function TopBar({
  telemetry, sso, connectionState = 'connected', operator = 'OP · J.VANCE',
  sourceLabel, sourceKind,
}: TopBarProps) {
  const [t, setT] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setT(prev => prev + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const fmt = (n: number) => String(n).padStart(2, '0');
  const time = `T+${fmt(Math.floor(t / 3600))}:${fmt(Math.floor(t / 60) % 60)}:${fmt(t % 60)}`;

  return (
    <header className="nx-top">
      <div className="nx-top__brand">
        <svg width="22" height="22" viewBox="0 0 64 64" fill="none">
          <path d="M32 6 L54 19 L54 45 L32 58 L10 45 L10 19 Z" stroke="#00BFFF" strokeWidth="1.5" />
          <path d="M32 18 L44 25 L44 39 L32 46 L20 39 L20 25 Z" stroke="#00BFFF" strokeWidth="1" opacity="0.55" />
          <circle cx="32" cy="32" r="3" fill="#00BFFF" />
        </svg>
        <div className="nx-top__name">
          <div className="nx-top__nx">NEXUS</div>
          <div className="nx-top__sub">ONTOLOGY OS · v4.20</div>
        </div>
      </div>

      <nav className="nx-top__nav">
        <button className="nx-tab nx-tab--active">▾ ONTOLOGY</button>
        <button className="nx-tab">◇ SNAPSHOTS</button>
        <button className="nx-tab">≡ INVESTIGATIONS</button>
        <button className="nx-tab">⌘ ACTIONS</button>
      </nav>

      <div className="nx-top__status">
        {/* Live API connection panel */}
        <StatusPill state={connectionState} />
        {sourceLabel && (
          <SourcePill label={sourceLabel} kind={sourceKind ?? 'local'} />
        )}
        <div className="nx-api">
          <div className="nx-api__head">
            <span className="nx-dot nx-dot--cyan nx-dot--pulse"></span>
            <span className="nx-mono-dim" style={{ fontSize: 9, letterSpacing: '0.10em' }}>
              API · {telemetry.feed}
            </span>
          </div>
          <div className="nx-api__sep"></div>
          <div className="nx-api__body">
            <Sparkline values={telemetry.pkts} />
            <div className="nx-api__metrics">
              <span className="nx-mono" style={{ fontSize: 9, color: 'var(--cyan)' }}>
                {telemetry.pktRate} pkt/s
              </span>
              <span className="nx-mono-dim" style={{ fontSize: 9 }}>
                {telemetry.latencyMs.toFixed(0)}ms
              </span>
            </div>
          </div>
        </div>

        {/* SSO authentication telemetry */}
        <div
          className="nx-sso"
          title={`${sso.protocol} · Session active · expires ${sso.expiresIn}`}
        >
          <svg width="11" height="12" viewBox="0 0 11 12" fill="none" aria-hidden="true">
            <path d="M2.5 5.5 V3.5 a3 3 0 0 1 6 0 V5.5" stroke="currentColor" strokeWidth="1" fill="none" />
            <rect x="1.5" y="5.5" width="8" height="6" stroke="currentColor" strokeWidth="1" fill="none" />
            <circle cx="5.5" cy="8.3" r="0.8" fill="currentColor" />
          </svg>
          <span className="nx-sso__txt">SSO · {sso.verified ? 'VERIFIED' : 'INVALID'}</span>
        </div>

        <div className="nx-mono" style={{ fontSize: 11, color: 'var(--cyan)' }}>{time}</div>
        <div className="nx-mono-dim" style={{ fontSize: 10 }}>{operator}</div>
      </div>
    </header>
  );
}
