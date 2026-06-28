import type { WorkflowProjectStatus as SharedWorkflowProjectStatus } from '../../../../shared/workflow-types.js';

export type {
  WorkflowFolderItem,
  WorkflowProjectItem,
  WorkflowProjectPathMove,
  WorkflowProjectSettings,
  WorkflowProjectSettingsDraft,
  WorkflowProjectStats,
  WorkflowProjectStatus,
  WorkflowProjectWebAppPublicationDraft,
  WorkflowProjectWebAppsResponse,
  WorkflowPublishedWebAppSummary,
} from '../../../../shared/workflow-types.js';

export type StoredWorkflowProjectSettings = {
  endpointName: string;
  publishedEndpointName: string;
  publishedSnapshotId: string | null;
  publishedStateHash: string | null;
  lastPublishedAt: string | null;
  publishedWebApps: StoredWorkflowPublishedWebApp[];
  legacyStatus?: SharedWorkflowProjectStatus;
};

export type StoredWorkflowPublishedWebApp = {
  uiGraphId: string;
  uiGraphName: string;
  slug: string;
  publishedSnapshotId: string;
  publishedAt: string;
};

export type PublishedWorkflowMatch = {
  endpointName: string;
  projectPath: string;
  publishedProjectPath: string;
};

export type PublishedWorkflowWebAppMatch = {
  slug: string;
  uiGraphId: string;
  projectPath: string;
  publishedProjectPath: string;
};

export type LatestWorkflowMatch = {
  endpointName: string;
  projectPath: string;
};
