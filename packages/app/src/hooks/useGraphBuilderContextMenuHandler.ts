import { P, match } from 'ts-pattern';
import { useStableCallback } from './useStableCallback';
import {
  type ChartNode,
  type NodeId,
  type GraphId,
  detachNodePrefabInstance,
  getNodePrefabInstancePrefabId,
  isNodePrefabInstanceNode,
  resolveNodePrefabInstance,
} from '@valerypopoff/rivet2-core';
import { type ContextMenuContext } from '../components/ContextMenu';
import { createRootGraphViewContext } from '../domain/graphEditing/navigationActions.js';
import { editingNodeState } from '../state/graphBuilder';
import { projectState } from '../state/savedGraphs';
import { useCanvasPositioning } from './useCanvasPositioning';
import { useFactorIntoSubgraph } from './useFactorIntoSubgraph';
import { useLoadGraph } from './useLoadGraph';
import { usePasteNodes } from './usePasteNodes';
import { graphMetadataState, nodesByIdState } from '../state/graph';
import { useCopyNodes } from './useCopyNodes';
import { useDuplicateNode } from './useDuplicateNode';
import { useAtomValue, useSetAtom } from 'jotai';
import { useAddNodeCommand } from '../commands/addNodeCommand';
import { useDeleteNodesCommand } from '../commands/deleteNodeCommand';
import { useEditNodeCommand } from '../commands/editNodeCommand';
import { copyToClipboard } from '../utils/copyToClipboard';
import { useGoToSubgraphNode } from './useGoToSubgraphNode.js';
import { useFrozenNodeOutputActions } from './useFrozenNodeOutputActions.js';
import { subGraphPortRearrangeTargetState, variadicPortRearrangeTargetState } from '../state/ui.js';
import { useOpenNodeLibrary } from './useOpenNodeLibrary.js';
import type { EditorGraphRun } from './editorGraphRunOptions.js';

type NodeFreezeTarget = {
  nodeId: NodeId;
  nodeType: ChartNode['type'];
};

