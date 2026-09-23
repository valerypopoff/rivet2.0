import type { WorkflowProjectStatus as SharedWorkflowProjectStatus } from '../../../../studio-server-shared/workflow-types.js';
import type { WorkflowEndpointAccess } from '../../../../studio-server-shared/workflow-types.js';

export type {
  WorkflowFolderItem,
  WorkflowProjectItem,
  WorkflowProjectPathMove,
  WorkflowProjectSettings,
  WorkflowProjectSettingsDraft,
  WorkflowProjectStats,
  WorkflowProjectStatus,
  WorkflowProjectWebAppAccessDraft,
  WorkflowProjectWebAppPublicationDraft,
  WorkflowProjectWebAppsResponse,
  WorkflowPublishedWebAppSummary,
} from '../../../../studio-server-shared/workflow-types.js';

export type StoredWorkflowProjectSettings = {
  publicationVersion?: string;
  endpointName: string;
  endpointAccess: WorkflowEndpointAccess;
  publishedEndpointName: string;
  publishedSnapshotId: string | null;
  publishedStateHash: string | null;
  lastPublishedAt: string | null;
  publishedWebApps: StoredWorkflowPublishedWebApp[];
  legacyStatus?: SharedWorkflowProjectStatus;
};

export type StoredWorkflowPublishedWebApp = {
  /** Stable identity of the app binding. It survives republishing the same UI graph. */
  appId: string;
  uiGraphId: string;
  uiGraphName: string;
  slug: string;
  publishedSnapshotId: string;
  publishedAt: string;
  allowedEmails: string[];
};

export type PublishedWorkflowMatch = {
  endpointName: string;
  projectPath: string;
  publishedProjectPath: string;
};

export type PublishedWorkflowWebAppMatch = {
  appId: string;
  slug: string;
  uiGraphId: string;
  allowedEmails: string[];
  /** Identifies the specific published app snapshot selected for this route. */
  publishedSnapshotId: string;
  projectPath: string;
  publishedProjectPath: string;
};

export type LatestWorkflowMatch = {
  endpointName: string;
  projectPath: string;
};
