import Select from '@atlaskit/select';
import { type FC, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { VariableSizeList, type ListChildComponentProps } from 'react-window';

import {
  WORKFLOW_RECORDING_INPUT_FILTER_OPERATORS,
  type WorkflowRecordingFilterStatus,
  type WorkflowRecordingInputFilter,
  type WorkflowRecordingInputFilterOperator,
  type WorkflowRecordingRunSummary,
  type WorkflowRecordingStatus,
  type WorkflowRecordingWorkflowSummary,
} from './types';
import { SegmentedControl, SegmentedControlButton } from './SegmentedControl';
import { RecordingInputPathField } from './RecordingInputPathField';
import { deleteInputPath, readInputPathHistory, rememberInputPath } from './recording-input-path-history';
import {
  groupRecordingRuns,
  recordingHierarchyRows,
  refreshRecordingRowMeasurements,
  type RecordingListRow,
  type RecordingRunFamily,
} from './recording-run-hierarchy';

const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const RUN_STATUS_LABELS: Record<WorkflowRecordingStatus, string> = {
  succeeded: 'Succeeded',
  failed: 'Failed',
  suspicious: 'Suspicious',
};

const runsPerPageOptions = [10, 20, 50, 100] as const;
const INPUT_FILTER_OPERATOR_LABELS: Partial<Record<WorkflowRecordingInputFilterOperator, string>> = {
  not_exists: 'not exists',
};

const inputFilterOperatorOptions: Array<{ value: WorkflowRecordingInputFilterOperator; label: string }> =
  WORKFLOW_RECORDING_INPUT_FILTER_OPERATORS.map((operator) => ({
    value: operator,
    label: INPUT_FILTER_OPERATOR_LABELS[operator] ?? operator,
  }));

const ESTIMATED_RECORDING_ROW_HEIGHT = 138;
const RECORDING_ROW_GAP = 8;

function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return 'Unavailable';
  }
  if (durationMs < 1000) {
    return `${durationMs.toFixed(2)} ms`;
  }

  // Split rounded centiseconds so minute boundaries never display 60.00s.
  const centiseconds = Math.round(durationMs / 10);
  if (centiseconds < 6000) {
    return `${(centiseconds / 100).toFixed(2)} s`;
  }

  const minutes = Math.floor(centiseconds / 6000);
  const remainderSeconds = ((centiseconds % 6000) / 100).toFixed(2);
  return `${minutes}m ${remainderSeconds}s`;
}

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

