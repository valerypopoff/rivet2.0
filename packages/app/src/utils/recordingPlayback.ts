import type { GraphId, RecordedEvents } from '@valerypopoff/rivet2-core';

/** Resolve the authored root graph that a recording must be replayed against. */
export function requireRecordingRootGraphId(events: readonly RecordedEvents[]): GraphId {
  for (const event of events) {
    if (event.type === 'start' && typeof event.data.startGraph === 'string' && event.data.startGraph.length > 0) {
      return event.data.startGraph;
    }
  }
  throw new Error('Recording does not declare a root start graph.');
}
