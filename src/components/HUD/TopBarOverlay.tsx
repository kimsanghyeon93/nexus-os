// TopBarOverlay — Sprint 5s+ toolbar surfaces.
//
// The four TopBar tabs each map to a distinct surface:
//   • ONTOLOGY        → no overlay (the canvas IS the ontology view)
//   • SNAPSHOTS       → list of captured dataset snapshots with re-download
//   • INVESTIGATIONS  → live anomaly watchlist sorted desc — click drills
//                       into the existing AuditModal via onSelect + open
//   • ACTIONS         → command palette mirroring CommandCenter's COMMANDS
//                       array, click-to-fire onCommand (same handler the
//                       hotkeys + click items hit)
//
// Visual language matches AuditModal: cyan-bordered glass frame, JetBrains
// Mono, role=dialog. Inline styles only — no new CSS. ESC + backdrop click
// + the × button all route through onClose, which the parent translates
// to setting activeTab back to 'ontology'.

import { useEffect, useRef, useState } from 'react';

import { useChat } from '../../hooks/useChat';
import { NEXUS_COLOR, NEXUS_SURFACE, withAlpha } from '../../styles/colors';
import { FONT_MONO } from '../../styles/fonts';
import { useLanguage } from '../../utils/i18n';
import type { NexusEntity } from '../../types/nexus';
import type { TopBarTab } from './TopBar';

// Sprint 5s+ loop iteration: was a 6-token local subset of the canonical
// palette; same values duplicated in RadarCanvas + AuditModal. Now sourced
// from src/styles/colors.ts.
const COLOR = NEXUS_COLOR;

export interface SnapshotEntryView {
  id:         string;
  filename:   string;
  /** UTC ISO-8601 capture instant — matches utils/snapshot SnapshotEntry. */
  capturedAt: string;
  bytes:      number;
  nodeCount:  number;
}

export interface TopBarOverlayProps {
  /** Which surface to show. 'ontology' renders null (overlay closed). */
  activeTab: TopBarTab;
  /** Captured-snapshot history. Newest-first. */
  snapshots: ReadonlyArray<SnapshotEntryView>;
  /** Re-download a previously captured snapshot. */
  onSnapshotReDownload: (id: string) => void;
  /** Full entity list — used to compute the investigations watchlist. */
  entities: ReadonlyArray<NexusEntity>;
  /** Fired when the operator clicks an entity row. App typically sets
   *  selectedId + auditTarget so the canvas focuses + AuditModal opens. */
  onEntitySelect: (id: string) => void;
  /** Fire a command id ('snapshot' / 'audit' / 'isolate' / ...). Wired to
   *  the same handler CommandCenter uses. */
  onCommand: (id: string) => void;
  /** Close the overlay — parent sets activeTab back to 'ontology'. */
  onClose: () => void;
}

export function TopBarOverlay(props: TopBarOverlayProps) {
  const { t } = useLanguage();
  if (props.activeTab === 'ontology') return null;

  // ESC + outside-click close. The capture phase ensures we beat any
  // child modals (AuditModal etc.) to the ESC keystroke when both are
  // mounted — overlay should close first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        props.onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [props.onClose, props.activeTab]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('overlay.aria', { tab: props.activeTab.toUpperCase() })}
      onClick={props.onClose}
      style={BACKDROP}
    >
      <div
        data-testid={`top-overlay-${props.activeTab}`}
        onClick={e => e.stopPropagation()}
        style={FRAME}
      >
        <header style={HEADER}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ color: COLOR.cyan, fontSize: 11, letterSpacing: '0.12em' }}>
              {titleFor(props.activeTab, t)}
            </span>
            <span style={{ color: COLOR.ash, fontSize: 9, letterSpacing: '0.10em' }}>
              {subtitleFor(props.activeTab, props, t)}
            </span>
          </div>
          <button type="button" onClick={props.onClose} style={CLOSE_BTN} aria-label="Close">×</button>
        </header>

        <div style={BODY}>
          {props.activeTab === 'snapshots'
            ? <SnapshotsBody {...props} />
            : props.activeTab === 'investigations'
              ? <InvestigationsBody {...props} />
              : props.activeTab === 'actions'
                ? <ActionsBody {...props} />
                : <AssistantBody />}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  SNAPSHOTS                                                          */