function RecordingRow({
  recording,
  family,
  expanded,
  isChild,
  onToggle,
  isDeleting,
  isInteractionLocked,
  isOpening,
  onDelete,
  onOpen,
}: {
  recording: WorkflowRecordingRunSummary;
  family: RecordingRunFamily | null;
  expanded: boolean;
  isChild: boolean;
  onToggle: (key: string) => void;
  isDeleting: boolean;
  isInteractionLocked: boolean;
  isOpening: boolean;
  onDelete: (recordingId: string) => void;
  onOpen: (recordingId: string) => void;
}) {
  const detailText =
    recording.errorMessage ??
    (recording.status === 'suspicious'
      ? 'Completed without throwing, but the final output was control-flow-excluded.'
      : null);
  const endpointNameAtExecution = recording.endpointNameAtExecution?.trim() || 'Unknown';
  const isSubgraphRun = recording.executionIdentity?.surface === 'subgraph_project';

  return (
    <div
      className={`run-recordings-run ${recording.status}${isChild ? ' run-recordings-sub-run' : ''}`}
      data-recording-id={recording.id}
    >
      <button
        type="button"
        className="run-recordings-run-open-button"
        onClick={() => onOpen(recording.id)}
        disabled={isDeleting || isInteractionLocked}
      >
        <div className="run-recordings-run-body">
          <div className="run-recordings-run-header">
            <div className="run-recordings-run-main">
              <div className="run-recordings-run-title">
                {recording.executionIdentity?.surface === 'scheduled' ? (
                  <span>Scheduled · {recording.executionIdentity.scheduleName ?? 'Scheduled run'} · </span>
                ) : null}
                {isChild ? <span className="run-recordings-sub-run-label">Sub-run · </span> : null}
                {formatTimestamp(recording.createdAt)}
              </div>
              {isOpening ? (
                <span className="run-recordings-badge opening" role="status" aria-live="polite">
                  Opening…
                </span>
              ) : isSubgraphRun ? (
                <span className="run-recordings-badge latest">
                  Subgraph ·{' '}
                  {recording.runKind === 'editor'
                    ? 'Local editor'
                    : recording.runKind === 'latest'
                      ? 'Latest'
                      : 'Published'}
                </span>
              ) : recording.runKind === 'latest' ? (
                <span className="run-recordings-badge latest">Latest</span>
              ) : recording.runKind === 'editor' ? (
                <span className="run-recordings-badge latest">Local editor</span>
              ) : null}
            </div>
          </div>
          {detailText ? <div className={`run-recordings-run-detail ${recording.status}`}>{detailText}</div> : null}
        </div>
        <div className="run-recordings-run-footer">
          <div className="run-recordings-run-meta">
            <span className={`run-recordings-badge ${recording.status}`}>{RUN_STATUS_LABELS[recording.status]}</span>
            <span className="run-recordings-run-duration">{formatDuration(recording.durationMs)}</span>
          </div>
        </div>
        <div className="run-recordings-run-endpoint">
          Project:{' '}
          <span className="run-recordings-run-endpoint-value">
            {recording.sourceProjectRelativePath || recording.sourceProjectName || recording.workflowId}
          </span>
        </div>
        <div className="run-recordings-run-endpoint">
          {isSubgraphRun ? 'Called graph' : 'Endpoint at execution'}:{' '}
          <span className="run-recordings-run-endpoint-value">
            {isSubgraphRun ? endpointNameAtExecution.replace(/^Subgraph:\s*/, '') : endpointNameAtExecution}
          </span>
        </div>
        {isSubgraphRun && recording.executionIdentity?.correlationId && (
          <div className="run-recordings-run-endpoint">
            Related run key:{' '}
            <span className="run-recordings-run-endpoint-value">{recording.executionIdentity.correlationId}</span>
          </div>
        )}
      </button>
      {family ? (
        <RecordingFamilyToggle
          family={family}
          expanded={expanded}
          disabled={isDeleting || isInteractionLocked}
          onToggle={onToggle}
        />
      ) : null}
      <div className="run-recordings-run-actions">
        <button
          type="button"
          className="run-recordings-run-delete-button"
          onClick={() => onDelete(recording.id)}
          disabled={isDeleting || isInteractionLocked}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function RecordingFamilyToggle({
  family,
  expanded,
  disabled,
  onToggle,
}: {
  family: RecordingRunFamily;
  expanded: boolean;
  disabled: boolean;
  onToggle: (key: string) => void;
}) {
  const count = family.children.length;
  return (
    <button
      type="button"
      className="run-recordings-family-toggle"
      aria-expanded={expanded}
      disabled={disabled}
      onClick={() => onToggle(family.key)}
      title={
        family.childLoadState
          ? 'Sub-runs are shown regardless of the root input filter.'
          : 'Includes sub-runs in this page.'
      }
    >
      <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      {family.childLoadState === 'loading'
        ? 'Loading sub-runs...'
        : family.childLoadState === 'failed'
          ? 'Retry loading sub-runs'
          : family.childLoadState === 'unloaded'
            ? 'Show sub-runs'
            : `${expanded ? 'Hide' : 'Show'} ${count} ${count === 1 ? 'sub-run' : 'sub-runs'}${family.childLoadState ? '' : ' in current results'}`}
    </button>
  );
}

type VirtualizedRecordingRowData = {
  recordings: RecordingListRow[];
  deletingRecordingId: string | null;
  openingRecordingId: string | null;
  onDelete: (recordingId: string) => void;
  onOpen: (recordingId: string) => void;
  onHeightChange: (recordingId: string, height: number) => void;
  onToggle: (key: string) => void;
};

function MeasuredRecordingRow({
  row,
  isDeleting,
  isInteractionLocked,
  isOpening,
  onDelete,
  onOpen,
  onHeightChange,
  onToggle,
}: {
  row: RecordingListRow;
  isDeleting: boolean;
  isInteractionLocked: boolean;
  isOpening: boolean;
  onDelete: (recordingId: string) => void;
  onOpen: (recordingId: string) => void;
  onHeightChange: (recordingId: string, height: number) => void;
  onToggle: (key: string) => void;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = rowRef.current;
    if (!element) return;
    const measure = () => onHeightChange(row.id, Math.ceil(element.getBoundingClientRect().height) + RECORDING_ROW_GAP);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [
    onHeightChange,
    row.id,
    row.recording,
    row.expanded,
    row.isChild,
    row.family?.children.length,
    row.family?.childLoadState,
  ]);

  return (
    <div ref={rowRef} className={row.isChild ? 'run-recordings-child-row' : undefined}>
      {row.recording ? (
        <RecordingRow
          recording={row.recording}
          family={row.family}
          expanded={row.expanded}
          isChild={row.isChild}
          onToggle={onToggle}
          isDeleting={isDeleting}
          isInteractionLocked={isInteractionLocked}
          isOpening={isOpening}
          onDelete={onDelete}
          onOpen={onOpen}
        />
      ) : row.family ? (
        <div className="run-recordings-family-context">
          <div className="run-recordings-run-title">Related sub-runs</div>
          <div>
            Primary run is not identified in these results. It may be on another page, filtered out, or no longer
            retained.
          </div>
          <RecordingFamilyToggle
            family={row.family}
            expanded={row.expanded}
            disabled={isDeleting || isInteractionLocked}
            onToggle={onToggle}
          />
        </div>
      ) : null}
    </div>
  );
}

function VirtualizedRecordingRow({ index, style, data }: ListChildComponentProps<VirtualizedRecordingRowData>) {
  const recording = data.recordings[index]!;

  return (
    <div style={{ ...style, boxSizing: 'border-box' }}>
      <MeasuredRecordingRow
        row={recording}
        isDeleting={data.deletingRecordingId !== null}
        isInteractionLocked={data.openingRecordingId !== null}
        isOpening={data.openingRecordingId === recording.recording?.id}
        onDelete={data.onDelete}
        onOpen={data.onOpen}
        onHeightChange={data.onHeightChange}
        onToggle={data.onToggle}
      />
    </div>
  );
}

function VirtualizedRecordingList({
  recordings: runs,
  childLoadStates,
  expandedKeys,
  onToggle,
  deletingRecordingId,
  openingRecordingId,
  onDelete,
  onOpen,
}: {
  recordings: WorkflowRecordingRunSummary[];
  childLoadStates?: Readonly<Record<string, RecordingRunFamily['childLoadState']>>;
  expandedKeys: ReadonlySet<string>;
  onToggle: (key: string) => void;
  deletingRecordingId: string | null;
  openingRecordingId: string | null;
  onDelete: (recordingId: string) => void;
  onOpen: (recordingId: string) => void;
}) {
  const families = useMemo(() => groupRecordingRuns(runs, childLoadStates), [runs, childLoadStates]);
  const recordings = useMemo(() => recordingHierarchyRows(families, expandedKeys), [families, expandedKeys]);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<VariableSizeList | null>(null);
  const rowHeightsRef = useRef(new Map<string, number>());
  const rowIndexesRef = useRef(new Map<string, number>());
  const previousRecordingsRef = useRef<RecordingListRow[]>([]);
  const [viewportHeight, setViewportHeight] = useState(0);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let previousWidth = viewport.clientWidth;
    const updateHeight = () => {
      if (viewport.clientWidth !== previousWidth) {
        previousWidth = viewport.clientWidth;
        // Offscreen rows cannot report their new wrapped height until mounted.
        rowHeightsRef.current.clear();
        listRef.current?.resetAfterIndex(0);
      }
      setViewportHeight(Math.max(0, Math.floor(viewport.clientHeight)));
    };
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const nextIds = recordings.map((recording) => recording.id);
    const firstChangedIndex = refreshRecordingRowMeasurements(
      previousRecordingsRef.current,
      recordings,
      rowHeightsRef.current,
    );
    rowIndexesRef.current = new Map(nextIds.map((recordingId, index) => [recordingId, index]));
    previousRecordingsRef.current = recordings;

    // Establish indexes before child passive effects measure newly added rows.
    // Input-filter results append in newest-first order. Existing row heights
    // remain correct, so resetting all virtual measurements on every response
    // would visibly jump a long list for no reason.
    if (firstChangedIndex != null) {
      listRef.current?.resetAfterIndex(firstChangedIndex, true);
    }
  }, [recordings]);

  const onHeightChange = useCallback((recordingId: string, height: number) => {
    if (rowHeightsRef.current.get(recordingId) === height) return;
    rowHeightsRef.current.set(recordingId, height);
    const index = rowIndexesRef.current.get(recordingId);
    if (index != null) {
      listRef.current?.resetAfterIndex(index);
    }
  }, []);

  const itemSize = useCallback(
    (index: number) => rowHeightsRef.current.get(recordings[index]!.id) ?? ESTIMATED_RECORDING_ROW_HEIGHT,
    [recordings],
  );

  const itemData: VirtualizedRecordingRowData = {
    recordings,
    deletingRecordingId,
    openingRecordingId,
    onDelete,
    onOpen,
    onHeightChange,
    onToggle,
  };

  return (
    <div ref={viewportRef} className="run-recordings-list-viewport">
      {viewportHeight > 0 ? (
        <VariableSizeList
          ref={listRef}
          className="run-recordings-list"
          height={viewportHeight}
          width="100%"
          itemCount={recordings.length}
          itemData={itemData}
          itemKey={(index, data) => data.recordings[index]!.id}
          itemSize={itemSize}
        >
          {VirtualizedRecordingRow}
        </VariableSizeList>
      ) : null}
    </div>
  );
}

