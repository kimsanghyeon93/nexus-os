// AuditModal — Sprint 5o-C-3 (⌘L Audit transactions).
//
// Pulls /v1/audit/recent for the focused entity and renders the result
// newest-first. Four UI states (one component, no state-machine library):
//
//   loading  — spinner + "FETCHING AUDIT TRAIL"
//   error    — problem.title + detail + Retry
//   empty    — "NO DECISIONS LOGGED" hint (visible vs DB outage is the
//              repo's responsibility — we render the same UI for both
//              because the operator can't act on the difference).
//   data     — scrollable list of AuditRow cards
//
// Architecturally a *dumb* dialog: the parent owns isOpen + symbol +
// query state, this component handles the fetch effect and renders.
// Closing on backdrop click / ESC / X-button all funnel through onClose.
//
// Visual language matches BootSequenceOverlay (cyan-bordered glass frame,
// JetBrains Mono, role=dialog/aria-modal). No new CSS — inline styles
// only, so the modal carries its own theming and we don't have to touch
// nexus.css for a single command surface.

import { useCallback, useEffect, useState } from 'react';

import { fetchRecentAudit } from '../../services/auditApi';
import type { ApiResult, AuditRecentDTO, AuditRow } from '../../types/api';

const ROW_LIMIT = 20;

export interface AuditModalProps {
  /** Mounted when truthy (parent controls). */
  symbol:    string | null;
  /** Human-readable label for the title bar (falls back to symbol). */
  label?:    string;
  /** Backend base URL — pass through for non-default deployments. */
  baseUrl?:  string;
  /** Fired by ESC, backdrop click, or × button. Parent flips `symbol`
   *  to null after this; the unmount tears the fetch effect down. */
  onClose:   () => void;
}

/** Internal fetch state. Discriminated union mirrors ApiResult so the
 *  branches collapse to a switch. */
type AuditFetchState =
  | { kind: 'loading' }
  | { kind: 'data'; data: AuditRecentDTO }
  | { kind: 'error'; title: string; detail: string };

export function AuditModal({ symbol, label, baseUrl, onClose }: AuditModalProps) {
  // The parent unmounts when symbol === null, but guard anyway so this
  // component is robust to defensive consumers passing both prop +
  // conditional rendering.
  if (symbol === null) return null;

  return (
    <AuditModalInner
      symbol={symbol}
      label={label ?? symbol}
      {...(baseUrl !== undefined ? { baseUrl } : {})}
      onClose={onClose}
    />
  );
}

interface AuditModalInnerProps {
  symbol:   string;
  label:    string;
  baseUrl?: string;
  onClose:  () => void;
}

function AuditModalInner({ symbol, label, baseUrl, onClose }: AuditModalInnerProps) {
  const [state, setState] = useState<AuditFetchState>({ kind: 'loading' });
  const [retryToken, setRetryToken] = useState(0);

  // Fetch once per mount (or on retry / symbol change). AbortController
  // cancels any in-flight call so a quick close-then-reopen on a new
  // symbol doesn't overwrite the new result with the stale one.
  useEffect(() => {
    const ctrl = new AbortController();
    setState({ kind: 'loading' });
    let mounted = true;

    (async () => {
      const result: ApiResult<AuditRecentDTO> = await fetchRecentAudit(symbol, {
        limit:  ROW_LIMIT,
        signal: ctrl.signal,
        ...(baseUrl !== undefined ? { baseUrl } : {}),
      });
      if (!mounted) return;
      if (result.ok) {
        setState({ kind: 'data', data: result.data });
      } else {
        setState({
          kind:   'error',
          title:  result.problem.title,
          detail: result.problem.detail
                  ?? `HTTP ${result.problem.status}`,
        });
      }
    })();

    return () => {
      mounted = false;
      ctrl.abort();
    };
  }, [symbol, retryToken, baseUrl]);

  // ESC closes — capture phase so we beat anything else that listens.
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

  const handleRetry = useCallback(() => setRetryToken(n => n + 1), []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="nx-audit-title"
      data-testid="audit-modal"
      onClick={onClose}
      style={BACKDROP}
    >
      <div onClick={e => e.stopPropagation()} style={FRAME}>
        <div style={CORNER_TL} aria-hidden>┌</div>
        <div style={CORNER_TR} aria-hidden>┐</div>
        <div style={CORNER_BL} aria-hidden>└</div>
        <div style={CORNER_BR} aria-hidden>┘</div>

        <header style={HEADER}>
          <div>
            <div id="nx-audit-title" style={TITLE}>AUDIT TRAIL · {label}</div>
            <div style={SUBTITLE}>
              SYMBOL · {symbol} · {state.kind === 'data'
                ? `${state.data.rows.length} ROW${state.data.rows.length === 1 ? '' : 'S'}`
                : 'PENDING'}
            </div>
          </div>
          <button
            type="button"
            data-testid="audit-modal-close"
            onClick={onClose}
            aria-label="Close audit"
            style={CLOSE_BTN}
          >
            ×
          </button>
        </header>

        <div style={BODY}>
          {state.kind === 'loading' && <LoadingState />}
          {state.kind === 'error' && (
            <ErrorState
              title={state.title}
              detail={state.detail}
              onRetry={handleRetry}
            />
          )}
          {state.kind === 'data' && state.data.rows.length === 0 && (
            <EmptyState symbol={symbol} />
          )}
          {state.kind === 'data' && state.data.rows.length > 0 && (
            <RowList rows={state.data.rows} />
          )}
        </div>

        <footer style={FOOTER}>
          [ ESC OR CLICK OUTSIDE TO CLOSE · NEWEST-FIRST · MAX {ROW_LIMIT} ROWS ]
        </footer>
      </div>
    </div>
  );
}

