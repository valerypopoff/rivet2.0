import { useStore } from 'jotai';
import type { GraphId, Project, ProjectId } from '@valerypopoff/rivet2-core';
import {
  comparisonReferenceGraphState,
  projectCompareReferenceState,
  viewingProjectComparisonNodeState,
} from '../../state/projectComparison.js';
import { projectState, projectsState } from '../../state/savedGraphs.js';
import { graphState, isReadOnlyGraphState } from '../../state/graph.js';
import { setProjectWorkspaceTargetState } from '../../state/workspaceTarget.js';
import { useWorkspaceTransitions } from '../useWorkspaceTransitions.js';
import { useStableCallback } from '../useStableCallback.js';
import type { RivetProjectCompareOptions, RivetProjectCompareState } from './types.js';
import { getProjectActivationRevision, subscribeProjectActivation } from '../../utils/projectActivationCoordinator.js';
import { isComparisonInspectionProject } from '../../utils/projectComparisonDocument.js';
import { nanoid } from 'nanoid';

export function useWorkspaceHostCompare() {
  const store = useStore();
  const transitions = useWorkspaceTransitions();
  const leaveReferenceView = () => {
    const view = store.get(comparisonReferenceGraphState);
    if (
      view &&
      view.reference.projectId === store.get(projectState).metadata.id &&
      store.get(graphState).metadata?.id === view.graphId
    ) {
      const project = store.get(projectState);
      const graph = (view.returnGraphId && project.graphs[view.returnGraphId]) || Object.values(project.graphs)[0];
      transitions.switchGraph(
        graph ?? {
          metadata: { id: 'empty-comparison-return' as GraphId, name: 'Empty project' },
          nodes: [],
          connections: [],
        },
        { pushHistory: false },
      );
    }
    store.set(comparisonReferenceGraphState, undefined);
  };
  const startProjectCompare = useStableCallback(
    async (referenceProject: Project, referencePath?: string | null, options?: RivetProjectCompareOptions) => {
      const projectId = store.get(projectState).metadata.id;
      if (!projectId || (options?.expectedProjectId && options.expectedProjectId !== projectId)) return false;
      leaveReferenceView();
      store.set(viewingProjectComparisonNodeState, undefined);
      store.set(projectCompareReferenceState, {
        referenceId: nanoid(),
        projectId,
        referencePath: referencePath ?? undefined,
        referenceProject,
        labels: options?.labels,
        identity: options?.identity,
        owner: options?.owner,
        referencedProjects: options?.referencedProjects,
      });
      if (isComparisonInspectionProject(projectId)) {
        const graphId = store.get(graphState).metadata?.id ?? ('empty-inspection' as GraphId);
        store.set(setProjectWorkspaceTargetState, { projectId, target: { type: 'comparisonReference', graphId } });
        store.set(isReadOnlyGraphState, true);
      }
      return true;
    },
  );
  const stopProjectCompare = useStableCallback(
    async (projectId?: ProjectId, owner?: { sessionId: string; generation: number }) => {
      const reference = store.get(projectCompareReferenceState);
      if (
        !reference ||
        (projectId && reference.projectId !== projectId) ||
        (owner && (reference.owner?.sessionId !== owner.sessionId || reference.owner.generation !== owner.generation))
      )
        return false;
      leaveReferenceView();
      store.set(viewingProjectComparisonNodeState, undefined);
      store.set(projectCompareReferenceState, undefined);
      return true;
    },
  );
  const getProjectCompareState = useStableCallback((): RivetProjectCompareState => {
    const reference = store.get(projectCompareReferenceState);
    const current = store.get(projectState).metadata.id;
    return {
      owner: reference?.owner ?? null,
      projectId: store.get(projectsState).openedProjects[current] ? current : null,
      referenceProjectId: reference?.projectId ?? null,
      referenceId: reference?.referenceId ?? null,
      graphId: store.get(graphState).metadata?.id ?? null,
      activationRevision: getProjectActivationRevision(store),
    };
  });
  const subscribeProjectCompare = useStableCallback((listener: () => void) => {
    const disposals = [
      store.sub(projectCompareReferenceState, listener),
      store.sub(projectState, listener),
      store.sub(projectsState, listener),
      store.sub(graphState, listener),
      subscribeProjectActivation(store, listener),
    ];
    return () => disposals.forEach((dispose) => dispose());
  });
  const updateProjectCompareDefinitions = useStableCallback(
    (owner: { sessionId: string; generation: number }, definitions: Record<ProjectId, Project>) => {
      const reference = store.get(projectCompareReferenceState);
      if (
        !reference ||
        reference.owner?.sessionId !== owner.sessionId ||
        reference.owner.generation !== owner.generation ||
        reference.projectId !== store.get(projectState).metadata.id
      )
        return false;
      const view = store.get(comparisonReferenceGraphState);
      const inspection = store.get(viewingProjectComparisonNodeState);
      const next = { ...reference, referencedProjects: definitions };
      store.set(projectCompareReferenceState, next);
      if (view?.reference === reference) store.set(comparisonReferenceGraphState, { ...view, reference: next });
      if (inspection)
        store.set(viewingProjectComparisonNodeState, {
          graphId: inspection.graphId,
          nodeId: inspection.nodeId,
          reference: next,
        });
      return true;
    },
  );
  const inspectComparisonGraph = useStableCallback((graphId: GraphId) => {
    const reference = store.get(projectCompareReferenceState);
    const current = store.get(projectState);
    const before = reference?.referenceProject.graphs[graphId];
    if (!reference || reference.projectId !== current.metadata.id || !before || current.graphs[graphId]) return false;
    const previous = store.get(comparisonReferenceGraphState);
    const currentGraphId = store.get(graphState).metadata?.id;
    const returnGraphId =
      previous?.reference === reference && currentGraphId === previous.graphId
        ? previous.returnGraphId
        : currentGraphId;
    const placeholder = { metadata: { ...before.metadata }, nodes: [], connections: [], comparisonReferenceView: true };
    transitions.switchGraph(placeholder, { pushHistory: false });
    store.set(comparisonReferenceGraphState, { reference, graphId, returnGraphId });
    store.set(setProjectWorkspaceTargetState, {
      projectId: current.metadata.id,
      target: { type: 'comparisonReference', graphId },
    });
    store.set(isReadOnlyGraphState, true);
    return true;
  });
  return {
    startProjectCompare,
    stopProjectCompare,
    getProjectCompareState,
    subscribeProjectCompare,
    updateProjectCompareDefinitions,
    inspectComparisonGraph,
  };
}
