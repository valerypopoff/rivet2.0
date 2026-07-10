import { useAtomValue } from 'jotai';
import { currentGraphViewState } from '../state/dataFlow.js';
import { graphState } from '../state/graph.js';
import { projectState } from '../state/savedGraphs.js';
import { projectWorkspaceTargetsState } from '../state/workspaceTarget.js';
import { getFallbackGraphView } from '../domain/workspace/projectWorkspaceTarget.js';

export function useProjectWorkspaceTarget() {
  const project = useAtomValue(projectState);
  const graph = useAtomValue(graphState);
  const currentGraphView = useAtomValue(currentGraphViewState);
  const targets = useAtomValue(projectWorkspaceTargetsState);
  const storedTarget = targets[project.metadata.id];

  if (storedTarget) {
    return storedTarget;
  }

  const graphId = currentGraphView?.graphId ?? graph.metadata?.id;
  return graphId ? { graphView: currentGraphView ?? getFallbackGraphView(graphId), type: 'graph' as const } : undefined;
}
