/**
 * Tracks post-recording LLM-profile evidence updates that intentionally run
 * outside the request response path. Workflow storage disposal drains these
 * before it closes its health-state store.
 */
const pendingRecordingOutcomes = new Set<Promise<void>>();

export function trackLLMProfileHealthRecordingOutcome(outcome: Promise<void>): Promise<void> {
  pendingRecordingOutcomes.add(outcome);
  void outcome.then(
    () => pendingRecordingOutcomes.delete(outcome),
    () => pendingRecordingOutcomes.delete(outcome),
  );
  return outcome;
}

export async function flushLLMProfileHealthRecordingOutcomes(): Promise<void> {
  while (pendingRecordingOutcomes.size > 0) {
    await Promise.all([...pendingRecordingOutcomes]);
  }
}