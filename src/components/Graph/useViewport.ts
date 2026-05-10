// useViewport — Sprint 5o-A: pan + zoom for RadarCanvas.
//
// Three responsibilities: hold the viewport state (scale + translate),
// expose the math (zoom-at-cursor, pan delta, reset, clamp), and provide
// the React event handlers wired into the canvas. The draw loop reads
// the *ref* (`viewportRef`) every frame for zero re-renders during drag,
// while a *state version* counter triggers re-render of UI overlays
// (zoom indicator) whenever the viewport actually changes.
//
// Coord convention:
//     screenX = worldX * scale + tx
//     worldX  = (screenX - tx) / scale
// Hit-tests must invert through `screenToWorld` before comparing with
// the simulation's positions (which are kept in the same world units
// the canvas was originally drawing in at scale=1).

import { useCallback, useEffect, useRef, useState } from 'react';

export interface Viewport {
  scale: number;
  tx:    number;
  ty:    number;
}

const IDENTITY: Viewport = { scale: 1, tx: 0, ty: 0 };

/** Min/max zoom — 0.5x is "fit out for context", 8x lets a single
 * KRX ticker fill the viewport for label legibility. */
const MIN_SCALE = 0.5;
const MAX_SCALE = 8.0;

/** Wheel notch sensitivity. 10% per notch is the Figma/Linear
 * default — fast enough to feel responsive, slow enough that one
 * accidental swipe doesn't fling you across 3 octaves. */
const WHEEL_FACTOR_BASE = 1.1;

/** Reset / hub-zoom tween duration. 250ms sits in the "snappy but
 * not jarring" window per UX research on graph navigation. */
const TWEEN_DURATION_MS = 250;


// ── Pure math (also reused by tests once vitest lands) ──────────────


export function clampScale(s: number): number {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));
}

/** Compute new viewport so the world point under (mouseX, mouseY)
 * stays under the same screen pixel after the scale change.
 *
 *     world point at cursor = (mouseX - tx) / scale         (invariant)
 *     after zoom:  scale_new = clamp(scale * factor)
 *     tx_new = mouseX - worldAtCursor * scale_new
 *            = mouseX - (mouseX - tx) * (scale_new / scale)
 *
 * Same shape for ty. If clamp pinned the scale (already at MIN/MAX),
 * the math degenerates to "no movement" — desired behavior. */
export function zoomAtPoint(
  vp:     Viewport,
  factor: number,
  mouseX: number,
  mouseY: number,
): Viewport {
  const scaleNew = clampScale(vp.scale * factor);
  const ratio    = scaleNew / vp.scale;
  return {
    scale: scaleNew,
    tx:    mouseX - (mouseX - vp.tx) * ratio,
    ty:    mouseY - (mouseY - vp.ty) * ratio,
  };
}

export function pan(vp: Viewport, dx: number, dy: number): Viewport {
  return { scale: vp.scale, tx: vp.tx + dx, ty: vp.ty + dy };
}

export function screenToWorld(
  vp: Viewport, screenX: number, screenY: number,
): { x: number; y: number } {
  return {
    x: (screenX - vp.tx) / vp.scale,
    y: (screenY - vp.ty) / vp.scale,
  };
}

/** Cubic-out easing — fast start, gentle landing. Standard for
 * UI tweens because it feels purposeful without being abrupt. */
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}


// ── Hook ────────────────────────────────────────────────────────────


export interface ViewportApi {
  /** Read inside the rAF draw loop — hot path, no React re-render. */
  viewportRef: React.MutableRefObject<Viewport>;
  /** Read in JSX (e.g. zoom indicator). Re-renders on every change. */
  viewport:    Viewport;
  /** Scroll-wheel zoom centered on cursor. */
  onWheel:     (e: React.WheelEvent<HTMLCanvasElement>) => void;
  /** Drag-pan: pointerDown begins, pointerMove pans, pointerUp ends. */
  onPointerDown: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerUp:   (e: React.PointerEvent<HTMLCanvasElement>) => void;
  /** Double-click empty area → animate back to identity viewport. */
  onDoubleClick: (e: React.MouseEvent<HTMLCanvasElement>) => void;
  /** Programmatic: smoothly tween to a target viewport (e.g.
   * "zoom-to-cluster" in Sprint 5o-B). Cancels any in-flight tween. */
  tweenTo:       (target: Viewport) => void;
  /** Reset to identity instantly (no tween) — mostly for tests / debug. */
  reset:         () => void;
  /** Cursor hint exposed to RadarCanvas for the canvas style prop. */
  cursor:        'default' | 'grab' | 'grabbing';
  /** True while pointer is actively panning — RadarCanvas suppresses
   * `onClick` selection during pans so a drag doesn't double as a click. */
  isPanning:     boolean;
}