type RecordingRunsTableProps = {
  childLoadStates?: Readonly<Record<string, RecordingRunFamily['childLoadState']>>;
  expandedFamilyKeys: ReadonlySet<string>;
  onToggleFamily: (key: string) => void;
  selectedWorkflow: WorkflowRecordingWorkflowSummary | null;
  selectedWorkflowEndpoint: string;
  selectedWorkflowStatusLabel: string;
  overallRunsCount: number;
  badRunsCount: number;
  filteredRunsCount: number;
  totalPages: number;
  inputSearchStatus: 'idle' | 'searching' | 'complete' | 'stopped';
  inputSearchProgress: { analyzedRuns: number; availableRuns: number } | null;
  page: number;
  runsPerPage: number;
  statusFilter: WorkflowRecordingFilterStatus;
  inputFilterVisible: boolean;
  inputFilterPath: string;
  inputFilterOperator: WorkflowRecordingInputFilterOperator;
  inputFilterValue: string;
  appliedInputFilter: WorkflowRecordingInputFilter | null;
  inputFilterError: string | null;
  runsLoading: boolean;
  visibleRuns: WorkflowRecordingRunSummary[];
  deletingRecordingId: string | null;
  openingRecordingId: string | null;
  onSetStatusFilter: (status: WorkflowRecordingFilterStatus) => void;
  onSetInputFilterVisible: (visible: boolean) => void;
  onSetInputFilterPath: (path: string) => void;
  onSetInputFilterOperator: (operator: WorkflowRecordingInputFilterOperator) => void;
  onSetInputFilterValue: (value: string) => void;
  onApplyInputFilter: () => boolean;
  onClearInputFilter: () => void;
  onStopInputSearch: () => void;
  onSetRunsPerPage: (pageSize: number) => void;
  onSetPage: (page: number | ((current: number) => number)) => void;
  onDeleteRecording: (recordingId: string) => void;
  onOpenRecording: (recordingId: string) => void;
};

