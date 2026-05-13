// CommandCenter — left column "operator communication center".
// Sprint 5s+ cleanup: the inline COMMANDS list was the same 8 hotkey
// entries the TopBar ⌘ ACTIONS palette renders, just less discoverable.
// Removed to eliminate the duplicate surface. CommandCenter now focuses
// on the three operator-to-system pipes:
//
//   1. SYSTEM     — connection status pill (LISTENING / STANDBY / OFFLINE)
//   2. VOICE      — real Web Speech API toggle + amplitude-driven waveform
//   3. NAV HINT   — small footer reminder for ⌘ ACTIONS / ▣ ASSISTANT
//
// Voice flow:
//   • Operator clicks the VOICE toggle → useVoiceCommand requests mic
//     permission. On grant, a SpeechRecognition session + an AnalyserNode
//     pipeline both spin up.
//   • Recognized phrases are matched against the vocab in
//     useVoiceCommand.ts (English + Korean for every hotkey command).
//     A hit fires onCommand(id) — the same callback the toolbar/hotkey
//     paths use, so voice is just another invocation surface.
//   • The waveform bars are driven by the AnalyserNode amplitude
//     instead of a placeholder CSS animation, so the visualization
//     reflects actual mic input.
//   • Firefox / Safari < 14.1 ship no SpeechRecognition; the toggle is
//     replaced with a clear "UNSUPPORTED" pill in that case.

import { useVoiceCommand } from '../../hooks/useVoiceCommand';
import { NEXUS_COLOR, withAlpha } from '../../styles/colors';
import { FONT_MONO } from '../../styles/fonts';
import { useLanguage } from '../../utils/i18n';
import { getOperatorIdentity } from '../../utils/operator';

export interface CommandCenterProps {
  status?: 'LISTENING' | 'STANDBY' | 'OFFLINE';
  /** Fired when an operator invokes a command. Currently the App handles
   *  'snapshot' (downloads dataset JSON + cinematic flash); other ids are
   *  reserved for future wiring. */
  onCommand?: (id: string) => void;
}

const WAVE_BAR_COUNT = 24;

