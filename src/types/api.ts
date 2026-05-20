// Backend API contract — TypeScript mirror of nexus-backend Pydantic DTOs.
//
// Field shapes match exactly so an `ApiResult<SnapshotDTO>` from the
// fetch wrapper can be handed to the canvas without an adapter step.
// Any drift between this file and the backend's `src/api/v1/dto.py` /
// `src/core/errors.py` is a contract break — bump v1 → v2 instead of
// silently widening the type.

// ──────────────────────────────────────────────────────────────────────
//  RFC 7807 — `application/problem+json`
// ──────────────────────────────────────────────────────────────────────

/**
 * RFC 7807 problem detail with NEXUS extensions.
 * Frontend Error Boundary switches on `type` URI to pick UI behavior.
 */
export interface ProblemDetail {
  /** URI identifying the problem class (e.g. `https://nexus-os.local/problems/auth-failed`) */
  type:        string;
  /** Short human-readable summary (e.g. `"Unauthorized"`) */
  title:       string;
  /** HTTP status code mirroring the response */
  status:      number;
  /** Specific explanation for this occurrence */
  detail?:     string;
  /** URI for this specific occurrence (typically the request path) */
  instance?:   string;
  /** Correlation id from the X-Request-ID header */
  request_id:  string;
  /** Field-level diagnostics on 422 responses */
  errors?:     Array<{ loc: Array<string | number>; msg: string; type: string }>;
}

/** Stable problem-type URIs the backend emits — keep in sync with errors.py */
export const PROBLEM_TYPE = {
  VALIDATION: 'https://nexus-os.local/problems/validation-error',
  AUTH:       'https://nexus-os.local/problems/auth-failed',
  INTERNAL:   'https://nexus-os.local/problems/internal-error',
  /** 400-class — query parameter or path argument failed enum / range
   *  / shape validation at the router layer. Distinct from VALIDATION
   *  (422, Pydantic body-level). Frontend dispatches both to the same
   *  "error-other" branch and renders `{title} — {detail}`. */
  INVALID_INPUT: 'https://nexus-os.local/problems/invalid-input',
  /** 503-class — a downstream the service depends on (alarm repo,
   *  market store, etc.) is unavailable. Pre-registered for forward
   *  compat: today only the alarms endpoint surfaces an analogue, and
   *  it falls back to an empty 200 in normal operation. */
  UPSTREAM_ERROR: 'https://nexus-os.local/problems/upstream-error',
  /** Synthesized client-side when fetch() itself fails (network down, CORS, etc.) */
  NETWORK:    'https://nexus-os.local/problems/network-error',
} as const;

export type ProblemTypeUri = typeof PROBLEM_TYPE[keyof typeof PROBLEM_TYPE] | string;

// ──────────────────────────────────────────────────────────────────────
//  v1 response payloads
// ──────────────────────────────────────────────────────────────────────

export interface EntityDTO {
  id:      string;
  cluster: string;
  /** 0.0–1.0 anomaly score */
  anomaly: number;
  tx_vol:  number;
  // Sprint 5s+ — securities ontology enrichment. Backend fills these when
  // `entity.id` matches a `security_master.ticker`; for non-security
  // ontology nodes (HUB_*, sector aggregators, watch list, etc.) they
  // remain null. Frontend treats null as "fall back to legacy label".
  display_name?: string | null;
  ticker?:       string | null;
  sector?:       string | null;
}

export interface EdgeDTO {
  from:   string;
  to:     string;
  weight: number;
}

export interface SnapshotDTO {
  entities: EntityDTO[];
  edges:    EdgeDTO[];
  /** ISO-8601 timestamp when the snapshot was assembled */
  ts:       string | null;
}

export interface MigrationStatusDTO {
  /** null when the schema_version table itself is missing */
  applied:  number | null;
  expected: number;
  ok:       boolean;
  reason?:  string | null;
}

export interface ReadinessDTO {
  ok:        boolean;
  database:  boolean;
  redis:     boolean;
  migration: MigrationStatusDTO;
}

