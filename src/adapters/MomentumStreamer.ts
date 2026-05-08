// MomentumStreamer — IMarketStreamer adapter that bridges the Momentum
// US-equity dataset (Alpha Vantage proxy) into the NEXUS OS harness.
//
// Modes
//   • 'mock' : pulls from a local snapshot of Momentum's mock stock universe
//              (deterministic, no network) — recommended for dev / CI.
//   • 'live' : polls Momentum's Cloud Functions proxy that fronts Alpha
//              Vantage. Subject to AV's free-tier rate limits (5 req/min).
//
// Mutation target
//   Momentum tickers are first-class NEXUS entities living in the MOMENTUM
//   cluster (added in Sprint 3d). The streamer mutates each ticker entity
//   directly — no longer routes through US sector aggregations.
//
// Anomaly
//   |changePercent| / 10  capped at 0.99. A 5% intraday move ⇒ 0.5 (cyan
//   territory); a 7%+ move ⇒ ≥0.7 → lime danger semantic fires.

import type {
  AnomalyEvent,
  ConnectionState,
  IMarketStreamer,
  MarketPacket,
  TelemetrySample,
  Unsubscribe,
} from '../types/streamer';

/* ------------------------------------------------------------------ */
/*  Momentum mock universe — copied from                               */
/*  github/Momentum/src/services/marketDataService.js                  */
/*  Each symbol corresponds 1:1 to a NEXUS entity in the MOMENTUM      */
/*  cluster, so no ticker-to-entity translation is needed.             */
/* ------------------------------------------------------------------ */

interface MomentumStock {
  symbol: string;
  name: string;
  sector: string;
  marketCapBase: number;
  basePrice: number;
}

const MOMENTUM_UNIVERSE: ReadonlyArray<MomentumStock> = [
  { symbol: 'AAPL',  name: 'Apple Inc.',                sector: 'Technology',  marketCapBase: 2800e9, basePrice: 170 },
  { symbol: 'MSFT',  name: 'Microsoft Corp.',           sector: 'Technology',  marketCapBase: 2750e9, basePrice: 340 },
  { symbol: 'NVDA',  name: 'NVIDIA Corp.',              sector: 'Technology',  marketCapBase: 1200e9, basePrice: 850 },
  { symbol: 'AVGO',  name: 'Broadcom Inc.',             sector: 'Technology',  marketCapBase: 600e9,  basePrice: 1100 },
  { symbol: 'CRM',   name: 'Salesforce, Inc.',          sector: 'Technology',  marketCapBase: 300e9,  basePrice: 280 },
  { symbol: 'AMD',   name: 'Advanced Micro Devices',    sector: 'Technology',  marketCapBase: 280e9,  basePrice: 160 },
  { symbol: 'INTC',  name: 'Intel Corporation',         sector: 'Technology',  marketCapBase: 180e9,  basePrice: 45 },
  { symbol: 'ORCL',  name: 'Oracle Corporation',        sector: 'Technology',  marketCapBase: 340e9,  basePrice: 115 },
  { symbol: 'GOOGL', name: 'Alphabet Inc. (A)',         sector: 'Comm',        marketCapBase: 1700e9, basePrice: 140 },
  { symbol: 'META',  name: 'Meta Platforms',            sector: 'Comm',        marketCapBase: 900e9,  basePrice: 330 },
  { symbol: 'NFLX',  name: 'Netflix, Inc.',             sector: 'Comm',        marketCapBase: 250e9,  basePrice: 550 },
  { symbol: 'DIS',   name: 'The Walt Disney Co.',       sector: 'Comm',        marketCapBase: 160e9,  basePrice: 90 },
  { symbol: 'AMZN',  name: 'Amazon.com',                sector: 'ConsDisc',    marketCapBase: 1500e9, basePrice: 150 },
  { symbol: 'TSLA',  name: 'Tesla, Inc.',               sector: 'ConsDisc',    marketCapBase: 800e9,  basePrice: 250 },
  { symbol: 'HD',    name: 'The Home Depot',            sector: 'ConsDisc',    marketCapBase: 350e9,  basePrice: 350 },
  { symbol: 'MCD',   name: "McDonald's Corp.",          sector: 'ConsDisc',    marketCapBase: 210e9,  basePrice: 290 },
  { symbol: 'NKE',   name: 'NIKE, Inc.',                sector: 'ConsDisc',    marketCapBase: 160e9,  basePrice: 105 },
  { symbol: 'LLY',   name: 'Eli Lilly and Co.',         sector: 'Healthcare',  marketCapBase: 590e9,  basePrice: 620 },
  { symbol: 'JNJ',   name: 'Johnson & Johnson',         sector: 'Healthcare',  marketCapBase: 380e9,  basePrice: 160 },
  { symbol: 'UNH',   name: 'UnitedHealth Group',        sector: 'Healthcare',  marketCapBase: 480e9,  basePrice: 520 },
  { symbol: 'MRK',   name: 'Merck & Co.',               sector: 'Healthcare',  marketCapBase: 280e9,  basePrice: 110 },
  { symbol: 'PFE',   name: 'Pfizer Inc.',               sector: 'Healthcare',  marketCapBase: 150e9,  basePrice: 30 },
  { symbol: 'JPM',   name: 'JPMorgan Chase & Co.',      sector: 'Finance',     marketCapBase: 490e9,  basePrice: 170 },
  { symbol: 'V',     name: 'Visa Inc.',                 sector: 'Finance',     marketCapBase: 520e9,  basePrice: 250 },
  { symbol: 'MA',    name: 'Mastercard Inc.',           sector: 'Finance',     marketCapBase: 400e9,  basePrice: 420 },
  { symbol: 'BAC',   name: 'Bank of America',           sector: 'Finance',     marketCapBase: 260e9,  basePrice: 35 },
  { symbol: 'XOM',   name: 'Exxon Mobil Corp.',         sector: 'Energy',      marketCapBase: 420e9,  basePrice: 110 },
  { symbol: 'CVX',   name: 'Chevron Corp.',             sector: 'Energy',      marketCapBase: 290e9,  basePrice: 150 },
];

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

