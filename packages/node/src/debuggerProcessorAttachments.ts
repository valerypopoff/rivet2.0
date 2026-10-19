import type { GraphProcessor, GraphExecutionMetadata, RemoteRunRequestId } from '@valerypopoff/rivet2-core';

export type DebuggerProcessorBroadcast = (
  processor: GraphProcessor,
  message: string,
  data: unknown,
  requestId?: RemoteRunRequestId,
) => void;

export type DebuggerProcessorAttachments = {
  attach(processor: GraphProcessor, requestId?: RemoteRunRequestId): void;
  detach(processor: GraphProcessor): void;
  getAttachedProcessors(): GraphProcessor[];
  getRequestId(processor: GraphProcessor): RemoteRunRequestId | undefined;
};

export function createDebuggerProcessorAttachments(options: {
  broadcast: DebuggerProcessorBroadcast;
  emitError: (error: unknown) => void;
  throttlePartialOutputs: number;
}): DebuggerProcessorAttachments {
  const attachedProcessors: GraphProcessor[] = [];
  const requestIdsByProcessorId = new Map<string, RemoteRunRequestId | undefined>();
  const processorEventCleanupsByProcessorId = new Map<string, Array<() => void>>();

  const attachments: DebuggerProcessorAttachments = {
    attach(processor, requestId) {
      if (attachedProcessors.find((p) => p.id === processor.id)) {
        return;
      }

      const partialTimes = new Map<string, number>();
      let rootExecution: GraphExecutionMetadata | undefined;
      const invocationKey = (data: { node: { id: string }; processId: string; execution?: GraphExecutionMetadata }) =>
        JSON.stringify([
          data.execution?.rootRunId,
          data.execution?.graphRunId,
          data.execution?.projectId,
          data.node.id,
          data.processId,
        ]);
      const identity = () => (rootExecution ? { execution: rootExecution } : {});
      const cleanups: Array<() => void> = [];
      attachedProcessors.push(processor);
      requestIdsByProcessorId.set(processor.id, requestId);
      processorEventCleanupsByProcessorId.set(processor.id, cleanups);

      cleanups.push(
        processor.on('nodeStart', (data) => {
          options.broadcast(processor, 'nodeStart', data);
        }),
      );
      cleanups.push(
        processor.on('nodeFinish', (data) => {
          partialTimes.delete(invocationKey(data));
          options.broadcast(processor, 'nodeFinish', data);
        }),
      );
      cleanups.push(
        processor.on('nodeError', ({ error, ...data }) => {
          partialTimes.delete(invocationKey(data));
          // Deferred Watch history carries its original occurrence clock.
          // Normalize only Error; preserve the rest of the event envelope.
          options.broadcast(processor, 'nodeError', {
            ...data,
            error: typeof error === 'string' ? error : error.toString(),
          });
        }),
      );
      cleanups.push(
        processor.on('error', ({ error }) => {
          options.broadcast(processor, 'error', {
            ...identity(),
            error: typeof error === 'string' ? error : error.toString(),
          });
          rootExecution = undefined;
          partialTimes.clear();
        }),
      );
      cleanups.push(
        processor.on('graphError', ({ graph, error, execution }) => {
          // A reused processor can fail preflight before its next start event.
          // The exact graph terminal is the authority for that new root.
          if (!execution.parentGraphRunId) rootExecution = execution;
          options.broadcast(processor, 'graphError', {
            graph,
            error: typeof error === 'string' ? error : error.toString(),
            execution,
          });
        }),
      );
      cleanups.push(
        processor.on('nodeExcluded', (data) => {
          partialTimes.delete(invocationKey(data));
          options.broadcast(processor, 'nodeExcluded', data);
        }),
      );
      cleanups.push(
        processor.on('start', (data) => {
          rootExecution = data.execution;
          partialTimes.clear();
          options.broadcast(processor, 'start', data);
        }),
      );
      cleanups.push(
        processor.on('done', (data) => {
          options.broadcast(processor, 'done', { ...data, ...identity() });
          rootExecution = undefined;
          partialTimes.clear();
        }),
      );
      cleanups.push(
        processor.on('partialOutput', (data) => {
          // Throttle the partial outputs because they can get ridiculous on the serdes side
          const key = invocationKey(data);
          if (partialTimes.get(key) == null || partialTimes.get(key)! + options.throttlePartialOutputs < Date.now()) {
            options.broadcast(processor, 'partialOutput', data);
            partialTimes.set(key, Date.now());
          }
        }),
      );
      cleanups.push(
        processor.on('progress', (data) => {
          options.broadcast(processor, 'progress', data);
        }),
      );
      cleanups.push(
        processor.on('llmCallFinished', (data) => {
          options.broadcast(processor, 'llmCallFinished', data);
        }),
      );
      cleanups.push(
        processor.on('llmChatOutputSnapshot', (data) => {
          // Logical LLM Chat pages are display-only, but remote debugger
          // consumers need the same event stream as in-process execution.
          options.broadcast(processor, 'llmChatOutputSnapshot', data);
        }),
      );
      cleanups.push(
        processor.on('llmProfileAttempt', (data) => {
          options.broadcast(processor, 'llmProfileAttempt', data);
        }),
      );
      cleanups.push(
        processor.on('toolCallFinished', (data) => {
          options.broadcast(processor, 'toolCallFinished', data);
        }),
      );
      cleanups.push(
        processor.on('abort', (data) => {
          // The abort payload distinguishes a successful control-flow abort
          // from an execution failure. Normalize Error exactly as the other
          // debugger terminals do: JSON would otherwise turn it into `{}`.
          options.broadcast(processor, 'abort', {
            ...identity(),
            successful: data.successful,
            ...(data.error === undefined
              ? {}
              : { error: typeof data.error === 'string' ? data.error : data.error.toString() }),
          });
        }),
      );
      cleanups.push(
        processor.on('graphAbort', (data) => {
          options.broadcast(processor, 'graphAbort', data);
        }),
      );
      cleanups.push(
        processor.on('trace', (message) => {
          options.broadcast(processor, 'trace', message);
        }),
      );
      cleanups.push(
        processor.on('nodeOutputsCleared', (data) => {
          options.broadcast(processor, 'nodeOutputsCleared', data);
        }),
      );
      cleanups.push(
        processor.on('streamingOutputWatchSummary', (data) => {
          options.broadcast(processor, 'streamingOutputWatchSummary', data);
        }),
      );
      cleanups.push(
        processor.on('graphStart', (data) => {
          options.broadcast(processor, 'graphStart', data);
        }),
      );
      cleanups.push(
        processor.on('graphFinish', (data) => {
          options.broadcast(processor, 'graphFinish', data);
        }),
      );
      cleanups.push(
        processor.on('graphOutputsReady', (data) => {
          options.broadcast(processor, 'graphOutputsReady', data);
        }),
      );
      cleanups.push(
        processor.on('pause', () => {
          options.broadcast(processor, 'pause', rootExecution ? identity() : null);
        }),
      );
      cleanups.push(
        processor.on('resume', () => {
          options.broadcast(processor, 'resume', rootExecution ? identity() : null);
        }),
      );
      cleanups.push(
        processor.on('userInput', (data) => {
          options.broadcast(processor, 'userInput', data);
        }),
      );
      cleanups.push(
        processor.on('finish', () => {
          attachments.detach(processor);
        }),
      );
    },

    detach(processor) {
      const cleanups = processorEventCleanupsByProcessorId.get(processor.id);
      processorEventCleanupsByProcessorId.delete(processor.id);

      for (const cleanup of cleanups ?? []) {
        try {
          cleanup();
        } catch (err) {
          options.emitError(err);
        }
      }

      const processorIndex = attachedProcessors.findIndex((p) => p.id === processor.id);
      if (processorIndex !== -1) {
        attachedProcessors.splice(processorIndex, 1);
      }
      requestIdsByProcessorId.delete(processor.id);
    },

    getAttachedProcessors() {
      return [...attachedProcessors];
    },

    getRequestId(processor) {
      return requestIdsByProcessorId.get(processor.id);
    },
  };

  return attachments;
}
