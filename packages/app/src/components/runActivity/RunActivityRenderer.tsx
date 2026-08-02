import {
  resolveNodePrefabInstance,
  type ChartNode,
  type GraphId,
  type NodeGraph,
  type NodeRunActivityDescriptor,
} from '@valerypopoff/rivet2-core';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { type FC, useEffect, useMemo, useState } from 'react';
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
  type ProcessDataForNode,
  type RunDataByNodeId,
} from '../../state/dataFlow.js';
import { graphState } from '../../state/graph.js';
import { editingNodeState, fullscreenOutputNodeState, selectedNodesState } from '../../state/graphBuilder.js';
import { projectState } from '../../state/savedGraphs.js';
import {
  overlayOpenState,
  runActivityColumnWidthsState,
  runActivityDrawerHeightState,
  runActivityDrawerOpenState,
} from '../../state/ui.js';
import { copyToClipboard } from '../../utils/copyToClipboard.js';
import { hasStoredPortMapValues, hasStoredSplitOutputValues } from '../../utils/executionDataReaders.js';
import { AgentResponseInspector } from '../agentTrace/AgentResponseInspector.js';
import { buildLlmInvocationTrace } from '../agentTrace/agentTraceViewModel.js';
import { RunActivityDrawer } from './RunActivityDrawer.js';
import { ValueProvenanceInspector } from './ValueProvenanceInspector.js';
import {
  areRunActivityColumnWidthsEqual,
  normalizeRunActivityColumnWidths,
} from '../../features/runActivity/runActivityColumnWidths.js';
import { buildValueProvenanceReport } from '../../features/runActivity/valueProvenance.js';
import {
  buildRunActivityViewModel,
  selectRunActivityRoot,
  type ResolveRunActivityInvocation,
} from './buildRunActivityViewModel.js';
import type { RunActivityInvocationIdentity, RunActivityItemViewModel } from './types.js';

const LIVE_DURATION_REFRESH_MS = 250;
const NARROW_VIEWPORT_QUERY = '(max-width: 720px)';

