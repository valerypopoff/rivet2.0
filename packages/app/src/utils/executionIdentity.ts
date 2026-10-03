import { type GraphExecutionMetadata, type GraphId } from '@valerypopoff/rivet2-core';
import {
  createRootGraphViewContext,
  createSubgraphGraphViewContext,
  type GraphViewContext,
  type GraphViewKey,
} from '../domain/graphEditing/navigationActions.js';

/** Live called-project evidence belongs to its own recording, not the caller's
 * canvas. Standalone replay uses that recording's project as the workspace.
 */
export function isLiveCalledProjectExecutionEvent(data: unknown): boolean {
  if (data == null || typeof data !== 'object') return false;
  const event = data as { execution?: GraphExecutionMetadata; replayRecordedAt?: number };
  return event.execution?.projectScope != null && !Number.isFinite(event.replayRecordedAt);
}

export function buildGraphViewContextFromExecution(options: {
  execution?: GraphExecutionMetadata;
  graphIdFallback?: GraphId;
}): GraphViewContext {
  const { execution, graphIdFallback } = options;
  const graphId = execution?.graphId ?? graphIdFallback;

  if (!graphId) {
    throw new Error('Cannot build graph view context without graph execution metadata or a graph id fallback.');
  }

  if (!execution?.executor) {
    return createRootGraphViewContext(graphId);
  }

  return createSubgraphGraphViewContext({
    graphId,
    parentGraphId: execution.executor.parentGraphId,
    parentNodeId: execution.executor.nodeId,
  });
}

export function buildGraphViewKeyFromExecution(options: {
  execution?: GraphExecutionMetadata;
  graphIdFallback?: GraphId;
}): GraphViewKey {
  return buildGraphViewContextFromExecution(options).key;
}
