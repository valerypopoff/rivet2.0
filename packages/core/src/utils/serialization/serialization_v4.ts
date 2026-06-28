import { mapValues } from 'lodash-es';
import type {
  NodeGraph,
  Project,
  GraphId,
  NodeId,
  NodeConnection,
  ChartNode,
  ProjectId,
  ChartNodeVariant,
  NodePrefabId,
  UiGraph,
  UiGraphId,
} from '../../index.js';
import { type AttachedData, doubleCheckProject } from './serializationUtils.js';
import { entries } from '../typeSafety.js';
import type { PluginLoadSpec } from '../../model/PluginLoadSpec.js';
import type { CombinedDataset } from './serialization.js';
import { type ProjectMetadata } from '../../model/Project.js';
import {
  type SerializedNodeConnection,
  serializeConnection,
  deserializeConnection,
  parseVisualData,
  packVisualDataV4,
  wrapInYamlEnvelope,
  unwrapYamlEnvelope,
} from './serializationHelpers.js';

type SerializedProject = {
  metadata: ProjectMetadata;

  graphs: Record<GraphId, SerializedGraph>;
  nodePrefabs?: Record<NodePrefabId, SerializedNodePrefab>;
  uiGraphs?: Record<UiGraphId, UiGraph>;

  attachedData?: AttachedData;
  plugins?: PluginLoadSpec[];
  references?: SerializedProjectReference[];
};

type SerializedProjectReference = {
  id: ProjectId;
  hintPaths?: string[];
  title?: string;
};

type SerializedGraphMetadata = {
  id: GraphId;
  name: string;
  description: string;
  attachedData?: AttachedData;
};

type SerializedGraph = {
  metadata: SerializedGraphMetadata;
  nodes: Record<SerializedGraphNodeKey, SerializedNode>;
};

type SerializedNode = {
  description?: string;
  isSplitRun?: boolean;
  splitRunMax?: number;
  splitRunConcurrency?: number;
  isSplitSequential?: boolean;
  visualData: string;
  outgoingConnections: SerializedNodeConnection[] | undefined;
  data?: unknown;
  variants?: ChartNodeVariant<unknown>[];
  disabled?: boolean;
  isConditional?: boolean;
};

type SerializedNodePrefab = {
  id: NodePrefabId;
  sourceNode: SerializedIsolatedNode;
};

type SerializedIsolatedNode = Omit<SerializedNode, 'outgoingConnections'> & {
  id: NodeId;
  type: string;
  title: string;
};

export function projectV4Deserializer(data: unknown): [Project, AttachedData] {
  const serializedProject = unwrapYamlEnvelope<SerializedProject>(data, 4, 'Project v4');
  const [project, attachedData] = fromSerializedProject(serializedProject);
  doubleCheckProject(project);
  return [project, attachedData];
}

export function graphV4Deserializer(data: unknown): NodeGraph {
  const serializedGraph = unwrapYamlEnvelope<SerializedGraph>(data, 4, 'Graph v4');
  return fromSerializedGraph(serializedGraph);
}

export function projectV4Serializer(project: Project, attachedData?: AttachedData): unknown {
  const filteredProject = {
    ...project,
    metadata: {
      ...project.metadata,
      path: undefined,
    },
  };

  return wrapInYamlEnvelope(4, toSerializedProject(filteredProject, attachedData));
}

export function graphV4Serializer(graph: NodeGraph): unknown {
  return wrapInYamlEnvelope(4, toSerializedGraph(graph));
}

function toSerializedProject(project: Project, attachedData?: AttachedData): SerializedProject {
  const nodePrefabs = mapValues(project.nodePrefabs ?? {}, (prefab) => ({
    id: prefab.id,
    sourceNode: toSerializedIsolatedNode(prefab.sourceNode),
  }));

  return {
    metadata: project.metadata,
    graphs: mapValues(project.graphs, (graph) => toSerializedGraph(graph)),
    nodePrefabs: Object.keys(nodePrefabs).length > 0 ? nodePrefabs : undefined,
    uiGraphs: project.uiGraphs && Object.keys(project.uiGraphs).length > 0 ? project.uiGraphs : undefined,
    attachedData,
    plugins: project.plugins ?? [],
    references: project.references ?? [],
  };
}

function fromSerializedProject(serializedProject: SerializedProject): [Project, AttachedData] {
  const nodePrefabs = mapValues(serializedProject.nodePrefabs ?? {}, (prefab) => ({
    id: prefab.id,
    sourceNode: fromSerializedIsolatedNode(prefab.sourceNode),
  }));

  return [
    {
      metadata: serializedProject.metadata,
      graphs: mapValues(serializedProject.graphs, (graph) => fromSerializedGraph(graph)) as Record<GraphId, NodeGraph>,
      nodePrefabs: Object.keys(nodePrefabs).length > 0 ? nodePrefabs : undefined,
      uiGraphs:
        serializedProject.uiGraphs && Object.keys(serializedProject.uiGraphs).length > 0
          ? serializedProject.uiGraphs
          : undefined,
      plugins: serializedProject.plugins ?? [],
      references: serializedProject.references ?? [],
    },
    serializedProject.attachedData ?? {},
  ];
}

function toSerializedIsolatedNode(node: ChartNode): SerializedIsolatedNode {
  const { outgoingConnections: _outgoingConnections, ...serializedNode } = toSerializedNode(node, [node], []);

  return {
    ...serializedNode,
    id: node.id,
    type: node.type,
    title: node.title,
  };
}

