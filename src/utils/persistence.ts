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

const STORAGE_KEY = 'nexus_os_v1_source_pref';
const LAYOUT_KEY  = 'nexus_os_v1_layout_pref';
const TOUR_KEY    = 'nexus_os_v1_tour_seen';

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
