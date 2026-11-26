import {
  formatRecordingDuration,
  formatRecordingTimestamp,
  RECORDING_STATUS_LABELS,
  SUSPICIOUS_RECORDING_DETAIL,
} from '../../app/src/utils/recordingPresentation';
import Select from '@atlaskit/select';
import { type FC, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { VariableSizeList, type ListChildComponentProps } from 'react-window';

import {
  WORKFLOW_RECORDING_INPUT_FILTER_OPERATORS,
  type WorkflowRecordingFilterStatus,
  type WorkflowRecordingInputFilter,
  type WorkflowRecordingInputFilterOperator,
  type WorkflowRecordingRunSummary,
  type WorkflowRecordingWorkflowSummary,
} from './types';
import { SegmentedControl, SegmentedControlButton } from './SegmentedControl';
import { RecordingInputPathField } from './RecordingInputPathField';
import { deleteInputPath, readInputPathHistory, rememberInputPath } from './recording-input-path-history';
import {
  groupRecordingRuns,
  recordingHierarchyRows,
  refreshRecordingRowMeasurements,
  recordingRowGap,
  RECORDING_ROW_GAP,
  type RecordingListRow,
  type RecordingRunFamily,
  type RecordingSubRunOrder,
} from './recording-run-hierarchy';
import { recordingProjectName, recordingProjectPath } from './recording-project-presentation';
import { copyTextToClipboard } from './copyTextToClipboard';
import { RecordingRunActions } from './RecordingRunActions';

const INPUT_FILTER_OPERATOR_LABELS: Partial<Record<WorkflowRecordingInputFilterOperator, string>> = {
  not_exists: 'not exists',
};

const inputFilterOperatorOptions: Array<{ value: WorkflowRecordingInputFilterOperator; label: string }> =
  WORKFLOW_RECORDING_INPUT_FILTER_OPERATORS.map((operator) => ({
    value: operator,
    label: INPUT_FILTER_OPERATOR_LABELS[operator] ?? operator,
  }));

const ESTIMATED_RECORDING_ROW_HEIGHT = 138;

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
  const detailText = recording.errorMessage ?? (recording.status === 'suspicious' ? SUSPICIOUS_RECORDING_DETAIL : null);
  const endpointNameAtExecution = recording.endpointNameAtExecution?.trim() || 'Unknown';
  const isSubgraphRun = recording.executionIdentity?.surface === 'subgraph_project';
  const playable = !recording.evidence || recording.evidence.availability === 'available';
  const availability = recording.evidence?.availability;
  const evidenceReason = recording.evidence?.reason;
  const correlationId = isSubgraphRun ? recording.executionIdentity?.correlationId : undefined;
  const [copyOutcome, setCopyOutcome] = useState<'copied' | 'failed' | null>(null);
  const [diagnosticsVisible, setDiagnosticsVisible] = useState(false);

  const copyCorrelationId = async () => {
    if (!correlationId) return;
    setCopyOutcome(null);
    try {
      await copyTextToClipboard(correlationId);
      setCopyOutcome('copied');
    } catch {
      setCopyOutcome('failed');
    }
  };

  return (
    <div
      className={`run-recordings-run ${recording.status}${isChild ? ' run-recordings-sub-run' : ''}${!playable ? ' evidence-only' : ''}`}
      data-recording-id={recording.id}
    >
      <button
        type="button"
        className="run-recordings-run-open-button"
        onClick={() => onOpen(recording.id)}
        disabled={isDeleting || isInteractionLocked || !playable}
      >
        <div className="run-recordings-run-body">
          <div className="run-recordings-run-header">
            <div className="run-recordings-run-main">
              <div className="run-recordings-run-title">
                {recording.executionIdentity?.surface === 'scheduled' ? (
                  <span>Scheduled · {recording.executionIdentity.scheduleName ?? 'Scheduled run'} · </span>
                ) : null}
                {formatRecordingTimestamp(recording.createdAt)}
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
            <span className="run-recordings-run-duration">{formatRecordingDuration(recording.durationMs)}</span>
          </div>
          {detailText ? <div className={`run-recordings-run-detail ${recording.status}`}>{detailText}</div> : null}
        </div>
        {recording.status !== 'succeeded' && (
          <div className="run-recordings-run-meta">
            <span className={`run-recordings-badge ${recording.status}`}>
              {recording.status === 'accepted'
                ? 'Accepted'
                : recording.status === 'unknown'
                  ? 'Outcome unknown'
                  : recording.status === 'running'
                    ? 'Running'
                    : RECORDING_STATUS_LABELS[recording.status]}
            </span>
          </div>
        )}
        {availability && availability !== 'available' && (
          <div className="run-recordings-run-detail" role="status">
            {availability === 'pending'
              ? 'Recording pending'
              : availability === 'deleted'
                ? 'Recording deleted'
                : 'Recording unavailable'}
            {evidenceReason &&
              ` · ${
                (
                  {
                    capacity: 'Capture capacity was exhausted',
                    capture_incomplete: 'Capture did not complete',
                    serialization_failed: 'Replay serialization failed',
                    upload_incomplete: 'Replay upload did not complete',
                    persistence_failed: 'Replay storage failed',
                  } as const
                )[evidenceReason]
              }`}
          </div>
        )}
        {recording.evidence?.childCoverage === 'incomplete' && (
          <div className="run-recordings-run-detail">Some called-project recordings could not be confirmed.</div>
        )}
        <div className="run-recordings-run-endpoint">
          Project name: <span className="run-recordings-run-endpoint-value">{recordingProjectName(recording)}</span>
        </div>
        <div
          className={`run-recordings-run-endpoint${!family && !diagnosticsVisible ? ' run-recordings-corner-clearance' : ''}`}
        >
          {isSubgraphRun ? 'Called graph' : 'Endpoint at execution'}:{' '}
          <span className="run-recordings-run-endpoint-value">
            {isSubgraphRun ? endpointNameAtExecution.replace(/^Subgraph:\s*/, '') : endpointNameAtExecution}
          </span>
        </div>
      </button>
      {family ? (
        <RecordingFamilyToggle
          family={family}
          expanded={expanded}
          disabled={isDeleting || isInteractionLocked}
          onToggle={onToggle}
        />
      ) : null}
      {diagnosticsVisible ? (
        <div
          className="run-recordings-run-diagnostics run-recordings-corner-clearance"
          role="region"
          aria-label="Diagnostic details"
        >
          <div className="run-recordings-run-diagnostic-fields">
            <div className="run-recordings-run-endpoint">
              Path:{' '}
              <span className="run-recordings-run-endpoint-value">
                {recordingProjectPath(recording.sourceProjectRelativePath) || 'Unknown'}
              </span>
            </div>
            {correlationId ? (
              <>
                <div className="run-recordings-run-endpoint">
                  Execution correlation ID: <span className="run-recordings-run-endpoint-value">{correlationId}</span>
                  <button
                    type="button"
                    className="run-recordings-page-button run-recordings-diagnostic-copy"
                    aria-label="Copy execution correlation ID"
                    onClick={() => void copyCorrelationId()}
                  >
                    Copy
                  </button>
                </div>
                <span role="status">
                  {copyOutcome === 'copied'
                    ? 'Copied'
                    : copyOutcome === 'failed'
                      ? 'Could not copy. Select and copy the ID manually.'
                      : ''}
                </span>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
      <div className="run-recordings-run-actions">
        <RecordingRunActions
          disabled={isDeleting || isInteractionLocked}
          diagnosticsVisible={diagnosticsVisible}
          onToggleDiagnostics={() => setDiagnosticsVisible((visible) => !visible)}
          onDelete={() => onDelete(recording.id)}
        />
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
          ? 'Sub-runs do not count toward runs per page and are shown regardless of the root filters.'
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

function RecordingSubRunSort({
  family,
  disabled,
  subRunOrder,
  onSortSubRuns,
}: {
  family: RecordingRunFamily;
  disabled: boolean;
  subRunOrder: RecordingSubRunOrder;
  onSortSubRuns: (key: string, order: RecordingSubRunOrder) => void;
}) {
  return (
    <div className="run-recordings-sub-run-sort">
      <span className="run-recordings-sub-run-sort-label">Sub-run sorting</span>
      <SegmentedControl label="Sub-run sorting">
        <SegmentedControlButton
          selected={subRunOrder === 'chronological'}
          disabled={disabled}
          onClick={() => onSortSubRuns(family.key, 'chronological')}
        >
          Chronological
        </SegmentedControlButton>
        <SegmentedControlButton
          selected={subRunOrder === 'project'}
          disabled={disabled}
          onClick={() => onSortSubRuns(family.key, 'project')}
        >
          Project name (A–Z)
        </SegmentedControlButton>
      </SegmentedControl>
    </div>
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
  subRunOrders: Readonly<Record<string, RecordingSubRunOrder>>;
  onSortSubRuns: (key: string, order: RecordingSubRunOrder) => void;
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
  subRunOrder,
  onSortSubRuns,
}: {
  row: RecordingListRow;
  isDeleting: boolean;
  isInteractionLocked: boolean;
  isOpening: boolean;
  onDelete: (recordingId: string) => void;
  onOpen: (recordingId: string) => void;
  onHeightChange: (recordingId: string, height: number) => void;
  onToggle: (key: string) => void;
  subRunOrder: RecordingSubRunOrder;
  onSortSubRuns: (key: string, order: RecordingSubRunOrder) => void;
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
    subRunOrder,
  ]);

  return (
    <div ref={rowRef} className={row.isChild || row.kind === 'sub-run-sort' ? 'run-recordings-child-row' : undefined}>
      {row.kind === 'sub-run-sort' && row.family ? (
        <RecordingSubRunSort
          family={row.family}
          disabled={isDeleting || isInteractionLocked}
          subRunOrder={subRunOrder}
          onSortSubRuns={onSortSubRuns}
        />
      ) : row.recording ? (
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
            Primary run is not identified in these results. It may be outside this project, filtered out, or no longer
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
    <div className="run-recordings-list-row" style={{ ...style, boxSizing: 'border-box' }}>
      {recording.isChild ? (
        <span
          className="run-recordings-sub-run-connector"
          aria-hidden="true"
          style={{ bottom: data.recordings[index + 1]?.isChild ? 0 : recordingRowGap(data.recordings, index) }}
        />
      ) : null}
      <MeasuredRecordingRow
        row={recording}
        isDeleting={data.deletingRecordingId !== null}
        isInteractionLocked={data.openingRecordingId !== null}
        isOpening={data.openingRecordingId === recording.recording?.id}
        onDelete={data.onDelete}
        onOpen={data.onOpen}
        onHeightChange={data.onHeightChange}
        onToggle={data.onToggle}
        subRunOrder={
          recording.kind === 'sub-run-sort' && recording.family
            ? data.subRunOrders[recording.family.key] ?? 'chronological'
            : 'chronological'
        }
        onSortSubRuns={data.onSortSubRuns}
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
  const [subRunOrders, setSubRunOrders] = useState<Record<string, RecordingSubRunOrder>>({});
  const onSortSubRuns = useCallback((key: string, order: RecordingSubRunOrder) => {
    setSubRunOrders((current) =>
      (current[key] ?? 'chronological') === order ? current : { ...current, [key]: order },
    );
  }, []);
  const families = useMemo(
    () => groupRecordingRuns(runs, childLoadStates, subRunOrders),
    [runs, childLoadStates, subRunOrders],
  );
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
    (index: number) =>
      (rowHeightsRef.current.get(recordings[index]!.id) ?? ESTIMATED_RECORDING_ROW_HEIGHT) +
      recordingRowGap(recordings, index) -
      RECORDING_ROW_GAP,
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
    subRunOrders,
    onSortSubRuns,
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
  overallRunsCount: number | null;
  badRunsCount: number | null;
  filteredRunsCount: number | null;
  unsearchableRuns: number;
  inputSearchStatus: 'idle' | 'searching' | 'complete' | 'stopped';
  inputSearchProgress: { analyzedRuns: number; availableRuns: number | null } | null;
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
  unsearchableRuns,
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
  onSetPage,
  onDeleteRecording,
  onOpenRecording,
}) => {
  const [inputPathHistory, setInputPathHistory] = useState(() => readInputPathHistory());
  const inputFilterToggleRef = useRef<HTMLButtonElement>(null);
  const allRunsLabel = overallRunsCount !== null && overallRunsCount > 0 ? `All (${overallRunsCount})` : 'All';
  const badRunsLabel = badRunsCount !== null && badRunsCount > 0 ? `Bad only (${badRunsCount})` : 'Bad only';
  const canApplyInputFilter = !deletingRecordingId && !openingRecordingId && !(runsLoading && appliedInputFilter);
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
  const inputSearchProgressPercent =
    inputSearchProgress && inputSearchProgress.availableRuns !== null
      ? inputSearchProgress.availableRuns === 0
        ? 100
        : Math.round(
            Math.min(1, Math.max(0, inputSearchProgress.analyzedRuns / inputSearchProgress.availableRuns)) * 100,
          )
      : null;
  const inputSearchProgressLabel = inputSearchProgress
    ? inputSearchProgress.availableRuns === null
      ? `Analyzed ${inputSearchProgress.analyzedRuns} runs; total not yet available`
      : inputSearchProgress.availableRuns === 0
        ? 'No available runs to analyze (100%)'
        : `Analyzed ${inputSearchProgress.analyzedRuns} of ${inputSearchProgress.availableRuns} available runs (${inputSearchProgressPercent}%)`
    : null;

  return (
    <section className="run-recordings-details">
      <aside className="run-recordings-sidebar" aria-label="Recording filters">
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
                  {recordingProjectPath(selectedWorkflow.project.relativePath)}
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {unsearchableRuns > 0 ? (
          <div className="run-recordings-warning" role="status">
            {unsearchableRuns} run attempts could not be searched because their recording payload is unavailable.
          </div>
        ) : null}
        <div className="run-recordings-runs-header">
          <div className="run-recordings-runs-title">
            {overallRunsCount === null ? 'Runs' : `${overallRunsCount} ${overallRunsCount === 1 ? 'Run' : 'Runs'}`}
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
        </div>

        {inputFilterVisible ? (
          <form
            className="run-recordings-input-filter"
            aria-label="Filter by input"
            onSubmit={(event) => {
              event.preventDefault();
              if (!canApplyInputFilter) return;
              if (onApplyInputFilter()) {
                setInputPathHistory(rememberInputPath(inputFilterPath));
              }
            }}
          >
            <div className="run-recordings-input-filter-header">
              <h3>Filter by input</h3>
              <button
                type="button"
                className="run-recordings-input-filter-close"
                aria-label="Close input filter"
                autoFocus
                onClick={() => {
                  onSetInputFilterVisible(false);
                  requestAnimationFrame(() => inputFilterToggleRef.current?.focus());
                }}
              >
                &times;
              </button>
            </div>
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
              <button type="submit" className="run-recordings-filter-apply-button" disabled={!canApplyInputFilter}>
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
                {inputSearchProgressLabel ? (
                  <div className="run-recordings-input-search-progress">
                    <span>{inputSearchProgressLabel}</span>
                    {inputSearchProgressPercent !== null ? (
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
                    ) : null}
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
        ) : (
          <button
            ref={inputFilterToggleRef}
            type="button"
            className="run-recordings-page-button run-recordings-filter-toggle"
            onClick={() => onSetInputFilterVisible(true)}
            aria-expanded={false}
          >
            Filter by input
          </button>
        )}
      </aside>

      <div className="run-recordings-runs-panel">
        <div className="run-recordings-runs-body">
          {runsLoading && visibleRuns.length === 0 ? (
            <div className="run-recordings-empty-group">
              {appliedInputFilter ? 'Searching for matching runs...' : 'Loading runs...'}
            </div>
          ) : filteredRunsCount === null ? (
            <div className="run-recordings-empty-group">Run history is unavailable.</div>
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
      </div>
    </section>
  );
};
