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
}

const COLOR = {
  cyan:   '#00BFFF',
  lime:   '#DEFF9A',
  amber:  '#FFB200',
  purple: '#A855F7',
  bone:   '#E8ECF5',
  ash:    '#8A93A8',
  low:    '#4A5066',
  void:   '#050510',
} as const;

/** Alpha multiplier for items that don't match the active diff filter.
 *  Low enough to ghost out, high enough to preserve topological context. */
const DIM_FACTOR = 0.06;

function nodeAccentColor(n: NexusEntity): string {
  if (n.anomaly > 0.7) return COLOR.lime;
  if (n.clusterColor === 'lime')   return COLOR.lime;
  if (n.clusterColor === 'amber')  return COLOR.amber;
  if (n.clusterColor === 'purple') return COLOR.purple;
  return COLOR.cyan;
}

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

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
}: RadarCanvasProps, ref: React.Ref<RadarCanvasHandle>) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dprRef = useRef<number>(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 1000, h: 600 });
  const [hoverId, setHoverId] = useState<string | null>(null);

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

  // Build sim state when entities change
  useEffect(() => {
    const sim: SimState = {
      nodes: entities.map(e => ({
        id: e.id,
        x: 0, y: 0, vx: 0, vy: 0,
        bx: e.baseX, by: e.baseY,
        isHub: e.isHub,
        mass: e.isHub ? 80 : 1,
        ref: e,
      })),
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
    const MAX_HOPS = 4;
    const stepWave = () => {
      hop++;
      if (hop > MAX_HOPS) return;
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
    if (n.isHub) return 18 + (n.eigen || 0) * 14;
    if (centralityMode === 'eigen')  return 4 + (n.eigen || 0) * 36;
    if (centralityMode === 'degree') return 4 + Math.min(20, (n.degree || 0) * 1.6);
    if (centralityMode === 'volume') return 4 + Math.min(22, Math.sqrt(n.txVol) * 0.34);
    return 6;
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

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    // Suppress hover updates mid-drag — the cursor isn't pointing at
    // entities, it's panning the surface.
    if (vp.isPanning) {
      if (hoverId) setHoverId(null);
      return;
    }
    const rect = canvasRef.current!.getBoundingClientRect();
    const id = hitTest(e.clientX - rect.left, e.clientY - rect.top);
    if (id !== hoverId) setHoverId(id);
  };
  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    // A drag-then-release fires both pointerup and click. We want
    // selection only on a true click (no panning happened); the panning
    // flag flips false in pointerup, so by the time click fires the
    // ref is already cleared — but we read viewportRef.current.tx/ty
    // delta via React state instead to be safe.
    if (vp.isPanning) return;
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

      // Spring to anchor
      sim.nodes.forEach(n => {
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

      // Coulomb repulsion (intra-cluster, O(N) binned)
      const byCluster: Record<string, SimNode[]> = {};
      sim.nodes.forEach(n => {
        const c = n.ref.cluster;
        (byCluster[c] ||= []).push(n);
      });
      for (const c in byCluster) {
        const arr = byCluster[c];
        if (!arr) continue;
        for (let i = 0; i < arr.length; i++) {
          for (let j = i + 1; j < arr.length; j++) {
            const a = arr[i], b = arr[j];
            if (!a || !b) continue;
            const dx = b.x - a.x, dy = b.y - a.y;
            const d2 = dx * dx + dy * dy + 25;
            if (d2 > 4900) continue;
            const inv = 1 / Math.sqrt(d2);
            const force = 800 / d2;
            const fx = dx * inv * force * dt;
            const fy = dy * inv * force * dt;
            if (!a.isHub) { a.vx -= fx; a.vy -= fy; }
            if (!b.isHub) { b.vx += fx; b.vy += fy; }
          }
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
        // Diff filter dim — non-matching edges fade to ghost.
        const edgeMatch = matchedEdgeKeys === null
          ? 1
          : (matchedEdgeKeys.has(`${tx.from}->${tx.to}`) ? 1 : DIM_FACTOR);
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
          const baseColor = isAnomaly ? COLOR.lime : COLOR.cyan;
          const op = isHot ? 0.85 : (isAnomaly ? 0.45 : (tx.kind === 'cluster' ? 0.28 : 0.18));
          ctx.strokeStyle = baseColor;
          ctx.globalAlpha = op * edgeMatch;
          ctx.lineWidth = isHot ? 1.4 : (isAnomaly ? 1 : 0.7);
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

      // Particles
      if (showFlow) {
        ctx.globalCompositeOperation = 'lighter';
        for (let i = 0; i < visibleTx.length; i++) {
          const tx = visibleTx[i];
          if (!tx) continue;
          const a = byId[tx.from], b = byId[tx.to];
          if (!a || !b) continue;
          if (tx.kind === 'cluster' && i % 2 === 0) continue;
          // Skip particles entirely on heavily-dimmed edges — flow visuals
          // would be noise in the ghost layer.
          if (matchedEdgeKeys !== null && !matchedEdgeKeys.has(`${tx.from}->${tx.to}`)) continue;
          const isAnomaly = tx.anomaly > 0.7;
          const isHot =
            (selectedId && (tx.from === selectedId || tx.to === selectedId)) ||
            (hoverId    && (tx.from === hoverId    || tx.to === hoverId));
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
        ctx.fillStyle = `rgba(0,191,255,${alpha})`;
        ctx.beginPath();
        ctx.moveTo(ccx, ccy);
        ctx.arc(ccx, ccy, sweepR, a0, a1);
        ctx.closePath();
        ctx.fill();
      }
      ctx.strokeStyle = 'rgba(0,191,255,0.55)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(ccx, ccy);
      ctx.lineTo(ccx + Math.cos(sweepAngle) * sweepR, ccy + Math.sin(sweepAngle) * sweepR);
      ctx.stroke();
      ctx.fillStyle = 'rgba(0,191,255,0.6)';
      ctx.beginPath();
      ctx.arc(ccx, ccy, 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,191,255,0.06)';
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

        const entityMatch = matchedEntities === null
          ? 1
          : (matchedEntities.has(n.id) ? 1 : DIM_FACTOR);
        const haloR = r * (3 + glowIntensity * 0.6 + scanBoost * 1.2);
        const halo = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, haloR);
        const haloAlpha = ((isSel || isHover ? 0.55 : 0.32) + scanBoost * 0.30 + (isAnomaly ? 0.1 : 0)) * entityMatch;
        halo.addColorStop(0, hexToRgba(accent, haloAlpha));
        halo.addColorStop(1, hexToRgba(accent, 0));
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
        const dim = matchedEntities === null
          ? 1
          : (matchedEntities.has(n.id) ? 1 : DIM_FACTOR);

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

      // Labels
      ctx.font = '500 9px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (const n of sim.nodes) {
        const showLabel = n.isHub || n.id === selectedId || n.id === hoverId;
        if (!showLabel) continue;
        const r = radiusOf(n.ref);
        const dim = matchedEntities === null
          ? 1
          : (matchedEntities.has(n.id) ? 1 : DIM_FACTOR);
        ctx.globalAlpha = dim;
        ctx.fillStyle = (n.id === selectedId || n.id === hoverId) ? COLOR.bone : COLOR.ash;
        const label = n.isHub ? n.ref.label.toUpperCase() : n.id;
        ctx.fillText(label, n.x, n.y + r + 6);
      }
      ctx.globalAlpha = 1;

      ctx.restore();   // pop viewport transform → DPR-only baseline

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [entities, visibleTx, size, selectedId, hoverId, glowIntensity, curved, showFlow, radiusOf, matchedEntities, matchedEdgeKeys, diffEdgeMap, vp.viewportRef]);

  const anomalyEdgeCount = useMemo(
    () => visibleTx.filter(t => t.anomaly > 0.7).length, [visibleTx],
  );

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
        onPointerDown={vp.onPointerDown}
        onPointerMove={vp.onPointerMove}
        onPointerUp={vp.onPointerUp}
        onPointerCancel={vp.onPointerUp}
        onDoubleClick={vp.onDoubleClick}
        style={{
          // Drag-pan grabbing wins over hover-pointer; grab hint when
          // idle is too aggressive (most clicks are entity selects),
          // so default to crosshair when not actively panning.
          cursor: vp.isPanning ? 'grabbing'
                : hoverId      ? 'pointer'
                :                'crosshair',
        }}
      />

      <div className="nx-canvas__hud-tl">
        <div className="nx-label">ONTOLOGY · GLOBAL MACRO</div>
        <div className="nx-mono-dim" style={{ fontSize: 10, marginTop: 4 }}>
          {entities.length} ENTITIES · {visibleTx.length} EDGES · {clusters?.length || 0} CLUSTERS · LIVE
        </div>
      </div>
      <div className="nx-canvas__hud-tr">
        <div className="nx-label" style={{ textAlign: 'right' }}>RADAR SCAN ACTIVE</div>
        <div className="nx-mono-dim" style={{ fontSize: 10, marginTop: 4, textAlign: 'right', color: '#DEFF9A' }}>
          ◆ {anomalyEdgeCount} ANOMALY EDGES
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
