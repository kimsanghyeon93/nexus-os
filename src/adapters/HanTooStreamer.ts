// HanTooStreamer — Korea Investment & Securities (KIS, 한국투자증권 "HanToo")
// OpenAPI WebSocket adapter (PRODUCTION SCAFFOLD / STUB).
//
// This file establishes the enterprise integration shape for the real backend
// without depending on credentials, network, or live infrastructure. The
// MockStreamer remains the harness default; HanTooStreamer is selected
// explicitly when an operator wants to preview the production path.
//
// REAL KIS OpenAPI ARCHITECTURE (for context — none of this is wired here):
//
//   1. OAuth 2.0 token issuance
//        POST {restUrl}/oauth2/tokenP
//        body: { grant_type: 'client_credentials', appkey, appsecret }
//        → { access_token, expires_in } — TTL ~24h
//
//   2. WebSocket approval key (separate from REST token)
//        POST {restUrl}/oauth2/Approval
//        body: { grant_type: 'client_credentials', appkey, secretkey }
//        → { approval_key } — required in every WS subscribe message
//
//   3. WebSocket open
//        wss://ops.koreainvestment.com:21000          (production)
//        wss://openapivts.koreainvestment.com:21000   (paper / 모의투자)
//
//   4. Subscribe message (sent over WS as JSON)
//        {
//          header: { approval_key, custtype: 'P', tr_type: '1', 'content-type': 'utf-8' },
//          body:   { input: { tr_id: 'H0STCNT0', tr_key: '005930' } }
//        }
//        tr_id examples:
//           H0STCNT0 — KOSPI 실시간 체결가 (real-time trades)
//           H0STASP0 — KOSPI 실시간 호가 (orderbook)
//           H0UPCNT0 — KOSPI200 지수 실시간
//           H0FXCNT0 — KRW FX 실시간
//
//   5. Inbound stream
//        Pipe-delimited string for tick TR_IDs:
//          "0|H0STCNT0|001|005930^090054^77900^5^800^1.04^77432.55^77000^...
//                                  └ ticker + ts + price + change + Δ% + ...
//        JSON for control / heartbeat frames.
//
// ENTERPRISE PATTERNS DEMONSTRATED IN THIS STUB:
//   • Connection state machine (disconnected → authenticating → connecting →
//     connected → reconnecting → failed) with monotonic transitions.
//   • OAuth-aware connect() — accepts an injected access_token (preferred)
//     or fetches one via REST when appKey/appSecret are configured.
//   • Exponential backoff with full jitter and a hard ceiling (default 30s).
//   • Subscription queue — subscribes are buffered until the socket reaches
//     the connected state, then flushed atomically.
//   • mapToOntology() — broker payload → NexusEntity / NexusEdge mutations,
//     with a clear extension point for parsing pipe-delimited tick frames.
//   • Stub mode — when credentials are absent, the streamer logs the lifecycle
//     and emits low-rate synthetic KRX ticks so the harness UI stays alive.

import type {
  AnomalyEvent,
  ConnectionState,
  IMarketStreamer,
  MarketPacket,
  TelemetrySample,
  Unsubscribe,
} from '../types/streamer';

export type { ConnectionState };

/* ------------------------------------------------------------------ */
/*  Public configuration                                               */
/* ------------------------------------------------------------------ */

/** TR_ID → NEXUS entity-id binding for a single subscribed instrument. */
export interface HanTooSubscription {
  /** KIS transaction ID — defines payload shape. */
  trId: 'H0STCNT0' | 'H0STASP0' | 'H0UPCNT0' | 'H0FXCNT0' | string;
  /** KRX 종목코드 (e.g. '005930') or index code. */
  trKey: string;
  /** Target NexusEntity in the dataset whose `anomaly` and `txVol` will be
   *  mutated when ticks arrive for this subscription. */
  entityId: string;
  /** Optional human label for logs / future tooltip. */
  label?: string;
}

export interface HanTooConfig {
  /** REST base URL (defaults to KIS production).
   *  Use `https://openapivts.koreainvestment.com:29443` for paper trading. */
  restUrl?: string;
  /** WebSocket base URL (defaults to KIS production).
   *  Use `wss://openapivts.koreainvestment.com:21000` for paper trading. */
  wsUrl?: string;
  /** Issued by KIS DevCenter (https://apiportal.koreainvestment.com/). */
  appKey?: string;
  appSecret?: string;
  /** Pre-fetched access token — preferred when callers manage OAuth themselves. */
  accessToken?: string;
  /** TR_IDs / tickers to subscribe on connect. */
  subscriptions?: ReadonlyArray<HanTooSubscription>;
  /** Connection-class tunables. */
  reconnect?: ReconnectPolicy;
  /** When true, no real network is touched — synthetic KRX ticks are emitted
   *  to keep the harness UI populated. Default `true` until production
   *  credentials are wired. */
  stubMode?: boolean;
}

