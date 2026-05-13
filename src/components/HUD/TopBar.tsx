// TopBar — global system bar with brand, nav tabs, live API telemetry,
// SSO session indicator, T+ counter and operator ID.

import { useEffect, useState } from 'react';
import { NEXUS_COLOR, withAlpha } from '../../styles/colors';
import type { ApiTelemetry, SsoSession } from '../../types/nexus';
import type { ConnectionState } from '../../types/streamer';
import { useLanguage, type Language } from '../../utils/i18n';
import { getOperatorIdentity } from '../../utils/operator';

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

/** Sprint 5s+ toolbar: the 4 nav tabs are no longer cosmetic. Each one
 *  swaps the main surface (canvas vs an overlay panel) so the operator
 *  can flip between ontology drilldown / snapshot history / anomaly
 *  watchlist / command palette without leaving the dashboard. The
 *  active tab is controlled state owned by App.tsx — this keeps the
 *  overlay rendering colocated with the rest of the focus state
 *  (selectedId, isolatedId, etc.) and avoids a duplicate router. */
export type TopBarTab = 'ontology' | 'snapshots' | 'investigations' | 'actions' | 'assistant';

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
  /** Active toolbar tab. Defaults to 'ontology' (the canvas view) when
   *  the parent doesn't pass one. */
  activeTab?: TopBarTab;
  /** Fired when an operator clicks a tab. Parent flips activeTab in
   *  response; the active class re-applies on the next render. */
  onTabChange?: (tab: TopBarTab) => void;
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

// Sprint 5s+ iter 10: pill labels moved out to i18n keys. Visual spec
// (tone + motion) stays here since those don't translate.
const STATE_SPEC: Record<ConnectionState, { i18nKey: string; tone: StatusPillSpec['tone']; motion: StatusPillSpec['motion'] }> = {
  connected:      { i18nKey: 'top.conn.live',   tone: 'cyan',   motion: 'pulse' },
  authenticating: { i18nKey: 'top.conn.auth',   tone: 'amber',  motion: 'blink' },
  connecting:     { i18nKey: 'top.conn.link',   tone: 'amber',  motion: 'blink' },
  reconnecting:   { i18nKey: 'top.conn.retry',  tone: 'purple', motion: 'blink' },
  failed:         { i18nKey: 'top.conn.failed', tone: 'amber',  motion: 'none'  },
  disconnected:   { i18nKey: 'top.conn.off',    tone: 'low',    motion: 'none'  },
  // Replay = operator-induced freeze. Amber communicates "out of real-time"
  // without the urgency of failed; the slow blink reads as "paused, waiting".
  replay:         { i18nKey: 'top.conn.replay', tone: 'amber',  motion: 'blink' },
};

interface StatusPillProps { state: ConnectionState }