const DEFAULT_PROXY_URL =
  'https://us-central1-modern-fintech-application.cloudfunctions.net/alphaVantageProxy';

export interface MomentumStreamerOptions {
  /** 'mock' synthesises a deterministic walk over Momentum's universe;
   *  'live' polls the Alpha Vantage proxy. Default: 'mock'. */
  source?: 'mock' | 'live';
  /** Override the Cloud Functions proxy URL (for self-hosted or alt envs). */
  proxyUrl?: string;
  /** Live-mode: REST poll period per symbol batch. AV free tier ~5/min. */
  pollMs?: number;
  /** Restrict the universe (e.g. ['AAPL','NVDA','TSLA']). Default: full set. */
  symbols?: ReadonlyArray<string>;
}

interface QuoteSnapshot {
  symbol: string;
  price: number;
  changePercent: number;
  marketCap: number;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function anomalyFromChange(changePercent: number): number {
  return clamp(Math.abs(changePercent) / 10, 0, 0.99);
}

function txVolDeltaFromQuote(q: QuoteSnapshot): number {
  // marketCap in $; normalise into NEXUS txVol scale ($M, ~hundreds–thousands).
  // Sign follows the price direction so green moves add, red moves subtract.
  const mag = (q.marketCap / 1e9) * Math.abs(q.changePercent) * 0.4;
  return q.changePercent >= 0 ? mag : -mag;
}

type Sub<T> = (v: T) => void;

/* ------------------------------------------------------------------ */
/*  Streamer                                                           */
/* ------------------------------------------------------------------ */

export class MomentumStreamer implements IMarketStreamer {
  private readonly source: 'mock' | 'live';
  private readonly proxyUrl: string;
  private readonly pollMs: number;
  private readonly symbols: ReadonlyArray<string>;

  private freq = 30;
  private running = false;
  private packetTimer: ReturnType<typeof setInterval> | null = null;
  private telemetryTimer: ReturnType<typeof setInterval> | null = null;
  private livePollTimer: ReturnType<typeof setInterval> | null = null;

  private readonly packetSubs = new Set<Sub<MarketPacket>>();
  private readonly telemetrySubs = new Set<Sub<TelemetrySample>>();
  private readonly anomalySubs = new Set<Sub<AnomalyEvent>>();
  private readonly connSubs = new Set<Sub<ConnectionState>>();
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

  private cursor = 0;
  private sampleCount = 0;
  private lastTelemetryAt = 0;

  /** Last known quote per symbol — fed by mock walk or live poll. */
  private quoteCache = new Map<string, QuoteSnapshot>();

  constructor(opts: MomentumStreamerOptions = {}) {
    this.source = opts.source ?? 'mock';
    this.proxyUrl = opts.proxyUrl ?? DEFAULT_PROXY_URL;
    this.pollMs = opts.pollMs ?? 30_000;
    this.symbols = opts.symbols ?? MOMENTUM_UNIVERSE.map(s => s.symbol);
    this.seedCache();
  }

  private seedCache(): void {
    for (const s of MOMENTUM_UNIVERSE) {
      if (!this.symbols.includes(s.symbol)) continue;
      this.quoteCache.set(s.symbol, {
        symbol: s.symbol,
        price: s.basePrice,
        // Seed with a non-trivial intraday move so the radar shows immediate
        // sector activity when the user switches sources.
        changePercent: (Math.random() - 0.4) * 4,
        marketCap: s.marketCapBase,
      });
    }
  }

  start(frequencyHz: number): void {
    if (this.running) this.stop();
    this.freq = clamp(frequencyHz, 1, 240);
    this.running = true;
    this.lastTelemetryAt = performance.now();

    this.scheduleEmitter();
    this.scheduleTelemetry();

    if (this.source === 'live') {
      void this.pollLive();
      this.livePollTimer = setInterval(() => void this.pollLive(), this.pollMs);
    } else {
      this.scheduleMockWalk();
    }
    this.setState('connected');
  }

