// RadarCanvas — high-performance <canvas> graph renderer.
// • Constrained force-directed layout (anchored hubs, member springs)
// • Cascading wave on selection (BFS, attenuated per hop)
// • Polar radar arm sweep (6s revolution) with concentric range rings
// • Curved/straight edges, particle flow, anomaly halos
// • Hover/click hit-test against current sim positions

import {
  forwardRef,
  useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState,
} from 'react';
import type {
  CentralityMode,
  ClusterDef,
  EdgeMode,
  NexusEdge,
  NexusEntity,
} from '../../types/nexus';
import type { DiffFilter, EntityDelta } from '../../utils/diff';
import {
  clearNodePositions,
  loadNodePositions,
  saveNodePosition,
} from '../../utils/persistence';
import { NEXUS_COLOR, withAlpha } from '../../styles/colors';
import { FONT_MONO } from '../../styles/fonts';
import { useLanguage } from '../../utils/i18n';
import { screenToWorld, useViewport } from './useViewport';

/** Imperative handle exposed via React.forwardRef so the parent can drive
 * commands like Analyze Cluster (zoom + pan to a cluster) without lifting
 * the entire viewport state up. */
export interface RadarCanvasHandle {
  /** Sprint 5o-B Command "Analyze cluster" (⌘A). Smoothly zooms the
   * viewport to scale=3 and pans so the cluster center sits at canvas
   * midpoint. Unknown clusterId is a no-op (logged). */
  analyzeCluster: (clusterId: string) => void;
  /** Reset the viewport to identity (instant, no tween). Useful when
   * the operator wants to bail back to fit-all without waiting for the
   * dblclick easing. */
  resetView: () => void;
  /** Sprint 5s+ escape hatch: wipe all saved drag positions and snap
   * every node back to its dataset-seeded anchor. Run when the operator
   * wants the canonical layout back after they've dragged things around
   * for exploration. Bound to the existing `clearNodePositions()`
   * helper so the localStorage key + memory both get reset. */
  resetLayout: () => void;
}

// Sprint 5s+ loop iteration: palette moved to `src/styles/colors.ts`
// (shared with AuditModal + TopBarOverlay). `COLOR` here is a local
// alias so the inline usage stays terse — every reference inside the
// render loop reads `COLOR.cyan` etc. just like before, the source
// of truth is now the import. See the colors module for semantic
// docs per token.
const COLOR = NEXUS_COLOR;

/** Alpha multiplier for items that don't match the active diff filter.
 *  Low enough to ghost out, high enough to preserve topological context. */
const DIM_FACTOR = 0.06;

/** Maximum BFS depth for any "ripple from selected entity" traversal.
 *
 *  Used by:
 *    • cascading anomaly wave (selection-triggered shock animation)
 *    • ⌘T Trace flow path (forward-edge reachability highlight)
 *    • shock anomaly propagation depth elsewhere in the codebase
 *
 *  Sprint 5s+ loop cleanup: was duplicated as a local `const MAX_HOPS = 4`
 *  in two separate places. Both intentionally used 4 hops to keep the
 *  ⌘T cone visually matching the cascading wave's reach — bumping
 *  this in two spots independently would silently desync the two
 *  surfaces. Now they share one number; the invariant is enforced by
 *  TypeScript instead of code review. 4 is the operator-facing
 *  contract: "ripples reach 4 hops, no further". */
const MAX_RIPPLE_HOPS = 4;

function nodeAccentColor(n: NexusEntity): string {
  if (n.anomaly > 0.7) return COLOR.lime;
  if (n.clusterColor === 'lime')   return COLOR.lime;
  if (n.clusterColor === 'amber')  return COLOR.amber;
  if (n.clusterColor === 'purple') return COLOR.purple;
  return COLOR.cyan;
}

// Sprint 5s+ loop iteration: was a local hexToRgba that duplicated the
// logic in src/styles/colors.ts:withAlpha. Removed in favor of the
// shared helper — every consumer in the canvas reads via withAlpha now.

interface SimNode {
  id: string;
  x: number; y: number;
  vx: number; vy: number;
  bx: number; by: number;
  isHub: boolean;
  mass: number;
  ref: NexusEntity;
}

interface SimState {
  nodes: SimNode[];
  initialized: boolean;
  idx: Record<string, number>;
}

export interface RadarCanvasProps {
  entities: NexusEntity[];
  transactions: NexusEdge[];
  clusters?: ClusterDef[] | undefined;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  glowIntensity?: number;
  dataDensity?: number;
  edgeMode?: EdgeMode;
  showFlow?: boolean;
  centralityMode?: CentralityMode;
  /** Diff-mode edge classification: `${from}->${to}` → 'new' | 'broken'.
   *  When present, the edge loop applies dashed strokes per kind. */
  diffEdgeMap?: ReadonlyMap<string, 'new' | 'broken'> | null;
  /** Per-entity diff deltas. Combined with `diffFilter`, drives the dim
   *  pass that ghosts non-matching nodes/edges to ~6% opacity. */
  diffMap?: ReadonlyMap<string, EntityDelta> | null;
  /** Active filter selected via DiffSummaryCard. Null = no dimming. */
  diffFilter?: DiffFilter;
  /** Sprint 5o-C-1: Isolate-entity focus mode. When set, renders the
   * focused entity + its 1-hop neighbors at full opacity and dims
   * everything else by DIM_FACTOR. Composes multiplicatively with the
   * diff-filter dim — both "filters" stack so an isolated entity that's
   * also outside the diff match shows at DIM_FACTOR² (~0.4%). Null
   * disables isolation entirely. */
  isolatedId?: string | null;
  /** Sprint 5o-C-2: Trace flow path mode. When set, performs a forward
   * BFS along directed edges (`from → to`) up to 4 hops from the focused
   * entity and renders only the resulting downstream cone at full
   * opacity; everything else dims by DIM_FACTOR. Independent of
   * `isolatedId` — both can be active simultaneously and compose
   * multiplicatively (DIM_FACTOR² ≈ 0.4%) for nodes/edges outside both
   * sets. Distinct semantics from isolation: ⌘I shows "who connects to
   * X" (1-hop undirected), ⌘T shows "where does flow from X reach"
   * (multi-hop directed). Null disables tracing entirely. */
  tracedId?: string | null;
  /** Sprint 5p-B: Entities that received a tick within the last ~3s.
   * Drives a thin lime pulse ring at radius ~1.7× the node body so the
   * operator can tell at a glance which nodes are currently being
   * driven by the active streamer (12 KIS-subscribed symbols on
   * BACKEND·LIVE, the full Momentum universe on MOMENTUM·LIVE). The
   * ring breathes via sin(t·π) ∈ [0.4, 1.0] so a static screenshot
   * still reads "this one's alive". Empty set = no pulse rendered. */
  liveEntityIds?: ReadonlySet<string>;
}