export const RecordingRunsTable: FC<RecordingRunsTableProps> = ({
  childLoadStates,
  expandedFamilyKeys,
  onToggleFamily,
  selectedWorkflow,
  selectedWorkflowEndpoint,
  selectedWorkflowStatusLabel,
  overallRunsCount,
  badRunsCount,
  filteredRunsCount,
  totalPages,
  inputSearchStatus,
  inputSearchProgress,
  page,
  runsPerPage,
  statusFilter,
  inputFilterVisible,
  inputFilterPath,
  inputFilterOperator,
  inputFilterValue,
  appliedInputFilter,
  inputFilterError,
  runsLoading,
  visibleRuns,
  deletingRecordingId,
  openingRecordingId,
  onSetStatusFilter,
  onSetInputFilterVisible,
  onSetInputFilterPath,
  onSetInputFilterOperator,
  onSetInputFilterValue,
  onApplyInputFilter,
  onClearInputFilter,
  onStopInputSearch,
  onSetRunsPerPage,
  onSetPage,
  onDeleteRecording,
  onOpenRecording,
}) => {
  const [inputPathHistory, setInputPathHistory] = useState(() => readInputPathHistory());
  const allRunsLabel = overallRunsCount > 0 ? `All (${overallRunsCount})` : 'All';
  const badRunsLabel = badRunsCount > 0 ? `Bad only (${badRunsCount})` : 'Bad only';
  const valueInputDisabled = inputFilterOperator === 'exists' || inputFilterOperator === 'not_exists';
  const selectedInputFilterOperator =
    inputFilterOperatorOptions.find((option) => option.value === inputFilterOperator) ?? inputFilterOperatorOptions[0]!;
  const inputSearchFoundLabel = filteredRunsCount === 1 ? '1 match found' : `${filteredRunsCount} matches found`;
  const inputSearchMessage =
    inputSearchStatus === 'searching'
      ? visibleRuns.length > 0
        ? `Searching older recordings... ${inputSearchFoundLabel}`
        : 'Searching newest recordings...'
      : inputSearchStatus === 'complete'
        ? `Search complete, ${inputSearchFoundLabel}`
        : inputSearchStatus === 'stopped'
          ? `Search stopped, ${inputSearchFoundLabel}`
          : '';
  const inputSearchProgressPercent = inputSearchProgress
    ? inputSearchProgress.availableRuns === 0
      ? 100
      : Math.round(Math.min(1, Math.max(0, inputSearchProgress.analyzedRuns / inputSearchProgress.availableRuns)) * 100)
    : null;
  const inputSearchProgressLabel = inputSearchProgress
    ? inputSearchProgress.availableRuns === 0
      ? 'No available runs to analyze (100%)'
      : `Analyzed ${inputSearchProgress.analyzedRuns} of ${inputSearchProgress.availableRuns} available runs (${inputSearchProgressPercent}%)`
    : null;

  return (
    <section className={`run-recordings-details${selectedWorkflow ? '' : ' run-recordings-details-any'}`}>
      {selectedWorkflow ? (
        <div className="run-recordings-workflow-summary">
          <div className="run-recordings-workflow-heading-row">
            <span className={`project-status-badge ${selectedWorkflow.project.settings.status}`}>
              {selectedWorkflowStatusLabel}
            </span>
            <div className="run-recordings-workflow-name">{selectedWorkflow.project.name}</div>
          </div>

          <div className="run-recordings-workflow-fields">
            <div className="run-recordings-workflow-field run-recordings-workflow-field-wide">
              <div className="run-recordings-field-label">Endpoint</div>
              <div className="run-recordings-field-value run-recordings-field-code">
                {selectedWorkflowEndpoint ? `/workflows/${selectedWorkflowEndpoint}` : 'No endpoint configured'}
              </div>
            </div>
            <div className="run-recordings-workflow-field">
              <div className="run-recordings-field-label">Project path</div>
              <div className="run-recordings-field-value run-recordings-field-code">
                {selectedWorkflow.project.relativePath}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <div className="run-recordings-runs-panel">
        <div className="run-recordings-runs-header">
          <div className="run-recordings-runs-heading-group">
            <div className="run-recordings-runs-title">
              {overallRunsCount} {overallRunsCount === 1 ? 'Run' : 'Runs'}
            </div>
            <SegmentedControl label="Filter runs">
              <SegmentedControlButton
                selected={statusFilter === 'all'}
                onClick={() => {
                  onSetStatusFilter('all');
                  onSetPage(1);
                }}
              >
                {allRunsLabel}
              </SegmentedControlButton>
              <SegmentedControlButton
                selected={statusFilter === 'failed'}
                onClick={() => {
                  onSetStatusFilter('failed');
                  onSetPage(1);
                }}
              >
                {badRunsLabel}
              </SegmentedControlButton>
            </SegmentedControl>
            <button
              type="button"
              className={`run-recordings-filter-link${inputFilterVisible ? ' active' : ''}`}
              onClick={() => onSetInputFilterVisible(!inputFilterVisible)}
              aria-pressed={inputFilterVisible}
            >
              Filter by input
            </button>
          </div>

          <div className="run-recordings-runs-controls">
            <div className="run-recordings-inline-control">
              <span className="run-recordings-field-label">Per page</span>
              <SegmentedControl label="Runs per page">
                {runsPerPageOptions.map((option) => (
                  <SegmentedControlButton
                    key={option}
                    selected={runsPerPage === option}
                    onClick={() => {
                      onSetRunsPerPage(option);
                      onSetPage(1);
                    }}
                  >
                    {option}
                  </SegmentedControlButton>
                ))}
              </SegmentedControl>
            </div>
          </div>
        </div>

        {inputFilterVisible ? (
          <form
            className="run-recordings-input-filter"
            onSubmit={(event) => {
              event.preventDefault();
              if (onApplyInputFilter()) {
                setInputPathHistory(rememberInputPath(inputFilterPath));
              }
            }}
          >
            <RecordingInputPathField
              value={inputFilterPath}
              paths={inputPathHistory}
              onChange={onSetInputFilterPath}
              onRefresh={() => setInputPathHistory(readInputPathHistory())}
              onDelete={(path) => setInputPathHistory(deleteInputPath(path))}
            />

            <label className="run-recordings-input-filter-field run-recordings-input-filter-operator">
              <span className="run-recordings-field-label">Operator</span>
              <Select
                inputId="run-recordings-input-filter-operator"
                options={inputFilterOperatorOptions}
                value={selectedInputFilterOperator}
                onChange={(option: { value: WorkflowRecordingInputFilterOperator; label: string } | null) => {
                  onSetInputFilterOperator(option?.value ?? '==');
                }}
                isSearchable={false}
                classNamePrefix="run-recordings-select"
                menuPlacement="auto"
                menuPortalTarget={typeof document === 'undefined' ? undefined : document.body}
                menuPosition="fixed"
                aria-label="Operator"
              />
            </label>

            <label className="run-recordings-input-filter-field">
              <span className="run-recordings-field-label">Value</span>
              <input
                type="text"
                value={valueInputDisabled ? '' : inputFilterValue}
                onChange={(event) => onSetInputFilterValue(event.target.value)}
                placeholder="bar"
                aria-label="Value"
                disabled={valueInputDisabled}
              />
            </label>

            <div className="run-recordings-input-filter-actions">
              <button type="submit" className="run-recordings-filter-apply-button" disabled={runsLoading}>
                Apply
              </button>
              <button
                type="button"
                className="run-recordings-page-button"
                onClick={onClearInputFilter}
                disabled={runsLoading && !appliedInputFilter}
              >
                Clear
              </button>
            </div>

            {inputFilterError ? <div className="run-recordings-input-filter-error">{inputFilterError}</div> : null}

            {appliedInputFilter && inputSearchMessage ? (
              <div className="run-recordings-input-search-status" aria-live="polite">
                <span className="run-recordings-input-search-message">
                  {inputSearchStatus === 'searching' ? (
                    <span className="run-recordings-input-search-spinner" aria-hidden="true" />
                  ) : null}
                  {inputSearchMessage}
                </span>
                {inputSearchProgressLabel && inputSearchProgressPercent != null ? (
                  <div className="run-recordings-input-search-progress">
                    <span>{inputSearchProgressLabel}</span>
                    <div
                      className="run-recordings-input-search-progress-track"
                      role="progressbar"
                      aria-label="Input search progress"
                      aria-valuemin={0}
                      aria-valuemax={Math.max(inputSearchProgress?.availableRuns ?? 0, 1)}
                      aria-valuenow={
                        inputSearchProgress?.availableRuns === 0 ? 1 : inputSearchProgress?.analyzedRuns ?? 0
                      }
                      aria-valuetext={inputSearchProgressLabel}
                    >
                      <span
                        className="run-recordings-input-search-progress-fill"
                        style={{ width: `${inputSearchProgressPercent}%` }}
                      />
                    </div>
                  </div>
                ) : null}
                {inputSearchStatus === 'searching' ? (
                  <button type="button" className="run-recordings-page-button" onClick={onStopInputSearch}>
                    Stop search
                  </button>
                ) : null}
              </div>
            ) : null}
          </form>
        ) : null}

        <div className="run-recordings-runs-body">
          {runsLoading && visibleRuns.length === 0 ? (
            <div className="run-recordings-empty-group">
              {appliedInputFilter ? 'Searching for matching runs...' : 'Loading runs...'}
            </div>
          ) : filteredRunsCount === 0 ? (
            <div className="run-recordings-empty-group">
              {appliedInputFilter
                ? inputSearchStatus === 'searching'
                  ? 'Searching for matching runs...'
                  : inputSearchStatus === 'stopped'
                    ? 'Search stopped. Results may be incomplete.'
                    : 'No runs match this input filter.'
                : statusFilter === 'failed'
                  ? 'No bad runs for this workflow.'
                  : 'No recorded runs yet.'}
            </div>
          ) : (
            <VirtualizedRecordingList
              key={JSON.stringify([
                selectedWorkflow?.workflowId ?? '',
                page,
                runsPerPage,
                statusFilter,
                appliedInputFilter,
              ])}
              recordings={visibleRuns}
              childLoadStates={childLoadStates}
              expandedKeys={expandedFamilyKeys}
              onToggle={onToggleFamily}
              deletingRecordingId={deletingRecordingId}
              openingRecordingId={openingRecordingId}
              onDelete={onDeleteRecording}
              onOpen={onOpenRecording}
            />
          )}
        </div>

        {!appliedInputFilter && filteredRunsCount > 0 && totalPages > 1 ? (
          <div className="run-recordings-pagination-footer">
            <button
              type="button"
              className="run-recordings-page-button"
              onClick={() => onSetPage((current) => Math.max(1, current - 1))}
              disabled={page <= 1 || runsLoading}
            >
              Previous
            </button>
            <div className="run-recordings-page-status">
              Page {page} of {totalPages}
            </div>
            <button
              type="button"
              className="run-recordings-page-button"
              onClick={() => onSetPage((current) => Math.min(totalPages, current + 1))}
              disabled={page >= totalPages || runsLoading}
            >
              Next
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
};
