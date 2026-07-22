import type { Opaque } from 'type-fest';
import type { ChartNode } from './NodeBase.js';
import { type GraphId, type NodeGraph } from './NodeGraph.js';
import { type PluginLoadSpec } from './PluginLoadSpec.js';
import type { MCP } from '../integrations/mcp/MCPProvider.js';
import type { UiGraph, UiGraphId } from './UiGraph.js';
import type { KnowledgeMetadata, KnowledgeStoreConnectionId } from '../integrations/KnowledgeStore.js';

export type ProjectId = Opaque<string, 'ProjectId'>;

export type DataId = Opaque<string, 'DataId'>;

export type NodePrefabId = Opaque<string, 'NodePrefabId'>;

export type NodePrefab = {
  id: NodePrefabId;
  sourceNode: ChartNode;
};

export type Project = {
  metadata: ProjectMetadata;

  plugins?: PluginLoadSpec[];

  graphs: Record<GraphId, NodeGraph>;

  nodePrefabs?: Record<NodePrefabId, NodePrefab>;

  uiGraphs?: Record<UiGraphId, UiGraph>;

  data?: Record<DataId, string>;

  /** References to other projects. */
  references?: ProjectReference[];
};

export type ProjectMetadata = {
  id: ProjectId;
  title: string;
  description: string;
  mainGraphId?: GraphId;
  path?: string;

  mcpServer?: MCP.Config;

  /** Named, non-secret knowledge-store connections available to graphs in this project. */
  knowledgeStores?: Record<KnowledgeStoreConnectionId, KnowledgeStoreConnectionDefinition>;
};

export type KnowledgeStoreConnectionDefinition = {
  displayName: string;
  provider: string;
  /** Plugin that registers the provider. Falls back to provider for older project files. */
  pluginId?: string;
  /** Provider-specific, portable, non-secret configuration. */
  config: KnowledgeMetadata;
};

/** A reference to another project file. Project references cannot be cyclic. */
export type ProjectReference = {
  /** The ID of the project being referenced. */
  id: ProjectId;

  /** Paths to use to attempt to resolve the reference. */
  hintPaths?: string[];

  /** A human-readable title for the project. */
  title?: string;
};
