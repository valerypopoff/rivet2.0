import type { ProcessDataForNode } from '../../state/dataFlow.js';

/**
 * A parallel Watch branch can retain terminals in completion order, which is
 * not necessarily the order in which Stop accepted one. Prefer the explicit
 * execution marker; the final-entry fallback keeps older recordings legible.
 */
export function getStopWatchingStreamingOutputPresentation(
  processes: ProcessDataForNode[] | undefined,
): ProcessDataForNode[] | undefined {
  if (!processes?.length) {
    return processes;
  }

  const acceptedTerminal = processes.findLast((process) => process.data.streamingWatchTerminal === true);
  return [acceptedTerminal ?? processes.at(-1)!];
}
