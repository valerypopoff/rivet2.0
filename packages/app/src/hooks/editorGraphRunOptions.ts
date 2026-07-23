import type {
  ExternalFunction,
  GraphId,
  GraphInputs,
  GraphOutputs,
  GraphProgress,
  NodeId,
  RivetWebAppStorage,
  RivetStoredValueStore,
  RivetKnowledgeStoreRegistry,
} from '@valerypopoff/rivet2-core';

export type EditorGraphRunOptions = {
  abortSignal?: AbortSignal;
  from?: NodeId;
  externalFunctions?: Record<string, ExternalFunction>;
  graphId?: GraphId;
  inputs?: GraphInputs;
  onProgress?: (progress: GraphProgress) => void;
  onWebAppStoragePatch?: (storagePatch: RivetWebAppStorage) => void;
  storedValueStore?: RivetStoredValueStore;
  knowledgeStores?: RivetKnowledgeStoreRegistry;
  requireLiveRun?: boolean;
  returnWhenGraphOutputsReady?: boolean;
  throwOnError?: boolean;
  to?: NodeId[];
  waitForResults?: boolean;
  webAppStorage?: RivetWebAppStorage;
};

export type EditorGraphRun = (options?: EditorGraphRunOptions) => Promise<GraphOutputs | undefined>;
