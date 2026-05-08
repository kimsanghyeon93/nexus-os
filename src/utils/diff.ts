// diff.ts — compute per-entity AND per-edge deltas between the live ontology
// and a dropped snapshot. Drives the PropertyHUD's "+X%" readouts, the canvas
// amber/cyan node coloring, AND the dashed-edge overlay (new/broken).
//
// Conventions:
//   • Delta = LIVE - REPLAY. Positive means the live state is HIGHER than
//     the dropped snapshot (entity grew); negative means it shrank.
//   • Entities present in only one side get a pseudo-zero on the missing
//     side so the same delta math applies.
//   • Edge keys are directional: `${from}->${to}`. A→B and B→A are distinct.

import type { NexusDataset, NexusEdge } from '../types/nexus';

export interface EntityDelta {
  entityId: string;
  liveAnomaly:    number;
  replayAnomaly:  number;
  anomalyDelta:   number;  // live - replay, range roughly [-1, +1]
  liveTxVol:      number;
  replayTxVol:    number;
  txVolDelta:     number;
  /** Convenience classification used by the canvas color override.
   *  'up'   ⇒ amber/red (anomaly grew above noise floor)
   *  'down' ⇒ cyan      (anomaly receded)
   *  'flat' ⇒ no visual change vs the dropped snapshot */
  tone: 'up' | 'down' | 'flat';
}

const ANOMALY_BAND = 0.10;  // ±10% considered noise — flat tone

/** Edge-level diff record. `kind === 'broken'` carries the original replay
 *  edge so the caller can inject it into the live TX array (otherwise the
 *  canvas iterator never sees it and the dashed line never renders). */
export interface EdgeDelta {
  key:  string;  // `${from}->${to}` — directional
  from: string;
  to:   string;
  kind: 'new' | 'broken';
  source?: NexusEdge;
}

export interface DiffResult {
  entityDeltas: Map<string, EntityDelta>;
  /** Edges present in LIVE but not in REPLAY — rendered as amber dashed. */
  newEdges:    EdgeDelta[];
  /** Edges present in REPLAY but not in LIVE — rendered as low-opacity
   *  cyan dashed (the live transport may have evicted these). */
  brokenEdges: EdgeDelta[];
}

function edgeKey(e: { from: string; to: string }): string {
  return `${e.from}->${e.to}`;
}

export function computeDiff(
  live: NexusDataset,
  replay: NexusDataset,
): DiffResult {
  /* Entity deltas */
  const entityDeltas = new Map<string, EntityDelta>();
  const replayById = new Map(replay.ENTITIES.map(e => [e.id, e]));

  for (const liveEnt of live.ENTITIES) {
    const r = replayById.get(liveEnt.id);
    const replayAnomaly = r?.anomaly ?? 0;
    const replayTxVol   = r?.txVol   ?? 0;
    const anomalyDelta  = liveEnt.anomaly - replayAnomaly;
    const txVolDelta    = liveEnt.txVol   - replayTxVol;
    const tone: EntityDelta['tone'] =
      anomalyDelta >  ANOMALY_BAND ? 'up'   :
      anomalyDelta < -ANOMALY_BAND ? 'down' :
                                     'flat';
    entityDeltas.set(liveEnt.id, {
      entityId:      liveEnt.id,
      liveAnomaly:   liveEnt.anomaly,
      replayAnomaly,
      anomalyDelta,
      liveTxVol:     liveEnt.txVol,
      replayTxVol,
      txVolDelta,
      tone,
    });
  }

  /* Topology diff — directional edge sets */
  const liveKeys   = new Set(live.TX.map(edgeKey));
  const replayKeys = new Set(replay.TX.map(edgeKey));
  const newEdges:    EdgeDelta[] = [];
  const brokenEdges: EdgeDelta[] = [];

  for (const tx of live.TX) {
    const k = edgeKey(tx);
    if (!replayKeys.has(k)) {
      newEdges.push({ key: k, from: tx.from, to: tx.to, kind: 'new' });
    }
  }
  for (const tx of replay.TX) {
    const k = edgeKey(tx);
    if (!liveKeys.has(k)) {
      brokenEdges.push({ key: k, from: tx.from, to: tx.to, kind: 'broken', source: tx });
    }
  }

  return { entityDeltas, newEdges, brokenEdges };
}

/* ------------------------------------------------------------------ */
/*  Aggregate metrics — drives the DiffSummaryCard war-room readout    */
/* ------------------------------------------------------------------ */

export interface DiffSummary {
  entitiesUp:    number;  // tone === 'up'   → amber
  entitiesDown:  number;  // tone === 'down' → cyan
  entitiesFlat:  number;  // tone === 'flat' → unchanged
  edgesNew:      number;  // present in live, absent from replay → amber dashed
  edgesBroken:   number;  // present in replay, absent from live → cyan ghost
}

/** Active diff highlight filter — selected via DiffSummaryCard tile click.
 *  Drives the RadarCanvas dim/highlight pass: matching items render at full
 *  opacity, everything else fades to a faint contextual ghost. */
export type DiffFilter =
  | 'entities-up'
  | 'entities-down'
  | 'edges-new'
  | 'edges-broken'
  | null;

export function summarizeDiff(
  entityDeltas: ReadonlyMap<string, EntityDelta>,
  diffEdgeMap:  ReadonlyMap<string, 'new' | 'broken'>,
): DiffSummary {
  let entitiesUp = 0, entitiesDown = 0, entitiesFlat = 0;
  for (const d of entityDeltas.values()) {
    if      (d.tone === 'up')   entitiesUp++;
    else if (d.tone === 'down') entitiesDown++;
    else                        entitiesFlat++;
  }
  let edgesNew = 0, edgesBroken = 0;
  for (const k of diffEdgeMap.values()) {
    if (k === 'new')    edgesNew++;
    else if (k === 'broken') edgesBroken++;
  }
  return { entitiesUp, entitiesDown, entitiesFlat, edgesNew, edgesBroken };
}
