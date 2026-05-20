// securitiesDataset — build NexusEntity / NexusEdge / ClusterDef arrays
// from the SecurityDTO + SecurityRelationDTO master data returned by
// `useSecurities()`.
//
// The legacy `buildDataset()` in `useMarketData.ts` hardcoded 80+ nodes
// and 100+ edges. Sprint 5s+ swaps the KIS-traded subset of that mock
// for live master data while preserving the non-security ontology nodes
// (HUB_*, sector aggregators, MACRO, SOV, WATCH, etc.) — those are
// still useful as a topological scaffold and have no master endpoint
// today. The merge strategy:
//
//   - For every SecurityDTO row, mint a NexusEntity. ID = ticker so the
//     existing BackendStreamer tick→mutation path (`entity.id ===
//     m.entityId`) resolves first-hit. Cluster id = "MKT:" + market so
//     existing render filters (centralityMode, anomaly halos, etc.)
//     keep working on a familiar cluster id shape.
//   - For every SecurityRelationDTO row, mint a NexusEdge. SECTOR:*
//     to_ticker prefixes become synthetic hub nodes (one per distinct
//     id). These act as cluster-level "sector aggregators" similar to
//     the legacy XLK/SMH hubs but driven by data, not hardcoded.
//   - Cluster definitions for each distinct market and synthetic sector
//     are appended on demand so RadarCanvas's overlay legend still
//     renders something sensible.

import type {
  ClusterColor,
  ClusterDef,
  ClusterId,
  NexusEdge,
  NexusEntity,
} from '../types/nexus';
import type {
  SecurityDTO,
  SecurityRelationDTO,
} from '../types/api';

/** Output shape — same fields as NexusDataset but exposed separately so
 *  the caller (useMarketData) can merge with the legacy ontology arrays. */
export interface SecuritiesDatasetParts {
  entities: NexusEntity[];
  edges:    NexusEdge[];
  clusters: ClusterDef[];
}

/** Per-market visual hint. Picks a NEXUS palette color + a hub position
 *  in unit-square coords. KRX corners up-right (legacy KRX cluster),
 *  US markets up-left/up-middle. OTHER falls back to amber bottom-right. */
const MARKET_HINTS: Record<string, { color: ClusterColor; cx: number; cy: number }> = {
  KRX:    { color: 'purple', cx: 0.85, cy: 0.30 },
  KOSDAQ: { color: 'purple', cx: 0.85, cy: 0.55 },
  NASDAQ: { color: 'cyan',   cx: 0.20, cy: 0.30 },
  NYSE:   { color: 'cyan',   cx: 0.20, cy: 0.55 },
  OTHER:  { color: 'amber',  cx: 0.50, cy: 0.78 },
};

/** Color a synthetic sector hub by guessing from the sector id token.
 *  Maintains visual continuity with the legacy KRX_SEMI / XLK conventions. */
function sectorColor(sectorId: string): ClusterColor {
  const up = sectorId.toUpperCase();
  if (up.includes('FIN'))                                return 'cyan';
  if (up.includes('BIO') || up.includes('HEALTH'))       return 'lime';
  if (up.includes('ENERGY') || up.includes('OIL'))       return 'amber';
  if (up.includes('AUTO') || up.includes('BATT'))        return 'amber';
  return 'cyan';
}

/** Build NexusDataset parts from a securities envelope.
 *
 *  Performance: O(N + E + S) where N = securities, E = relations,
 *  S = distinct sector hubs. Position seeding uses a deterministic
 *  hash of the ticker so the same input always yields the same canvas
 *  positions — useful for screenshot diffs and the localStorage drag-
 *  position persistence (which keys off id). */