// ──────────────────────────────────────────────────────────────────────
//  /v1/audit/recent — Sprint 5o-C-3
// ──────────────────────────────────────────────────────────────────────

/** One agent's contribution to a coordinator decision. The backend
 *  preserves additional fields (e.g. agent-specific notes) but the modal
 *  only renders agent_id + action + confidence today. */
export interface AuditRationale {
  agent_id:   string;
  action:     string;          // 'buy' | 'hold' | 'sell'
  confidence: number;          // 0..1
  /** Forward-compatible bag for agent-specific extras. */
  [extra: string]: unknown;
}

/** One row from `execution_audit`. Time-series per symbol; the modal
 *  renders these newest-first. Mode + executed disambiguate the four
 *  decision shapes:
 *    live + executed=true  → broker filled
 *    live + executed=false → broker rejected (`reason` carries detail)
 *    shadow                → would-be order, gated by ALLOW_LIVE_ORDERS
 *    noop                  → either HOLD signal OR sizer dropped to 0 */
export interface AuditRow {
  ts:                string;          // ISO 8601 UTC
  symbol:            string;
  mode:              'live' | 'shadow' | 'noop';
  executed:          boolean;
  intended_action:   'buy' | 'hold' | 'sell';
  intended_quantity: number;
  order_id:          string | null;
  blocked_by:        string | null;   // guard_id when blocked
  reason:            string | null;
  signal_action:     'buy' | 'hold' | 'sell';
  signal_confidence: number;
  signal_score:      number;
  signal_rationale:  AuditRationale[];
}

export interface AuditRecentDTO {
  symbol: string;
  rows:   AuditRow[];
}

// ──────────────────────────────────────────────────────────────────────
//  /v1/metrics/* — Sprint 5q observability
// ──────────────────────────────────────────────────────────────────────

/** One minute-bucket of coordinator decision activity. Drives the
 *  SystemHealthPanel decisions/min sparkline + alive indicator. */
export interface DecisionBucket {
  bucket:    string;   // ISO 8601
  n_total:   number;
  n_live:    number;
  n_shadow:  number;
  n_noop:    number;
  n_blocked: number;
}

export interface DecisionRateDTO {
  window_minutes: number;
  /** Newest-first; reverse on the client for the left-to-right time axis. */
  buckets:        DecisionBucket[];
}

export interface BlockedReason {
  guard_id:      string;
  n_blocked:     number;
  last_fired_at: string;   // ISO 8601
}

export interface BlockedReasonsDTO {
  window_minutes: number;
  /** Pre-summed across reasons so the HUD doesn't have to reduce
   *  client-side just to label the panel ("N BLOCKED · 60M"). */
  total_blocked:  number;
  /** Sorted descending by n_blocked at the SQL layer. */
  reasons:        BlockedReason[];
}

// ──────────────────────────────────────────────────────────────────────
//  /v1/ticks/recent — Sprint 5p-C (price sparkline data path)
// ──────────────────────────────────────────────────────────────────────

/** One raw tick row from `market_tick`. Drives the PropertyHUD price
 *  sparkline — per-tick resolution inside the current minute, distinct
 *  from the 1m-OHLC continuous aggregate. */
export interface MarketTick {
  ts:     string;             // ISO 8601 UTC
  price:  number;             // KRW for KIS symbols; USD for synthetic
  volume: number;
  side:   'buy' | 'sell';
}

export interface MarketTickRecentDTO {
  symbol: string;
  ticks:  MarketTick[];
}

/** One-symbol latest-tick snapshot entry. Powers the KisLiveSnapshot
 *  HUD grid (Sprint 5p-D) — every KIS subscription at a glance. */
export interface MarketTickSnapshot {
  symbol: string;
  ts:     string;
  price:  number;
  volume: number;
  side:   'buy' | 'sell';
}

