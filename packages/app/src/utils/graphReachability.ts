import {
  type GraphId,
  type NodeGraph,
  type PluginLoadSpec,
  type Project,
  type UiGraph,
  type UiGraphActionComponent,
  type UiGraphId,
  resolveBuiltInPlugin,
} from '@valerypopoff/rivet2-core';
import {
  collectGraphDependencyEdges,
  createGraphDependencyDiscovery,
  getDelegateToolTargetGraphIds,
  getGraphDependencyIndex,
  isReachableGraphDependencyEdge,
} from './graphDependencyDiscovery.js';

export type { GraphDependencyEdgeKind } from './graphDependencyDiscovery.js';

export type GraphReachabilityBucket = 'definitely-reachable' | 'dynamically-reachable' | 'unreachable';

export type GraphReachabilityAnalysisStatus = 'ready' | 'partial' | 'blocked';

export type GraphReachabilityBlockedReason = 'missing-main-graph' | 'invalid-main-graph';

export type GraphReachabilityUnsupportedReason = 'unregistered-node-type' | 'third-party-plugin-node';

export type GraphReachabilityRegistry = {
  isRegistered(type: string): boolean;
  getPluginFor(type: string): { id: string } | undefined;
};

export type GraphReachabilityReport = {
  status: GraphReachabilityAnalysisStatus;
  blockedReason?: GraphReachabilityBlockedReason;
  definite: Set<GraphId>;
  dynamic: Set<GraphId>;
  unreachable: Set<GraphId>;
  unsupportedNodeTypes: string[];
  unsupportedReasons: GraphReachabilityUnsupportedReason[];
  warnings: string[];
};

type ReachabilityMode = 'definite' | 'dynamic';

type ReachabilityProject = Pick<Project, 'metadata' | 'graphs' | 'nodePrefabs' | 'uiGraphs'>;

type GetGraphReachabilityReportOptions = {
  registry?: GraphReachabilityRegistry;
  builtInPluginIds?: Iterable<string>;
};

export function resolveSupportedBuiltInPluginIds(pluginSpecs: PluginLoadSpec[] | undefined): Set<string> {
  const supportedIds = new Set<string>();

  for (const spec of pluginSpecs ?? []) {
    if (spec.type !== 'built-in') {
      continue;
    }

    supportedIds.add(spec.id);

    try {
      supportedIds.add(resolveBuiltInPlugin(spec.id).id);
    } catch {
      // Keep the explicit spec id even if the built-in plugin catalog has drifted.
    }
  }

  return supportedIds;
}

/**
 * Traverses dependency edges discovered by graphDependencyDiscovery. This owns
 * roots, definite/dynamic propagation, plugin diagnostics, and final buckets;
 * it deliberately does not interpret executor-node wiring itself.
 */
export function getGraphReachabilityReport(
  project: ReachabilityProject,
  options: GetGraphReachabilityReportOptions = {},
): GraphReachabilityReport {
  const warnings = new Set<string>();
  const unsupportedNodeTypes = new Set<string>();
  const unsupportedReasons = new Set<GraphReachabilityUnsupportedReason>();
  const discovery = createGraphDependencyDiscovery(project);
  const { allGraphIds } = discovery;
  const builtInPluginIds = new Set(options.builtInPluginIds ?? []);

  const definite = new Set<GraphId>();
  const dynamic = new Set<GraphId>();
  const queue: Array<{ graphId: GraphId; mode: ReachabilityMode }> = [];
  const strongestModeByGraph = new Map<GraphId, number>();

  const enqueue = (graphId: GraphId, mode: ReachabilityMode) => {
    if (!project.graphs[graphId]) {
      return;
    }

    const nextStrength = mode === 'definite' ? 2 : 1;
    const currentStrength = strongestModeByGraph.get(graphId) ?? 0;
    if (currentStrength >= nextStrength) {
      return;
    }

    strongestModeByGraph.set(graphId, nextStrength);
    queue.push({ graphId, mode });
  };

  const mainGraphId = project.metadata.mainGraphId;
  if (!mainGraphId) {
    warnings.add(
      'Reachability is rooted at project.metadata.mainGraphId. This project has no main graph, even though some runtime paths can fall back to a different graph.',
    );

    return buildBlockedReport({
      blockedReason: 'missing-main-graph',
      definite,
      dynamic,
      allGraphIds,
      warnings,
    });
  }

  if (!project.graphs[mainGraphId]) {
    warnings.add(`The configured main graph ${mainGraphId} does not exist in the current project.`);

    return buildBlockedReport({
      blockedReason: 'invalid-main-graph',
      definite,
      dynamic,
      allGraphIds,
      warnings,
    });
  }

  enqueue(mainGraphId, 'definite');
  for (const graphId of getUiGraphActionTargetGraphIds(project.uiGraphs)) {
    enqueue(graphId, 'definite');
  }
  for (const graphId of getDelegateToolTargetGraphIds(discovery)) {
    enqueue(graphId, 'definite');
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    const index = getGraphDependencyIndex(discovery, current.graphId);
    if (!index) {
      continue;
    }

    if (current.mode === 'definite') {
      definite.add(current.graphId);
      dynamic.delete(current.graphId);
    } else if (!definite.has(current.graphId)) {
      dynamic.add(current.graphId);
    }

    collectUnsupportedNodeTypes({
      builtInPluginIds,
      graph: index.graph,
      registry: options.registry,
      unsupportedNodeTypes,
      unsupportedReasons,
    });

    for (const edge of collectGraphDependencyEdges({ index })) {
      edge.warnings?.forEach((warning) => warnings.add(warning));

      if (!isReachableGraphDependencyEdge(edge)) {
        continue;
      }

      const nextMode =
        current.mode === 'dynamic'
          ? 'dynamic'
          : edge.kind === 'direct-static' || edge.kind === 'static-via-callgraph'
            ? 'definite'
            : 'dynamic';

      for (const target of edge.targets) {
        enqueue(target, nextMode);
      }
    }
  }

  const unreachable = new Set(allGraphIds.filter((graphId) => !definite.has(graphId) && !dynamic.has(graphId)));

  return {
    status: unsupportedNodeTypes.size > 0 ? 'partial' : 'ready',
    definite,
    dynamic,
    unreachable,
    unsupportedNodeTypes: [...unsupportedNodeTypes].sort(),
    unsupportedReasons: [...unsupportedReasons].sort(),
    warnings: [...warnings],
  };
}

