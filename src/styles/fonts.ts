// NEXUS OS typography tokens.
//
// Sprint 5s+ loop consolidation: the JetBrains Mono font-family string
// was duplicated 18 times across 11 files — every HUD panel re-declared
// the same `'"JetBrains Mono", ui-monospace, monospace'` literal, and
// two of the duplications had subtle drift (one dropped `ui-monospace`,
// one wrapped the canvas font-shorthand around a slightly different
// form). A font swap meant 18 edits AND the drift was a latent
// inconsistency between text rendered in canvas vs DOM.
//
// One token, one truth. Canvas use cases that need the size + weight
// prefix (`ctx.font = "500 9px <family>"`) compose this string with a
// template literal — see usage in RadarCanvas.tsx.

/** Monospace stack for every NEXUS HUD surface. `ui-monospace` keeps
 *  macOS rendering crisp on Safari; the bare `monospace` is the final
 *  fallback when the typeface isn't loaded yet. */
export const FONT_MONO = '"JetBrains Mono", ui-monospace, monospace';
