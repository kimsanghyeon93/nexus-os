// MockStreamer — synthetic IMarketStreamer for the Test Harness.
//
// Drives two independent channels:
//   • onPacket   — emits at the configured frequencyHz; each packet carries
//                  small mutations the hook applies in-place to the dataset.
//   • onTelemetry — aggregated 4Hz tick (pktRate, latencyMs) used to drive
//                  the TopBar sparkline. Decoupled from the per-packet rate
//                  so 120 pkt/s does not translate into 120 React renders.
//
// triggerAnomaly() bypasses the schedule and fires a one-shot shock packet
// + AnomalyEvent so the App can promote the target to selectedId and let
// the existing 4-hop BFS wave do its job.

import type {
  AnomalyEvent,
  ConnectionState,
  IMarketStreamer,
  MarketPacket,
  TelemetrySample,
  Unsubscribe,
} from '../types/streamer';

const FREQ_MIN = 1;
const FREQ_MAX = 240;
const TELEMETRY_PERIOD_MS = 250;

const SYM_POOL: ReadonlyArray<string> = [
  'SMH', 'XLK', 'XLF', 'XLE', 'XLY', 'XLRE', 'VIX', 'DXY',
  'BTC', 'ETH', 'USDT', 'USDC',
  'EURUSD', 'USDJPY', 'USDCNH', 'USDKRW', 'GBPUSD',
  'UST10', 'UST2', 'BUND', 'JGB', 'KTB10',
  'WTI', 'BRT', 'XAU', 'XAG', 'CU', 'NG',
  'KOSPI', 'KRX_SEMI', 'KRX_BATT', 'KRX_AUTO', 'KRX_FIN', 'KRX_SHIP',
  'OBSIDIAN', 'HELIX', 'SAFFRON', 'NORDSEE', 'BAKU_TR',
  'TORNADO', 'WALLET_X', 'CYGNUS',
];

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

type Sub<T> = (v: T) => void;

export class MockStreamer implements IMarketStreamer {
  private freq = 30;
  private running = false;
  private packetTimer: ReturnType<typeof setInterval> | null = null;
  private telemetryTimer: ReturnType<typeof setInterval> | null = null;

  private packetSubs = new Set<Sub<MarketPacket>>();
  private telemetrySubs = new Set<Sub<TelemetrySample>>();
  private anomalySubs = new Set<Sub<AnomalyEvent>>();
  private connSubs = new Set<Sub<ConnectionState>>();
  private state: ConnectionState = 'disconnected';

  get connectionState(): ConnectionState { return this.state; }

  onConnectionStateChange(cb: Sub<ConnectionState>): Unsubscribe {
    this.connSubs.add(cb);
    return () => this.connSubs.delete(cb);
  }

  private setState(next: ConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    this.connSubs.forEach(cb => cb(next));
  }

  private sampleCount = 0;
  private lastTelemetryAt = 0;

  start(frequencyHz: number): void {
    if (this.running) this.stop();
    this.freq = clamp(frequencyHz, FREQ_MIN, FREQ_MAX);
    this.running = true;
    this.lastTelemetryAt = performance.now();
    this.scheduleEmitter();
    this.scheduleTelemetry();
    this.setState('connected');
  }

  stop(): void {
    this.running = false;
    if (this.packetTimer != null) {
      clearInterval(this.packetTimer);
      this.packetTimer = null;
    }
    if (this.telemetryTimer != null) {
      clearInterval(this.telemetryTimer);
      this.telemetryTimer = null;
    }
    this.setState('disconnected');
  }

  restart(): void {
    this.start(this.freq);
  }

  setFrequency(hz: number): void {
    this.freq = clamp(hz, FREQ_MIN, FREQ_MAX);
    if (this.running && this.packetTimer != null) {
      clearInterval(this.packetTimer);
      this.scheduleEmitter();
    }
  }

  triggerAnomaly(targetNodeId: string): void {
    const shock: MarketPacket = {
      ts: Date.now(),
      latencyMs: 4 + Math.random() * 6,
      mutations: [
        {
          entityId: targetNodeId,
          anomaly: 0.95,
          txVolDelta: 8000 + Math.random() * 6000,
        },
      ],
    };
    this.sampleCount++;
    this.fanoutPacket(shock);
    this.fanoutAnomaly({ targetId: targetNodeId });
  }

  onPacket(cb: Sub<MarketPacket>): Unsubscribe {
    this.packetSubs.add(cb);
    return () => this.packetSubs.delete(cb);
  }

  onTelemetry(cb: Sub<TelemetrySample>): Unsubscribe {
    this.telemetrySubs.add(cb);
    return () => this.telemetrySubs.delete(cb);
  }

  onAnomaly(cb: Sub<AnomalyEvent>): Unsubscribe {
    this.anomalySubs.add(cb);
    return () => this.anomalySubs.delete(cb);
  }

  private scheduleEmitter(): void {
    const intervalMs = Math.max(2, Math.round(1000 / this.freq));
    this.packetTimer = setInterval(() => this.emit(), intervalMs);
  }

  private scheduleTelemetry(): void {
    this.telemetryTimer = setInterval(() => {
      const now = performance.now();
      const dt = (now - this.lastTelemetryAt) / 1000;
      const rate = dt > 0 ? this.sampleCount / dt : 0;
      this.sampleCount = 0;
      this.lastTelemetryAt = now;
      const sample: TelemetrySample = {
        pktRate: Math.round(rate),
        latencyMs: 16 + Math.random() * 14,
      };
      this.fanoutTelemetry(sample);
    }, TELEMETRY_PERIOD_MS);
  }

  private emit(): void {
    const id = SYM_POOL[(Math.random() * SYM_POOL.length) | 0];
    // 4% of packets carry a small anomaly nudge; the rest are pure volume noise
    const mutateAnomaly = Math.random() < 0.04;
    const packet: MarketPacket = {
      ts: Date.now(),
      latencyMs: 14 + Math.random() * 18,
      mutations: [
        {
          entityId: id,
          txVolDelta: (Math.random() - 0.5) * 80,
          ...(mutateAnomaly
            ? { anomaly: clamp(0.5 + Math.random() * 0.5, 0, 0.99) }
            : {}),
        },
      ],
    };
    this.sampleCount++;
    this.fanoutPacket(packet);
  }

  private fanoutPacket(p: MarketPacket): void {
    this.packetSubs.forEach(cb => cb(p));
  }
  private fanoutTelemetry(t: TelemetrySample): void {
    this.telemetrySubs.forEach(cb => cb(t));
  }
  private fanoutAnomaly(e: AnomalyEvent): void {
    this.anomalySubs.forEach(cb => cb(e));
  }
}
