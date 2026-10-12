import type { ProjectId } from '@valerypopoff/rivet2-core';
import {
  createEvaluationBaselineSnapshot,
  type EvaluationBaselineSnapshot,
  type EvaluationRun,
  type EvaluationRecordingReference,
  type EvaluationSuite,
  type EvaluationRunStore,
} from '@valerypopoff/rivet2-evaluations';
import type { EvaluationsState } from '../../state/evaluations.js';

export type EvaluationCommandNotice = {
  kind: 'success' | 'unavailable' | 'conflict' | 'failed' | 'partial';
  message: string;
  level?: 'info' | 'warn';
};

// Store identity survives render/panel replacement; tails exist only while
// renames are pending. Keep request order without serializing unrelated runs.
const pendingRenames = new WeakMap<EvaluationRunStore, Map<string, { tail: Promise<void>; count: number }>>();

function orderRunRename(
  store: EvaluationRunStore,
  projectId: ProjectId,
  runId: string,
  rename: () => Promise<void>,
  onConflict: () => void,
): Promise<void> {
  let entries = pendingRenames.get(store);
  if (!entries) pendingRenames.set(store, (entries = new Map()));
  const key = JSON.stringify([projectId, runId]);
  const previous = entries.get(key);
  if (previous && previous.count >= 8) {
    onConflict();
    return Promise.resolve();
  }
  const entry = previous ?? { tail: Promise.resolve(), count: 0 };
  entry.count++;
  const result = entry.tail.then(rename);
  entry.tail = result.catch(() => undefined);
  entries.set(key, entry);
  return result.finally(() => {
    if (--entry.count === 0) entries.delete(key);
  });
}

export function getEvaluationRunRecordingReferences(run: EvaluationRun): EvaluationRecordingReference[] {
  return run.trials.flatMap((trial) => [
    ...(trial.recording === undefined ? [] : [trial.recording]),
    ...trial.observations.flatMap((observation) =>
      observation.recording === undefined ? [] : [observation.recording],
    ),
  ]);
}

function withEvaluationRunRecordingRetention(
  run: EvaluationRun,
  recordingIds: ReadonlySet<string>,
  retention: EvaluationRecordingReference['retention'],
  expiresAt?: string,
): EvaluationRun {
  const update = (reference: EvaluationRecordingReference): EvaluationRecordingReference =>
    !recordingIds.has(reference.id)
      ? reference
      : {
          id: reference.id,
          retention,
          ...(expiresAt === undefined ? {} : { expiresAt }),
        };
  return {
    ...run,
    trials: run.trials.map((trial) => ({
      ...trial,
      ...(trial.recording === undefined ? {} : { recording: update(trial.recording) }),
      observations: trial.observations.map((observation) =>
        observation.recording === undefined
          ? observation
          : { ...observation, recording: update(observation.recording) },
      ),
    })),
  };
}

function withEvaluationRunName(run: EvaluationRun, value: string): EvaluationRun {
  const name = value.trim();
  if (name.length > 0) return { ...run, name };
  const { name: _name, ...unnamed } = run;
  return unnamed;
}