  stop(): void {
    this.running = false;
    if (this.packetTimer != null) { clearInterval(this.packetTimer); this.packetTimer = null; }
    if (this.telemetryTimer != null) { clearInterval(this.telemetryTimer); this.telemetryTimer = null; }
    if (this.livePollTimer != null) { clearInterval(this.livePollTimer); this.livePollTimer = null; }
    this.setState('disconnected');
  }

  restart(): void {
    this.start(this.freq);
  }

  setFrequency(hz: number): void {
    this.freq = clamp(hz, 1, 240);
    if (this.running && this.packetTimer != null) {
      clearInterval(this.packetTimer);
      this.scheduleEmitter();
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

  /* ----- packet pump --------------------------------------------- */

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
      this.fanoutTelemetry({
        pktRate: Math.round(rate),
        latencyMs: this.source === 'live' ? 80 + Math.random() * 40 : 16 + Math.random() * 14,
      });
    }, 250);
  }

  private emit(): void {
    if (this.symbols.length === 0) return;
    const symbol = this.symbols[this.cursor % this.symbols.length];
    this.cursor++;
    const q = this.quoteCache.get(symbol);
    if (!q) return;
    const anomaly = anomalyFromChange(q.changePercent);
    const packet: MarketPacket = {
      ts: Date.now(),
      latencyMs: this.source === 'live' ? 90 + Math.random() * 40 : 16 + Math.random() * 14,
      mutations: [{
        // Symbol IS the entity id — Momentum tickers are first-class
        // members of the MOMENTUM cluster.
        entityId: symbol,
        txVolDelta: txVolDeltaFromQuote(q),
        // Only assert anomaly when the move is meaningful; otherwise leave
        // the entity's anomaly untouched so cyan/lime state reflects market.
        ...(anomaly >= 0.5 ? { anomaly } : {}),
      }],
    };
    this.sampleCount++;
    this.fanoutPacket(packet);
  }

  /* ----- mock random walk ---------------------------------------- */

  private scheduleMockWalk(): void {
    // Drift each cached quote so the harness shows continuous sector activity
    // even without a live API. Faster cadence + higher shock probability so
    // the visual difference vs. SYNTHETIC mode is immediately obvious.
    setInterval(() => {
      if (!this.running) return;
      for (const [sym, q] of this.quoteCache) {
        const drift = (Math.random() - 0.5) * 1.2;
        // 6% chance per tick of a synthetic shock ≥5% — frequent enough to
        // see lime danger pulses on the radar, rare enough to feel realistic.
        const shock = Math.random() < 0.06 ? (Math.random() < 0.5 ? -1 : 1) * (5 + Math.random() * 4) : 0;
        const next = clamp(q.changePercent + drift + shock, -12, 12);
        this.quoteCache.set(sym, { ...q, changePercent: next });
      }
    }, 800);
  }

  /* ----- live poll ----------------------------------------------- */

  private async pollLive(): Promise<void> {
    // AV free tier is 5 req/min, so we round-robin a small batch each cycle
    // rather than fanning out the whole universe.
    const BATCH = 4;
    const start = (this.cursor / Math.max(1, this.symbols.length)) | 0;
    const slice = this.symbols.slice(
      (start * BATCH) % this.symbols.length,
      (start * BATCH) % this.symbols.length + BATCH,
    );

    for (const sym of slice) {
      try {
        const url = `${this.proxyUrl}?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(sym)}`;
        const resp = await fetch(url);
        if (!resp.ok) continue;
        const data: unknown = await resp.json();
        const quote = parseGlobalQuote(sym, data);
        if (quote) {
          // marketCap: keep prior (proxy GLOBAL_QUOTE doesn't return it)
          const prior = this.quoteCache.get(sym);
          this.quoteCache.set(sym, {
            symbol: sym,
            price: quote.price,
            changePercent: quote.changePercent,
            marketCap: prior?.marketCap ?? 0,
          });
        }
      } catch {
        // Network/CORS/quota failures shouldn't kill the streamer.
      }
    }
  }

  /* ----- fanout -------------------------------------------------- */

  private fanoutPacket(p: MarketPacket): void { this.packetSubs.forEach(cb => cb(p)); }
  private fanoutTelemetry(t: TelemetrySample): void { this.telemetrySubs.forEach(cb => cb(t)); }
  private fanoutAnomaly(e: AnomalyEvent): void { this.anomalySubs.forEach(cb => cb(e)); }
}

/** Parse Alpha Vantage's GLOBAL_QUOTE shape. */
function parseGlobalQuote(symbol: string, raw: unknown): { price: number; changePercent: number } | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const gq = obj['Global Quote'];
  if (!gq || typeof gq !== 'object') return null;
  const q = gq as Record<string, string>;
  const price = parseFloat(q['05. price']);
  const changePctRaw = q['10. change percent'];
  const changePercent = changePctRaw ? parseFloat(changePctRaw.replace('%', '')) : 0;
  if (!Number.isFinite(price)) return null;
  void symbol;
  return { price, changePercent };
}
