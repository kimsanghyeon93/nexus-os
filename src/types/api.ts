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
