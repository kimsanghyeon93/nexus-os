// snapshot.ts — capture the current NEXUS dataset to a downloadable JSON file.
//
// Filename convention is mission-critical and must match exactly:
//
//   nexus_snapshot_YYYYMMDD_HHMMSS_<NodeCount>nodes.json
//
// Example: nexus_snapshot_20260508_143012_106nodes.json
//
// The payload wraps the live dataset in a small envelope with capture metadata
// so a downstream investigations workspace can replay or diff snapshots.
//
// This module is split into two pieces:
//   1. prepareSnapshot(dataset)  — pure: builds JSON + metadata (no side effect)
//   2. triggerDownload(json, fn) — side effect: invokes Blob + <a download>
//
// The split lets the App cache prepared JSON for "RE-DL" replay (Sprint 3k)
// without re-serializing or risking divergence from the original capture.

import type { NexusDataset } from '../types/nexus';

export interface SnapshotMeta {
  /** Stable identity for React keys + history dedupe. */
  id: string;
  /** UTC ISO-8601 capture instant. */
  capturedAt: string;
  /** Filename per the nexus_snapshot_… convention. */
  filename: string;
  /** Serialized payload size in bytes (matches what was downloaded). */
  bytes: number;
  /** Snapshot of dataset.ENTITIES.length at capture time. */
  nodeCount: number;
}

/** History entry surfaced to the CaptureHistory HUD. */
export type SnapshotEntry = SnapshotMeta;

const VERSION = 'nexus-os-v4.20';

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

function timestampParts(d: Date): { date: string; time: string } {
  return {
    date: `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`,
    time: `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`,
  };
}

/** Build the JSON payload + metadata for a capture. Pure — no side effects. */
export function prepareSnapshot(dataset: NexusDataset): { json: string; meta: SnapshotMeta } {
  const now = new Date();
  const { date, time } = timestampParts(now);
  const nodeCount = dataset.ENTITIES.length;
  const filename = `nexus_snapshot_${date}_${time}_${nodeCount}nodes.json`;

  const payload = {
    version: VERSION,
    captured_at: now.toISOString(),
    counts: {
      entities:     dataset.ENTITIES.length,
      transactions: dataset.TX.length,
      clusters:     dataset.CLUSTERS.length,
    },
    dataset,
  };

  const json = JSON.stringify(payload, null, 2);
  const bytes = new Blob([json]).size;
  // The filename uniquely identifies a capture (second-precision + nodeCount),
  // so it's a natural primary key. Concatenate with the byte length to break
  // any same-second / same-count collision on rapid successive captures.
  const id = `${filename}:${bytes}`;

  return {
    json,
    meta: {
      id,
      capturedAt: now.toISOString(),
      filename,
      bytes,
      nodeCount,
    },
  };
}

/** Side-effect: stream the prepared JSON to the operator's downloads folder. */
export function triggerDownload(json: string, filename: string): void {
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    // Defer revocation a tick — Safari needs the URL alive long enough for
    // the click to be processed before it's garbage-collected.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** Convenience: prepare + download in one shot. Used by the primary capture
 *  flow (CommandCenter button, ⌘S hotkey). Replay uses the split form so it
 *  can re-emit the exact byte sequence from the original capture. */
export function downloadSnapshot(dataset: NexusDataset): SnapshotMeta {
  const { json, meta } = prepareSnapshot(dataset);
  triggerDownload(json, meta.filename);
  return meta;
}

/* ------------------------------------------------------------------ */
/*  Replay — accept dropped JSON files and parse back into a dataset   */
/* ------------------------------------------------------------------ */

/** Parse a JSON string into a NexusDataset. Accepts two shapes:
 *
 *   1. Envelope (preferred — what prepareSnapshot writes):
 *        { version, captured_at, counts, dataset: { ENTITIES, TX, CLUSTERS } }
 *
 *   2. Raw dataset (lenient — useful for hand-edited fixtures):
 *        { ENTITIES, TX, CLUSTERS }
 *
 *  Returns null if the input is not parseable or doesn't satisfy the minimum
 *  shape — callers should treat null as "ignore this drop". */
export function parseSnapshotPayload(text: string): NexusDataset | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;

  const candidate =
    isDatasetShape(obj) ? (obj as unknown as NexusDataset) :
    isDatasetShape(obj.dataset) ? (obj.dataset as NexusDataset) :
    null;

  return candidate;
}

function isDatasetShape(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    Array.isArray(o.ENTITIES) &&
    Array.isArray(o.TX) &&
    Array.isArray(o.CLUSTERS)
  );
}
