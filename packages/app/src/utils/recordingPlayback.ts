import type { GraphId, RecordedEvents } from '@valerypopoff/rivet2-core';

/** Hosted replay copies are detached snapshots, not editable source-project files. */
export function isRecordingSnapshotPath(path: string | null | undefined): boolean {
  return path?.startsWith('recording://') === true;
}

/** Hosted child artifacts have no root start; never substitute the currently viewed graph. */
export function getRecordingPlaybackGraphId(events: readonly RecordedEvents[]): GraphId | undefined {
  const start = events.find(
    (event) => event.type === 'start' && typeof event.data.startGraph === 'string' && event.data.startGraph.length > 0,
  );
  if (start?.type === 'start') return start.data.startGraph;
  const graphStart = events.find(
    (event) => event.type === 'graphStart' && typeof event.data.graphId === 'string' && event.data.graphId.length > 0,
  );
  return graphStart?.type === 'graphStart' ? graphStart.data.graphId : undefined;
}

/** Resolve the authored root graph that a recording must be replayed against. */
export function requireRecordingRootGraphId(events: readonly RecordedEvents[]): GraphId {
  for (const event of events) {
    if (event.type === 'start' && typeof event.data.startGraph === 'string' && event.data.startGraph.length > 0) {
      return event.data.startGraph;
    }
  }
  throw new Error('Recording does not declare a root start graph.');
}
