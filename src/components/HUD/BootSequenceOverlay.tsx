// BootSequenceOverlay — first-run JARVIS boot sequence.
//
// Custom-built (no react-joyride / Shepherd dependency) so the look is bespoke
// to NEXUS OS: monospaced typewriter reveal, glassmorphic centered frame,
// cyan glow, ARIA-correct dialog. Triggered once per browser via
// localStorage('nexus_os_v1_tour_seen').
//
// The component is dumb — it only types out the briefing and listens for ESC.
// Persistence is the parent's job; we just call onDismiss() when the operator
// acknowledges, so the tour can also be re-shown on demand later.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLanguage } from '../../utils/i18n';

interface BootSequenceOverlayProps {
  onDismiss: () => void;
}

/** Briefing line keys — i18n values come from `boot.l0` … `boot.l5` so a
 *  language flip mid-boot replays the typewriter in the new tongue. */
const BRIEFING_KEYS: ReadonlyArray<string> = [
  'boot.l0', '', 'boot.l1', 'boot.l2', 'boot.l3', 'boot.l4', 'boot.l5',
];

/** Typewriter timing. Tuned for legibility — slow enough to feel ceremonial,
 *  fast enough to not feel sluggish. */
const CHAR_INTERVAL_MS = 18;
const LINE_PAUSE_MS    = 90;
const PRE_DELAY_MS     = 240;
const FADE_OUT_MS      = 320;

interface RevealState {
  /** Index of the line currently being typed (or done). */
  line: number;
  /** Number of chars revealed on the current line. */
  col: number;
}

export function BootSequenceOverlay({ onDismiss }: BootSequenceOverlayProps) {
  const { t, lang } = useLanguage();
  // Translate the briefing once per render; the typewriter reveal reads
  // from this array. Memoized so the reveal effect dep on it stays stable
  // unless the language flips.
  const BRIEFING_LINES = useMemo<ReadonlyArray<string>>(
    () => BRIEFING_KEYS.map(k => (k === '' ? '' : t(k))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lang],
  );
  const [reveal, setReveal] = useState<RevealState>({ line: 0, col: 0 });
  const [fadingOut, setFadingOut] = useState(false);

  const completed = reveal.line >= BRIEFING_LINES.length;

  // Typewriter — single chained-timeout driver, cancellable on unmount.
  useEffect(() => {
    if (fadingOut) return;
    let cancelled = false;
    let line = 0;
    let col = 0;

    const tick = () => {
      if (cancelled) return;
      if (line >= BRIEFING_LINES.length) {
        setReveal({ line, col: 0 });
        return;
      }
      const cur = BRIEFING_LINES[line];
      if (cur === undefined) return;
      if (col >= cur.length) {
        // Move to next line after a longer pause for visual rhythm.
        line += 1;
        col = 0;
        setReveal({ line, col });
        window.setTimeout(tick, LINE_PAUSE_MS);
        return;
      }
      col += 1;
      setReveal({ line, col });
      window.setTimeout(tick, CHAR_INTERVAL_MS);
    };

    const initial = window.setTimeout(tick, PRE_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(initial);
    };
  }, [fadingOut, BRIEFING_LINES]);

  // Ack handler — ESC starts the fade, fade end calls onDismiss.
  // Wrapped in a ref-stable callback so the keydown listener doesn't churn.
  const dismissTimerRef = useRef<number | null>(null);
  const acknowledge = useCallback(() => {
    if (fadingOut) return;
    setFadingOut(true);
    dismissTimerRef.current = window.setTimeout(onDismiss, FADE_OUT_MS);
  }, [fadingOut, onDismiss]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        acknowledge();
      }
    };
    // capture phase so the overlay's ESC wins over any other listeners that
    // might process Escape (none today, but future-proof).
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [acknowledge]);

  // Cleanup any in-flight fade timer if the component unmounts mid-fade.
  useEffect(() => {
    return () => {
      if (dismissTimerRef.current != null) {
        window.clearTimeout(dismissTimerRef.current);
      }
    };
  }, []);

  return (
    <div
      className={'nx-boot' + (fadingOut ? ' nx-boot--fading' : '')}
      role="dialog"
      aria-modal="true"
      aria-labelledby="nx-boot-title"
      data-testid="boot-sequence"
      onClick={acknowledge}
    >
      <div
        className="nx-boot__frame"
        onClick={e => e.stopPropagation() /* clicks inside frame don't dismiss */}
      >
        <div className="nx-boot__corner nx-boot__corner--tl" aria-hidden>┌</div>
        <div className="nx-boot__corner nx-boot__corner--tr" aria-hidden>┐</div>
        <div className="nx-boot__corner nx-boot__corner--bl" aria-hidden>└</div>
        <div className="nx-boot__corner nx-boot__corner--br" aria-hidden>┘</div>

        <div id="nx-boot-title" className="nx-boot__lines">
          {BRIEFING_LINES.map((line, i) => {
            let shown = '';
            let showCursor = false;
            if (i < reveal.line) {
              shown = line;
            } else if (i === reveal.line && !completed) {
              shown = line.slice(0, reveal.col);
              showCursor = true;
            }
            const isHeader = line.startsWith('[');
            return (
              <div
                key={i}
                className={
                  'nx-boot__line' +
                  (isHeader ? ' nx-boot__line--head' : '') +
                  (line === '' ? ' nx-boot__line--break' : '')
                }
              >
                {shown || ' '/* keep height */}
                {showCursor && <span className="nx-boot__cursor" aria-hidden>▌</span>}
              </div>
            );
          })}
        </div>

        <div
          className={'nx-boot__ack' + (completed ? ' nx-boot__ack--ready' : '')}
          aria-live="polite"
        >
          [ PRESS <kbd className="nx-boot__kbd">ESC</kbd> TO ACKNOWLEDGE ]
        </div>
      </div>
    </div>
  );
}
