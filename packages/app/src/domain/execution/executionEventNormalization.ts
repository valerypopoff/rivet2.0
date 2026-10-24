import type { GraphExecutionMetadata, ProcessEventMessageMap } from '@valerypopoff/rivet2-core';

export type ExecutionSourceKind = 'browser' | 'desktop-node' | 'hosted-node' | 'remote-debugger' | 'recording';
export type ExecutionLifecycle = 'event' | 'outputs-ready' | 'abort-requested' | 'display-terminal' | 'settled';
export type ExecutionOrigin = 'live' | 'reconnect' | 'replay' | 'recording';

/** Scope legacy browser terminals to their captured processor, without mutating recorded payloads. */
export function bindExecutionTerminal<T extends object>(data: T, execution: GraphExecutionMetadata | undefined): T {
  return execution && !(data as { execution?: GraphExecutionMetadata }).execution ? { ...data, execution } : data;
}

// Exhaustive on purpose: a new wire event needs an explicit lifecycle review.
const lifecycleByMessage = {
  codeConsole: 'event',
  nodeStart: 'event',
  nodeFinish: 'event',
  nodeError: 'event',
  nodeExcluded: 'event',
  userInput: 'event',
  start: 'event',
  done: 'display-terminal',
  abort: 'abort-requested',
  graphAbort: 'abort-requested',
  graphStart: 'event',
  webAppStoragePatch: 'event',
  graphFinish: 'event',
  graphOutputsReady: 'outputs-ready',
  partialOutput: 'event',
  progress: 'event',
  llmCallFinished: 'event',
  llmChatOutputSnapshot: 'event',
  llmProfileAttempt: 'event',
  toolCallFinished: 'event',
  nodeOutputsCleared: 'event',
  streamingOutputWatchSummary: 'event',
  error: 'display-terminal',
  graphError: 'event',
  trace: 'event',
  pause: 'event',
  resume: 'event',
} satisfies Record<keyof ProcessEventMessageMap, ExecutionLifecycle>;

/** Internal envelope only: no project, recording, or transport format changes. */
export function normalizeExecutionEvent<K extends keyof ProcessEventMessageMap>(options: {
  source: object;
  kind: ExecutionSourceKind;
  sourceProjectId: string;
  bindingToken?: number;
  requestId?: string;
  origin?: ExecutionOrigin;
  message: K;
  data: ProcessEventMessageMap[K];
}) {
  const event = options.data as { execution?: GraphExecutionMetadata; replayRecordedAt?: number } | null;
  const rootGraphTerminal =
    !event?.execution?.parentGraphRunId &&
    event?.execution?.projectId === options.sourceProjectId &&
    (options.message === 'graphFinish' || options.message === 'graphError');
  const lifecycle: ExecutionLifecycle = rootGraphTerminal ? 'display-terminal' : lifecycleByMessage[options.message];
  return {
    ...options,
    origin:
      options.kind === 'recording'
        ? 'recording'
        : Number.isFinite(event?.replayRecordedAt)
          ? 'replay'
          : options.origin ?? 'live',
    execution: event?.execution,
    lifecycle,
    // Neither outputs nor abort/error notices demonstrate processor cleanup.
    settlement: 'unknown' as const,
  };
}
