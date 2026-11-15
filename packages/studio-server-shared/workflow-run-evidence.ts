import type {
  WorkflowRecordingExecutionIdentity,
  WorkflowRecordingRunKind,
  WorkflowRunCost,
} from './workflow-recording-types.js';

/** One attempt, never an instruction to execute or retry a graph. */
export type RunEvidenceHandle = { id: string; token: string };
export type RunEvidenceState = 'accepted' | 'running' | 'succeeded' | 'failed' | 'suspicious' | 'unknown';
export type RecordingAvailability = 'pending' | 'available' | 'unavailable' | 'deleted';
export type RecordingUnavailableReason =
  | 'capacity'
  | 'capture_incomplete'
  | 'serialization_failed'
  | 'upload_incomplete'
  | 'persistence_failed';
export type RunEvidenceInput = {
  projectId: string;
  sourceProjectName: string;
  sourceProjectRelativePath: string;
  endpointName: string;
  runKind: WorkflowRecordingRunKind;
  executionIdentity?: WorkflowRecordingExecutionIdentity;
  createdAt?: string;
  rootId?: string;
  sourceRunId?: string;
};
export type RunEvidenceOutcome = {
  state: Exclude<RunEvidenceState, 'accepted' | 'running'>;
  durationMs?: number;
  cost?: WorkflowRunCost;
};
export type RunEvidenceSummary = RunEvidenceInput & {
  id: string;
  createdAt: string;
  state: RunEvidenceState;
  availability: RecordingAvailability;
  reason?: RecordingUnavailableReason;
  durationMs?: number;
  cost?: WorkflowRunCost;
  childCoverage: 'unknown' | 'complete' | 'incomplete';
  handoffReady?: boolean;
};
export interface RunEvidenceRepository {
  begin(input: RunEvidenceInput, handle?: RunEvidenceHandle): Promise<RunEvidenceHandle>;
  heartbeat(handle: RunEvidenceHandle): Promise<void>;
  outcome(handle: RunEvidenceHandle, outcome: RunEvidenceOutcome, incompleteChildren?: boolean): Promise<void>;
  unavailable(handle: RunEvidenceHandle, reason: RecordingUnavailableReason): Promise<void>;
  childIncomplete(handle: RunEvidenceHandle): Promise<void>;
  read(handle: RunEvidenceHandle): Promise<RunEvidenceSummary>;
  track(handle: RunEvidenceHandle): void;
  release(handle: RunEvidenceHandle): void;
  adoptExecutor?(
    projectId: string,
    graphId: string,
    correlationId: string,
    requestId: string,
  ): Promise<RunEvidenceHandle | undefined>;
}