/** Joins the metadata journal to the editor's existing graph and output stores. */
export const RunActivityRenderer: FC = () => {
  const [open, setOpen] = useAtom(runActivityDrawerOpenState);
  const [height, setHeight] = useAtom(runActivityDrawerHeightState);
  const [storedColumnWidths, setStoredColumnWidths] = useAtom(runActivityColumnWidthsState);
  const journal = useAtomValue(runActivityJournalState);
  const runDataByNode = useAtomValue(lastRunDataByNodeState);
  const project = useAtomValue(projectState);
  const currentGraph = useAtomValue(graphState);
  const registry = useProjectNodeRegistry();
  const [now, setNow] = useState(() => Date.now());
  const [inspectedProcess, setInspectedProcess] = useState<{
    node: ChartNode;
    processData: ProcessDataForNode;
  }>();
  const [provenanceItem, setProvenanceItem] = useState<RunActivityItemViewModel>();
  const goToNode = useGoToNode();
  const setOpenOverlay = useSetAtom(overlayOpenState);
  const setSelectedGraphRunByView = useSetAtom(selectedGraphRunByViewState);
  const setSelectedProcessPages = useSetAtom(selectedProcessPageNodesState);
  const setSelectedNodes = useSetAtom(selectedNodesState);
  const setEditingNode = useSetAtom(editingNodeState);
  const setFullscreenOutputNode = useSetAtom(fullscreenOutputNodeState);
  const selectedRoot = selectRunActivityRoot(journal);
  const columnWidths = useMemo(() => normalizeRunActivityColumnWidths(storedColumnWidths), [storedColumnWidths]);

  // atomWithStorage intentionally tolerates old browser values. Repair an
  // invalid record once at the owning UI boundary rather than letting a stale
  // preference leak into every drawer render.
  useEffect(() => {
    if (!areRunActivityColumnWidthsEqual(storedColumnWidths, columnWidths)) setStoredColumnWidths(columnWidths);
  }, [columnWidths, setStoredColumnWidths, storedColumnWidths]);

  useEffect(() => {
    if (!open || (selectedRoot?.status !== 'running' && selectedRoot?.status !== 'outputs-ready')) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), LIVE_DURATION_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [open, selectedRoot?.rootRunId, selectedRoot?.status]);

  const resolveInvocation = useMemo<ResolveRunActivityInvocation>(() => {
    return ({ invocation }) => {
      const graph = getCurrentGraphDefinition(project.graphs[invocation.graphId], currentGraph, invocation.graphId);
      const sourceNode = graph?.nodes.find((node) => node.id === invocation.nodeId);
      const effectiveNode = sourceNode ? resolveNodePrefabInstance(project, sourceNode) : undefined;
      const processData = findExactProcessData(runDataByNode, {
        rootRunId: invocation.rootRunId,
        graphRunId: invocation.graphRunId,
        graphId: invocation.graphId,
        nodeId: invocation.nodeId,
        processId: invocation.processId,
      });
      const descriptor = effectiveNode ? safelyGetRunActivityDescriptor(registry, effectiveNode) : undefined;
      const displayType = effectiveNode ? safelyGetNodeDisplayName(registry, effectiveNode) : invocation.nodeType;
      const hasStoredOutput = processData ? processHasStoredOutput(processData) : false;
      const responseTrace = effectiveNode ? buildLlmInvocationTrace(effectiveNode, processData) : undefined;

      return {
        graphName: graph?.metadata?.name,
        nodeTitle: sourceNode?.title,
        nodeType: displayType,
        category: descriptor?.category,
        primaryOutputPortId: descriptor?.primaryOutputPortId,
        contextInputPortIds: descriptor?.contextInputPortIds,
        runData: processData?.data,
        navigable: graph != null && sourceNode != null,
        fullOutputAvailable: graph != null && sourceNode != null && hasStoredOutput,
        inspectable: responseTrace != null,
        searchTerms: [sourceNode?.title, effectiveNode?.type, displayType].filter(
          (value): value is string => value != null && value.length > 0,
        ),
      };
    };
  }, [currentGraph, project, registry, runDataByNode]);

  const stableViewModel = useMemo(
    () =>
      buildRunActivityViewModel(journal, resolveInvocation, {
        now: selectedRoot?.finishedAt ?? selectedRoot?.startedAt ?? 0,
      }),
    [journal, resolveInvocation, selectedRoot?.finishedAt, selectedRoot?.startedAt],
  );
  const viewModel = useMemo(() => {
    if (selectedRoot?.startedAt == null || selectedRoot.finishedAt != null) return stableViewModel;
    return {
      ...stableViewModel,
      durationMs: Math.max(0, now - selectedRoot.startedAt),
    };
  }, [now, selectedRoot?.finishedAt, selectedRoot?.startedAt, stableViewModel]);

  const selectExactInvocation = useStableCallback((item: RunActivityItemViewModel) => {
    const graphRun = journal.rootsById[item.identity.rootRunId]?.graphRunsById[item.identity.graphRunId];
    const graph = getCurrentGraphDefinition(project.graphs[item.graphId], currentGraph, item.graphId);
    if (!graphRun || !graph?.nodes.some((node) => node.id === item.identity.nodeId)) return false;

    const graphView = createRunActivityGraphView(item.identity.graphId, graphRun.executor);
    const page = findExactProcessPage(runDataByNode, item.identity);
    setOpenOverlay(undefined);
    setSelectedGraphRunByView((current) => ({
      ...current,
      [graphView.key]: item.identity.graphRunId,
    }));
    if (page != null) {
      setSelectedProcessPages((current) => ({ ...current, [item.identity.nodeId]: page }));
    }
    setEditingNode(null);

    const narrow = window.matchMedia(NARROW_VIEWPORT_QUERY).matches;
    if (narrow) setOpen(false);
    goToNode(item.identity.nodeId, {
      graphId: item.identity.graphId,
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
    setSelectedNodes([item.identity.nodeId]);
    return true;
  });

  const handleOpenFullOutput = useStableCallback((item: RunActivityItemViewModel) => {
    if (!selectExactInvocation(item)) return;
    window.requestAnimationFrame(() => setFullscreenOutputNode(item.identity.nodeId));
  });

  const handleInspectResponse = useStableCallback((item: RunActivityItemViewModel) => {
    const graph = getCurrentGraphDefinition(project.graphs[item.graphId], currentGraph, item.graphId);
    const sourceNode = graph?.nodes.find((node) => node.id === item.identity.nodeId);
    const processData = findExactProcessData(runDataByNode, item.identity);
    if (!sourceNode || !processData) return;
    const effectiveNode = resolveNodePrefabInstance(project, sourceNode);
    if (!buildLlmInvocationTrace(effectiveNode, processData)) return;
    setInspectedProcess({ node: effectiveNode, processData });
  });

  const handleInspectValueProvenance = useStableCallback((item: RunActivityItemViewModel) => {
    setProvenanceItem(item);
  });

  const provenanceReport = useMemo(() => {
    if (provenanceItem == null) return undefined;
    const root = journal.rootsById[provenanceItem.identity.rootRunId];
    const invocation = root?.nodeInvocationsByKey[provenanceItem.activityKey];
    const graph = getCurrentGraphDefinition(
      project.graphs[provenanceItem.graphId],
      currentGraph,
      provenanceItem.graphId,
    );
    if (!root || !invocation || !graph) return undefined;
    return buildValueProvenanceReport({ graph, root, target: invocation, runDataByNode });
  }, [currentGraph, journal.rootsById, project.graphs, provenanceItem, runDataByNode]);

  useEffect(() => {
    if (provenanceItem != null && provenanceReport == null) setProvenanceItem(undefined);
  }, [provenanceItem, provenanceReport]);

  useEffect(() => {
    if (provenanceItem != null && (!open || selectedRoot?.rootRunId !== provenanceItem.identity.rootRunId)) {
      setProvenanceItem(undefined);
    }
  }, [open, provenanceItem, selectedRoot?.rootRunId]);

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
        toolCallCount: item.toolCallCount,
      })),
    };
    void copyToClipboard(JSON.stringify(diagnostic, null, 2)).then(() =>
      toast.success('Run Activity diagnostics copied.'),
    );
  });

  const inspectedTrace = useMemo(
    () =>
      inspectedProcess == null
        ? undefined
        : buildLlmInvocationTrace(inspectedProcess.node, inspectedProcess.processData),
    [inspectedProcess],
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
        onLocate={selectExactInvocation}
        onOpenFullOutput={handleOpenFullOutput}
        onInspectResponse={handleInspectResponse}
        onInspectValueProvenance={handleInspectValueProvenance}
        onCopyDiagnostics={handleCopyDiagnostics}
      />
      {inspectedProcess && (
        <AgentResponseInspector trace={inspectedTrace} onClose={() => setInspectedProcess(undefined)} renderInPortal />
      )}
      {provenanceItem && provenanceReport && (
        <ValueProvenanceInspector report={provenanceReport} onClose={() => setProvenanceItem(undefined)} />
      )}
    </>
  );
};

