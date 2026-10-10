import { useEffect, useRef, useState } from 'react';
import type { ProjectId } from '@valerypopoff/rivet2-core';
import type { EvaluationRun, EvaluationRunStore } from '@valerypopoff/rivet2-evaluations';
import {
  isEvaluationRunHistoryCached,
  type EvaluationRunHistoryScope,
  type EvaluationsState,
} from '../../state/evaluations.js';
import { mergeEvaluationRunHistory, type EvaluationRunHistoryLoadStatus } from './evaluationWorkspaceModel.js';

export function useEvaluationHistory({
  state,
  setState,
  projectId,
  projectAvailable,
  selectedSuiteId,
  runStore,
  suiteRuns,
  suiteCurrentRun,
  hasCachedRunHistory,
}: {
  state: EvaluationsState;
  setState: (update: (state: EvaluationsState) => EvaluationsState) => void;
  projectId: ProjectId;
  projectAvailable: boolean;
  selectedSuiteId?: string;
  runStore: EvaluationRunStore;
  suiteRuns: EvaluationRun[];
  suiteCurrentRun?: EvaluationRun;
  hasCachedRunHistory: boolean;
}) {
  const [runsStatus, setRunsStatus] = useState<EvaluationRunHistoryLoadStatus>('idle');
  const [runsError, setRunsError] = useState<string>();
  const [runDetailsLoading, setRunDetailsLoading] = useState(false);
  const [runDetailsError, setRunDetailsError] = useState<string>();
  const [loadingHistoryPage, setLoadingHistoryPage] = useState(false);
  const historyPageRequest = useRef<object>();
  const [runDetailsRetry, setRunDetailsRetry] = useState(0);
  const [historyRevision, setHistoryRevision] = useState(0);
  // Reading history is asynchronous, while deleting a run updates the store
  // and local selection immediately. A request generation prevents an older
  // read from putting the deleted record back into the Runs view afterward.
  const runHistoryReadGeneration = useRef(0);
  useEffect(
    () => () => {
      // The workspace atom outlives this overlay. An abandoned page must not
      // merge into a reopened panel, even when it has the same project/suite.
      runHistoryReadGeneration.current += 1;
      historyPageRequest.current = undefined;
    },
    [],
  );
  // The overlay unmounts while Canvas is active. Keep the latest cache marker
  // in a ref so returning to the same suite does not replay every retained run
  // payload from durable storage merely because this effect starts again.
  const runHistoryScopeRef = useRef(state.runHistoryScope);
  runHistoryScopeRef.current = state.runHistoryScope;
  useEffect(() => {
    const readGeneration = ++runHistoryReadGeneration.current;
    historyPageRequest.current = undefined;
    setLoadingHistoryPage(false);
    if (!projectAvailable) {
      setRunsStatus('idle');
      setRunsError(undefined);
      setState((current) =>
        current.runs.length === 0 &&
        current.selectedRunId == null &&
        current.currentRun == null &&
        current.runHistoryScope == null &&
        current.runTrialExpansion == null
          ? current
          : {
              ...current,
              runs: [],
              runHistoryScope: undefined,
              runTrialExpansion: undefined,
              selectedRunId: undefined,
              currentRun: undefined,
            },
      );
      return;
    }
    if (!selectedSuiteId) {
      // A dataset is a peer editor, not a new run-history scope. Keep the
      // last suite's fully hydrated history and presentation warm so a quick
      // resource switch does not reread and rebuild the Runs pane.
      setRunsStatus('idle');
      setRunsError(undefined);
      return;
    }

    const scope: EvaluationRunHistoryScope = { projectId: projectId, suiteId: selectedSuiteId };
    const hadCachedHistory = isEvaluationRunHistoryCached({ runHistoryScope: runHistoryScopeRef.current }, scope);
    // A successfully listed exact scope has a warm first page. Reuse it
    // on an overlay remount instead of doing a synchronous-heavy durable read
    // before Definition, Runs, or Compare can respond to a tab click.
    setRunsStatus(hadCachedHistory ? 'ready' : 'loading');
    setRunsError(undefined);
    if (hadCachedHistory) return;

    let active = true;
    const readHistory = async () => {
      const input = { projectId: projectId, suiteId: selectedSuiteId };
      if (!runStore.listPage) return { runs: await runStore.list(input), entries: undefined, nextCursor: undefined };
      const page = await runStore.listPage(input);
      // Render the picker as soon as headers arrive. Selected bodies have one
      // independent hydration path below, including initial loads and retries.
      return {
        runs: [] as EvaluationRun[],
        entries: page.runs.filter((run) => run.projectId === input.projectId && run.suiteId === input.suiteId),
        nextCursor: page.nextCursor,
      };
    };
    void readHistory()
      .then(({ runs, entries, nextCursor }) => {
        if (!active || readGeneration !== runHistoryReadGeneration.current) return;
        setRunsStatus('ready');
        setState((current) => {
          // The store contract accepts a suite filter, but retain the client
          // boundary as well. A stale or buggy host store must not leak a
          // different suite's history into the selected suite or its Compare
          // view.
          const persistedSuiteRuns = runs.filter(
            (run) => run.projectId === projectId && run.suiteId === selectedSuiteId,
          );
          const mergedRuns = mergeEvaluationRunHistory(
            persistedSuiteRuns,
            current.currentRun?.projectId === projectId && current.currentRun.suiteId === selectedSuiteId
              ? current.currentRun
              : undefined,
          );
          const selectedRunId =
            current.selectedRunId &&
            (entries !== undefined || mergedRuns.some((run) => run.id === current.selectedRunId))
              ? current.selectedRunId
              : mergedRuns[0]?.id ?? entries?.[0]?.id;
          return {
            ...current,
            runs: mergedRuns,
            runHistoryEntries: entries ? [...entries] : undefined,
            runHistoryNextCursor: nextCursor,
            // Only a successful list proves this history page is warm.
            // Progress and terminal snapshots intentionally do not set this.
            runHistoryScope: scope,
            runTrialExpansion:
              current.runTrialExpansion?.scope.projectId === scope.projectId &&
              current.runTrialExpansion.scope.suiteId === scope.suiteId &&
              current.runTrialExpansion.runId === selectedRunId
                ? current.runTrialExpansion
                : undefined,
            selectedRunId,
          };
        });
      })
      .catch((error: unknown) => {
        if (!active || readGeneration !== runHistoryReadGeneration.current) return;
        setRunsStatus('error');
        setRunsError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      active = false;
    };
    // Run lifecycle changes are delivered directly by the executor. In
    // particular, a terminal update atomically installs and selects the final
    // in-memory run before recording retention and persistence. Reloading
    // history when `runningSuiteId` changes would briefly replace that selection
    // with whichever old run the store returned first.
  }, [projectId, projectAvailable, runStore, selectedSuiteId, setState, historyRevision, hasCachedRunHistory]);

  useEffect(() => {
    setRunDetailsError(undefined);
    if (
      !hasCachedRunHistory ||
      !runStore.listPage ||
      !state.selectedRunId ||
      suiteRuns.some((run) => run.id === state.selectedRunId) ||
      suiteCurrentRun?.id === state.selectedRunId
    ) {
      setRunDetailsLoading(false);
      return;
    }
    let active = true;
    setRunDetailsLoading(true);
    const readGeneration = runHistoryReadGeneration.current;
    void runStore
      .get({ projectId: projectId, runId: state.selectedRunId })
      .then((run) => {
        if (!active || readGeneration !== runHistoryReadGeneration.current) return;
        if (!run || run.suiteId !== selectedSuiteId) {
          // A persisted selection can be older than the first page or belong
          // to the previously selected suite. Only replace an unavailable
          // selection when it wasn't advertised in this scope's headers.
          const entries = state.runHistoryEntries ?? [];
          const fallback = entries.find((entry) => entry.suiteId === selectedSuiteId)?.id;
          if (
            fallback &&
            fallback !== state.selectedRunId &&
            !entries.some((entry) => entry.id === state.selectedRunId)
          ) {
            setState((current) =>
              current.selectedRunId !== state.selectedRunId ||
              current.runHistoryScope?.projectId !== projectId ||
              current.runHistoryScope?.suiteId !== selectedSuiteId
                ? current
                : { ...current, selectedRunId: fallback, runTrialExpansion: undefined },
            );
            setRunDetailsLoading(false);
            return;
          }
          throw new Error('This evaluation run is no longer available.');
        }
        if (run.id !== state.selectedRunId || run.projectId !== projectId)
          throw new Error('Evaluation run details do not match the selected project and run.');
        setState((current) =>
          current.selectedRunId !== state.selectedRunId ||
          current.runHistoryScope?.projectId !== projectId ||
          current.runHistoryScope?.suiteId !== selectedSuiteId ||
          current.runs.some((item) => item.id === run.id) ||
          current.currentRun?.id === run.id
            ? current
            : { ...current, runs: [...current.runs.slice(-9), run] },
        );
        setRunDetailsLoading(false);
      })
      .catch((error) => {
        if (!active || readGeneration !== runHistoryReadGeneration.current) return;
        setRunDetailsLoading(false);
        setRunDetailsError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      active = false;
    };
  }, [
    hasCachedRunHistory,
    runStore,
    state.selectedRunId,
    projectId,
    selectedSuiteId,
    suiteRuns,
    suiteCurrentRun,
    state.runHistoryEntries,
    setState,
    runDetailsRetry,
    historyRevision,
  ]);

  const loadMoreRunHistory = async () => {
    if (
      historyPageRequest.current ||
      !hasCachedRunHistory ||
      !runStore.listPage ||
      !state.runHistoryNextCursor ||
      !selectedSuiteId
    )
      return;
    const request = {};
    historyPageRequest.current = request;
    const generation = runHistoryReadGeneration.current;
    setLoadingHistoryPage(true);
    setRunsError(undefined);
    try {
      const page = await runStore.listPage({
        projectId: projectId,
        suiteId: selectedSuiteId,
        after: state.runHistoryNextCursor,
      });
      if (generation !== runHistoryReadGeneration.current) return;
      const entries = page.runs.filter((run) => run.projectId === projectId && run.suiteId === selectedSuiteId);
      setState((current) =>
        current.runHistoryScope?.projectId !== projectId ||
        current.runHistoryScope.suiteId !== selectedSuiteId ||
        current.runHistoryNextCursor !== state.runHistoryNextCursor
          ? current
          : {
              ...current,
              runHistoryEntries: [
                ...new Map(
                  [...(current.runHistoryEntries ?? []), ...entries].map((entry) => [entry.id, entry]),
                ).values(),
              ],
              runHistoryNextCursor: page.nextCursor,
            },
      );
    } catch (error) {
      if (generation === runHistoryReadGeneration.current)
        setRunsError(error instanceof Error ? error.message : String(error));
    } finally {
      if (historyPageRequest.current === request) {
        historyPageRequest.current = undefined;
        setLoadingHistoryPage(false);
      }
    }
  };

  return {
    runsStatus,
    runsError,
    runDetailsLoading,
    runDetailsError,
    loadingHistoryPage,
    setRunDetailsRetry,
    loadMoreRunHistory,
    invalidateHistory: () => {
      // Fence reads synchronously at the durable mutation boundary, then let
      // effects restart any still-needed cold page/detail. Merely changing the
      // token can otherwise strand a canceled detail in its loading state.
      runHistoryReadGeneration.current += 1;
      historyPageRequest.current = undefined;
      setLoadingHistoryPage(false);
      setHistoryRevision((revision) => revision + 1);
    },
    markHistoryReady: () => {
      setRunsStatus('ready');
      setRunsError(undefined);
    },
  };
}