// ── State branches ────────────────────────────────────────────────────

function LoadingState() {
  return (
    <div data-testid="audit-loading" style={CENTER_PANEL}>
      <div style={SPINNER} aria-hidden />
      <div style={STATUS_LINE}>FETCHING AUDIT TRAIL...</div>
      <div style={STATUS_HINT}>Querying execution_audit hypertable</div>
    </div>
  );
}

interface ErrorStateProps {
  title:  string;
  detail: string;
  onRetry: () => void;
}

function ErrorState({ title, detail, onRetry }: ErrorStateProps) {
  return (
    <div data-testid="audit-error" style={CENTER_PANEL}>
      <div style={ERR_ICON} aria-hidden>◆</div>
      <div style={STATUS_LINE_AMBER}>{title.toUpperCase()}</div>
      <div style={ERR_DETAIL}>{detail}</div>
      <button
        type="button"
        onClick={onRetry}
        data-testid="audit-retry"
        style={RETRY_BTN}
      >
        RETRY
      </button>
    </div>
  );
}

function EmptyState({ symbol }: { symbol: string }) {
  return (
    <div data-testid="audit-empty" style={CENTER_PANEL}>
      <div style={EMPTY_GLYPH} aria-hidden>∅</div>
      <div style={STATUS_LINE}>NO DECISIONS LOGGED</div>
      <div style={STATUS_HINT}>
        No coordinator output recorded for <strong>{symbol}</strong> yet.
        Once a tick arrives, every guarded / shadow / live decision lands here.
      </div>
    </div>
  );
}

function RowList({ rows }: { rows: AuditRow[] }) {
  return (
    <ul data-testid="audit-rows" style={LIST}>
      {rows.map((r, i) => (
        <AuditRowCard key={`${r.ts}-${i}`} row={r} />
      ))}
    </ul>
  );
}

