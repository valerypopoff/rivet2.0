// @ts-ignore
import * as yaml from 'yaml';
import { graphV3Deserializer, projectV3Deserializer } from './serialization_v3.js';
import type { Project, NodeGraph, Dataset, DatasetMetadata, ChartNode } from '../../index.js';
import { getError } from '../errors.js';
import {
  type AttachedData,
  ProjectValidationError,
  type SerializationVersion,
  yamlProblem,
} from './serializationUtils.js';
import { prepareSerializedInput } from './serializationInput.js';
import { UiGraphNormalizationError } from '../../model/UiGraphNormalization.js';
import {
  datasetV4Deserializer,
  datasetV4Serializer,
  graphV4Deserializer,
  graphV4Serializer,
  projectV4Deserializer,
  projectV4Serializer,
} from './serialization_v4.js';
import { graphV2Deserializer, projectV2Deserializer } from './serialization_v2.js';
import { graphV1Deserializer, projectV1Deserializer } from './serialization_v1.js';

export function serializeProject(project: Project, attachedData?: AttachedData): unknown {
  return projectV4Serializer(project, attachedData);
}

const errMessage = (err: unknown) => `${getError(err).message}\n${getError(err).stack}`;

export function deserializeProject(serializedProject: unknown, path: string | null = null): [Project, AttachedData] {
  const { deserializerInput, version } = prepareSerializedInput(serializedProject);

  try {
    const result = deserializeProjectByVersion(deserializerInput, version);
    normalizeDeserializedProject(result[0]);
    if (path !== null) {
      result[0].metadata.path = path;
    }
    return result;
  } catch (err) {
    if (err instanceof yaml.YAMLError) {
      yamlProblem(err);
    }
    console.warn(`Failed to deserialize project v${version}: ${errMessage(err)}`);
    if (err instanceof UiGraphNormalizationError) {
      throw new Error(`Could not deserialize project: ${err.message}`, { cause: err });
    }
    if (err instanceof ProjectValidationError) {
      throw new Error(`Could not deserialize project: ${err.message}`, { cause: err });
    }
    throw new Error('Could not deserialize project');
  }
}

export function serializeGraph(graph: NodeGraph): unknown {
  return graphV4Serializer(graph);
}

export function deserializeGraph(serializedGraph: unknown): NodeGraph {
  const { deserializerInput, version } = prepareSerializedInput(serializedGraph);

  try {
    const graph = deserializeGraphByVersion(deserializerInput, version);
    normalizeDeserializedGraph(graph);
    return graph;
  } catch (err) {
    if (err instanceof yaml.YAMLError) {
      yamlProblem(err);
    }
    console.warn(`Failed to deserialize graph v${version}: ${errMessage(err)}`);
    throw new Error('Could not deserialize graph');
  }
}

function normalizeDeserializedProject(project: Project): void {
  for (const graph of Object.values(project.graphs)) {
    normalizeDeserializedGraph(graph);
  }

  for (const prefab of Object.values(project.nodePrefabs ?? {})) {
    normalizeDeserializedNode(prefab.sourceNode);
  }
}

function normalizeDeserializedGraph(graph: NodeGraph): void {
  for (const node of graph.nodes) {
    normalizeDeserializedNode(node);
  }
}

type LegacyPassthroughData = Record<string, unknown> & {
  renderAsDataBus?: unknown;
};

type LegacyLLMChatV2DiagnosticsData = Record<string, unknown> & {
  outputRequestStatus?: unknown;
  outputRequestError?: unknown;
  outputRequestBody?: unknown;
};

function hasLegacyDataBusFlag(node: ChartNode): node is ChartNode<'passthrough', LegacyPassthroughData> {
  const data = node.data as LegacyPassthroughData | undefined;
  return node.type === 'passthrough' && data != null && Object.hasOwn(data, 'renderAsDataBus');
}

function migrateLegacyLLMChatV2Diagnostics(node: ChartNode): void {
  if (node.type !== 'llmChatV2' || node.data == null || typeof node.data !== 'object') {
    return;
  }

  const data = node.data as LegacyLLMChatV2DiagnosticsData;
  if (data.outputRequestStatus !== true) {
    return;
  }

  // Output request details used to expose all three diagnostics together.
  // Materialize the split settings on load so existing output connections and
  // editor-visible behavior remain unchanged after the setting was separated.
  if (!Object.hasOwn(data, 'outputRequestError')) {
    data.outputRequestError = true;
  }
  if (!Object.hasOwn(data, 'outputRequestBody')) {
    data.outputRequestBody = true;
  }
}

function normalizeDeserializedNode(node: ChartNode): void {
  if (node.type === 'code' && node.title === 'Code') {
    node.title = 'Code (legacy)';
  } else if (node.type === 'codeNew' && node.title === 'Code new') {
    node.title = 'Code';
  }

  if (hasLegacyDataBusFlag(node)) {
    const { renderAsDataBus: _legacyFlag, ...data } = node.data;
    (node as ChartNode).data = data;
  }

  migrateLegacyLLMChatV2Diagnostics(node);
}

function deserializeProjectByVersion(
  serializedProject: unknown,
  version: SerializationVersion,
): [Project, AttachedData] {
  switch (version) {
    case 4:
      return projectV4Deserializer(serializedProject);
    case 3:
      return [projectV3Deserializer(serializedProject), {}];
    case 2:
      return [projectV2Deserializer(serializedProject), {}];
    case 1:
    default:
      return [projectV1Deserializer(serializedProject), {}];
  }
}

function deserializeGraphByVersion(serializedGraph: unknown, version: SerializationVersion): NodeGraph {
  switch (version) {
    case 4:
      return graphV4Deserializer(serializedGraph);
    case 3:
      return graphV3Deserializer(serializedGraph);
    case 2:
      return graphV2Deserializer(serializedGraph);
    case 1:
    default:
      return graphV1Deserializer(serializedGraph);
  }
}

export type CombinedDataset = {
  meta: DatasetMetadata;
  data: Dataset;
};

export function serializeDatasets(datasets: CombinedDataset[]): string {
  return datasetV4Serializer(datasets);
}

export function deserializeDatasets(serializedDatasets: string): CombinedDataset[] {
  return datasetV4Deserializer(serializedDatasets);
}