export function CommandCenter({ status = 'LISTENING', onCommand }: CommandCenterProps) {
  // Sprint 5s+ voice command. The hook lazily starts SpeechRecognition +
  // an AnalyserNode pipe on toggle; until the operator opts in we render
  // an idle "VOICE · OFF" state and zero amplitude so the bars sit at
  // their resting height. A no-op onCommand handler is safe — toggling
  // ON without a parent listener still demonstrates mic activity.
  const voice = useVoiceCommand({ onCommand: id => onCommand?.(id) });
  const { t } = useLanguage();
  const statusKey =
    status === 'LISTENING' ? 'cmd.status.listening'
    : status === 'STANDBY' ? 'cmd.status.standby'
    : 'cmd.status.offline';
  const op = getOperatorIdentity();

  return (
    <aside className="nx-panel nx-cmd" aria-label="Command Center">
      <header className="nx-panel__head">
        <div className="nx-panel__title">
          <span className="nx-dot nx-dot--cyan nx-dot--pulse" />
          <span>{t('cmd.title')}</span>
        </div>
        <span className="nx-panel__chev">▾</span>
      </header>

      <section className="nx-cmd__status">
        <div className="nx-label">{t('cmd.system')}</div>
        <div className="nx-cmd__status-row">
          <span className={`nx-status-pill nx-status-pill--${statusTone(status)}`}>
            {t(statusKey)}
          </span>
          <span className="nx-mono-dim" style={{ fontSize: 9 }}>{t('cmd.ready')}</span>
        </div>
      </section>

      {/* Sprint 5s+: the inline COMMANDS list moved to ⌘ ACTIONS in the
          top toolbar. Operators reach the same 8 hotkey commands either
          via the palette (1 click), the global hotkeys (⌘A/S/I/T/L/R/!),
          or voice. Keeping the list here too was pure duplication. */}
      <section className="nx-cmd__nav">
        <div className="nx-label">{t('cmd.nav')}</div>
        <div className="nx-mono-dim" style={{ fontSize: 9, lineHeight: 1.7, padding: '4px 0' }}>
          {t('cmd.nav.actions')}<br />
          {t('cmd.nav.assistant')}<br />
          {t('cmd.nav.snapshots')}<br />
          {t('cmd.nav.investigations')}
        </div>
      </section>

      <section className="nx-cmd__voice">
        <div
          className="nx-label"
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <span>{t('cmd.voice')}</span>
          {voice.supported ? (
            <button
              type="button"
              data-testid="voice-toggle"
              onClick={voice.toggle}
              style={voiceToggleStyle(voice.enabled, voice.error !== null)}
              aria-pressed={voice.enabled}
              title={voice.enabled ? t('cmd.voice.titleOn') : t('cmd.voice.titleOff')}
            >
              {t(voice.enabled ? 'cmd.voice.on' : 'cmd.voice.off')}
            </button>
          ) : (
            <span style={{ color: NEXUS_COLOR.amber, fontSize: 9, letterSpacing: '0.08em' }}>
              {t('cmd.voice.unsupported')}
            </span>
          )}
        </div>
        <div
          className="nx-cmd__waveform"
          aria-hidden
          data-active={voice.enabled ? 'true' : 'false'}
        >
          {Array.from({ length: WAVE_BAR_COUNT }).map((_, i) => {
            // When voice is ON, drive bar heights from the live
            // amplitude. The (1 + sin)/2 envelope adds a soft wave so
            // adjacent bars don't all collapse to the same height when
            // amplitude is mid-range — preserving the "waveform" read
            // even at constant volume. When OFF, fall back to the
            // pre-5s+ CSS animation (animationDelay only, no height
            // override) so the panel still has a heartbeat.
            const phase = (i / WAVE_BAR_COUNT) * Math.PI * 2;
            const envelope = (1 + Math.sin(phase * 2 + i * 0.6)) * 0.5;
            const live = voice.enabled
              ? 0.18 + voice.amplitude * (0.5 + envelope * 0.5)
              : null;
            return (
              <span
                key={i}
                className="nx-cmd__bar"
                style={{
                  animationDelay: `${(i % 6) * 80}ms`,
                  ...(live !== null
                    ? { animation: 'none', height: `${Math.round(live * 100)}%` }
                    : null),
                }}
              />
            );
          })}
        </div>
        <div className="nx-mono-dim" style={{ fontSize: 9, marginTop: 6 }}>
          {voice.error
            ? voiceErrorHintI18n(voice.error, t)
            : voice.enabled
              ? voice.lastPhrase
                ? t('cmd.voice.heard', {
                    phrase: voice.lastPhrase,
                    cmd: voice.lastCommand?.toUpperCase() ?? '—',
                  })
                : t('cmd.voice.listening')
              : t('cmd.voice.awaiting')}
        </div>
      </section>

      <footer className="nx-panel__foot nx-mono-dim" style={{ fontSize: 9 }}>
        {t('cmd.footer.operator', { name: op.name, clearance: op.clearance })}
      </footer>
    </aside>
  );
}

function statusTone(s: CommandCenterProps['status']): 'cyan' | 'amber' | 'low' {
  if (s === 'LISTENING') return 'cyan';
  if (s === 'STANDBY')   return 'amber';
  return 'low';
}

function voiceToggleStyle(active: boolean, errored: boolean): React.CSSProperties {
  const border = errored
    ? NEXUS_COLOR.amber
    : active
      ? NEXUS_COLOR.lime
      : withAlpha(NEXUS_COLOR.cyan, 0.40);
  const color = errored ? NEXUS_COLOR.amber : active ? NEXUS_COLOR.lime : NEXUS_COLOR.cyan;
  return {
    background:    'transparent',
    border:        `0.8px solid ${border}`,
    color,
    padding:       '2px 8px',
    fontSize:      9,
    letterSpacing: '0.08em',
    fontFamily:    FONT_MONO,
    cursor:        'pointer',
    borderRadius:  2,
  };
}

// Sprint 5s+ iter 10: i18n-aware variant. Operator-readable hints are
// now translated; the SpeechRecognition error codes themselves stay as
// the upper-case literals the W3C spec defines.
function voiceErrorHintI18n(
  code: string,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return t('cmd.voice.err.notAllowed');
    case 'audio-capture':
      return t('cmd.voice.err.noMic');
    case 'unsupported':
      return t('cmd.voice.err.unsupported');
    case 'NotFoundError':
      return t('cmd.voice.err.noMic');
    case 'NotAllowedError':
      return t('cmd.voice.err.permission');
    default:
      return t('cmd.voice.err.generic', { code: code.toUpperCase() });
  }
}