export interface ReconnectPolicy {
  /** Initial backoff in ms — doubled each failure. */
  initialMs: number;
  /** Hard ceiling — backoff never exceeds this. */
  maxMs: number;
  /** [0..1] — full-jitter scaling factor on the computed delay. */
  jitter: number;
  /** Stop reconnecting after this many consecutive failures. */
  maxAttempts: number;
}

const DEFAULT_RECONNECT: ReconnectPolicy = {
  initialMs: 1_000,
  maxMs: 30_000,
  jitter: 0.5,
  maxAttempts: 10,
};

const DEFAULT_REST_URL = 'https://openapi.koreainvestment.com:9443';
const DEFAULT_WS_URL   = 'wss://ops.koreainvestment.com:21000';

const DEFAULT_SUBSCRIPTIONS: ReadonlyArray<HanTooSubscription> = [
  { trId: 'H0STCNT0', trKey: '005930', entityId: 'KRX_SEMI', label: 'Samsung Electronics' },
  { trId: 'H0STCNT0', trKey: '000660', entityId: 'KRX_SEMI', label: 'SK Hynix' },
  { trId: 'H0STCNT0', trKey: '373220', entityId: 'KRX_BATT', label: 'LG Energy Solution' },
  { trId: 'H0STCNT0', trKey: '005380', entityId: 'KRX_AUTO', label: 'Hyundai Motor' },
  { trId: 'H0STCNT0', trKey: '105560', entityId: 'KRX_FIN',  label: 'KB Financial' },
  { trId: 'H0STCNT0', trKey: '009540', entityId: 'KRX_SHIP', label: 'HD Hyundai Heavy' },
  { trId: 'H0UPCNT0', trKey: '0001',   entityId: 'KOSPI',    label: 'KOSPI Composite' },
  { trId: 'H0FXCNT0', trKey: 'USDKRW', entityId: 'USDKRW',   label: 'USD/KRW' },
];

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

type Sub<T> = (v: T) => void;

const TAG = '[HanToo]';

/* ------------------------------------------------------------------ */
/*  Streamer                                                           */
/* ------------------------------------------------------------------ */

export class HanTooStreamer implements IMarketStreamer {
  private readonly config: Required<Omit<HanTooConfig, 'appKey' | 'appSecret' | 'accessToken'>> & {
    appKey?: string;
    appSecret?: string;
    accessToken?: string;
  };

  private state: ConnectionState = 'disconnected';
  private freq = 30;
  private running = false;

  private ws: WebSocket | null = null;
  private approvalKey: string | null = null;

  private packetTimer: ReturnType<typeof setInterval> | null = null;
  private telemetryTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private reconnectAttempts = 0;
  private subscribeQueue: HanTooSubscription[] = [];

  private readonly packetSubs = new Set<Sub<MarketPacket>>();
  private readonly telemetrySubs = new Set<Sub<TelemetrySample>>();
  private readonly anomalySubs = new Set<Sub<AnomalyEvent>>();
  private readonly connSubs = new Set<Sub<ConnectionState>>();

  private sampleCount = 0;
  private lastTelemetryAt = 0;
  private stubCursor = 0;

  constructor(config: HanTooConfig = {}) {
    this.config = {
      restUrl:       config.restUrl       ?? DEFAULT_REST_URL,
      wsUrl:         config.wsUrl         ?? DEFAULT_WS_URL,
      subscriptions: config.subscriptions ?? DEFAULT_SUBSCRIPTIONS,
      reconnect:     config.reconnect     ?? DEFAULT_RECONNECT,
      stubMode:      config.stubMode      ?? true,
      appKey:        config.appKey,
      appSecret:     config.appSecret,
      accessToken:   config.accessToken,
    };
  }

  /* --- IMarketStreamer surface ----------------------------------- */

