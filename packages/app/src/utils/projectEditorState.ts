import { emptyNodeGraph, type GraphId, type NodeGraph, type Project } from '@valerypopoff/rivet2-core';
import {
  createRootGraphViewContext,
  createSubgraphGraphViewContext,
  type GraphNavigationStack,
  type GraphViewContext,
} from '../domain/graphEditing/navigationActions.js';
import type { CanvasPosition } from '../state/graphBuilder.js';
import type { PersistedCanvasPosition, ProjectEditorState } from '../state/projectEditor.js';
import { isProjectGraphViewContextValid } from '../domain/workspace/projectWorkspaceTarget.js';

export type EditorRestoreViewportStrategy =
  | { type: 'saved'; position: CanvasPosition }
  | { type: 'center' }
  | { type: 'reset' };

export type ProjectEditorRestoreTarget = {
  graph: NodeGraph;
  navigationStack: GraphNavigationStack;
  viewport: EditorRestoreViewportStrategy;
};

type ProjectLike = Pick<Project, 'graphs' | 'metadata'>;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isGraphViewContextLike(value: unknown): value is GraphViewContext {
  if (typeof value !== 'object' || value == null) {
    return false;
  }

  const graphView = value as Partial<GraphViewContext> & {
    parent?: { parentGraphId?: unknown; parentNodeId?: unknown };
  };

  if (typeof graphView.graphId !== 'string') {
    return false;
  }

  if (graphView.parent == null) {
    return true;
  }

  return typeof graphView.parent.parentGraphId === 'string' && typeof graphView.parent.parentNodeId === 'string';
}

function normalizeGraphViewContext(graphView: GraphViewContext): GraphViewContext {
  if (!graphView.parent) {
    return createRootGraphViewContext(graphView.graphId);
  }

  return createSubgraphGraphViewContext({
    graphId: graphView.graphId,
    parentGraphId: graphView.parent.parentGraphId,
    parentNodeId: graphView.parent.parentNodeId,
  });
}

function toPersistedCanvasPosition(
  canvasPosition: PersistedCanvasPosition | CanvasPosition | undefined,
): PersistedCanvasPosition | undefined {
  if (!canvasPosition) {
    return undefined;
  }

  if (!isFiniteNumber(canvasPosition.x) || !isFiniteNumber(canvasPosition.y) || !isFiniteNumber(canvasPosition.zoom)) {
    return undefined;
  }

  return {
    x: canvasPosition.x,
    y: canvasPosition.y,
    zoom: canvasPosition.zoom,
  };
}

function toCanvasPosition(
  canvasPosition: PersistedCanvasPosition | CanvasPosition | undefined,
): CanvasPosition | undefined {
  const persistedCanvasPosition = toPersistedCanvasPosition(canvasPosition);
  if (!persistedCanvasPosition) {
    return undefined;
  }

  return {
    x: persistedCanvasPosition.x,
    y: persistedCanvasPosition.y,
    zoom: persistedCanvasPosition.zoom,
  };
}

function createRootNavigationStack(graphId: GraphId | undefined): GraphNavigationStack {
  if (!graphId) {
    return {
      stack: [],
      index: undefined,
    };
  }

  return {
    stack: [createRootGraphViewContext(graphId)],
    index: 0,
  };
}

function pickFallbackGraph(project: ProjectLike): NodeGraph {
  if (project.metadata.mainGraphId && project.graphs[project.metadata.mainGraphId]) {
    return project.graphs[project.metadata.mainGraphId]!;
  }

  const firstSortedGraph = Object.values(project.graphs).sort((a, b) =>
    (a.metadata?.name ?? '').localeCompare(b.metadata?.name ?? ''),
  )[0];

  return firstSortedGraph ?? emptyNodeGraph();
}

