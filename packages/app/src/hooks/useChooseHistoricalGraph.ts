import { type GraphId, type NodeGraph } from '@valerypopoff/rivet2-core';
import { type CalculatedRevision } from '../utils/ProjectRevisionCalculator';
import { useSetAtom } from 'jotai';
import { graphState, historicalGraphState, isReadOnlyGraphState } from '../state/graph';
import { useClearGraphHistory } from '../commands/Command.js';
import { nodeEditorSessionRevisionState } from '../state/graphBuilder.js';

export function useChooseHistoricalGraph(revision: CalculatedRevision) {
  const setGraph = useSetAtom(graphState);
  const setIsReadOnlyGraph = useSetAtom(isReadOnlyGraphState);
  const setHistoricalGraph = useSetAtom(historicalGraphState);
  const clearGraphHistory = useClearGraphHistory();
  const retireEditors = useSetAtom(nodeEditorSessionRevisionState);

  return (graphId: GraphId) => {
    const nodesBefore = revision.projectAtRevision!.graphs[graphId]?.nodes ?? [];
    const nodesAfter = revision.projectAtRevision!.graphs[graphId]?.nodes!;

    const nodesDeleted = nodesAfter?.filter((node) => !nodesBefore?.some((n) => n.id === node.id));

    const combinedGraph: NodeGraph = {
      ...revision.projectAtRevision!.graphs[graphId]!,
      nodes: [...nodesAfter, ...nodesDeleted],
    };

    clearGraphHistory(graphId);
    retireEditors((revision) => revision + 1);
    setGraph(combinedGraph);
    setIsReadOnlyGraph(true);
    setHistoricalGraph(revision);
  };
}