/* ------------------------------------------------------------------ */

function SnapshotsBody({ snapshots, onSnapshotReDownload }: TopBarOverlayProps) {
  const { t } = useLanguage();
  if (snapshots.length === 0) {
    return (
      <div style={EMPTY_HINT}>
        {t('overlay.snapshots.empty')}<br />
        {t('overlay.snapshots.emptyHint')}
      </div>
    );
  }
  return (
    <ul style={LIST}>
      {snapshots.map(s => (
        <li key={s.id} style={SNAPSHOT_ROW}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ color: COLOR.cyan, fontSize: 11, fontWeight: 500 }}>{s.filename}</span>
            <span style={{ color: COLOR.ash, fontSize: 9, letterSpacing: '0.06em' }}>
              {t('overlay.snapshots.rowSummary', {
                ts: formatIso(s.capturedAt),
                nodes: s.nodeCount,
                bytes: formatBytes(s.bytes),
              })}
            </span>
          </div>
          <button
            type="button"
            onClick={() => onSnapshotReDownload(s.id)}
            style={ROW_BTN}
            title={t('overlay.snapshots.redownloadTitle')}
          >
            {t('overlay.snapshots.redownload')}
          </button>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ */
/*  INVESTIGATIONS                                                     */
/* ------------------------------------------------------------------ */

const ANOMALY_THRESHOLD = 0.4;

function InvestigationsBody({ entities, onEntitySelect }: TopBarOverlayProps) {
  const { t } = useLanguage();
  // Watchlist = every entity with anomaly ≥ threshold, sorted desc.
  // Hubs are filtered out because their anomaly is structural placeholder
  // (set in the seed for the WATCH cluster), not a market signal.
  const watchlist = entities
    .filter(e => !e.isHub && (e.anomaly ?? 0) >= ANOMALY_THRESHOLD)
    .sort((a, b) => (b.anomaly ?? 0) - (a.anomaly ?? 0))
    .slice(0, 40);

  if (watchlist.length === 0) {
    return (
      <div style={EMPTY_HINT}>
        {t('overlay.invest.empty')}<br />
        {t('overlay.invest.emptyHint', { threshold: ANOMALY_THRESHOLD.toFixed(2) })}
      </div>
    );
  }
  return (
    <ul style={LIST}>
      {watchlist.map(e => {
        const anomaly = e.anomaly ?? 0;
        const tone = anomaly > 0.7 ? COLOR.lime : anomaly > 0.5 ? COLOR.amber : COLOR.cyan;
        return (
          <li
            key={e.id}
            style={INVESTIGATION_ROW}
            onClick={() => onEntitySelect(e.id)}
            role="button"
            tabIndex={0}
            onKeyDown={ev => {
              if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                onEntitySelect(e.id);
              }
            }}
            title={t('overlay.invest.rowTitle')}
          >
            <span style={{ color: COLOR.bone, fontSize: 11, fontWeight: 500, minWidth: 80 }}>
              {e.id}
            </span>
            <span style={{ color: COLOR.ash, fontSize: 10, flex: 1 }}>
              {/* Sprint 5s+ — prefer display_name from the securities
                  master when it's been merged onto the entity. Legacy
                  ontology nodes keep their hardcoded label. */}
              {e.display_name ?? e.label}
            </span>
            <span style={{ color: COLOR.ash, fontSize: 9, letterSpacing: '0.08em', minWidth: 60 }}>
              {e.cluster}
            </span>
            <span style={{
              color: tone, fontSize: 11, fontWeight: 600, fontVariantNumeric: 'tabular-nums',
              minWidth: 56, textAlign: 'right',
            }}>
              {(anomaly * 100).toFixed(0)}%
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/* ------------------------------------------------------------------ */
/*  ACTIONS — command palette                                          */
/* ------------------------------------------------------------------ */

interface ActionItem {
  id: string;
  hotkey: string;
}

// Sprint 5s+ iter 10: labels + hints now live in i18n dictionary
// (`overlay.actions.<id>` + `overlay.actions.hint.<id>`). Only the
// hotkey glyph stays here — it's language-neutral.
const ACTIONS: ReadonlyArray<ActionItem> = [
  { id: 'analyze',  hotkey: '⌘A' },
  { id: 'snapshot', hotkey: '⌘S' },
  { id: 'isolate',  hotkey: '⌘I' },
  { id: 'trace',    hotkey: '⌘T' },
  { id: 'audit',    hotkey: '⌘L' },
  { id: 'replay',   hotkey: '⌘R' },
  { id: 'alert',    hotkey: '⌘!' },
  { id: 'tour',     hotkey: '?'  },
];

function ActionsBody({ onCommand, onClose }: TopBarOverlayProps) {
  const { t } = useLanguage();
  // Focus the first action on mount so keyboard navigation works
  // immediately without a click. Subsequent arrow keys move through
  // the list (handled by native button tab order).
  const firstRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { firstRef.current?.focus(); }, []);

  return (
    <ul style={LIST}>
      {ACTIONS.map((a, i) => (
        <li key={a.id} style={{ listStyle: 'none' }}>
          <button
            ref={i === 0 ? firstRef : null}
            type="button"
            data-testid={`action-${a.id}`}
            onClick={() => { onCommand(a.id); onClose(); }}
            style={ACTION_ROW}
          >
            <span style={{
              fontFamily: FONT_MONO,
              color: COLOR.cyan, fontSize: 11, minWidth: 36,
            }}>{a.hotkey}</span>
            <span style={{ color: COLOR.bone, fontSize: 11, fontWeight: 500, minWidth: 160 }}>
              {t(`overlay.actions.${a.id}`)}
            </span>
            <span style={{ color: COLOR.ash, fontSize: 9, letterSpacing: '0.04em', flex: 1, textAlign: 'left' }}>
              {t(`overlay.actions.hint.${a.id}`)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ */
/*  ASSISTANT — chat panel                                             */
/* ------------------------------------------------------------------ */

function AssistantBody() {
  const chat = useChat();
  const { t } = useLanguage();
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef  = useRef<HTMLTextAreaElement>(null);

  // Auto-focus the input on mount + auto-scroll to bottom on new
  // message. Operators expect chat-style affordances (focus, scroll-
  // pin) without any extra clicking.
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [chat.messages, chat.isResponding]);

  const submit = () => {
    const text = draft.trim();
    if (!text || chat.isResponding) return;
    chat.send(text);
    setDraft('');
  };

  return (
    <div style={CHAT_LAYOUT}>
      <div ref={scrollRef} style={CHAT_SCROLL}>
        {chat.messages.map(m => (
          <div key={m.id} style={chatRowStyle(m.role)}>
            <span style={chatRolePillStyle(m.role)}>{chatRoleLabel(m.role, t)}</span>
            <div style={chatBubbleStyle(m.role)}>{m.text}</div>
          </div>
        ))}
        {chat.isResponding && (
          <div style={chatRowStyle('assistant')}>
            <span style={chatRolePillStyle('assistant')}>{chatRoleLabel('assistant', t)}</span>
            <div style={{ ...chatBubbleStyle('assistant'), color: COLOR.ash, fontStyle: 'italic' }}>
              {t('overlay.asst.thinking')}
            </div>
          </div>
        )}
      </div>

      <div style={CHAT_INPUT_ROW}>
        <textarea
          ref={inputRef}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            // Enter sends; Shift+Enter inserts newline. Same affordance as
            // every other chat surface — operators won't have to relearn.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={t('overlay.asst.placeholder')}
          rows={2}
          data-testid="chat-input"
          style={CHAT_TEXTAREA}
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <button
            type="button"
            onClick={submit}
            disabled={!draft.trim() || chat.isResponding}
            data-testid="chat-send"
            style={chatSendBtnStyle(!draft.trim() || chat.isResponding)}
          >
            {t('overlay.asst.send')}
          </button>
          <button
            type="button"
            onClick={chat.clear}
            title={t('overlay.asst.clearTitle')}
            style={chatClearBtnStyle}
            data-testid="chat-clear"
          >
            {t('overlay.asst.clear')}
          </button>
        </div>
      </div>
    </div>
  );
}

function chatRoleLabel(
  role: 'operator' | 'assistant' | 'system',
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const key = role === 'operator' ? 'overlay.asst.role.op'
            : role === 'assistant' ? 'overlay.asst.role.asst'
            : 'overlay.asst.role.sys';
  return t(key);
}

function chatRowStyle(role: 'operator' | 'assistant' | 'system'): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
    padding: '8px 16px',
    flexDirection: role === 'operator' ? 'row-reverse' : 'row',
  };
}

function chatRolePillStyle(role: 'operator' | 'assistant' | 'system'): React.CSSProperties {
  const tone = role === 'operator' ? COLOR.cyan : role === 'assistant' ? COLOR.lime : COLOR.ash;
  return {
    color: tone,
    fontSize: 8,
    letterSpacing: '0.10em',
    fontWeight: 600,
    minWidth: 36,
    padding: '4px 6px',
    border: `0.6px solid ${tone}`,
    borderRadius: 2,
    textAlign: 'center',
    flexShrink: 0,
    marginTop: 2,
  };
}

function chatBubbleStyle(role: 'operator' | 'assistant' | 'system'): React.CSSProperties {
  const bg = role === 'operator'
    ? withAlpha(COLOR.cyan, 0.06)
    : role === 'assistant'
      ? withAlpha(COLOR.lime, 0.04)
      : 'transparent';
  const border = role === 'system' ? `0.4px dashed ${COLOR.low}` : '0.4px solid transparent';
  return {
    flex: '0 1 auto',
    maxWidth: '70%',
    background: bg,
    border,
    padding: '8px 12px',
    color: COLOR.bone,
    fontSize: 11,
    lineHeight: 1.55,
    borderRadius: 3,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  };
}

const CHAT_LAYOUT: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '60vh',
  minHeight: 360,
};

const CHAT_SCROLL: React.CSSProperties = {
  flex: '1 1 auto',
  overflowY: 'auto',
  padding: '4px 0',
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};

const CHAT_INPUT_ROW: React.CSSProperties = {
  display: 'flex',
  alignItems: 'stretch',
  gap: 8,
  padding: '10px 16px 12px',
  borderTop: `0.4px solid ${COLOR.low}`,
};

const CHAT_TEXTAREA: React.CSSProperties = {
  flex: '1 1 auto',
  resize: 'none',
  background: withAlpha(COLOR.cyan, 0.04),
  border: `0.6px solid ${withAlpha(COLOR.cyan, 0.25)}`,
  color: COLOR.bone,
  padding: '8px 10px',
  fontSize: 11,
  lineHeight: 1.4,
  fontFamily: FONT_MONO,
  borderRadius: 2,
  outline: 'none',
};

function chatSendBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    background:    'transparent',
    border:        `0.8px solid ${disabled ? COLOR.low : COLOR.cyan}`,
    color:         disabled ? COLOR.ash : COLOR.cyan,
    padding:       '8px 12px',
    fontSize:      10,
    letterSpacing: '0.08em',
    fontWeight:    600,
    cursor:        disabled ? 'not-allowed' : 'pointer',
    borderRadius:  2,
    fontFamily:    'inherit',
  };
}

const chatClearBtnStyle: React.CSSProperties = {
  background:    'transparent',
  border:        `0.6px solid ${COLOR.low}`,
  color:         COLOR.ash,
  padding:       '4px 12px',
  fontSize:      8,
  letterSpacing: '0.10em',
  cursor:        'pointer',
  borderRadius:  2,
  fontFamily:    'inherit',
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

type Translator = (key: string, params?: Record<string, string | number>) => string;

function titleFor(tab: TopBarTab, t: Translator): string {
  switch (tab) {
    case 'snapshots':      return t('overlay.snapshots.title');
    case 'investigations': return t('overlay.invest.title');
    case 'actions':        return t('overlay.actions.title');
    case 'assistant':      return t('overlay.asst.title');
    default:               return '';
  }
}

function subtitleFor(tab: TopBarTab, props: TopBarOverlayProps, t: Translator): string {
  const esc = t('overlay.escClose');
  switch (tab) {
    case 'snapshots': {
      const count = props.snapshots.length;
      return t('overlay.snapshots.subtitle', { count, plural: count === 1 ? '' : 'S', esc });
    }
    case 'investigations': {
      const count = props.entities.filter(
        e => !e.isHub && (e.anomaly ?? 0) >= ANOMALY_THRESHOLD,
      ).length;
      return t('overlay.invest.subtitle', {
        count, threshold: (ANOMALY_THRESHOLD * 100).toFixed(0), esc,
      });
    }
    case 'actions':
      return t('overlay.actions.subtitle', { count: ACTIONS.length, esc });
    case 'assistant':
      return t('overlay.asst.subtitle', { esc });
    default:
      return '';
  }
}

function formatIso(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
  return `${(b / 1024 / 1024).toFixed(1)}MB`;
}

/* ------------------------------------------------------------------ */
/*  Styles                                                             */
/* ------------------------------------------------------------------ */

const BACKDROP: React.CSSProperties = {
  position: 'fixed', inset: 0,
  background: NEXUS_SURFACE.backdropLite,
  backdropFilter: 'blur(6px) saturate(1.2)',
  WebkitBackdropFilter: 'blur(6px) saturate(1.2)',
  zIndex: 200,
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'center',
  paddingTop: 72,
};

const FRAME: React.CSSProperties = {
  width: 'min(960px, 92vw)',
  maxHeight: '78vh',
  display: 'flex',
  flexDirection: 'column',
  background: NEXUS_SURFACE.frame,
  border: `0.8px solid ${withAlpha(COLOR.cyan, 0.35)}`,
  borderRadius: 3,
  boxShadow: `0 24px 64px rgba(0, 0, 0, 0.55), 0 0 32px ${withAlpha(COLOR.cyan, 0.10)} inset`,
  fontFamily: FONT_MONO,
  color: COLOR.bone,
};

const HEADER: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '10px 14px',
  borderBottom: `0.8px solid ${withAlpha(COLOR.cyan, 0.18)}`,
};

const CLOSE_BTN: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: COLOR.ash,
  fontSize: 18,
  lineHeight: 1,
  cursor: 'pointer',
  padding: '0 4px',
};

const BODY: React.CSSProperties = {
  flex: '1 1 auto',
  overflowY: 'auto',
  padding: '6px 0',
  scrollbarWidth: 'thin',
  scrollbarColor: `${withAlpha(COLOR.cyan, 0.35)} transparent`,
};

const LIST: React.CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: '4px 0',
};

const SNAPSHOT_ROW: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '8px 16px',
  borderBottom: `0.4px solid ${COLOR.low}`,
};

const INVESTIGATION_ROW: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '6px 16px',
  borderBottom: `0.4px solid ${COLOR.low}`,
  cursor: 'pointer',
  transition: 'background 120ms ease',
};

const ACTION_ROW: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  width: '100%',
  padding: '8px 16px',
  background: 'transparent',
  border: 'none',
  borderBottom: `0.4px solid ${COLOR.low}`,
  cursor: 'pointer',
  textAlign: 'left',
  fontFamily: 'inherit',
};

const ROW_BTN: React.CSSProperties = {
  background: 'transparent',
  border: `0.8px solid ${withAlpha(COLOR.cyan, 0.35)}`,
  color: COLOR.cyan,
  padding: '4px 10px',
  fontSize: 9,
  letterSpacing: '0.08em',
  cursor: 'pointer',
  borderRadius: 2,
  fontFamily: 'inherit',
};

const EMPTY_HINT: React.CSSProperties = {
  padding: '32px 16px',
  textAlign: 'center',
  color: COLOR.ash,
  fontSize: 10,
  letterSpacing: '0.06em',
  lineHeight: 1.6,
};

// Cyan thin scrollbar — match AuditModal / TapePanel conventions. Idempotent
// guard so HMR doesn't stack multiple style nodes.
if (typeof document !== 'undefined' && !document.getElementById('nx-topbar-overlay-css')) {
  const style = document.createElement('style');
  style.id = 'nx-topbar-overlay-css';
  style.textContent = `
    [data-testid^="top-overlay-"] ::-webkit-scrollbar { width: 6px; }
    [data-testid^="top-overlay-"] ::-webkit-scrollbar-track { background: transparent; }
    [data-testid^="top-overlay-"] ::-webkit-scrollbar-thumb { background: ${withAlpha(COLOR.cyan, 0.28)}; border-radius: 3px; }
    [data-testid^="top-overlay-"] ::-webkit-scrollbar-thumb:hover { background: ${withAlpha(COLOR.cyan, 0.55)}; }
    [data-testid="top-overlay-investigations"] li[role="button"]:hover,
    [data-testid="top-overlay-actions"] button:hover {
      background: ${withAlpha(COLOR.cyan, 0.06)};
    }
  `;
  document.head.appendChild(style);
}
