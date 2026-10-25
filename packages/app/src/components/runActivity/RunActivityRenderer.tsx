import { type GraphId } from '@valerypopoff/rivet2-core';
import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai';
import { type FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import {
  createRootGraphViewContext,
  createSubgraphGraphViewContext,
  type GraphViewContext,
} from '../../domain/graphEditing/navigationActions.js';
import { useGoToNode } from '../../hooks/useGoToNode.js';
import { useProjectNodeRegistry } from '../../hooks/useProjectNodeRegistry.js';
import { useStableCallback } from '../../hooks/useStableCallback.js';
import {
  lastRunDataByNodeState,
  runActivityJournalState,
  selectedGraphRunByViewState,
  selectedProcessPageNodesState,
} from '../../state/dataFlow.js';
import { graphState } from '../../state/graph.js';
import { editingNodeState, selectedNodesState } from '../../state/graphBuilder.js';
import { projectState } from '../../state/savedGraphs.js';
import {
  overlayOpenState,
  runActivityColumnWidthsState,
  runActivityDrawerHeightState,
  runActivityDrawerOpenState,
} from '../../state/ui.js';
import { copyToClipboard } from '../../utils/copyToClipboard.js';
import { AgentResponseInspector } from '../agentTrace/AgentResponseInspector.js';
import { RunActivityDrawer } from './RunActivityDrawer.js';
import {
  areRunActivityColumnWidthsEqual,
  normalizeRunActivityColumnWidths,
} from '../../features/runActivity/runActivityColumnWidths.js';
import { getRunActivityRootDurationMs } from '../../features/runActivity/runActivityJournal.js';
import {
  createRunActivityViewModelProjector,
  selectRunActivityRoot,
  type ResolveRunActivityInvocation,
} from './buildRunActivityViewModel.js';
import type {
  RunActivityDrawerProps,
  RunActivityDrawerViewState,
  RunActivityInvocationIdentity,
  RunActivityItemViewModel,
  RunActivityToolResultTarget,
} from './types.js';
import {
  findExactProcessData,
  findExactProcessPage,
  processHasStoredOutputPort,
  resolveRunActivityInspectorTrace,
  shouldCloseRunActivityInspector,
} from './runActivityInspectorLifecycle.js';
import { createRunActivityInvocationResolver, getCurrentGraphDefinition } from './runActivityInvocationResolver.js';
import { createRunActivityOutputNavigation } from './runActivityOutputNavigation.js';

const LIVE_DURATION_REFRESH_MS = 250;
const NARROW_VIEWPORT_QUERY = '(max-width: 720px)';

/** Joins the metadata journal to the editor's existing graph and output stores. */
export const RunActivityRenderer: FC = () => {
  // Collection belongs to the execution snapshot, not this view. Unmount the
  // expensive resolver/subscriptions while hidden, but retain the journal.
  const open = useAtomValue(runActivityDrawerOpenState);
  const store = useStore();
  const outputNavigation = useMemo(() => createRunActivityOutputNavigation(store), [store]);
  useEffect(() => () => outputNavigation.dispose(), [outputNavigation]);
  const viewState = useRef<RunActivityDrawerViewState>();
  const retainViewState = useCallback((state: RunActivityDrawerViewState) => {
    viewState.current = state;
  }, []);
  return open ? (
    <OpenRunActivityRenderer
      initialViewState={viewState.current}
      onViewStateChange={retainViewState}
      outputNavigation={outputNavigation}
    />
  ) : null;
};

const OpenRunActivityRenderer: FC<
  Pick<RunActivityDrawerProps, 'initialViewState' | 'onViewStateChange'> & {
    outputNavigation: ReturnType<typeof createRunActivityOutputNavigation>;
  }
> = ({ initialViewState, onViewStateChange, outputNavigation }) => {
  const [open, setOpen] = useAtom(runActivityDrawerOpenState);
  const [height, setHeight] = useAtom(runActivityDrawerHeightState);
  const [storedColumnWidths, setStoredColumnWidths] = useAtom(runActivityColumnWidthsState);
  const journal = useAtomValue(runActivityJournalState);
  const runDataByNode = useAtomValue(lastRunDataByNodeState);
  const project = useAtomValue(projectState);
  const currentGraph = useAtomValue(graphState);
  const registry = useProjectNodeRegistry();
  const [now, setNow] = useState(() => Date.now());
  const [inspectedIdentity, setInspectedIdentity] = useState<RunActivityInvocationIdentity>();
  const goToNode = useGoToNode();
  const setOpenOverlay = useSetAtom(overlayOpenState);
  const setSelectedGraphRunByView = useSetAtom(selectedGraphRunByViewState);
  const setSelectedProcessPages = useSetAtom(selectedProcessPageNodesState);
  const setSelectedNodes = useSetAtom(selectedNodesState);
  const setEditingNode = useSetAtom(editingNodeState);
  const selectedRoot = selectRunActivityRoot(journal);
  const inspectedRootRunId = inspectedIdentity?.rootRunId;
  const columnWidths = useMemo(() => normalizeRunActivityColumnWidths(storedColumnWidths), [storedColumnWidths]);

  useEffect(() => {
    if (
      shouldCloseRunActivityInspector({
        drawerOpen: open,
        inspectedRootRunId,
        selectedRootRunId: selectedRoot?.rootRunId,
      })
    ) {
      setInspectedIdentity(undefined);
    }
  }, [inspectedRootRunId, open, selectedRoot?.rootRunId]);

  // atomWithStorage intentionally tolerates old browser values. Repair an
  // invalid record once at the owning UI boundary rather than letting a stale
  // preference leak into every drawer render.
  useEffect(() => {
    if (!areRunActivityColumnWidthsEqual(storedColumnWidths, columnWidths)) setStoredColumnWidths(columnWidths);
  }, [columnWidths, setStoredColumnWidths, storedColumnWidths]);

  useEffect(() => {
    if (
      !open ||
      (selectedRoot?.status !== 'running' && selectedRoot?.status !== 'outputs-ready') ||
      selectedRoot.recordedTiming != null
    ) {
      return;
    }
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), LIVE_DURATION_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [open, selectedRoot?.recordedTiming, selectedRoot?.rootRunId, selectedRoot?.status]);

  const presentation = useMemo(
    () => ({
      resolve: createRunActivityInvocationResolver(project, currentGraph, registry),
      project: createRunActivityViewModelProjector(),
    }),
    [currentGraph, project, registry],
  );
  const resolveInvocation = useMemo<ResolveRunActivityInvocation>(
    () => (context) => presentation.resolve(context, runDataByNode),
    [presentation, runDataByNode],
  );

  const stableViewModel = useMemo(
    () =>
      presentation.project(journal, resolveInvocation, {
        now: selectedRoot?.finishedAt ?? selectedRoot?.startedAt ?? 0,
      }),
    [journal, presentation, resolveInvocation, selectedRoot?.finishedAt, selectedRoot?.startedAt],
  );
  const viewModel = useMemo(() => {
    if (selectedRoot?.startedAt == null || selectedRoot.finishedAt != null || selectedRoot.recordedTiming != null) {
      return stableViewModel;
    }
    return {
      ...stableViewModel,
      durationMs: getRunActivityRootDurationMs(selectedRoot, now),
    };
  }, [now, selectedRoot, stableViewModel]);

  const selectExactExecutionTarget = useStableCallback((identity: RunActivityInvocationIdentity) => {
    const graphRun = journal.rootsById[identity.rootRunId]?.graphRunsById[identity.graphRunId];
    if (graphRun?.projectId != null && graphRun.projectId !== project.metadata.id) return false;
    const graph = getCurrentGraphDefinition(project.graphs[identity.graphId], currentGraph, identity.graphId);
    if (!graphRun || !graph?.nodes.some((node) => node.id === identity.nodeId)) return false;

    const parentGraphRun =
      graphRun.parentGraphRunId == null
        ? undefined
        : journal.rootsById[identity.rootRunId]?.graphRunsById[graphRun.parentGraphRunId];
    const foreignCaller = graphRun.projectId != null && parentGraphRun?.projectId !== project.metadata.id;
    const graphView = createRunActivityGraphView(identity.graphId, foreignCaller ? undefined : graphRun.executor);
    const page = findExactProcessPage(runDataByNode, identity);
    setOpenOverlay(undefined);
    setSelectedGraphRunByView((current) => ({
      ...current,
      [graphView.key]: identity.graphRunId,
    }));
    if (page != null) {
      setSelectedProcessPages((current) => ({ ...current, [identity.nodeId]: page }));
    }
    setEditingNode(null);

    const narrow = window.matchMedia(NARROW_VIEWPORT_QUERY).matches;
    if (narrow) setOpen(false);
    goToNode(identity.nodeId, {
      graphId: identity.graphId,
      graphView,
      zoom: 0.85,
      viewportCenter: narrow
        ? undefined
        : {
            x: window.innerWidth / 2,
            y: Math.max(120, (window.innerHeight - height) / 2),
          },
    });
    // Loading another graph clears its selection, so select the exact node only
    // after navigation has installed the target graph workspace.
    setSelectedNodes([identity.nodeId]);
    return true;
  });

  const selectExactInvocation = useStableCallback((item: RunActivityItemViewModel) =>
    selectExactExecutionTarget(item.identity),
  );

  const handleOpenFullOutput = useStableCallback((item: RunActivityItemViewModel) => {
    if (!selectExactInvocation(item)) return;
    outputNavigation.schedule(item.identity);
  });

  const handleOpenToolResult = useStableCallback((target: RunActivityToolResultTarget) => {
    const processData = findExactProcessData(runDataByNode, target);
    if (processData == null || !processHasStoredOutputPort(processData, target.outputPortId)) {
      toast.info('The recorded tool result is no longer available.');
      return;
    }
    if (!selectExactExecutionTarget(target)) {
      toast.info('The Delegate Tool Call result is no longer available in this project.');
      return;
    }
    outputNavigation.schedule(target);
  });

  const handleInspectResponse = useStableCallback((item: RunActivityItemViewModel) => {
    if (!resolveRunActivityInspectorTrace(project, currentGraph, runDataByNode, item.identity)) return;
    setInspectedIdentity(item.identity);
  });

  const handleCopyDiagnostics = useStableCallback(() => {
    const diagnostic = {
      status: viewModel.status,
      startedAt: viewModel.startedAt,
      outputsReadyAt: viewModel.outputsReadyAt,
      durationMs: viewModel.durationMs,
      backgroundWorkPending: viewModel.backgroundWorkPending ?? false,
      accounting: viewModel.accounting,
      partialReason: viewModel.partialReason,
      omittedItemCount: viewModel.omittedItemCount ?? 0,
      activities: viewModel.items.map((item) => ({
        ...item.identity,
        sequence: item.sequence,
        graphName: item.graphName,
        nodeTitle: item.nodeTitle,
        nodeType: item.nodeType,
        status: item.status,
        category: item.category,
        resultOrigin: item.resultOrigin,
        startedAt: item.startedAt,
        durationMs: item.durationMs,
        modelCallCount: item.modelCallCount,
        classifierRequestCount: item.classifierRequestCount,
        toolCallCount: item.toolCallCount,
      })),
    };
    void copyToClipboard(JSON.stringify(diagnostic, null, 2)).then(() =>
      toast.success('Run Activity diagnostics copied.'),
    );
  });

  const inspectedTrace = useMemo(
    () =>
      inspectedIdentity == null
        ? undefined
        : resolveRunActivityInspectorTrace(project, currentGraph, runDataByNode, inspectedIdentity),
    [currentGraph, inspectedIdentity, project, runDataByNode],
  );

  return (
    <>
      <RunActivityDrawer
        open={open}
        viewModel={viewModel}
        height={height}
        onClose={() => setOpen(false)}
        onHeightChange={setHeight}
        columnWidths={columnWidths}
        onColumnWidthsChange={setStoredColumnWidths}
        initialViewState={initialViewState}
        onViewStateChange={onViewStateChange}
        onLocate={selectExactInvocation}
        onOpenFullOutput={handleOpenFullOutput}
        onOpenToolResult={handleOpenToolResult}
        onInspectResponse={handleInspectResponse}
        onCopyDiagnostics={handleCopyDiagnostics}
      />
      {inspectedIdentity && (
        <AgentResponseInspector trace={inspectedTrace} onClose={() => setInspectedIdentity(undefined)} renderInPortal />
      )}
    </>
  );
};

function createRunActivityGraphView(
  graphId: GraphId,
  executor:
    | { parentGraphId: GraphId; nodeId: RunActivityInvocationIdentity['nodeId'] }
    | 'browser'
    | 'nodejs'
    | undefined,
): GraphViewContext {
  return typeof executor === 'object'
    ? createSubgraphGraphViewContext({
        graphId,
        parentGraphId: executor.parentGraphId,
        parentNodeId: executor.nodeId,
      })
    : createRootGraphViewContext(graphId);
}
