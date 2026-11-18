import {
  compileDataBusTopology,
  DELEGATE_TOOL_CALL_INPUT_ID,
  deserializeDatasets,
  resolveNodePrefabInstances,
  resolveToolContinuationConnections,
  type ChartNode,
  type DelegateFunctionCallNode,
  type GraphId,
  type GraphReferenceNode,
  type LLMChatV2NodeData,
  type NodeConnection,
  type NodeId,
  type Project,
} from '@valerypopoff/rivet2-node';
import { badRequest, conflict, createHttpError } from '../../utils/httpError.js';

type EndpointGraphCall = {
  node: ChartNode;
  targetGraphId: GraphId;
  targetProjectId?: string;
  selector?: 'latest' | 'published' | 'project-reference';
};

type GraphCallData = {
  graphId?: GraphId;
  targetGraph?: GraphId;
  targetProjectId?: string;
  projectId?: string;
  targetScope?: string;
  targetVersion?: string;
};

/** Match built-in graph call routes using the same prefab and Data Bus topology as execution. */
export function listEndpointGraphCalls(project: Project, graphId: GraphId) {
  const graph = Object.hasOwn(project.graphs, graphId) ? project.graphs[graphId] : undefined;
  if (!graph)
    throw badRequest(`Graph ${graphId} is missing from project ${project.metadata.title || project.metadata.id}.`);
  const graphName = graph.metadata?.name ?? graphId;
  const { executionNodes, connections } = (() => {
    try {
      return compileDataBusTopology({
        graphNodes: resolveNodePrefabInstances(project, graph.nodes),
        connections: graph.connections,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw badRequest(`${project.metadata.title || project.metadata.id} / ${graphName}: ${message}`);
    }
  })();
  const nodes = new Map(executionNodes.map((node) => [node.id, node]));
  const incoming = new Map<NodeId, NodeConnection[]>();
  for (const connection of connections) {
    if (!nodes.has(connection.outputNodeId)) continue;
    const wires = incoming.get(connection.inputNodeId) ?? [];
    wires.push(connection);
    incoming.set(connection.inputNodeId, wires);
  }
  const continuations = resolveToolContinuationConnections({ nodes: executionNodes, connections });
  const calls: EndpointGraphCall[] = [];
  let callsAnyLocalGraph = false;
  for (const node of executionNodes) {
    if (node.disabled) continue;
    const data = node.data as GraphCallData;
    const addLocal = (targetGraphId: GraphId | undefined) => {
      if (targetGraphId) calls.push({ node, targetGraphId });
    };
    if (node.type === 'subGraph') {
      if (!data.graphId || (data.targetScope && !data.targetProjectId))
        throw badRequest(`Select a graph for ${node.title} in ${graphName}.`);
      if (data.targetVersion && data.targetVersion !== 'latest' && data.targetVersion !== 'published')
        throw badRequest(`Invalid Subgraph version for ${node.title} in ${graphName}.`);
      calls.push({
        node,
        targetGraphId: data.graphId,
        targetProjectId: data.targetProjectId,
        selector: data.targetVersion === 'published' ? 'published' : 'latest',
      });
    } else if (node.type === 'referencedGraphAlias') {
      if (!data.projectId || !data.graphId)
        throw badRequest(`Select a referenced graph for ${node.title} in ${graphName}.`);
      calls.push({ node, targetGraphId: data.graphId, targetProjectId: data.projectId, selector: 'project-reference' });
    } else if (node.type === 'loopUntil' || node.type === 'cron') {
      addLocal(data.targetGraph);
    } else if (node.type === 'callGraph') {
      const wires = incoming.get(node.id)?.filter((wire) => wire.inputId === 'graph');
      if (!wires?.length) continue;
      const source = wires.length === 1 ? nodes.get(wires[0]!.outputNodeId) : undefined;
      if (source?.disabled) continue;
      if (source?.type === 'graphReference' && wires[0]!.outputId === 'graph') {
        const reference = (source as GraphReferenceNode).data;
        if (!reference.useGraphIdOrNameInput) {
          // A missing fixed graph yields excluded control flow.
          if (Object.hasOwn(project.graphs, reference.graphId)) addLocal(reference.graphId);
          continue;
        }
      }
      callsAnyLocalGraph = true;
    } else if (node.type === 'delegateFunctionCall') {
      if (!incoming.get(node.id)?.some((wire) => wire.inputId === DELEGATE_TOOL_CALL_INPUT_ID)) continue;
      const delegate = (node as DelegateFunctionCallNode).data;
      if (delegate.autoDelegate) {
        callsAnyLocalGraph = true;
      } else {
        for (const handler of delegate.handlers ?? []) addLocal(handler.value);
      }
      addLocal(delegate.unknownHandler);
    } else if (node.type === 'llmChatV2') {
      const llm = node.data as LLMChatV2NodeData;
      // Without an effective continuation wire, the LLM resolves tool graphs by name itself.
      if (llm.useToolCalling && llm.autoContinueToolCalls && !continuations.has(node.id)) {
        callsAnyLocalGraph = true;
      }
    } else if (node.type === 'openaiRunThread') {
      const thread = node.data as {
        toolCallHandlers?: { value: GraphId }[];
        onMessageCreationSubgraphId?: GraphId;
      };
      for (const handler of thread.toolCallHandlers ?? []) addLocal(handler.value);
      addLocal(thread.onMessageCreationSubgraphId);
    }
  }
  return { calls, callsAnyLocalGraph };
}

export function assertEndpointDatasetReadable(contents: string | null, invalidStatus: 409 | 503 = 503): void {
  if (contents === null) return;
  try {
    if (Array.isArray(deserializeDatasets(contents))) return;
  } catch {
    // Parser messages may contain the saved payload.
  }
  throw createHttpError(invalidStatus, 'The captured endpoint dataset is invalid.');
}

export function assertLegacyEndpointCanBeRestored(project: Project, datasetsContents: string | null = null): void {
  // Older readers treat a zero-byte dataset file as absent.
  assertEndpointDatasetReadable(datasetsContents || null);
  const reject = () => {
    throw conflict('This history entry contains the project only. Its earlier dependency revisions were not captured.');
  };
  if (project.references?.length) reject();
  const rootGraph = project.metadata.mainGraphId;
  if (!rootGraph) throw badRequest('The revision has no endpoint entry graph.');
  const seen = new Set<GraphId>();
  const pending = [rootGraph];
  let queuedAllLocalGraphs = false;
  while (pending.length) {
    const graphId = pending.pop()!;
    if (seen.has(graphId)) continue;
    seen.add(graphId);
    const { calls, callsAnyLocalGraph } = listEndpointGraphCalls(project, graphId);
    if (callsAnyLocalGraph && !queuedAllLocalGraphs) {
      queuedAllLocalGraphs = true;
      for (const id of Object.keys(project.graphs) as GraphId[]) pending.push(id);
    }
    for (const call of calls) {
      if (call.targetProjectId) reject();
      pending.push(call.targetGraphId);
    }
  }
}
