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
import { createGraphOutputSelection } from './GraphOutputSelection.js';

export function canStreamThroughGraphCaller(node: ChartNode): node is SubGraphNode | ReferencedGraphAliasNode {
  return (
    (node.type === 'subGraph' || node.type === 'referencedGraphAlias') &&
    !node.disabled &&
    !node.isConditional &&
    !node.isSplitRun &&
    !(node as SubGraphNode).data.useErrorOutput
  );
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
      const owner = caller.type === 'subGraph' ? context.project : projects[caller.data.projectId];
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
        const outputNames = new Set(
          Object.values(childContext.nodes)
            .filter((node) => node.type === 'graphOutput')
            .map((node) => (node as GraphOutputNode).data.id),
        );
        const outputs = parent.connections
          .filter((edge) => edge.outputNodeId === caller.id)
          .map((edge) => edge.outputId)
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

  const pending: Array<{ graph: NodeGraph; edge: NodeConnection }> = [];
  for (const [candidate, context] of contexts) {
    for (const node of Object.values(context.nodes)) {
      if (node.type !== 'watchStreamingOutput' || node.disabled || isFrozen(context.project, candidate, node)) continue;
      const inputs = context.incoming(node.id).filter((edge) => edge.inputId === 'stream');
      // Multiple providers are rejected by the Watch scheduler, not multiple streams.
      if (inputs.length === 1) pending.push({ graph: candidate, edge: inputs[0]! });
    }
  }

  while (pending.length) {
    const { graph: candidate, edge } = pending.pop()!;
    const context = contexts.get(candidate)!;
    if (context.marked.has(edge)) continue;
    const route = new Set([edge]);
    let producerEdge = edge;
    let source = context.nodes[producerEdge.outputNodeId];
    while (source && canRenderDataBusNode(source)) {
      const channel = getDataBusOutputChannelIndex(producerEdge.outputId);
      const providers = context
        .incoming(source.id)
        .filter((input) => getDataBusInputChannelIndex(input.inputId) === channel);
      if (channel == null || providers.length !== 1 || route.has(providers[0]!)) {
        source = undefined;
        break;
      }
      producerEdge = providers[0]!;
      route.add(producerEdge);
      source = context.nodes[producerEdge.outputNodeId];
    }
    if (!source || source.disabled || source.type === 'dataBus') continue;
    if (context.nodes[edge.inputNodeId]?.type === 'graphOutput' && source.isSplitRun) continue;
    for (const segment of route) context.marked.add(segment);
    if (source.isSplitRun || isFrozen(context.project, candidate, source)) continue;

    if (source.type === 'graphInput' && producerEdge.outputId === 'data') {
      if (!canStreamThroughGraphInput(source)) continue;
      const inputName = (source as GraphInputNode).data.id;
      for (const parent of callers.get(candidate) ?? []) {
        if (parent.selected && !parent.selected.has(edge.inputNodeId)) continue;
        for (const input of contexts.get(parent.graph)!.incoming(parent.node.id)) {
          if (input.inputId === inputName) pending.push({ graph: parent.graph, edge: input });
        }
      }
      continue;
    }

    if (!canStreamThroughGraphCaller(source)) continue;
    const caller = source;
    const childProject = caller.type === 'subGraph' ? context.project : projects[caller.data.projectId];
    const child = childProject?.graphs[caller.data.graphId];
    const childContext = child && contexts.get(child);
    if (!child || !childContext) continue;
    const outputs = Object.values(childContext.nodes).filter(
      (node): node is GraphOutputNode =>
        node.type === 'graphOutput' && !node.disabled && (node as GraphOutputNode).data.id === producerEdge.outputId,
    );
    // Duplicate names have first-final-winner semantics, so cannot relay partials.
    if (outputs.length !== 1) continue;
    const output = outputs[0]!;
    if (output.isConditional || output.isSplitRun || isFrozen(childProject, child, output)) continue;
    for (const input of childContext.incoming(output.id)) {
      if (input.inputId === 'value' && !childContext.nodes[input.outputNodeId]?.isSplitRun) {
        pending.push({ graph: child, edge: input });
      }
    }
  }

  return contexts.get(graph)?.marked ?? new Set();
}
