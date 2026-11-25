import { useCallback, useRef, useState } from 'react';
import type { WorkflowRecordingCounts } from '../../studio-server-shared/workflow-recording-types';
import { fetchWorkflowRecordingRuns } from './workflowApi';
import { countsAfterDeletingRun } from './recording-run-counts';
import type {
  WorkflowRecordingFilterStatus,
  WorkflowRecordingInputFilter,
  WorkflowRecordingInputFilterOperator,
  WorkflowRecordingRunSummary,
  WorkflowRecordingRunsPageResponse,
} from './types';

type InputSearchStatus = 'idle' | 'searching' | 'complete' | 'stopped';

type InputSearchProgress = {
  analyzedRuns: number;
  availableRuns: number | null;
};

type RecordingRunsView = {
  workflowId: string;
  page: number;
  pageSize: number;
  status: WorkflowRecordingFilterStatus;
  inputFilter: WorkflowRecordingInputFilter | null;
};

type RecordingRunsPageOptions = Omit<
  Parameters<typeof fetchWorkflowRecordingRuns>[1],
  'includeSubgraphRuns' | 'groupByRoot'
>;

function loadWorkflowRecordingRunsPage(workflowId: string, options: RecordingRunsPageOptions) {
  return fetchWorkflowRecordingRuns(workflowId, { ...options, includeSubgraphRuns: true, groupByRoot: true });
}

function getNextInputSearchProgress(
  currentProgress: InputSearchProgress,
  response: WorkflowRecordingRunsPageResponse,
): InputSearchProgress {
  const responseAnalyzedRuns = response.inputSearchAnalyzedRuns ?? response.nextInputCursor;
  const availableRuns = response.scopeCounts
    ? response.statusFilter === 'failed'
      ? response.scopeCounts.failedRuns + response.scopeCounts.suspiciousRuns
      : response.scopeCounts.totalRuns
    : currentProgress.availableRuns;
  const analyzedRuns = Math.max(
    currentProgress.analyzedRuns,
    responseAnalyzedRuns ??
      (response.hasMore ? currentProgress.analyzedRuns : availableRuns ?? currentProgress.analyzedRuns),
  );

  return {
    // Catalog counts are an estimate, not a frozen search snapshot. Use the
    // scanner's cumulative count once it reaches the end of its keyset.
    availableRuns: response.hasMore
      ? availableRuns === null
        ? null
        : Math.max(availableRuns, analyzedRuns)
      : responseAnalyzedRuns !== undefined || availableRuns !== null
        ? analyzedRuns
        : null,
    analyzedRuns,
  };
}

