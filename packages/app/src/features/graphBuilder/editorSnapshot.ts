import { type DataId, type GraphId, type NodeGraph, type Project, type ProjectId } from '@valerypopoff/rivet2-core';
import { cloneDeep } from 'lodash-es';
import {
  assertGraphBuilderAuthoringValue,
  canonicalGraphBuilderAuthoringStringify,
  compareGraphBuilderStrings,
  hashGraphBuilderString,
  type PortableJsonValue,
} from '../../domain/graphBuilder/index.js';

export type GraphBuilderProjectDataManifestEntry = {
  id: DataId;
  digest: string;
  metadata: PortableJsonValue;
};

export type GraphBuilderEditorSnapshot = {
  activeGraphId: GraphId;
  authoringProject: Omit<Project, 'data'>;
  canonicalIdentity: string;
  fingerprint: string;
  projectDataManifest: GraphBuilderProjectDataManifestEntry[];
  projectId: ProjectId;
  transientGraph: boolean;
};

export type CreateGraphBuilderEditorSnapshotOptions = {
  graph: NodeGraph;
  project: Omit<Project, 'data'>;
  projectData?: Record<DataId, string>;
  createGraphId?: () => GraphId;
};

/**
 * Captures the complete authoring project seen by Graph Builder.
 *
 * The live graph is authoritative over the corresponding persisted graph. An
 * untouched empty canvas is deliberately included as a transient graph: it is
 * part of the private draft even though the ordinary save seam correctly omits
 * it until the user creates something.
 */
export function createGraphBuilderEditorSnapshot(
  options: CreateGraphBuilderEditorSnapshotOptions,
): GraphBuilderEditorSnapshot {
  assertGraphBuilderAuthoringValue({ graph: options.graph, project: options.project });
  const projectId = options.project.metadata.id;
  if (!projectId) {
    throw new Error('Graph Builder requires a project ID.');
  }

  const activeGraphId = resolveActiveGraphId(options);
  const graph = cloneDeep({
    ...options.graph,
    metadata: {
      name: 'Untitled graph',
      description: '',
      ...options.graph.metadata,
      id: activeGraphId,
    },
  });
  const persistedGraph = Object.hasOwn(options.project.graphs, activeGraphId)
    ? options.project.graphs[activeGraphId]
    : undefined;
  const transientGraph = persistedGraph == null && graph.nodes.length === 0 && graph.connections.length === 0;
  const authoringProject = cloneDeep({
    ...options.project,
    graphs: {
      ...options.project.graphs,
      [activeGraphId]: graph,
    },
  });
  const projectDataManifest = buildGraphBuilderProjectDataManifest(options.projectData);
  const identityValue = {
    project: authoringProject,
    projectDataManifest,
  };
  const canonicalIdentity = canonicalGraphBuilderAuthoringStringify(identityValue);

  return {
    activeGraphId,
    authoringProject,
    canonicalIdentity,
    fingerprint: hashGraphBuilderString(canonicalIdentity),
    projectDataManifest,
    projectId,
    transientGraph,
  };
}

export function buildGraphBuilderProjectDataManifest(
  projectData: Record<DataId, string> | undefined,
): GraphBuilderProjectDataManifestEntry[] {
  return Object.entries(projectData ?? {})
    .map(([rawId, value]) => ({
      id: rawId as DataId,
      digest: hashGraphBuilderString(value),
      metadata: {
        byteLength: new TextEncoder().encode(value).byteLength,
      },
    }))
    .sort((left, right) => compareGraphBuilderStrings(String(left.id), String(right.id)));
}

function resolveActiveGraphId(options: CreateGraphBuilderEditorSnapshotOptions): GraphId {
  const liveId = options.graph.metadata?.id;
  if (liveId) {
    return liveId;
  }

  const generatedId = options.createGraphId?.();
  if (!generatedId) {
    throw new Error('Graph Builder requires the live graph to have an ID.');
  }

  if (Object.hasOwn(options.project.graphs, generatedId)) {
    throw new Error(`Graph Builder generated a graph ID that is already in use: ${generatedId}.`);
  }

  return generatedId;
}