function RadarCanvasInner({
  entities, transactions, clusters,
  selectedId, onSelect,
  glowIntensity = 1, dataDensity = 1,
  edgeMode = 'curved', showFlow = true,
  centralityMode = 'eigen',
  diffEdgeMap = null,
  diffMap     = null,
  diffFilter  = null,
  isolatedId  = null,
  tracedId    = null,
  liveEntityIds,
}: RadarCanvasProps, ref: React.Ref<RadarCanvasHandle>) {
  const { t } = useLanguage();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dprRef = useRef<number>(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 1000, h: 600 });
  const [hoverId, setHoverId] = useState<string | null>(null);
  // Sprint 5s+ Obsidian-style direct manipulation: which node (if any)
  // the operator is currently dragging. Persists across renders; the
  // sim loop reads it every frame to suppress the spring-to-anchor
  // on that node so the cursor wins. On release we update the anchor
  // (bx/by) to the drop position — Obsidian's "stay where you put it"
  // behavior. Pointer event handlers below wrap vp.onPointerDown so a
  // node hit becomes a node-drag; an empty-canvas click still falls
  // through to viewport pan.
  const draggingRef = useRef<{ nodeId: string; pointerId: number } | null>(null);

  const tRef = useRef(0);
  const sweepRef = useRef(0);
  const simRef = useRef<SimState | null>(null);

  // Sprint 5o-A: pan + zoom viewport. Hook owns the math + handlers;
  // we wire its events into the <canvas> below and consult its ref
  // every frame inside the rAF draw loop.
  const vp = useViewport();

  // Sprint 5o-B: Analyze Cluster (⌘A) — Compute the viewport target
  // such that the cluster center lands at the canvas midpoint at
  // zoom 3x, then tween. Cluster centers `cx, cy` are 0..1 normalized
  // against the canvas pixel size, so multiply by current size.w/size.h.
  useImperativeHandle(ref, () => ({
    analyzeCluster: (clusterId: string) => {
      const c = (clusters ?? []).find(cc => cc.id === clusterId);
      if (!c) {
        // eslint-disable-next-line no-console
        console.info(`[NEXUS] analyzeCluster: unknown cluster '${clusterId}'`);
        return;
      }
      const SCALE = 3;
      const worldX = c.cx * size.w;
      const worldY = c.cy * size.h;
      vp.tweenTo({
        scale: SCALE,
        tx:    size.w / 2 - worldX * SCALE,
        ty:    size.h / 2 - worldY * SCALE,
      });
    },
    resetView: () => vp.reset(),
    resetLayout: () => {
      // Wipe localStorage + snap every live sim node back to its seeded
      // anchor (baseX / baseY from the dataset). Velocity zeroed so the
      // springs settle cleanly instead of overshooting from the drag
      // residual.
      clearNodePositions();
      const sim = simRef.current;
      if (!sim) return;
      for (const n of sim.nodes) {
        n.bx = n.ref.baseX;
        n.by = n.ref.baseY;
        n.vx = 0;
        n.vy = 0;
      }
    },
  }), [clusters, size.w, size.h, vp]);

  const curved = edgeMode === 'curved';

  // Resize
  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver(entries => {
      const e = entries[0];
      if (!e) return;
      const r = e.contentRect;
      setSize({ w: Math.max(100, r.width), h: Math.max(100, r.height) });
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  const visibleTx = useMemo(() => {
    if (dataDensity >= 1) return transactions;
    const sorted = [...transactions].sort((a, b) => b.usd - a.usd);
    const k = Math.max(1, Math.floor(sorted.length * dataDensity));
    return sorted.slice(0, k);
  }, [transactions, dataDensity]);

  /* ------------------------------------------------------------------
   *  Diff filter precomputation
   *  - matchedEntities: ids that should render at full opacity.
   *  - matchedEdgeKeys: edge ids ('${from}->${to}') that match.
   *  Non-matching items multiply their alpha by DIM_FACTOR so the
   *  topological context is preserved as a ghost layer.
   * ------------------------------------------------------------------ */
  const matchedEntities = useMemo<ReadonlySet<string> | null>(() => {
    if (!diffFilter) return null;
    const out = new Set<string>();
    if (diffFilter === 'entities-up' || diffFilter === 'entities-down') {
      const want = diffFilter === 'entities-up' ? 'up' : 'down';
      diffMap?.forEach((d, id) => { if (d.tone === want) out.add(id); });
    } else if (diffFilter === 'edges-new' || diffFilter === 'edges-broken') {
      // Highlight entities that are endpoints of any matching edge — keeps
      // the affected nodes legible even if their own delta was 'flat'.
      const want = diffFilter === 'edges-new' ? 'new' : 'broken';
      diffEdgeMap?.forEach((kind, key) => {
        if (kind !== want) return;
        const sep = key.indexOf('->');
        if (sep < 0) return;
        out.add(key.slice(0, sep));
        out.add(key.slice(sep + 2));
      });
    }
    return out;
  }, [diffFilter, diffMap, diffEdgeMap]);

  const matchedEdgeKeys = useMemo<ReadonlySet<string> | null>(() => {
    if (!diffFilter) return null;
    const out = new Set<string>();
    if (diffFilter === 'edges-new' || diffFilter === 'edges-broken') {
      const want = diffFilter === 'edges-new' ? 'new' : 'broken';
      diffEdgeMap?.forEach((kind, key) => { if (kind === want) out.add(key); });
    } else if (diffFilter === 'entities-up' || diffFilter === 'entities-down') {
      // Edges touching a matching entity stay lit so connections are visible.
      const want = diffFilter === 'entities-up' ? 'up' : 'down';
      const liveTones = new Set<string>();
      diffMap?.forEach((d, id) => { if (d.tone === want) liveTones.add(id); });
      for (const tx of visibleTx) {
        if (liveTones.has(tx.from) || liveTones.has(tx.to)) {
          out.add(`${tx.from}->${tx.to}`);
        }
      }
    }
    return out;
  }, [diffFilter, diffMap, diffEdgeMap, visibleTx]);

  /* Sprint 5o-C-1: Isolation neighborhood
   * - isolatedNodes: focus + 1-hop neighbors via the transactions graph.
   *   Walks visibleTx once to gather every counterparty whose edge touches
   *   the focused id. The focused node itself is always included.
   * - isolatedEdges: edges where AT LEAST one endpoint is the focus
   *   (so the connecting line stays lit even when the counterparty is
   *   itself dim — an isolated entity always shows its OWN edges in full).
   *   We do NOT light internal edges between two neighbors that don't
   *   touch the focus — keeps the visual hierarchy "focus → neighbors"
   *   instead of "everything in the neighborhood is equally important".
   * Returns null when isolatedId is null (no isolation active). */
  const isolatedNodes = useMemo<ReadonlySet<string> | null>(() => {
    if (!isolatedId) return null;
    const out = new Set<string>([isolatedId]);
    for (const tx of visibleTx) {
      if (tx.from === isolatedId) out.add(tx.to);
      else if (tx.to === isolatedId) out.add(tx.from);
    }
    return out;
  }, [isolatedId, visibleTx]);

  const isolatedEdgeKeys = useMemo<ReadonlySet<string> | null>(() => {
    if (!isolatedId) return null;
    const out = new Set<string>();
    for (const tx of visibleTx) {
      if (tx.from === isolatedId || tx.to === isolatedId) {
        out.add(`${tx.from}->${tx.to}`);
      }
    }
    return out;
  }, [isolatedId, visibleTx]);

  /* Sprint 5o-C-2: Trace forward-flow reachability from a focus entity.
   * Forward BFS following only directed edges `from → to`. MAX_HOPS=4
   * matches the existing cascading-wave depth so ⌘T's visual span
   * mirrors the ripple operators already see on selection. Both sets
   * computed in one pass — every traversed edge is added regardless of
   * whether `to` was already visited, so parallel paths through the
   * downstream cone stay visible (a→b and a→c→b both light up). Null
   * when tracedId is null. Cap of 4 hops bounds the work to O(MAX_HOPS
   * × edges); visibleTx tops out around 200 so this is trivial. */
  const traceData = useMemo<{
    nodes: ReadonlySet<string>;
    edgeKeys: ReadonlySet<string>;
  } | null>(() => {
    if (!tracedId) return null;
    const nodes = new Set<string>([tracedId]);
    const edgeKeys = new Set<string>();
    let frontier: string[] = [tracedId];
    for (let hop = 0; hop < MAX_RIPPLE_HOPS && frontier.length; hop++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const tx of visibleTx) {
          if (tx.from !== id) continue;
          edgeKeys.add(`${tx.from}->${tx.to}`);
          if (nodes.has(tx.to)) continue;
          nodes.add(tx.to);
          next.push(tx.to);
        }
      }
      frontier = next;
    }
    return { nodes, edgeKeys };
  }, [tracedId, visibleTx]);
  const tracedNodes    = traceData?.nodes ?? null;
  const tracedEdgeKeys = traceData?.edgeKeys ?? null;

  // Build sim state when entities change. Sprint 5s+: at construction
  // time, read any saved drag positions from localStorage and overlay
  // them onto the seeded baseX/baseY anchors. The operator's hand-
  // arranged layout therefore survives page reloads + dev-server HMR.
  // Unknown ids in the saved map are silently dropped (entity removed
  // from dataset), and entities without an override use their seeded
  // anchor as before.
  useEffect(() => {
    const saved = loadNodePositions();
    const sim: SimState = {
      nodes: entities.map(e => {
        const override = saved[e.id];
        return {
          id: e.id,
          x: 0, y: 0, vx: 0, vy: 0,
          bx: override?.bx ?? e.baseX,
          by: override?.by ?? e.baseY,
          isHub: e.isHub,
          mass: e.isHub ? 80 : 1,
          ref: e,
        };
      }),
      initialized: false,
      idx: {},
    };
    sim.nodes.forEach((n, i) => { sim.idx[n.id] = i; });
    simRef.current = sim;
  }, [entities]);

  // Cascading wave on selection (BFS up to 4 hops, attenuated per hop)
  useEffect(() => {
    const sim = simRef.current;
    if (!sim || !selectedId) return;
    const adj: Record<string, Set<string>> = {};
    visibleTx.forEach(tx => {
      (adj[tx.from] ||= new Set()).add(tx.to);
      (adj[tx.to]   ||= new Set()).add(tx.from);
    });
    const centerIdx = sim.idx[selectedId];
    if (centerIdx === undefined) return;
    const center = sim.nodes[centerIdx];
    if (!center) return;
    const visited = new Set<string>([selectedId]);
    let frontier: string[] = [selectedId];
    let hop = 0;
    const HOP_DELAY = 90;
    const stepWave = () => {
      hop++;
      if (hop > MAX_RIPPLE_HOPS) return;
      const next: string[] = [];
      const attenuation = Math.pow(0.55, hop - 1);
      const basePush = 90 * attenuation;
      for (const id of frontier) {
        const neighbors = adj[id];
        if (!neighbors) continue;
        for (const nb of neighbors) {
          if (visited.has(nb)) continue;
          visited.add(nb);
          next.push(nb);
          const oi = sim.idx[nb];
          if (oi == null) continue;
          const o = sim.nodes[oi];
          if (!o) continue;
          const dx = o.x - center.x, dy = o.y - center.y;
          const len = Math.hypot(dx, dy) || 1;
          o.vx += (dx / len) * basePush;
          o.vy += (dy / len) * basePush;
        }
      }
      frontier = next;
      if (frontier.length) setTimeout(stepWave, HOP_DELAY);
    };
    stepWave();
  }, [selectedId, visibleTx]);

  const radiusOf = useCallback((n: NexusEntity): number => {
    // Sprint 5s+ tier-aware sizing. The ontology has three semantic
    // strata; their visuals must read in the same order even when
    // centrality scores swing:
    //   Tier-1 HUB     (cluster center)            → 18–32 px
    //   Tier-2 SECTOR  (equity_sector + central_bank
    //                    + sovereign-bond aggregators) → 9–16 px
    //   Tier-3 LEAF    (individual ticker / fx / commodity / crypto)
    //                                                → 4–11 px
    // Tier ceilings are clamped so a high-eigen leaf never reads
    // bigger than a sector ETF — the visual hierarchy stays stable
    // through anomaly storms.
    if (n.isHub) return 18 + (n.eigen || 0) * 14;
    const isSector = n.type === 'equity_sector' || n.type === 'central_bank';
    const base    = isSector ? 9 : 4;
    const ceiling = isSector ? 16 : 11;
    let bonus = 0;
    if (centralityMode === 'eigen')       bonus = (n.eigen || 0) * (isSector ? 14 : 22);
    else if (centralityMode === 'degree') bonus = Math.min(10, (n.degree || 0) * 1.4);
    else if (centralityMode === 'volume') bonus = Math.min(12, Math.sqrt(n.txVol) * 0.30);
    return Math.min(ceiling, base + bonus);
  }, [centralityMode]);

  const hitTest = useCallback((screenX: number, screenY: number): string | null => {
    const sim = simRef.current;
    if (!sim) return null;
    // Click arrives in screen coords; sim positions are world coords
    // (the canvas was originally drawing them at scale=1, identity tx/ty,
    // so "world" is the same coordinate system as "screen at identity"
    // — but at non-identity viewport, we must invert).
    const w = screenToWorld(vp.viewportRef.current, screenX, screenY);
    // Hit radius in world units = visual hit radius / scale, so the
    // hit target stays the same physical pixel size at all zoom levels.
    const scale = vp.viewportRef.current.scale;
    const HIT_PAD_PX = 6;
    let best: SimNode | null = null;
    let bestD2 = Infinity;
    for (const n of sim.nodes) {
      const dx = w.x - n.x, dy = w.y - n.y;
      const d2 = dx * dx + dy * dy;
      const r = radiusOf(n.ref) + HIT_PAD_PX / scale;
      if (d2 < r * r && d2 < bestD2) { best = n; bestD2 = d2; }
    }
    return best?.id || null;
  }, [radiusOf, vp.viewportRef]);

  // ── Sprint 5s+ node-drag wrappers (Obsidian-style direct manipulation) ──
  // The flow is: pointerdown → hitTest. If we hit a non-hub node, start a
  // node-drag (pin its position to cursor, suppress sim spring). Otherwise
  // fall through to viewport pan. The wrappers also gate hover/click so
  // a drag-then-release doesn't fire selection.
  const didJustDragRef = useRef(false);

  const onPointerDownWrapped = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const id = hitTest(e.clientX - rect.left, e.clientY - rect.top);
    if (id) {
      const sim = simRef.current;
      const node = sim?.nodes.find(n => n.id === id);
      // Hubs are anchored structural — pinning them would warp the
      // entire cluster, so they stay non-draggable. Members are fair game.
      if (node && !node.isHub) {
        draggingRef.current = { nodeId: id, pointerId: e.pointerId };
        didJustDragRef.current = false;
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ok */ }
        return;
      }
    }
    vp.onPointerDown(e);
  }, [hitTest, vp]);

  const onPointerMoveWrapped = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = draggingRef.current;
    if (drag && e.pointerId === drag.pointerId) {
      const rect = canvasRef.current!.getBoundingClientRect();
      const w = screenToWorld(
        vp.viewportRef.current,
        e.clientX - rect.left,
        e.clientY - rect.top,
      );
      const sim = simRef.current;
      const node = sim?.nodes.find(n => n.id === drag.nodeId);
      if (node) {
        // Mark drag as actually moving so onClick suppresses selection.
        // Without this every tap on a node would fire a "drag" of zero
        // distance and we'd lose the click-to-select intent.
        if (Math.hypot(node.x - w.x, node.y - w.y) > 1) {
          didJustDragRef.current = true;
        }
        node.x = w.x;
        node.y = w.y;
        node.vx = 0;
        node.vy = 0;
      }
      return;
    }
    vp.onPointerMove(e);
  }, [vp]);

  const onPointerUpWrapped = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = draggingRef.current;
    if (drag && e.pointerId === drag.pointerId) {
      const sim = simRef.current;
      const node = sim?.nodes.find(n => n.id === drag.nodeId);
      if (node && didJustDragRef.current) {
        // Persist the drop position by updating the spring anchor
        // (bx/by are stored in unit-square coords; the sim reads them
        // every frame against the current canvas size). Now the node
        // stays where it was dropped instead of springing back. This
        // is the "Obsidian remembers where you put it" semantic.
        const W = size.w, H = size.h;
        if (W > 0 && H > 0) {
          node.bx = node.x / W;
          node.by = node.y / H;
          // Sprint 5s+ drop-position persistence: write to localStorage
          // immediately so a page reload restores the same layout. We
          // store bx/by (anchors) rather than x/y (live sim state) so
          // the saved value is stable across the force-sim's micro-jitter.
          saveNodePosition(drag.nodeId, node.bx, node.by);
        }
      }
      draggingRef.current = null;
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ok */ }
      return;
    }
    vp.onPointerUp(e);
  }, [vp, size.w, size.h]);

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    // Suppress hover updates mid-drag — the cursor isn't pointing at
    // entities, it's panning the surface or dragging a node.
    if (vp.isPanning || draggingRef.current !== null) {
      if (hoverId) setHoverId(null);
      return;
    }
    const rect = canvasRef.current!.getBoundingClientRect();
    const id = hitTest(e.clientX - rect.left, e.clientY - rect.top);
    if (id !== hoverId) setHoverId(id);
  };
  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    // Suppress click selection if we just finished dragging (either
    // viewport-pan or node-drag). didJustDragRef captures the node
    // case; vp.isPanning the pan case.
    if (vp.isPanning || didJustDragRef.current) {
      didJustDragRef.current = false;
      return;
    }
    const rect = canvasRef.current!.getBoundingClientRect();
    const id = hitTest(e.clientX - rect.left, e.clientY - rect.top);
    if (id) onSelect?.(id);
  };

  // Render + sim loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    let raf = 0;
    let last = performance.now();

    const draw = (now: number) => {
      const dt = Math.min(0.04, (now - last) / 1000);
      last = now;
      tRef.current += dt;
      sweepRef.current = (sweepRef.current + dt / 6.0) % 1; // 6s revolution
      const t = tRef.current;
      const sweepAngle = sweepRef.current * Math.PI * 2 - Math.PI / 2;

      const dpr = dprRef.current;
      const W = size.w, H = size.h;
      if (canvas.width !== W * dpr) {
        canvas.width = W * dpr;
        canvas.height = H * dpr;
        canvas.style.width = `${W}px`;
        canvas.style.height = `${H}px`;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      ctx.clearRect(0, 0, W, H);

      // Viewport transform — pan + zoom apply to all subsequent drawing.
      // Save/restore around the entire render so the next frame starts
      // from a clean DPR-only baseline (set once at canvas-resize time).
      const view = vp.viewportRef.current;
      ctx.save();
      ctx.translate(view.tx, view.ty);
      ctx.scale(view.scale, view.scale);

      const sim = simRef.current;
      if (!sim) { ctx.restore(); raf = requestAnimationFrame(draw); return; }

      if (!sim.initialized && W > 100) {
        sim.nodes.forEach(n => { n.x = n.bx * W; n.y = n.by * H; });
        sim.initialized = true;
      }

      // Ambient breathing
      sim.nodes.forEach((n, i) => {
        if (n.isHub) return;
        const phase = i * 0.7 + t * 0.4;
        n.vx += Math.cos(phase) * 0.6;
        n.vy += Math.sin(phase * 1.13) * 0.6;
      });

      // Spring to anchor. Sprint 5s+: skip the dragging node so its
      // position is exclusively controlled by the cursor while the
      // pointer is down. On release we update bx/by to the drop
      // position (see pointerup wrapper) so the spring resumes pulling
      // toward the new anchor — no warp-back to the seed coordinate.
      const dragNodeId = draggingRef.current?.nodeId;
      sim.nodes.forEach(n => {
        if (n.id === dragNodeId) return;
        const tx = n.bx * W, ty = n.by * H;
        const dx = tx - n.x, dy = ty - n.y;
        const k = n.isHub ? 18 : 6.5;
        n.vx += dx * k * dt;
        n.vy += dy * k * dt;
      });

      // Edge springs (inter-cluster only)
      for (let i = 0; i < visibleTx.length; i++) {
        const tx = visibleTx[i];
        if (!tx) continue;
        const ai = sim.idx[tx.from], bi = sim.idx[tx.to];
        if (ai == null || bi == null) continue;
        const a = sim.nodes[ai], b = sim.nodes[bi];
        if (!a || !b) continue;
        if (tx.kind === 'cluster') continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const rest = 180;
        const stretch = (len - rest) / len;
        const k = 0.6;
        const fx = dx * stretch * k * dt;
        const fy = dy * stretch * k * dt;
        if (!a.isHub) { a.vx += fx; a.vy += fy; }
        if (!b.isHub) { b.vx -= fx; b.vy -= fy; }
      }

      // Coulomb repulsion. Sprint 5s+: was intra-cluster only with
      // 70px radius (d²<4900), which let edge members of adjacent
      // clusters drift into each other when high-density clusters
      // (MOMENTUM=28, KRX=22) couldn't fit their members on a small
      // ring. Now ALL pairs repel within 110px (d²<12100), and the
      // force constant doubles (1600 vs 800) so the inter-cluster
      // separation actually wins against the anchor spring. Cost is
      // O(N²) per frame: 118 nodes → 6,903 pairs, ~140k mults/sec at
      // 60 FPS — well under the budget.
      const arr = sim.nodes;
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          const a = arr[i], b = arr[j];
          if (!a || !b) continue;
          const dx = b.x - a.x, dy = b.y - a.y;
          const d2 = dx * dx + dy * dy + 25;
          if (d2 > 12100) continue;
          const inv = 1 / Math.sqrt(d2);
          const force = 1600 / d2;
          const fx = dx * inv * force * dt;
          const fy = dy * inv * force * dt;
          if (!a.isHub) { a.vx -= fx; a.vy -= fy; }
          if (!b.isHub) { b.vx += fx; b.vy += fy; }
        }
      }

      // Integrate + damp
      const damp = 0.82;
      sim.nodes.forEach(n => {
        n.vx *= damp;
        n.vy *= damp;
        n.x += n.vx * dt;
        n.y += n.vy * dt;
      });

      const byId: Record<string, SimNode> = {};
      sim.nodes.forEach(n => { byId[n.id] = n; });

      /* Sprint 5o-C-1/2: Composed dim factors across diff filter,
       * isolation, trace, and (5s+) hover-focus. Each filter contributes
       * one factor in [0..1]; multiplied together so an entity/edge
       * outside two filters dims to DIM_FACTOR² ≈ 0.4%. Closures avoid
       * 4× repetition across halo / body / label / edge render passes.
       * Each filter is null-respecting — null sentinel means "filter
       * not active" and contributes a factor of 1.
       *
       * Hover-focus (Obsidian-style): when hoverId is set, compute the
       * 1-hop neighbor set on the fly. Hovered node + neighbors get
       * factor 1; everyone else gets HOVER_DIM (softer than DIM_FACTOR
       * so the canvas stays readable for navigation context). */
      const HOVER_DIM = 0.22;
      const hoverNeighbors: Set<string> | null = hoverId
        ? (() => {
            const s = new Set<string>([hoverId]);
            for (let i = 0; i < visibleTx.length; i++) {
              const tx = visibleTx[i];
              if (!tx) continue;
              if (tx.from === hoverId) s.add(tx.to);
              else if (tx.to === hoverId) s.add(tx.from);
            }
            return s;
          })()
        : null;
      const entityDim = (id: string): number => {
        const a = matchedEntities === null
          ? 1 : (matchedEntities.has(id) ? 1 : DIM_FACTOR);
        const b = isolatedNodes === null
          ? 1 : (isolatedNodes.has(id) ? 1 : DIM_FACTOR);
        const c = tracedNodes === null
          ? 1 : (tracedNodes.has(id) ? 1 : DIM_FACTOR);
        const d = hoverNeighbors === null
          ? 1 : (hoverNeighbors.has(id) ? 1 : HOVER_DIM);
        return a * b * c * d;
      };
      const edgeDim = (key: string, fromId: string, toId: string): number => {
        const a = matchedEdgeKeys === null
          ? 1 : (matchedEdgeKeys.has(key) ? 1 : DIM_FACTOR);
        // Edge dim semantics differ slightly: an edge stays lit if it
        // touches the focus (handled via isolatedEdgeKeys) — but if BOTH
        // endpoints are dim'd nodes, the edge between them must also dim
        // even if it's technically "between two neighbors of focus".
        const touchesFocus = isolatedEdgeKeys === null
          ? true : isolatedEdgeKeys.has(key);
        const bothInIso = isolatedNodes === null
          ? true : (isolatedNodes.has(fromId) && isolatedNodes.has(toId));
        const b = (isolatedEdgeKeys === null) || touchesFocus || bothInIso
          ? 1 : DIM_FACTOR;
        const c = tracedEdgeKeys === null
          ? 1 : (tracedEdgeKeys.has(key) ? 1 : DIM_FACTOR);
        // Hover-focus on edges: edge stays lit iff it TOUCHES the
        // hovered node (one of its endpoints IS hoverId). Edges
        // between two neighbors (but not touching the hover) dim.
        const d = hoverNeighbors === null
          ? 1
          : (fromId === hoverId || toId === hoverId ? 1 : HOVER_DIM);
        return a * b * c * d;
      };

      // Edges
      ctx.lineWidth = 1;
      for (let i = 0; i < visibleTx.length; i++) {
        const tx = visibleTx[i];
        if (!tx) continue;
        const a = byId[tx.from], b = byId[tx.to];
        if (!a || !b) continue;
        const isAnomaly = tx.anomaly > 0.7;
        const isHot =
          (selectedId && (tx.from === selectedId || tx.to === selectedId)) ||
          (hoverId    && (tx.from === hoverId    || tx.to === hoverId));
        // Diff overlay takes precedence over normal edge styling so the
        // operator can read topology change at a glance. Per-edge dash
        // patterns are local to this iteration; the reset after the loop
        // (CRITICAL) prevents leakage into particles / halos / labels.
        const diffKind = diffEdgeMap?.get(`${tx.from}->${tx.to}`);
        // Diff filter + isolation dim composed via edgeDim() helper.
        const edgeMatch = edgeDim(`${tx.from}->${tx.to}`, tx.from, tx.to);
        if (diffKind === 'new') {
          ctx.setLineDash([8, 6]);
          ctx.strokeStyle = COLOR.amber;
          ctx.globalAlpha = (isHot ? 1 : 0.85) * edgeMatch;
          ctx.lineWidth = 1.3;
        } else if (diffKind === 'broken') {
          ctx.setLineDash([2, 4]);
          ctx.strokeStyle = COLOR.cyan;
          ctx.globalAlpha = (isHot ? 0.55 : 0.30) * edgeMatch;
          ctx.lineWidth = 0.8;
        } else {
          ctx.setLineDash([]);
          // Sprint 5s+ sector emphasis. Three edge tiers map to three
          // visual weights:
          //   • 'sector' (stock → its sector hub) — the dominant ontology
          //       relationship. Painted in the sector hub's cluster color
          //       (purple for KRX, amber/cyan for COMM/EQ, etc.) at α=0.50
          //       and 1.0px so the sector grouping is the first thing the
          //       operator's eye picks up.
          //   • 'cluster' (intra-cluster, hub↔hub) — structural, α=0.28.
          //   • 'inter' (cross-correlation, e.g., NVDA↔KRX_SEMI without a
          //       sector relationship) — background context, α=0.18.
          // Anomaly (>0.7) still wins on color (lime), so the operator's
          // eye finds risk before structure.
          let baseColor: string;
          if (isAnomaly) {
            baseColor = COLOR.lime;
          } else if (tx.kind === 'sector') {
            const target = byId[tx.to];
            baseColor = target?.ref.clusterColor === 'purple' ? COLOR.purple
                      : target?.ref.clusterColor === 'amber'  ? COLOR.amber
                      : target?.ref.clusterColor === 'lime'   ? COLOR.lime
                      : COLOR.cyan;
          } else {
            baseColor = COLOR.cyan;
          }
          // Sprint 5s+ idle declutter: 'inter' (cross-correlation) edges
          // drop to α=0.10 by default — they're contextual, not primary.
          // Hovering an endpoint pops them back up via the hover-focus
          // factor (edgeDim multiplier = 1 on touch). This is the
          // Obsidian "rest state stays clean, signal-on-demand" feel.
          const op = isHot       ? 0.85
                   : isAnomaly   ? 0.45
                   : tx.kind === 'sector'  ? 0.50
                   : tx.kind === 'cluster' ? 0.28
                   :                          0.10;
          ctx.strokeStyle = baseColor;
          ctx.globalAlpha = op * edgeMatch;
          ctx.lineWidth = isHot     ? 1.4
                        : isAnomaly ? 1.0
                        : tx.kind === 'sector' ? 1.0
                        :                        0.7;
        }
        ctx.beginPath();
        if (curved) {
          const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
          const dx = b.x - a.x, dy = b.y - a.y;
          const len = Math.hypot(dx, dy) || 1;
          const ox = -dy / len * 28, oy = dx / len * 28;
          ctx.moveTo(a.x, a.y);
          ctx.quadraticCurveTo(mx + ox, my + oy, b.x, b.y);
        } else {
          ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        }
        ctx.stroke();
      }
      // CRITICAL — reset dash so subsequent particles, halos, node strokes,
      // and labels don't pick up dashes from the last drawn edge.
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      // Particles. Sprint 5s+ "의미 없이 흐르지 않게": gate emission by
      // recent live activity. The previous behavior fired particles on
      // EVERY visible edge at a constant rate set by `tx.usd` (a static
      // dataset field) — so the canvas looked like a permanent traffic
      // jam regardless of whether any symbols were actually publishing
      // ticks. Now an edge animates only if EITHER endpoint is in
      // `liveEntityIds` (per-entity tick clock, ≤2s freshness window
      // sourced by useMarketData). Idle edges stay quiet, currently-
      // ticking edges glow. Hubs, synthetic AML watch targets, and
      // anything else without a backend tick stream show no flow
      // unless one of their endpoints is live.
      if (showFlow) {
        ctx.globalCompositeOperation = 'lighter';
        const hasLive = liveEntityIds && liveEntityIds.size > 0;
        for (let i = 0; i < visibleTx.length; i++) {
          const tx = visibleTx[i];
          if (!tx) continue;
          const a = byId[tx.from], b = byId[tx.to];
          if (!a || !b) continue;
          if (tx.kind === 'cluster' && i % 2 === 0) continue;
          // Skip particles entirely on heavily-dimmed edges — flow visuals
          // would be noise in the ghost layer.
          if (matchedEdgeKeys !== null && !matchedEdgeKeys.has(`${tx.from}->${tx.to}`)) continue;
          // Sprint 5s+ liveness gate. When at least one endpoint is in
          // liveEntityIds, this edge represents a real data path and
          // earns its flow. When neither endpoint has ticked recently,
          // suppress emission unless the operator is hovering/selecting
          // (hot edges always animate so the operator can trace the
          // topology without waiting for a tick).
          const isHot =
            (selectedId && (tx.from === selectedId || tx.to === selectedId)) ||
            (hoverId    && (tx.from === hoverId    || tx.to === hoverId));
          if (hasLive && !isHot) {
            const fromLive = liveEntityIds!.has(tx.from);
            const toLive   = liveEntityIds!.has(tx.to);
            if (!fromLive && !toLive) continue;
          }
          const isAnomaly = tx.anomaly > 0.7;
          const count = isHot ? 3 : (isAnomaly ? 2 : 1);
          const speed = 0.18 + Math.log10(tx.usd) * 0.04;
          for (let p = 0; p < count; p++) {
            const tt = ((t * speed + p / count + i * 0.013) % 1);
            let cx: number, cy: number;
            if (curved) {
              const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
              const dx = b.x - a.x, dy = b.y - a.y;
              const len = Math.hypot(dx, dy) || 1;
              const ox = -dy / len * 28, oy = dx / len * 28;
              const cx_ctrl = mx + ox, cy_ctrl = my + oy;
              const u = 1 - tt;
              cx = u * u * a.x + 2 * u * tt * cx_ctrl + tt * tt * b.x;
              cy = u * u * a.y + 2 * u * tt * cy_ctrl + tt * tt * b.y;
            } else {
              cx = a.x + (b.x - a.x) * tt;
              cy = a.y + (b.y - a.y) * tt;
            }
            const color = isAnomaly ? COLOR.lime : COLOR.cyan;
            const r = isAnomaly ? 2.2 : 1.5;
            ctx.fillStyle = color;
            ctx.shadowColor = color;
            ctx.shadowBlur = 6 * glowIntensity;
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        ctx.shadowBlur = 0;
        ctx.globalCompositeOperation = 'source-over';
      }

      // Polar radar sweep
      const ccx = W / 2, ccy = H / 2;
      const sweepR = Math.hypot(W, H) / 2 + 40;
      const wedgeWidth = Math.PI / 5;
      const steps = 28;
      for (let s = 0; s < steps; s++) {
        const t0 = s / steps;
        const t1 = (s + 1) / steps;
        const a0 = sweepAngle - wedgeWidth * (1 - t0);
        const a1 = sweepAngle - wedgeWidth * (1 - t1);
        const alpha = t0 * t0 * 0.10;
        ctx.fillStyle = withAlpha(COLOR.cyan, alpha);
        ctx.beginPath();
        ctx.moveTo(ccx, ccy);
        ctx.arc(ccx, ccy, sweepR, a0, a1);
        ctx.closePath();
        ctx.fill();
      }
      ctx.strokeStyle = withAlpha(COLOR.cyan, 0.55);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(ccx, ccy);
      ctx.lineTo(ccx + Math.cos(sweepAngle) * sweepR, ccy + Math.sin(sweepAngle) * sweepR);
      ctx.stroke();
      ctx.fillStyle = withAlpha(COLOR.cyan, 0.6);
      ctx.beginPath();
      ctx.arc(ccx, ccy, 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = withAlpha(COLOR.cyan, 0.06);
      ctx.lineWidth = 1;
      for (const rr of [W * 0.18, W * 0.32, W * 0.46]) {
        ctx.beginPath();
        ctx.arc(ccx, ccy, rr, 0, Math.PI * 2);
        ctx.stroke();
      }

      const angDist = (a: number, b: number): number => {
        let d = Math.abs(a - b) % (Math.PI * 2);
        if (d > Math.PI) d = Math.PI * 2 - d;
        return d;
      };

      // Halos
      ctx.globalCompositeOperation = 'lighter';
      for (const n of sim.nodes) {
        const r = radiusOf(n.ref);
        const isSel = n.id === selectedId;
        const isHover = n.id === hoverId;
        const accent = nodeAccentColor(n.ref);
        const isAnomaly = n.ref.anomaly > 0.7;
        const nodeAng = Math.atan2(n.y - ccy, n.x - ccx);
        const ad = angDist(nodeAng, sweepAngle);
        const scanBoost = Math.max(0, 1 - ad / (Math.PI / 5));

        const entityMatch = entityDim(n.id);
        const haloR = r * (3 + glowIntensity * 0.6 + scanBoost * 1.2);
        const halo = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, haloR);
        const haloAlpha = ((isSel || isHover ? 0.55 : 0.32) + scanBoost * 0.30 + (isAnomaly ? 0.1 : 0)) * entityMatch;
        halo.addColorStop(0, withAlpha(accent, haloAlpha));
        halo.addColorStop(1, withAlpha(accent, 0));
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(n.x, n.y, haloR, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';

      // Node bodies
      for (const n of sim.nodes) {
        const r = radiusOf(n.ref);
        const isSel = n.id === selectedId;
        const isHover = n.id === hoverId;
        const accent = nodeAccentColor(n.ref);
        const dim = entityDim(n.id);

        ctx.globalAlpha = dim;
        ctx.fillStyle = COLOR.void;
        ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2); ctx.fill();

        ctx.strokeStyle = accent;
        ctx.lineWidth = isSel ? 1.6 : (isHover ? 1.3 : (n.isHub ? 1.4 : 1.0));
        ctx.shadowColor = accent;
        ctx.shadowBlur = (isSel ? 12 : (isHover ? 10 : 6)) * glowIntensity;
        ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2); ctx.stroke();

        if (n.isHub) {
          ctx.shadowBlur = 0;
          ctx.lineWidth = 0.8;
          ctx.globalAlpha = 0.5 * dim;
          ctx.beginPath(); ctx.arc(n.x, n.y, r * 0.55, 0, Math.PI * 2); ctx.stroke();
          ctx.globalAlpha = dim;
          ctx.fillStyle = accent;
          ctx.beginPath(); ctx.arc(n.x, n.y, 2.4, 0, Math.PI * 2); ctx.fill();
        }
        if (n.ref.sanctioned) {
          ctx.shadowBlur = 6;
          ctx.shadowColor = COLOR.amber;
          ctx.fillStyle = COLOR.amber;
          ctx.beginPath();
          ctx.arc(n.x + r * 0.85, n.y - r * 0.85, 3.2, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
      }

      // Sprint 5p-B: Live-tick pulse rings. Drawn AFTER node bodies so
      // the ring sits on top of the body stroke but BEFORE labels (we
      // don't want labels behind a glowing ring). The breath uses the
      // ambient `t` clock so all live nodes pulse in sync — operators
      // tend to register "alive" faster from synchronized motion than
      // from random per-node phases. Composes with entityDim so a
      // dim'd-but-live node still shows a faint pulse hint rather than
      // disappearing entirely.
      if (liveEntityIds && liveEntityIds.size > 0) {
        const breath = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(t * Math.PI * 1.4));
        ctx.globalCompositeOperation = 'lighter';
        for (const n of sim.nodes) {
          if (!liveEntityIds.has(n.id)) continue;
          const r = radiusOf(n.ref);
          const dim = entityDim(n.id);
          const ringR = r * 1.75 + 2;
          ctx.globalAlpha = 0.55 * breath * dim;
          ctx.strokeStyle = COLOR.lime;
          ctx.lineWidth = 1.2;
          ctx.shadowColor = COLOR.lime;
          ctx.shadowBlur = 6 * glowIntensity;
          ctx.beginPath();
          ctx.arc(n.x, n.y, ringR, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }

      // Labels — bbox-based collision avoidance (Sprint 5q+).
      //
      // Candidate set is bounded: only hubs (10) + at most 2 of
      // {selectedId, hoverId}, so worst-case ~12 labels. O(N²) overlap
      // check is ≤ 144 cheap ops per frame at 60Hz = trivial vs the
      // rest of the draw pipeline.
      //
      // Each candidate is offered four anchor positions in priority
      // order: BELOW the node (default — matches the prior layout),
      // ABOVE, RIGHT, LEFT. We accept the first slot whose bbox
      // doesn't overlap a previously-placed bbox. If all four fail,
      // the label is dropped — operator can still hover the node for
      // the inspector readout, so a missing label is a smaller UX hit
      // than two labels stacked on top of each other.
      //
      // Selected / hover labels are drawn FIRST (highest priority) so
      // a hub label can never displace the one the operator is
      // actively pointing at.
      // Sprint 5s+ loop: canvas font shorthand composes the shared
      // FONT_MONO stack instead of re-hardcoding the family name.
      ctx.font = `500 9px ${FONT_MONO}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';

      type LabelCandidate = {
        node:    SimNode;
        text:    string;
        radius:  number;
        dim:     number;
        bright:  boolean;    // selected/hover → bone, else ash
        prio:    number;     // lower draws first; wins exclusions
      };
      const candidates: LabelCandidate[] = [];
      for (const n of sim.nodes) {
        const isSel = n.id === selectedId;
        const isHov = n.id === hoverId;
        if (!(n.isHub || isSel || isHov)) continue;
        candidates.push({
          node:   n,
          text:   n.isHub ? n.ref.label.toUpperCase() : n.id,
          radius: radiusOf(n.ref),
          dim:    entityDim(n.id),
          bright: isSel || isHov,
          // Priority: selected (0) < hover (1) < hub-with-anomaly (2)
          // < normal hub (3). Lower number = drawn first.
          prio:   isSel ? 0 : isHov ? 1 : (n.ref.anomaly > 0.7 ? 2 : 3),
        });
      }
      candidates.sort((a, b) => a.prio - b.prio);

      // ~9px font → height ≈ 11px with descent; 1.5px pad on each axis
      // keeps adjacent labels from touching while staying tight enough
      // for dense clusters to keep multiple labels visible.
      const LABEL_H = 11;
      const PAD_X   = 2;
      const PAD_Y   = 2;
      type Bbox = readonly [number, number, number, number];
      const placed: Bbox[] = [];
      const boxesOverlap = (a: Bbox, b: Bbox): boolean =>
        !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);

      for (const c of candidates) {
        const { node: n, text, radius: r, dim, bright } = c;
        const w = ctx.measureText(text).width;
        // Four anchor offsets relative to node center: BELOW, ABOVE,
        // RIGHT, LEFT. dx/dy are the label's TOP-CENTER position
        // (textBaseline = 'top', textAlign = 'center').
        const offsets: ReadonlyArray<readonly [number, number]> = [
          [0,         r + 6],                        // below
          [0,         -r - 6 - LABEL_H],             // above
          [r + 6 + w / 2,  -LABEL_H / 2],            // right
          [-r - 6 - w / 2, -LABEL_H / 2],            // left
        ];
        let drawn = false;
        for (const [dx, dy] of offsets) {
          const cx = n.x + dx;
          const cy = n.y + dy;
          const box: Bbox = [
            cx - w / 2 - PAD_X,
            cy - PAD_Y,
            cx + w / 2 + PAD_X,
            cy + LABEL_H + PAD_Y,
          ];
          if (placed.some(b => boxesOverlap(box, b))) continue;
          placed.push(box);
          ctx.globalAlpha = dim;
          ctx.fillStyle = bright ? COLOR.bone : COLOR.ash;
          ctx.fillText(text, cx, cy);
          drawn = true;
          break;
        }
        // No fit → drop label this frame; the cluster legend in the
        // bottom HUD still names this node, and hover reveals its id.
        void drawn;
      }
      ctx.globalAlpha = 1;

      ctx.restore();   // pop viewport transform → DPR-only baseline

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [entities, visibleTx, size, selectedId, hoverId, glowIntensity, curved, showFlow, radiusOf, matchedEntities, matchedEdgeKeys, isolatedNodes, isolatedEdgeKeys, tracedNodes, tracedEdgeKeys, liveEntityIds, diffEdgeMap, vp.viewportRef]);

  // Sprint 5s+ "29 비정상 엣지는 api 결과가 맞니?" — the operator caught
  // that the anomaly-edge counter was reading STATIC seed values from
  // the dataset's TX.anomaly field, not live data. Fix: derive each
  // edge's effective anomaly from its endpoint entities' live anomaly
  // (the BackendStreamer mutates entity.anomaly on every tick). Edge
  // anomaly = max(from, to) so an edge inherits the more dangerous of
  // its two endpoints. The static TX.anomaly is kept as a floor so
  // ontologically-flagged relationships (e.g., NORDSEE→OBSIDIAN AML
  // ties seeded at 0.9) don't drop below their seed when both
  // endpoints are quiet. Counter recomputes whenever `entities` change
  // — useMarketData mutates entity.anomaly via Object.assign on each
  // tick, but the array reference flips on every diff/snapshot so
  // useMemo dep on `entities` is correct.
  const anomalyEdgeCount = useMemo(() => {
    const byId: Record<string, NexusEntity> = {};
    for (const e of entities) byId[e.id] = e;
    let n = 0;
    for (const t of visibleTx) {
      const a = byId[t.from]?.anomaly ?? 0;
      const b = byId[t.to]?.anomaly   ?? 0;
      const live = Math.max(a, b, t.anomaly);
      if (live > 0.7) n++;
    }
    return n;
  }, [entities, visibleTx]);

  return (
    <div ref={wrapRef} className="nx-canvas">
      <div className="nx-canvas__noise"></div>
      <div className="nx-canvas__vignette"></div>
      <div className="nx-canvas__grid"></div>

      <canvas
        ref={canvasRef}
        className="nx-canvas__svg"
        onMouseMove={onMouseMove}
        onMouseLeave={() => setHoverId(null)}
        onClick={onClick}
        onWheel={vp.onWheel}
        onPointerDown={onPointerDownWrapped}
        onPointerMove={onPointerMoveWrapped}
        onPointerUp={onPointerUpWrapped}
        onPointerCancel={onPointerUpWrapped}
        onDoubleClick={vp.onDoubleClick}
        style={{
          // Drag-pan grabbing wins over hover-pointer; grab hint when
          // idle is too aggressive (most clicks are entity selects),
          // so default to crosshair when not actively panning.
          cursor: draggingRef.current ? 'grabbing'
                : vp.isPanning        ? 'grabbing'
                : hoverId             ? 'grab'
                :                       'crosshair',
        }}
      />

      <div className="nx-canvas__hud-tl">
        <div className="nx-label">{t('hud.canvas.title')}</div>
        <div className="nx-mono-dim" style={{ fontSize: 10, marginTop: 4 }}>
          {t('hud.canvas.summary', {
            ents: entities.length,
            edges: visibleTx.length,
            clusters: clusters?.length || 0,
          })}
        </div>
      </div>
      <div className="nx-canvas__hud-tr">
        <div className="nx-label" style={{ textAlign: 'right' }}>{t('hud.canvas.radar')}</div>
        <div className="nx-mono-dim" style={{ fontSize: 10, marginTop: 4, textAlign: 'right', color: COLOR.lime }}>
          {t('hud.canvas.anomalyEdges', { n: anomalyEdgeCount })}
        </div>
        {/* Zoom indicator (Sprint 5o-A) — only renders when off-identity */}
        {(vp.viewport.scale !== 1 || vp.viewport.tx !== 0 || vp.viewport.ty !== 0) && (
          <div
            className="nx-mono-dim"
            style={{
              fontSize: 10, marginTop: 4, textAlign: 'right',
              color: 'var(--cyan, #00BFFF)',
            }}
            title="Double-click empty area to reset"
          >
            × {vp.viewport.scale.toFixed(2)}
          </div>
        )}
      </div>
      <div className="nx-canvas__hud-bl">
        <ClusterLegend clusters={clusters} />
      </div>
      <div className="nx-canvas__hud-br">
        <div className="nx-mono-dim" style={{ fontSize: 10, textAlign: 'right' }}>
          CENTRALITY · {centralityMode.toUpperCase()}
        </div>
        <div className="nx-mono-dim" style={{ fontSize: 9, marginTop: 2, textAlign: 'right', color: 'var(--fg-low)' }}>
          {curved ? 'CURVED' : 'STRAIGHT'} · {showFlow ? 'FLOW ON' : 'FLOW OFF'} · DENSITY {Math.round(dataDensity * 100)}%
        </div>
      </div>
    </div>
  );
}

// forwardRef wrapper — exposes RadarCanvasHandle to App.tsx so command-
// center actions (Analyze cluster, Reset view) can drive the canvas
// imperatively without lifting the entire viewport state up.
export const RadarCanvas = forwardRef<RadarCanvasHandle, RadarCanvasProps>(RadarCanvasInner);
RadarCanvas.displayName = 'RadarCanvas';


function ClusterLegend({ clusters }: { clusters?: ClusterDef[] | undefined }) {
  if (!clusters) return null;
  const colorOf = (c: string): string =>
    c === 'lime' ? COLOR.lime : c === 'amber' ? COLOR.amber : c === 'purple' ? COLOR.purple : COLOR.cyan;
  return (
    <div className="nx-legend" style={{ maxWidth: 580 }}>
      {clusters.map(c => (
        <div key={c.id} className="nx-legend__item">
          <span className="nx-legend__dot" style={{ background: colorOf(c.color), boxShadow: `0 0 6px ${colorOf(c.color)}` }}></span>
          <span>{c.label}</span>
        </div>
      ))}
    </div>
  );
}
