import type { ProcessDataForNode } from '../../state/dataFlow.js';

/**
 * Returns the retained Watch iteration selected after the stream settles.
 * A running branch has no terminal iteration yet: its newest page must remain
 * a numbered history page until Core emits the Watch summary.
 */
export function getStreamingOutputWatchTerminalPageIndex(processes: ProcessDataForNode[] | undefined): number | undefined {
  if (!processes) {
    return undefined;
  }

  for (let index = processes.length - 1; index >= 0; index -= 1) {
    if (processes[index]?.data.streamingWatchTerminal === true) {
      return index;
    }
  }

  return undefined;
}

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