function getCurrentGraphDefinition(
  savedGraph: NodeGraph | undefined,
  currentGraph: NodeGraph,
  graphId: GraphId,
): NodeGraph | undefined {
  return currentGraph.metadata?.id === graphId ? currentGraph : savedGraph;
}

function safelyGetRunActivityDescriptor(
  registry: ReturnType<typeof useProjectNodeRegistry>,
  node: ChartNode,
): NodeRunActivityDescriptor | undefined {
  try {
    return registry.createDynamicImpl(node).getRunActivityDescriptor();
  } catch {
    return undefined;
  }
}

function safelyGetNodeDisplayName(registry: ReturnType<typeof useProjectNodeRegistry>, node: ChartNode): string {
  try {
    return registry.getDynamicDisplayName(node.type);
  } catch {
    return node.type;
  }
}

function findExactProcessData(
  runDataByNode: RunDataByNodeId,
  identity: RunActivityInvocationIdentity,
): ProcessDataForNode | undefined {
  return runDataByNode[identity.nodeId]?.find((process) => matchesExactProcess(process, identity));
}

function findExactProcessPage(runDataByNode: RunDataByNodeId, identity: RunActivityInvocationIdentity) {
  const graphProcesses =
    runDataByNode[identity.nodeId]?.filter(
      (process) =>
        process.rootRunId === identity.rootRunId &&
        process.graphRunId === identity.graphRunId &&
        (process.graphId == null || process.graphId === identity.graphId),
    ) ?? [];
  const page = graphProcesses.findIndex((process) => process.processId === identity.processId);
  return page < 0 ? undefined : page;
}

function matchesExactProcess(process: ProcessDataForNode, identity: RunActivityInvocationIdentity): boolean {
  return (
    process.rootRunId === identity.rootRunId &&
    process.graphRunId === identity.graphRunId &&
    process.processId === identity.processId &&
    (process.graphId == null || process.graphId === identity.graphId)
  );
}

function processHasStoredOutput(processData: ProcessDataForNode): boolean {
  return (
    hasStoredPortMapValues(processData.data.outputData) || hasStoredSplitOutputValues(processData.data.splitOutputData)
  );
}

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
