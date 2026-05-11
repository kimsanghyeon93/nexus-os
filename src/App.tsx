// App — main NEXUS OS container.
// 3-column layout: CommandCenter (left), RadarCanvas (center), PropertyHUD
// (right). The optional harnessSlot is rendered docked to the bottom of the
// right column — that's where dev/test panels live so they never overlap the
// canvas's bottom-left legend or HUD overlays.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMarketData } from './hooks/useMarketData';
import { TopBar } from './components/HUD/TopBar';
import { CommandCenter } from './components/HUD/CommandCenter';
import { PropertyHUD } from './components/HUD/PropertyHUD';
import { CaptureHistory } from './components/HUD/CaptureHistory';
import { DiffSummaryCard } from './components/HUD/DiffSummaryCard';
import { BootSequenceOverlay } from './components/HUD/BootSequenceOverlay';
import { AuditModal } from './components/HUD/AuditModal';
import { RadarCanvas, type RadarCanvasHandle } from './components/Graph/RadarCanvas';
import { parseSnapshotPayload, prepareSnapshot, triggerDownload, type SnapshotEntry } from './utils/snapshot';
import { summarizeDiff, type DiffFilter } from './utils/diff';
import { loadLayoutPref, saveLayoutPref, loadTourSeen, saveTourSeen } from './utils/persistence';
import type { GraphViewConfig } from './types/nexus';
import type { IMarketStreamer } from './types/streamer';

const HISTORY_MAX = 5;

const DEFAULT_VIEW: GraphViewConfig = {
  glowIntensity: 1.0,
  dataDensity: 1.0,
  edgeMode: 'curved',
  showFlow: true,
  centrality: 'eigen',
};

export interface AppProps {
  /** Optional injected streamer. In production, the real WebSocket client.
   *  In dev/test, the harness MockStreamer. Omit for legacy synthetic mode. */
  streamer?: IMarketStreamer;
  /** Optional dev/test panel rendered in the right-column bottom slot.
   *  Used by NexusTestbed to dock the HarnessPanel without overlap. */
  harnessSlot?: ReactNode;
  /** Controlled selection. When provided, App becomes a controlled component
   *  for selectedId — used by NexusTestbed so the harness's shock button can
   *  target the currently selected entity. */
  selectedId?: string | null;
  onSelectedChange?: (id: string | null) => void;
  /** Human-readable source label for the TopBar source badge
   *  (e.g. 'BACKEND · LIVE'). Omit to hide the badge entirely. */
  sourceLabel?: string;
  /** Source origin classification — drives the badge color tone:
   *    'remote' = data is coming over the network from nexus-backend → cyan
   *    'local'  = synthetic / replay / offline adapter           → low (grey) */
  sourceKind?: 'remote' | 'local';
}

