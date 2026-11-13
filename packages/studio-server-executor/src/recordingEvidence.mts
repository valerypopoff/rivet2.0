import type {
  AppExecutorProcessorOptionsContext,
  AppExecutorHostOptions,
} from '../../app-executor/bin/executorHostState.mjs';
import type { RunEvidenceHandle } from '../../studio-server-shared/workflow-run-evidence.js';

/** The executor, rather than its browser observer, renews evidence for Node runs. */
export class HostedExecutorRecordingEvidence {
  readonly #runs = new Map<
    string,
    { handle: RunEvidenceHandle; correlationId: string; timer: ReturnType<typeof setInterval> }
  >();
  constructor(
    readonly baseUrl: string,
    readonly headers: () => HeadersInit,
    readonly request: typeof fetch = fetch,
  ) {}
  async #post(operation: string, body: unknown) {
    const headers = new Headers(this.headers());
    headers.set('content-type', 'application/json');
    const response = await this.request(
      new URL('/api/workflows/local-editor-recordings/runs/' + operation, this.baseUrl),
      {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) throw new Error('Executor recording evidence service is unavailable.');
    return response.json() as Promise<{ handle?: RunEvidenceHandle; state?: string }>;
  }
  async prepare(context: AppExecutorProcessorOptionsContext): Promise<void> {
    const correlationId = context.llmProfileHealthExecutionCorrelationId;
    if (!context.recordSubgraphProjectRuns || !correlationId?.startsWith('rvt-durable-local-')) return;
    if (this.#runs.has(context.requestId)) return;
    const { handle } = await this.#post('executor-owner', {
      projectId: context.project.metadata.id,
      graphId: context.graphId,
      correlationId,
      requestId: context.requestId,
    });
    if (!handle || typeof handle.id !== 'string' || typeof handle.token !== 'string')
      throw new Error('Invalid executor recording registration.');
    const timer = setInterval(() => {
      void this.#post('heartbeat', { handle }).catch(() => undefined);
    }, 30_000);
    timer.unref();
    this.#runs.set(context.requestId, { handle, correlationId, timer });
  }
  handle(correlationId: string | undefined): RunEvidenceHandle | undefined {
    return [...this.#runs.values()].find((run) => run.correlationId === correlationId)?.handle;
  }
  async childFailed(correlationId: string | undefined): Promise<void> {
    const handle = this.handle(correlationId);
    if (handle) await this.#post('child-incomplete', { handle }).catch(() => undefined);
  }
  async settled(input: Parameters<NonNullable<AppExecutorHostOptions['onRunSettled']>>[0]): Promise<void> {
    const entry = this.#runs.get(input.requestId);
    if (!entry) return;
    this.#runs.delete(input.requestId);
    clearInterval(entry.timer);
    try {
      await this.#post('outcome', {
        handle: entry.handle,
        outcome: { state: input.state, durationMs: input.durationMs, cost: input.cost },
      });
    } catch (error) {
      if ((await this.#post('read', { handle: entry.handle })).state !== input.state) throw error;
    }
  }
}
