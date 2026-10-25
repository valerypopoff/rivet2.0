import type { GraphOutputs } from '@valerypopoff/rivet2-core';
import {
  EvaluationGraphExecutionError,
  type EvaluationEventCollector,
  type EvaluationRecordingReference,
  type PortableJson,
} from '@valerypopoff/rivet2-evaluations';

/** One trial-result policy, with execution and terminal capture owned by the adapter. */
export async function executeEvaluationGraph(input: {
  execute: () => Promise<GraphOutputs>;
  captured: EvaluationEventCollector;
  startedAt: number;
  signal?: AbortSignal;
  /** Node waits for its request-scoped recording; Browser capture is already synchronous. */
  settleCapture?: (failed: boolean) => Promise<void>;
  persistRecording: () => Promise<EvaluationRecordingReference | undefined>;
}) {
  const { captured, signal } = input;
  const evidence = async () => {
    const recording = await input.persistRecording();
    return {
      metrics: captured.metrics,
      ...(recording === undefined ? {} : { recording }),
      ...(captured.providerAttempts.length === 0 ? {} : { providerAttempts: captured.providerAttempts }),
    };
  };
  try {
    const outputs = await input.execute();
    captured.metrics.durationMs = Date.now() - input.startedAt;
    await input.settleCapture?.(false);
    return {
      outputs: Object.fromEntries(Object.entries(outputs).map(([key, value]) => [key, value.value as PortableJson])),
      ...(await evidence()),
    };
  } catch (error) {
    captured.metrics.durationMs = Math.max(captured.metrics.durationMs, Date.now() - input.startedAt);
    await input.settleCapture?.(true);
    const details = await evidence();
    if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error;
    throw new EvaluationGraphExecutionError(error instanceof Error ? error.message : String(error), details);
  }
}
