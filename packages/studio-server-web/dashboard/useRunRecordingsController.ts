import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  sumWorkflowRecordingCounts,
  type WorkflowRecordingCounts,
} from '../../studio-server-shared/workflow-recording-types';
import {
  deleteWorkflowRecording as deleteWorkflowRecordingRequest,
  fetchWorkflowRecordingRuns,
  fetchRecordingSubRuns,
  fetchWorkflowRecordingWorkflows,
} from './workflowApi';
import type {
  WorkflowRecordingFilterStatus,
  WorkflowRecordingInputFilter,
  WorkflowRecordingInputFilterOperator,
  WorkflowRecordingRunSummary,
  WorkflowRecordingRunsPageResponse,
  WorkflowRecordingWorkflowListResponse,
} from './types';

type InputSearchStatus = 'idle' | 'searching' | 'complete' | 'stopped';

type InputSearchProgress = {
  analyzedRuns: number;
  availableRuns: number;
};

function countsAfterDeletingRun<T extends WorkflowRecordingCounts>(counts: T, run: WorkflowRecordingRunSummary): T {
  return {
    ...counts,
    totalRuns: Math.max(0, counts.totalRuns - 1),
    failedRuns: Math.max(0, counts.failedRuns - Number(run.status === 'failed')),
    suspiciousRuns: Math.max(0, counts.suspiciousRuns - Number(run.status === 'suspicious')),
  };
}

function getAvailableInputSearchRuns(
  response: WorkflowRecordingWorkflowListResponse | null,
  workflowId: string,
  statusFilter: WorkflowRecordingFilterStatus,
): number {
  const counts = workflowId
    ? response?.workflows.find((workflow) => workflow.workflowId === workflowId)
    : response?.totals ?? sumWorkflowRecordingCounts(response?.workflows ?? []);
  if (!counts) return 0;
  return statusFilter === 'failed' ? counts.failedRuns + counts.suspiciousRuns : counts.totalRuns;
}

function getNextInputSearchProgress(
  currentProgress: InputSearchProgress,
  response: WorkflowRecordingRunsPageResponse,
): InputSearchProgress {
  const responseAnalyzedRuns = response.inputSearchAnalyzedRuns ?? response.nextInputCursor;
  const analyzedRuns = Math.max(
    currentProgress.analyzedRuns,
    responseAnalyzedRuns ?? (response.hasMore ? currentProgress.analyzedRuns : currentProgress.availableRuns),
  );

  return {
    // Catalog counts are an estimate, not a frozen search snapshot. Use the
    // scanner's cumulative count once it reaches the end of its keyset.
    availableRuns: response.hasMore
      ? Math.max(
          response.scopeCounts
            ? response.statusFilter === 'failed'
              ? response.scopeCounts.failedRuns + response.scopeCounts.suspiciousRuns
              : response.scopeCounts.totalRuns
            : currentProgress.availableRuns,
          analyzedRuns,
        )
      : analyzedRuns,
    analyzedRuns,
  };
}

