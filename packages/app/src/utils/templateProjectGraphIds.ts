import { type ChartNode, type GraphId, type Project } from '@valerypopoff/rivet2-core';

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

  for (const graph of Object.values(project.graphs)) {
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
    if (typeof handler.value === 'string') {
      handler.value = remapGraphId(handler.value, graphIdMapping);
    }
  }
}

function remapGraphId(graphId: GraphId, graphIdMapping: GraphIdMapping): GraphId {
  return graphIdMapping[graphId] ?? graphId;
}
