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