function resolveSavedViewport(
  graph: NodeGraph,
  persistedCanvasPositionsByGraph: Record<GraphId, PersistedCanvasPosition | undefined>,
  legacyCanvasPositionsByGraph: Record<GraphId, CanvasPosition | undefined> | undefined,
  allowLegacyFallback: boolean,
): EditorRestoreViewportStrategy {
  const graphId = graph.metadata?.id;
  const persistedPosition = graphId ? persistedCanvasPositionsByGraph[graphId] : undefined;
  if (persistedPosition) {
    return {
      type: 'saved',
      position: {
        ...persistedPosition,
        fromSaved: true,
      },
    };
  }

  const legacyPosition = allowLegacyFallback && graphId ? legacyCanvasPositionsByGraph?.[graphId] : undefined;
  if (legacyPosition) {
    return {
      type: 'saved',
      position: {
        x: legacyPosition.x,
        y: legacyPosition.y,
        zoom: legacyPosition.zoom,
        fromSaved: true,
      },
    };
  }

  if (graph.nodes.length > 0) {
    return { type: 'center' };
  }

  return { type: 'reset' };
}

export function sanitizeProjectEditorStateForProject(
  project: ProjectLike,
  projectEditorState: ProjectEditorState | undefined,
): ProjectEditorState | undefined {
  if (!projectEditorState) {
    return undefined;
  }

  return {
    navigationStack: sanitizeNavigationStackForProject(project, projectEditorState.navigationStack),
    canvasPositionsByGraph: pruneCanvasPositionsForProject(project, projectEditorState.canvasPositionsByGraph),
  };
}

export function sanitizeNavigationStackForProject(
  project: ProjectLike,
  navigationStack: GraphNavigationStack | undefined,
): GraphNavigationStack {
  const rawStack = Array.isArray(navigationStack?.stack) ? navigationStack.stack : [];
  const rawIndex = typeof navigationStack?.index === 'number' ? navigationStack.index : rawStack.length - 1;
  const clampedRawIndex = Math.min(Math.max(rawIndex, 0), Math.max(rawStack.length - 1, 0));
  const validEntries = rawStack.flatMap((graphView, rawEntryIndex) =>
    isGraphViewContextLike(graphView) && isProjectGraphViewContextValid(graphView, project)
      ? [{ graphView: normalizeGraphViewContext(graphView), rawEntryIndex }]
      : [],
  );

  if (validEntries.length === 0) {
    return {
      stack: [],
      index: undefined,
    };
  }

  const exactActiveIndex = validEntries.findIndex((entry) => entry.rawEntryIndex === clampedRawIndex);
  const previousActiveIndex = validEntries.reduce<number | undefined>(
    (lastIndex, entry, index) => (entry.rawEntryIndex <= clampedRawIndex ? index : lastIndex),
    undefined,
  );
  const activeIndex = exactActiveIndex >= 0 ? exactActiveIndex : previousActiveIndex ?? 0;

  return {
    stack: validEntries.map((entry) => entry.graphView),
    index: activeIndex,
  };
}

export function getActiveGraphView(navigationStack: GraphNavigationStack | undefined): GraphViewContext | undefined {
  if (!navigationStack || navigationStack.stack.length === 0) {
    return undefined;
  }

  const rawIndex = navigationStack.index ?? navigationStack.stack.length - 1;
  const clampedIndex = Math.min(Math.max(rawIndex, 0), navigationStack.stack.length - 1);
  return navigationStack.stack[clampedIndex];
}

export function getActiveGraphId(navigationStack: GraphNavigationStack | undefined): GraphId | undefined {
  return getActiveGraphView(navigationStack)?.graphId;
}

export function pruneCanvasPositionsForProject(
  project: ProjectLike,
  canvasPositionsByGraph: Record<GraphId, PersistedCanvasPosition | CanvasPosition | undefined> | undefined,
): Record<GraphId, PersistedCanvasPosition | undefined> {
  const nextPositionsByGraph: Record<GraphId, PersistedCanvasPosition | undefined> = {};
  const positionsByGraph =
    canvasPositionsByGraph != null && typeof canvasPositionsByGraph === 'object'
      ? (canvasPositionsByGraph as Record<GraphId, PersistedCanvasPosition | CanvasPosition | undefined>)
      : undefined;

  for (const graphId of Object.keys(project.graphs) as GraphId[]) {
    const position = toPersistedCanvasPosition(positionsByGraph?.[graphId]);
    if (position) {
      nextPositionsByGraph[graphId] = position;
    }
  }

  return nextPositionsByGraph;
}