export default function App({
  streamer, harnessSlot,
  selectedId: controlledSelectedId, onSelectedChange,
  sourceLabel, sourceKind,
}: AppProps = {}) {
  const {
    dataset, telemetry, sso, shockTarget, connectionState,
    isReplaying, isDiffing, diffMap, diffEdgeMap, liveEntityIds,
    replayDataset, diffSnapshot, resumeLive,
  } = useMarketData(streamer);
  const { ENTITIES, TX, CLUSTERS } = dataset;

  const [view] = useState<GraphViewConfig>(DEFAULT_VIEW);

  // Symmetric column collapse — both flags lazy-init from a single layout pref
  // payload, so reload restores the operator's exact war-room geometry.
  const initialLayout = useState(() => loadLayoutPref())[0];
  const [isLeftColumnCollapsed, setIsLeftColumnCollapsed]   = useState<boolean>(initialLayout.leftCollapsed);
  const [isRightColumnCollapsed, setIsRightColumnCollapsed] = useState<boolean>(initialLayout.rightCollapsed);
  useEffect(() => {
    // Single write per flip — both flags persisted atomically.
    saveLayoutPref({
      leftCollapsed:  isLeftColumnCollapsed,
      rightCollapsed: isRightColumnCollapsed,
    });
  }, [isLeftColumnCollapsed, isRightColumnCollapsed]);

  // First-run JARVIS boot sequence. Shows the briefing once per browser, then
  // never again unless the operator explicitly re-opens it via the Show Help
  // command, the `?` hotkey, or `⌘/` / `Ctrl+/`. Lazy-init means the tour
  // decision for the auto-open is fixed on mount.
  const [showBootTour, setShowBootTour] = useState<boolean>(() => !loadTourSeen());
  const dismissBootTour = useCallback(() => {
    // Always mark as seen on dismiss — manual re-open from the command list
    // is the supported flow for repeat viewing, so we don't need to keep
    // re-auto-triggering on subsequent sessions.
    saveTourSeen();
    setShowBootTour(false);
  }, []);
  const toggleBootTour = useCallback(() => {
    // Pure UI toggle — never touches diff/replay/streamer state. The overlay
    // sits on top (z-index 1200) of whatever's running underneath.
    setShowBootTour(prev => !prev);
  }, []);

  // Deep Focus toggle — when both columns are collapsed, the canvas spans the
  // full width minus two narrow handles. Symmetric to a "presentation mode".
  const toggleDeepFocus = useCallback(() => {
    const bothCollapsed = isLeftColumnCollapsed && isRightColumnCollapsed;
    if (bothCollapsed) {
      setIsLeftColumnCollapsed(false);
      setIsRightColumnCollapsed(false);
    } else {
      setIsLeftColumnCollapsed(true);
      setIsRightColumnCollapsed(true);
    }
  }, [isLeftColumnCollapsed, isRightColumnCollapsed]);
  const [internalSelectedId, setInternalSelectedId] = useState<string | null>('OBSIDIAN');
  const isControlled = controlledSelectedId !== undefined;
  const selectedId = isControlled ? controlledSelectedId : internalSelectedId;
  // Memoized so the shock-target useEffect (and any future consumers) get a
  // stable identity across renders — react-hooks/exhaustive-deps relies on
  // referential equality to know when "unchanged" really means unchanged.
  const setSelectedId = useCallback((id: string | null) => {
    if (!isControlled) setInternalSelectedId(id);
    onSelectedChange?.(id);
  }, [isControlled, onSelectedChange]);

  // Promote anomaly shocks to selection so the existing 4-hop BFS wave fires.
  // null → target on a separate task to guarantee RadarCanvas's [selectedId]
  // effect re-runs even when the shock target equals the current selection.
  useEffect(() => {
    if (!shockTarget) return;
    setSelectedId(null);
    const t = setTimeout(() => setSelectedId(shockTarget.id), 0);
    return () => clearTimeout(t);
  }, [shockTarget, setSelectedId]);

  // Cinematic "system freeze" — flash the canvas borders + a faint overlay
  // for 250ms when a snapshot is captured. Token bumped on every capture so
  // consecutive snapshots restart the animation cleanly.
  const [snapshotPulse, setSnapshotPulse] = useState(0);

  // Audit trail: last 5 captures. The actual JSON bytes are cached in a ref
  // so RE-DL replays the EXACT payload that was originally written, not a
  // recapture of the dataset's current (possibly mutated) state.
  const [snapshotHistory, setSnapshotHistory] = useState<ReadonlyArray<SnapshotEntry>>([]);
  const [pulseId, setPulseId] = useState<string | null>(null);
  const jsonCacheRef = useRef<Map<string, string>>(new Map());

  // Sprint 5o-B command wiring:
  //   ⌘A Analyze cluster — drive RadarCanvas via imperative handle (zoom)
  //   ⌘R Replay last shock — re-fire triggerAnomaly on the most recent target
  //   ⌘! Raise alert       — fire triggerAnomaly on the current selection
  // The radar ref captures the imperative handle exposed by RadarCanvas;
  // lastShockIdRef remembers the most recent shock target across renders
  // (a ref, not state, because re-render isn't useful — only the click is).
  const radarRef    = useRef<RadarCanvasHandle | null>(null);
  const lastShockIdRef = useRef<string | null>(null);
  // Track shock targets coming through the streamer (anomaly events fire
  // shockTarget; clicking "Raise alert" fires triggerAnomaly which loops
  // back through the streamer → setShockTarget → here).
  useEffect(() => {
    if (shockTarget) lastShockIdRef.current = shockTarget.id;
  }, [shockTarget]);

  // Sprint 5o-C-1: Isolation focus. When set, RadarCanvas dims everything
  // except this entity + its 1-hop neighbors (DIM_FACTOR = 6%). Distinct
  // from `selectedId` because operators can keep an isolation locked while
  // hovering / selecting other entities for inspection — handy for tracing
  // the relationship between a focused node and unrelated regions.
  const [isolatedId, setIsolatedId] = useState<string | null>(null);

  // Sprint 5o-C-2: Trace flow path. When set, RadarCanvas dims everything
  // except the downstream cone reachable via directed edges from this
  // entity (forward BFS, max 4 hops). Independent of isolatedId — both
  // can be locked simultaneously and compose multiplicatively (DIM_FACTOR²
  // for nodes/edges outside both sets) so the operator can simultaneously
  // see "X's neighborhood" + "Y's downstream cone" without losing either.
  const [tracedId, setTracedId] = useState<string | null>(null);

  // Sprint 5o-C-3: ⌘L Audit modal target. When set, AuditModal mounts
  // and fetches /v1/audit/recent for the symbol. We store both id and
  // label so the modal title can show the human-readable name even
  // after the operator selects something else underneath.
  const [auditTarget, setAuditTarget] =
    useState<{ id: string; label: string } | null>(null);

  // Tiny toast for command feedback (⌘I/⌘T lock/unlock, ⌘R no-shock).
  // Auto-clears after 2.4s.
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2400);
    return () => clearTimeout(t);
  }, [toast]);

  const handleCommand = useCallback((id: string) => {
    if (id === 'snapshot') {
      const { json, meta } = prepareSnapshot(dataset);

      // Dedupe: same-second + same-node-count captures collide on filename.
      // Skip the audit-list duplicate but still serve the download — the
      // operator explicitly requested it.
      triggerDownload(json, meta.filename);
      console.info(`[NEXUS] snapshot captured · ${meta.filename} (${meta.bytes} bytes)`);
      setSnapshotPulse(p => p + 1);

      setSnapshotHistory(prev => {
        if (prev[0]?.filename === meta.filename) return prev;
        jsonCacheRef.current.set(meta.id, json);
        const next = [meta, ...prev].slice(0, HISTORY_MAX);
        // Evict cached JSON for entries that fell off the end (keep memory
        // bounded — 5 × ~100KB worst case, but worth being tidy).
        const liveIds = new Set(next.map(e => e.id));
        for (const cachedId of jsonCacheRef.current.keys()) {
          if (!liveIds.has(cachedId)) jsonCacheRef.current.delete(cachedId);
        }
        return next;
      });
      setPulseId(meta.id);
      return;
    }
    if (id === 'tour') {
      toggleBootTour();
      return;
    }

    // ── Sprint 5o-B: live commands ──────────────────────────────────
    // All four below require a current selection to act on.  We read
    // selection inline (avoiding a `selected` dep that would re-create
    // handleCommand on every selection flip and tear down the keydown
    // effect's cleanup unnecessarily).
    const currentSelected = isControlled ? controlledSelectedId : internalSelectedId;
    const selectedEntity  = currentSelected
      ? dataset.ENTITIES.find(e => e.id === currentSelected) ?? null
      : null;

    if (id === 'analyze') {
      if (!selectedEntity) {
        setToast('Select an entity first (⌘A then click)');
        return;
      }
      radarRef.current?.analyzeCluster(selectedEntity.cluster);
      console.info(`[NEXUS] analyze cluster · ${selectedEntity.cluster}`);
      return;
    }
    if (id === 'alert') {
      if (!selectedEntity) {
        setToast('Select an entity first to raise alert');
        return;
      }
      // Fires the 4-hop cascading ripple. Streamer's onAnomaly callback
      // promotes it back through useMarketData → setShockTarget → our
      // useEffect logs it as the lastShockId for ⌘R replay.
      streamer?.triggerAnomaly(selectedEntity.id);
      console.warn(`[NEXUS] alert raised · ${selectedEntity.id}`);
      return;
    }
    if (id === 'replay') {
      const last = lastShockIdRef.current;
      if (!last) {
        setToast('No shock to replay yet — raise an alert first');
        return;
      }
      streamer?.triggerAnomaly(last);
      console.info(`[NEXUS] replay last shock · ${last}`);
      return;
    }

    // ⌘I Isolate entity (Sprint 5o-C-1): three-way toggle.
    //   no selection         → toast "select first"
    //   selected === isolated → clear isolation (toast "Isolation lifted")
    //   isolated set, different selection → switch focus (toast "Isolated: X")
    //   isolation off, selection set → engage (toast "Isolated: X")
    if (id === 'isolate') {
      if (!selectedEntity) {
        setToast('Select an entity first to isolate');
        return;
      }
      if (isolatedId === selectedEntity.id) {
        setIsolatedId(null);
        setToast('Isolation lifted');
        console.info('[NEXUS] isolation lifted');
        return;
      }
      setIsolatedId(selectedEntity.id);
      setToast(`Isolated: ${selectedEntity.label}`);
      console.info(`[NEXUS] isolate · ${selectedEntity.id} (${selectedEntity.label})`);
      return;
    }

    // ⌘T Trace flow path (Sprint 5o-C-2): three-way toggle, mirroring ⌘I.
    //   no selection             → toast "select first"
    //   selected === traced      → clear trace (toast "Trace cleared")
    //   traced set, different    → switch focus (toast "Tracing flow: X")
    //   trace off, selection set → engage (toast "Tracing flow: X")
    // State is independent of isolatedId so both can be active
    // simultaneously — closures in RadarCanvas compose them multiplicatively.
    if (id === 'trace') {
      if (!selectedEntity) {
        setToast('Select an entity first to trace');
        return;
      }
      if (tracedId === selectedEntity.id) {
        setTracedId(null);
        setToast('Trace cleared');
        console.info('[NEXUS] trace cleared');
        return;
      }
      setTracedId(selectedEntity.id);
      setToast(`Tracing flow: ${selectedEntity.label}`);
      console.info(`[NEXUS] trace · ${selectedEntity.id} (${selectedEntity.label})`);
      return;
    }

    // ⌘L Audit transactions (Sprint 5o-C-3): open the AuditModal for the
    // current selection. The modal owns its own fetch + loading / empty
    // / error states; we just point it at a symbol. Re-pressing ⌘L while
    // already open and pointing at the SAME entity closes the modal —
    // mirrors ⌘I / ⌘T's "press again to clear" muscle memory.
    if (id === 'audit') {
      if (!selectedEntity) {
        setToast('Select an entity first to audit');
        return;
      }
      if (auditTarget?.id === selectedEntity.id) {
        setAuditTarget(null);
        return;
      }
      setAuditTarget({ id: selectedEntity.id, label: selectedEntity.label });
      console.info(`[NEXUS] audit · ${selectedEntity.id} (${selectedEntity.label})`);
      return;
    }
  }, [dataset, toggleBootTour, isControlled, controlledSelectedId, internalSelectedId, streamer, isolatedId, tracedId, auditTarget]);

  // Clear the new-entry pulse 700ms after it fires so subsequent captures
  // can re-pulse the topmost row even if it has the same id (rare).
  useEffect(() => {
    if (pulseId == null) return;
    const t = setTimeout(() => setPulseId(null), 700);
    return () => clearTimeout(t);
  }, [pulseId]);

  const handleReplay = useCallback((id: string) => {
    const json = jsonCacheRef.current.get(id);
    if (!json) {
      console.warn(`[NEXUS] replay miss — entry ${id} no longer cached`);
      return;
    }
    const entry = snapshotHistory.find(e => e.id === id);
    if (!entry) return;
    triggerDownload(json, entry.filename);
    console.info(`[NEXUS] snapshot replayed · ${entry.filename}`);
  }, [snapshotHistory]);

  // Global power-user hotkeys.
  //   ⌘S  / Ctrl+S  — snapshot capture (preventDefault blocks Save Page).
  //   ⌘\  / Ctrl+\  — Deep Focus toggle (collapse/expand both columns).
  //   ?            — toggle JARVIS boot briefing (Shift+/ on US layouts).
  //   ⌘/  / Ctrl+/  — alias for `?`, useful when shift state is awkward.
  // Cleanup on unmount prevents listener leak across hot-reload / remount.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Help hotkey — handled FIRST so it works while overlays are showing.
      // The two equivalent bindings cover both shift-and-no-mod and the
      // explicit ⌘/ Ctrl+/ alias.
      const isHelpKey =
        (!e.metaKey && !e.ctrlKey && !e.altKey && e.key === '?') ||
        ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === '/' || e.code === 'Slash'));
      if (isHelpKey) {
        e.preventDefault();
        toggleBootTour();
        return;
      }

      const mod = (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey;
      if (!mod) return;
      if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        handleCommand('snapshot');
        return;
      }
      // Sprint 5o-B command hotkeys. ⌘! (alert) is awkward on most layouts
      // because Shift+1 = "!"; we accept both `e.key === '!'` (the shifted
      // glyph) and the Digit1 code with shiftKey set.
      if (e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        handleCommand('analyze');
        return;
      }
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        handleCommand('replay');
        return;
      }
      if (e.key === 'i' || e.key === 'I') {
        e.preventDefault();
        handleCommand('isolate');
        return;
      }
      if (e.key === 't' || e.key === 'T') {
        e.preventDefault();
        handleCommand('trace');
        return;
      }
      if (e.key === 'l' || e.key === 'L') {
        e.preventDefault();
        handleCommand('audit');
        return;
      }
      // KeyboardEvent.code is more reliable than .key for punctuation.
      if (e.key === '\\' || e.code === 'Backslash') {
        e.preventDefault();
        toggleDeepFocus();
        return;
      }
    };
    // ⌘! Raise alert — separate handler because we need shiftKey set
    // (Shift+1 produces "!" on US/KR layouts).
    const onAlertKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (e.key === '!' || (e.shiftKey && e.code === 'Digit1')) {
        e.preventDefault();
        handleCommand('alert');
      }
    };
    window.addEventListener('keydown', onAlertKey);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keydown', onAlertKey);
    };
  }, [handleCommand, toggleDeepFocus, toggleBootTour]);

  // Global drag-and-drop replay. The whole window is the drop target so the
  // operator can drop a snapshot anywhere on the war-room display. A depth
  // counter handles the dragenter/dragleave nesting that fires on every
  // child element traversal — only the "outer" enter/leave toggle the overlay.
  const [isDragHover, setIsDragHover] = useState(false);
  useEffect(() => {
    let depth = 0;
    const hasFile = (dt: DataTransfer | null) =>
      !!dt && Array.from(dt.types).includes('Files');

    const onDragEnter = (e: DragEvent) => {
      if (!hasFile(e.dataTransfer)) return;
      e.preventDefault();
      depth++;
      if (depth === 1) setIsDragHover(true);
    };
    const onDragOver = (e: DragEvent) => {
      if (!hasFile(e.dataTransfer)) return;
      e.preventDefault();
      // Required so the browser fires the drop event AND shows the copy cursor.
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = (e: DragEvent) => {
      if (!hasFile(e.dataTransfer)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setIsDragHover(false);
    };
    const onDrop = async (e: DragEvent) => {
      if (!hasFile(e.dataTransfer)) return;
      e.preventDefault();
      depth = 0;
      setIsDragHover(false);
      // Shift held at drop time selects DIFF mode instead of plain replay.
      // Captured BEFORE the async file read so a key release mid-parse
      // doesn't accidentally downgrade the operator's intent.
      const wantsDiff = e.shiftKey;
      const file = e.dataTransfer?.files?.[0];
      if (!file || !/\.json$/i.test(file.name)) {
        console.warn(`[NEXUS] replay rejected — not a .json file (${file?.name ?? 'no file'})`);
        return;
      }
      try {
        const text = await file.text();
        const parsed = parseSnapshotPayload(text);
        if (!parsed) {
          console.warn(`[NEXUS] replay rejected — payload doesn't match dataset shape`);
          return;
        }
        if (wantsDiff) {
          diffSnapshot(parsed);
          console.info(`[NEXUS] diff mode engaged · ${file.name} · ${parsed.ENTITIES.length} entities`);
        } else {
          replayDataset(parsed);
          console.info(`[NEXUS] snapshot replay loaded · ${file.name} · ${parsed.ENTITIES.length} entities`);
        }
      } catch (err) {
        console.warn('[NEXUS] replay failed', err);
      }
    };
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [replayDataset, diffSnapshot]);

  const selected = useMemo(
    () => ENTITIES.find(e => e.id === selectedId) || null,
    [ENTITIES, selectedId],
  );

  // Aggregate counts that drive the DiffSummaryCard. Recomputed only when a
  // diff session enters or exits — cheap relative to the underlying maps.
  const diffSummary = useMemo(
    () => (diffMap && diffEdgeMap ? summarizeDiff(diffMap, diffEdgeMap) : null),
    [diffMap, diffEdgeMap],
  );

  // Operator-selected filter for the diff highlight pass. Reset every time
  // a diff session begins or ends so a stale filter never clings to the
  // next session's data.
  const [diffFilter, setDiffFilter] = useState<DiffFilter>(null);
  useEffect(() => { setDiffFilter(null); }, [diffMap]);

  return (
    <div className="nx-app" data-screen-label="Dashboard">
      <TopBar
        telemetry={telemetry}
        sso={sso}
        connectionState={connectionState}
        {...(sourceLabel !== undefined ? { sourceLabel } : {})}
        {...(sourceKind  !== undefined ? { sourceKind  } : {})}
      />
      <div
        className={
          'nx-app__main' +
          (isLeftColumnCollapsed  ? ' nx-app__main--left-collapsed'  : '') +
          (isRightColumnCollapsed ? ' nx-app__main--right-collapsed' : '')
        }
      >
        <div className="nx-app__left">
          <button
            type="button"
            className="nx-col-toggle nx-col-toggle--left"
            data-testid="left-column-toggle"
            onClick={() => setIsLeftColumnCollapsed(c => !c)}
            aria-label={isLeftColumnCollapsed ? 'Expand left column' : 'Collapse left column'}
            aria-expanded={!isLeftColumnCollapsed}
            title={isLeftColumnCollapsed ? 'Expand left column' : 'Collapse left column'}
          >
            {isLeftColumnCollapsed ? '▸' : '◂'}
          </button>
          <div className="nx-app__left-content">
            <CommandCenter status="LISTENING" onCommand={handleCommand} />
          </div>
        </div>

        <RadarCanvas
          ref={radarRef}
          entities={ENTITIES}
          transactions={TX}
          clusters={CLUSTERS}
          selectedId={selectedId}
          onSelect={setSelectedId}
          glowIntensity={view.glowIntensity}
          dataDensity={view.dataDensity}
          edgeMode={view.edgeMode}
          showFlow={view.showFlow}
          centralityMode={view.centrality}
          diffEdgeMap={diffEdgeMap}
          diffMap={diffMap}
          diffFilter={diffFilter}
          isolatedId={isolatedId}
          tracedId={tracedId}
          liveEntityIds={liveEntityIds}
        />

        <div className="nx-app__right">
          <button
            type="button"
            className="nx-col-toggle"
            data-testid="right-column-toggle"
            onClick={() => setIsRightColumnCollapsed(c => !c)}
            aria-label={isRightColumnCollapsed ? 'Expand right column' : 'Collapse right column'}
            aria-expanded={!isRightColumnCollapsed}
            title={isRightColumnCollapsed ? 'Expand right column' : 'Collapse right column'}
          >
            {isRightColumnCollapsed ? '◂' : '▸'}
          </button>
          <div className="nx-app__right-content">
            <div className="nx-app__right-main">
              <PropertyHUD
                entity={selected}
                transactions={TX}
                onSelect={setSelectedId}
                diffMap={diffMap}
              />
              {isDiffing && diffSummary
                ? <DiffSummaryCard
                    summary={diffSummary}
                    filter={diffFilter}
                    onFilterChange={setDiffFilter}
                  />
                : <CaptureHistory
                    entries={snapshotHistory}
                    onReplay={handleReplay}
                    pulseId={pulseId}
                  />}
            </div>
            {harnessSlot && (
              <div className="nx-app__right-dev">{harnessSlot}</div>
            )}
          </div>
        </div>
      </div>
      {snapshotPulse > 0 && (
        <div
          key={snapshotPulse}
          className="nx-snapshot-flash"
          aria-hidden="true"
        />
      )}
      {isDragHover && <DropOverlay />}
      {isReplaying && (
        <ReplayBadge
          mode={isDiffing ? 'diff' : 'replay'}
          onResumeLive={resumeLive}
        />
      )}
      {showBootTour && <BootSequenceOverlay onDismiss={dismissBootTour} />}

      {/* Sprint 5o-C-3 Audit modal. Mounts when auditTarget is set; the
       *  modal owns its own fetch + loading/empty/error/data branches.
       *  Closing routes through onClose → null state → unmount, which
       *  also cancels any in-flight fetch via the modal's effect cleanup. */}
      {auditTarget && (
        <AuditModal
          symbol={auditTarget.id}
          label={auditTarget.label}
          onClose={() => setAuditTarget(null)}
        />
      )}

      {/* Sprint 5o-B command-feedback toast. Auto-clears 2.4s after the
       * command fires; floats above the canvas without occluding the HUD. */}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: 'fixed',
            top: '64px',
            left: '50%',
            transform: 'translateX(-50%)',
            padding: '8px 16px',
            background: 'rgba(11, 11, 24, 0.92)',
            border: '0.8px solid var(--cyan, #00BFFF)',
            borderRadius: '3px',
            color: 'var(--cyan, #00BFFF)',
            fontFamily: 'var(--font-mono, monospace)',
            fontSize: '11px',
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            zIndex: 1300,
            boxShadow: '0 0 12px rgba(0, 191, 255, 0.25)',
            pointerEvents: 'none',
          }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}

/** Full-screen drop hint shown while a file is being dragged over the window.
 *  The SHIFT hint surfaces the diff-mode entry path — operators only learn
 *  about it from this overlay, so the discoverability bar lives here. */
function DropOverlay() {
  return (
    <div className="nx-drop" aria-live="polite">
      <div className="nx-drop__frame">
        <div className="nx-drop__bracket nx-drop__bracket--l">[</div>
        <div className="nx-drop__body">
          <div className="nx-drop__label">DROP NEXUS SNAPSHOT</div>
          <div className="nx-drop__sub">TO REPLAY · .json — live feed will be paused</div>
          <div className="nx-drop__hint">
            HOLD <kbd className="nx-drop__kbd">SHIFT</kbd> WHILE DROPPING TO ENTER DIFF MODE
          </div>
        </div>
        <div className="nx-drop__bracket nx-drop__bracket--r">]</div>
      </div>
    </div>
  );
}

interface ReplayBadgeProps {
  /** 'replay' = full-replay freeze; 'diff' = comparing live vs snapshot. */
  mode: 'replay' | 'diff';
  onResumeLive: () => void;
}

/** Banner that lingers below the TopBar while in replay/diff. The right-aligned
 *  RESUME LIVE button is the explicit, discoverable exit — clicking it clears
 *  replay state, restores the live dataset, and restarts the active streamer. */
function ReplayBadge({ mode, onResumeLive }: ReplayBadgeProps) {
  const text = mode === 'diff'
    ? '◆ DIFF MODE · COMPARING LIVE vs SNAPSHOT · AMBER ↑ · CYAN ↓'
    : '◆ REPLAY MODE · LIVE FEED PAUSED';
  return (
    <div className="nx-replay-badge" aria-live="polite">
      <span className="nx-replay-badge__msg">{text}</span>
      <button
        type="button"
        className="nx-replay-badge__resume"
        data-testid="resume-live"
        onClick={onResumeLive}
      >
        RESUME LIVE ▸
      </button>
    </div>
  );
}
