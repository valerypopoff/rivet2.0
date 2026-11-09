import { type GraphId, type NodeId, type Project, type ProjectId } from '@valerypopoff/rivet2-core';

export type GraphViewKey = string;

export type GraphViewContext = {
  key: GraphViewKey;
  graphId: GraphId;
  /** Present in a cross-project navigation trail; legacy/local views remain unscoped. */
  projectId?: ProjectId;
  parent?: {
    parentGraphId: GraphId;
    parentNodeId: NodeId;
  };
};

export type GraphNavigationStack = {
  stack: GraphViewContext[];
  index?: number;
};

export function createRootGraphViewContext(graphId: GraphId): GraphViewContext {
  return {
    key: `root:${graphId}`,
    graphId,
  };
}

export function createSubgraphGraphViewContext(options: {
  graphId: GraphId;
  parentGraphId: GraphId;
  parentNodeId: NodeId;
}): GraphViewContext {
  return {
    key: `subgraph:${options.parentGraphId}:${options.parentNodeId}:${options.graphId}`,
    graphId: options.graphId,
    parent: {
      parentGraphId: options.parentGraphId,
      parentNodeId: options.parentNodeId,
    },
  };
}

export function createInitialGraphNavigationStack(options: {
  currentGraphId?: GraphId;
  availableGraphIds: GraphId[];
  existingStack: GraphNavigationStack;
}): GraphNavigationStack | undefined {
  if (
    options.existingStack.stack.length === 0 &&
    options.currentGraphId != null &&
    options.availableGraphIds.includes(options.currentGraphId)
  ) {
    return { index: 0, stack: [createRootGraphViewContext(options.currentGraphId)] };
  }

  return undefined;
}

export function getGraphNavigationAvailability(
  stack: GraphNavigationStack,
  project?: Pick<Project, 'graphs'>,
  getProject?: GraphHistoryProjectResolver,
) {
  return {
    hasForward: findNavigationTargetIndex('forward', stack, project, getProject) != null,
    hasBackward: findNavigationTargetIndex('backward', stack, project, getProject) != null,
  };
}

export function resolveNavigationTarget(options: {
  direction: 'backward' | 'forward';
  navigationStack: GraphNavigationStack;
  project: Pick<Project, 'graphs'>;
  getProject?: GraphHistoryProjectResolver;
}): { nextStack: GraphNavigationStack; targetGraphId: GraphId; targetView: GraphViewContext } | undefined {
  const { direction, navigationStack } = options;
  const targetIndex = findNavigationTargetIndex(direction, navigationStack, options.project, options.getProject);
  if (targetIndex == null) {
    return undefined;
  }

  const targetView = navigationStack.stack[targetIndex];
  const targetGraphId = targetView?.graphId;
  const targetProject = options.getProject ? options.getProject(targetView!) : options.project;
  if (!targetGraphId || !targetProject?.graphs[targetGraphId]) {
    return undefined;
  }

  return {
    nextStack: {
      ...navigationStack,
      index: targetIndex,
    },
    targetView,
    targetGraphId,
  };
}

function findNavigationTargetIndex(
  direction: 'backward' | 'forward',
  navigationStack: GraphNavigationStack,
  project?: Pick<Project, 'graphs'>,
  getProject?: GraphHistoryProjectResolver,
): number | undefined {
  const currentIndex = navigationStack.index;
  if (currentIndex == null) {
    return undefined;
  }

  const step = direction === 'backward' ? -1 : 1;
  for (let index = currentIndex + step; index >= 0 && index < navigationStack.stack.length; index += step) {
    const view = navigationStack.stack[index];
    const graphId = view?.graphId;
    const targetProject = view && getProject ? getProject(view) : project;
    if (graphId && ((!project && !getProject) || targetProject?.graphs[graphId])) {
      return index;
    }
  }

  return undefined;
}

export type GraphHistoryProjectResolver = (view: GraphViewContext) => Pick<Project, 'graphs'> | undefined;

/** Extend the caller's active trail only after a cross-project open succeeds. */
export function appendCrossProjectGraphNavigation(options: {
  navigationStack: GraphNavigationStack;
  sourceProjectId: ProjectId;
  sourceGraphId: GraphId;
  targetProjectId: ProjectId;
  targetGraphId: GraphId;
}): GraphNavigationStack {
  const { navigationStack, sourceProjectId, sourceGraphId, targetProjectId, targetGraphId } = options;
  const stack = navigationStack.stack
    .slice(0, (navigationStack.index ?? -1) + 1)
    .map((view) => ({ ...view, projectId: view.projectId ?? sourceProjectId }));
  const current = stack.at(-1);
  if (current?.projectId !== sourceProjectId || current.graphId !== sourceGraphId) {
    stack.push({ ...createRootGraphViewContext(sourceGraphId), projectId: sourceProjectId });
  }
  stack.push({ ...createRootGraphViewContext(targetGraphId), projectId: targetProjectId });
  return { stack, index: stack.length - 1 };
}