export function buildCurrentProjectEditorStateSnapshot(args: {
  project: ProjectLike;
  currentGraphId: GraphId | undefined;
  navigationStack: GraphNavigationStack;
  canvasPosition: CanvasPosition;
  existingProjectEditorState?: ProjectEditorState;
  legacyCanvasPositionsByGraph?: Record<GraphId, CanvasPosition | undefined>;
}): ProjectEditorState {
  const {
    project,
    currentGraphId,
    navigationStack,
    canvasPosition,
    existingProjectEditorState,
    legacyCanvasPositionsByGraph,
  } = args;

  const existingPositionsByGraph = pruneCanvasPositionsForProject(project, existingProjectEditorState?.canvasPositionsByGraph);

  const nextPositionsByGraph = {
    ...existingPositionsByGraph,
  };

  const currentLegacyPosition = currentGraphId ? toPersistedCanvasPosition(legacyCanvasPositionsByGraph?.[currentGraphId]) : undefined;
  if (currentGraphId && project.graphs[currentGraphId] && currentLegacyPosition && !nextPositionsByGraph[currentGraphId]) {
    nextPositionsByGraph[currentGraphId] = currentLegacyPosition;
  }

  if (currentGraphId && project.graphs[currentGraphId]) {
    nextPositionsByGraph[currentGraphId] = toPersistedCanvasPosition(canvasPosition);
  }

  let nextNavigationStack = sanitizeNavigationStackForProject(project, navigationStack);

  if (currentGraphId && project.graphs[currentGraphId]) {
    const activeGraphId = getActiveGraphId(nextNavigationStack);
    if (activeGraphId !== currentGraphId) {
      let matchingIndex = -1;
      for (let index = nextNavigationStack.stack.length - 1; index >= 0; index -= 1) {
        if (nextNavigationStack.stack[index]?.graphId === currentGraphId) {
          matchingIndex = index;
          break;
        }
      }

      nextNavigationStack =
        matchingIndex >= 0
          ? {
              stack: nextNavigationStack.stack,
              index: matchingIndex,
            }
          : createRootNavigationStack(currentGraphId);
    }
  }

  return {
    navigationStack: nextNavigationStack,
    canvasPositionsByGraph: pruneCanvasPositionsForProject(project, nextPositionsByGraph),
  };
}

export function resolveCanvasPositionsForProject(args: {
  project: ProjectLike;
  persistedProjectEditorState?: ProjectEditorState;
  legacyCanvasPositionsByGraph?: Record<GraphId, CanvasPosition | undefined>;
}): Record<GraphId, CanvasPosition | undefined> {
  const { project, persistedProjectEditorState, legacyCanvasPositionsByGraph } = args;

  const persistedCanvasPositionsByGraph = pruneCanvasPositionsForProject(
    project,
    persistedProjectEditorState?.canvasPositionsByGraph,
  );
  if (Object.keys(persistedCanvasPositionsByGraph).length > 0) {
    return Object.fromEntries(
      Object.entries(persistedCanvasPositionsByGraph).flatMap(([graphId, position]) => {
        const normalizedPosition = toCanvasPosition(position);
        return normalizedPosition ? [[graphId as GraphId, normalizedPosition]] : [];
      }),
    );
  }

  return Object.fromEntries(
    (Object.keys(project.graphs) as GraphId[]).flatMap((graphId) => {
      const normalizedPosition = toCanvasPosition(legacyCanvasPositionsByGraph?.[graphId]);
      return normalizedPosition ? [[graphId, normalizedPosition]] : [];
    }),
  );
}

