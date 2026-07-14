import type { GraphOutputs, GraphProgress, RemoteRunRequestId } from '@valerypopoff/rivet2-core';

type PendingExecution = {
  promise: Promise<GraphOutputs>;
  reject: (reason?: unknown) => void;
  resolve: (value: GraphOutputs) => void;
  onProgress?: (progress: GraphProgress) => void;
};

export type PendingGraphExecution = {
  promise: Promise<GraphOutputs>;
  requestId: RemoteRunRequestId;
};

export function createExecutorSessionPendingExecutions() {
  let pendingRequestCounter = 0;
  const pendingExecutions = new Map<RemoteRunRequestId, PendingExecution>();

  function createRemoteExecutionRequest(): RemoteRunRequestId {
    pendingRequestCounter += 1;
    return `remote-run-${pendingRequestCounter}` as RemoteRunRequestId;
  }

  function createPendingGraphExecution(
    requestId = createRemoteExecutionRequest(),
    onProgress?: (progress: GraphProgress) => void,
  ): PendingGraphExecution {
    rejectPendingExecution(requestId, new Error('graph execution replaced by a newer request'));

    let resolve!: (value: GraphOutputs) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<GraphOutputs>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    pendingExecutions.set(requestId, { promise, reject, resolve, onProgress });
    return { promise, requestId };
  }

  function resolvePendingGraphExecution(requestId: RemoteRunRequestId | undefined, outputs: GraphOutputs): void {
    const resolvedRequestId = resolveSinglePendingRequestId(requestId);
    if (!resolvedRequestId) {
      return;
    }

    const pendingExecution = pendingExecutions.get(resolvedRequestId);
    pendingExecution?.resolve(outputs);
    pendingExecutions.delete(resolvedRequestId);
  }

  function rejectPendingGraphExecution(requestId: RemoteRunRequestId | undefined, reason: unknown): void {
    const resolvedRequestId = resolveSinglePendingRequestId(requestId);
    if (!resolvedRequestId) {
      return;
    }

    rejectPendingExecution(resolvedRequestId, reason);
  }

  function rejectAllPendingGraphExecutions(reason: unknown): void {
    for (const pendingExecution of pendingExecutions.values()) {
      pendingExecution.reject(reason);
    }

    pendingExecutions.clear();
  }

  function reportPendingGraphProgress(requestId: RemoteRunRequestId | undefined, progress: GraphProgress): void {
    const resolvedRequestId = resolveSinglePendingRequestId(requestId);
    if (resolvedRequestId) {
      pendingExecutions.get(resolvedRequestId)?.onProgress?.(progress);
    }
  }

  function rejectPendingExecution(requestId: RemoteRunRequestId, reason: unknown): void {
    const pendingExecution = pendingExecutions.get(requestId);
    if (!pendingExecution) {
      return;
    }

    pendingExecution.reject(reason);
    pendingExecutions.delete(requestId);
  }

  function resolveSinglePendingRequestId(requestId: RemoteRunRequestId | undefined): RemoteRunRequestId | undefined {
    if (requestId) {
      return requestId;
    }

    if (pendingExecutions.size !== 1) {
      return undefined;
    }

    return pendingExecutions.keys().next().value as RemoteRunRequestId;
  }

  return {
    createPendingGraphExecution,
    createRemoteExecutionRequest,
    rejectAllPendingGraphExecutions,
    rejectPendingGraphExecution,
    reportPendingGraphProgress,
    resolvePendingGraphExecution,
  };
}