export function buildSecuritiesDataset(
  securities: SecurityDTO[],
  relations:  SecurityRelationDTO[],
): SecuritiesDatasetParts {
  const entities: NexusEntity[] = [];
  const edges:    NexusEdge[]   = [];
  const clusters: ClusterDef[]  = [];

  // ── 1. Cluster definitions for each distinct market ──────────────────
  const seenMarkets = new Set<string>();
  for (const s of securities) {
    if (seenMarkets.has(s.market)) continue;
    seenMarkets.add(s.market);
    const hint = MARKET_HINTS[s.market] ?? MARKET_HINTS['OTHER']!;
    clusters.push({
      id:    `MKT:${s.market}` as ClusterId,
      label: `${s.market} MARKET`,
      cx:    hint.cx,
      cy:    hint.cy,
      color: hint.color,
      mark:  'hexagon',
    });
  }

  // ── 2. Materialize securities as NexusEntity rows ────────────────────
  for (const s of securities) {
    const hint = MARKET_HINTS[s.market] ?? MARKET_HINTS['OTHER']!;
    // Deterministic jitter around the market hub — sin/cos on a hash of
    // the ticker gives a stable per-mount position. Real layout will
    // override via the force-sim once it starts iterating.
    const h = hashString(s.ticker);
    const angle = (h % 360) * (Math.PI / 180);
    const radius = 0.08 + ((h >> 8) % 100) / 1000;
    const x = hint.cx + Math.cos(angle) * radius;
    const y = hint.cy + Math.sin(angle) * radius * 0.65;

    entities.push({
      id:           s.ticker,
      label:        s.display_name,
      type:         s.market === 'KRX' || s.market === 'KOSDAQ' ? 'kr_equity' : 'us_equity',
      cluster:      `MKT:${s.market}` as ClusterId,
      clusterColor: hint.color,
      mark:         'hexagon',
      x, y,
      baseX: x, baseY: y,
      orbitR: 0, orbitSpeed: 0, orbitPhase: 0,
      isHub: false,
      jurisdiction: marketToJurisdiction(s.market),
      founded: null,
      anomaly: s.anomaly,
      sanctioned: false,
      txVol: s.tx_vol,
      // Sprint 5s+ — securities-specific metadata. RadarCanvas mode
      // 'securities' reads these for size / color / hover-card.
      display_name: s.display_name,
      ticker:       s.ticker,
      market:       s.market,
      sectorLabel:  s.sector_label,
      currency:     s.currency,
      marketCap:    s.market_cap,
      lastPrice:    s.last_price,
      changePct:    s.change_pct,
      isSubscribed: s.is_subscribed,
      dataSource:   s.data_source,
      aliases:      s.aliases,
    });
  }

  // ── 3. Process relations → edges + synthetic sector hubs ─────────────
  const sectorHubsSeen = new Set<string>();
  for (const r of relations) {
    // SECTOR:* targets materialize as virtual hub nodes the first time
    // we see them. Position them at a deterministic spot near the
    // market center of their primary tickers' cluster — quick rule:
    // place at canvas-center (0.5, 0.5) and let the force-sim float
    // them into place via incoming sector-spring edges.
    if (r.to_ticker.startsWith('SECTOR:') && !sectorHubsSeen.has(r.to_ticker)) {
      sectorHubsSeen.add(r.to_ticker);
      const sectorId = r.to_ticker.slice('SECTOR:'.length);
      const c = sectorColor(sectorId);
      entities.push({
        id:           r.to_ticker,
        label:        sectorId,
        type:         'equity_sector',
        cluster:      'EQ',
        clusterColor: c,
        mark:         'hexagon',
        x: 0.5, y: 0.5, baseX: 0.5, baseY: 0.5,
        orbitR: 0, orbitSpeed: 0, orbitPhase: 0,
        isHub: true,
        jurisdiction: 'GLOBAL',
        founded: null,
        anomaly: 0,
        sanctioned: false,
        txVol: 0,
        sectorLabel: sectorId,
      });
    }

    // Map relation kind → existing EdgeKind:
    //   'sector' → 'sector'    (the new 5s+ kind, full visibility)
    //   else     → 'inter'     (cross-asset / weaker)
    const kind = r.kind === 'sector' ? 'sector' : 'inter';

    edges.push({
      from: r.from_ticker,
      to:   r.to_ticker,
      // We don't have a real USD value for sector membership — use the
      // weight as a stand-in so the existing edge thickness / particle
      // count heuristics produce sensible output without a special case.
      usd:  r.weight * 1_000_000,
      n:    1,
      anomaly: 0,
      kind,
    });
  }

  return { entities, edges, clusters };
}

// ── helpers ────────────────────────────────────────────────────────────

function hashString(s: string): number {
  // Tiny FNV-1a variant — enough variance for layout seeding, no crypto.
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

function marketToJurisdiction(market: string): string {
  switch (market) {
    case 'KRX':
    case 'KOSDAQ':
      return 'KR';
    case 'NASDAQ':
    case 'NYSE':
      return 'US';
    default:
      return 'GLOBAL';
  }
}

/** Compute the operator-facing `display_name` given a SecurityDTO and an
 *  optional language preference. Implements §4.1 option-A semantics with
 *  the §4.1 footnote's "en mode → name_en → name_ko → ticker" fallback
 *  re-ordering. Backend always returns ko-preferred `display_name`; this
 *  helper lets components re-resolve on the client when the operator
 *  flips i18n. */
export function pickDisplayName(
  s: Pick<SecurityDTO, 'display_name' | 'name_ko' | 'name_en' | 'ticker'>,
  lang: 'ko' | 'en' = 'ko',
): string {
  if (lang === 'en') {
    return s.name_en ?? s.name_ko ?? s.ticker;
  }
  return s.display_name ?? s.name_ko ?? s.name_en ?? s.ticker;
}
