import type { NodeRunData } from '../state/dataFlow.js';

type ReplayTimedEvent = {
  replayRecordedAt?: unknown;
};

export type RecordedNodeTiming = {
  startedAt?: number;
  finishedAt?: number;
};

/**
 * Returns the original recording timestamp carried by RecordingPlayer. This
 * is deliberately shared by node history and Run Activity so neither surface
 * can accidentally treat a replay delivery timestamp as execution timing.
 */
export function getReplayRecordedAt(event: unknown): number | undefined {
  if (event == null || typeof event !== 'object') return undefined;
  const at = (event as ReplayTimedEvent).replayRecordedAt;
  return typeof at === 'number' && Number.isFinite(at) && at >= 0 ? at : undefined;
}

/** Builds the historical node boundary represented by one replayed event. */
export function getRecordedNodeTiming(
  event: ReplayTimedEvent,
  boundary: 'start' | 'terminal' | 'excluded',
): RecordedNodeTiming | undefined {
  const at = getReplayRecordedAt(event);
  if (at == null) return undefined;

  switch (boundary) {
    case 'start':
      return { startedAt: at };
    case 'terminal':
      return { finishedAt: at };
    case 'excluded':
      return { startedAt: at, finishedAt: at };
  }
}

/**
 * Separates a recording's historical node clock from the local receipt clock
 * used to order playback events in the editor.
 */
export function getRecordedNodeTimingPatch(
  event: ReplayTimedEvent,
  boundary: 'start' | 'terminal' | 'excluded',
): Partial<Pick<NodeRunData, 'recordedTiming'>> {
  const recordedTiming = getRecordedNodeTiming(event, boundary);
  return recordedTiming == null ? {} : { recordedTiming };
}
