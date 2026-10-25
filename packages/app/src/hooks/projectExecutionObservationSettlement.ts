import { produce } from 'immer';
import type { RootRunId } from '@valerypopoff/rivet2-core';
import type { ProjectExecutionSnapshot } from '../state/dataFlow.js';
import { settleObservedRunActivityRoot } from '../features/runActivity/runActivityJournal.js';
import {
  interruptRunningProcesses,
  reconcileRunningProcessesAfterSuccessfulDone,
  removeRunningGraphEntry,
} from './graphExecutionEventHelpers.js';

/** An explicit document replacement ends display ownership, not the accepted execution. */
export function retireProjectExecutionDisplay(snapshot: ProjectExecutionSnapshot): ProjectExecutionSnapshot {
  return produce(snapshot, (draft) => {
    for (const root of snapshot.runActivityJournal?.activeRootRunIds ?? [])
      draft.runActivityJournal = settleObservedRunActivityRoot(draft.runActivityJournal, root, 'aborted');
    draft.lastRunDataByNode = interruptRunningProcesses(snapshot.lastRunDataByNode);
    for (const runs of Object.values(draft.graphRunHistoryByView))
      for (const run of runs) {
        if (run.status !== 'running') continue;
        run.status = 'aborted';
        run.finishedAt = Date.now();
      }
    draft.graphRunning = false;
    draft.completedRootRunIds = [];
    draft.graphPaused = false;
    draft.runningGraphs = [];
    draft.userInputQuestions = {};
  });
}

/** Exact-root display completion; never stops a processor or changes command ownership. */
export function settleProjectExecutionObservation(
  snapshot: ProjectExecutionSnapshot,
  root: string,
  status: 'completed' | 'error' | 'aborted',
) {
  const rootRunId = root as RootRunId;
  return produce(snapshot, (draft) => {
    // Passive projections finish through explicit settlement, not source done.
    // Their rebased graphFinish can still have queued this root for legacy done.
    draft.completedRootRunIds = (snapshot.completedRootRunIds ?? []).filter((id) => id !== rootRunId);
    draft.runActivityJournal = settleObservedRunActivityRoot(snapshot.runActivityJournal, rootRunId, status);
    draft.lastRunDataByNode =
      status === 'completed'
        ? reconcileRunningProcessesAfterSuccessfulDone(snapshot.lastRunDataByNode, { rootRunId })
        : interruptRunningProcesses(snapshot.lastRunDataByNode, rootRunId);
    for (const runs of Object.values(draft.graphRunHistoryByView))
      for (const run of runs) {
        if (run.rootRunId !== rootRunId || run.status !== 'running') continue;
        run.status = status === 'completed' ? 'ok' : status;
        run.finishedAt = Date.now();
        draft.runningGraphs = removeRunningGraphEntry(draft.runningGraphs, run.graphId);
      }
  });
}
