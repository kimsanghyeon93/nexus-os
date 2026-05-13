// Operator identity — single source of truth for the badge that
// appears in the TopBar (top-right) and CommandCenter footer.
// Sprint 5s+ loop iteration: the values used to be hardcoded as
// "J.VANCE" + "Ω" in two separate components — TopBar had it as a
// prop default, CommandCenter had it inline as a literal. Any rename
// required edits in both places; worse, a real deploy would still
// ship the placeholder name.
//
// The helper reads VITE_OPERATOR_NAME and VITE_OPERATOR_CLEARANCE at
// build time. Default fallbacks preserve the cinematic JARVIS feel for
// demos that don't set the env vars.
//
// Future: when SSO actually lands (currently the SsoSession in
// useMarketData is mocked too), this should pull from the SSO claim
// instead. Until then env-driven config beats two-place duplication.

interface OperatorIdentity {
  /** TopBar "OP · J.VANCE" form */
  topbar: string;
  /** CommandCenter footer "OPERATOR · J.VANCE · CLEARANCE Ω" form */
  footer: string;
  /** Bare name for code that needs just the identifier */
  name: string;
  /** Clearance level glyph */
  clearance: string;
}

const DEFAULT_NAME      = 'J.VANCE';
const DEFAULT_CLEARANCE = 'Ω';

function readEnv(key: string): string | undefined {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  return env?.[key];
}

export function getOperatorIdentity(): OperatorIdentity {
  const name      = readEnv('VITE_OPERATOR_NAME')      ?? DEFAULT_NAME;
  const clearance = readEnv('VITE_OPERATOR_CLEARANCE') ?? DEFAULT_CLEARANCE;
  return {
    name,
    clearance,
    topbar: `OP · ${name}`,
    footer: `OPERATOR · ${name} · CLEARANCE ${clearance}`,
  };
}