/**
 * Returns static same-project references only. Delegate Tool Call edges are
 * intentionally excluded because tool handlers are reachability roots, not
 * direct references for this editor query.
 */
export function getGraphIdsReferencingGraph(project: ReachabilityProject, targetGraphId: GraphId): Set<GraphId> {
  const referencingGraphIds = new Set<GraphId>();
  const discovery = createGraphDependencyDiscovery(project);

  for (const [graphId] of discovery.graphEntries) {
    if (graphId === targetGraphId) {
      continue;
    }

    const index = getGraphDependencyIndex(discovery, graphId);
    if (!index) {
      continue;
    }

    const referencesTarget = collectGraphDependencyEdges({
      index,
      includeDelegateFunctionCallEdges: false,
    }).some((edge) => isReachableGraphDependencyEdge(edge) && edge.targets.includes(targetGraphId));

    if (referencesTarget) {
      referencingGraphIds.add(graphId);
    }
  }

  return referencingGraphIds;
}

/** Returns web apps with a Button or Chat action that directly targets a graph. */
export function getUiGraphIdsReferencingGraph(
  project: Pick<Project, 'uiGraphs'>,
  targetGraphId: GraphId,
): Set<UiGraphId> {
  const referencingUiGraphIds = new Set<UiGraphId>();

  for (const [uiGraphId, uiGraph] of Object.entries(project.uiGraphs ?? {}) as Array<[UiGraphId, UiGraph]>) {
    if (uiGraph.components.some((component) => getUiGraphActionTargetGraphId(component) === targetGraphId)) {
      referencingUiGraphIds.add(uiGraphId);
    }
  }

  return referencingUiGraphIds;
}

function getUiGraphActionTargetGraphIds(uiGraphs: Record<UiGraphId, UiGraph> | undefined): Set<GraphId> {
  const graphIds = new Set<GraphId>();

  for (const uiGraph of Object.values(uiGraphs ?? {})) {
    for (const component of uiGraph.components) {
      const graphId = getUiGraphActionTargetGraphId(component);
      if (graphId) {
        graphIds.add(graphId);
      }
    }
  }

  return graphIds;
}

function getUiGraphActionTargetGraphId(component: UiGraph['components'][number]): GraphId | undefined {
  return isUiGraphActionComponent(component) ? component.action.graphId : undefined;
}

function isUiGraphActionComponent(component: UiGraph['components'][number]): component is UiGraphActionComponent {
  return component.type === 'button' || component.type === 'chat';
}

function collectUnsupportedNodeTypes(options: {
  builtInPluginIds: ReadonlySet<string>;
  graph: NodeGraph;
  registry: GraphReachabilityRegistry | undefined;
  unsupportedNodeTypes: Set<string>;
  unsupportedReasons: Set<GraphReachabilityUnsupportedReason>;
}) {
  const { builtInPluginIds, graph, registry, unsupportedNodeTypes, unsupportedReasons } = options;
  if (!registry) {
    return;
  }

  for (const node of graph.nodes) {
    if (node.disabled) {
      continue;
    }

    if (!registry.isRegistered(node.type)) {
      unsupportedNodeTypes.add(node.type);
      unsupportedReasons.add('unregistered-node-type');
      continue;
    }

    const plugin = registry.getPluginFor(node.type);
    if (plugin && !builtInPluginIds.has(plugin.id)) {
      unsupportedNodeTypes.add(node.type);
      unsupportedReasons.add('third-party-plugin-node');
    }
  }
}

function buildBlockedReport(options: {
  blockedReason: GraphReachabilityBlockedReason;
  definite: Set<GraphId>;
  dynamic: Set<GraphId>;
  allGraphIds: readonly GraphId[];
  warnings: ReadonlySet<string>;
}): GraphReachabilityReport {
  const { blockedReason, definite, dynamic, allGraphIds, warnings } = options;

  return {
    status: 'blocked',
    blockedReason,
    definite,
    dynamic,
    unreachable: new Set(allGraphIds),
    unsupportedNodeTypes: [],
    unsupportedReasons: [],
    warnings: [...warnings],
  };
}
