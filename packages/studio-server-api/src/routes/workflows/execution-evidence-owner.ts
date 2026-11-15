import type {
  RunEvidenceHandle,
  RunEvidenceRepository,
  RunEvidenceInput,
  RunEvidenceOutcome,
} from '@valerypopoff/rivet-studio-server-shared/workflow-run-evidence.js';
import { reportRecordingFailure } from './recording-diagnostics.js';
import { deferEvidenceWork } from './recording-evidence-work.js';

export type ExecutionEvidenceOwner = {
  handle: RunEvidenceHandle;
  repository?: RunEvidenceRepository;
  registration?: Promise<void>;
  incompleteChildren?: boolean;
};
export type BeginExecutionEvidence = (input: RunEvidenceInput) => ExecutionEvidenceOwner | undefined;
export async function registeredEvidenceRepository(owner: ExecutionEvidenceOwner): Promise<RunEvidenceRepository> {
  await owner.registration;
  if (!owner.repository) throw new Error('Recording registration did not complete.');
  return owner.repository;
}
export const activeEvidenceOwners = new Map<string, ExecutionEvidenceOwner>();
export function rootRunEvidence(correlationId: string | undefined) {
  return correlationId ? activeEvidenceOwners.get(correlationId) : undefined;
}
export function incompleteChildEvidence(owner: ExecutionEvidenceOwner | undefined): Promise<void> {
  if (!owner || owner.incompleteChildren) return Promise.resolve();
  owner.incompleteChildren = true;
  return deferEvidenceWork(async () => {
    try {
      await (await registeredEvidenceRepository(owner)).childIncomplete(owner.handle);
    } catch (error) {
      reportRecordingFailure(error, { recordingId: owner.handle.id, phase: 'persistence' });
    }
  });
}
export async function completeRunEvidence(
  owner: ExecutionEvidenceOwner | undefined,
  outcome: RunEvidenceOutcome,
  correlationId?: string,
): Promise<void> {
  if (!owner) return;
  try {
    const repository = await registeredEvidenceRepository(owner);
    await repository.outcome(owner.handle, outcome, owner.incompleteChildren === true);
    if (outcome.state === 'unknown') await repository.unavailable(owner.handle, 'capture_incomplete');
  } catch (error) {
    reportRecordingFailure(error, { recordingId: owner.handle.id, phase: 'persistence' });
  } finally {
    owner.repository?.release(owner.handle);
    if (correlationId && activeEvidenceOwners.get(correlationId) === owner) activeEvidenceOwners.delete(correlationId);
  }
}