export interface MarketTickSnapshotsDTO {
  /** Symbols as the operator (and the backend) parsed them; preserved
   *  in order so the HUD can render placeholder rows when a symbol has
   *  no recorded ticks yet. */
  requested: string[];
  /** Symbols with at least one recorded tick. May be shorter than
   *  `requested` — sort by symbol ascending. */
  snapshots: MarketTickSnapshot[];
}

/** Sprint 5p-E: cross-symbol tape entry. Currently mirrors
 *  MarketTickSnapshot field shape but kept as a distinct type so the
 *  forensic surface can diverge (e.g. add a `seq` or `tradeId` later)
 *  without breaking snapshot consumers. */
export interface MarketTickTapeEntry {
  ts:     string;
  symbol: string;
  price:  number;
  volume: number;
  side:   'buy' | 'sell';
}

export interface MarketTickTapeDTO {
  entries: MarketTickTapeEntry[];
}

/** Sprint 5p-H — relative volume bar entry. */
export interface MarketVolumeBucket {
  symbol:       string;
  total_volume: number;
  tick_count:   number;
}

export interface MarketVolumeWindowDTO {
  window_minutes: number;
  buckets:        MarketVolumeBucket[];
}

// ──────────────────────────────────────────────────────────────────────
//  /v1/alarms — Operator Alarms (Sprint 5t — system_alarm read-side)
// ──────────────────────────────────────────────────────────────────────

/** Severity rank for an `AlarmDTO`. Wire format is the lowercase token
 *  exactly as the Pydantic `Severity(str, Enum)` enum emits — frontend
 *  must compare against these strings, not synthesize numeric ranks. */
export type AlarmSeverity = 'info' | 'warn' | 'anomaly' | 'critical';

/** Lifecycle status for an `AlarmDTO`. Maps directly to the backend
 *  `Status(str, Enum)` enum; the `acknowledged_at` / `resolved_at`
 *  timestamps are non-null precisely when the status implies them. */
export type AlarmStatus = 'active' | 'acknowledged' | 'resolved';

/** One alarm row. Mirrors `nexus-backend.src.api.v1.dto.AlarmDTO`
 *  byte-for-byte — snake_case throughout, no alias remap. The backend's
 *  domain layer enforces these invariants:
 *    status='active'        ⇒ acknowledged_at === null AND resolved_at === null
 *    status='acknowledged'  ⇒ acknowledged_at !== null AND resolved_at === null
 *    status='resolved'      ⇒ resolved_at !== null (ack step optional)
 *    occurred_at ≤ acknowledged_at ≤ resolved_at (time ordering) */
export interface AlarmDTO {
  /** ULID/UUIDv7 — stable identifier, used as the React row key. */
  id:                string;
  severity:          AlarmSeverity;
  status:            AlarmStatus;
  /** Originating component (kebab-case, e.g. `trading-coordinator`). */
  source:            string;
  /** Machine-parseable stable code (UPPER_SNAKE, ≤64). */
  code:              string;
  /** ALL CAPS short label (≤48 chars) shown in the row. */
  title:             string;
  /** Single-line observational message (≤240 chars). */
  message:           string;
  /** Ontology entity id this alarm references — null when no entity. */
  entity_id:         string | null;
  /** Sprint 5s+ — human-readable security display name when `entity_id`
   *  matches a `security_master.ticker`; null otherwise (non-security
   *  ontology node, or no entity at all). AlarmRow renders
   *  `${entity_display} · ${entity_id}` when present, falling back to
   *  the raw `entity_id` when null. */
  entity_display?:   string | null;
  /** ISO-8601 UTC. Newest-first ordering anchor. */
  occurred_at:       string;
  /** ISO-8601 UTC. null while status='active'. */
  acknowledged_at:   string | null;
  /** ISO-8601 UTC. null until status='resolved'. */
  resolved_at:       string | null;
  /** Source-specific extras. Expanded row sorts keys alphabetically. */
  metadata:          Record<string, unknown> | null;
}

/** Envelope returned by `GET /v1/alarms`. `items` is newest-first;
 *  `unacknowledged_count` is a *global* active count (ignores filters);
 *  `window_since` is the effective lower bound (echoed `since` or the
 *  server-applied 24h lookback); `server_time` lets the client compute
 *  age values without trusting the local clock. */
