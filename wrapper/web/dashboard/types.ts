import type {
  WorkflowFolderItem,
  WorkflowProjectDeleteResponse,
  WorkflowProjectDownloadVersion,
  WorkflowProjectItem,
  WorkflowProjectPathMove,
  WorkflowProjectSettings,
  WorkflowProjectSettingsDraft,
  WorkflowProjectStatus,
  WorkflowProjectWebAppAccessDraft,
  WorkflowProjectWebAppPublicationDraft,
  WorkflowProjectWebAppSummary,
  WorkflowProjectWebAppsResponse,
  WorkflowPublishedVersionRestoreResponse,
  WorkflowPublishedVersionCommentResponse,
  WorkflowPublishedVersionStarResponse,
  WorkflowPublishedVersionSummary,
  WorkflowPublishedVersionPreviewResponse,
  WorkflowPublishedVersionsResponse,
} from '../../shared/workflow-types';
import type {
  WorkflowRecordingFilterStatus,
  WorkflowRecordingInputFilter,
  WorkflowRecordingInputFilterOperator,
  WorkflowRecordingRunsPageResponse,
  WorkflowRecordingRunKind,
  WorkflowRecordingRunSummary,
  WorkflowRecordingStatus,
  WorkflowRunStatisticsAggregation,
  WorkflowRunStatisticsBucket,
  WorkflowRunStatisticsCatalogResponse,
  WorkflowRunStatisticsMetrics,
  WorkflowRunStatisticsPeriod,
  WorkflowRunStatisticsQuery,
  WorkflowRunStatisticsResponse,
  WorkflowRunStatisticsRunKind,
  WorkflowRunStatisticsStatusCounts,
  WorkflowRunStatisticsSurface,
  WorkflowRunStatisticsTarget,
  WorkflowRunStatisticsTargetSummary,
  WorkflowRecordingWorkflowListResponse,
  WorkflowRecordingWorkflowSummary,
} from '../../shared/workflow-recording-types';
export {
  getWorkflowRunStatisticsTargetKey,
  WORKFLOW_RECORDING_INPUT_FILTER_OPERATORS,
} from '../../shared/workflow-recording-types';

export type {
  WorkflowFolderItem,
  WorkflowProjectDeleteResponse,
  WorkflowProjectDownloadVersion,
  WorkflowProjectItem,
  WorkflowProjectPathMove,
  WorkflowProjectSettings,
  WorkflowProjectSettingsDraft,
  WorkflowProjectStatus,
  WorkflowProjectWebAppAccessDraft,
  WorkflowProjectWebAppPublicationDraft,
  WorkflowProjectWebAppSummary,
  WorkflowProjectWebAppsResponse,
  WorkflowPublishedVersionRestoreResponse,
  WorkflowPublishedVersionCommentResponse,
  WorkflowPublishedVersionStarResponse,
  WorkflowPublishedVersionSummary,
  WorkflowPublishedVersionPreviewResponse,
  WorkflowPublishedVersionsResponse,
  WorkflowRecordingFilterStatus,
  WorkflowRecordingInputFilter,
  WorkflowRecordingInputFilterOperator,
  WorkflowRecordingRunsPageResponse,
  WorkflowRecordingRunKind,
  WorkflowRecordingRunSummary,
  WorkflowRecordingStatus,
  WorkflowRunStatisticsAggregation,
  WorkflowRunStatisticsBucket,
  WorkflowRunStatisticsCatalogResponse,
  WorkflowRunStatisticsMetrics,
  WorkflowRunStatisticsPeriod,
  WorkflowRunStatisticsQuery,
  WorkflowRunStatisticsResponse,
  WorkflowRunStatisticsRunKind,
  WorkflowRunStatisticsStatusCounts,
  WorkflowRunStatisticsSurface,
  WorkflowRunStatisticsTarget,
  WorkflowRunStatisticsTargetSummary,
  WorkflowRecordingWorkflowListResponse,
  WorkflowRecordingWorkflowSummary,
};

export type WorkflowMoveResponse = {
  folder?: WorkflowFolderItem;
  project?: WorkflowProjectItem;
  movedProjectPaths: WorkflowProjectPathMove[];
};

export type WorkflowTreeResponse = {
  root: string;
  folders: WorkflowFolderItem[];
  projects: WorkflowProjectItem[];
};

export type HostedRouteConfig = {
  executorWsUrl: string;
  remoteDebuggerDefaultWs: string;
  publishedWorkflowsBasePath: string;
  latestWorkflowsBasePath: string;
  publishedAppsBasePath: string;
  latestAppsBasePath: string;
  webAppsAuthMode: 'ui-gate' | 'oauth' | 'none';
};

export type WorkflowProjectOpenOptions = {
  preview?: boolean;
  replaceCurrent?: boolean;
  reloadFromDisk?: boolean;
  title?: string;
};
