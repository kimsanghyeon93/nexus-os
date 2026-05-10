// BackendStreamer — IMarketStreamer that subscribes to the nexus-backend
// /v1/stream WebSocket. Implements the same contract as MockStreamer /
// MomentumStreamer / HanTooStreamer so it slots into App.tsx without
// touching useMarketData or any HUD component.
//
// Wire format: each frame on the socket is a JSON tick produced by the
// backend mock publisher (or the real KIS adapter once Sprint 4c lands):
//
//   { symbol, ts, price, volume, side }
//
// Mapping to the frontend MarketPacket: each tick becomes one packet
// with one EntityMutation.txVolDelta. Anomaly is left to the backend
// analysis module — until that emits its own channel, BackendStreamer
// does NOT fabricate anomaly values client-side.

import type {
  AnomalyEvent,
  ConnectionState,
  IMarketStreamer,
  MarketPacket,
  TelemetrySample,
  Unsubscribe,
} from '../types/streamer';

interface BackendTick {
  symbol: string;
  ts:     string;
  price:  number;
  volume: number;
  side:   'buy' | 'sell';
}

const TELEMETRY_INTERVAL_MS = 1000;

export class BackendStreamer implements IMarketStreamer {
  private ws:        WebSocket | null = null;
  private freq:      number = 1;       // Hz — accepted but ignored (backend owns cadence)
  private _state:    ConnectionState   = 'disconnected';

  private packetSubs:    Set<(p: MarketPacket) => void>     = new Set();
  private telemetrySubs: Set<(t: TelemetrySample) => void>  = new Set();
  private anomalySubs:   Set<(e: AnomalyEvent) => void>     = new Set();
  private stateSubs:     Set<(s: ConnectionState) => void>  = new Set();

  // Telemetry accumulators — packets-per-second is computed on a 1s timer
  // rather than every-message to match the existing streamers' cadence.
  private pktCounter:      number = 0;
  private telemetryTimer:  number | null = null;

  constructor(private url: string = 'ws://localhost:8001/v1/stream') {}

  // ── IMarketStreamer ──────────────────────────────────────────────────

  start(frequencyHz: number): void {
    this.freq = frequencyHz;
    if (this.ws !== null) return;          // idempotent — already connecting / connected
    this.setState('connecting');

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch {
      this.setState('failed');
      return;
    }

    this.ws = socket;

    socket.onopen = () => {
      this.setState('connected');
      this.startTelemetryTimer();
    };

    socket.onmessage = (ev: MessageEvent) => {
      const tick = this.parseTick(ev.data);
      if (tick === null) return;
      this.pktCounter += 1;

      const packet: MarketPacket = {
        ts:        Date.now(),
        latencyMs: 0,                       // backend pre-aggregated; no transport stamp yet
        mutations: [{
          entityId:    tick.symbol,
          txVolDelta:  tick.volume,
        }],
      };
      for (const cb of this.packetSubs) cb(packet);
    };

    socket.onerror = () => {
      this.setState('failed');
    };

    socket.onclose = () => {
      this.stopTelemetryTimer();
      this.ws = null;
      // Don't override 'failed' — onerror fires before onclose on hard fail.
      if (this._state !== 'failed') this.setState('disconnected');
    };
  }

  stop(): void {
    this.stopTelemetryTimer();
    if (this.ws !== null) {
      this.ws.close();
      // onclose handler will null out this.ws and update state.
    } else {
      this.setState('disconnected');
    }
  }

  restart(): void {
    this.stop();
    // Defer so the close handler can run before a new connect. Without
    // this, the new socket can race onclose of the old one.
    queueMicrotask(() => this.start(this.freq));
  }

  setFrequency(hz: number): void {
    // Backend owns cadence (mock publisher emits ~2 ticks/sec). We retain
    // the value so restart() can pass it back through start(), preserving
    // the IMarketStreamer contract.
    this.freq = hz;
  }

  triggerAnomaly(targetNodeId: string): void {
    // Backend ignores client-side shock requests — its anomaly source is
    // the analysis module. We still notify local subscribers so UI shock
    // animations stay snappy without a server round-trip.
    const evt: AnomalyEvent = { targetId: targetNodeId };
    for (const cb of this.anomalySubs) cb(evt);
  }

  // ── Subscription helpers ────────────────────────────────────────────

  onPacket(cb: (p: MarketPacket) => void): Unsubscribe {
    this.packetSubs.add(cb);
    return () => { this.packetSubs.delete(cb); };
  }

  onTelemetry(cb: (t: TelemetrySample) => void): Unsubscribe {
    this.telemetrySubs.add(cb);
    return () => { this.telemetrySubs.delete(cb); };
  }

  onAnomaly(cb: (e: AnomalyEvent) => void): Unsubscribe {
    this.anomalySubs.add(cb);
    return () => { this.anomalySubs.delete(cb); };
  }

  get connectionState(): ConnectionState {
    return this._state;
  }

  onConnectionStateChange(cb: (s: ConnectionState) => void): Unsubscribe {
    this.stateSubs.add(cb);
    return () => { this.stateSubs.delete(cb); };
  }

  // ── Internals ───────────────────────────────────────────────────────

  private parseTick(raw: unknown): BackendTick | null {
    if (typeof raw !== 'string') return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;                           // probably a heartbeat / non-tick frame
    }
    if (!parsed || typeof parsed !== 'object') return null;

    const t = parsed as Partial<BackendTick>;
    if (typeof t.symbol !== 'string') return null;
    if (typeof t.price  !== 'number') return null;
    if (typeof t.volume !== 'number') return null;
    if (typeof t.ts     !== 'string') return null;
    if (t.side !== 'buy' && t.side !== 'sell') return null;
    return t as BackendTick;
  }

  private setState(next: ConnectionState): void {
    if (this._state === next) return;
    this._state = next;
    for (const cb of this.stateSubs) cb(next);
  }

  private startTelemetryTimer(): void {
    if (this.telemetryTimer !== null) return;
    this.telemetryTimer = window.setInterval(() => {
      const sample: TelemetrySample = {
        pktRate:   this.pktCounter,
        latencyMs: 0,
      };
      this.pktCounter = 0;
      for (const cb of this.telemetrySubs) cb(sample);
    }, TELEMETRY_INTERVAL_MS);
  }

  private stopTelemetryTimer(): void {
    if (this.telemetryTimer !== null) {
      window.clearInterval(this.telemetryTimer);
      this.telemetryTimer = null;
    }
  }
}