function fromSerializedIsolatedNode(serializedNode: SerializedIsolatedNode): ChartNode {
  const [node] = fromSerializedNode(
    {
      ...serializedNode,
      outgoingConnections: undefined,
    },
    `[${serializedNode.id}]:${serializedNode.type} "${serializedNode.title}"`,
  );

  return node;
}

function toSerializedGraph(graph: NodeGraph): SerializedGraph {
  const graphMetadata: SerializedGraphMetadata = {
    id: graph.metadata!.id!,
    name: graph.metadata!.name!,
    description: graph.metadata!.description!,
  };

  if (graph.metadata!.attachedData) {
    graphMetadata.attachedData = graph.metadata!.attachedData;
  }

  return {
    metadata: graphMetadata,
    nodes: graph.nodes.reduce(
      (acc, node) => ({
        ...acc,
        [getGraphNodeKey(node)]: toSerializedNode(node, graph.nodes, graph.connections),
      }),
      {} as Record<NodeId, SerializedNode>,
    ),
  };
}

/** [nodeId]:type "Title of Node" */
type SerializedGraphNodeKey = `[${NodeId}]:${string} "${string}"`;

function getGraphNodeKey(node: ChartNode): string {
  return `[${node.id}]:${node.type} "${node.title}"`;
}

function deserializeGraphNodeKey(key: string): [NodeId, string, string] {
  const { nodeId, type, title } = key.match(/^\[(?<nodeId>[^\]]+)\]:(?<type>[^\s]+) "(?<title>.*)"$/)?.groups ?? {};
  if (!nodeId || !type || title == null) {
    throw new Error(`Invalid graph node key: ${key}`);
  }
  return [nodeId as NodeId, type, title];
}

function fromSerializedGraph(serializedGraph: SerializedGraph): NodeGraph {
  const allConnections: NodeConnection[] = [];
  const allNodes: ChartNode[] = [];

  for (const [serializedNodeInfo, node] of entries(serializedGraph.nodes)) {
    const [chartNode, connections] = fromSerializedNode(node, serializedNodeInfo);
    allNodes.push(chartNode);
    allConnections.push(...connections);
  }

  const metadata: SerializedGraphMetadata = {
    id: serializedGraph.metadata.id,
    name: serializedGraph.metadata.name,
    description: serializedGraph.metadata.description,
  };

  if (serializedGraph.metadata.attachedData) {
    metadata.attachedData = serializedGraph.metadata.attachedData;
  }

  return {
    metadata,
    nodes: allNodes,
    connections: allConnections,
  };
}

function toSerializedNode(node: ChartNode, allNodes: ChartNode[], allConnections: NodeConnection[]): SerializedNode {
  const outgoingConnections = allConnections
    .filter((connection) => connection.outputNodeId === node.id)
    .map((connection) => serializeConnection(connection, allNodes))
    .sort();
  return {
    description: node.description?.trim() ? node.description : undefined,
    visualData: packVisualDataV4(node),
    isSplitRun: node.isSplitRun ? true : undefined,
    splitRunMax: node.isSplitRun ? node.splitRunMax : undefined,
    splitRunConcurrency: node.isSplitRun ? node.splitRunConcurrency : undefined,
    isSplitSequential: node.isSplitSequential ? true : undefined,
    data: Object.keys(node.data ?? {}).length > 0 ? node.data : undefined,
    outgoingConnections: outgoingConnections.length > 0 ? outgoingConnections : undefined,
    variants: (node.variants?.length ?? 0) > 0 ? node.variants : undefined,
    disabled: node.disabled ? true : undefined,
    isConditional: node.isConditional,
  };
}

function fromSerializedNode(
  serializedNode: SerializedNode,
  serializedNodeInfo: SerializedGraphNodeKey,
): [ChartNode, NodeConnection[]] {
  const [nodeId, type, title] = deserializeGraphNodeKey(serializedNodeInfo);

  const { x, y, width, zIndex, borderColor, bgColor } = parseVisualData(serializedNode.visualData);

  const connections = serializedNode.outgoingConnections?.map((conn) => deserializeConnection(conn, nodeId)) ?? [];

  const color = borderColor || bgColor ? { border: borderColor!, bg: bgColor! } : undefined;

  return [
    {
      id: nodeId,
      type,
      title,
      description: serializedNode.description,
      isSplitRun: serializedNode.isSplitRun ?? false,
      splitRunMax: serializedNode.splitRunMax ?? 10,
      splitRunConcurrency: serializedNode.splitRunConcurrency,
      isSplitSequential: serializedNode.isSplitSequential ?? false,
      visualData: {
        x,
        y,
        width,
        zIndex,
        color,
      },
      data: serializedNode.data ?? {},
      variants: serializedNode.variants ?? [],
      disabled: serializedNode.disabled,
      isConditional: serializedNode.isConditional,
    },
    connections,
  ];
}

export function datasetV4Serializer(datasets: CombinedDataset[]): string {
  return JSON.stringify({ datasets });
}

export function datasetV4Deserializer(serializedDatasets: string): CombinedDataset[] {
  const dataContainer = JSON.parse(serializedDatasets) as { datasets: CombinedDataset[] };
  if (!dataContainer.datasets) {
    throw new Error('Invalid dataset data');
  }
  return dataContainer.datasets;
}
