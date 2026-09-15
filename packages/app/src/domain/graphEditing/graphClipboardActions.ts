import { type GraphId, type NodeGraph, type NodeId } from '@valerypopoff/rivet2-core';
import { nanoid } from 'nanoid/non-secure';
import type { GraphsClipboardItem } from '../../state/clipboard.js';
import { remapGraphNodeReferences } from '../../utils/templateProjectGraphIds.js';

export function copyGraphToClipboard(graph: NodeGraph, currentGraph: NodeGraph): GraphsClipboardItem | undefined {
  const source = currentGraph.metadata?.id === graph.metadata?.id ? currentGraph : graph;
  if (!source.metadata?.id || !source.metadata.name) return undefined;

  return { type: 'graphs', source: 'graph', graphs: structuredClone([source]) };
}

export function copyFolderToClipboard(
  folderPath: string,
  savedGraphs: readonly NodeGraph[],
  currentGraph: NodeGraph,
): GraphsClipboardItem | undefined {
  const graphs = savedGraphs
    .filter((graph) => graph.metadata?.name?.startsWith(`${folderPath}/`) && graph.metadata.id)
    .map((graph) => (graph.metadata!.id === currentGraph.metadata?.id ? currentGraph : graph));
  if (graphs.length === 0) return undefined;

  return { type: 'graphs', source: 'folder', sourceFolderPath: folderPath, graphs: structuredClone(graphs) };
}

export function buildPastedGraphs(options: {
  clipboard: GraphsClipboardItem;
  destinationFolderPath?: string;
  destinationGraphs: readonly NodeGraph[];
  destinationFolderPaths: readonly string[];
}): NodeGraph[] {
  const { clipboard, destinationFolderPath, destinationGraphs, destinationFolderPaths } = options;
  if (clipboard.graphs.length === 0) return [];

  const occupiedPaths = new Set([
    ...destinationFolderPaths,
    ...destinationGraphs.map((graph) => graph.metadata?.name).filter((name): name is string => !!name),
  ]);
  const destinationPrefix = destinationFolderPath ? `${destinationFolderPath}/` : '';
  const sourceFolderPath = clipboard.source === 'folder' ? clipboard.sourceFolderPath : undefined;

  const baseName =
    clipboard.source === 'folder'
      ? clipboard.sourceFolderPath.split('/').at(-1)
      : clipboard.graphs[0]?.metadata?.name?.split('/').at(-1);
  if (!baseName) return [];

  const collides = (path: string) =>
    occupiedPaths.has(path) ||
    (clipboard.source === 'folder' && [...occupiedPaths].some((occupied) => occupied.startsWith(`${path}/`)));
  const basePath = `${destinationPrefix}${baseName}`;
  let pasteRoot = basePath;
  for (let copyNumber = 1; collides(pasteRoot); copyNumber++) {
    pasteRoot = `${basePath} (Copy${copyNumber === 1 ? '' : ` ${copyNumber}`})`;
  }

  const graphs = structuredClone(clipboard.graphs);
  const occupiedGraphIds = new Set([
    ...destinationGraphs.map((graph) => graph.metadata?.id).filter(Boolean),
    ...graphs.map((graph) => graph.metadata?.id).filter(Boolean),
  ]);
  const occupiedNodeIds = new Set<NodeId>([
    ...destinationGraphs.flatMap((graph) => graph.nodes.map((node) => node.id)),
    ...graphs.flatMap((graph) => graph.nodes.map((node) => node.id)),
  ]);
  const graphIdMapping = Object.create(null) as Record<GraphId, GraphId>;

  for (const graph of graphs) {
    const oldGraphId = graph.metadata?.id;
    if (!oldGraphId || !graph.metadata?.name) return [];

    let newGraphId = nanoid() as GraphId;
    while (occupiedGraphIds.has(newGraphId)) newGraphId = nanoid() as GraphId;
    occupiedGraphIds.add(newGraphId);
    graphIdMapping[oldGraphId] = newGraphId;

    graph.metadata.id = newGraphId;
    graph.metadata.name = sourceFolderPath
      ? `${pasteRoot}/${graph.metadata.name.slice(sourceFolderPath.length + 1)}`
      : pasteRoot;

    const nodeIdMapping = new Map<NodeId, NodeId>();
    for (const node of graph.nodes) {
      let newNodeId = nanoid() as NodeId;
      while (occupiedNodeIds.has(newNodeId)) newNodeId = nanoid() as NodeId;
      occupiedNodeIds.add(newNodeId);
      nodeIdMapping.set(node.id, newNodeId);
      node.id = newNodeId;
    }
    for (const connection of graph.connections) {
      connection.inputNodeId = nodeIdMapping.get(connection.inputNodeId) ?? connection.inputNodeId;
      connection.outputNodeId = nodeIdMapping.get(connection.outputNodeId) ?? connection.outputNodeId;
    }
  }

  remapGraphNodeReferences(graphs, graphIdMapping);
  return graphs;
}
