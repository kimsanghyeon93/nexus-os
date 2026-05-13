// TapePanel — Sprint 5p-E forensic tick stream.
//
// Streaming log of every tick across the requested symbols, newest at
// top. Polls /v1/ticks/tape at 1s — faster than the snapshot grid
// because operators reading the tape want low latency for "did we see
// X tick at exactly 09:35:22?" questions. Pause toggle lets the
// operator freeze the frame for careful reading.
//
// Hides entirely when no symbols are configured.

import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchTickTape } from '../../services/marketApi';
import { NEXUS_COLOR, withAlpha } from '../../styles/colors';
import { FONT_MONO } from '../../styles/fonts';
import { useLanguage } from '../../utils/i18n';
import type { MarketTickTapeEntry } from '../../types/api';

const POLL_INTERVAL_MS = 1000;
const TAPE_LIMIT       = 80;
const ROWS_VISIBLE     = 12;   // height of the scroll viewport, in rows

export interface TapePanelProps {
  symbols:    ReadonlyArray<string>;
  onSelect?:  ((id: string) => void) | undefined;
}

interface TapeState {
  entries:  ReadonlyArray<MarketTickTapeEntry>;
  receivedAt: number;
}

export function TapePanel({ symbols, onSelect }: TapePanelProps) {
  const { t } = useLanguage();
  const [state, setState] = useState<TapeState>({ entries: [], receivedAt: 0 });
  const [paused, setPaused] = useState(false);
  // pausedAtRef captures the frame the operator wants to inspect — when
  // we resume, the latest poll overwrites this snapshot and the tape
  // jumps forward. While paused, the frozen view stays exactly the
  // entries seen at the moment of pause, even though the underlying
  // database keeps accumulating.
  const pausedRef = useRef<TapeState | null>(null);

  useEffect(() => {
    if (symbols.length === 0) return;
    let mounted = true;
    let ctrl: AbortController | null = null;

    const pull = async () => {
      ctrl?.abort();
      ctrl = new AbortController();
      const result = await fetchTickTape(symbols, {
        limit:  TAPE_LIMIT,
        signal: ctrl.signal,
      });
      if (!mounted) return;
      if (result.ok) {
        if (paused && pausedRef.current === null) {
          // Pause kicked in mid-flight; freeze the current frame.
          // No state update needed — we keep showing the previous frame.
          return;
        }
        if (paused) return;
        setState({
          entries:    result.data.entries,
          receivedAt: Date.now(),
        });
      }
    };

    pull();
    const id = setInterval(pull, POLL_INTERVAL_MS);
    return () => {
      mounted = false;
      clearInterval(id);
      ctrl?.abort();
    };
  }, [symbols, paused]);

  // When pause is toggled ON, freeze the currently-displayed state into
  // pausedRef so we can restore it visually even if a stray poll-in-
  // flight wraps after the toggle. Operators see no flicker.
  useEffect(() => {
    if (paused) {
      pausedRef.current = state;
    } else {
      pausedRef.current = null;
    }
  }, [paused, state]);

  const togglePause = useCallback(() => setPaused(p => !p), []);

  if (symbols.length === 0) return null;

  const displayed = paused && pausedRef.current ? pausedRef.current.entries : state.entries;

  return (
    <section
      className="nx-panel"
      aria-label="Live Tape"
      data-testid="tape-panel"
      style={PANEL}
    >
      <header className="nx-panel__head">
        <div className="nx-panel__title">
          <span
            className={'nx-dot ' + (paused ? 'nx-dot--amber' : 'nx-dot--cyan nx-dot--pulse')}
          />
          <span>{t(paused ? 'hud.tape.paused' : 'hud.tape.live')}</span>
        </div>
        <button
          type="button"
          data-testid="tape-pause-toggle"
          onClick={togglePause}
          aria-pressed={paused}
          style={pauseBtnStyle(paused)}
          title={t(paused ? 'hud.tape.titleResume' : 'hud.tape.titlePause')}
        >
          {t(paused ? 'hud.tape.resume' : 'hud.tape.pause')}
        </button>
      </header>

      <div style={VIEWPORT}>
        {displayed.length === 0 && (
          <div style={EMPTY_HINT}>{t('hud.tape.empty')}</div>
        )}
        {displayed.length > 0 && (
          <ul style={LIST}>
            {displayed.map((t, i) => (
              <li
                key={`${t.ts}-${t.symbol}-${i}`}
                data-testid="tape-row"
                style={rowStyle(t.side)}
                role="button"
                tabIndex={0}
                onClick={() => onSelect?.(t.symbol)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect?.(t.symbol);
                  }
                }}
              >
                <span style={TS_TEXT}>{formatTs(t.ts)}</span>
                <span style={SYM_TEXT}>{t.symbol}</span>
                <span style={sideStyle(t.side)}>{t.side === 'buy' ? '▲' : '▼'}</span>
                <span style={PRICE_TEXT}>{formatPrice(t.price)}</span>
                <span style={VOL_TEXT}>×{t.volume.toLocaleString('en-US')}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

// ── helpers / styles ───────────────────────────────────────────────────

function formatTs(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatPrice(p: number): string {
  if (p >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (p >= 1)    return p.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return p.toFixed(4);
}

function rowStyle(side: 'buy' | 'sell'): React.CSSProperties {
  // Whisper-quiet row tint by side so the eye picks up trade direction
  // from row color in addition to the explicit arrow.
  return {
    display:       'grid',
    gridTemplateColumns: '70px 60px 12px 1fr auto',
    alignItems:    'center',
    gap:           8,
    padding:       '2px 8px',
    fontFamily:    FONT_MONO,
    fontSize:      9,
    cursor:        'pointer',
    background:    side === 'buy'
                    ? withAlpha(NEXUS_COLOR.lime, 0.02)
                    : withAlpha(NEXUS_COLOR.amber, 0.02),
  };
}

function sideStyle(side: 'buy' | 'sell'): React.CSSProperties {
  return {
    color:    side === 'buy' ? '#DEFF9A' : '#FFB200',
    fontSize: 8,
  };
}

function pauseBtnStyle(paused: boolean): React.CSSProperties {
  return {
    background:    'transparent',
    border:        '0.8px solid',
    borderColor:   paused ? NEXUS_COLOR.amber : withAlpha(NEXUS_COLOR.cyan, 0.30),
    color:         paused ? NEXUS_COLOR.amber : NEXUS_COLOR.cyan,
    padding:       '2px 8px',
    fontSize:      9,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    fontFamily:    FONT_MONO,
    cursor:        'pointer',
    borderRadius:  2,
  };
}

const PANEL: React.CSSProperties = {
  marginTop: 8,
};

const VIEWPORT: React.CSSProperties = {
  // ROWS_VISIBLE rows × ~14px (line-height of fontSize 9 with padding)
  maxHeight:      ROWS_VISIBLE * 16,
  overflowY:      'auto',
  scrollbarWidth: 'thin',
  scrollbarColor: `${withAlpha(NEXUS_COLOR.cyan, 0.35)} transparent`,
  padding:        '4px 0 8px',
};

const LIST: React.CSSProperties = {
  listStyle: 'none',
  margin:    0,
  padding:   0,
  display:   'flex',
  flexDirection: 'column',
};

const TS_TEXT: React.CSSProperties = {
  color:         '#8A93A8',
  fontVariantNumeric: 'tabular-nums',
};

const SYM_TEXT: React.CSSProperties = {
  color:         '#DEFF9A',
  fontWeight:    500,
};

const PRICE_TEXT: React.CSSProperties = {
  color:         '#E8ECF5',
  fontVariantNumeric: 'tabular-nums',
  textAlign:     'right',
};

const VOL_TEXT: React.CSSProperties = {
  color:         '#4A5066',
  fontVariantNumeric: 'tabular-nums',
};

const EMPTY_HINT: React.CSSProperties = {
  padding:       '20px 12px',
  color:         '#4A5066',
  fontSize:      10,
  textAlign:     'center',
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  fontFamily:    FONT_MONO,
};

// Scoped scrollbar styling — same approach as AuditModal, ::-webkit
// pseudo-elements can't be set via React style props. Idempotent ID
// guard avoids multiple style nodes on hot-reload.
if (typeof document !== 'undefined' && !document.getElementById('nx-tape-scroll-css')) {
  const style = document.createElement('style');
  style.id = 'nx-tape-scroll-css';
  style.textContent = `
    [data-testid="tape-panel"] ::-webkit-scrollbar { width: 6px; }
    [data-testid="tape-panel"] ::-webkit-scrollbar-track { background: transparent; }
    [data-testid="tape-panel"] ::-webkit-scrollbar-thumb { background: ${withAlpha(NEXUS_COLOR.cyan, 0.28)}; border-radius: 3px; }
    [data-testid="tape-panel"] ::-webkit-scrollbar-thumb:hover { background: ${withAlpha(NEXUS_COLOR.cyan, 0.55)}; }
  `;
  document.head.appendChild(style);
}
