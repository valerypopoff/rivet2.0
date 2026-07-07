import type { NodeId } from '@valerypopoff/rivet2-core';
import type { PageValue, ProcessDataForNode } from '../../state/dataFlow.js';
import { resolveCanvasExecutionProcessPage } from '../../state/selectors/executionSelectors.js';
import type { DragMode } from './nodeDragInteraction.js';

type DraggingExecutionSourceOptions = {
  dragMode: DragMode;
  draggingNodeId: NodeId;
  draggingSourceNodeIds: NodeId[];
  index: number;
};

type DraggingExecutionContextOptions = DraggingExecutionSourceOptions & {
  expandedOutputNodeIdSet: ReadonlySet<NodeId>;
  lastRunPerNode: Record<NodeId, ProcessDataForNode[] | undefined>;
  selectedProcessPagePerNode: Record<NodeId, PageValue>;
};

export function resolveDraggingExecutionSourceNodeId(options: DraggingExecutionSourceOptions): NodeId {
  const { dragMode, draggingNodeId, draggingSourceNodeIds, index } = options;

  if (dragMode === 'move') {
    return draggingNodeId;
  }

  return draggingSourceNodeIds[index] ?? draggingNodeId;
}

export function resolveDraggingExecutionContext(options: DraggingExecutionContextOptions): {
  executionSourceNodeId: NodeId;
  isOutputExpanded: boolean;
  lastRun?: ProcessDataForNode[];
  processPage: PageValue;
} {
  const { expandedOutputNodeIdSet, lastRunPerNode, selectedProcessPagePerNode } = options;
  const executionSourceNodeId = resolveDraggingExecutionSourceNodeId(options);

  return {
    executionSourceNodeId,
    isOutputExpanded: expandedOutputNodeIdSet.has(executionSourceNodeId),
    lastRun: lastRunPerNode[executionSourceNodeId],
    processPage: resolveCanvasExecutionProcessPage(selectedProcessPagePerNode[executionSourceNodeId]),
  };
}
