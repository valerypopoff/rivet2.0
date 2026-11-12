import { useAtomValue } from 'jotai';
import { currentGraphViewState } from '../state/dataFlow.js';
import { graphState } from '../state/graph.js';
import { projectState } from '../state/savedGraphs.js';
import { projectWorkspaceTargetsState } from '../state/workspaceTarget.js';
import { getFallbackGraphView, isProjectWorkspaceTargetValid } from '../domain/workspace/projectWorkspaceTarget.js';
import { projectCompareReferenceState } from '../state/projectComparison.js';
import { isComparisonInspectionProject } from '../utils/projectComparisonDocument.js';

export function useProjectWorkspaceTarget() {
  const project = useAtomValue(projectState);
  const graph = useAtomValue(graphState);
  const currentGraphView = useAtomValue(currentGraphViewState);
  const targets = useAtomValue(projectWorkspaceTargetsState);
  const comparison = useAtomValue(projectCompareReferenceState);
  const storedTarget = targets[project.metadata.id];

  if (
    storedTarget?.type === 'comparisonReference' &&
    comparison?.projectId === project.metadata.id &&
    graph.metadata?.id === storedTarget.graphId &&
    (comparison.referenceProject.graphs[storedTarget.graphId] || isComparisonInspectionProject(project.metadata.id))
  )
    return storedTarget;

  if (storedTarget && isProjectWorkspaceTargetValid(storedTarget, project)) {
    return storedTarget;
  }

  const currentGraphTarget =
    currentGraphView && isProjectWorkspaceTargetValid({ graphView: currentGraphView, type: 'graph' }, project)
      ? currentGraphView
      : undefined;
  const graphId = currentGraphTarget?.graphId ?? graph.metadata?.id;
  return graphId
    ? { graphView: currentGraphTarget ?? getFallbackGraphView(graphId), type: 'graph' as const }
    : undefined;
}
