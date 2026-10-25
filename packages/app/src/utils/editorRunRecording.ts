import {
  logRuntimeDebug,
  serializeDatasets,
  serializeProject,
  type CombinedDataset,
  type ExecutionRecorder,
  type GraphId,
  type Project,
} from '@valerypopoff/rivet2-core';
import type { LocalExecutionRecordingPersistenceProvider } from '../providers/ProvidersContext.js';

/** A capability-approved destination, never a run or transport owner. */
export type EditorRecordingPersistenceTarget = {
  provider: LocalExecutionRecordingPersistenceProvider;
  projectPath: string;
  correlationId: string;
};

/** Adapters decide eligibility (playback, executor target, web-app execution). */
export async function prepareEditorRecordingPersistence(input: {
  eligible: boolean;
  projectPath?: string | null;
  provider?: LocalExecutionRecordingPersistenceProvider;
}): Promise<EditorRecordingPersistenceTarget | undefined> {
  if (!input.eligible || !input.projectPath || !input.provider) return undefined;
  try {
    if (!(await input.provider.getCapability())) return undefined;
  } catch {
    // A failed capability read must not prevent an ordinary editor run.
    return undefined;
  }
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return { provider: input.provider, projectPath: input.projectPath, correlationId: `rvt-local-${id}` };
}

/**
 * Called once by the existing processor/session or request-capture owner, after
 * its real capture settles. This function cannot stop execution, replay writes,
 * decide remote terminality or acquire display ownership.
 */
export async function persistEditorRunRecording(input: {
  source: 'browser' | 'node';
  recorder: Pick<ExecutionRecorder, 'serialize'>;
  project: Project;
  graphId: GraphId;
  createdAt: string;
  startedAt: number;
  status: 'succeeded' | 'failed' | 'suspicious';
  errorMessage?: string;
  persistence?: EditorRecordingPersistenceTarget;
  exportDatasets: () => Promise<CombinedDataset[]>;
  /** Browser retains its in-memory replay even when no hosted destination exists. */
  onSerialized?: (recording: string) => void;
}): Promise<void> {
  const durationMs = Math.max(0, performance.now() - input.startedAt);
  const metadata = { source: input.source, graphId: input.graphId, projectId: input.project.metadata.id };
  try {
    const recordingSerialized = input.recorder.serialize();
    try {
      input.onSerialized?.(recordingSerialized);
    } catch (error) {
      // A presentation observer cannot invalidate accepted execution evidence.
      logRuntimeDebug('Editor recording could not update its replay display.', { ...metadata, error });
    }
    const target = input.persistence;
    if (!target) return;
    const projectContents = serializeProject(input.project) as string;
    const datasetsContents = serializeDatasets(await input.exportDatasets());
    await target.provider.persist({
      createdAt: input.createdAt,
      projectId: input.project.metadata.id,
      projectPath: target.projectPath,
      projectContents,
      datasetsContents,
      recordingSerialized,
      status: input.status,
      durationMs,
      errorMessage: input.errorMessage,
      executionIdentity: { correlationId: target.correlationId, graphId: input.graphId },
    });
  } catch (error) {
    if (input.persistence) {
      try {
        await input.persistence.provider.markUnavailable(input.persistence.correlationId);
      } catch (outcomeError) {
        logRuntimeDebug('Editor recording could not report its unavailable artifact.', {
          ...metadata,
          error: outcomeError,
        });
      }
    }
    logRuntimeDebug('Editor recording was not retained by the hosted server.', { ...metadata, error });
  }
}
