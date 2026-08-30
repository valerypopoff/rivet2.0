import {
  finalizeEvaluationRecordingRetention,
  fingerprintEvaluationDataset,
  preserveEvaluationRunName,
  runEvaluationSuite,
  type EvaluationDataset,
  type EvaluationGraphRunner,
  type EvaluationProjectData,
  type EvaluationRun,
  type EvaluationRunEvent,
  type EvaluationRunPurpose,
  type EvaluationRunStore,
  type EvaluationSuite,
} from '@valerypopoff/rivet2-evaluations';
import type { Project, ProjectId } from '@valerypopoff/rivet2-core';
import { evaluationRecordingRetentionUpdates } from './evaluationRecordingRetentionUpdates.js';
import { formatEvaluationRunHistoryPersistenceWarning } from './evaluationRunSummary.js';

export type EvaluationExecutionStage = 'preparing' | 'running' | 'finalizing' | 'persisting' | 'completed' | 'failed';

export type EvaluationStorageFault = 'dataset-snapshot' | 'run-checkpoint' | 'recording-retention' | 'run-history';

export type ExecuteEvaluationRunLifecycleOptions = {
  project: Project;
  projectId: ProjectId;
  evaluationData: EvaluationProjectData;
  dataset: EvaluationDataset;
  suite: EvaluationSuite;
  purpose: EvaluationRunPurpose;
  executionMode: string;
  signal: AbortSignal;
  runGraph: EvaluationGraphRunner;
  runStore: EvaluationRunStore;
  getExistingRun: (runId: string) => EvaluationRun | undefined;
  getRecordingPersistenceFailureCount?: () => number;
  /** Runtime-specific preparation, such as uploading a project to a remote executor. */
  prepare?: () => Promise<void>;
  assertActive?: () => void;
  onEvent?: (event: EvaluationRunEvent) => void;
  onStageChange?: (stage: EvaluationExecutionStage) => void;
  onStorageFault?: (kind: EvaluationStorageFault, error: unknown) => void;
};

const DATASET_SNAPSHOT_WARNING =
  'The exact evaluation dataset snapshot could not be retained; later replay may not have the original cases.';
const RECORDING_RETENTION_WARNING = 'Some evaluation recording retention updates could not be saved.';

/**
 * Owns the runtime-independent lifecycle of an evaluation execution.
 *
 * Browser and remote executors supply only the graph-running adapter. Keeping
 * snapshotting, finalization, retention, naming, and history persistence here
 * prevents those runtimes from drifting into subtly different semantics.
 */
export async function executeEvaluationRunLifecycle(
  options: ExecuteEvaluationRunLifecycleOptions,
): Promise<EvaluationRun> {
  const { project, projectId, evaluationData, dataset, suite, purpose, executionMode, signal, runGraph, runStore } =
    options;
  let datasetSnapshotWarning: string | undefined;
  let checkpointWarning: string | undefined;
  let checkpointFaultReported = false;
  let checkpointWrites = Promise.resolve();

  const assertActive = (): void => {
    if (signal.aborted) throw signal.reason;
    options.assertActive?.();
  };

  try {
    options.onStageChange?.('preparing');
    try {
      await runStore.putDatasetSnapshot({
        projectId,
        fingerprint: fingerprintEvaluationDataset(dataset),
        dataset: structuredClone({ ...dataset, projectId }),
        createdAt: new Date().toISOString(),
      });
      assertActive();
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      datasetSnapshotWarning = DATASET_SNAPSHOT_WARNING;
      options.onStorageFault?.('dataset-snapshot', error);
    }

    await options.prepare?.();
    assertActive();
    options.onStageChange?.('running');
    const result = await runEvaluationSuite({
      project,
      evaluationData,
      dataset,
      suiteId: suite.id,
      purpose,
      executionMode,
      signal,
      runGraph,
      onEvent: (event) => {
        options.onEvent?.(event);
        if (!runStore.applyRunEvent) return;
        checkpointWrites = checkpointWrites.then(async () => {
          try {
            await runStore.applyRunEvent!(event);
          } catch (error) {
            checkpointWarning = 'Live evaluation progress could not be checkpointed to run history.';
            if (!checkpointFaultReported) {
              checkpointFaultReported = true;
              options.onStorageFault?.('run-checkpoint', error);
            }
          }
        });
        return checkpointWrites;
      },
    });
    await checkpointWrites;

    options.onStageChange?.('finalizing');
    const finalizedResult = finalizeEvaluationRecordingRetention(
      result,
      suite.configuration?.recordingRetention ?? 'failures-and-baselines',
    );
    const finalizedRun = preserveEvaluationRunName(options.getExistingRun(finalizedResult.id), finalizedResult);
    if (datasetSnapshotWarning !== undefined) finalizedRun.warnings.push(datasetSnapshotWarning);
    if (checkpointWarning !== undefined) finalizedRun.warnings.push(checkpointWarning);

    const recordingPersistenceFailureCount = options.getRecordingPersistenceFailureCount?.() ?? 0;
    if (recordingPersistenceFailureCount > 0) {
      finalizedRun.warnings.push(
        `${recordingPersistenceFailureCount} replay recording${recordingPersistenceFailureCount === 1 ? '' : 's'} could not be retained by application storage.`,
      );
    }

    options.onStageChange?.('persisting');
    try {
      const retentionUpdates = await Promise.all(
        evaluationRecordingRetentionUpdates(projectId, finalizedRun.trials).map((update) =>
          runStore.updateRecordingRetention(update),
        ),
      );
      if (retentionUpdates.some((updated) => !updated)) {
        throw new Error('One or more replay recordings disappeared before their retention policy could be finalized.');
      }
    } catch (error) {
      finalizedRun.warnings.push(RECORDING_RETENTION_WARNING);
      options.onStorageFault?.('recording-retention', error);
    }

    try {
      await runStore.put(finalizedRun);
    } catch (error) {
      finalizedRun.warnings.push(formatEvaluationRunHistoryPersistenceWarning(error));
      options.onStorageFault?.('run-history', error);
    }

    options.onStageChange?.('completed');
    return finalizedRun;
  } catch (error) {
    options.onStageChange?.('failed');
    throw error;
  }
}
