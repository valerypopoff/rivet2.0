import { canRenderDataBusNode, getDataBusInputChannelIndex, getDataBusOutputChannelIndex } from './DataBusTopology.js';
import { resolveNodePrefabInstance } from './NodePrefabResolver.js';
import type { ChartNode, NodeConnection, NodeId } from './NodeBase.js';
import type { FrozenNodeOutputsByGraph } from './GraphProcessor.js';
import type { GraphInputNode } from './nodes/GraphInputNode.js';
import type { GraphOutputNode } from './nodes/GraphOutputNode.js';
import type { NodeGraph } from './NodeGraph.js';
import type { NodeRegistration } from './NodeRegistration.js';
import type { Project, ProjectId } from './Project.js';
import type { ReferencedGraphAliasNode } from './nodes/ReferencedGraphAliasNode.js';
import type { SubGraphNode } from './nodes/SubGraphNode.js';
import { getSubgraphTargetBoundaryChange, reconcileSubgraphTargetBoundary } from './nodes/SubGraphNode.js';
import { getGraphBoundary } from './GraphBoundaryCache.js';
import { createGraphOutputSelection } from './GraphOutputSelection.js';
import { getSubgraphProjectKey } from './SubgraphProjectTarget.js';

function getCallerProject(
  owner: Project,
  caller: SubGraphNode | ReferencedGraphAliasNode,
  projects: Record<ProjectId, Project>,
): Project | undefined {
  if (caller.type === 'referencedGraphAlias') return projects[caller.data.projectId];
  if (!caller.data.targetProjectId) return owner;
  return projects[
    getSubgraphProjectKey({
      projectId: caller.data.targetProjectId,
      version: caller.data.targetVersion ?? 'latest',
    })
  ];
}

function getCallerBoundary(caller: SubGraphNode | ReferencedGraphAliasNode, target: Project) {
  if (caller.type !== 'subGraph') return undefined;
  const actual = getGraphBoundary(target, caller.data.graphId);
  if (!actual || getSubgraphTargetBoundaryChange(caller.data.targetBoundary, actual)) return undefined;
  return reconcileSubgraphTargetBoundary(caller.data.targetBoundary, actual);
}

/** An executing caller may forward outputs after its condition has passed. */
export function canForwardGraphCallerOutputPartials(node: ChartNode): node is SubGraphNode | ReferencedGraphAliasNode {
  return (
    (node.type === 'subGraph' || node.type === 'referencedGraphAlias') &&
    !node.disabled &&
    !node.isSplitRun &&
    !(node as SubGraphNode).data.useErrorOutput
  );
}

/** Early input delivery must not bypass the caller's ordinary readiness/condition gate. */
export function canStreamThroughGraphCaller(node: ChartNode): node is SubGraphNode | ReferencedGraphAliasNode {
  return canForwardGraphCallerOutputPartials(node) && !node.isConditional;
}

export function canStreamThroughGraphInput(node: ChartNode): node is GraphInputNode {
  return (
    node.type === 'graphInput' &&
    !node.disabled &&
    !node.isConditional &&
    !node.isSplitRun &&
    !(node as GraphInputNode).data.useDefaultValueInput
  );
}

/** A named output may forward only when one direct producer determines its terminal value. */
export function canForwardGraphOutputPartials(
  graphOutput: ChartNode,
  sourceNode: ChartNode,
  graphOutputIsFrozen: boolean,
): graphOutput is GraphOutputNode {
  return (
    graphOutput.type === 'graphOutput' &&
    !graphOutput.disabled &&
    !graphOutput.isConditional &&
    !graphOutput.isSplitRun &&
    !sourceNode.isSplitRun &&
    !graphOutputIsFrozen
  );
}

