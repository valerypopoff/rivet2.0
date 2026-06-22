import { atom } from 'jotai';
import {
  compareProjects,
  type Project,
  type ProjectComparison,
  type ProjectGraphComparison,
  type ProjectId,
  type NodeId,
  type GraphId,
} from '@valerypopoff/rivet2-core';
import { graphMetadataState, graphState } from './graph.js';
import { projectState } from './savedGraphs.js';

export type ProjectCompareReference = {
  projectId: ProjectId;
  referenceProject: Project;
  referencePath?: string;
  labels?: ProjectCompareSideLabels;
};

export type ActiveProjectComparison = ProjectCompareReference & {
  comparison: ProjectComparison;
};

export type ProjectCompareSideLabels = {
  referenceLabel?: string;
  currentLabel?: string;
};

export type ResolvedProjectCompareSideLabels = {
  referenceLabel: string;
  currentLabel: string;
};

const DEFAULT_PROJECT_COMPARE_SIDE_LABELS: ResolvedProjectCompareSideLabels = {
  referenceLabel: 'Previous',
  currentLabel: 'Current',
};

function normalizeProjectCompareSideLabel(label: string | undefined): string | undefined {
  const trimmedLabel = label?.trim();
  return trimmedLabel && trimmedLabel.length > 0 ? trimmedLabel : undefined;
}

export function resolveProjectCompareSideLabels(
  labels: ProjectCompareSideLabels | undefined,
): ResolvedProjectCompareSideLabels {
  return {
    referenceLabel:
      normalizeProjectCompareSideLabel(labels?.referenceLabel) ?? DEFAULT_PROJECT_COMPARE_SIDE_LABELS.referenceLabel,
    currentLabel:
      normalizeProjectCompareSideLabel(labels?.currentLabel) ?? DEFAULT_PROJECT_COMPARE_SIDE_LABELS.currentLabel,
  };
}

export const projectCompareReferenceState = atom<ProjectCompareReference | undefined>(undefined);

export const viewingProjectComparisonNodeState = atom<{ graphId: GraphId; nodeId: NodeId } | undefined>(undefined);

export const activeProjectComparisonState = atom<ActiveProjectComparison | undefined>((get) => {
  const project = get(projectState);
  const graph = get(graphState);
  const reference = get(projectCompareReferenceState);

  if (!reference || reference.projectId !== project.metadata.id) {
    return undefined;
  }

  const graphId = graph.metadata?.id;
  const liveProject = graphId
    ? {
        ...project,
        graphs: {
          ...project.graphs,
          [graphId]: graph,
        },
      }
    : project;

  return {
    ...reference,
    comparison: compareProjects(reference.referenceProject, liveProject as Project),
  };
});

export const selectedGraphProjectComparisonState = atom<ProjectGraphComparison | undefined>((get) => {
  const comparison = get(activeProjectComparisonState)?.comparison;
  const graphId = get(graphMetadataState)?.id;

  return graphId ? comparison?.graphs[graphId] : undefined;
});
