// CaptureHistory — compact JARVIS-style audit list at the bottom of the
// right column. Shows the last N (default 5) snapshots with a RE-DL action
// per item that re-emits the exact byte sequence captured originally.
//
// The "new entry" pulse is keyed off the most recent entry id — the topmost
// row briefly pulses cyan when a fresh capture lands.

import type { SnapshotEntry } from '../../utils/snapshot';

export interface CaptureHistoryProps {
  entries: ReadonlyArray<SnapshotEntry>;
  /** Re-trigger download for a stored entry by id. */
  onReplay: (id: string) => void;
  /** Id of the entry that should pulse as "newly added". null when idle. */
  pulseId: string | null;
}

export function CaptureHistory({ entries, onReplay, pulseId }: CaptureHistoryProps) {
  return (
    <section className="nx-hist" aria-label="Capture History">
      <header className="nx-hist__head">
        <div className="nx-hist__title">
          <span className="nx-dot nx-dot--cyan" />
          <span>CAPTURE HISTORY</span>
        </div>
        <span className="nx-mono-dim nx-hist__count">
          {entries.length}/5
        </span>
      </header>

      {entries.length === 0 ? (
        <div className="nx-hist__empty">
          NO CAPTURES — ⌘S TO BEGIN AUDIT TRAIL
        </div>
      ) : (
        <ul className="nx-hist__list">
          {entries.map((e, i) => (
            <li
              key={e.id}
              className={
                'nx-hist__item' +
                (e.id === pulseId ? ' nx-hist__item--pulse' : '')
              }
              data-testid={`history-item-${i}`}
            >
              <div className="nx-hist__row">
                <span className="nx-hist__idx">#{entries.length - i}</span>
                <span className="nx-hist__time">{formatTime(e.capturedAt)}</span>
                <span className="nx-hist__nodes">{e.nodeCount}n</span>
                <span className="nx-hist__size">{formatBytes(e.bytes)}</span>
                <button
                  type="button"
                  className="nx-hist__redl"
                  data-testid={`history-redl-${i}`}
                  onClick={() => onReplay(e.id)}
                  title={`Re-download ${e.filename}`}
                  aria-label={`Re-download ${e.filename}`}
                >
                  ↓ RE-DL
                </button>
              </div>
              <div className="nx-hist__fname" title={e.filename}>
                {e.filename}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}
