// NexusTestbed — wraps <App /> with a fixed Harness Control Panel that
// drives the injected streamer.
//
// The streamer is selected at runtime via the SOURCE control:
//   • SYNTHETIC      — MockStreamer (random walk over the synthetic universe)
//   • MOMENTUM/MOCK  — MomentumStreamer in 'mock' mode (Momentum US universe,
//                      no network) — drives the existing NEXUS sector entities
//   • MOMENTUM/LIVE  — MomentumStreamer hitting the Alpha Vantage proxy
//   • HANTOO/STUB    — KIS OpenAPI scaffold, no network
//   • BACKEND/LIVE   — connects to ws://localhost:8000/v1/stream; the
//                      nexus-backend mock publisher (or KIS adapter once
//                      4c lands) drives the canvas
//
// Switching source rebuilds the streamer; subscriptions inside <App /> rewire
// automatically because useMarketData re-runs its effect on streamer change.

import { useEffect, useMemo, useState } from 'react';
import App from '../App';
import { MockStreamer } from './MockStreamer';
import { MomentumStreamer } from '../adapters/MomentumStreamer';
import { HanTooStreamer } from '../adapters/HanTooStreamer';
import { BackendStreamer } from '../services/BackendStreamer';
import { loadSourcePref, saveSourcePref } from '../utils/persistence';
import type { IMarketStreamer } from '../types/streamer';

const FREQ_MIN = 10;
const FREQ_MAX = 120;
/** Fallback shock target when nothing is selected on the radar. */
const DEFAULT_SHOCK_TARGET = 'KRX_SEMI';

/** Allowlist for both the union type and the persistence validator. Adding a
 *  new source requires updating this single tuple — TS keeps everything else
 *  in lockstep, and `loadSourcePref` will reject any stale localStorage value
 *  that's not in the current allowlist. */
const SOURCES = ['synthetic', 'momentum-mock', 'momentum-live', 'hantoo-stub', 'backend-live'] as const;
type Source = typeof SOURCES[number];

const SOURCE_LABEL: Record<Source, string> = {
  'synthetic':      'SYNTHETIC',
  'momentum-mock':  'MOMENTUM · MOCK',
  'momentum-live':  'MOMENTUM · LIVE',
  'hantoo-stub':    'HANTOO · STUB',
  'backend-live':   'BACKEND · LIVE',
};

function makeStreamer(source: Source): IMarketStreamer {
  switch (source) {
    case 'synthetic':     return new MockStreamer();
    case 'momentum-mock': return new MomentumStreamer({ source: 'mock' });
    case 'momentum-live': return new MomentumStreamer({ source: 'live' });
    case 'hantoo-stub':   return new HanTooStreamer({ stubMode: true });
    case 'backend-live':  return new BackendStreamer();
  }
}

export function NexusTestbed() {
  // Lazy initializer — read once on first mount. Subsequent renders ignore
  // localStorage so a tab that's been open across two storage events doesn't
  // flicker its source. Validated against SOURCES; bad/unknown values fall
  // back to 'synthetic'.
  const [source, setSource] = useState<Source>(() =>
    loadSourcePref(SOURCES, 'synthetic'),
  );
  const [freq, setFreq] = useState(30);
  // selectedId is lifted up so the harness's shock button can target whatever
  // entity the operator currently has locked on the radar / PropertyHUD.
  const [selectedId, setSelectedId] = useState<string | null>('OBSIDIAN');

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

  return (
    <App
      streamer={streamer}
      selectedId={selectedId}
      onSelectedChange={setSelectedId}
      sourceLabel={SOURCE_LABEL[source]}
      sourceKind={source === 'backend-live' ? 'remote' : 'local'}
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
  const fps = useFps();
  const fpsColor =
    fps >= 55 ? '#00BFFF' : fps >= 40 ? '#FFB200' : '#DEFF9A';

  return (
    <div
      style={{
        padding: '12px 14px',
        background: 'transparent',
        color: '#E8ECF5',
        fontFamily: '"JetBrains Mono", monospace',
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
        <div style={{ color: '#00BFFF', fontWeight: 600 }}>
          ◆ HARNESS · DATA INJECTION
        </div>
        <div style={{ color: fpsColor }}>{fps} FPS</div>
      </div>

      {/* Source selector — driven by SOURCES so adding a new option in the
          tuple at the top of the file flows through here automatically. */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ color: '#8A93A8', marginBottom: 4 }}>SOURCE</div>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {SOURCES.map(s => {
            const active = s === source;
            return (
              <button
                key={s}
                type="button"
                data-testid={`source-${s}`}
                onClick={() => onSourceChange(s)}
                style={{
                  flex: '1 1 calc(33% - 4px)',
                  minWidth: 0,
                  padding: '5px 4px',
                  background: active ? 'rgba(0, 191, 255, 0.12)' : 'transparent',
                  color: active ? '#00BFFF' : '#8A93A8',
                  border: `1px solid ${active ? 'rgba(0, 191, 255, 0.55)' : '#2A2D44'}`,
                  borderRadius: 2,
                  fontFamily: 'inherit',
                  fontSize: 9,
                  letterSpacing: '0.08em',
                  cursor: 'pointer',
                }}
              >
                {SOURCE_LABEL[s]}
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
          color: '#8A93A8',
        }}
      >
        <span>FREQUENCY</span>
        <span style={{ color: '#00BFFF' }}>{freq} pkt/s</span>
      </label>
      <input
        type="range"
        min={FREQ_MIN}
        max={FREQ_MAX}
        step={1}
        value={freq}
        onChange={e => onFreqChange(Number(e.target.value))}
        style={{ width: '100%', accentColor: '#00BFFF', marginBottom: 12 }}
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
          color: '#DEFF9A',
          border: '1px solid #DEFF9A',
          borderRadius: 3,
          fontFamily: 'inherit',
          fontSize: 10,
          letterSpacing: '0.10em',
          fontWeight: 600,
          cursor: 'pointer',
          textTransform: 'uppercase',
          boxShadow: '0 0 12px rgba(222, 255, 154, 0.18)',
        }}
      >
        ▲ Simulate Market Shock · {shockTarget}
      </button>

      <div
        style={{
          marginTop: 10,
          fontSize: 9,
          color: '#4A5066',
          lineHeight: 1.5,
        }}
      >
        {source === 'backend-live'
          ? 'WS → ws://localhost:8000/v1/stream · nexus-backend mock publisher feeds 12 KRX symbols.'
          : source === 'hantoo-stub'
          ? 'KIS OpenAPI scaffold. No network. KRX entities ticking.'
          : source === 'momentum-live'
          ? 'Live polls Alpha Vantage proxy (~30s/batch). 28 tickers.'
          : source === 'momentum-mock'
          ? 'Momentum cluster live — 28 US tickers, |Δ%|≥7 → lime.'
          : `Slide to ${FREQ_MAX} pkt/s to stress the canvas.`}
        <br />
        Shock fires a 4-hop cascading ripple.
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
