import type { WorkflowFolderItem, WorkflowProjectItem, WorkflowProjectStatus } from '../../../shared/workflow-types.js';
import type { WorkflowRecordingWorkflowSummary } from '../../../shared/workflow-recording-types.js';

export type SourceWorkflowSnapshot = {
  relativePath: string;
  endpointName: string;
  publishedEndpointName: string;
  lastPublishedAt: string | null;
  contents: string;
  datasetsContents: string | null;
  publishedContents: string | null;
  publishedDatasetsContents: string | null;
};

export type MigrationProjectState = {
  relativePath: string;
  endpointName: string;
  lastPublishedAt: string | null;
  status: WorkflowProjectStatus;
};

export type MigrationRecordingState = {
  relativePath: string;
  totalRuns: number;
  failedRuns: number;
  suspiciousRuns: number;
  latestRunAt: string | null;
};

export type VerificationSummary = {
  sourceProjectCount: number;
  targetProjectCount: number;
  sourceFolderCount: number;
  targetFolderCount: number;
  sourceRecordingWorkflowCount: number;
  targetRecordingWorkflowCount: number;
};

export function flattenProjectsFromRecordingSummary(workflows: WorkflowRecordingWorkflowSummary[]): MigrationRecordingState[] {
  return workflows
    .map((workflow) => ({
      relativePath: workflow.project.relativePath,
      totalRuns: workflow.totalRuns,
      failedRuns: workflow.failedRuns,
      suspiciousRuns: workflow.suspiciousRuns,
      latestRunAt: workflow.latestRunAt ?? null,
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export function deriveSourceWorkflowStatus(workflow: SourceWorkflowSnapshot): WorkflowProjectStatus {
  if (!workflow.publishedEndpointName) {
    return 'unpublished';
  }

  return workflow.publishedContents === workflow.contents &&
    workflow.publishedDatasetsContents === workflow.datasetsContents &&
    workflow.publishedEndpointName.toLowerCase() === workflow.endpointName.toLowerCase()
    ? 'published'
    : 'unpublished_changes';
}

export function flattenProjects(projects: WorkflowProjectItem[], folders: WorkflowFolderItem[]): WorkflowProjectItem[] {
  const flattenedProjects = [...projects];
  const visit = (items: WorkflowFolderItem[]) => {
    for (const folder of items) {
      flattenedProjects.push(...folder.projects);
      visit(folder.folders);
    }
  };

  visit(folders);
  return flattenedProjects;
}

export function collectFolderPaths(folders: WorkflowFolderItem[]): string[] {
  const paths: string[] = [];
  const visit = (items: WorkflowFolderItem[]) => {
    for (const folder of items) {
      paths.push(folder.relativePath);
      visit(folder.folders);
    }
  };

  visit(folders);
  return paths.sort((left, right) => left.localeCompare(right));
}

export function verifyMigrationState(options: {
  sourceFolderPaths: string[];
  targetFolderPaths: string[];
  sourceProjectState: MigrationProjectState[];
  targetProjectState: MigrationProjectState[];
  sourceRecordingState: MigrationRecordingState[];
  targetRecordingState: MigrationRecordingState[];
}): VerificationSummary {
  const {
    sourceFolderPaths,
    targetFolderPaths,
    sourceProjectState,
    targetProjectState,
    sourceRecordingState,
    targetRecordingState,
  } = options;

  const targetFolderPathSet = new Set(targetFolderPaths);
  for (const sourceFolderPath of sourceFolderPaths) {
    if (!targetFolderPathSet.has(sourceFolderPath)) {
      throw new Error(`Managed workflow folder is missing: ${sourceFolderPath}`);
    }
  }

  const targetProjectStateByRelativePath = new Map(targetProjectState.map((project) => [project.relativePath, project]));
  for (const sourceProject of sourceProjectState) {
    const targetProject = targetProjectStateByRelativePath.get(sourceProject.relativePath);
    if (!targetProject) {
      throw new Error(`Managed workflow is missing: ${sourceProject.relativePath}`);
    }

    if (JSON.stringify(sourceProject) !== JSON.stringify(targetProject)) {
      throw new Error(`Managed workflow mismatch for ${sourceProject.relativePath}`);
    }
  }

  const targetRecordingStateByRelativePath = new Map(targetRecordingState.map((workflow) => [workflow.relativePath, workflow]));
  for (const sourceRecording of sourceRecordingState) {
    const targetRecording = targetRecordingStateByRelativePath.get(sourceRecording.relativePath);
    if (!targetRecording) {
      throw new Error(`Managed recording summary is missing: ${sourceRecording.relativePath}`);
    }

    if (targetRecording.totalRuns < sourceRecording.totalRuns) {
      throw new Error(`Managed recording count regressed for ${sourceRecording.relativePath}`);
    }

    if (targetRecording.failedRuns < sourceRecording.failedRuns) {
      throw new Error(`Managed failed recording count regressed for ${sourceRecording.relativePath}`);
    }

    if (targetRecording.suspiciousRuns < sourceRecording.suspiciousRuns) {
      throw new Error(`Managed suspicious recording count regressed for ${sourceRecording.relativePath}`);
    }

    if (sourceRecording.latestRunAt && (!targetRecording.latestRunAt || targetRecording.latestRunAt < sourceRecording.latestRunAt)) {
      throw new Error(`Managed latest recording timestamp regressed for ${sourceRecording.relativePath}`);
    }
  }

  return {
    sourceProjectCount: sourceProjectState.length,
    targetProjectCount: targetProjectState.length,
    sourceFolderCount: sourceFolderPaths.length,
    targetFolderCount: targetFolderPaths.length,
    sourceRecordingWorkflowCount: sourceRecordingState.length,
    targetRecordingWorkflowCount: targetRecordingState.length,
  };
}
