import ModalDialog, { ModalBody, ModalTransition } from '@atlaskit/modal-dialog';
import { useCallback, useEffect, useMemo, useRef, useState, type FC } from 'react';

import { getWorkflowProjectStatusLabel } from './projectSettingsForm';
import { RecordingRunsTable } from './RecordingRunsTable';
import { RecordingWorkflowSelect, type RecordingWorkflowOption } from './RecordingWorkflowSelect';
import type { RecordingOpenResult, WorkflowRecordingWorkflowSummary } from './types';
import './RunRecordingsModal.css';
import { useRunRecordingsController } from './useRunRecordingsController';

interface RunRecordingsModalProps {
  isOpen: boolean;
  resetToken: number;
  onDismiss: () => void;
  onClose: () => void;
  onOpenRecording: (recordingId: string) => Promise<RecordingOpenResult>;
  onFoundCountChange: (count: number) => void;
}

const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function formatTimestamp(value: string | undefined): string {
  if (!value) {
    return 'Never';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return timestampFormatter.format(date);
}

function getWorkflowEndpoint(workflow: WorkflowRecordingWorkflowSummary): string {
  return workflow.project.settings.endpointName || '';
}

export const RunRecordingsModal: FC<RunRecordingsModalProps> = ({
  isOpen,
  resetToken,
  onDismiss,
  onClose,
  onOpenRecording,
  onFoundCountChange,
}) => {
  const [openingRecordingId, setOpeningRecordingId] = useState<string | null>(null);
  const [openingError, setOpeningError] = useState<string | null>(null);
  const openingAttemptRef = useRef(0);
  const {
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
    inputSearchProgress,
    visibleRuns,
    setSelectedWorkflowId,
    setRunsPerPage,
    setPage,
    setStatusFilter,
    setInputFilterVisible,
    setInputFilterPath,
    setInputFilterOperator,
    setInputFilterValue,
    handleApplyInputFilter,
    handleClearInputFilter,
    handleStopInputSearch,
    handleDeleteRecording,
  } = useRunRecordingsController(isOpen, resetToken);

  useEffect(() => {
    onFoundCountChange(filteredRunsCount);
  }, [filteredRunsCount, onFoundCountChange]);

  useEffect(() => {
    openingAttemptRef.current += 1;
    setOpeningRecordingId(null);
    setOpeningError(null);

    return () => {
      openingAttemptRef.current += 1;
    };
  }, [isOpen, resetToken]);

  const workflowOptions = useMemo<RecordingWorkflowOption[]>(
    () =>
      workflows.map((workflow) => {
        const endpoint = getWorkflowEndpoint(workflow);
        const statusLabel = getWorkflowProjectStatusLabel(workflow.project.settings.status);

        return {
          label: workflow.project.name,
          value: workflow.workflowId,
          description: workflow.latestRunAt
            ? `Last run ${formatTimestamp(workflow.latestRunAt)}`
            : 'No recorded runs yet',
          endpoint,
          recordingCount: workflow.totalRuns,
          statusLabel,
        };
      }),
    [workflows],
  );

  const selectedWorkflowEndpoint = selectedWorkflow ? getWorkflowEndpoint(selectedWorkflow) : '';
  const selectedWorkflowStatusLabel = selectedWorkflow
    ? getWorkflowProjectStatusLabel(selectedWorkflow.project.settings.status)
    : '';
  const handleExplicitClose = useCallback(() => {
    handleStopInputSearch();
    onClose();
  }, [handleStopInputSearch, onClose]);
  const handleOpenRecording = useCallback(
    async (recordingId: string) => {
      if (openingRecordingId) {
        return;
      }

      const attempt = openingAttemptRef.current + 1;
      openingAttemptRef.current = attempt;
      setOpeningRecordingId(recordingId);
      setOpeningError(null);
      const result = await onOpenRecording(recordingId);
      if (openingAttemptRef.current !== attempt) {
        return;
      }

      if (result.opened) {
        onDismiss();
        return;
      }

      setOpeningRecordingId(null);
      setOpeningError(result.error);
    },
    [onDismiss, onOpenRecording, openingRecordingId],
  );

  if (!isOpen) {
    return null;
  }

  return (
    <ModalTransition>
      <ModalDialog
        testId="run-recordings-modal"
        width="large"
        height="calc(100vh - 40px)"
        label="Run recordings"
        onClose={onDismiss}
      >
        <ModalBody>
          <div className="project-settings-modal-shell run-recordings-shell" aria-busy={openingRecordingId !== null}>
            <div className="project-settings-modal-header-row run-recordings-header-row">
              <div className="project-settings-modal-heading run-recordings-heading">
                <div className="project-settings-modal-title run-recordings-title">Run recordings</div>
                <div className="run-recordings-help">
                  Choose a workflow, inspect its published run history, and open any recording in the editor.
                </div>
              </div>
              <button
                type="button"
                className="project-settings-close-button"
                onClick={handleExplicitClose}
                aria-label="Close run recordings"
              >
                &times;
              </button>
            </div>

            <div className="project-settings-modal-content run-recordings-content">
              {error || openingError ? (
                <div className="project-settings-error run-recordings-error" role="alert">
                  {openingError ?? error}
                </div>
              ) : null}

              {workflowsLoading ? <div className="run-recordings-empty-state">Loading recordings...</div> : null}

              {!workflowsLoading && workflows.length === 0 ? (
                <div className="run-recordings-empty-state">No published or previously published workflows yet.</div>
              ) : null}

              {!workflowsLoading && workflows.length > 0 ? (
                <div className="run-recordings-layout">
                  <RecordingWorkflowSelect
                    workflowOptions={workflowOptions}
                    selectedWorkflowId={selectedWorkflowId}
                    onSelectWorkflow={(workflowId) => {
                      setSelectedWorkflowId(workflowId);
                      setPage(1);
                    }}
                  />

                  {selectedWorkflow ? (
                    <RecordingRunsTable
                      selectedWorkflow={selectedWorkflow}
                      selectedWorkflowEndpoint={selectedWorkflowEndpoint}
                      selectedWorkflowStatusLabel={selectedWorkflowStatusLabel}
                      overallRunsCount={overallRunsCount}
                      badRunsCount={badRunsCount}
                      filteredRunsCount={filteredRunsCount}
                      totalPages={totalPages}
                      inputSearchStatus={inputSearchStatus}
                      inputSearchProgress={inputSearchProgress}
                      page={page}
                      runsPerPage={runsPerPage}
                      statusFilter={statusFilter}
                      inputFilterVisible={inputFilterVisible}
                      inputFilterPath={inputFilterPath}
                      inputFilterOperator={inputFilterOperator}
                      inputFilterValue={inputFilterValue}
                      appliedInputFilter={appliedInputFilter}
                      inputFilterError={inputFilterError}
                      runsLoading={runsLoading}
                      visibleRuns={visibleRuns}
                      deletingRecordingId={deletingRecordingId}
                      openingRecordingId={openingRecordingId}
                      onSetStatusFilter={setStatusFilter}
                      onSetInputFilterVisible={setInputFilterVisible}
                      onSetInputFilterPath={setInputFilterPath}
                      onSetInputFilterOperator={setInputFilterOperator}
                      onSetInputFilterValue={setInputFilterValue}
                      onApplyInputFilter={handleApplyInputFilter}
                      onClearInputFilter={handleClearInputFilter}
                      onStopInputSearch={handleStopInputSearch}
                      onSetRunsPerPage={setRunsPerPage}
                      onSetPage={setPage}
                      onDeleteRecording={handleDeleteRecording}
                      onOpenRecording={handleOpenRecording}
                    />
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </ModalBody>
      </ModalDialog>
    </ModalTransition>
  );
};
