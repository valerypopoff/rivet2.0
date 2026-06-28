import { type NodeId } from '@valerypopoff/rivet2-core';
import { connectionsForSingleNodeState } from './selectors/graphSelectors';
import { ioDefinitionsForNodeState } from './selectors/ioDefinitions';
import { nodeByIdState, nodeInstanceByIdState } from './selectors/nodeSelectors';
import { removeExecutionNodeStateFamilies } from './dataFlow';
import { removeGraphBuilderNodeStateFamilies } from './graphBuilder';

export {
  connectionsState,
  graphMetadataState,
  graphState,
  historicalChangedNodesState,
  historicalGraphState,
  isReadOnlyGraphState,
  nodesState,
} from './atoms/graph';
export {
  connectionsForNodeState,
  nodesByIdState,
  nodesForConnectionState,
} from './selectors/graphSelectors';
export { connectionsForSingleNodeState } from './selectors/graphSelectors';
export { ioDefinitionsForNodeState } from './selectors/ioDefinitions';
export {
  effectiveNodeByIdState,
  effectiveNodesByIdState,
  nodeByIdState,
  nodeConstructorsState,
  nodeInstanceByIdState,
  nodeInstancesState,
} from './selectors/nodeSelectors';

export function removeGraphNodeStateFamilies(nodeId: NodeId): void {
  connectionsForSingleNodeState.remove(nodeId);
  nodeByIdState.remove(nodeId);
  nodeInstanceByIdState.remove(nodeId);
  ioDefinitionsForNodeState.remove(nodeId);
}

/** Clean up all node-keyed atomFamily entries for a set of nodes (e.g., when switching graphs). */
export function cleanupNodeAtomFamilies(nodeIds: NodeId[]): void {
  for (const nodeId of nodeIds) {
    removeGraphNodeStateFamilies(nodeId);
    removeExecutionNodeStateFamilies(nodeId);
    removeGraphBuilderNodeStateFamilies(nodeId);
  }
}
