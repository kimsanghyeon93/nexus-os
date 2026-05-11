// CommandCenter — left column skeleton.
// Mock JARVIS-style command surface: status indicator, command list, hotkeys.
// All data here is placeholder until the real action runtime is wired.

interface Command {
  id: string;
  label: string;
  hotkey: string;
  /** rough relevance / state bucket — drives subtle accent variation */
  state: 'idle' | 'armed' | 'listening';
}

const COMMANDS: ReadonlyArray<Command> = [
  { id: 'analyze',  label: 'Analyze cluster',     hotkey: '⌘A', state: 'armed' },
  { id: 'snapshot', label: 'Capture snapshot',    hotkey: '⌘S', state: 'idle' },
  { id: 'isolate',  label: 'Isolate entity',      hotkey: '⌘I', state: 'idle' },
  { id: 'alert',    label: 'Raise alert',         hotkey: '⌘!', state: 'armed' },
  { id: 'replay',   label: 'Replay last shock',   hotkey: '⌘R', state: 'idle' },
  { id: 'trace',    label: 'Trace flow path',     hotkey: '⌘T', state: 'idle' },
  { id: 'audit',    label: 'Audit transactions',  hotkey: '⌘L', state: 'listening' },
  { id: 'tour',     label: 'Show help / tour',    hotkey: '?',  state: 'idle' },
];

export interface CommandCenterProps {
  status?: 'LISTENING' | 'STANDBY' | 'OFFLINE';
  /** Fired when an operator invokes a command. Currently the App handles
   *  'snapshot' (downloads dataset JSON + cinematic flash); other ids are
   *  reserved for future wiring. */
  onCommand?: (id: string) => void;
}

export function CommandCenter({ status = 'LISTENING', onCommand }: CommandCenterProps) {
  return (
    <aside className="nx-panel nx-cmd" aria-label="Command Center">
      <header className="nx-panel__head">
        <div className="nx-panel__title">
          <span className="nx-dot nx-dot--cyan nx-dot--pulse" />
          <span>COMMAND</span>
        </div>
        <span className="nx-panel__chev">▾</span>
      </header>

      <section className="nx-cmd__status">
        <div className="nx-label">SYSTEM</div>
        <div className="nx-cmd__status-row">
          <span className={`nx-status-pill nx-status-pill--${statusTone(status)}`}>
            {status}
          </span>
          <span className="nx-mono-dim" style={{ fontSize: 9 }}>READY</span>
        </div>
      </section>

      <section className="nx-cmd__list">
        <div className="nx-label">COMMANDS</div>
        <ul>
          {COMMANDS.map(c => (
            <li
              key={c.id}
              className={`nx-cmd__item nx-cmd__item--${c.state}`}
              role="button"
              tabIndex={0}
              data-testid={`command-${c.id}`}
              onClick={() => onCommand?.(c.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onCommand?.(c.id);
                }
              }}
            >
              <span className="nx-cmd__bullet" aria-hidden>›</span>
              <span className="nx-cmd__label">{c.label}</span>
              <span className="nx-cmd__hotkey">[{c.hotkey}]</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="nx-cmd__voice">
        <div className="nx-label">VOICE</div>
        <div className="nx-cmd__waveform" aria-hidden>
          {Array.from({ length: 24 }).map((_, i) => (
            <span
              key={i}
              className="nx-cmd__bar"
              style={{ animationDelay: `${(i % 6) * 80}ms` }}
            />
          ))}
        </div>
        {/* Sprint 5q+: the previous "...placeholder" hint leaked dev
            scaffolding into the operator surface. Replaced with the
            shortcut grammar the keystroke hotkeys actually consume so
            the waveform reads as a live coaching strip, not a stub. */}
        <div className="nx-mono-dim" style={{ fontSize: 9, marginTop: 6 }}>
          AWAITING COMMAND · ⌘ + A/I/T/L/R/S TO INVOKE
        </div>
      </section>

      <footer className="nx-panel__foot nx-mono-dim" style={{ fontSize: 9 }}>
        OPERATOR · J.VANCE · CLEARANCE Ω
      </footer>
    </aside>
  );
}

function statusTone(s: CommandCenterProps['status']): 'cyan' | 'amber' | 'low' {
  if (s === 'LISTENING') return 'cyan';
  if (s === 'STANDBY')   return 'amber';
  return 'low';
}
