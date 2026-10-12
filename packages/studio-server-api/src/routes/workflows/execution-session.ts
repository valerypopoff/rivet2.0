import { performance } from 'node:perf_hooks';
import { ExecutionRecorder, type NodeCreatedProcessor, type DataValue } from '@valerypopoff/rivet2-node';

export type ExecutionSessionResult = {
  recorder: ExecutionRecorder | null;
  outputs?: Record<string, DataValue>;
  status: 'succeeded' | 'failed' | 'suspicious';
  durationMs: number;
  errorMessage?: string;
  failure?: { error: unknown };
};
export function getExecutionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export function getExecutionOutputStatus(
  outputs: Record<string, { type?: string; value?: unknown }>,
): 'succeeded' | 'suspicious' {
  return outputs.output?.type === 'control-flow-excluded' ? 'suspicious' : 'succeeded';
}
function disposeProcessor(processor: NodeCreatedProcessor): void {
  try {
    processor.dispose();
  } catch {
    // Cleanup must not replace a completed result or prevent its evidence from
    // being persisted. Exception contents may contain provider credentials.
    console.error('[workflow-execution] Processor cleanup failed; resources may remain allocated.');
  }
}

/** Owns one processor through its full terminal, including post-response work.
 * Transports deliver foreground outputs; they never own tail completion or
 * release this processor early on a response-writing failure. Persistence is
 * deliberately caller-owned (Evaluation artifacts differ from workflow runs). */
export class ExecutionSession {
  readonly recorder: ExecutionRecorder | null;
  #started = false;
  constructor(
    readonly processor: NodeCreatedProcessor,
    options: {
      recording: boolean;
      recorderOptions?: ConstructorParameters<typeof ExecutionRecorder>[0];
    },
  ) {
    try {
      this.recorder = options.recording ? new ExecutionRecorder(options.recorderOptions) : null;
      this.recorder?.record(processor.processor);
    } catch (error) {
      disposeProcessor(processor);
      throw error;
    }
  }
  async run(
    onForeground?: (outputs: Record<string, DataValue>) => void | Promise<void>,
  ): Promise<ExecutionSessionResult> {
    if (this.#started) throw new Error('An execution session can run only once.');
    this.#started = true;
    const startedAt = performance.now();
    const result: ExecutionSessionResult = { recorder: this.recorder, status: 'succeeded', durationMs: 0 };
    try {
      const foreground = await this.processor.run();
      try {
        await onForeground?.(foreground);
      } catch (error) {
        result.failure = { error };
      }
      const outputs = await this.processor.processor.waitForRunCompletion();
      result.outputs = outputs;
      result.status = getExecutionOutputStatus(outputs);
    } catch (error) {
      result.status = 'failed';
      result.errorMessage = getExecutionErrorMessage(error);
      result.failure = { error };
    } finally {
      result.durationMs = performance.now() - startedAt;
      disposeProcessor(this.processor);
    }
    return result;
  }
}
