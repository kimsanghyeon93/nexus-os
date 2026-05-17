// NexusTestbed — wraps <App /> with a fixed Harness Control Panel that
// drives the injected streamer.
//
// Sprint 5s "전면 개선" (frontend mock removal): the backend now publishes
// REAL prices for both KRX (KIS WS during 09–15:30 KST + Yahoo Finance
// `.KS` polling off-hours) and US (Yahoo Finance polling). Earlier
// frontend streamer surfaces — MomentumStreamer (AV proxy, 25/day cap),
// HanTooStreamer (KIS stub, no network), HybridStreamer (Sprint 5r
// dual-pipe composite) — became redundant once the backend's
// `nexus.market.tick` channel carries the full KRX+US universe at the
// same wire shape. They were deleted.
//
// The SOURCE control is now binary:
//   • BACKEND · LIVE  — production path. nexus-backend WS at
//                        ws://localhost:8001/v1/stream feeds KRX + US
//                        ticks. DEFAULT.
//   • OFFLINE · SIM   — MockStreamer random walk. Kept for the canvas
//                        to stay alive when the backend is unreachable
//                        (dev box without `docker compose up`, corp
//                        proxy outage, etc.). Operator must opt in.
//
// Switching source rebuilds the streamer; subscriptions inside <App /> rewire
// automatically because useMarketData re-runs its effect on streamer change.

import { useEffect, useMemo, useState } from 'react';
import App from '../App';
import { MockStreamer } from './MockStreamer';
import { BackendStreamer } from '../services/BackendStreamer';
import { NEXUS_COLOR, withAlpha } from '../styles/colors';
import { FONT_MONO } from '../styles/fonts';
import { useLanguage } from '../utils/i18n';
import { loadSourcePref, saveSourcePref } from '../utils/persistence';
import type { IMarketStreamer } from '../types/streamer';
import { useSystemHealth } from '../hooks/useSystemHealth';

const FREQ_MIN = 10;
const FREQ_MAX = 120;
/** Fallback shock target when nothing is selected on the radar. */
const DEFAULT_SHOCK_TARGET = 'KRX_SEMI';

/** Allowlist for both the union type and the persistence validator. Adding a
 *  new source requires updating this single tuple — TS keeps everything else
 *  in lockstep, and `loadSourcePref` will reject any stale localStorage value
 *  that's not in the current allowlist (so operators with an old
 *  'momentum-mock' / 'global-live' preference auto-fall-back to default). */
const SOURCES = ['backend-live', 'synthetic'] as const;
type Source = typeof SOURCES[number];

const SOURCE_LABEL: Record<Source, string> = {
  'backend-live':   'BACKEND · LIVE  ▴KRX+US',
  'synthetic':      'OFFLINE · SIM',
};

function makeStreamer(source: Source): IMarketStreamer {
  switch (source) {
    case 'backend-live':  return new BackendStreamer();
    case 'synthetic':     return new MockStreamer();
  }
}