  start(frequencyHz: number): void {
    if (this.running) this.stop();
    this.freq = clamp(frequencyHz, 1, 240);
    this.running = true;
    this.lastTelemetryAt = performance.now();
    this.scheduleTelemetry();

    if (this.config.stubMode) {
      console.warn(`${TAG} stub mode — no network, emitting synthetic KRX ticks at ${this.freq}Hz`);
      // Walk the same lifecycle a real connection would, just on a faster
      // synthetic timeline. This drives the TopBar pill through amber → cyan
      // so operators see production-shape transitions in dev.
      this.transitionTo('authenticating');
      setTimeout(() => {
        if (!this.running) return;
        this.transitionTo('connecting');
        setTimeout(() => {
          if (!this.running) return;
          this.transitionTo('connected');
          this.startStubEmitter();
        }, 250);
      }, 250);
    } else {
      void this.connect(this.config.accessToken);
    }
  }

  stop(): void {
    this.running = false;
    this.clearTimer('packetTimer');
    this.clearTimer('telemetryTimer');
    this.clearTimer('reconnectTimer');
    this.disconnect();
  }

  restart(): void {
    this.start(this.freq);
  }

  setFrequency(hz: number): void {
    this.freq = clamp(hz, 1, 240);
    if (this.running && this.config.stubMode && this.packetTimer != null) {
      this.clearTimer('packetTimer');
      this.startStubEmitter();
    }
  }

