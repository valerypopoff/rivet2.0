import type { ProcessEvents } from '@valerypopoff/rivet2-core';
import type { RunDataByNodeId } from '../state/dataFlow.js';

/**
 * Marks only the retained Watch child run selected by Core as the terminal
 * iteration. The summary is emitted after that child's retained events, so a
 * later parallel completion must not change which page is presented as
 * Terminal.
 *
 * Returns whether the supplied run data changed. A false result makes no
 * mutation, so Immer callers preserve identity for legacy summaries that do
 * not identify a child run, or for a duplicate summary.
 */
export function markStreamingOutputWatchTerminal(
  runDataByNodeId: RunDataByNodeId,
  { execution, summary }: ProcessEvents['streamingOutputWatchSummary'],
): boolean {
  const terminalGraphRunId = summary.selectedIteration?.graphRunId;
  if (terminalGraphRunId == null) {
    return false;
  }

  let changed = false;
  for (const processes of Object.values(runDataByNodeId)) {
    for (const process of processes) {
      if (
        process.graphRunId === terminalGraphRunId &&
        (execution.rootRunId == null || process.rootRunId === execution.rootRunId) &&
        process.data.streamingWatchTerminal !== true
      ) {
        process.data.streamingWatchTerminal = true;
        changed = true;
      }
    }
  }

  return changed;
}
