import type { AttachedData, Project } from '@valerypopoff/rivet2-node';
import type { NodeDatasetProvider } from '@valerypopoff/rivet2-node';

import type { ManagedEndpointPointerCacheEntry } from './execution-cache.js';

export type ManagedExecutionDebugInfo = {
  cacheStatus: 'hit' | 'miss' | 'bypass';
  resolveMs: number;
  materializeMs: number;
};

export type ManagedExecutionProjectResult = {
  project: Project;
  attachedData: AttachedData;
  datasetProvider: NodeDatasetProvider;
  projectVirtualPath: string;
  revisionKey: string;
  webAppUiGraphId?: string;
  webAppAllowedEmails?: string[];
  debug: ManagedExecutionDebugInfo;
};

export type ManagedExecutionRevisionRecord = {
  revision_id: string;
  workflow_id: string;
  project_blob_key: string;
  dataset_blob_key: string | null;
  created_at: Date | string;
};

export type ManagedExecutionWorkflowRecord = {
  workflow_id: string;
  relative_path: string;
  current_draft_revision_id: string;
  published_revision_id: string | null;
};

export type ManagedExecutionPointerLookupResult = {
  pointer: ManagedEndpointPointerCacheEntry;
  revision: ManagedExecutionRevisionRecord;
};

export type ManagedExecutionInvalidationEvent =
  | {
      eventType: 'workflow-changed';
      workflowId: string;
      sourceInstanceId?: string;
    }
  | {
      eventType: 'clear-all';
      sourceInstanceId?: string;
    };

export type ManagedExecutionWorkflowGenerationRecord = {
  generation: number;
  updatedAt: number;
};

export type ManagedExecutionResolveSnapshot = {
  startedAtWallClock: number;
  anyGeneration: number;
  globalGeneration: number;
  globalUpdatedAt: number;
};

export type ManagedExecutionWorkflowSnapshot = {
  workflowId: string;
  generation: number;
};
