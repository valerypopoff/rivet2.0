/** Optional upload metadata: older API replicas ignore headers without rejecting the body. */
export const WORKFLOW_RECORDING_CREATED_AT_HEADER = 'x-rivet-recording-created-at';

/** Capture before persistence is queued; no artifact reads or deserialization. */
export function getWorkflowRecordingCreatedAt(
  events: readonly { type: string; ts: number; occurredAt?: number }[],
  fallback = Date.now(),
): string {
  const event = events.find((entry) => entry.type === 'start' || entry.type === 'graphStart') ?? events[0];
  const valid = (value: number | undefined): value is number =>
    value != null && Number.isFinite(value) && value > 0 && value <= 8.64e15;
  const timestamp = valid(event?.occurredAt) ? event.occurredAt : valid(event?.ts) ? event.ts : fallback;
  return new Date(timestamp).toISOString();
}