/** Durable commands own sequencing; the view supplies presentation and scoped projection. */
export function createEvaluationRunCommands({
  state,
  setState: projectStateUpdate,
  projectId,
  runStore,
  selectedSuite,
  comparableRun,
  invalidateHistory,
  markHistoryReady,
  onNotice,
  isCurrent = () => true,
}: {
  state: EvaluationsState;
  setState: (update: (state: EvaluationsState) => EvaluationsState) => void;
  projectId: ProjectId;
  runStore: EvaluationRunStore;
  selectedSuite?: EvaluationSuite;
  comparableRun?: EvaluationRun;
  invalidateHistory: () => void;
  markHistoryReady: () => void;
  onNotice: (notice: EvaluationCommandNotice) => void;
  isCurrent?: () => boolean;
}) {
  const setState: typeof projectStateUpdate = (update) =>
    projectStateUpdate((current) => (isCurrent() ? update(current) : current));
  const ownsRun = (run: EvaluationRun) => {
    if (run.projectId === projectId) return true;
    onNotice({ kind: 'failed', message: 'Evaluation run belongs to another project.' });
    return false;
  };
  const invalidateCurrentHistory = (suiteId: string) => {
    if (isCurrent()) {
      invalidateHistory();
      markHistoryReady();
      return;
    }
    // Durable work can finish after this panel closes or changes scope. Do
    // not project its old selection, but don't leave that exact cache warm:
    // the next visit must read the committed name/deletion/retention state.
    projectStateUpdate((current) =>
      current.runHistoryScope?.projectId === projectId && current.runHistoryScope.suiteId === suiteId
        ? { ...current, runHistoryScope: undefined }
        : current,
    );
  };
  const toast = {
    info: (message: string) => onNotice({ kind: 'unavailable', message, level: 'info' }),
    warn: (message: string) => onNotice({ kind: 'unavailable', message, level: 'warn' }),
    error: (message: string) => onNotice({ kind: 'failed', message }),
    success: (message: string) => onNotice({ kind: 'success', message }),
  };
  const renameEvaluationRun = async (runId: string, value: string) => {
    const isLiveRun =
      state.currentRun?.id === runId &&
      (state.currentRun.executionStatus === 'queued' || state.currentRun.executionStatus === 'running');
    const rename = (run: EvaluationRun) => (run.id === runId ? withEvaluationRunName(run, value) : run);

    // A live run has no terminal history record yet. Keep its name in memory
    // until the runner writes the named terminal snapshot. A retained run only
    // updates after its history write succeeds, avoiding an unsaved name that
    // looks durable in the Runs tab.
    if (isLiveRun) {
      setState((current) => ({
        ...current,
        currentRun: current.currentRun ? rename(current.currentRun) : undefined,
        runs: current.runs.map(rename),
      }));
    }

    try {
      const renamed = await runStore.updateRunName({
        projectId: projectId,
        runId,
        ...(value.trim().length === 0 ? {} : { name: value.trim() }),
      });
      if (renamed === undefined) {
        if (isLiveRun) return;
        throw new Error('This evaluation run is no longer available in local history.');
      }
      invalidateCurrentHistory(renamed.suiteId);
      if (!isLiveRun) {
        setState((current) => ({
          ...current,
          currentRun: current.currentRun ? rename(current.currentRun) : undefined,
          runs: current.runs.map(rename),
          runHistoryEntries: current.runHistoryEntries?.map((entry) =>
            entry.id === runId ? { ...entry, name: value.trim() || undefined } : entry,
          ),
        }));
      }
    } catch (error) {
      toast.error(`Could not save the evaluation run name: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const updateEvaluationRunRecordingRetention = async (run: EvaluationRun, action: 'keep' | 'release') => {
    if (!ownsRun(run)) return;
    const now = Date.now();
    const sourceRetention = action === 'keep' ? 'temporary' : 'retained';
    const references = [
      ...new Map(
        getEvaluationRunRecordingReferences(run)
          .filter(
            (reference) =>
              reference.retention === sourceRetention &&
              (action !== 'keep' || reference.expiresAt === undefined || Date.parse(reference.expiresAt) > now),
          )
          .map((reference) => [reference.id, reference]),
      ).values(),
    ];
    if (references.length === 0) {
      toast.info(
        action === 'keep'
          ? 'This run has no unexpired temporary replay recordings to keep.'
          : 'This run has no manually retained replay recordings to release.',
      );
      return;
    }

    const expiresAt = action === 'release' ? new Date(now + 24 * 60 * 60 * 1000).toISOString() : undefined;
    const changedIds = new Set<string>();
    let failure: unknown;
    for (const reference of references) {
      try {
        const updated = await runStore.updateRecordingRetention({
          expiresAt,
          projectId: projectId,
          recordingId: reference.id,
          retention: action === 'keep' ? 'retained' : 'temporary',
        });
        if (updated) changedIds.add(reference.id);
      } catch (error) {
        failure = error;
        break;
      }
    }

    if (changedIds.size > 0) {
      invalidateCurrentHistory(run.suiteId);
      const update = (candidate: EvaluationRun) =>
        candidate.id === run.id
          ? withEvaluationRunRecordingRetention(
              candidate,
              changedIds,
              action === 'keep' ? 'retained' : 'temporary',
              expiresAt,
            )
          : candidate;
      setState((current) => ({
        ...current,
        currentRun: current.currentRun ? update(current.currentRun) : undefined,
        runs: current.runs.map(update),
      }));
    }
    if (failure !== undefined || changedIds.size !== references.length) {
      const detail =
        failure === undefined
          ? 'One or more recordings expired or were removed before the change could be saved.'
          : failure instanceof Error
            ? failure.message
            : String(failure);
      onNotice({
        kind: 'partial',
        message: `Only ${changedIds.size} of ${references.length} replay recordings were updated. Refresh Runs before trying again: ${detail}`,
      });
      return;
    }
    toast.success(
      action === 'keep'
        ? `${changedIds.size} replay recording${changedIds.size === 1 ? '' : 's'} will be kept until you release them.`
        : `${changedIds.size} replay recording${changedIds.size === 1 ? '' : 's'} will expire in 24 hours.`,
    );
  };
  const deleteEvaluationRun = async (run: EvaluationRun) => {
    if (!ownsRun(run)) return;
    const isLiveRun =
      state.currentRun?.id === run.id &&
      (state.currentRun.executionStatus === 'queued' || state.currentRun.executionStatus === 'running');
    if (isLiveRun) {
      toast.warn('A running evaluation cannot be deleted. Cancel it or wait for it to finish first.');
      return;
    }

    try {
      await runStore.delete({ projectId: projectId, runId: run.id });
      // A history read started before the delete may still resolve with the
      // removed run. Invalidate it before updating the locally selected list.
      invalidateCurrentHistory(run.suiteId);
      setState((current) => {
        const runs = current.runs.filter((candidate) => candidate.id !== run.id);
        const replacement = runs.find((candidate) => candidate.suiteId === run.suiteId);
        return {
          ...current,
          currentRun: current.currentRun?.id === run.id ? undefined : current.currentRun,
          runs,
          runHistoryEntries: current.runHistoryEntries?.filter((entry) => entry.id !== run.id),
          selectedRunId:
            current.selectedRunId === run.id
              ? replacement?.id ?? current.runHistoryEntries?.find((entry) => entry.id !== run.id)?.id
              : current.selectedRunId,
          runTrialExpansion: current.runTrialExpansion?.runId === run.id ? undefined : current.runTrialExpansion,
        };
      });
    } catch (error) {
      toast.error(`Could not delete the evaluation run: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const promoteBaseline = async () => {
    const run = comparableRun;
    if (!run || !selectedSuite) return;
    if (!ownsRun(run)) return;
    if (run.suiteId !== selectedSuite.id) {
      toast.error('Evaluation run belongs to another suite.');
      return;
    }
    const recordingCount = run.trials.reduce(
      (count, trial) =>
        count +
        Number(trial.recording != null) +
        trial.observations.filter((observation) => observation.recording != null).length,
      0,
    );
    if (recordingCount === 0) {
      toast.warn('Only a run with retained replay artifacts can become an evaluation baseline.');
      return;
    }

    // Validate before pinning artifacts in the run store. In particular, a
    // canceled run must not leave permanently retained recordings behind.
    let baseline: EvaluationBaselineSnapshot;
    try {
      baseline = createEvaluationBaselineSnapshot(run);
    } catch (error) {
      toast.warn(error instanceof Error ? error.message : String(error));
      return;
    }

    try {
      await runStore.promoteBaseline({ projectId: projectId, runId: run.id });
      invalidateCurrentHistory(run.suiteId);
      const retained = (reference: { id: string }) => ({ id: reference.id, retention: 'baseline' as const });
      const promoteRun = (candidate: EvaluationRun): EvaluationRun =>
        candidate.id !== run.id
          ? candidate
          : {
              ...candidate,
              trials: candidate.trials.map((trial) => ({
                ...trial,
                ...(trial.recording == null ? {} : { recording: retained(trial.recording) }),
                observations: trial.observations.map((observation) =>
                  observation.recording == null
                    ? observation
                    : { ...observation, recording: retained(observation.recording) },
                ),
              })),
            };
      // Baselines belong to the shared library. Complete the accepted command
      // even after navigation, without projecting its run into another project.
      projectStateUpdate((current) => ({
        ...current,
        currentRun: isCurrent() && current.currentRun ? promoteRun(current.currentRun) : current.currentRun,
        runs: isCurrent() ? current.runs.map(promoteRun) : current.runs,
        // Resource deletion can finish while storage is pinning recordings.
        // Preserve the durable pins, but never resurrect a deleted suite's
        // baseline. Library normalization also enforces this invariant.
        data: current.data.suites.some((suite) => suite.id === baseline.suiteId)
          ? {
              ...current.data,
              baselines: [
                ...current.data.baselines.filter((candidate) => candidate.suiteId !== baseline.suiteId),
                baseline,
              ],
            }
          : current.data,
      }));
    } catch (error) {
      toast.error(
        `Could not promote the evaluation baseline: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  return {
    renameEvaluationRun: (runId: string, name: string) =>
      orderRunRename(
        runStore,
        projectId,
        runId,
        () => renameEvaluationRun(runId, name),
        () => onNotice({ kind: 'conflict', message: 'Run names are still being saved. Wait before renaming again.' }),
      ),
    updateEvaluationRunRecordingRetention,
    deleteEvaluationRun,
    promoteBaseline,
  };
}
