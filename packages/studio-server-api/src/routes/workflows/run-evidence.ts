import type {
  RunEvidenceHandle,
  RunEvidenceInput,
  RunEvidenceRepository,
  RecordingUnavailableReason,
} from '@valerypopoff/rivet-studio-server-shared/workflow-run-evidence.js';
import { getWorkflowStorageServices } from './storage-composition.js';
import { isWorkflowRecordingEnabled } from './recordings-config.js';
import { reportRecordingFailure } from './recording-diagnostics.js';
import { getManagedWorkflowRelativePathFromVirtualPath } from '../../../../studio-server-shared/workflow-types.js';
import type { WorkflowRecordingExecutionIdentity } from '@valerypopoff/rivet-studio-server-shared/workflow-recording-types.js';
import type { WorkflowExecutionDefinition } from './data-backend.js';
import { createHash, randomUUID } from 'node:crypto';
import { recordingDurabilityEnabled } from './managed/recording-evidence.js';
import { deferEvidenceWork, pendingEvidenceWorkCount } from './recording-evidence-work.js';
import { recordStudioMetrics } from '../../metrics.js';
import {
  activeEvidenceOwners,
  registeredEvidenceRepository,
  type ExecutionEvidenceOwner,
} from './execution-evidence-owner.js';
let lastAdmissionWarning = 0;
export {
  rootRunEvidence,
  incompleteChildEvidence,
  completeRunEvidence,
  type ExecutionEvidenceOwner,
} from './execution-evidence-owner.js';
export function executionRunEvidenceInput(
  project: Pick<WorkflowExecutionDefinition, 'project' | 'projectVirtualPath'>,
  executionIdentity: WorkflowRecordingExecutionIdentity,
  endpointName: string,
  runKind: RunEvidenceInput['runKind'],
): RunEvidenceInput {
  return {
    projectId: project.project.metadata.id,
    sourceProjectName: project.project.metadata.title,
    sourceProjectRelativePath:
      getManagedWorkflowRelativePathFromVirtualPath(project.projectVirtualPath) ?? project.projectVirtualPath,
    executionIdentity,
    endpointName,
    runKind,
  };
}
export async function getRunEvidenceRepository(accepted = false): Promise<RunEvidenceRepository | undefined> {
  if (!accepted && (!isWorkflowRecordingEnabled() || !recordingDurabilityEnabled())) return undefined;
  const services = getWorkflowStorageServices();
  if (services.mode !== 'managed') return undefined;
  return (await services.getRepository('recordings')).evidence;
}
export function beginRunEvidence(input: RunEvidenceInput): ExecutionEvidenceOwner | undefined {
  try {
    if (
      !isWorkflowRecordingEnabled() ||
      !recordingDurabilityEnabled() ||
      getWorkflowStorageServices().mode !== 'managed'
    )
      return undefined;
  } catch (error) {
    reportRecordingFailure(error, { projectId: input.projectId, phase: 'admission' });
    return undefined;
  }
  // A recording backlog must not consume execution slots or unbounded memory.
  if (pendingEvidenceWorkCount() >= 256) {
    recordStudioMetrics((metrics) => metrics.recordWorkflowRecordingPersistenceDrop());
    if (Date.now() - lastAdmissionWarning > 60_000) {
      lastAdmissionWarning = Date.now();
      reportRecordingFailure(undefined, { projectId: input.projectId, phase: 'admission' });
    }
    return undefined;
  }
  const owner: ExecutionEvidenceOwner = { handle: { id: randomUUID(), token: randomUUID() } };
  const registrationInput = { ...input, createdAt: input.createdAt ?? new Date().toISOString() };
  owner.registration = deferEvidenceWork(async () => {
    const repository = await getRunEvidenceRepository(true);
    if (!repository) throw new Error('Recording evidence storage is unavailable.');
    await repository.begin(registrationInput, owner.handle);
    owner.repository = repository;
    repository.track(owner.handle);
  });
  void owner.registration.catch((error) =>
    reportRecordingFailure(error, { projectId: input.projectId, phase: 'admission' }),
  );
  if (input.executionIdentity?.correlationId) activeEvidenceOwners.set(input.executionIdentity.correlationId, owner);
  return owner;
}
export async function beginChildEvidence(
  owner: ExecutionEvidenceOwner,
  input: RunEvidenceInput,
  captureId: string,
): Promise<RunEvidenceHandle> {
  const digest = createHash('sha256')
    .update(owner.handle.id + '\0' + captureId)
    .digest()
    .subarray(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x80; // UUIDv8: deterministic capture identity.
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.toString('hex');
  const id = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
  return (await registeredEvidenceRepository(owner)).begin(
    { ...input, rootId: owner.handle.id },
    { id, token: owner.handle.token },
  );
}
export async function unavailableRunEvidence(
  handle: RunEvidenceHandle | undefined,
  reason: RecordingUnavailableReason,
): Promise<void> {
  if (!handle) return;
  try {
    await (await getRunEvidenceRepository(true))?.unavailable(handle, reason);
  } catch (error) {
    reportRecordingFailure(error, { recordingId: handle.id, phase: 'persistence' });
  }
}
