// HybridStreamer — composite IMarketStreamer running two underlying
// streamers in parallel. Sprint 5r: lets the operator drive both the
// KRX side (live via BackendStreamer / nexus-backend WS) and the US
// side (live via MomentumStreamer / Alpha Vantage proxy) in a single
// source selection.
//
// Subscriptions: every consumer callback is re-registered on both
// underlying streamers; events fan out from whichever source emits.
// Connection state: AGGREGATED ("connected" iff BOTH are connected;
// "reconnecting" if either is reconnecting; "failed" if either is
// failed; "disconnected" only when both are). The TopBar pill thus
// turns yellow / red as soon as one half hiccups, which is what an
// operator who's running both pipes wants — they need to know the
// moment either side stops driving the canvas.
//
// triggerAnomaly: forwarded to BOTH streamers. KRX hits its own
// backend audit pipe; MomentumStreamer just bounces an anomaly event
// back to local subscribers. Either path triggers the cascading
// ripple, so a single ⌘! invocation works regardless of which side
// the entity belongs to.

import type {
  AnomalyEvent,
  ConnectionState,
  IMarketStreamer,
  MarketPacket,
  TelemetrySample,
  Unsubscribe,
} from '../types/streamer';

export class HybridStreamer implements IMarketStreamer {
  private readonly a: IMarketStreamer;
  private readonly b: IMarketStreamer;
  private freq: number = 1;

  // Aggregated state derived from both children. Stored alongside the
  // listeners so we only fan out on real transitions, not on duplicate
  // child events that resolve to the same aggregate.
  private _state: ConnectionState = 'disconnected';
  private readonly stateSubs = new Set<(s: ConnectionState) => void>();

  // Unsubscribers stashed at construction so .stop() / GC can release
  // them. Public unsubscribe handlers below return their own closures.
  private readonly innerOffs: Unsubscribe[] = [];

  constructor(a: IMarketStreamer, b: IMarketStreamer) {
    this.a = a;
    this.b = b;

    // Track child connection state so the aggregated pill reflects the
    // weaker of the two. onConnectionStateChange callbacks may fire
    // before start(); subscribe now and re-derive each time.
    this.innerOffs.push(
      this.a.onConnectionStateChange(() => this.deriveState()),
      this.b.onConnectionStateChange(() => this.deriveState()),
    );
    this.deriveState();
  }

  // ── IMarketStreamer ──────────────────────────────────────────────────

  start(frequencyHz: number): void {
    this.freq = frequencyHz;
    this.a.start(frequencyHz);
    this.b.start(frequencyHz);
    this.deriveState();
  }

  stop(): void {
    this.a.stop();
    this.b.stop();
    this.deriveState();
  }

  restart(): void {
    this.a.restart();
    this.b.restart();
    this.deriveState();
  }

  setFrequency(hz: number): void {
    this.freq = hz;
    this.a.setFrequency(hz);
    this.b.setFrequency(hz);
  }

  triggerAnomaly(targetNodeId: string): void {
    // Fan out to both — only one will actually carry the symbol, but
    // the other's no-op is harmless and we don't want to plumb a
    // routing table here.
    this.a.triggerAnomaly(targetNodeId);
    this.b.triggerAnomaly(targetNodeId);
  }

  onPacket(cb: (p: MarketPacket) => void): Unsubscribe {
    const offA = this.a.onPacket(cb);
    const offB = this.b.onPacket(cb);
    return () => { offA(); offB(); };
  }

  onTelemetry(cb: (t: TelemetrySample) => void): Unsubscribe {
    // Telemetry merge — fire the caller with each child's sample as it
    // arrives. The UI only displays the most recent value (pkt/s
    // counter), so rapid alternation between the two streams is
    // visually fine.
    const offA = this.a.onTelemetry(cb);
    const offB = this.b.onTelemetry(cb);
    return () => { offA(); offB(); };
  }

  onAnomaly(cb: (e: AnomalyEvent) => void): Unsubscribe {
    const offA = this.a.onAnomaly(cb);
    const offB = this.b.onAnomaly(cb);
    return () => { offA(); offB(); };
  }

  get connectionState(): ConnectionState {
    return this._state;
  }

  onConnectionStateChange(cb: (s: ConnectionState) => void): Unsubscribe {
    this.stateSubs.add(cb);
    return () => { this.stateSubs.delete(cb); };
  }

  // ── Internals ───────────────────────────────────────────────────────

  /** Aggregate the two child states into one observable state.
   *  Priority (weakest wins): failed > reconnecting > connecting >
   *  authenticating > disconnected > connected. So the pill turns red
   *  the moment EITHER half fails — operators running a dual stream
   *  want loud signal on partial outages, not a calm "still mostly
   *  working" green. */
  private deriveState(): void {
    const order: ConnectionState[] = [
      'failed',
      'reconnecting',
      'connecting',
      'authenticating',
      'disconnected',
      'connected',
      'replay',
    ];
    const idx = (s: ConnectionState): number => {
      const i = order.indexOf(s);
      return i === -1 ? order.length : i;
    };
    const aS = this.a.connectionState;
    const bS = this.b.connectionState;
    const next = idx(aS) <= idx(bS) ? aS : bS;
    if (next === this._state) return;
    this._state = next;
    for (const cb of this.stateSubs) cb(next);
  }
}