function AuditRowCard({ row }: { row: AuditRow }) {
  const tone = row.executed ? 'lime'
             : row.blocked_by ? 'amber'
             : row.mode === 'shadow' ? 'cyan'
             : 'low';
  const accent = TONE_COLOR[tone];
  const ts = formatTs(row.ts);
  return (
    <li style={{ ...ROW, borderLeftColor: accent }} data-testid="audit-row">
      <div style={ROW_HEAD}>
        <span style={{ ...MODE_BADGE, color: accent, borderColor: accent }}>
          {row.mode.toUpperCase()}
          {row.executed ? ' · FILLED' : ''}
          {row.blocked_by ? ' · BLOCKED' : ''}
        </span>
        <span style={ROW_TS}>{ts}</span>
      </div>
      <div style={ROW_INTENT}>
        Intended: <strong>{row.intended_action.toUpperCase()}</strong>
        {row.intended_quantity > 0 && <> × {row.intended_quantity}</>}
        <span style={SEP}>·</span>
        Signal: <strong>{row.signal_action.toUpperCase()}</strong>
        <span style={SEP}>·</span>
        Conf: <strong>{(row.signal_confidence * 100).toFixed(0)}%</strong>
        <span style={SEP}>·</span>
        Score: <strong>{row.signal_score.toFixed(2)}</strong>
      </div>
      {(row.blocked_by || row.reason) && (
        <div style={ROW_REASON}>
          {row.blocked_by && (
            <>
              <span style={LABEL}>BLOCKED BY</span>
              <code style={CODE}>{row.blocked_by}</code>
            </>
          )}
          {row.reason && (
            <>
              <span style={LABEL}>REASON</span>
              <span>{row.reason}</span>
            </>
          )}
        </div>
      )}
      {row.signal_rationale.length > 0 && (
        <details style={ROW_RATIONALE}>
          <summary style={SUMMARY}>
            RATIONALE · {row.signal_rationale.length} AGENT{row.signal_rationale.length === 1 ? '' : 'S'}
          </summary>
          <ul style={RATIONALE_LIST}>
            {row.signal_rationale.map((c, i) => (
              <li key={`${c.agent_id}-${i}`} style={RATIONALE_ITEM}>
                <code style={CODE}>{c.agent_id}</code>
                <span style={SEP}>·</span>
                {c.action.toUpperCase()}
                <span style={SEP}>·</span>
                {(c.confidence * 100).toFixed(0)}%
              </li>
            ))}
          </ul>
        </details>
      )}
      {row.order_id && (
        <div style={ROW_ORDER_ID}>ORDER · {row.order_id}</div>
      )}
    </li>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────

function formatTs(iso: string): string {
  // `2026-05-11T04:30:00+00:00` → `04:30:00 · 05/11`. Keeps the modal
  // tight; the date is shown small so the eye lands on the time first.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const date = `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
  return `${time} · ${date}`;
}

// ── Style tokens ──────────────────────────────────────────────────────
// Inline styles keep this self-contained — modal carries its own theme
// without nexus.css edits.

const TONE_COLOR: Record<'lime' | 'amber' | 'cyan' | 'low', string> = {
  lime:  '#DEFF9A',
  amber: '#FFB200',
  cyan:  '#00BFFF',
  low:   '#8A93A8',
};

const FONT_MONO = '"JetBrains Mono", ui-monospace, monospace';

const BACKDROP: React.CSSProperties = {
  position:  'fixed',
  inset:     0,
  background: 'rgba(2, 4, 12, 0.78)',
  backdropFilter: 'blur(6px)',
  WebkitBackdropFilter: 'blur(6px)',
  zIndex:    1400,
  display:   'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding:   '32px',
};

const FRAME: React.CSSProperties = {
  position:  'relative',
  width:     '100%',
  maxWidth:  '720px',
  maxHeight: '78vh',
  display:   'flex',
  flexDirection: 'column',
  background: 'rgba(11, 11, 24, 0.92)',
  border:    '0.8px solid rgba(0, 191, 255, 0.55)',
  boxShadow: '0 0 24px rgba(0, 191, 255, 0.18)',
  fontFamily: FONT_MONO,
  color:     '#E8ECF5',
  borderRadius: 3,
};

const CORNER_BASE: React.CSSProperties = {
  position:    'absolute',
  width:       12,
  height:      12,
  color:       '#00BFFF',
  fontSize:    14,
  lineHeight:  '12px',
  pointerEvents: 'none',
};
const CORNER_TL: React.CSSProperties = { ...CORNER_BASE, top: -1, left: -1 };
const CORNER_TR: React.CSSProperties = { ...CORNER_BASE, top: -1, right: -1 };
const CORNER_BL: React.CSSProperties = { ...CORNER_BASE, bottom: -1, left: -1 };
const CORNER_BR: React.CSSProperties = { ...CORNER_BASE, bottom: -1, right: -1 };

const HEADER: React.CSSProperties = {
  display:    'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  padding:    '16px 20px 12px',
  borderBottom: '0.8px solid rgba(0, 191, 255, 0.20)',
};

const TITLE: React.CSSProperties = {
  color:        '#00BFFF',
  fontSize:     12,
  letterSpacing: '0.10em',
  textTransform: 'uppercase',
  fontWeight:   600,
};

const SUBTITLE: React.CSSProperties = {
  color:        '#8A93A8',
  fontSize:     10,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  marginTop:    4,
};

const CLOSE_BTN: React.CSSProperties = {
  background: 'transparent',
  border:     '0.8px solid rgba(0, 191, 255, 0.30)',
  color:      '#00BFFF',
  width:      24,
  height:     24,
  fontSize:   16,
  cursor:     'pointer',
  fontFamily: FONT_MONO,
  borderRadius: 2,
  lineHeight: '20px',
};

const BODY: React.CSSProperties = {
  flex:      1,
  overflowY: 'auto',
  padding:   '16px 20px',
};

const FOOTER: React.CSSProperties = {
  padding:    '8px 20px',
  borderTop:  '0.8px solid rgba(0, 191, 255, 0.20)',
  color:      '#4A5066',
  fontSize:   9,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  textAlign:  'center',
};

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
  border:       '1.5px solid rgba(0, 191, 255, 0.18)',
  borderTopColor: '#00BFFF',
  animation:    'nxAuditSpin 0.9s linear infinite',
  marginBottom: 12,
};

const STATUS_LINE: React.CSSProperties = {
  color:        '#00BFFF',
  fontSize:     11,
  letterSpacing: '0.10em',
};

const STATUS_LINE_AMBER: React.CSSProperties = { ...STATUS_LINE, color: '#FFB200' };

const STATUS_HINT: React.CSSProperties = {
  color:     '#8A93A8',
  fontSize:  10,
  marginTop: 8,
  maxWidth:  420,
  lineHeight: 1.5,
};

const ERR_ICON: React.CSSProperties = {
  color:     '#FFB200',
  fontSize:  20,
  marginBottom: 8,
};

const ERR_DETAIL: React.CSSProperties = {
  ...STATUS_HINT,
  color: '#E8ECF5',
};

const RETRY_BTN: React.CSSProperties = {
  marginTop: 16,
  padding:   '6px 16px',
  background: 'transparent',
  border:    '0.8px solid #FFB200',
  color:     '#FFB200',
  fontSize:  10,
  letterSpacing: '0.10em',
  textTransform: 'uppercase',
  fontFamily: FONT_MONO,
  cursor:    'pointer',
  borderRadius: 2,
};

const EMPTY_GLYPH: React.CSSProperties = {
  color:     '#4A5066',
  fontSize:  28,
  marginBottom: 8,
};

const LIST: React.CSSProperties = {
  listStyle: 'none',
  margin:    0,
  padding:   0,
  display:   'flex',
  flexDirection: 'column',
  gap:       10,
};

const ROW: React.CSSProperties = {
  background:  'rgba(0, 191, 255, 0.04)',
  borderLeft:  '2px solid #00BFFF',
  borderRadius: 2,
  padding:     '10px 12px',
};

const ROW_HEAD: React.CSSProperties = {
  display:    'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: 6,
};

const MODE_BADGE: React.CSSProperties = {
  border:        '0.8px solid currentColor',
  padding:       '1px 6px',
  fontSize:      9,
  letterSpacing: '0.10em',
  textTransform: 'uppercase',
  borderRadius:  2,
};

const ROW_TS: React.CSSProperties = {
  color:    '#8A93A8',
  fontSize: 10,
};

const ROW_INTENT: React.CSSProperties = {
  fontSize:    11,
  color:       '#E8ECF5',
  marginBottom: 4,
};

const ROW_REASON: React.CSSProperties = {
  display:    'flex',
  flexWrap:   'wrap',
  gap:        '4px 8px',
  fontSize:   10,
  color:      '#8A93A8',
  marginTop:  4,
};

const LABEL: React.CSSProperties = {
  color:         '#4A5066',
  fontSize:      9,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  marginRight:   4,
};

const CODE: React.CSSProperties = {
  color:      '#DEFF9A',
  fontFamily: FONT_MONO,
  background: 'rgba(222, 255, 154, 0.08)',
  padding:    '0 4px',
  borderRadius: 2,
};

const SEP: React.CSSProperties = {
  color:   '#4A5066',
  margin:  '0 4px',
};

const ROW_RATIONALE: React.CSSProperties = {
  marginTop: 6,
  fontSize:  10,
};

const SUMMARY: React.CSSProperties = {
  cursor:        'pointer',
  color:         '#00BFFF',
  fontSize:      9,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
};

const RATIONALE_LIST: React.CSSProperties = {
  listStyle: 'none',
  margin:    '6px 0 0',
  padding:   0,
  display:   'flex',
  flexDirection: 'column',
  gap:       2,
  color:     '#8A93A8',
};

const RATIONALE_ITEM: React.CSSProperties = {
  fontSize: 10,
};

const ROW_ORDER_ID: React.CSSProperties = {
  marginTop:     6,
  fontSize:      9,
  color:         '#8A93A8',
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
};

// Spinner keyframes are injected once on mount via a styled <style> block
// in the modal so we don't have to edit nexus.css. Idempotent — same id
// per module so multiple opens don't multiply the rule.
if (typeof document !== 'undefined' && !document.getElementById('nx-audit-spin-css')) {
  const style = document.createElement('style');
  style.id = 'nx-audit-spin-css';
  style.textContent = '@keyframes nxAuditSpin { to { transform: rotate(360deg); } }';
  document.head.appendChild(style);
}