export function resolvePersistedCanvasPositionsForLegacyCache(args: {
  project: ProjectLike;
  persistedProjectEditorState?: ProjectEditorState;
}): Record<GraphId, CanvasPosition | undefined> {
  const persistedCanvasPositionsByGraph = pruneCanvasPositionsForProject(
    args.project,
    args.persistedProjectEditorState?.canvasPositionsByGraph,
  );

  return Object.fromEntries(
    Object.entries(persistedCanvasPositionsByGraph).flatMap(([graphId, position]) => {
      const normalizedPosition = toCanvasPosition(position);
      return normalizedPosition
        ? [[graphId as GraphId, { ...normalizedPosition, fromSaved: true } satisfies CanvasPosition]]
        : [];
    }),
  );
}

export function resolveProjectEditorRestoreTarget(args: {
  project: ProjectLike;
  persistedProjectEditorState?: ProjectEditorState;
  explicitGraphToLoad?: NodeGraph;
  explicitGraphView?: GraphViewContext;
  openedGraphId?: GraphId;
  legacyCanvasPositionsByGraph?: Record<GraphId, CanvasPosition | undefined>;
}): ProjectEditorRestoreTarget {
  const {
    project,
    persistedProjectEditorState,
    explicitGraphToLoad,
    explicitGraphView,
    openedGraphId,
    legacyCanvasPositionsByGraph,
  } = args;

  const sanitizedPersistedProjectEditorState = sanitizeProjectEditorStateForProject(project, persistedProjectEditorState);
  const persistedCanvasPositionsByGraph = sanitizedPersistedProjectEditorState?.canvasPositionsByGraph ?? {};
  const allowLegacyViewportFallback = Object.keys(persistedCanvasPositionsByGraph).length === 0;
  const normalizedExplicitGraphView =
    explicitGraphView &&
    isGraphViewContextLike(explicitGraphView) &&
    isProjectGraphViewContextValid(explicitGraphView, project)
      ? normalizeGraphViewContext(explicitGraphView)
      : undefined;
  const explicitGraphId =
    normalizedExplicitGraphView?.graphId ?? explicitGraphToLoad?.metadata?.id;

  if (explicitGraphId && project.graphs[explicitGraphId]) {
    const graph = project.graphs[explicitGraphId]!;
    const navigationStack =
      normalizedExplicitGraphView
        ? {
            stack: [normalizedExplicitGraphView],
            index: 0,
          }
        : createRootNavigationStack(explicitGraphId);

    return {
      graph,
      navigationStack,
      viewport: resolveSavedViewport(
        graph,
        persistedCanvasPositionsByGraph,
        legacyCanvasPositionsByGraph,
        allowLegacyViewportFallback,
      ),
    };
  }

  const persistedActiveGraphId = getActiveGraphId(sanitizedPersistedProjectEditorState?.navigationStack);
  if (persistedActiveGraphId && project.graphs[persistedActiveGraphId]) {
    const graph = project.graphs[persistedActiveGraphId]!;
    return {
      graph,
      navigationStack: sanitizedPersistedProjectEditorState!.navigationStack,
      viewport: resolveSavedViewport(
        graph,
        persistedCanvasPositionsByGraph,
        legacyCanvasPositionsByGraph,
        allowLegacyViewportFallback,
      ),
    };
  }

  if (openedGraphId && project.graphs[openedGraphId]) {
    const graph = project.graphs[openedGraphId]!;
    return {
      graph,
      navigationStack: createRootNavigationStack(openedGraphId),
      viewport: resolveSavedViewport(
        graph,
        persistedCanvasPositionsByGraph,
        legacyCanvasPositionsByGraph,
        allowLegacyViewportFallback,
      ),
    };
  }

  const graph = pickFallbackGraph(project);
  const graphId = graph.metadata?.id;
  return {
    graph,
    navigationStack: createRootNavigationStack(graphId),
    viewport: resolveSavedViewport(
      graph,
      persistedCanvasPositionsByGraph,
      legacyCanvasPositionsByGraph,
      allowLegacyViewportFallback,
    ),
  };
}
