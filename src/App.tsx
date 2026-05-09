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
import { RadarCanvas } from './components/Graph/RadarCanvas';
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
    isReplaying, isDiffing, diffMap, diffEdgeMap,
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
  const setSelectedId = (id: string | null) => {
    if (!isControlled) setInternalSelectedId(id);
    onSelectedChange?.(id);
  };

  // Promote anomaly shocks to selection so the existing 4-hop BFS wave fires.
  // null → target on a separate task to guarantee RadarCanvas's [selectedId]
  // effect re-runs even when the shock target equals the current selection.
  useEffect(() => {
    if (!shockTarget) return;
    setSelectedId(null);
    const t = setTimeout(() => setSelectedId(shockTarget.id), 0);
    return () => clearTimeout(t);
  }, [shockTarget]);

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
        if (prev.length > 0 && prev[0].filename === meta.filename) return prev;
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
    // other command ids are reserved for future wiring
  }, [dataset, toggleBootTour]);

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
      // KeyboardEvent.code is more reliable than .key for punctuation.
      if (e.key === '\\' || e.code === 'Backslash') {
        e.preventDefault();
        toggleDeepFocus();
        return;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
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
  }, [replayDataset]);

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
        sourceLabel={sourceLabel}
        sourceKind={sourceKind}
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
