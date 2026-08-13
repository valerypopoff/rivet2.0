import type { RunActivityJournal } from '../features/runActivity/runActivityJournal.js';
import {
  getRunActivityRootDurationMs,
  selectCurrentRunActivityRoot,
} from '../features/runActivity/runActivityJournal.js';

export type RuntimeStatusTiming = {
  elapsedMs?: number;
  startedAt?: number;
  isLive: boolean;
};

/**
 * Resolves the compact Runtime indicator from the same root-run owner used by
 * Run Activity. The graph start atom is retained only as a compatibility
 * fallback for a live run whose first activity event has not arrived yet.
 */
export function resolveRuntimeStatusTiming(options: {
  graphRunning: boolean;
  graphStartTime?: number;
  journal: RunActivityJournal;
  now: number;
}): RuntimeStatusTiming {
  const root = selectCurrentRunActivityRoot(options.journal);
  const liveGraphStartTime = options.graphRunning ? options.graphStartTime : undefined;
  const hasNewerUnjournaledLiveRun =
    liveGraphStartTime != null &&
    (root == null || root.finishedAt != null || root.startedAt == null || liveGraphStartTime > root.startedAt);

  if (hasNewerUnjournaledLiveRun) {
    return {
      elapsedMs: Math.max(0, options.now - liveGraphStartTime),
      startedAt: liveGraphStartTime,
      isLive: true,
    };
  }

  if (root?.startedAt != null) {
    return {
      elapsedMs: getRunActivityRootDurationMs(root, options.now),
      startedAt: root.startedAt,
      isLive: root.finishedAt == null,
    };
  }

  if (liveGraphStartTime != null) {
    return {
      elapsedMs: Math.max(0, options.now - liveGraphStartTime),
      startedAt: liveGraphStartTime,
      isLive: true,
    };
  }

  return { isLive: false };
}
