// NEXUS OS canonical color palette.
//
// Sprint 5s+ loop consolidation: the same 8-token palette was duplicated
// across three files — RadarCanvas.tsx had `const COLOR = {...}`, AuditModal
// had `const TONE_COLOR = {...}` (subset of the same values), and
// TopBarOverlay had its own `const COLOR = {...}`. Every hex literal
// matched exactly, so a palette tweak required edits in three places
// AND any new component had to copy-paste the values yet again.
//
// This module is the single source of truth. Every NEXUS component that
// renders to canvas or inline styles should import from here. CSS-in-CSS
// surfaces (dashboard.css) define their own `--cyan` / `--lime` /
// etc. variables that match these values; both layers must stay in lockstep.
//
// Semantic contract per token (must not drift across surfaces):
//
//   cyan   — Western/developed-markets baseline. Default cluster tone for
//             CENTRAL BANKS, SOVEREIGN BONDS, US EQUITY SECTORS, MOMENTUM,
//             MACRO INDICATORS. Also the canvas-chrome accent (sweep
//             beam, polar rings, default edge tint).
//   purple — Non-USD / EM / exotic risk. FX PAIRS, DIGITAL ASSETS (crypto),
//             KRX · KOSPI SECTORS.
//   amber  — Hard commodity risk. COMMODITIES cluster + diff-overlay 'new'
//             edge dash. Reserved for orange-spectrum signals.
//   lime   — Watchlist + anomaly. SANCTION / WATCH cluster, anomaly>0.7
//             nodes/edges, anomaly-edge counter in the top-right HUD.
//             Treat as the highest-attention color: lime always means
//             "look here NOW".
//   bone   — Body text / labels on dark surfaces.
//   ash    — Dim text labels, idle cluster legend chips.
//   low    — Subtle separators, near-invisible structural hairlines.
//   void   — Canvas background sentinel (matches dashboard glass tone).

export const NEXUS_COLOR = {
  cyan:   '#00BFFF',
  lime:   '#DEFF9A',
  amber:  '#FFB200',
  purple: '#A855F7',
  bone:   '#E8ECF5',
  ash:    '#8A93A8',
  low:    '#4A5066',
  void:   '#050510',
} as const;

export type NexusColorToken = keyof typeof NEXUS_COLOR;

/** Build an `rgba(...)` string from any NEXUS palette hex + an alpha 0..1.
 *
 *  Sprint 5s+ loop iteration: was 14 sites of `'rgba(0, 191, 255, X)'`
 *  scattered across AuditModal / CommandCenter / KisLiveSnapshot / App
 *  with the literal `0, 191, 255` re-typed every time. If the canonical
 *  cyan hex (#00BFFF = rgb(0,191,255)) were tweaked, those RGB triplets
 *  would silently drift from the palette. `withAlpha(NEXUS_COLOR.cyan,
 *  0.30)` derives the RGB from the same hex the palette exports, so a
 *  palette tweak propagates everywhere automatically.
 *
 *  Input must be a 6-digit `#RRGGBB` hex (the NEXUS_COLOR shape). Output
 *  is a valid CSS rgba() string. Invalid input falls back to the hex
 *  itself (so the call never throws inline in a style object). */
/** Surface tones — semi-transparent "deep glass" backgrounds used by
 *  modals, overlays, and floating toasts. These are NOT the canonical
 *  hue palette; they're the cool-dark substrate everything else floats
 *  on top of. Each panel surface used to inline its own near-black
 *  rgba with slight tint drift (#0b0b18 vs #080a14 vs #050510), and
 *  the alpha was hand-tuned per surface — toasts/frames at 0.92 for
 *  "near-opaque", backdrops at 0.62-0.78 for "see-through dim".
 *
 *  Sprint 5s+ loop iter 9 Track A: codified as three named tones so a
 *  future "lighter" or "warmer" surface family is a single edit. */
export const NEXUS_SURFACE = {
  /** Floating panels + toasts. Cool charcoal, near-opaque. */
  panel:    'rgba(11, 11, 24, 0.92)',
  /** Modal frames sitting over a backdrop. Slightly cooler than panel. */
  frame:    'rgba(8, 10, 20, 0.92)',
  /** Semi-transparent backdrop behind an open modal. Darker, lower α. */
  backdrop: 'rgba(2, 4, 12, 0.78)',
  /** Lighter backdrop variant used when the modal beneath needs more
   *  context-visibility (TopBarOverlay tabs). */
  backdropLite: 'rgba(5, 5, 16, 0.62)',
} as const;

export type NexusSurfaceToken = keyof typeof NEXUS_SURFACE;

export function withAlpha(hex: string, alpha: number): string {
  if (!/^#[0-9A-Fa-f]{6}$/.test(hex)) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