function StatusPill({ state }: StatusPillProps) {
  const { t } = useLanguage();
  const spec = STATE_SPEC[state];
  const label = t(spec.i18nKey);
  return (
    <div
      className={`nx-conn-pill nx-conn-pill--${spec.tone}`}
      title={t('top.conn.title', { state })}
      aria-label={t('top.conn.title', { state })}
    >
      <span className={`nx-conn-pill__dot nx-conn-pill__dot--${spec.motion}`} />
      <span className="nx-conn-pill__txt">{label}</span>
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
  const { t } = useLanguage();
  // 'remote' = network-fed data from nexus-backend → cyan (matches LIVE pill).
  // 'local'  = synthetic / mock / offline adapter → low/grey (no glow).
  const tone = kind === 'remote' ? 'cyan' : 'low';
  const suffix = kind === 'remote'
    ? t('top.source.suffixRemote')
    : t('top.source.suffixLocal');
  return (
    <div
      className={`nx-source-pill nx-source-pill--${tone}`}
      title={t('top.source.title', { label, suffix })}
      aria-label={t('top.source.title', { label, suffix: '' })}
    >
      <span className="nx-source-pill__prefix">{t('top.source.prefix')}</span>
      <span className="nx-source-pill__txt">{label}</span>
    </div>
  );
}

/** Stable tab definitions. Order matches the toolbar L→R. Labels come
 *  from i18n at render time (see `useTabLabels`). The glyph prefix
 *  (▾ / ◇ / ≡ / ⌘ / ▣) is part of the i18n value so swapping language
 *  doesn't lose the cyberpunk badge. */
const TAB_IDS: ReadonlyArray<TopBarTab> = [
  'ontology', 'snapshots', 'investigations', 'actions', 'assistant',
];

export function TopBar({
  telemetry, sso, connectionState = 'connected', operator,
  sourceLabel, sourceKind, activeTab = 'ontology', onTabChange,
}: TopBarProps) {
  // Sprint 5s+ loop iteration: pull the operator label from env via
  // a shared helper so the two displays (TopBar + CommandCenter footer)
  // stay in lockstep — was previously duplicated as a literal in
  // CommandCenter and a prop default here.
  const resolvedOperator = operator ?? getOperatorIdentity().topbar;
  const { lang, setLang, t } = useLanguage();
  // Renamed from `t` to `secs` to avoid collision with i18n's `t(...)`.
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setSecs(prev => prev + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const fmt = (n: number) => String(n).padStart(2, '0');
  const time = `T+${fmt(Math.floor(secs / 3600))}:${fmt(Math.floor(secs / 60) % 60)}:${fmt(secs % 60)}`;

  return (
    <header className="nx-top">
      <div className="nx-top__brand">
        {/* Sprint 5s+ loop iter 7: brand SVG strokes/fill route through
            NEXUS_COLOR.cyan instead of the literal '#00BFFF' so the
            brand mark recolors when the canonical palette is tweaked.
            Was 3 inline hex literals — last visible SVG hex in the app. */}
        <svg width="22" height="22" viewBox="0 0 64 64" fill="none">
          <path d="M32 6 L54 19 L54 45 L32 58 L10 45 L10 19 Z" stroke={NEXUS_COLOR.cyan} strokeWidth="1.5" />
          <path d="M32 18 L44 25 L44 39 L32 46 L20 39 L20 25 Z" stroke={NEXUS_COLOR.cyan} strokeWidth="1" opacity="0.55" />
          <circle cx="32" cy="32" r="3" fill={NEXUS_COLOR.cyan} />
        </svg>
        <div className="nx-top__name">
          <div className="nx-top__nx">NEXUS</div>
          <div className="nx-top__sub">{t('top.subtitle', { version: '4.20' })}</div>
        </div>
      </div>

      <nav className="nx-top__nav">
        {TAB_IDS.map(id => (
          <button
            key={id}
            type="button"
            data-testid={`top-tab-${id}`}
            className={`nx-tab${id === activeTab ? ' nx-tab--active' : ''}`}
            onClick={() => onTabChange?.(id)}
            aria-pressed={id === activeTab}
          >
            {t(`top.tab.${id}`)}
          </button>
        ))}
      </nav>

      <div className="nx-top__status">
        {/* Sprint 5s+ iter 10: language toggle */}
        <LangToggle lang={lang} setLang={setLang} t={t} />
        {/* Live API connection panel */}
        <StatusPill state={connectionState} />
        {sourceLabel && (
          <SourcePill label={sourceLabel} kind={sourceKind ?? 'local'} />
        )}
        <div className="nx-api">
          <div className="nx-api__head">
            <span className="nx-dot nx-dot--cyan nx-dot--pulse"></span>
            <span className="nx-mono-dim" style={{ fontSize: 9, letterSpacing: '0.10em' }}>
              {t('top.api', { feed: telemetry.feed })}
            </span>
          </div>
          <div className="nx-api__sep"></div>
          <div className="nx-api__body">
            <Sparkline values={telemetry.pkts} />
            <div className="nx-api__metrics">
              <span className="nx-mono" style={{ fontSize: 9, color: 'var(--cyan)' }}>
                {t('top.api.pktsPerSec', { rate: telemetry.pktRate })}
              </span>
              <span className="nx-mono-dim" style={{ fontSize: 9 }}>
                {t('top.api.latency', { latency: telemetry.latencyMs.toFixed(0) })}
              </span>
            </div>
          </div>
        </div>

        {/* SSO authentication telemetry */}
        <div
          className="nx-sso"
          title={t('top.sso.title', { protocol: sso.protocol, expires: sso.expiresIn })}
        >
          <svg width="11" height="12" viewBox="0 0 11 12" fill="none" aria-hidden="true">
            <path d="M2.5 5.5 V3.5 a3 3 0 0 1 6 0 V5.5" stroke="currentColor" strokeWidth="1" fill="none" />
            <rect x="1.5" y="5.5" width="8" height="6" stroke="currentColor" strokeWidth="1" fill="none" />
            <circle cx="5.5" cy="8.3" r="0.8" fill="currentColor" />
          </svg>
          <span className="nx-sso__txt">{t(sso.verified ? 'top.sso.verified' : 'top.sso.invalid')}</span>
        </div>

        <div className="nx-mono" style={{ fontSize: 11, color: 'var(--cyan)' }}>{time}</div>
        <div className="nx-mono-dim" style={{ fontSize: 10 }}>{resolvedOperator}</div>
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------ */
/*  LangToggle — Sprint 5s+ iter 10 EN/한 switcher                     */
/* ------------------------------------------------------------------ */
//
// Compact two-button pill that lives in the TopBar status row. Active
// language gets cyan border + bright cyan text; inactive renders dim
// ash. The toggle persists to localStorage and broadcasts a custom
// event so every other useLanguage consumer in the tab re-renders
// instantly (no full reload needed).

interface LangToggleProps {
  lang: Language;
  setLang: (lang: Language) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

function LangToggle({ lang, setLang, t: translate }: LangToggleProps) {
  return (
    <div
      role="group"
      aria-label={translate('top.lang.toggleLabel')}
      style={{
        display:      'flex',
        gap:          0,
        border:       `0.6px solid ${withAlpha(NEXUS_COLOR.cyan, 0.30)}`,
        borderRadius: 2,
        overflow:     'hidden',
        fontFamily:   '"JetBrains Mono", ui-monospace, monospace',
      }}
    >
      {(['en', 'ko'] as ReadonlyArray<Language>).map(L => {
        const active = lang === L;
        return (
          <button
            key={L}
            type="button"
            data-testid={`lang-${L}`}
            aria-pressed={active}
            onClick={() => setLang(L)}
            style={{
              background:    active ? withAlpha(NEXUS_COLOR.cyan, 0.18) : 'transparent',
              color:         active ? NEXUS_COLOR.cyan : NEXUS_COLOR.ash,
              border:        'none',
              padding:       '2px 8px',
              fontSize:      9,
              letterSpacing: '0.10em',
              cursor:        'pointer',
              fontFamily:    'inherit',
              fontWeight:    active ? 600 : 400,
            }}
            title={L === 'en' ? 'English' : '한국어'}
          >
            {L === 'en' ? 'EN' : '한'}
          </button>
        );
      })}
    </div>
  );
}
