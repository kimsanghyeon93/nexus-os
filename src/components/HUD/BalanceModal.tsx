// BalanceModal — KIS Balance Panel (Task 7).
//
// Displays account balance summary and holdings detail.
// The parent (TopBar) owns `useBalance` — polling continues even when
// this modal is closed. Props receive data/loading/error/refresh/lastUpdated
// directly so the 30s background poll is never interrupted by open/close cycles.
//
// Four UI states (one component):
//   loading (data === null)  — spinner + "ACQUIRING BALANCE —"
//   error (error !== null)   — error message
//   empty (holdings === [])  — summary cards + "NO POSITIONS HELD"
//   normal                   — summary cards + holdings table
//
// Visual language matches AuditModal: cyan-bordered glass frame, JetBrains
// Mono, inline styles only (no nexus.css edits).

import { useEffect, useRef, useState } from 'react';

import { NEXUS_COLOR, NEXUS_SURFACE, withAlpha } from '../../styles/colors';
import { FONT_MONO } from '../../styles/fonts';
import type { BalanceDTO, HoldingDTO } from '../../types/api';

// Alias for terse inline-style references.
const COLOR = NEXUS_COLOR;

// ── Props ─────────────────────────────────────────────────────────────

export interface BalanceModalProps {
  open:        boolean;
  onClose:     () => void;
  data:        BalanceDTO | null;
  loading:     boolean;
  error:       string | null;
  refresh:     () => void;
  lastUpdated: Date | null;
}

// ── Root ──────────────────────────────────────────────────────────────

export function BalanceModal({
  open,
  onClose,
  data,
  loading,
  error,
  refresh,
  lastUpdated,
}: BalanceModalProps) {
  // Don't mount DOM when closed — keeps the component tree clean.
  if (!open) return null;

  return (
    <BalanceModalInner
      onClose={onClose}
      data={data}
      loading={loading}
      error={error}
      refresh={refresh}
      lastUpdated={lastUpdated}
    />
  );
}

// ── Inner (always mounted when open) ─────────────────────────────────

interface BalanceModalInnerProps {
  onClose:     () => void;
  data:        BalanceDTO | null;
  loading:     boolean;
  error:       string | null;
  refresh:     () => void;
  lastUpdated: Date | null;
}

function BalanceModalInner({
  onClose,
  data,
  loading,
  error,
  refresh,
  lastUpdated,
}: BalanceModalInnerProps) {
  // ESC key handler — capture phase beats anything else.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const holdings = data?.holdings ?? [];
  const summary  = data?.summary ?? null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="nx-balance-title"
      data-testid="balance-modal"
      onClick={onClose}
      style={BACKDROP}
    >
      <div onClick={e => e.stopPropagation()} style={FRAME}>
        {/* Corner glyphs — visual chrome matching AuditModal */}
        <div style={CORNER_TL} aria-hidden>┌</div>
        <div style={CORNER_TR} aria-hidden>┐</div>
        <div style={CORNER_BL} aria-hidden>└</div>
        <div style={CORNER_BR} aria-hidden>┘</div>

        <header style={HEADER}>
          <div>
            <div id="nx-balance-title" style={TITLE}>
              <span style={STATUS_DOT} aria-hidden>●</span>
              ACCOUNT BALANCE
            </div>
            <div style={SUBTITLE}>
              {data !== null
                ? `KIS · ${new Date(data.ts).toLocaleString('ko-KR')}`
                : 'AWAITING DATA'}
            </div>
          </div>
          <div style={HEADER_CONTROLS}>
            <button
              type="button"
              data-testid="balance-modal-refresh"
              onClick={refresh}
              aria-label="Refresh balance"
              title="Refresh balance data"
              style={REFRESH_BTN}
            >
              ↺
            </button>
            <button
              type="button"
              data-testid="balance-modal-close"
              onClick={onClose}
              aria-label="Close balance panel"
              style={CLOSE_BTN}
            >
              ×
            </button>
          </div>
        </header>

        <div style={BODY}>
          {/* Branch 1: loading, no data yet */}
          {loading && data === null && <LoadingState />}

          {/* Branch 2: error */}
          {error !== null && (
            <ErrorState error={error} onRetry={refresh} />
          )}

          {/* Branch 3 + 4: data available */}
          {data !== null && error === null && (
            <>
              {/* Summary row */}
              {summary !== null && (
                <div style={SUMMARY_ROW} data-testid="balance-summary">
                  <SummaryCard
                    label="예수금"
                    value={summary.cash}
                    unit="KRW"
                  />
                  <SummaryCard
                    label="총평가금액"
                    value={summary.eval_total}
                    unit="KRW"
                  />
                  <SummaryCard
                    label="총손익"
                    value={summary.profit_loss}
                    pct={summary.profit_loss_pct}
                    unit="KRW"
                    colored
                  />
                </div>
              )}

              {/* Divider + holdings header */}
              <div style={SECTION_HEADER}>
                <span>HOLDINGS</span>
                {loading && (
                  <span style={REFRESHING_HINT} aria-hidden> ● REFRESHING</span>
                )}
              </div>

              {/* Branch 3: no positions */}
              {holdings.length === 0 && (
                <EmptyHoldingsState />
              )}

              {/* Branch 4: holdings table */}
              {holdings.length > 0 && (
                <HoldingsTable holdings={holdings} />
              )}
            </>
          )}
        </div>

        <footer style={FOOTER}>
          <ElapsedLabel lastUpdated={lastUpdated} />
          {lastUpdated === null && (
            <span>[ ESC OR CLICK OUTSIDE TO CLOSE · 30S AUTO-REFRESH ]</span>
          )}
        </footer>
      </div>
    </div>
  );
}

