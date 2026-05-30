import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  deleteWorkflowRecording as deleteWorkflowRecordingRequest,
  fetchWorkflowRecordingRuns,
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

function appendUniqueRuns(
  currentRuns: WorkflowRecordingRunSummary[],
  nextRuns: WorkflowRecordingRunSummary[],
): WorkflowRecordingRunSummary[] {
  const seenIds = new Set(currentRuns.map((run) => run.id));
  const uniqueNextRuns = nextRuns.filter((run) => {
    if (seenIds.has(run.id)) {
      return false;
    }

    seenIds.add(run.id);
    return true;
  });

  return uniqueNextRuns.length > 0 ? [...currentRuns, ...uniqueNextRuns] : currentRuns;
}

export function useRunRecordingsController(isOpen: boolean, resetToken = 0) {
  const [workflowsResponse, setWorkflowsResponse] = useState<WorkflowRecordingWorkflowListResponse | null>(null);
  const [workflowsLoading, setWorkflowsLoading] = useState(true);
  const [runsLoading, setRunsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState('');
  const [runsPage, setRunsPage] = useState<WorkflowRecordingRunsPageResponse | null>(null);
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
  const [inputFilterError, setInputFilterError] = useState<string | null>(null);
  const [deletingRecordingId, setDeletingRecordingId] = useState<string | null>(null);
  const inputSearchAbortControllerRef = useRef<AbortController | null>(null);

  const loadWorkflowRecordingWorkflows = useCallback((signal?: AbortSignal) => fetchWorkflowRecordingWorkflows({ signal }), []);
  const loadWorkflowRecordingRunsPage = useCallback((
    workflowId: string,
    options: {
      page: number;
      pageSize: number;
      status: WorkflowRecordingFilterStatus;
      inputFilter?: WorkflowRecordingInputFilter | null;
      inputCursor?: number;
      signal?: AbortSignal;
    },
  ) => fetchWorkflowRecordingRuns(workflowId, options), []);
  const abortInputSearch = useCallback(() => {
    inputSearchAbortControllerRef.current?.abort();
    inputSearchAbortControllerRef.current = null;
  }, []);

  const resetSessionState = useCallback(() => {
    abortInputSearch();
    setSelectedWorkflowId('');
    setRunsPage(null);
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

  useEffect(() => {
    if (workflows.length === 0) {
      setSelectedWorkflowId('');
      setPage(1);
      return;
    }

    if (!workflows.some((workflow) => workflow.workflowId === selectedWorkflowId)) {
      setSelectedWorkflowId(workflows[0]!.workflowId);
      setPage(1);
    }
  }, [selectedWorkflowId, workflows]);

  const selectedWorkflow = useMemo(
    () => workflows.find((workflow) => workflow.workflowId === selectedWorkflowId) ?? null,
    [selectedWorkflowId, workflows],
  );

  useEffect(() => {
    if (!selectedWorkflowId) {
      return;
    }

    let cancelled = false;
    const abortController = new AbortController();
    inputSearchAbortControllerRef.current = appliedInputFilter ? abortController : null;
    setRunsLoading(true);
    setRunsPage(null);
    setError(null);

    if (appliedInputFilter) {
      setInputFilterRuns([]);
      setInputSearchStatus('searching');

      void (async () => {
        let nextCursor = 0;
        while (!cancelled && !abortController.signal.aborted) {
          const response = await loadWorkflowRecordingRunsPage(selectedWorkflowId, {
            page: 1,
            pageSize: runsPerPage,
            status: statusFilter,
            inputFilter: appliedInputFilter,
            inputCursor: nextCursor,
            signal: abortController.signal,
          });

          if (cancelled || abortController.signal.aborted) {
            return;
          }

          setRunsPage(response);
          setInputFilterRuns((currentRuns) => appendUniqueRuns(currentRuns, response.runs));

          const responseNextCursor = response.nextInputCursor;
          if (!response.hasMore || responseNextCursor == null || responseNextCursor <= nextCursor) {
            setInputSearchStatus('complete');
            return;
          }

          nextCursor = responseNextCursor;
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
  ]);

  const overallRunsCount = selectedWorkflow?.totalRuns ?? 0;
  const badRunsCount = (selectedWorkflow?.failedRuns ?? 0) + (selectedWorkflow?.suspiciousRuns ?? 0);
  const visibleRuns = appliedInputFilter ? inputFilterRuns : runsPage?.runs ?? [];
  const filteredRunsCount = appliedInputFilter
    ? inputFilterRuns.length
    : runsPage?.totalRuns ?? (statusFilter === 'failed' ? badRunsCount : overallRunsCount);
  const totalPages = appliedInputFilter ? 1 : Math.max(1, Math.ceil(filteredRunsCount / runsPerPage));

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  const handleApplyInputFilter = useCallback(() => {
    const path = inputFilterPath.trim();
    if (!path.startsWith('$')) {
      setInputFilterError('JSON path must start with $');
      return;
    }

    setInputFilterError(null);
    setAppliedInputFilter({
      path,
      operator: inputFilterOperator,
      value: inputFilterOperator === 'exists' || inputFilterOperator === 'not_exists'
        ? ''
        : inputFilterValue,
    });
    setInputFilterRuns([]);
    setInputSearchStatus('searching');
    setPage(1);
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
    setPage(1);
  }, [abortInputSearch]);

  const handleSetInputFilterVisible = useCallback((visible: boolean) => {
    setInputFilterVisible(visible);
    setInputFilterError(null);
    if (!visible) {
      abortInputSearch();
      setAppliedInputFilter(null);
      setInputFilterRuns([]);
      setInputSearchStatus('idle');
      setPage(1);
    }
  }, [abortInputSearch]);

  const handleStopInputSearch = useCallback(() => {
    abortInputSearch();
    if (appliedInputFilter) {
      setInputSearchStatus('stopped');
      setRunsLoading(false);
    }
  }, [abortInputSearch, appliedInputFilter]);

  const handleDeleteRecording = useCallback(async (recordingId: string) => {
    if (!window.confirm('Are you sure you want to delete this recording? This action cannot be undone.')) {
      return;
    }

    const currentWorkflowId = selectedWorkflowId;
    const currentPage = page;
    const currentPageSize = runsPerPage;
    const currentStatusFilter = statusFilter;
    const currentInputFilter = appliedInputFilter;
    const currentInputSearchStatus = inputSearchStatus;

    try {
      abortInputSearch();
      setDeletingRecordingId(recordingId);
      setRunsLoading(true);
      setError(null);

      await deleteWorkflowRecordingRequest(recordingId);

      const nextWorkflowsResponse = await loadWorkflowRecordingWorkflows();
      setWorkflowsResponse(nextWorkflowsResponse);

      const refreshedWorkflow = nextWorkflowsResponse.workflows.find((workflow) => workflow.workflowId === currentWorkflowId) ?? null;
      if (!refreshedWorkflow) {
        setRunsPage(null);
        setInputFilterRuns([]);
        return;
      }

      if (currentInputFilter) {
        setInputFilterRuns((currentRuns) => currentRuns.filter((run) => run.id !== recordingId));
        setInputSearchStatus(currentInputSearchStatus === 'searching' ? 'stopped' : currentInputSearchStatus);
        setRunsPage(null);
        return;
      }

      setRunsPage(null);
      let nextRunsPage = await loadWorkflowRecordingRunsPage(refreshedWorkflow.workflowId, {
        page: currentPage,
        pageSize: currentPageSize,
        status: currentStatusFilter,
        inputFilter: null,
      });
      if (nextRunsPage.totalRuns > 0 && nextRunsPage.runs.length === 0 && currentPage > 1) {
        const nextPage = Math.max(1, Math.ceil(nextRunsPage.totalRuns / currentPageSize));
        setPage(nextPage);
        nextRunsPage = await loadWorkflowRecordingRunsPage(refreshedWorkflow.workflowId, {
          page: nextPage,
          pageSize: currentPageSize,
          status: currentStatusFilter,
          inputFilter: null,
        });
      }

      setRunsPage(nextRunsPage);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunsLoading(false);
      setDeletingRecordingId(null);
    }
  }, [
    loadWorkflowRecordingRunsPage,
    loadWorkflowRecordingWorkflows,
    page,
    runsPerPage,
    selectedWorkflowId,
    statusFilter,
    appliedInputFilter,
    inputSearchStatus,
    abortInputSearch,
  ]);

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
    badRunsCount,
    filteredRunsCount,
    totalPages,
    inputSearchStatus,
    visibleRuns,
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
