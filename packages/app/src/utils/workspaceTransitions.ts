import { produce } from 'immer';
import {
  type DataId,
  type GraphId,
  type NodeGraph,
  type NodeId,
  type Project,
  emptyNodeGraph,
  reconcileProjectUiGraphButtonBindings,
} from '@valerypopoff/rivet2-core';
import {
  createRootGraphViewContext,
  type GraphNavigationStack,
  type GraphViewContext,
} from '../domain/graphEditing/navigationActions.js';
import type { TrivetState } from '../state/trivet.js';
import type { CanvasPosition } from '../state/graphBuilder.js';
import type { OpenedProjectInfo } from '../state/savedGraphs.js';
import { prepareCurrentGraphForSave } from './currentGraphSave.js';

export type WorkspaceTransitionType =
  | 'load-project'
  | 'switch-graph'
  | 'save-project'
  | 'save-current-graph-into-project'
  | 'close-project';

export type ProjectLoadTransition = {
  cleanupNodeIds: NodeId[];
  graph: NodeGraph;
  loadedProject: { loaded: boolean; path: string | null };
  navigationStack: GraphNavigationStack;
  project: Omit<Project, 'data'>;
  resetHistoricalGraph: true;
  resetReadOnlyGraph: true;
  viewport: GraphSwitchViewportStrategy;
};

export type GraphSwitchViewportStrategy =
  | { type: 'saved'; position: CanvasPosition }
  | { type: 'center' }
  | { type: 'reset' };

export type GraphSwitchTransition = {
  cleanupNodeIds: NodeId[];
  graph: NodeGraph;
  navigationStack?: GraphNavigationStack;
  resetHistoricalGraph: true;
  resetReadOnlyGraph: true;
  selectedNodes: [];
  viewport: GraphSwitchViewportStrategy;
};

export function createDefaultTrivetState(testSuites: TrivetState['testSuites'] = []): TrivetState {
  return {
    testSuites,
    selectedTestSuiteId: undefined,
    editingTestCaseId: undefined,
    recentTestResults: undefined,
    runningTests: false,
  };
}

export function chooseProjectGraph(
  project: Omit<Project, 'data'>,
  options: { openedGraphId?: GraphId; fallbackToMainGraph?: boolean; fallbackToSortedProjectGraph?: boolean } = {},
): NodeGraph {
  const { openedGraphId, fallbackToMainGraph = false, fallbackToSortedProjectGraph = false } = options;

  if (openedGraphId && project.graphs[openedGraphId]) {
    return project.graphs[openedGraphId]!;
  }

  if (fallbackToMainGraph && project.metadata.mainGraphId && project.graphs[project.metadata.mainGraphId]) {
    return project.graphs[project.metadata.mainGraphId]!;
  }

  if (fallbackToSortedProjectGraph) {
    return (
      Object.values(project.graphs).sort((a, b) => (a.metadata?.name ?? '').localeCompare(b.metadata?.name ?? ''))[0] ??
      emptyNodeGraph()
    );
  }

  return emptyNodeGraph();
}

export function resolveProjectGraphForLoad(
  project: Omit<Project, 'data'>,
  options: {
    graphToLoad?: NodeGraph;
    openedGraphId?: GraphId;
  } = {},
): NodeGraph {
  const explicitGraphId = options.graphToLoad?.metadata?.id;

  if (explicitGraphId && project.graphs[explicitGraphId]) {
    return project.graphs[explicitGraphId]!;
  }

  if (options.openedGraphId && project.graphs[options.openedGraphId]) {
    return project.graphs[options.openedGraphId]!;
  }

  if (project.metadata.mainGraphId && project.graphs[project.metadata.mainGraphId]) {
    return project.graphs[project.metadata.mainGraphId]!;
  }

  const firstSortedGraph = Object.values(project.graphs).sort((a, b) =>
    (a.metadata?.name ?? '').localeCompare(b.metadata?.name ?? ''),
  )[0];

  return firstSortedGraph ?? emptyNodeGraph();
}

