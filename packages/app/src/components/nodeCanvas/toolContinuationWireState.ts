import {
  resolveToolContinuationConnections,
  type NodeConnection,
  type NodeGraph,
  type NodeId,
} from '@valerypopoff/rivet2-core';

export type ToolContinuationWireState = {
  delegateNodeId: NodeId;
  kind: 'connected' | 'ambiguous';
};

export function getToolContinuationWireStates(
  graph: Pick<NodeGraph, 'connections' | 'nodes'>,
): ReadonlyMap<NodeConnection, ToolContinuationWireState> {
  const states = new Map<NodeConnection, ToolContinuationWireState>();
  for (const resolution of resolveToolContinuationConnections(graph).values()) {
    if (resolution.kind === 'connected') {
      states.set(resolution.connection, {
        delegateNodeId: resolution.delegateNode.id,
        kind: 'connected',
      });
      continue;
    }

    if (resolution.kind === 'ambiguous') {
      resolution.candidates.forEach(({ connection, delegateNode }) => {
        states.set(connection, { delegateNodeId: delegateNode.id, kind: 'ambiguous' });
      });
    }
  }

  return states;
}
