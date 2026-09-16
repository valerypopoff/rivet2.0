import {
  resolveNodePrefabInstance,
  type ChartNode,
  type NodeGraph,
  type NodeId,
  type NodeInputDefinition,
  type NodeOutputDefinition,
  type NodeBody,
  type NodeBodySpec,
  type Project,
  type NodeRegistration,
} from '@valerypopoff/rivet2-core';
import * as yaml from 'yaml';

export function getComparisonNodesById(project: Project, graph: NodeGraph) {
  return Object.fromEntries(
    graph.nodes.map((entry) => [entry.id, resolveNodePrefabInstance(project, entry)]),
  ) as Record<NodeId, ChartNode>;
}

export function getComparisonNodePorts(
  registry: Pick<NodeRegistration, 'createDynamicImpl'>,
  project: Project,
  graph: NodeGraph,
  node: ChartNode,
  nodesById = getComparisonNodesById(project, graph),
): { inputs: NodeInputDefinition[]; outputs: NodeOutputDefinition[] } {
  try {
    const impl = registry.createDynamicImpl(nodesById[node.id] ?? node);
    const connections = graph.connections.filter((c) => c.inputNodeId === node.id || c.outputNodeId === node.id);
    return {
      inputs: impl.getInputDefinitionsIncludingBuiltIn(connections, nodesById, project, {}),
      outputs: impl.getOutputDefinitions(connections, nodesById, project, {}),
    };
  } catch {
    // A missing plugin or external project must not prevent inspecting saved data.
    return { inputs: [], outputs: [] };
  }
}

export function getComparisonNodeFallback(node: ChartNode, project: Project): string {
  if (node.type === 'subGraph') {
    const graphId = (node.data as { graphId?: string }).graphId;
    const target = Object.values(project.graphs).find((graph) => graph.metadata?.id === graphId);
    return `Graph: ${target?.metadata?.name ?? '(unavailable in reference)'}\nID: ${graphId ?? '(not set)'}`;
  }
  const savedSettings = yaml.stringify(node.data) ?? '';
  return `${node.type}${savedSettings ? `\n${savedSettings.trimEnd()}` : ''}`;
}

export function getComparisonBodySpecs(body: NodeBody, fallback: string): NodeBodySpec[] {
  const specs = typeof body === 'string' ? [{ type: 'plain' as const, text: body }] : body ? [body].flat() : [];
  const usefulSpecs = specs.filter((spec) => typeof spec?.text === 'string' && spec.text.trim());
  return (usefulSpecs.length ? usefulSpecs : [{ type: 'plain' as const, text: fallback }]).map((spec) => {
    const text = spec.text.slice(0, 4000).split('\n').slice(0, 12).join('\n');
    const preview = text.length < spec.text.length ? `${text}\n…` : text;
    return spec.type === 'plain' && preview.startsWith('!markdown')
      ? { type: 'markdown', text: preview.slice('!markdown'.length), disableLinks: true }
      : { ...spec, text: preview };
  });
}
