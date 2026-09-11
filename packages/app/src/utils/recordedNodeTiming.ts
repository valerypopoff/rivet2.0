import type { NodeRunData } from '../state/dataFlow.js';

type ReplayTimedEvent = {
  eventOccurredAt?: unknown;
  replayRecordedAt?: unknown;
};

export type RecordedNodeTiming = {
  startedAt?: number;
  finishedAt?: number;
};

/**
 * Returns the authoritative execution-occurrence clock from a deferred live
 * Watch event or from RecordingPlayer. This is deliberately shared by node
 * history and Run Activity so neither surface can substitute delivery time
 * for execution timing.
 */
export function getEventOccurredAt(event: unknown): number | undefined {
  if (event == null || typeof event !== 'object') return undefined;
  const { eventOccurredAt, replayRecordedAt } = event as ReplayTimedEvent;
  // An untrusted or older transport can carry a malformed optional Watch
  // clock. Do not let it mask otherwise valid replay provenance.
  return isTimestamp(eventOccurredAt) ? eventOccurredAt : isTimestamp(replayRecordedAt) ? replayRecordedAt : undefined;
}

/** @deprecated Use getEventOccurredAt for live deferred and replayed events. */
export function getReplayRecordedAt(event: unknown): number | undefined {
  if (event == null || typeof event !== 'object') return undefined;
  const at = (event as ReplayTimedEvent).replayRecordedAt;
  return isTimestamp(at) ? at : undefined;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Builds the historical node boundary represented by one replayed event. */
export function getRecordedNodeTiming(
  event: ReplayTimedEvent,
  boundary: 'start' | 'terminal' | 'excluded',
): RecordedNodeTiming | undefined {
  const at = getEventOccurredAt(event);
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
