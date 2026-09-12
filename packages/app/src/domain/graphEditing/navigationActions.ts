import { type GraphId, type NodeId, type Project } from '@valerypopoff/rivet2-core';

export type GraphViewKey = string;

export type GraphViewContext = {
  key: GraphViewKey;
  graphId: GraphId;
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
) {
  return {
    hasForward: findNavigationTargetIndex('forward', stack, project) != null,
    hasBackward: findNavigationTargetIndex('backward', stack, project) != null,
  };
}

export function resolveNavigationTarget(options: {
  direction: 'backward' | 'forward';
  navigationStack: GraphNavigationStack;
  project: Pick<Project, 'graphs'>;
}): { nextStack: GraphNavigationStack; targetGraphId: GraphId; targetView: GraphViewContext } | undefined {
  const { direction, navigationStack } = options;
  const targetIndex = findNavigationTargetIndex(direction, navigationStack, options.project);
  if (targetIndex == null) {
    return undefined;
  }

  const targetView = navigationStack.stack[targetIndex];
  const targetGraphId = targetView?.graphId;
  if (!targetGraphId || !options.project.graphs[targetGraphId]) {
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
): number | undefined {
  const currentIndex = navigationStack.index;
  if (currentIndex == null) {
    return undefined;
  }

  const step = direction === 'backward' ? -1 : 1;
  for (let index = currentIndex + step; index >= 0 && index < navigationStack.stack.length; index += step) {
    const graphId = navigationStack.stack[index]?.graphId;
    if (graphId && (!project || project.graphs[graphId])) {
      return index;
    }
  }

  return undefined;
}