export function useRecordingRunsQuery() {
  const [runsLoading, setRunsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runsPage, setRunsPage] = useState<WorkflowRecordingRunsPageResponse | null>(null);
  const [relatedCounts, setRelatedCounts] = useState<{ workflowId: string; counts: WorkflowRecordingCounts } | null>(
    null,
  );
  const [runsPerPage, setRunsPerPage] = useState<number>(20);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<WorkflowRecordingFilterStatus>('all');
  const [inputFilterVisible, setInputFilterVisible] = useState(false);
  const [inputFilterPath, setInputFilterPath] = useState('$');
  const [inputFilterOperator, setInputFilterOperator] = useState<WorkflowRecordingInputFilterOperator>('==');
  const [inputFilterValue, setInputFilterValue] = useState('');
  const [appliedInputFilter, setAppliedInputFilter] = useState<WorkflowRecordingInputFilter | null>(null);
  const [inputFilterRuns, setInputFilterRuns] = useState<WorkflowRecordingRunSummary[]>([]);
  const [inputSearchStatus, setInputSearchStatus] = useState<InputSearchStatus>('idle');
  const [inputSearchProgress, setInputSearchProgress] = useState<InputSearchProgress | null>(null);
  const [inputFilterError, setInputFilterError] = useState<string | null>(null);
  const inputSearchAbortControllerRef = useRef<AbortController | null>(null);

  const abortInputSearch = useCallback(() => {
    inputSearchAbortControllerRef.current?.abort();
    inputSearchAbortControllerRef.current = null;
  }, []);

  const reset = useCallback(() => {
    abortInputSearch();
    setRunsPage(null);
    setRelatedCounts(null);
    setError(null);
    setPage(1);
    setRunsPerPage(20);
    setStatusFilter('all');
    setInputFilterVisible(false);
    setInputFilterPath('$');
    setInputFilterOperator('==');
    setInputFilterValue('');
    setAppliedInputFilter(null);
    setInputFilterRuns([]);
    setInputSearchStatus('idle');
    setInputSearchProgress(null);
    setInputFilterError(null);
    setRunsLoading(false);
  }, [abortInputSearch]);

  const startView = useCallback((view: RecordingRunsView, initialAvailableRuns: number | null) => {
    const {
      workflowId: selectedWorkflowId,
      page,
      pageSize: runsPerPage,
      status: statusFilter,
      inputFilter: appliedInputFilter,
    } = view;
    setRelatedCounts(null);
    let cancelled = false;
    const abortController = new AbortController();
    inputSearchAbortControllerRef.current = appliedInputFilter ? abortController : null;
    setRunsLoading(true);
    setRunsPage(null);
    setError(null);

    if (appliedInputFilter) {
      const seenIds = new Set<string>();
      const seenContinuations = new Set<string>();
      setInputFilterRuns([]);
      setInputSearchStatus('searching');
      setInputSearchProgress({
        analyzedRuns: 0,
        availableRuns: initialAvailableRuns,
      });

      void (async () => {
        let nextCursor = 0;
        let nextAfter: string | undefined;
        while (!cancelled && !abortController.signal.aborted) {
          const response = await loadWorkflowRecordingRunsPage(selectedWorkflowId, {
            page: 1,
            // Preserve quick initial discovery; subsequent search batches are
            // independent of ordinary table pagination and fill the virtual list.
            pageSize: nextCursor === 0 && !nextAfter ? runsPerPage : 100,
            status: statusFilter,
            inputFilter: appliedInputFilter,
            inputCursor: nextCursor,
            inputAfter: nextAfter,
            signal: abortController.signal,
          });

          if (cancelled || abortController.signal.aborted) {
            return;
          }

          setRunsPage((current) => ({
            ...response,
            unsearchableRuns: response.unsearchableRuns ?? current?.unsearchableRuns,
          }));
          if (response.scopeCounts) {
            setRelatedCounts({ workflowId: response.workflowId, counts: response.scopeCounts });
          }
          const newRuns = response.runs.filter((run) => {
            if (seenIds.has(run.id)) {
              return false;
            }
            seenIds.add(run.id);
            return true;
          });
          if (newRuns.length > 0) {
            setInputFilterRuns((currentRuns) => [...currentRuns, ...newRuns]);
          }
          setInputSearchProgress((currentProgress) =>
            currentProgress ? getNextInputSearchProgress(currentProgress, response) : currentProgress,
          );

          const responseNextCursor = response.nextInputCursor;
          const responseNextAfter = response.nextInputAfter;
          if (!response.hasMore) {
            setInputSearchStatus('complete');
            return;
          }

          if (
            (responseNextAfter != null && seenContinuations.has(responseNextAfter)) ||
            (responseNextAfter == null && (responseNextCursor == null || responseNextCursor <= nextCursor))
          ) {
            throw new Error('Recording input search returned a continuation that did not advance.');
          }

          // A continuation can be followed only once in this search, even if
          // other tokens were returned between its first and next appearance.
          if (responseNextAfter != null) seenContinuations.add(responseNextAfter);
          nextCursor = responseNextCursor ?? nextCursor;
          nextAfter = responseNextAfter;
        }
      })()
        .catch((err) => {
          if (!cancelled && !abortController.signal.aborted) {
            setError(err instanceof Error ? err.message : String(err));
            setInputSearchStatus('stopped');
          }
        })
        .finally(() => {
          const isCurrentSearch = inputSearchAbortControllerRef.current === abortController;
          if (!cancelled && isCurrentSearch) {
            setRunsLoading(false);
          }
          if (isCurrentSearch) {
            inputSearchAbortControllerRef.current = null;
          }
        });
    } else {
      setInputFilterRuns([]);
      setInputSearchStatus('idle');
      setInputSearchProgress(null);

      void loadWorkflowRecordingRunsPage(selectedWorkflowId, {
        page,
        pageSize: runsPerPage,
        status: statusFilter,
        inputFilter: null,
        signal: abortController.signal,
      })
        .then((response) => {
          if (!cancelled) {
            setRunsPage(response);
          }
        })
        .catch((err) => {
          if (!cancelled && !abortController.signal.aborted) {
            setError(err instanceof Error ? err.message : String(err));
          }
        })
        .finally(() => {
          if (!cancelled) {
            setRunsLoading(false);
          }
        });
    }

    return () => {
      cancelled = true;
      abortController.abort();
      if (inputSearchAbortControllerRef.current === abortController) inputSearchAbortControllerRef.current = null;
    };
  }, []);

  const rememberScopeCounts = useCallback((response: WorkflowRecordingRunsPageResponse | null) => {
    if (response?.scopeCounts) setRelatedCounts({ workflowId: response.workflowId, counts: response.scopeCounts });
  }, []);

  const handleApplyInputFilter = useCallback(() => {
    if (inputSearchStatus === 'searching') return false;
    const path = inputFilterPath.trim();
    if (!path.startsWith('$')) {
      setInputFilterError('JSON path must start with $');
      return false;
    }

    setInputFilterError(null);
    setAppliedInputFilter({
      path,
      operator: inputFilterOperator,
      value: inputFilterOperator === 'exists' || inputFilterOperator === 'not_exists' ? '' : inputFilterValue,
    });
    setInputFilterRuns([]);
    setInputSearchStatus('searching');
    setInputSearchProgress(null);
    setPage(1);
    return true;
  }, [inputFilterOperator, inputFilterPath, inputFilterValue, inputSearchStatus]);

  const handleClearInputFilter = useCallback(() => {
    abortInputSearch();
    setInputFilterError(null);
    setAppliedInputFilter(null);
    setInputFilterPath('$');
    setInputFilterOperator('==');
    setInputFilterValue('');
    setInputFilterRuns([]);
    setInputSearchStatus('idle');
    setInputSearchProgress(null);
    setPage(1);
  }, [abortInputSearch]);

  const handleSetInputFilterVisible = useCallback(
    (visible: boolean) => {
      setInputFilterVisible(visible);
      setInputFilterError(null);
      if (!visible) {
        abortInputSearch();
        setAppliedInputFilter(null);
        setInputFilterRuns([]);
        setInputSearchStatus('idle');
        setInputSearchProgress(null);
        setPage(1);
      }
    },
    [abortInputSearch],
  );

  const handleStopInputSearch = useCallback(() => {
    abortInputSearch();
    if (appliedInputFilter) {
      setInputSearchStatus('stopped');
      setRunsLoading(false);
    }
  }, [abortInputSearch, appliedInputFilter]);

  const beginDeletion = useCallback(() => {
    abortInputSearch();
    if (appliedInputFilter && inputSearchStatus === 'searching') setInputSearchStatus('stopped');
    setRunsLoading(true);
    setError(null);
  }, [abortInputSearch, appliedInputFilter, inputSearchStatus]);

  const reconcileDeletedRecording = useCallback(
    (recordingId: string, deletingRun: WorkflowRecordingRunSummary | undefined, view: RecordingRunsView) => {
      const countsIncludeDeletedRun =
        !view.inputFilter || deletingRun?.executionIdentity?.surface !== 'subgraph_project';
      setInputFilterRuns((runs) => runs.filter((run) => run.id !== recordingId));
      if (deletingRun) {
        setRelatedCounts((current) => {
          if (current?.workflowId !== view.workflowId) return null;
          // Input search counts roots. A child deletion must retain these counts
          // even when the latest continuation omitted scopeCounts.
          return countsIncludeDeletedRun
            ? { ...current, counts: countsAfterDeletingRun(current.counts, deletingRun) }
            : current;
        });
      }
      setRunsPage((current) => {
        if (!current) return current;
        return {
          ...current,
          runs: current.runs.filter((run) => run.id !== recordingId),
          // A child does not consume a family slot; the refresh supplies the authoritative total.
          totalRuns: current.totalRuns,
          scopeCounts:
            deletingRun && current.scopeCounts && countsIncludeDeletedRun
              ? countsAfterDeletingRun(current.scopeCounts, deletingRun)
              : current.scopeCounts,
        };
      });
      if (
        !view.inputFilter &&
        Boolean(view.workflowId && deletingRun?.executionIdentity?.correlationId) &&
        deletingRun?.executionIdentity?.surface !== 'subgraph_project'
      ) {
        // A removed root anchor also invalidates membership of retained children in this scope.
        setRunsPage(null);
        setRelatedCounts(null);
      }
    },
    [],
  );

  const clearMissingWorkflowResults = useCallback(() => {
    setRunsPage(null);
    setInputFilterRuns([]);
  }, []);

  const restartInputSearch = useCallback((filter: WorkflowRecordingInputFilter) => {
    setAppliedInputFilter({ ...filter });
  }, []);

  // This read never publishes its completion. The parent checks the mutation
  // token after awaiting it, then accepts the response synchronously.
  const readPageAfterDeletion = useCallback((view: RecordingRunsView) => {
    setRunsPage(null);
    return loadWorkflowRecordingRunsPage(view.workflowId, {
      page: view.page,
      pageSize: view.pageSize,
      status: view.status,
      inputFilter: null,
    });
  }, []);

  const acceptPageAfterDeletion = useCallback(
    (response: WorkflowRecordingRunsPageResponse, view: RecordingRunsView) => {
      if (response.totalRuns > 0 && response.runs.length === 0 && view.page > 1) {
        // The page effect alone owns the replacement request.
        setPage(Math.max(1, Math.ceil(response.totalRuns / view.pageSize)));
        return;
      }
      setRunsPage(response);
    },
    [],
  );
  const reportDeletionError = useCallback((message: string) => setError(message), []);
  const finishDeletion = useCallback(() => setRunsLoading(false), []);

  return {
    runsLoading,
    error,
    runsPage,
    relatedCounts,
    runsPerPage,
    page,
    statusFilter,
    inputFilterVisible,
    inputFilterPath,
    inputFilterOperator,
    inputFilterValue,
    appliedInputFilter,
    inputFilterRuns,
    inputSearchStatus,
    inputSearchProgress,
    inputFilterError,
    setRunsPerPage,
    setPage,
    setStatusFilter,
    setInputFilterPath,
    setInputFilterOperator,
    setInputFilterValue,
    handleSetInputFilterVisible,
    handleApplyInputFilter,
    handleClearInputFilter,
    handleStopInputSearch,
    reset,
    startView,
    rememberScopeCounts,
    beginDeletion,
    reconcileDeletedRecording,
    clearMissingWorkflowResults,
    restartInputSearch,
    readPageAfterDeletion,
    acceptPageAfterDeletion,
    reportDeletionError,
    finishDeletion,
  };
}
