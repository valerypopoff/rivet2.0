import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { sumWorkflowRecordingCounts } from '../../studio-server-shared/workflow-recording-types';
import {
  deleteWorkflowRecording as deleteWorkflowRecordingRequest,
  fetchWorkflowRecordingWorkflows,
} from './workflowApi';
import { useRecordingSubRuns } from './useRecordingSubRuns';
import { useRecordingRunsQuery } from './useRecordingRunsQuery';
import { countsAfterDeletingRun } from './recording-run-counts';
import type {
  WorkflowProjectItem,
  WorkflowRecordingFilterStatus,
  WorkflowRecordingWorkflowListResponse,
} from './types';

function getAvailableInputSearchRuns(
  response: WorkflowRecordingWorkflowListResponse | null,
  workflowId: string,
  statusFilter: WorkflowRecordingFilterStatus,
): number | null {
  if (!response) return null;
  const counts = workflowId
    ? response.workflows.find((workflow) => workflow.workflowId === workflowId)
    : response.totals ?? sumWorkflowRecordingCounts(response.workflows);
  if (!counts) return 0;
  return statusFilter === 'failed' ? counts.failedRuns + counts.suspiciousRuns : counts.totalRuns;
}

export function useRunRecordingsController(
  sessionActive: boolean,
  resetToken = 0,
  initialProject: WorkflowProjectItem | null = null,
) {
  const initialProjectId = initialProject?.id ?? '';
  const sessionKey = JSON.stringify([resetToken, initialProjectId]);
  const [initializedSessionKey, setInitializedSessionKey] = useState<string | null>(null);
  const sessionReady = initializedSessionKey === sessionKey;
  const [refreshToken, setRefreshToken] = useState(0);
  const [workflowsResponse, setWorkflowsResponse] = useState<WorkflowRecordingWorkflowListResponse | null>(null);
  const [workflowsLoading, setWorkflowsLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState('');
  const {
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
    handleClearInputFilter,
    handleStopInputSearch,
    handleApplyInputFilter: applyInputFilter,
    reset: resetRunQuery,
    startView: startRunQuery,
    rememberScopeCounts,
    beginDeletion,
    reconcileDeletedRecording: reconcileDeletedRuns,
    clearMissingWorkflowResults,
    restartInputSearch,
    readPageAfterDeletion,
    acceptPageAfterDeletion,
    reportDeletionError,
    finishDeletion,
  } = useRecordingRunsQuery();
  const [deletingRecordingId, setDeletingRecordingId] = useState<string | null>(null);
  const workflowsRef = useRef<WorkflowRecordingWorkflowListResponse | null>(null);
  const runsRequestVersionRef = useRef(0);
  const deletionRequestRef = useRef<object | null>(null);
  const catalogAbortControllerRef = useRef<AbortController | null>(null);
  const primaryRuns = appliedInputFilter ? inputFilterRuns : runsPage?.runs ?? [];
  const {
    subRuns,
    childLoadStates,
    childLoadErrors,
    handleLoadSubRuns,
    resetForView: resetSubRuns,
    abortPending: abortSubRuns,
    reconcileDeletedRecording: reconcileDeletedSubRuns,
  } = useRecordingSubRuns(primaryRuns, selectedWorkflowId, runsRequestVersionRef);

  const abortCatalog = useCallback(() => {
    catalogAbortControllerRef.current?.abort();
    catalogAbortControllerRef.current = null;
  }, []);
  const loadWorkflowRecordingWorkflows = useCallback(
    async (reportError = true) => {
      abortCatalog();
      const controller = new AbortController();
      catalogAbortControllerRef.current = controller;
      const isCurrent = () => !controller.signal.aborted && catalogAbortControllerRef.current === controller;
      setWorkflowsLoading(true);
      setCatalogError(null);
      try {
        const response = await fetchWorkflowRecordingWorkflows({ signal: controller.signal });
        if (!isCurrent()) return null;
        workflowsRef.current = response;
        setWorkflowsResponse(response);
        return response;
      } catch (err) {
        if (!isCurrent()) return null;
        if (reportError) setCatalogError(err instanceof Error ? err.message : String(err));
        throw err;
      } finally {
        if (isCurrent()) {
          setWorkflowsLoading(false);
          catalogAbortControllerRef.current = null;
        }
      }
    },
    [abortCatalog],
  );
  const retryCatalog = useCallback(() => {
    void loadWorkflowRecordingWorkflows().catch(() => {});
  }, [loadWorkflowRecordingWorkflows]);
  const resetReadState = useCallback(() => {
    resetRunQuery();
    abortCatalog();
    runsRequestVersionRef.current++;
    deletionRequestRef.current = null;
    setCatalogError(null);
    setWorkflowsLoading(true);
    setDeletingRecordingId(null);
  }, [resetRunQuery, abortCatalog]);

  useEffect(() => {
    resetReadState();
    setSelectedWorkflowId(initialProjectId);
    setWorkflowsResponse(null);
    workflowsRef.current = null;
    setInitializedSessionKey(sessionKey);
  }, [initialProjectId, resetReadState, sessionKey]);

  const refresh = useCallback(() => {
    resetReadState();
    setRefreshToken((current) => current + 1);
  }, [resetReadState]);

  useEffect(() => {
    if (!sessionActive || !sessionReady) return;
    void loadWorkflowRecordingWorkflows().catch(() => {});
    return abortCatalog;
  }, [sessionActive, sessionReady, sessionKey, refreshToken, loadWorkflowRecordingWorkflows, abortCatalog]);

  const workflows = useMemo(() => {
    const catalog = sessionReady ? workflowsResponse?.workflows ?? [] : [];
    if (!initialProject || catalog.some((workflow) => workflow.workflowId === initialProject.id)) return catalog;
    return [
      ...catalog,
      { workflowId: initialProject.id, project: initialProject, totalRuns: 0, failedRuns: 0, suspiciousRuns: 0 },
    ];
  }, [initialProject, workflowsResponse, sessionReady]);

  useEffect(() => {
    if (
      sessionReady &&
      workflowsResponse &&
      selectedWorkflowId &&
      !workflows.some((workflow) => workflow.workflowId === selectedWorkflowId)
    ) {
      setSelectedWorkflowId('');
      setPage(1);
    }
  }, [selectedWorkflowId, workflows, sessionReady, workflowsResponse]);

  const selectedWorkflow = useMemo(
    () => workflows.find((workflow) => workflow.workflowId === selectedWorkflowId) ?? null,
    [selectedWorkflowId, workflows],
  );

  useEffect(() => {
    workflowsRef.current = workflowsResponse;
  }, [workflowsResponse]);

  useEffect(() => {
    if (!sessionActive || !sessionReady) return;
    const requestVersion = ++runsRequestVersionRef.current;
    resetSubRuns();
    deletionRequestRef.current = null;
    setDeletingRecordingId(null);
    const cancelQuery = startRunQuery(
      {
        workflowId: selectedWorkflowId,
        page,
        pageSize: runsPerPage,
        status: statusFilter,
        inputFilter: appliedInputFilter,
      },
      getAvailableInputSearchRuns(workflowsRef.current, selectedWorkflowId, statusFilter),
    );
    return () => {
      cancelQuery();
      abortSubRuns();
      if (runsRequestVersionRef.current === requestVersion) runsRequestVersionRef.current++;
    };
  }, [
    appliedInputFilter,
    startRunQuery,
    resetSubRuns,
    abortSubRuns,
    page,
    runsPerPage,
    selectedWorkflowId,
    statusFilter,
    sessionActive,
    sessionReady,
    sessionKey,
    refreshToken,
  ]);

  const allWorkflowsRunsCount = getAvailableInputSearchRuns(workflowsResponse, '', 'all');
  const scopeCounts =
    (runsPage?.workflowId === selectedWorkflowId ? runsPage.scopeCounts : undefined) ??
    (relatedCounts?.workflowId === selectedWorkflowId ? relatedCounts.counts : undefined);
  useEffect(() => {
    rememberScopeCounts(runsPage);
  }, [runsPage, rememberScopeCounts]);
  const overallRunsCount =
    scopeCounts?.totalRuns ?? getAvailableInputSearchRuns(workflowsResponse, selectedWorkflowId, 'all');
  const badRunsCount = scopeCounts
    ? scopeCounts.failedRuns + scopeCounts.suspiciousRuns
    : getAvailableInputSearchRuns(workflowsResponse, selectedWorkflowId, 'failed');
  const visibleRuns = [...primaryRuns, ...subRuns];
  const filteredRunsCount = appliedInputFilter ? inputFilterRuns.length : runsPage?.totalRuns ?? null;
  const totalPages = appliedInputFilter ? 1 : Math.max(1, Math.ceil((filteredRunsCount ?? 0) / runsPerPage));

  useEffect(() => {
    // Loading clears runsPage. Do not clamp against a possibly stale catalog
    // while the requested page's authoritative total is still in flight.
    if (runsLoading || !runsPage || appliedInputFilter) return;
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [appliedInputFilter, page, runsLoading, runsPage, totalPages]);

  const handleApplyInputFilter = useCallback(() => {
    if (!sessionActive || !sessionReady || deletingRecordingId) return false;
    return applyInputFilter();
  }, [sessionActive, sessionReady, deletingRecordingId, applyInputFilter]);

  const handleDeleteRecording = useCallback(
    async (recordingId: string) => {
      // A replacement view owns a fresh token; old mutations cannot update it.
      if (deletionRequestRef.current) return;
      if (!window.confirm('Are you sure you want to delete this recording? This action cannot be undone.')) return;
      const view = {
        workflowId: selectedWorkflowId,
        page,
        pageSize: runsPerPage,
        status: statusFilter,
        inputFilter: appliedInputFilter,
      };
      const deletingRun = visibleRuns.find((run) => run.id === recordingId);
      const requestVersion = runsRequestVersionRef.current;
      const deletionRequest = {};
      deletionRequestRef.current = deletionRequest;
      const isCurrent = () =>
        runsRequestVersionRef.current === requestVersion && deletionRequestRef.current === deletionRequest;
      let deleted = false;
      try {
        beginDeletion();
        setDeletingRecordingId(recordingId);
        await deleteWorkflowRecordingRequest(recordingId);
        deleted = true;
        if (!isCurrent()) return;
        // Do not let an opening snapshot restore counts after this committed deletion.
        abortCatalog();
        reconcileDeletedRuns(recordingId, deletingRun, view);
        reconcileDeletedSubRuns(recordingId, deletingRun);
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
        }
        const nextWorkflowsResponse = await loadWorkflowRecordingWorkflows(false);
        if (!isCurrent() || !nextWorkflowsResponse) return;
        const refreshedWorkflow =
          nextWorkflowsResponse.workflows.find((workflow) => workflow.workflowId === view.workflowId) ?? null;
        if (view.workflowId && !refreshedWorkflow) {
          clearMissingWorkflowResults();
          // Ordinary selections fall back to Any; inspected projects retain their empty history.
          if (view.workflowId !== initialProjectId) return;
        }
        if (view.inputFilter) {
          if (deletingRun?.executionIdentity?.surface === 'subgraph_project') return;
          restartInputSearch(view.inputFilter);
          return;
        }
        const nextRunsPage = await readPageAfterDeletion(view);
        if (!isCurrent()) return;
        acceptPageAfterDeletion(nextRunsPage, view);
      } catch (err) {
        if (isCurrent()) {
          const message = err instanceof Error ? err.message : String(err);
          reportDeletionError(deleted ? 'Recording deleted, but refreshing the list failed: ' + message : message);
        }
      } finally {
        if (isCurrent()) {
          finishDeletion();
          setDeletingRecordingId(null);
          deletionRequestRef.current = null;
        }
      }
    },
    [
      page,
      runsPerPage,
      selectedWorkflowId,
      statusFilter,
      appliedInputFilter,
      visibleRuns,
      beginDeletion,
      abortCatalog,
      reconcileDeletedRuns,
      reconcileDeletedSubRuns,
      loadWorkflowRecordingWorkflows,
      clearMissingWorkflowResults,
      initialProjectId,
      restartInputSearch,
      readPageAfterDeletion,
      acceptPageAfterDeletion,
      reportDeletionError,
      finishDeletion,
    ],
  );

  return {
    refresh,
    refreshToken,
    workflows,
    workflowsLoading: !sessionReady || workflowsLoading,
    catalogError: sessionReady ? catalogError : null,
    retryCatalog,
    runsLoading: !sessionReady || runsLoading || (sessionActive && !appliedInputFilter && !runsPage && !error),
    error: sessionReady ? error : null,
    selectedWorkflowId: sessionReady ? selectedWorkflowId : initialProjectId,
    selectedWorkflow: sessionReady
      ? selectedWorkflow
      : workflows.find((workflow) => workflow.workflowId === initialProjectId) ?? null,
    runsPerPage,
    page,
    statusFilter,
    inputFilterVisible: sessionReady && inputFilterVisible,
    inputFilterPath,
    inputFilterOperator,
    inputFilterValue,
    appliedInputFilter,
    inputFilterError,
    deletingRecordingId,
    overallRunsCount: sessionReady ? overallRunsCount : null,
    allWorkflowsRunsCount: sessionReady ? allWorkflowsRunsCount : null,
    badRunsCount: sessionReady ? badRunsCount : null,
    filteredRunsCount: sessionReady ? filteredRunsCount : null,
    totalPages,
    inputSearchStatus,
    inputSearchProgress,
    unsearchableRuns: runsPage?.unsearchableRuns ?? 0,
    visibleRuns: sessionReady ? visibleRuns : [],
    childLoadStates,
    childLoadErrors: sessionReady ? childLoadErrors : {},
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
