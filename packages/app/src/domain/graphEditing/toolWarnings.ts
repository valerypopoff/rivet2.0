import {
  resolveToolContinuationConnections,
  type ChartNode,
  type NodeGraph,
  type NodeId,
  type Project,
} from '@valerypopoff/rivet2-core';

type ToolNodeData = {
  name?: unknown;
  useNameInput?: unknown;
};

type DelegateToolCallNodeData = {
  autoDelegate?: unknown;
};

type LLMChatToolUseNodeData = {
  useToolCalling?: unknown;
};

function getEnabledStaticToolName(node: ChartNode): string | undefined {
  if (node.type !== 'gptFunction' || node.disabled) {
    return undefined;
  }

  const data = node.data as ToolNodeData;
  if (data.useNameInput === true || typeof data.name !== 'string' || !data.name.trim()) {
    return undefined;
  }

  return data.name;
}

/**
 * Finds static Tool nodes whose names collide in at least one actual LLM Chat
 * Tool registry. Tools in separate registries are deliberately allowed to
 * reuse a name, and unused Tools do not create a misleading warning.
 */
export function getDuplicateToolNodeIds(graph: NodeGraph | undefined): Set<NodeId> {
  const duplicateNodeIds = new Set<NodeId>();
  if (graph == null) {
    return duplicateNodeIds;
  }
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));

  for (const llmNode of graph.nodes) {
    if (
      llmNode.type !== 'llmChatV2' ||
      llmNode.disabled ||
      (llmNode.data as LLMChatToolUseNodeData).useToolCalling !== true
    ) {
      continue;
    }

    const nodeIdsByName = new Map<string, NodeId[]>();
    for (const toolNodeId of getToolNodeIdsUpstreamFromLLMToolsInput(graph, llmNode.id)) {
      const toolNode = nodesById.get(toolNodeId);
      if (toolNode == null) {
        continue;
      }
      const name = getEnabledStaticToolName(toolNode);
      if (name == null) {
        continue;
      }

      const nodeIds = nodeIdsByName.get(name) ?? [];
      nodeIds.push(toolNodeId);
      nodeIdsByName.set(name, nodeIds);
    }

    for (const nodeIds of nodeIdsByName.values()) {
      if (nodeIds.length > 1) {
        for (const nodeId of nodeIds) {
          duplicateNodeIds.add(nodeId);
        }
      }
    }
  }

  return duplicateNodeIds;
}

export function getDuplicateToolNameWarning(node: ChartNode, duplicateToolNodeIds: ReadonlySet<NodeId>): string | undefined {
  const name = getEnabledStaticToolName(node);
  return name != null && duplicateToolNodeIds.has(node.id)
    ? `Another Tool in this LLM Chat's Tools input uses the name "${name}".`
    : undefined;
}

function getToolNodeIdsUpstreamFromLLMToolsInput(graph: NodeGraph, llmNodeId: NodeId): Set<NodeId> {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const queue = graph.connections
    .filter((connection) => connection.inputNodeId === llmNodeId && connection.inputId === 'functions')
    .map((connection) => connection.outputNodeId);
  const visited = new Set<NodeId>();
  const toolNodeIds = new Set<NodeId>();

  while (queue.length > 0) {
    const nodeId = queue.pop()!;
    if (visited.has(nodeId)) {
      continue;
    }
    visited.add(nodeId);

    const node = nodesById.get(nodeId);
    if (node?.type === 'gptFunction') {
      toolNodeIds.add(nodeId);
      continue;
    }

    for (const connection of graph.connections) {
      if (connection.inputNodeId === nodeId) {
        queue.push(connection.outputNodeId);
      }
    }
  }

  return toolNodeIds;
}

/**
 * Returns warnings only for Tool nodes that feed an eligible connected LLM
 * continuation. Dynamic tool names are intentionally not warned because their
 * handler cannot be statically determined. External and unknown fallbacks do
 * not suppress this warning: they are fallbacks, not a named graph handler.
 */
export function getMissingAutoDelegateToolGraphWarnings(
  graph: NodeGraph | undefined,
  project: Pick<Project, 'graphs'> | undefined,
): ReadonlyMap<NodeId, string> {
  const warnings = new Map<NodeId, string>();
  if (graph == null || project == null) {
    return warnings;
  }

  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const [llmNodeId, resolution] of resolveToolContinuationConnections(graph)) {
    if (resolution.kind !== 'connected') {
      continue;
    }

    const config = resolution.delegateNode.data as DelegateToolCallNodeData;
    if (config.autoDelegate !== true) {
      continue;
    }

    for (const toolNodeId of getToolNodeIdsUpstreamFromLLMToolsInput(graph, llmNodeId)) {
      const toolNode = nodesById.get(toolNodeId);
      if (toolNode == null) {
        continue;
      }
      const toolName = getEnabledStaticToolName(toolNode);
      if (toolName == null) {
        continue;
      }

      const hasExactHandler = Object.values(project.graphs).some(
        (candidate) => candidate.metadata?.name === toolName,
      );
      if (!hasExactHandler) {
        warnings.set(
          toolNodeId,
          `Auto Delegate needs a graph named "${toolName}" for Tool "${toolName}". External Call and Unknown Handler settings are fallbacks, not named graph handlers.`,
        );
      }
    }
  }

  return warnings;
}

export function getToolNodeHeaderWarning(params: {
  node: ChartNode;
  duplicateToolNodeIds: ReadonlySet<NodeId>;
  missingAutoDelegateToolGraphWarnings: ReadonlyMap<NodeId, string>;
}): string | undefined {
  const warnings = [
    getDuplicateToolNameWarning(params.node, params.duplicateToolNodeIds),
    params.missingAutoDelegateToolGraphWarnings.get(params.node.id),
  ].filter((warning): warning is string => warning != null);

  return warnings.length > 0 ? warnings.join('\n\n') : undefined;
}
