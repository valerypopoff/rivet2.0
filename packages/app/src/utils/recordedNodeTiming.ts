import type { NodeRunData } from '../state/dataFlow.js';

type ReplayTimedEvent = {
  replayRecordedAt?: unknown;
};

/**
 * Separates a recording's historical node clock from the local receipt clock
 * used to order playback events in the editor.
 */
export function getRecordedNodeTimingPatch(
  event: ReplayTimedEvent,
  boundary: 'start' | 'terminal' | 'excluded',
): Partial<Pick<NodeRunData, 'recordedTiming'>> {
  const at = event.replayRecordedAt;
  if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) {
    return {};
  }

  switch (boundary) {
    case 'start':
      return { recordedTiming: { startedAt: at } };
    case 'terminal':
      return { recordedTiming: { finishedAt: at } };
    case 'excluded':
      return { recordedTiming: { startedAt: at, finishedAt: at } };
  }
}