// ── State branches ────────────────────────────────────────────────────

function LoadingState() {
  return (
    <div data-testid="balance-loading" style={CENTER_PANEL}>
      <div style={SPINNER} aria-hidden />
      <div style={STATUS_LINE}>ACQUIRING BALANCE —</div>
      <AnimatedDots />
    </div>
  );
}

/** Animated "..." that cycles 1 → 2 → 3 dots */
function AnimatedDots() {
  const [count, setCount] = useState(1);
  useEffect(() => {
    const id = setInterval(() => setCount(n => (n % 3) + 1), 400);
    return () => clearInterval(id);
  }, []);
  return (
    <div style={{ ...STATUS_HINT, letterSpacing: '0.18em' }} aria-hidden>
      {'·'.repeat(count)}
    </div>
  );
}

function ErrorState({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div data-testid="balance-error" style={CENTER_PANEL}>
      <div style={ERR_ICON} aria-hidden>◆</div>
      <div style={STATUS_LINE_AMBER}>BALANCE UNAVAILABLE — {error}</div>
      <button
        type="button"
        onClick={onRetry}
        data-testid="balance-retry"
        style={RETRY_BTN}
      >
        ▸ RETRY
      </button>
    </div>
  );
}

function EmptyHoldingsState() {
  return (
    <div data-testid="balance-empty" style={EMPTY_HOLDINGS}>
      <span style={EMPTY_GLYPH} aria-hidden>○</span>
      <span style={STATUS_HINT}>NO POSITIONS HELD</span>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────

interface SummaryCardProps {
  label:   string;
  value:   number;
  pct?:    number;
  unit?:   string;
  /** If true, value is colored by profit/loss sign */
  colored?: boolean;
}

function SummaryCard({ label, value, pct, colored }: SummaryCardProps) {
  const valueColor = colored
    ? value > 0 ? COLOR.lime
    : value < 0 ? COLOR.amber
    : COLOR.ash
    : COLOR.bone;

  const formattedValue = formatKrw(value, colored);
  const formattedPct   = pct !== undefined ? formatPct(pct) : null;
  const pctColor       = pct !== undefined
    ? pct > 0 ? COLOR.lime
    : pct < 0 ? COLOR.amber
    : COLOR.ash
    : COLOR.ash;

  return (
    <div style={SUMMARY_CARD} data-testid="summary-card">
      <div style={CARD_LABEL}>{label}</div>
      <div style={{ ...CARD_VALUE, color: valueColor }}>{formattedValue}</div>
      {formattedPct !== null && (
        <div style={{ ...CARD_PCT, color: pctColor }}>{formattedPct}</div>
      )}
    </div>
  );
}

function HoldingsTable({ holdings }: { holdings: HoldingDTO[] }) {
  return (
    <div data-testid="holdings-table" style={TABLE_WRAP}>
      <table style={TABLE}>
        <thead>
          <tr style={TABLE_HEAD_ROW}>
            <th style={TH}>코드</th>
            <th style={TH}>종목명</th>
            <th style={{ ...TH, textAlign: 'right' }}>수량</th>
            <th style={{ ...TH, textAlign: 'right' }}>평균단가</th>
            <th style={{ ...TH, textAlign: 'right' }}>손익%</th>
          </tr>
        </thead>
        <tbody>
          {holdings.map(h => (
            <HoldingRow key={h.symbol} holding={h} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HoldingRow({ holding: h }: { holding: HoldingDTO }) {
  const pctColor = h.profit_loss_pct > 0 ? COLOR.lime
                 : h.profit_loss_pct < 0 ? COLOR.amber
                 : COLOR.ash;

  return (
    <tr style={TR} data-testid="holding-row">
      <td style={{ ...TD, ...TD_CODE }}>{h.symbol}</td>
      <td style={TD}>{h.name}</td>
      <td style={{ ...TD, textAlign: 'right' }}>
        {h.quantity.toLocaleString('ko-KR')}
      </td>
      <td style={{ ...TD, textAlign: 'right' }}>
        {h.avg_price.toLocaleString('ko-KR')}
      </td>
      <td style={{ ...TD, textAlign: 'right', color: pctColor, fontWeight: 500 }}>
        {formatPct(h.profit_loss_pct)}
      </td>
    </tr>
  );
}

interface ElapsedLabelProps {
  lastUpdated: Date | null;
}

function ElapsedLabel({ lastUpdated }: ElapsedLabelProps) {
  // Tick every second so the elapsed time updates live.
  const [, setTick] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    intervalRef.current = setInterval(() => setTick(n => n + 1), 1000);
    return () => {
      if (intervalRef.current !== null) clearInterval(intervalRef.current);
    };
  }, []);

  if (lastUpdated === null) return null;

  const elapsed = Math.max(0, Math.floor((Date.now() - lastUpdated.getTime()) / 1000));
  return (
    <span data-testid="elapsed-label">
      [ ESC OR CLICK OUTSIDE TO CLOSE · 갱신: {elapsed}초 전 · 30초마다 자동 갱신 ]
    </span>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────

/** Format an integer KRW value with sign prefix when colored. */
function formatKrw(value: number, withSign = false): string {
  const abs = Math.abs(value).toLocaleString('ko-KR');
  if (!withSign) return abs;
  if (value > 0) return `+${abs}`;
  if (value < 0) return `-${abs}`;
  return abs;
}

/** Format a profit/loss percentage: +2.43% / -1.20% */
function formatPct(pct: number): string {
  const abs = Math.abs(pct).toFixed(2);
  if (pct > 0) return `+${abs}%`;
  if (pct < 0) return `-${abs}%`;
  return `${abs}%`;
}

// ── Style tokens ──────────────────────────────────────────────────────
// Inline styles — the modal carries its own theme, no nexus.css edits.

const BACKDROP: React.CSSProperties = {
  position:             'fixed',
  inset:                0,
  background:           NEXUS_SURFACE.backdrop,
  backdropFilter:       'blur(18px)',
  WebkitBackdropFilter: 'blur(18px)',
  zIndex:               1400,
  display:              'flex',
  alignItems:           'center',
  justifyContent:       'center',
  padding:              '32px',
};

const FRAME: React.CSSProperties = {
  position:      'relative',
  width:         '100%',
  maxWidth:      '760px',
  maxHeight:     '80vh',
  display:       'flex',
  flexDirection: 'column',
  background:    NEXUS_SURFACE.panel,
  border:        `1px solid ${withAlpha(COLOR.cyan, 0.55)}`,
  boxShadow:     `0 0 24px ${withAlpha(COLOR.cyan, 0.18)}`,
  fontFamily:    FONT_MONO,
  color:         COLOR.bone,
  borderRadius:  4,
};

const CORNER_BASE: React.CSSProperties = {
  position:    'absolute',
  width:       12,
  height:      12,
  color:       COLOR.cyan,
  fontSize:    14,
  lineHeight:  '12px',
  pointerEvents: 'none',
};
const CORNER_TL: React.CSSProperties = { ...CORNER_BASE, top: -1, left: -1 };
const CORNER_TR: React.CSSProperties = { ...CORNER_BASE, top: -1, right: -1 };
const CORNER_BL: React.CSSProperties = { ...CORNER_BASE, bottom: -1, left: -1 };
const CORNER_BR: React.CSSProperties = { ...CORNER_BASE, bottom: -1, right: -1 };

const HEADER: React.CSSProperties = {
  display:        'flex',
  alignItems:     'flex-start',
  justifyContent: 'space-between',
  padding:        '16px 20px 12px',
  borderBottom:   `1px solid ${withAlpha(COLOR.cyan, 0.20)}`,
};

const TITLE: React.CSSProperties = {
  display:       'flex',
  alignItems:    'center',
  gap:           8,
  color:         COLOR.cyan,
  fontSize:      12,
  letterSpacing: '0.10em',
  textTransform: 'uppercase',
  fontWeight:    600,
};

/** Green health dot in the title */
const STATUS_DOT: React.CSSProperties = {
  color:    COLOR.lime,
  fontSize: 8,
};

const SUBTITLE: React.CSSProperties = {
  color:         COLOR.ash,
  fontSize:      10,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  marginTop:     4,
};

const HEADER_CONTROLS: React.CSSProperties = {
  display:    'flex',
  alignItems: 'center',
  gap:        8,
};

const CLOSE_BTN: React.CSSProperties = {
  background:   'transparent',
  border:       `1px solid ${withAlpha(COLOR.cyan, 0.30)}`,
  color:        COLOR.cyan,
  width:        24,
  height:       24,
  fontSize:     16,
  cursor:       'pointer',
  fontFamily:   FONT_MONO,
  borderRadius: 2,
  lineHeight:   '20px',
};

const REFRESH_BTN: React.CSSProperties = {
  background:    'transparent',
  border:        `1px solid ${withAlpha(COLOR.cyan, 0.30)}`,
  color:         COLOR.cyan,
  width:         24,
  height:        24,
  fontSize:      14,
  cursor:        'pointer',
  fontFamily:    FONT_MONO,
  borderRadius:  2,
  lineHeight:    '20px',
  display:       'flex',
  alignItems:    'center',
  justifyContent: 'center',
};

const BODY: React.CSSProperties = {
  flex:          1,
  overflowY:     'auto',
  padding:       '16px 20px',
  scrollbarWidth: 'thin',
  scrollbarColor: `${withAlpha(COLOR.cyan, 0.35)} transparent`,
};

const FOOTER: React.CSSProperties = {
  padding:       '8px 20px',
  borderTop:     `1px solid ${withAlpha(COLOR.cyan, 0.20)}`,
  color:         COLOR.low,
  fontSize:      9,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  textAlign:     'center',
};

// ── Summary row ───────────────────────────────────────────────────────

const SUMMARY_ROW: React.CSSProperties = {
  display:       'flex',
  gap:           12,
  marginBottom:  16,
};

const SUMMARY_CARD: React.CSSProperties = {
  flex:         1,
  background:   withAlpha(COLOR.cyan, 0.04),
  border:       `1px solid ${withAlpha(COLOR.cyan, 0.18)}`,
  borderRadius: 4,
  padding:      '12px 16px',
  display:      'flex',
  flexDirection: 'column',
  gap:          4,
};

const CARD_LABEL: React.CSSProperties = {
  color:         COLOR.ash,
  fontSize:      9,
  letterSpacing: '0.10em',
  textTransform: 'uppercase',
  fontWeight:    500,
};

const CARD_VALUE: React.CSSProperties = {
  fontSize:           16,
  fontWeight:         600,
  fontVariantNumeric: 'tabular-nums',
  lineHeight:         1.2,
};

const CARD_PCT: React.CSSProperties = {
  fontSize:           10,
  fontVariantNumeric: 'tabular-nums',
};

// ── Section divider ───────────────────────────────────────────────────

const SECTION_HEADER: React.CSSProperties = {
  display:       'flex',
  alignItems:    'center',
  gap:           8,
  fontSize:      9,
  letterSpacing: '0.10em',
  textTransform: 'uppercase',
  color:         COLOR.ash,
  borderTop:     `1px solid ${withAlpha(COLOR.cyan, 0.15)}`,
  paddingTop:    12,
  marginBottom:  8,
};

const REFRESHING_HINT: React.CSSProperties = {
  color:    COLOR.lime,
  fontSize: 9,
};

// ── Holdings table ────────────────────────────────────────────────────

const TABLE_WRAP: React.CSSProperties = {
  width:    '100%',
  overflowX: 'auto',
};

const TABLE: React.CSSProperties = {
  width:          '100%',
  borderCollapse: 'collapse',
  fontSize:       11,
};

const TABLE_HEAD_ROW: React.CSSProperties = {
  borderBottom: `1px solid ${withAlpha(COLOR.cyan, 0.20)}`,
};

const TH: React.CSSProperties = {
  color:         COLOR.ash,
  fontSize:      9,
  letterSpacing: '0.10em',
  textTransform: 'uppercase',
  padding:       '0 8px 8px 8px',
  textAlign:     'left',
  fontWeight:    500,
  whiteSpace:    'nowrap',
};

const TR: React.CSSProperties = {
  borderBottom: `1px solid ${withAlpha(COLOR.cyan, 0.08)}`,
};

const TD: React.CSSProperties = {
  padding:            '8px',
  fontSize:           11,
  color:              COLOR.bone,
  fontVariantNumeric: 'tabular-nums',
  whiteSpace:         'nowrap',
};

const TD_CODE: React.CSSProperties = {
  color:      COLOR.cyan,
  fontSize:   10,
  letterSpacing: '0.06em',
};

// ── Center / empty states ─────────────────────────────────────────────

const CENTER_PANEL: React.CSSProperties = {
  display:        'flex',
  flexDirection:  'column',
  alignItems:     'center',
  justifyContent: 'center',
  padding:        '40px 20px',
  textAlign:      'center',
  minHeight:      120,
};

const SPINNER: React.CSSProperties = {
  width:        18,
  height:       18,
  borderRadius: '50%',
  border:       `1.5px solid ${withAlpha(COLOR.cyan, 0.18)}`,
  borderTopColor: COLOR.cyan,
  animation:    'nxBalanceSpin 0.9s linear infinite',
  marginBottom: 12,
};

const STATUS_LINE: React.CSSProperties = {
  color:         COLOR.cyan,
  fontSize:      11,
  letterSpacing: '0.10em',
};

const STATUS_LINE_AMBER: React.CSSProperties = {
  ...STATUS_LINE,
  color: COLOR.amber,
};

const STATUS_HINT: React.CSSProperties = {
  color:      COLOR.ash,
  fontSize:   10,
  marginTop:  8,
  lineHeight: 1.5,
};

const ERR_ICON: React.CSSProperties = {
  color:        COLOR.amber,
  fontSize:     20,
  marginBottom: 8,
};

const RETRY_BTN: React.CSSProperties = {
  marginTop:     16,
  padding:       '6px 16px',
  background:    'transparent',
  border:        `1px solid ${COLOR.amber}`,
  color:         COLOR.amber,
  fontSize:      10,
  letterSpacing: '0.10em',
  textTransform: 'uppercase',
  fontFamily:    FONT_MONO,
  cursor:        'pointer',
  borderRadius:  2,
};

const EMPTY_HOLDINGS: React.CSSProperties = {
  display:        'flex',
  alignItems:     'center',
  gap:            8,
  padding:        '16px 0',
  color:          COLOR.ash,
  fontSize:       10,
  letterSpacing:  '0.08em',
  textTransform:  'uppercase',
};

const EMPTY_GLYPH: React.CSSProperties = {
  color:    COLOR.low,
  fontSize: 14,
};

// ── Keyframes injected once at module load (idempotent via id) ────────

if (typeof document !== 'undefined' && !document.getElementById('nx-balance-spin-css')) {
  const style = document.createElement('style');
  style.id = 'nx-balance-spin-css';
  style.textContent = `
    @keyframes nxBalanceSpin { to { transform: rotate(360deg); } }
    [data-testid="balance-modal"] ::-webkit-scrollbar {
      width: 6px;
      height: 6px;
    }
    [data-testid="balance-modal"] ::-webkit-scrollbar-track {
      background: transparent;
    }
    [data-testid="balance-modal"] ::-webkit-scrollbar-thumb {
      background: ${withAlpha(COLOR.cyan, 0.28)};
      border-radius: 3px;
    }
    [data-testid="balance-modal"] ::-webkit-scrollbar-thumb:hover {
      background: ${withAlpha(COLOR.cyan, 0.55)};
    }
    [data-testid="balance-modal"] ::-webkit-scrollbar-corner {
      background: transparent;
    }
  `;
  document.head.appendChild(style);
}
