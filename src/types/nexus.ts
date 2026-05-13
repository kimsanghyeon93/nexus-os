// NEXUS OS — shared domain types
// Used by hooks, components, and (eventually) the market-package WS adapter.

export type ClusterId =
  | 'CB' | 'SOV' | 'EQ' | 'FX' | 'COMM'
  | 'CRYPTO' | 'MACRO' | 'WATCH' | 'KRX' | 'MOMENTUM';

export type ClusterColor = 'cyan' | 'lime' | 'amber' | 'purple';

export type EntityType =
  | 'hub' | 'central_bank' | 'bond' | 'equity_sector'
  | 'us_equity' | 'kr_equity' | 'fx'
  | 'commodity' | 'crypto' | 'wallet' | 'mixer' | 'exchange'
  | 'macro' | 'corporation' | 'holding' | 'bank';

export interface ClusterDef {
  id: ClusterId;
  label: string;
  /** normalized 0..1 anchor on canvas */
  cx: number;
  cy: number;
  color: ClusterColor;
  mark: string;
  anomaly?: boolean;
}

export interface NexusEntity {
  id: string;
  label: string;
  type: EntityType;
  cluster: ClusterId;
  clusterColor: ClusterColor;
  mark: string;
  /** current normalized position (mutated by sim) */
  x: number;
  y: number;
  /** anchor (immutable target for the spring) */
  baseX: number;
  baseY: number;
  /** legacy orbital fields — retained for back-compat, unused by force sim */
  orbitR: number;
  orbitSpeed: number;
  orbitPhase: number;
  isHub: boolean;
  jurisdiction: string;
  founded: number | null;
  /** 0..1 — >0.7 marks a critical anomaly (lime semantic) */
  anomaly: number;
  sanctioned: boolean;
  /** raw transactional volume in $M */
  txVol: number;
  /** populated post-build */
  degree?: number;
  eigen?: number;
}

// Sprint 5s+: 'sector' edge kind. Stocks → their sector hub (KRX
// stocks → KRX_SEMI/AUTO/etc.; US momentum tickers → XLK/XLF/etc.)
// got rendered identically to "random cross-cluster" lines, hiding
// the ontology's most semantically loaded relationship. The new kind
// gets its own styling (cluster-colored, higher alpha) so the sector
// membership graph is the FIRST thing the operator's eye picks up.
export type EdgeKind = 'cluster' | 'inter' | 'sector';

export interface NexusEdge {
  from: string;
  to: string;
  /** USD value of the aggregated flow */
  usd: number;
  /** sample count */
  n: number;
  /** 0..1 — >0.7 highlights as anomalous (lime) */
  anomaly: number;
  kind: EdgeKind;
}

export interface NexusDataset {
  ENTITIES: NexusEntity[];
  TX: NexusEdge[];
  CLUSTERS: ClusterDef[];
}

// ---------- Live API telemetry ----------

export interface ApiTelemetry {
  /** rolling buffer of packets/sec samples (most-recent last) */
  pkts: number[];
  /** current latency in ms (jittery) */
  latencyMs: number;
  /** packet rate (last sample) */
  pktRate: number;
  /** human-readable feed name, e.g. 'market-pkg/v4' */
  feed: string;
  /** 'live' | 'degraded' | 'down' — currently always 'live' in dummy mode */
  status: 'live' | 'degraded' | 'down';
}

export interface SsoSession {
  protocol: 'SAML 2.0' | 'OIDC';
  verified: boolean;
  expiresIn: string; // hh:mm:ss
}

// ---------- Centrality / view config ----------

export type CentralityMode = 'eigen' | 'degree' | 'volume';
export type EdgeMode = 'curved' | 'straight';

export interface GraphViewConfig {
  glowIntensity: number;
  dataDensity: number;
  edgeMode: EdgeMode;
  showFlow: boolean;
  centrality: CentralityMode;
}