export function useGraphBuilderContextMenuHandler(runGraph: EditorGraphRun) {
  const { clientToCanvasPosition } = useCanvasPositioning();
  const loadGraph = useLoadGraph();
  const project = useAtomValue(projectState);
  const pasteNodes = usePasteNodes();
  const copyNodes = useCopyNodes();
  const duplicateNode = useDuplicateNode();
  const factorIntoSubgraph = useFactorIntoSubgraph();
  const setEditingNodeId = useSetAtom(editingNodeState);
  const nodesById = useAtomValue(nodesByIdState);
  const graphId = useAtomValue(graphMetadataState)?.id;
  const removeNodes = useDeleteNodesCommand();
  const editNode = useEditNodeCommand();
  const goToSubgraphNode = useGoToSubgraphNode();
  const { freezeNode, unfreezeNode } = useFrozenNodeOutputActions();
  const setSubGraphPortRearrangeTarget = useSetAtom(subGraphPortRearrangeTargetState);
  const setVariadicPortRearrangeTarget = useSetAtom(variadicPortRearrangeTargetState);
  const openNodeLibrary = useOpenNodeLibrary();

  const addNode = useAddNodeCommand();
  const openLinkedNodeLibraryNode = useStableCallback((node: ChartNode | undefined) => {
    if (!node || !isNodePrefabInstanceNode(node)) {
      return false;
    }

    const prefabId = getNodePrefabInstancePrefabId(node);
    const sourceNodeId = prefabId ? project.nodePrefabs?.[prefabId]?.sourceNode.id : undefined;
    openNodeLibrary({
      editingPrefabId: prefabId,
      selectedNodeIds: sourceNodeId ? [sourceNodeId] : [],
    });
    return true;
  });

  return useStableCallback(
    (menuItemId: string, data: unknown, context: ContextMenuContext, meta: { x: number; y: number }) => {
      match(menuItemId)
        .with(P.string.startsWith('add-node:'), () => {
          const nodeType = data as string;
          addNode({
            nodeType,
            position: clientToCanvasPosition(meta.x, meta.y),
          });
        })
        .with('node-delete', () => {
          const { nodeId: toDeleteNodeId } = context.data as { nodeId: NodeId };
          removeNodes({ nodeIds: [toDeleteNodeId] });
        })
        .with('paste', () => {
          pasteNodes(meta);
        })
        .with('node-edit', () => {
          const { nodeId } = context.data as { nodeId: NodeId };
          if (openLinkedNodeLibraryNode(nodesById[nodeId])) {
            return;
          }

          setEditingNodeId(nodeId);
        })
        .with('node-open-prefab-source', () => {
          const { nodeId } = context.data as { nodeId: NodeId };
          openLinkedNodeLibraryNode(nodesById[nodeId]);
        })
        .with('node-detach-prefab', () => {
          const { nodeId } = context.data as { nodeId: NodeId };
          const linkedNode = nodesById[nodeId];
          const detachedNode = linkedNode ? detachNodePrefabInstance(project, linkedNode) : undefined;

          if (!detachedNode) {
            return;
          }

          editNode({ nodeId, newNode: detachedNode, mergeWithPrevious: false });
        })
        .with('node-rearrange-subgraph-ports', () => {
          const { nodeId } = context.data as { nodeId: NodeId };
          if (graphId) {
            setVariadicPortRearrangeTarget(undefined);
            setSubGraphPortRearrangeTarget({ graphId, nodeId, projectId: project.metadata.id });
          }
        })
        .with(P.union('node-rearrange-variadic-inputs', 'node-rearrange-variadic-inputs-outputs'), () => {
          const { nodeId } = context.data as { nodeId: NodeId };
          if (graphId) {
            setSubGraphPortRearrangeTarget(undefined);
            setVariadicPortRearrangeTarget({ graphId, nodeId, projectId: project.metadata.id });
          }
        })
        .with('node-duplicate', () => {
          const { nodeId } = context.data as { nodeId: NodeId };
          duplicateNode(nodeId);
        })
        .with('nodes-factor-into-subgraph', () => {
          factorIntoSubgraph();
        })
        .with('node-go-to-subgraph', () => {
          const { nodeId } = context.data as { nodeId: NodeId };
          const node = nodesById[nodeId];
          goToSubgraphNode(node ? resolveNodePrefabInstance(project, node) : undefined);
        })
        .with(P.string.startsWith('go-to-graph:'), () => {
          const graphId = data as GraphId;
          const graph = project.graphs[graphId];
          if (graph) {
            loadGraph(graph, { graphView: createRootGraphViewContext(graphId) });
          }
        })
        .with('node-run-to-here', () => {
          const { nodeId } = context.data as { nodeId: NodeId };

          runGraph({ to: [nodeId] });
        })
        .with('node-run-from-here', () => {
          const { nodeId } = context.data as { nodeId: NodeId };

          runGraph({ from: nodeId });
        })
        .with(P.union('node-freeze', 'nodes-freeze'), () => {
          const { nodeId, nodeType, freezeNodeTargets } = context.data as {
            nodeId: NodeId;
            nodeType: ChartNode['type'];
            freezeNodeTargets?: NodeFreezeTarget[];
          };
          const targets = freezeNodeTargets?.length ? freezeNodeTargets : [{ nodeId, nodeType }];
          if (graphId) {
            for (const target of targets) {
              freezeNode(graphId, target.nodeId, target.nodeType);
            }
          }
        })
        .with(P.union('node-unfreeze', 'nodes-unfreeze'), () => {
          const { nodeId, unfreezeNodeIds } = context.data as { nodeId: NodeId; unfreezeNodeIds?: NodeId[] };
          const nodeIds = unfreezeNodeIds?.length ? unfreezeNodeIds : [nodeId];
          if (graphId) {
            for (const nodeIdToUnfreeze of nodeIds) {
              unfreezeNode(graphId, nodeIdToUnfreeze);
            }
          }
        })
        .with('node-copy', () => {
          const { nodeId } = context.data as { nodeId: NodeId };
          copyNodes(nodeId);
        })
        .otherwise(() => {
          console.log('Unknown menu item selected', menuItemId);
        });
    },
  );
}