export function createProjectLoadTransition(options: {
  currentGraph: NodeGraph;
  graphToLoad: NodeGraph;
  navigationStack?: GraphNavigationStack;
  path?: string | null;
  project: Omit<Project, 'data'>;
  viewport?: GraphSwitchViewportStrategy;
}): ProjectLoadTransition {
  return {
    cleanupNodeIds: options.currentGraph.nodes.map((node) => node.id),
    graph: options.graphToLoad,
    loadedProject: {
      loaded: true,
      path: options.path ?? null,
    },
    navigationStack: options.navigationStack ?? {
      stack: [createRootGraphViewContext(options.graphToLoad.metadata!.id!)],
      index: 0,
    },
    project: options.project,
    resetHistoricalGraph: true,
    resetReadOnlyGraph: true,
    viewport: options.viewport ?? resolveProjectLoadViewportStrategy(options.graphToLoad, undefined),
  };
}

export function createGraphSwitchTransition(options: {
  currentGraph: NodeGraph;
  graphToLoad: NodeGraph;
  lastSavedPositions: Record<GraphId, CanvasPosition | undefined>;
  pushHistory?: boolean;
  previousNavigationStack: GraphNavigationStack;
  nextGraphView?: GraphViewContext;
}): GraphSwitchTransition {
  const graphChanged = options.currentGraph.metadata?.id !== options.graphToLoad.metadata?.id;
  const lastSavedPosition = options.lastSavedPositions[options.graphToLoad.metadata!.id!];
  const nextGraphView = options.nextGraphView ?? createRootGraphViewContext(options.graphToLoad.metadata!.id!);

  return {
    cleanupNodeIds: graphChanged ? options.currentGraph.nodes.map((node) => node.id) : [],
    graph: options.graphToLoad,
    navigationStack: options.pushHistory
      ? {
          index: (options.previousNavigationStack.index ?? -1) + 1,
          stack: [
            ...options.previousNavigationStack.stack.slice(0, (options.previousNavigationStack.index ?? -1) + 1),
            nextGraphView,
          ],
        }
      : undefined,
    resetHistoricalGraph: true,
    resetReadOnlyGraph: true,
    selectedNodes: [],
    viewport: resolveViewportStrategy(graphChanged, options.graphToLoad, lastSavedPosition),
  };
}

export function mergeCurrentGraphIntoProject(
  project: Omit<Project, 'data'>,
  savedGraph?: NodeGraph,
): Omit<Project, 'data'> {
  if (!savedGraph) {
    return project;
  }

  const prepared = prepareCurrentGraphForSave(savedGraph, Object.values(project.graphs));
  if (!prepared) {
    return project;
  }

  const mergedProject = produce(project, (draft) => {
    draft.graphs[prepared.currentGraph.metadata!.id!] = prepared.currentGraph;
  });

  return reconcileProjectUiGraphButtonBindings(project, mergedProject);
}

export function shouldPersistProjectBeforeLoad(options: {
  currentProjectHasOpenTab: boolean;
  loadedProject: { loaded: boolean };
  navigationStack: GraphNavigationStack;
  project: Omit<Project, 'data'>;
}): boolean {
  const projectId = options.project.metadata.id;
  if (!projectId) {
    return false;
  }

  return (
    options.currentProjectHasOpenTab ||
    options.loadedProject.loaded ||
    Object.keys(options.project.graphs).length > 0 ||
    options.navigationStack.stack.length > 0
  );
}

export function mergeStaticData(
  previousData: Record<DataId, string> | undefined,
  incomingData: Record<DataId, string> | undefined,
): Record<DataId, string> | undefined {
  if (!incomingData) {
    return previousData;
  }

  return {
    ...(previousData ?? {}),
    ...incomingData,
  };
}

function resolveViewportStrategy(
  graphChanged: boolean,
  graphToLoad: NodeGraph,
  lastSavedPosition: CanvasPosition | undefined,
): GraphSwitchViewportStrategy {
  if (lastSavedPosition && graphChanged) {
    return { type: 'saved', position: lastSavedPosition };
  }

  if (graphToLoad.nodes.length > 0) {
    return { type: 'center' };
  }

  return { type: 'reset' };
}

function resolveProjectLoadViewportStrategy(
  graphToLoad: NodeGraph,
  lastSavedPosition: CanvasPosition | undefined,
): GraphSwitchViewportStrategy {
  if (lastSavedPosition) {
    return { type: 'saved', position: lastSavedPosition };
  }

  if (graphToLoad.nodes.length > 0) {
    return { type: 'center' };
  }

  return { type: 'reset' };
}