  triggerAnomaly(targetNodeId: string): void {
    const shock: MarketPacket = {
      ts: Date.now(),
      latencyMs: 4 + Math.random() * 6,
      mutations: [{
        entityId: targetNodeId,
        anomaly: 0.95,
        txVolDelta: 8000 + Math.random() * 6000,
      }],
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

  onConnectionStateChange(cb: Sub<ConnectionState>): Unsubscribe {
    this.connSubs.add(cb);
    return () => this.connSubs.delete(cb);
  }

  /* --- Connection lifecycle (PRODUCTION SCAFFOLD) ---------------- */

  /** Establish the WS session.
   *
   *  Real flow:
   *   1. If `authToken` not provided, POST to /oauth2/tokenP with appKey/appSecret.
   *   2. POST to /oauth2/Approval to obtain the approval_key required by WS.
   *   3. Open WebSocket(this.config.wsUrl).
   *   4. On open, flush this.subscribeQueue.
   *   5. On message, route to handlePush() → mapToOntology() → fanoutPacket().
   *   6. On close/error, schedule reconnect via setupReconnectLogic().
   */
  async connect(authToken?: string): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting') return;

    // Stub mode: walk the production lifecycle on a synthetic timeline so the
    // TopBar pill animates amber → cyan even after a simulated drop.
    if (this.config.stubMode) {
      this.transitionTo('authenticating');
      setTimeout(() => {
        if (!this.running) return;
        this.transitionTo('connecting');
        setTimeout(() => {
          if (!this.running) return;
          this.transitionTo('connected');
          this.reconnectAttempts = 0;
        }, 200);
      }, 200);
      return;
    }

    this.transitionTo('authenticating');

    const token = authToken ?? this.config.accessToken;
    if (!token && (!this.config.appKey || !this.config.appSecret)) {
      console.warn(`${TAG} no access_token and no appKey/appSecret — falling back to stub mode`);
      this.config.stubMode = true;
      // Walk the stub lifecycle so the pill ends in 'connected', not 'failed'.
      this.transitionTo('connecting');
      setTimeout(() => {
        if (!this.running) return;
        this.transitionTo('connected');
        if (this.packetTimer == null) this.startStubEmitter();
      }, 250);
      return;
    }

    // STUB: real implementation would issue REST calls here.
    //   const tokenResp = token ?? await this.requestAccessToken();
    //   this.approvalKey = await this.requestApprovalKey(tokenResp);
    //
    // The stub records the intent and bails out cleanly.
    this.approvalKey = '__stub_approval_key__';
    console.info(`${TAG} authenticated (stub) — approval_key acquired`);

    this.transitionTo('connecting');

    // STUB: real implementation would open the socket.
    //   this.ws = new WebSocket(this.config.wsUrl);
    //   this.ws.addEventListener('open',    () => this.onOpen());
    //   this.ws.addEventListener('message', (e) => this.onMessage(e));
    //   this.ws.addEventListener('close',   () => this.onClose());
    //   this.ws.addEventListener('error',   () => this.onError());
    //
    // We simulate a successful open so the state machine stays correct.
    this.transitionTo('connected');
    this.reconnectAttempts = 0;
    this.flushSubscribeQueue();
  }

  /** Tear down the WS cleanly and cancel any pending reconnect. */
  disconnect(): void {
    this.clearTimer('reconnectTimer');
    if (this.ws) {
      try { this.ws.close(1000, 'client_shutdown'); } catch { /* socket already dead */ }
      this.ws = null;
    }
    this.approvalKey = null;
    if (this.state !== 'disconnected') this.transitionTo('disconnected');
  }

  /** Exponential backoff with full jitter, ceiling-clamped, attempt-capped. */
  private setupReconnectLogic(): void {
    const policy = this.config.reconnect;
    if (this.reconnectAttempts >= policy.maxAttempts) {
      console.error(`${TAG} reconnect attempts exhausted (${policy.maxAttempts}) — giving up`);
      this.transitionTo('failed');
      return;
    }
    const exp = Math.min(policy.maxMs, policy.initialMs * Math.pow(2, this.reconnectAttempts));
    const jittered = exp * (1 - policy.jitter + Math.random() * policy.jitter);
    const delay = Math.round(jittered);
    this.reconnectAttempts++;
    this.transitionTo('reconnecting');
    console.warn(`${TAG} reconnect #${this.reconnectAttempts} in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      void this.connect();
    }, delay);
  }

  /* --- Subscription management ----------------------------------- */

  subscribe(sub: HanTooSubscription): void {
    this.subscribeQueue.push(sub);
    if (this.state === 'connected') this.flushSubscribeQueue();
  }

  private flushSubscribeQueue(): void {
    // In stub mode this.ws is null, but the queue still needs to drain so the
    // state machine moves forward. Real path requires both ws AND approvalKey.
    if (this.state !== 'connected') return;
    if (!this.config.stubMode && (!this.ws || !this.approvalKey)) return;
    const pending = this.subscribeQueue.splice(0);
    for (const sub of pending) {
      // STUB: real implementation would send the KIS WS subscribe envelope.
      const envelope = {
        header: {
          approval_key: this.approvalKey,
          custtype: 'P',
          tr_type: '1',
          'content-type': 'utf-8',
        },
        body: { input: { tr_id: sub.trId, tr_key: sub.trKey } },
      };
      // this.ws?.send(JSON.stringify(envelope));
      void envelope;
    }
  }

  /* --- Inbound payload mapping (PRODUCTION SCAFFOLD) ------------- */

  /** Convert a raw KIS push frame into ontology-level mutations.
   *
   *  KIS H0STCNT0 (KOSPI 체결) wire format is pipe-delimited, e.g.:
   *
   *    "0|H0STCNT0|001|005930^090054^77900^5^800^1.04^..."
   *     │  │       │   └── data section, '^'-delimited fields
   *     │  │       └── data length
   *     │  └── tr_id
   *     └── encryption flag (0 = plaintext, 1 = AES-encrypted)
   *
   *  Field mapping (체결 / trades):
   *    [0]  종목코드   → match against subscription → entityId
   *    [1]  체결시간
   *    [2]  현재가
   *    [3]  전일대비부호
   *    [4]  전일대비
   *    [5]  전일대비율  → |Δ%| / 10 → anomaly (cap 0.99)
   *    [12] 거래량      → contributes to txVolDelta
   *
   *  Index (H0UPCNT0) and FX (H0FXCNT0) frames have different field layouts;
   *  the production parser will dispatch on tr_id.
   */
  private mapToOntology(rawPayload: unknown): { mutations: MarketPacket['mutations'] } {
    if (typeof rawPayload !== 'string') return { mutations: [] };

    const [encFlag, trId, _len, body] = rawPayload.split('|');
    if (encFlag !== '0' || !trId || !body) return { mutations: [] };

    const fields = body.split('^');
    const ticker = fields[0];
    const sub = this.config.subscriptions.find(s => s.trKey === ticker && s.trId === trId);
    if (!sub) return { mutations: [] };

    // Field indices below are placeholders — real values come from KIS docs.
    const changePctRaw = fields[5];
    const volumeRaw    = fields[12];

    const changePct = Number.parseFloat(changePctRaw ?? '0');
    const volume    = Number.parseInt(volumeRaw ?? '0', 10);

    const anomaly = clamp(Math.abs(changePct) / 10, 0, 0.99);

    return {
      mutations: [{
        entityId: sub.entityId,
        txVolDelta: Number.isFinite(volume) ? volume / 1000 : 0,
        ...(anomaly >= 0.5 ? { anomaly } : {}),
      }],
    };
  }

  /* --- Stub emitter (no network) --------------------------------- */

  private startStubEmitter(): void {
    const intervalMs = Math.max(2, Math.round(1000 / this.freq));
    this.packetTimer = setInterval(() => this.emitStub(), intervalMs);
  }

  private emitStub(): void {
    const subs = this.config.subscriptions;
    if (subs.length === 0) return;
    const sub = subs[this.stubCursor % subs.length];
    this.stubCursor++;

    // Construct a fake KIS pipe-delimited payload so the same parser used in
    // production (mapToOntology) is exercised even without a real socket.
    const drift = (Math.random() - 0.5) * 1.4;
    const shock = Math.random() < 0.04 ? (Math.random() < 0.5 ? -1 : 1) * (5 + Math.random() * 4) : 0;
    const changePct = clamp(drift + shock, -10, 10);
    const volume = Math.floor(40_000 + Math.random() * 60_000);

    const fakeFields = [
      sub.trKey,                                    // [0] 종목코드
      new Date().toISOString().slice(11, 19).replace(/:/g, ''), // [1] 체결시간 hhmmss
      '77900',                                       // [2] 현재가
      changePct >= 0 ? '2' : '5',                    // [3] 전일대비부호
      Math.abs(changePct * 779).toFixed(0),          // [4] 전일대비 (price)
      changePct.toFixed(2),                          // [5] 전일대비율 (%)
      '77432.55', '77000', '78100', '76800',         // [6..9] vwap/open/high/low
      '0', '0', String(volume),                      // [10..12] (volume at index 12)
    ].join('^');
    const rawPayload = `0|${sub.trId}|${fakeFields.length}|${fakeFields}`;

    const { mutations } = this.mapToOntology(rawPayload);
    if (mutations.length === 0) return;

    const packet: MarketPacket = {
      ts: Date.now(),
      latencyMs: 28 + Math.random() * 24,
      mutations,
    };
    this.sampleCount++;
    this.fanoutPacket(packet);

    // Once every ~150 ticks, simulate an unexpected socket drop so the
    // reconnect path is visibly exercised in stub mode. Fully self-healing.
    if (Math.random() < 1 / 150) this.simulateDrop();
  }

  /** Stub-only — pretend the socket dropped to demonstrate setupReconnectLogic. */
  private simulateDrop(): void {
    if (this.state !== 'connected') return;
    console.warn(`${TAG} stub: simulating WS drop to exercise reconnect path`);
    this.transitionTo('disconnected');
    this.setupReconnectLogic();
    // setupReconnectLogic transitions to 'reconnecting' and schedules a
    // call into connect() — which in stub mode synchronously walks the
    // state machine back to 'connected'.
  }

  /* --- Telemetry ticker (shared with all transports) ------------- */

  private scheduleTelemetry(): void {
    this.telemetryTimer = setInterval(() => {
      const now = performance.now();
      const dt = (now - this.lastTelemetryAt) / 1000;
      const rate = dt > 0 ? this.sampleCount / dt : 0;
      this.sampleCount = 0;
      this.lastTelemetryAt = now;
      this.fanoutTelemetry({
        pktRate: Math.round(rate),
        latencyMs: this.config.stubMode ? 28 + Math.random() * 24 : 60 + Math.random() * 40,
      });
    }, 250);
  }

  /* --- Internal state plumbing ----------------------------------- */

  private transitionTo(next: ConnectionState): void {
    if (this.state === next) return;
    console.info(`${TAG} ${this.state} → ${next}`);
    this.state = next;
    this.connSubs.forEach(cb => cb(next));
  }

  private clearTimer(key: 'packetTimer' | 'telemetryTimer' | 'reconnectTimer'): void {
    const t = this[key];
    if (t == null) return;
    clearInterval(t as ReturnType<typeof setInterval>);
    clearTimeout(t as ReturnType<typeof setTimeout>);
    this[key] = null;
  }

  private fanoutPacket(p: MarketPacket): void { this.packetSubs.forEach(cb => cb(p)); }
  private fanoutTelemetry(t: TelemetrySample): void { this.telemetrySubs.forEach(cb => cb(t)); }
  private fanoutAnomaly(e: AnomalyEvent): void { this.anomalySubs.forEach(cb => cb(e)); }

  /** Read-only state introspection — useful for a future TopBar status pill. */
  get connectionState(): ConnectionState { return this.state; }
}
