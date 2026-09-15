import { type ChartNode, type GraphId, type NodeGraph, type Project } from '@valerypopoff/rivet2-core';

type TemplateProject = Pick<Project, 'metadata' | 'graphs'>;

type GraphIdMapping = Record<GraphId, GraphId>;

type VariantLike = {
  data: unknown;
};

type ToolHandler = { key: string; value: GraphId };

export function remapTemplateProjectGraphIds(project: TemplateProject, graphIdMapping: GraphIdMapping): void {
  if (project.metadata.mainGraphId) {
    project.metadata.mainGraphId = remapGraphId(project.metadata.mainGraphId, graphIdMapping);
  }

  remapGraphNodeReferences(Object.values(project.graphs), graphIdMapping);
}

/** Remaps references within copied graphs without changing destination project metadata. */
export function remapGraphNodeReferences(graphs: readonly NodeGraph[], graphIdMapping: GraphIdMapping): void {
  for (const graph of graphs) {
    for (const node of graph.nodes) {
      remapNodeGraphIds(node, graphIdMapping);
    }
  }
}

function remapNodeGraphIds(node: ChartNode, graphIdMapping: GraphIdMapping): void {
  remapNodeData(node.type, node.data as Record<string, unknown>, graphIdMapping);

  for (const variant of (node.variants ?? []) as VariantLike[]) {
    remapNodeData(node.type, variant.data as Record<string, unknown>, graphIdMapping);
  }
}

function remapNodeData(nodeType: string, data: Record<string, unknown>, graphIdMapping: GraphIdMapping): void {
  if (data == null || typeof data !== 'object') return;

  switch (nodeType) {
    case 'subGraph':
    case 'graphReference':
      if (typeof data.graphId === 'string') {
        data.graphId = remapGraphId(data.graphId as GraphId, graphIdMapping);
      }
      break;

    case 'loopUntil':
    case 'cron':
      if (typeof data.targetGraph === 'string') {
        data.targetGraph = remapGraphId(data.targetGraph as GraphId, graphIdMapping);
      }
      break;

    case 'delegateFunctionCall':
      remapToolHandlers(data.handlers, graphIdMapping);
      if (typeof data.unknownHandler === 'string') {
        data.unknownHandler = remapGraphId(data.unknownHandler as GraphId, graphIdMapping);
      }
      break;

    case 'openaiRunThread':
      remapToolHandlers(data.toolCallHandlers, graphIdMapping);
      if (typeof data.onMessageCreationSubgraphId === 'string') {
        data.onMessageCreationSubgraphId = remapGraphId(data.onMessageCreationSubgraphId as GraphId, graphIdMapping);
      }
      break;

    default:
      break;
  }
}

function remapToolHandlers(value: unknown, graphIdMapping: GraphIdMapping): void {
  if (!Array.isArray(value)) {
    return;
  }

  for (const handler of value as ToolHandler[]) {
    if (handler && typeof handler.value === 'string') {
      handler.value = remapGraphId(handler.value, graphIdMapping);
    }
  }
}

function remapGraphId(graphId: GraphId, graphIdMapping: GraphIdMapping): GraphId {
  return Object.hasOwn(graphIdMapping, graphId) ? graphIdMapping[graphId]! : graphId;
}
