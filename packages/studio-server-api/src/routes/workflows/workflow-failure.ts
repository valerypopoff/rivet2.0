import { createHttpError, type HttpError } from '../../utils/httpError.js';

export type WorkflowFailureCode =
  | 'workflow_state_changed'
  | 'workflow_destination_conflict'
  | 'workflow_project_mismatch'
  | 'workflow_publication_missing'
  | 'workflow_storage_busy';

/** Enumerable primitives retain identity across the catalog worker boundary. */
export function workflowFailure(code: WorkflowFailureCode, message: string): HttpError {
  return createHttpError(code === 'workflow_storage_busy' ? 503 : 409, message, { code, expose: true });
}
export function hasWorkflowFailure(error: unknown, ...codes: WorkflowFailureCode[]): boolean {
  return !!error && typeof error === 'object' && codes.includes((error as { code?: WorkflowFailureCode }).code!);
}

/** Read SQLite's extended numeric result code, never its localized message. */
export function normalizeWorkflowStorageFailure(error: unknown): unknown {
  if (!error || typeof error !== 'object') return error;
  const value = error as { errcode?: number; code?: string; reason?: string };
  if (
    hasWorkflowFailure(error, 'workflow_state_changed', 'workflow_destination_conflict') ||
    value.reason === 'publication-route-conflict'
  )
    return workflowFailure(
      value.code === 'workflow_state_changed' ? 'workflow_state_changed' : 'workflow_destination_conflict',
      'Workflow storage changed or the destination already exists. Refresh before trying again.',
    );
  if (value.errcode !== undefined && (value.errcode & 255) === 5)
    return workflowFailure('workflow_storage_busy', 'Workflow storage is busy. Please try again.');
  return error;
}