export function useRunRecordingsController(isOpen: boolean, resetToken = 0) {
  const [workflowsResponse, setWorkflowsResponse] = useState<WorkflowRecordingWorkflowListResponse | null>(null);
  const [workflowsLoading, setWorkflowsLoading] = useState(true);
  const [runsLoading, setRunsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState('');
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
  const [subRuns, setSubRuns] = useState<WorkflowRecordingRunSummary[]>([]);
  const [childLoadStates, setChildLoadStates] = useState<Record<string, 'loading' | 'complete' | 'failed'>>({});
  const [childLoadErrors, setChildLoadErrors] = useState<Record<string, string>>({});
  const childRequestsRef = useRef(new Map<string, AbortController>());
  const [inputSearchStatus, setInputSearchStatus] = useState<InputSearchStatus>('idle');
  const [inputSearchProgress, setInputSearchProgress] = useState<InputSearchProgress | null>(null);
  const [inputFilterError, setInputFilterError] = useState<string | null>(null);
  const [deletingRecordingId, setDeletingRecordingId] = useState<string | null>(null);
  const inputSearchAbortControllerRef = useRef<AbortController | null>(null);
  const workflowsRef = useRef<WorkflowRecordingWorkflowListResponse | null>(null);
  const runsRequestVersionRef = useRef(0);
  const deletionRequestRef = useRef<object | null>(null);

  const loadWorkflowRecordingWorkflows = useCallback(
    (signal?: AbortSignal) => fetchWorkflowRecordingWorkflows({ signal }),
    [],
  );
  const loadWorkflowRecordingRunsPage = useCallback(
    (
      workflowId: string,
      options: {
        page: number;
        pageSize: number;
        status: WorkflowRecordingFilterStatus;
        inputFilter?: WorkflowRecordingInputFilter | null;
        inputCursor?: number;
        inputAfter?: string;
        signal?: AbortSignal;
      },
    ) => fetchWorkflowRecordingRuns(workflowId, { ...options, includeSubgraphRuns: true }),
    [],
  );
  const abortInputSearch = useCallback(() => {
    inputSearchAbortControllerRef.current?.abort();
    inputSearchAbortControllerRef.current = null;
  }, []);

  const resetSessionState = useCallback(() => {
    abortInputSearch();
    runsRequestVersionRef.current++;
    deletionRequestRef.current = null;
    setSelectedWorkflowId('');
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
    setWorkflowsResponse(null);
    setWorkflowsLoading(true);
    setDeletingRecordingId(null);
  }, [abortInputSearch]);

  useEffect(() => {
    resetSessionState();
  }, [resetSessionState, resetToken]);

  useEffect(() => {
    if (!isOpen || workflowsResponse) {
      return;
    }

    let cancelled = false;
    const abortController = new AbortController();
    setError(null);
    setWorkflowsLoading(true);

    void loadWorkflowRecordingWorkflows(abortController.signal)
      .then((response) => {
        if (!cancelled) {
          setWorkflowsResponse(response);
        }
      })
      .catch((err) => {
        if (!cancelled && !abortController.signal.aborted) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setWorkflowsLoading(false);
        }
      });

    return () => {
      cancelled = true;
      abortController.abort();
    };
  }, [isOpen, loadWorkflowRecordingWorkflows, workflowsResponse]);

  const workflows = useMemo(() => workflowsResponse?.workflows ?? [], [workflowsResponse]);
  const workflowsReady = workflowsResponse !== null;

  useEffect(() => {
    if (selectedWorkflowId && !workflows.some((workflow) => workflow.workflowId === selectedWorkflowId)) {
      setSelectedWorkflowId('');
      setPage(1);
    }
  }, [selectedWorkflowId, workflows]);

  const selectedWorkflow = useMemo(
    () => workflows.find((workflow) => workflow.workflowId === selectedWorkflowId) ?? null,
    [selectedWorkflowId, workflows],
  );

  useEffect(() => {
    workflowsRef.current = workflowsResponse;
  }, [workflowsResponse]);

  useEffect(() => {
    const requestVersion = ++runsRequestVersionRef.current;
    for (const request of childRequestsRef.current.values()) request.abort();
    childRequestsRef.current.clear();
    setSubRuns([]);
    setChildLoadStates({});
    setChildLoadErrors({});
    setRelatedCounts(null);
    deletionRequestRef.current = null;
    setDeletingRecordingId(null);
    if (!workflowsReady) {
      setInputSearchProgress(null);
      return;
    }

    let cancelled = false;
    const abortController = new AbortController();
    inputSearchAbortControllerRef.current = appliedInputFilter ? abortController : null;
    setRunsLoading(true);
    setRunsPage(null);
    setError(null);

    if (appliedInputFilter) {
      const seenIds = new Set<string>();
      setInputFilterRuns([]);
      setInputSearchStatus('searching');
      setInputSearchProgress({
        analyzedRuns: 0,
        availableRuns: getAvailableInputSearchRuns(workflowsRef.current, selectedWorkflowId, statusFilter),
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

          setRunsPage(response);
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
            (responseNextAfter != null && responseNextAfter === nextAfter) ||
            (responseNextAfter == null && (responseNextCursor == null || responseNextCursor <= nextCursor))
          ) {
            throw new Error('Recording input search returned a continuation that did not advance.');
          }

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
      for (const request of childRequestsRef.current.values()) request.abort();
      childRequestsRef.current.clear();
      if (runsRequestVersionRef.current === requestVersion) runsRequestVersionRef.current++;
      abortController.abort();
      if (inputSearchAbortControllerRef.current === abortController) {
        inputSearchAbortControllerRef.current = null;
      }
    };
  }, [
    appliedInputFilter,
    loadWorkflowRecordingRunsPage,
    page,
    runsPerPage,
    selectedWorkflowId,
    statusFilter,
    workflowsReady,
  ]);

  const allWorkflowsRunsCount = getAvailableInputSearchRuns(workflowsResponse, '', 'all');
  const scopeCounts =
    (runsPage?.workflowId === selectedWorkflowId ? runsPage.scopeCounts : undefined) ??
    (relatedCounts?.workflowId === selectedWorkflowId ? relatedCounts.counts : undefined);
  useEffect(() => {
    if (runsPage?.scopeCounts) setRelatedCounts({ workflowId: runsPage.workflowId, counts: runsPage.scopeCounts });
  }, [runsPage]);
  const overallRunsCount =
    scopeCounts?.totalRuns ?? getAvailableInputSearchRuns(workflowsResponse, selectedWorkflowId, 'all');
  const badRunsCount = scopeCounts
    ? scopeCounts.failedRuns + scopeCounts.suspiciousRuns
    : getAvailableInputSearchRuns(workflowsResponse, selectedWorkflowId, 'failed');
  const visibleRuns = appliedInputFilter ? [...inputFilterRuns, ...subRuns] : runsPage?.runs ?? [];
  const filteredRunsCount = appliedInputFilter
    ? inputFilterRuns.length
    : runsPage?.totalRuns ?? (statusFilter === 'failed' ? badRunsCount : overallRunsCount);
  const totalPages = appliedInputFilter ? 1 : Math.max(1, Math.ceil(filteredRunsCount / runsPerPage));

  const handleLoadSubRuns = useCallback(
    async (key: string) => {
      if (!appliedInputFilter || !key.startsWith('correlation:')) return;
      const root = inputFilterRuns.find((run) => `correlation:${run.executionIdentity?.correlationId}` === key);
      if (!root || childLoadStates[root.id] === 'complete' || childRequestsRef.current.has(root.id)) return;
      const controller = new AbortController();
      const version = runsRequestVersionRef.current;
      childRequestsRef.current.set(root.id, controller);
      const isCurrent = () => !controller.signal.aborted && version === runsRequestVersionRef.current;
      setChildLoadStates((states) => ({ ...states, [root.id]: 'loading' }));
      setChildLoadErrors((errors) => {
        const next = { ...errors };
        delete next[root.id];
        return next;
      });
      try {
        // Fetch metadata in bounded pages, not input artifacts or all history.
        // Publish complete families only; failed attempts can safely retry.
        const children = new Map<string, WorkflowRecordingRunSummary>();
        let expectedCount: number | undefined;
        for (let childPage = 1; ; childPage++) {
          const response = await fetchRecordingSubRuns(root.id, childPage, controller.signal);
          if (!isCurrent()) return;
          if (
            response.workflowId !== root.id ||
            response.page !== childPage ||
            !Number.isSafeInteger(response.totalRuns) ||
            response.totalRuns < 0
          ) {
            throw new Error('Sub-run pagination returned the wrong recording or page.');
          }
          expectedCount ??= response.totalRuns;
          if (response.totalRuns !== expectedCount) {
            throw new Error('Sub-runs changed while loading. Retry to refresh the family.');
          }
          const previousCount = children.size;
          if (
            response.runs.some(
              (run) =>
                run.executionIdentity?.surface !== 'subgraph_project' ||
                run.executionIdentity.correlationId !== root.executionIdentity?.correlationId,
            )
          ) {
            throw new Error('Sub-run pagination returned an unrelated recording.');
          }
          for (const run of response.runs) children.set(run.id, run);
          if (
            children.size > expectedCount ||
            (response.hasMore && (children.size === previousCount || children.size >= expectedCount))
          ) {
            throw new Error('Sub-run pagination did not advance consistently.');
          }
          if (!response.hasMore) {
            if (children.size !== expectedCount) {
              throw new Error('Sub-run pagination was incomplete. Retry to refresh the family.');
            }
            break;
          }
        }
        if (!isCurrent()) return;
        setSubRuns((current) => [...new Map([...current, ...children.values()].map((run) => [run.id, run])).values()]);
        setChildLoadStates((states) => ({ ...states, [root.id]: 'complete' }));
      } catch (err) {
        if (isCurrent()) {
          setChildLoadStates((states) => ({ ...states, [root.id]: 'failed' }));
          setChildLoadErrors((errors) => ({
            ...errors,
            [root.id]: `Could not load sub-runs: ${err instanceof Error ? err.message : String(err)}`,
          }));
        }
      } finally {
        if (childRequestsRef.current.get(root.id) === controller) childRequestsRef.current.delete(root.id);
      }
    },
    [appliedInputFilter, inputFilterRuns, childLoadStates],
  );

  useEffect(() => {
    // Loading clears runsPage. Do not clamp against a possibly stale catalog
    // while the requested page's authoritative total is still in flight.
    if (runsLoading || !runsPage || appliedInputFilter) return;
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [appliedInputFilter, page, runsLoading, runsPage, totalPages]);

  const handleApplyInputFilter = useCallback(() => {
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
  }, [inputFilterOperator, inputFilterPath, inputFilterValue]);

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

  const handleDeleteRecording = useCallback(
    async (recordingId: string) => {
      // Serialize mutations within this view. A replacement view owns a fresh
      // token, so an older server-side deletion cannot block or update it.
      if (deletionRequestRef.current) return;
      if (!window.confirm('Are you sure you want to delete this recording? This action cannot be undone.')) {
        return;
      }

      const currentWorkflowId = selectedWorkflowId;
      const currentPage = page;
      const currentPageSize = runsPerPage;
      const currentStatusFilter = statusFilter;
      const currentInputFilter = appliedInputFilter;
      const deletingRun = visibleRuns.find((run) => run.id === recordingId);
      const changesRelatedScope =
        !currentInputFilter &&
        Boolean(currentWorkflowId && deletingRun?.executionIdentity?.correlationId) &&
        deletingRun?.executionIdentity?.surface !== 'subgraph_project';
      const requestVersion = runsRequestVersionRef.current;
      const deletionRequest = {};
      deletionRequestRef.current = deletionRequest;
      const isCurrent = () =>
        runsRequestVersionRef.current === requestVersion && deletionRequestRef.current === deletionRequest;
      let deleted = false;

      try {
        abortInputSearch();
        if (currentInputFilter && inputSearchStatus === 'searching') setInputSearchStatus('stopped');
        setDeletingRecordingId(recordingId);
        setRunsLoading(true);
        setError(null);

        await deleteWorkflowRecordingRequest(recordingId);
        deleted = true;
        if (!isCurrent()) return;
        // The mutation already committed, even if refreshing metadata later fails.
        setInputFilterRuns((currentRuns) => currentRuns.filter((run) => run.id !== recordingId));
        setChildLoadErrors((errors) => {
          const next = { ...errors };
          delete next[recordingId];
          return next;
        });
        for (const request of childRequestsRef.current.values()) request.abort();
        childRequestsRef.current.clear();
        setChildLoadStates((states) =>
          Object.fromEntries(Object.entries(states).map(([id, state]) => [id, state === 'loading' ? 'failed' : state])),
        );
        setSubRuns((currentRuns) =>
          currentRuns.filter(
            (run) =>
              run.id !== recordingId &&
              (deletingRun?.executionIdentity?.surface === 'subgraph_project' ||
                run.executionIdentity?.correlationId !== deletingRun?.executionIdentity?.correlationId),
          ),
        );
        if (deletingRun) {
          setWorkflowsResponse((current) =>
            current
              ? {
                  ...current,
                  totals: current.totals ? countsAfterDeletingRun(current.totals, deletingRun) : undefined,
                  workflows: current.workflows.map((workflow) =>
                    workflow.workflowId === deletingRun.workflowId
                      ? countsAfterDeletingRun(workflow, deletingRun)
                      : workflow,
                  ),
                }
              : current,
          );
          setRelatedCounts((current) =>
            current?.workflowId === currentWorkflowId &&
            (!currentInputFilter || deletingRun.executionIdentity?.surface !== 'subgraph_project')
              ? { ...current, counts: countsAfterDeletingRun(current.counts, deletingRun) }
              : null,
          );
        }
        setRunsPage((current) => {
          if (!current) return current;
          return {
            ...current,
            runs: current.runs.filter((run) => run.id !== recordingId),
            totalRuns: deletingRun && !currentInputFilter ? Math.max(0, current.totalRuns - 1) : current.totalRuns,
            scopeCounts:
              deletingRun &&
              current.scopeCounts &&
              (!currentInputFilter || deletingRun.executionIdentity?.surface !== 'subgraph_project')
                ? countsAfterDeletingRun(current.scopeCounts, deletingRun)
                : current.scopeCounts,
          };
        });
        if (changesRelatedScope) {
          // Removing a root anchor can remove other, still-retained children
          // from this scope, even if the following catalog refresh fails.
          setRunsPage(null);
          setRelatedCounts(null);
        }

        const nextWorkflowsResponse = await loadWorkflowRecordingWorkflows();
        if (!isCurrent()) return;
        setWorkflowsResponse(nextWorkflowsResponse);

        const refreshedWorkflow =
          nextWorkflowsResponse.workflows.find((workflow) => workflow.workflowId === currentWorkflowId) ?? null;
        if (currentWorkflowId && !refreshedWorkflow) {
          setRunsPage(null);
          setInputFilterRuns([]);
          return;
        }

        if (currentInputFilter) {
          if (deletingRun?.executionIdentity?.surface === 'subgraph_project') return;
          setAppliedInputFilter({ ...currentInputFilter });
          return;
        }

        setRunsPage(null);
        const nextRunsPage = await loadWorkflowRecordingRunsPage(currentWorkflowId, {
          page: currentPage,
          pageSize: currentPageSize,
          status: currentStatusFilter,
          inputFilter: null,
        });
        if (!isCurrent()) return;
        if (nextRunsPage.totalRuns > 0 && nextRunsPage.runs.length === 0 && currentPage > 1) {
          const nextPage = Math.max(1, Math.ceil(nextRunsPage.totalRuns / currentPageSize));
          // The page effect owns the replacement request. Do not race it with
          // another manually fetched page from this deletion callback.
          setPage(nextPage);
          return;
        }

        setRunsPage(nextRunsPage);
      } catch (err) {
        if (isCurrent()) {
          const message = err instanceof Error ? err.message : String(err);
          setError(deleted ? `Recording deleted, but refreshing the list failed: ${message}` : message);
        }
      } finally {
        if (isCurrent()) {
          setRunsLoading(false);
          setDeletingRecordingId(null);
          deletionRequestRef.current = null;
        }
      }
    },
    [
      loadWorkflowRecordingRunsPage,
      loadWorkflowRecordingWorkflows,
      page,
      runsPerPage,
      selectedWorkflowId,
      statusFilter,
      appliedInputFilter,
      inputSearchStatus,
      visibleRuns,
      abortInputSearch,
    ],
  );

  return {
    workflows,
    workflowsLoading,
    runsLoading,
    error,
    selectedWorkflowId,
    selectedWorkflow,
    runsPerPage,
    page,
    statusFilter,
    inputFilterVisible,
    inputFilterPath,
    inputFilterOperator,
    inputFilterValue,
    appliedInputFilter,
    inputFilterError,
    deletingRecordingId,
    overallRunsCount,
    allWorkflowsRunsCount,
    badRunsCount,
    filteredRunsCount,
    totalPages,
    inputSearchStatus,
    inputSearchProgress,
    visibleRuns,
    childLoadStates: appliedInputFilter ? childLoadStates : undefined,
    childLoadErrors: appliedInputFilter ? childLoadErrors : {},
    handleLoadSubRuns,
    setSelectedWorkflowId,
    setRunsPerPage,
    setPage,
    setStatusFilter,
    setInputFilterPath,
    setInputFilterOperator,
    setInputFilterValue,
    setInputFilterVisible: handleSetInputFilterVisible,
    handleApplyInputFilter,
    handleClearInputFilter,
    handleStopInputSearch,
    handleDeleteRecording,
  };
}
