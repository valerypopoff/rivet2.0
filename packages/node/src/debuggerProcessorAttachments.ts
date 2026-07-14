import type { GraphProcessor, NodeId, RemoteRunRequestId } from '@valerypopoff/rivet2-core';

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

      const lastPartialOutputsTimePerNode: Record<NodeId, number> = {};
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
          options.broadcast(processor, 'nodeFinish', data);
        }),
      );
      cleanups.push(
        processor.on('nodeError', ({ node, error, processId, execution, durationMs, splitRunDurationMs }) => {
          options.broadcast(processor, 'nodeError', {
            node,
            error: typeof error === 'string' ? error : error.toString(),
            processId,
            execution,
            ...(durationMs === undefined ? {} : { durationMs }),
            ...(splitRunDurationMs === undefined ? {} : { splitRunDurationMs }),
          });
        }),
      );
      cleanups.push(
        processor.on('error', ({ error }) => {
          options.broadcast(processor, 'error', {
            error: typeof error === 'string' ? error : error.toString(),
          });
        }),
      );
      cleanups.push(
        processor.on('graphError', ({ graph, error, execution }) => {
          options.broadcast(processor, 'graphError', {
            graph,
            error: typeof error === 'string' ? error : error.toString(),
            execution,
          });
        }),
      );
      cleanups.push(
        processor.on('nodeExcluded', (data) => {
          options.broadcast(processor, 'nodeExcluded', data);
        }),
      );
      cleanups.push(
        processor.on('start', (data) => {
          options.broadcast(processor, 'start', data);
        }),
      );
      cleanups.push(
        processor.on('done', (data) => {
          options.broadcast(processor, 'done', data);
        }),
      );
      cleanups.push(
        processor.on('partialOutput', (data) => {
          // Throttle the partial outputs because they can get ridiculous on the serdes side
          if (
            lastPartialOutputsTimePerNode[data.node.id] == null ||
            (lastPartialOutputsTimePerNode[data.node.id] ?? 0) + options.throttlePartialOutputs < Date.now()
          ) {
            options.broadcast(processor, 'partialOutput', data);
            lastPartialOutputsTimePerNode[data.node.id] = Date.now();
          }
        }),
      );
      cleanups.push(
        processor.on('progress', (data) => {
          options.broadcast(processor, 'progress', data);
        }),
      );
      cleanups.push(
        processor.on('abort', () => {
          options.broadcast(processor, 'abort', null);
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
        processor.on('pause', () => {
          options.broadcast(processor, 'pause', null);
        }),
      );
      cleanups.push(
        processor.on('resume', () => {
          options.broadcast(processor, 'resume', null);
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