export function NexusTestbed() {
  // Lazy initializer — read once on first mount. Subsequent renders ignore
  // localStorage so a tab that's been open across two storage events doesn't
  // flicker its source. Validated against SOURCES; bad/unknown values
  // (including stale 'momentum-mock' / 'global-live' / 'hantoo-stub' from
  // pre-5s sessions) auto-fall-back to 'backend-live' — the real-data path.
  const [source, setSource] = useState<Source>(() =>
    loadSourcePref(SOURCES, 'backend-live'),
  );
  const [freq, setFreq] = useState(30);
  // selectedId is lifted up so the harness's shock button can target whatever
  // entity the operator currently has locked on the radar / PropertyHUD.
  const [selectedId, setSelectedId] = useState<string | null>('OBSIDIAN');
  const { publisher, loading: healthLoading } = useSystemHealth();

  // Persist on every change. Best-effort — errors are swallowed inside
  // saveSourcePref so storage failures (Safari private mode, quota, etc.)
  // never crash the operator surface.
  useEffect(() => {
    saveSourcePref(source);
  }, [source]);

  // New streamer instance whenever source changes — old one is cleaned up
  // by useMarketData's effect cleanup.
  const streamer = useMemo<IMarketStreamer>(() => makeStreamer(source), [source]);

  useEffect(() => {
    streamer.start(freq);
    return () => streamer.stop();
    // freq goes through setFrequency; not a start trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamer]);

  useEffect(() => {
    streamer.setFrequency(freq);
  }, [freq, streamer]);

  const shockTarget = selectedId ?? DEFAULT_SHOCK_TARGET;

  // publisher 기반 배지 — backend-live 모드에서만 세분화
  const derivedSourceLabel = source === 'backend-live'
    ? (healthLoading
        ? SOURCE_LABEL['backend-live']
        : publisher === 'kis'  ? 'KIS LIVE  ▴KRX'
        : publisher === 'mock' ? 'BACKEND · MOCK'
        :                        'NO SOURCE')
    : SOURCE_LABEL[source];

  const derivedSourceKind: 'remote' | 'local' =
    source === 'backend-live' && publisher === 'kis' ? 'remote' : 'local';

  return (
    <App
      streamer={streamer}
      selectedId={selectedId}
      onSelectedChange={setSelectedId}
      sourceLabel={derivedSourceLabel}
      sourceKind={derivedSourceKind}
      harnessSlot={
        <HarnessPanel
          source={source}
          onSourceChange={setSource}
          freq={freq}
          onFreqChange={setFreq}
          shockTarget={shockTarget}
          onShock={() => streamer.triggerAnomaly(shockTarget)}
        />
      }
    />
  );
}

interface HarnessPanelProps {
  source: Source;
  onSourceChange: (s: Source) => void;
  freq: number;
  onFreqChange: (hz: number) => void;
  shockTarget: string;
  onShock: () => void;
}

function HarnessPanel({
  source, onSourceChange, freq, onFreqChange, shockTarget, onShock,
}: HarnessPanelProps) {
  const { t } = useLanguage();
  const fps = useFps();
  const fpsColor =
    fps >= 55 ? NEXUS_COLOR.cyan : fps >= 40 ? NEXUS_COLOR.amber : NEXUS_COLOR.lime;

  return (
    <div
      style={{
        padding: '12px 14px',
        background: 'transparent',
        color: NEXUS_COLOR.bone,
        // Sprint 5s+ loop: was '"JetBrains Mono", monospace' — missing
        // the `ui-monospace` step every other HUD surface includes.
        // Normalized to FONT_MONO so the harness panel renders with
        // the same fallback stack as the panels it wraps.
        fontFamily: FONT_MONO,
        fontSize: 10,
        letterSpacing: '0.06em',
        userSelect: 'none',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 10,
        }}
      >
        <div style={{ color: NEXUS_COLOR.cyan, fontWeight: 600 }}>
          {t('harness.title')}
        </div>
        <div style={{ color: fpsColor }}>{t('harness.fps', { n: fps })}</div>
      </div>

      {/* Source selector — binary post-5s. BACKEND·LIVE is the production
          path (real KRX+US ticks); OFFLINE·SIM is the fallback when the
          backend can't be reached. Two-button row, equal width. */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ color: NEXUS_COLOR.ash, marginBottom: 4 }}>{t('harness.source')}</div>
        <div style={{ display: 'flex', gap: 4 }}>
          {SOURCES.map(s => {
            const active = s === source;
            return (
              <button
                key={s}
                type="button"
                data-testid={`source-${s}`}
                onClick={() => onSourceChange(s)}
                style={{
                  flex: '1 1 0',
                  minWidth: 0,
                  padding: '6px 4px',
                  background: active ? withAlpha(NEXUS_COLOR.cyan, 0.12) : 'transparent',
                  color: active ? NEXUS_COLOR.cyan : NEXUS_COLOR.ash,
                  // Sprint 5s+: `#2A2D44` is the harness panel's structural
                  // border tone — darker than NEXUS_COLOR.low so it reads
                  // as inactive UI chrome instead of a content separator.
                  // Not in NEXUS_COLOR; keeping the literal here as the
                  // single defined usage. Future tokenize if it spreads.
                  border: `1px solid ${active ? withAlpha(NEXUS_COLOR.cyan, 0.55) : '#2A2D44'}`,
                  borderRadius: 2,
                  fontFamily: 'inherit',
                  fontSize: 9,
                  letterSpacing: '0.08em',
                  cursor: 'pointer',
                }}
              >
                {t(s === 'backend-live' ? 'harness.source.backend' : 'harness.source.offline')}
              </button>
            );
          })}
        </div>
      </div>

      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 6,
          color: NEXUS_COLOR.ash,
        }}
      >
        <span>{t('harness.frequency')}</span>
        <span style={{ color: NEXUS_COLOR.cyan }}>{t('harness.freqUnit', { n: freq })}</span>
      </label>
      <input
        type="range"
        min={FREQ_MIN}
        max={FREQ_MAX}
        step={1}
        value={freq}
        onChange={e => onFreqChange(Number(e.target.value))}
        style={{ width: '100%', accentColor: NEXUS_COLOR.cyan, marginBottom: 12 }}
      />

      <button
        type="button"
        data-testid="shock-button"
        onClick={onShock}
        style={{
          display: 'block',
          width: '100%',
          padding: '8px 10px',
          background: 'transparent',
          color: NEXUS_COLOR.lime,
          border: `1px solid ${NEXUS_COLOR.lime}`,
          borderRadius: 3,
          fontFamily: 'inherit',
          fontSize: 10,
          letterSpacing: '0.10em',
          fontWeight: 600,
          cursor: 'pointer',
          textTransform: 'uppercase',
          boxShadow: `0 0 12px ${withAlpha(NEXUS_COLOR.lime, 0.18)}`,
        }}
      >
        {t('harness.shock', { target: shockTarget })}
      </button>

      <div
        style={{
          marginTop: 10,
          fontSize: 9,
          color: NEXUS_COLOR.low,
          lineHeight: 1.5,
        }}
      >
        {source === 'backend-live'
          ? t('harness.source.backendDesc')
          : t('harness.source.offlineDesc', { max: FREQ_MAX })}
      </div>
    </div>
  );
}

function useFps(): number {
  const [fps, setFps] = useState(60);
  useEffect(() => {
    let raf = 0;
    let frames = 0;
    let last = performance.now();
    const tick = (now: number) => {
      frames++;
      if (now - last >= 500) {
        setFps(Math.round((frames * 1000) / (now - last)));
        frames = 0;
        last = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return fps;
}
