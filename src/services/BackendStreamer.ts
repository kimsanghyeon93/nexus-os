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

/** Default WS URL. Reads VITE_BACKEND_WS_URL at build time so the same
 *  bundle can target localhost, staging, prod without code edits. Falls
 *  back to the dev compose mapping (host port 8001 → container 8000)
 *  per docker-compose.override.yml. Sprint 5s+ loop: extracted from the
 *  constructor default — was hardcoded since BackendStreamer landed. */
function defaultBackendWsUrl(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  return env?.['VITE_BACKEND_WS_URL'] ?? 'ws://localhost:8001/v1/stream';
}

// Reconnect schedule — exponential backoff, capped. The backend's
// docker-compose health gate can take a few seconds to come up after a
// rebuild; tighter cadence early, longer cadence after to avoid burning
// CPU on a host that's offline. Reset to step 0 after every successful
// onopen so a 12h-uptime stream that drops once doesn't sit at 30s.
const RECONNECT_DELAYS_MS: ReadonlyArray<number> = [
  1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000,
];

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

  // Reconnect bookkeeping. `stopped` flips true when the operator
  // explicitly calls stop() (or switches to a different source) so the
  // reconnect loop knows to bail. `reconnectStep` is the index into
  // RECONNECT_DELAYS_MS — capped at the last entry so the schedule
  // plateaus gracefully.
  private stopped:         boolean        = false;
  private reconnectStep:   number         = 0;
  private reconnectTimer:  number | null  = null;

  constructor(private url: string = defaultBackendWsUrl()) {}

  // ── IMarketStreamer ──────────────────────────────────────────────────

  start(frequencyHz: number): void {
    this.freq = frequencyHz;
    this.stopped = false;
    this.cancelReconnect();
    if (this.ws !== null) return;          // idempotent — already connecting / connected
    this.setState('connecting');

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch {
      this.handleConnectionLost('construct-threw');
      return;
    }

    this.ws = socket;

    socket.onopen = () => {
      this.setState('connected');
      this.reconnectStep = 0;
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
      // Don't transition state here — onerror fires BEFORE onclose, and
      // both paths converge on handleConnectionLost via onclose. Setting
      // 'failed' from onerror would race the reconnect logic in onclose.
    };

    socket.onclose = () => {
      this.stopTelemetryTimer();
      this.ws = null;
      this.handleConnectionLost('socket-close');
    };
  }

  stop(): void {
    this.stopped = true;
    this.cancelReconnect();
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

  /** Single funnel for "socket went away". Decides between auto-reconnect
   *  (schedule next attempt) and terminal 'disconnected' (operator stopped
   *  the streamer or switched source). Updates state with what the operator
   *  will see in the TopBar connection pill. `_reason` is for debugging
   *  only — not surfaced. */
  private handleConnectionLost(_reason: string): void {
    if (this.stopped) {
      this.setState('disconnected');
      return;
    }
    // Mid-session drop: schedule the next reconnect attempt and reflect
    // 'reconnecting' so the operator sees the system trying. We DO NOT
    // surface 'failed' until the schedule runs out (or until a hard
    // construction error which short-circuits via handleConnectionLost
    // with `stopped=false` but no socket — same path).
    this.setState('reconnecting');
    const step = Math.min(this.reconnectStep, RECONNECT_DELAYS_MS.length - 1);
    const delay = RECONNECT_DELAYS_MS[step] ?? 30000;
    this.reconnectStep = step + 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      this.start(this.freq);
    }, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
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