export function useViewport(): ViewportApi {
  const viewportRef = useRef<Viewport>({ ...IDENTITY });
  // Counter forces re-render of UI overlays that read `viewport` (the
  // snapshot) — kept separate from the ref so the draw loop's per-frame
  // ref read never causes React work.
  const [, setVersion] = useState(0);
  const bump = useCallback(() => { setVersion(v => v + 1); }, []);

  // Pan state lives in refs — pointermove fires often, we don't want
  // to batch through React state.
  const isPanningRef    = useRef(false);
  const lastPointerRef  = useRef<{x: number; y: number} | null>(null);
  const [isPanning, setIsPanning] = useState(false);

  // Active tween (if any) — cancelled by user input or new tween.
  const tweenRef = useRef<number | null>(null);
  const cancelTween = useCallback(() => {
    if (tweenRef.current !== null) {
      cancelAnimationFrame(tweenRef.current);
      tweenRef.current = null;
    }
  }, []);

  const apply = useCallback((vp: Viewport) => {
    viewportRef.current = vp;
    bump();
  }, [bump]);

  const onWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    cancelTween();
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    // Wheel down (positive deltaY) = zoom out; up = zoom in.
    // Magnitude bounded to one notch worth so a fast trackpad swipe
    // can't multiply the factor 50× and overshoot.
    const direction = e.deltaY > 0 ? -1 : 1;
    const factor = direction > 0 ? WHEEL_FACTOR_BASE : 1 / WHEEL_FACTOR_BASE;
    apply(zoomAtPoint(viewportRef.current, factor, mx, my));
  }, [apply, cancelTween]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    // Only primary button (left click) initiates a pan; right/middle
    // are reserved (browser default contextmenu, autoscroll).
    if (e.button !== 0) return;
    cancelTween();
    isPanningRef.current = true;
    setIsPanning(true);
    lastPointerRef.current = { x: e.clientX, y: e.clientY };
    // Capture so a drag that exits the canvas still releases on up.
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [cancelTween]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isPanningRef.current || lastPointerRef.current === null) return;
    const dx = e.clientX - lastPointerRef.current.x;
    const dy = e.clientY - lastPointerRef.current.y;
    lastPointerRef.current = { x: e.clientX, y: e.clientY };
    apply(pan(viewportRef.current, dx, dy));
  }, [apply]);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isPanningRef.current) return;
    isPanningRef.current = false;
    setIsPanning(false);
    lastPointerRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ok */ }
  }, []);

  const tweenTo = useCallback((target: Viewport) => {
    cancelTween();
    const start = { ...viewportRef.current };
    const t0 = performance.now();
    const step = (now: number) => {
      const elapsed = now - t0;
      const u = Math.min(1, elapsed / TWEEN_DURATION_MS);
      const k = easeOutCubic(u);
      apply({
        scale: start.scale + (target.scale - start.scale) * k,
        tx:    start.tx    + (target.tx    - start.tx)    * k,
        ty:    start.ty    + (target.ty    - start.ty)    * k,
      });
      if (u < 1) {
        tweenRef.current = requestAnimationFrame(step);
      } else {
        tweenRef.current = null;
      }
    };
    tweenRef.current = requestAnimationFrame(step);
  }, [apply, cancelTween]);

  const onDoubleClick = useCallback((_e: React.MouseEvent<HTMLCanvasElement>) => {
    // Smooth return to "fit-all" — operator's escape hatch when lost
    // somewhere deep in a zoomed cluster.
    tweenTo(IDENTITY);
  }, [tweenTo]);

  const reset = useCallback(() => {
    cancelTween();
    apply({ ...IDENTITY });
  }, [apply, cancelTween]);

  // Cleanup any in-flight tween if the component unmounts mid-animation.
  useEffect(() => {
    return () => { cancelTween(); };
  }, [cancelTween]);

  const cursor: ViewportApi['cursor'] = isPanning ? 'grabbing' : 'default';

  return {
    viewportRef,
    viewport: viewportRef.current,
    onWheel, onPointerDown, onPointerMove, onPointerUp, onDoubleClick,
    tweenTo, reset, cursor, isPanning,
  };
}