export interface AlarmListDTO {
  items:                AlarmDTO[];
  total:                number;
  unacknowledged_count: number;
  /** ISO-8601 UTC, or null if the backend chose not to apply a lookback. */
  window_since:         string | null;
  server_time:          string;
}

// ──────────────────────────────────────────────────────────────────────
//  /v1/stream WebSocket — Quote (H0STASP0 호가 5단계)
// ──────────────────────────────────────────────────────────────────────

export interface QuoteLevel {
  price:  number;
  volume: number;
}

/** 5-level order book snapshot from KIS H0STASP0.
 *  Discriminated by `type === "quote"` in the WebSocket stream. */
export interface Quote {
  type:   'quote';
  symbol: string;
  ts:     string;           // ISO-8601
  bids:   QuoteLevel[];     // [0] = best bid (highest price), len ≤ 5
  asks:   QuoteLevel[];     // [0] = best ask (lowest price), len ≤ 5
}

// ──────────────────────────────────────────────────────────────────────
//  /v1/health — publisher source indicator
// ──────────────────────────────────────────────────────────────────────

/** Active tick source reported by PublisherSupervisor. */
export type PublisherKind = 'kis' | 'mock' | 'none';

export interface HealthDTO {
  status:    string;
  service:   string;
  publisher: PublisherKind;
}

// ──────────────────────────────────────────────────────────────────────
//  /v1/balance — KIS Balance Panel (holding summary & detail)
// ──────────────────────────────────────────────────────────────────────

export interface HoldingDTO {
  symbol:          string;
  name:            string;
  quantity:        number;
  avg_price:       number;
  current_price:   number;
  eval_amount:     number;
  profit_loss:     number;
  profit_loss_pct: number;
}

export interface BalanceSummaryDTO {
  cash:            number;
  eval_total:      number;
  profit_loss:     number;
  profit_loss_pct: number;
}

export interface BalanceDTO {
  summary:   BalanceSummaryDTO;
  holdings:  HoldingDTO[];
  ts:        string;
}

// ──────────────────────────────────────────────────────────────────────
//  /v1/order — Manual Order Entry
// ──────────────────────────────────────────────────────────────────────

export interface OrderRequestDTO {
  symbol:     string;
  action:     'buy' | 'sell';
  quantity:   number;
  order_type: 'market' | 'limit';
  price:      number;   // 0 = 시장가
}

export interface OrderResponseDTO {
  order_id: string;
  symbol:   string;
  action:   string;
  quantity: number;
  status:   'accepted' | 'rejected';
  message:  string;
  ts:       string;
}

// ──────────────────────────────────────────────────────────────────────
//  /v1/securities — Securities Ontology (Sprint 5s+ master + relations)
// ──────────────────────────────────────────────────────────────────────

/** Where the security is listed. Wire format matches the backend
 *  `SecurityMarket(str, Enum)` exactly. `OTHER` is the catch-all for
 *  pre-IPO / OTC / non-listed instruments we still want to render. */
export type SecurityMarket = 'KRX' | 'KOSDAQ' | 'NASDAQ' | 'NYSE' | 'OTHER';

/** Relation kinds emitted by `GET /v1/securities/relations`. The wire
 *  strings come from the backend `SecurityRelationKind(str, Enum)`.
 *  Today only `sector` (and a few `same_chaebol` / `supply_chain` from
 *  the static seed) are populated; the other variants are reserved so
 *  the frontend can render them without a type bump when the backend
 *  starts emitting correlation/cross-listing data. */
export type SecurityRelationKind =
  | 'sector'
  | 'correlation'
  | 'same_chaebol'
  | 'supply_chain'
  | 'cross_listing';

/** Single security row from the master. Mirror of the backend's
 *  `SecurityDTO` Pydantic model, snake_case throughout. `last_price` /
 *  `change_pct` are always null from the master endpoint — the frontend
 *  joins them in client-side from the `/v1/ticks/snapshot` stream. */
