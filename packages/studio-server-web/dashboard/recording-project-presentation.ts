import type { WorkflowRecordingRunSummary } from './types';

export function recordingProjectPath(path: string | undefined): string {
  return path?.replace(/\.rivet-project$/i, '') ?? '';
}

export function recordingProjectName(recording: WorkflowRecordingRunSummary): string {
  return (
    recordingProjectPath(recording.sourceProjectName?.trim()) ||
    recordingProjectPath(recording.sourceProjectRelativePath).split(/[\\/]/).at(-1) ||
    recording.workflowId
  );
}
