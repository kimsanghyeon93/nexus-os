// IMarketStreamer — DI seam shared by the production WebSocket client and
// the harness MockStreamer. The hook (`useMarketData`) only ever depends
// on this interface, never on a concrete transport.

/** Transport-level connection state. Synthetic streamers only ever toggle
 *  between 'disconnected' and 'connected'; networked transports walk the
 *  full lifecycle. The TopBar status pill renders directly from this enum. */
export type ConnectionState =
  | 'disconnected'
  | 'authenticating'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed'
  /** Frozen replay of an external snapshot — live transport is paused so its
   *  mutations do not overwrite the dropped dataset. Set by useMarketData
   *  independently of the underlying streamer's own state machine. */
  | 'replay';

export interface EntityMutation {
  entityId: string;
  /** delta added to NexusEntity.txVol */
  txVolDelta?: number;
  /** absolute new value 0..1 — > 0.7 trips the lime danger semantic */
  anomaly?: number;
}

export interface MarketPacket {
  /** wall-clock emit time (ms) */
  ts: number;
  /** synthetic latency reported by the transport */
  latencyMs: number;
  /** in-place mutations the hook should apply to its dataset */
  mutations: EntityMutation[];
}

export interface TelemetrySample {
  /** packets-per-second observed since the last sample */
  pktRate: number;
  latencyMs: number;
}

export interface AnomalyEvent {
  targetId: string;
}

export type Unsubscribe = () => void;

export interface IMarketStreamer {
  start(frequencyHz: number): void;
  stop(): void;
  /** Resume after a stop()/disconnect using the most recently set frequency.
   *  Implementations call this.start(this.freq) — no caller arg required.
   *  Used by the replay-resume flow so callers don't need to plumb freq. */
  restart(): void;
  setFrequency(hz: number): void;
  /** Fire a synthetic shock on a specific node — drives the lime-danger
   *  color and the 4-hop cascading ripple via the hook's shockTarget output. */
  triggerAnomaly(targetNodeId: string): void;

  onPacket(cb: (p: MarketPacket) => void): Unsubscribe;
  onTelemetry(cb: (t: TelemetrySample) => void): Unsubscribe;
  onAnomaly(cb: (e: AnomalyEvent) => void): Unsubscribe;

  /** Subscribe to order-book quote updates (H0STASP0).
   *  Optional — streamers that don't produce quotes (MockStreamer)
   *  implement a no-op stub. */
  onQuote?: (cb: (q: import('./api').Quote) => void) => Unsubscribe;

  /** Current transport state. Read-only snapshot — subscribe via
   *  onConnectionStateChange for live updates. */
  readonly connectionState: ConnectionState;
  onConnectionStateChange(cb: (s: ConnectionState) => void): Unsubscribe;
}
