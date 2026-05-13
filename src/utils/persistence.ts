// persistence.ts — best-effort localStorage helpers for operator preferences.
//
// All access is wrapped in try/catch because:
//   • Safari Private Browsing throws QuotaExceededError on setItem.
//   • Strict cookie/storage policies (cross-origin iframes, kiosk modes,
//     deliberately-disabled storage) make `window.localStorage` itself throw.
//   • SSR / build-time evaluation has no window.
//
// On any failure we silently fall through to the in-memory default. The HUD
// must never crash because storage is disabled.

const STORAGE_KEY  = 'nexus_os_v1_source_pref';
const LAYOUT_KEY   = 'nexus_os_v1_layout_pref';
const TOUR_KEY     = 'nexus_os_v1_tour_seen';
const POSITIONS_KEY = 'nexus_os_v1_node_positions';

/** Read the persisted source. Validated against the caller's allowlist so a
 *  tampered or stale localStorage value can never put the harness into an
 *  unknown state. Falls back to the supplied default on any miss/error. */
export function loadSourcePref<T extends string>(
  allowlist: ReadonlyArray<T>,
  fallback: T,
): T {
  try {
    if (typeof window === 'undefined') return fallback;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw && (allowlist as ReadonlyArray<string>).includes(raw)) {
      return raw as T;
    }
  } catch {
    // Storage disabled / quota exceeded / SecurityError — fall through.
  }
  return fallback;
}

/** Write the source preference. Failures are swallowed because persistence is
 *  a quality-of-life feature, not a correctness guarantee. */
export function saveSourcePref(source: string): void {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(STORAGE_KEY, source);
  } catch {
    // Safari Private Mode / quota / SecurityError — swallow silently.
  }
}

/* ------------------------------------------------------------------ */
/*  Layout preference (right-column collapse, future panel toggles)    */
/* ------------------------------------------------------------------ */

/** JSON-encoded so we can extend without churning the storage key.
 *  Adding a new layout flag here is non-breaking — old payloads parse
 *  successfully and missing fields fall back to their declared defaults. */
export interface LayoutPref {
  leftCollapsed: boolean;
  rightCollapsed: boolean;
}

const LAYOUT_DEFAULT: LayoutPref = {
  leftCollapsed:  false,
  rightCollapsed: false,
};

export function loadLayoutPref(): LayoutPref {
  try {
    if (typeof window === 'undefined') return LAYOUT_DEFAULT;
    const raw = window.localStorage.getItem(LAYOUT_KEY);
    if (!raw) return LAYOUT_DEFAULT;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return LAYOUT_DEFAULT;
    const obj = parsed as Record<string, unknown>;
    // Defensive: each field validated + defaulted independently so a
    // partially-corrupted payload doesn't throw away usable bits.
    return {
      leftCollapsed:
        typeof obj.leftCollapsed === 'boolean'
          ? obj.leftCollapsed
          : LAYOUT_DEFAULT.leftCollapsed,
      rightCollapsed:
        typeof obj.rightCollapsed === 'boolean'
          ? obj.rightCollapsed
          : LAYOUT_DEFAULT.rightCollapsed,
    };
  } catch {
    return LAYOUT_DEFAULT;
  }
}

export function saveLayoutPref(pref: LayoutPref): void {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(pref));
  } catch {
    // Same safety blanket as saveSourcePref.
  }
}

/* ------------------------------------------------------------------ */
/*  Onboarding tour (boot sequence overlay)                            */
/* ------------------------------------------------------------------ */

/** Has this browser already seen the JARVIS boot sequence? Returns false on
 *  any storage failure so first-run experience is preserved over silence. */
export function loadTourSeen(): boolean {
  try {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(TOUR_KEY) === 'true';
  } catch {
    return false;
  }
}

export function saveTourSeen(): void {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(TOUR_KEY, 'true');
  } catch {
    // Best-effort — operator just sees the tour again next time.
  }
}

/* ------------------------------------------------------------------ */
/*  Node positions (Obsidian-style drag persistence — Sprint 5s+)      */
/* ------------------------------------------------------------------ */
//
// When the operator drags a node into a layout that makes sense to them
// (cluster proximity, sector grouping, "this asset belongs over here"),
// that arrangement should survive a reload. Without persistence, every
// page refresh would warp the canvas back to the seed positions and
// the operator would have to redo their organization — frustrating
// after even a few drags.
//
// Storage shape: `{ [entityId]: { bx: number; by: number } }`. We store
// only the anchor (bx/by, unit-square 0..1) — NOT the live x/y, because
// the force-sim continuously perturbs x/y and storing a snapshot of
// those would jitter on every release. Anchors are stable: the sim
// springs each node toward bx*W, by*H, so persisting bx/by is enough
// to reproduce the drop location at any canvas size.
//
// Entries for unknown entity ids are silently dropped on load (e.g.,
// after a dataset rename or a frontend deletion). Coordinates outside
// [0, 1.5] are clamped — a stray bad value won't fling a node off-canvas.

export type NodePositionMap = Record<string, { bx: number; by: number }>;

/** Load saved anchor positions. Returns an empty object on any failure
 *  (storage disabled, corrupt JSON, wrong shape) so the canvas just
 *  falls back to seed positions instead of crashing. */
export function loadNodePositions(): NodePositionMap {
  try {
    if (typeof window === 'undefined') return {};
    const raw = window.localStorage.getItem(POSITIONS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: NodePositionMap = {};
    for (const [id, val] of Object.entries(parsed as Record<string, unknown>)) {
      if (!val || typeof val !== 'object') continue;
      const obj = val as { bx?: unknown; by?: unknown };
      if (typeof obj.bx !== 'number' || typeof obj.by !== 'number') continue;
      if (!Number.isFinite(obj.bx) || !Number.isFinite(obj.by)) continue;
      // Clamp loosely — a value of 1.2 means "100px off the right edge",
      // which is fine if the canvas later grows. A value of 50 is corrupt.
      out[id] = {
        bx: Math.max(-0.5, Math.min(1.5, obj.bx)),
        by: Math.max(-0.5, Math.min(1.5, obj.by)),
      };
    }
    return out;
  } catch {
    return {};
  }
}

/** Write a single node's anchor (merge into existing map). Best-effort
 *  — failures are swallowed because the operator can always re-drag if
 *  Safari Private Mode silently rejected the write. */
export function saveNodePosition(id: string, bx: number, by: number): void {
  try {
    if (typeof window === 'undefined') return;
    const current = loadNodePositions();
    current[id] = { bx, by };
    window.localStorage.setItem(POSITIONS_KEY, JSON.stringify(current));
  } catch {
    // Same safety blanket as the other writers.
  }
}

/** Wipe all saved positions — reset-layout escape hatch. */
export function clearNodePositions(): void {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.removeItem(POSITIONS_KEY);
  } catch {
    // Best-effort.
  }
}