/** Trace Watch demand through named boundaries without making ordinary nodes repeatable. */
export function getProjectStreamingOutputWatchConnections({
  project,
  graph,
  referencedProjects,
  registry,
  frozenNodeOutputs = {},
  isNodeFrozen,
  fullGraphCallers,
}: {
  project: Project;
  graph: NodeGraph;
  referencedProjects: Record<ProjectId, Project>;
  registry: NodeRegistration<any, any>;
  frozenNodeOutputs?: FrozenNodeOutputsByGraph;
  isNodeFrozen?: (owner: Project, candidate: NodeGraph, node: ChartNode) => boolean;
  fullGraphCallers?: ReadonlySet<NodeId>;
}): ReadonlySet<NodeConnection> {
  // Unsaved active graph edits must take precedence over the stored project graph.
  const currentProject: Project = {
    ...project,
    graphs: { ...project.graphs, ...(graph.metadata?.id ? { [graph.metadata.id]: graph } : {}) },
  };
  const projects: Record<ProjectId, Project> = { ...referencedProjects, [project.metadata.id]: currentProject };
  const contexts = new Map<
    NodeGraph,
    {
      project: Project;
      nodes: Record<NodeId, ChartNode>;
      incoming: (nodeId: NodeId) => NodeConnection[];
      marked: Set<NodeConnection>;
    }
  >();
  const isFrozen = (owner: Project, candidate: NodeGraph, node: ChartNode) =>
    isNodeFrozen?.(owner, candidate, node) ??
    (owner === currentProject &&
      !!(candidate.metadata?.id && frozenNodeOutputs[candidate.metadata.id]?.[node.id]?.length));

  for (const owner of Object.values(projects)) {
    for (const candidate of Object.values(owner.graphs)) {
      const nodes = Object.fromEntries(
        candidate.nodes.map((node) => [node.id, resolveNodePrefabInstance(owner, node)]),
      );
      const connectionsByNode = new Map<NodeId, NodeConnection[]>();
      for (const edge of candidate.connections) {
        for (const id of new Set([edge.inputNodeId, edge.outputNodeId])) {
          const edges = connectionsByNode.get(id) ?? [];
          edges.push(edge);
          connectionsByNode.set(id, edges);
        }
      }
      const ports = new Map<NodeId, { inputs: Set<string>; outputs: Set<string> }>();
      const getPorts = (nodeId: NodeId) => {
        const cached = ports.get(nodeId);
        if (cached) return cached;
        const node = nodes[nodeId];
        let definitions = { inputs: new Set<string>(), outputs: new Set<string>() };
        try {
          if (!node) return definitions;
          const impl = registry.createDynamicImpl(node);
          const connections = connectionsByNode.get(node.id) ?? [];
          definitions = {
            inputs: new Set(
              impl.getInputDefinitionsIncludingBuiltIn(connections, nodes, owner, projects).map((port) => port.id),
            ),
            outputs: new Set(impl.getOutputDefinitions(connections, nodes, owner, projects).map((port) => port.id)),
          };
        } catch {
          // Missing plugins or incomplete definitions cannot establish a stream route.
        }
        ports.set(nodeId, definitions);
        return definitions;
      };
      // Resolve definitions only on visited routes, including failed plugin lookups.
      const incomingByNode = new Map<NodeId, NodeConnection[]>();
      const incoming = (nodeId: NodeId) => {
        let edges = incomingByNode.get(nodeId);
        if (!edges) {
          edges = (connectionsByNode.get(nodeId) ?? []).filter(
            (edge) =>
              edge.inputNodeId === nodeId &&
              getPorts(nodeId).inputs.has(edge.inputId) &&
              getPorts(edge.outputNodeId).outputs.has(edge.outputId),
          );
          incomingByNode.set(nodeId, edges);
        }
        return edges;
      };
      contexts.set(candidate, { project: owner, nodes, incoming, marked: new Set() });
    }
  }

  // Index callers by the actual target graph, not graph/node IDs (which are local).
  const callers = new Map<NodeGraph, Array<{ graph: NodeGraph; node: ChartNode; selected?: ReadonlySet<NodeId> }>>();
  for (const [parent, context] of contexts) {
    for (const node of Object.values(context.nodes)) {
      if (node.disabled || isFrozen(context.project, parent, node) || !canStreamThroughGraphCaller(node)) continue;
      const caller = node as SubGraphNode | ReferencedGraphAliasNode;
      const owner = getCallerProject(context.project, caller, projects);
      const child = owner?.graphs[caller.data.graphId];
      if (!child) continue;
      let selected: ReadonlySet<NodeId> | undefined;
      if (
        caller.type === 'subGraph' &&
        caller.data.skipUnusedOutputs &&
        !caller.data.useAsGraphPartialOutput &&
        !(parent === graph && fullGraphCallers?.has(caller.id))
      ) {
        const childContext = contexts.get(child)!;
        const callerBoundary = getCallerBoundary(caller, owner);
        const outputNames = new Set(
          Object.values(childContext.nodes)
            .filter((node) => node.type === 'graphOutput')
            .map((node) => (node as GraphOutputNode).data.id),
        );
        const outputs = parent.connections
          .filter((edge) => edge.outputNodeId === caller.id)
          .map((edge) => callerBoundary?.outputs.find((output) => output.portId === edge.outputId)?.id ?? edge.outputId)
          .filter((id) => outputNames.has(id));
        try {
          selected = createGraphOutputSelection(
            { ...child, nodes: Object.values(childContext.nodes) },
            outputs,
            (node) => childContext.incoming(node.id).map((edge) => childContext.nodes[edge.outputNodeId]!),
          ).nodeIds;
        } catch {
          continue;
        }
      }
      const entries = callers.get(child) ?? [];
      entries.push({ graph: parent, node, selected });
      callers.set(child, entries);
    }
  }

  const watchInputs: Array<{ graph: NodeGraph; edge: NodeConnection }> = [];
  for (const [candidate, context] of contexts) {
    for (const node of Object.values(context.nodes)) {
      if (node.type !== 'watchStreamingOutput' || node.disabled || isFrozen(context.project, candidate, node)) continue;
      const inputs = context.incoming(node.id).filter((edge) => edge.inputId === 'stream');
      // Multiple providers are rejected by the Watch scheduler, not multiple streams.
      if (inputs.length === 1) watchInputs.push({ graph: candidate, edge: inputs[0]! });
    }
  }

  const visiting = new Map<NodeGraph, Set<NodeConnection>>();
  const trace = (candidate: NodeGraph, edge: NodeConnection): boolean => {
    const context = contexts.get(candidate)!;
    if (context.marked.has(edge)) return true;
    const graphVisiting = visiting.get(candidate) ?? new Set<NodeConnection>();
    if (graphVisiting.has(edge)) return false;
    graphVisiting.add(edge);
    visiting.set(candidate, graphVisiting);

    try {
      const source = context.nodes[edge.outputNodeId];
      if (!source || source.disabled || source.isSplitRun || isFrozen(context.project, candidate, source)) return false;

      if (canRenderDataBusNode(source)) {
        const channel = getDataBusOutputChannelIndex(edge.outputId);
        if (channel == null) return false;
        const providers = context
          .incoming(source.id)
          .filter((input) => getDataBusInputChannelIndex(input.inputId) === channel);
        if (providers.length !== 1 || !trace(candidate, providers[0]!)) return false;
        context.marked.add(edge);
        return true;
      }

      if (source.type === 'graphInput' && edge.outputId === 'data') {
        if (!canStreamThroughGraphInput(source)) return false;
        const inputName = (source as GraphInputNode).data.id;
        let foundSource = false;
        for (const parent of callers.get(candidate) ?? []) {
          if (parent.selected && !parent.selected.has(edge.inputNodeId)) continue;
          const callerPortId =
            getCallerBoundary(parent.node as SubGraphNode | ReferencedGraphAliasNode, context.project)?.inputs.find(
              (input) => input.nodeId === source.id,
            )?.portId ?? inputName;
          const inputs = contexts
            .get(parent.graph)!
            .incoming(parent.node.id)
            .filter((input) => input.inputId === callerPortId);
          // Ambiguous authored inputs stay final-only even though ordinary
          // execution retains its established first-provider projection.
          if (inputs.length === 1 && trace(parent.graph, inputs[0]!)) foundSource = true;
        }
        if (!foundSource) return false;
        context.marked.add(edge);
        return true;
      }

      if (source.type !== 'subGraph' && source.type !== 'referencedGraphAlias') {
        context.marked.add(edge);
        return true;
      }

      if (!canForwardGraphCallerOutputPartials(source)) return false;
      const caller = source;
      const childProject = getCallerProject(context.project, caller, projects);
      const child = childProject?.graphs[caller.data.graphId];
      const childContext = child && contexts.get(child);
      if (!childProject || !child || !childContext) return false;
      const targetOutputId =
        getCallerBoundary(caller, childProject)?.outputs.find((output) => output.portId === edge.outputId)?.id ??
        edge.outputId;
      const outputs = Object.values(childContext.nodes).filter(
        (node): node is GraphOutputNode =>
          node.type === 'graphOutput' && !node.disabled && (node as GraphOutputNode).data.id === targetOutputId,
      );
      // Duplicate names have first-final-winner semantics, so cannot relay partials.
      if (outputs.length !== 1) return false;
      const output = outputs[0]!;
      const outputIsFrozen = isFrozen(childProject, child, output);
      const providers = childContext.incoming(output.id).filter((input) => input.inputId === 'value');
      // As in GraphProcessor's effective connection projection, the first
      // valid provider owns a single-input Graph Output in a malformed graph.
      // Never mark a shadowed provider that cannot determine the final value.
      const provider = providers[0];
      const providerNode = provider && childContext.nodes[provider.outputNodeId];
      if (
        !provider ||
        !providerNode ||
        !canForwardGraphOutputPartials(output, providerNode, outputIsFrozen) ||
        !trace(child, provider)
      )
        return false;
      context.marked.add(edge);
      return true;
    } finally {
      graphVisiting.delete(edge);
      if (graphVisiting.size === 0) visiting.delete(candidate);
    }
  };

  for (const { graph: candidate, edge } of watchInputs) trace(candidate, edge);

  return contexts.get(graph)?.marked ?? new Set();
}
