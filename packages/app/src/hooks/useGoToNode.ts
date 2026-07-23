import {
  canRenderPassthroughAsDataBus,
  type GraphId,
  type NodeId,
  resolveNodePrefabInstance,
} from '@valerypopoff/rivet2-core';
import { createRootGraphViewContext } from '../domain/graphEditing/navigationActions.js';
import { useStableCallback } from './useStableCallback';
import { useLoadGraph } from './useLoadGraph';
import { graphState } from '../state/graph';
import { projectState } from '../state/savedGraphs';
import { canvasPositionState } from '../state/graphBuilder';
import { useAtomValue, useSetAtom } from 'jotai';
import { useCanvasPositioning } from './useCanvasPositioning.js';

type GoToNodeOptions = {
  graphId?: GraphId;
  zoom?: number;
  viewportCenter?: { x: number; y: number };
};

export function useGoToNode() {
  const project = useAtomValue(projectState);
  const currentGraph = useAtomValue(graphState);
  const loadGraph = useLoadGraph();
  const setPosition = useSetAtom(canvasPositionState);
  const { canvasClientOffset } = useCanvasPositioning();

  return useStableCallback((nodeId: NodeId, options?: GoToNodeOptions) => {
    const graphForNode =
      options?.graphId != null
        ? options.graphId === currentGraph.metadata?.id
          ? currentGraph
          : project.graphs[options.graphId]
        : [currentGraph, ...Object.values(project.graphs)].find((graph) => graph.nodes.some((n) => n.id === nodeId));

    if (graphForNode == null || !graphForNode.nodes.some((node) => node.id === nodeId)) {
      return;
    }

    const node = graphForNode.nodes.find((n) => n.id === nodeId)!;

    loadGraph(graphForNode, { graphView: createRootGraphViewContext(graphForNode.metadata!.id!) });

    if (canRenderPassthroughAsDataBus(resolveNodePrefabInstance(project, node))) {
      return;
    }

    const nodeRect = { x: node.visualData.x, y: node.visualData.y, width: node.visualData.width ?? 300, height: 300 };
    const viewportBounds = { width: window.innerWidth, height: window.innerHeight };
    const targetCanvasClientOffset =
      graphForNode.metadata?.id === currentGraph.metadata?.id ? canvasClientOffset : { x: 0, y: 0 };

    const zoom = options?.zoom ?? 1;

    // Place node at the requested viewport point so overlays can reserve visible space.
    const nodeCenter = { x: nodeRect.x + nodeRect.width / 2, y: nodeRect.y + nodeRect.height / 2 };
    const viewportCenter = options?.viewportCenter ?? {
      x: targetCanvasClientOffset.x + (viewportBounds.width - targetCanvasClientOffset.x) / 2,
      y: targetCanvasClientOffset.y + (viewportBounds.height - targetCanvasClientOffset.y) / 2,
    };
    const offset = {
      x: (viewportCenter.x - targetCanvasClientOffset.x) / zoom - nodeCenter.x,
      y: (viewportCenter.y - targetCanvasClientOffset.y) / zoom - nodeCenter.y,
    };

    setPosition({ x: offset.x, y: offset.y, zoom });
  });
}