export interface SecurityDTO {
  ticker:             string;
  /** Human-readable name resolved by the backend per §4.1 (option A —
   *  always ko-preferred). Frontend may override with `name_en` in
   *  English language mode. Never null — backend falls through to the
   *  raw ticker when no localized name exists. */
  display_name:       string;
  /** Canonical Korean name. Null for non-KR listings. */
  name_ko:            string | null;
  /** Canonical English name. Null when the ko-only feed wasn't
   *  translated. */
  name_en:            string | null;
  /** Search aliases — pre-normalized synonyms ("Samsung", "SEC", 등).
   *  Empty array means the search index has only the canonical names
   *  to work with. */
  aliases:            string[];
  market:             SecurityMarket;
  /** Internal sector id, joins to `SECTOR:*` relation targets. */
  sector:             string;
  /** Operator-facing sector label (Korean preferred). */
  sector_label:       string;
  /** ISO 4217 currency code. */
  currency:           string;
  /** Float for very large caps, null when undisclosed. */
  shares_outstanding: number | null;
  /** Native currency. Null when the latest tick has not yet landed. */
  market_cap:         number | null;
  /** Latest trade price. Always null on /v1/securities — fetched
   *  separately via the tick stream. */
  last_price:         number | null;
  /** Day-over-day percentage. Always null on /v1/securities — fetched
   *  via the tick stream. */
  change_pct:         number | null;
  /** 0.0–1.0, mirrors EntityDTO.anomaly. Always 0.0 from the master
   *  endpoint; the live value lives in EntityDTO and BackendStreamer. */
  anomaly:            number;
  tx_vol:             number;
  /** True when this ticker is wired into KIS subscriptions and will
   *  receive live ticks via BackendStreamer. */
  is_subscribed:      boolean;
  /** Provenance tag for operator confidence. `static_master` = seed
   *  data; `cached` = backend served stale because upstream is down. */
  data_source:        string;
  /** ISO-8601 — last time the master row was refreshed. The `stale`
   *  badge fires when (`now - updated_at` > 24h) OR `data_source ===
   *  'cached'`. */
  updated_at:         string;
}

/** Envelope returned by `GET /v1/securities`. Items are ticker-ASC
 *  sorted server-side so the search index has a stable order. */
export interface SecurityListDTO {
  items:       SecurityDTO[];
  total:       number;
  /** ISO-8601 — when the backend assembled this envelope. Lets the UI
   *  compute "freshness" without trusting the local clock. */
  server_time: string;
}

/** One graph edge between two securities (or a security and a synthetic
 *  sector hub like `SECTOR:SEMI`). The `directed` flag controls whether
 *  the canvas renders an arrow vs a plain line. */
export interface SecurityRelationDTO {
  from_ticker: string;
  /** May be a real ticker OR a synthetic id with the `SECTOR:` prefix.
   *  When prefixed, the frontend materializes a virtual sector hub node
   *  with `id = to_ticker` and adds it to the graph. */
  to_ticker:   string;
  kind:        SecurityRelationKind;
  /** 0.0–1.0 — used as spring strength in the force-sim. */
  weight:      number;
  directed:    boolean;
  /** Free-text provenance ("KRX sector classification", "co-listed
   *  ADR", etc.). Surfaced in PropertyHUD on demand. */
  evidence:    string | null;
}

// ──────────────────────────────────────────────────────────────────────
//  ApiResult — discriminated union the wrapper returns
// ──────────────────────────────────────────────────────────────────────

/**
 * Discriminated union: every API call resolves to either a successful
 * response with typed `data`, or a failure carrying a `problem`.
 * The discriminator is `ok` so consumers can write
 *   if (!result.ok) { handle(result.problem); return; }
 * and TypeScript narrows from there.
 */
export type ApiResult<T> =
  | { ok: true;  data:    T;             requestId: string }
  | { ok: false; problem: ProblemDetail; requestId: string };
