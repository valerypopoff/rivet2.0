import type { PortId } from '@valerypopoff/rivet2-core';
import type {
  RunActivityGraphRun,
  RunActivityJournal,
  RunActivityModelCall,
  RunActivityNodeInvocation,
  RunActivityRoot,
  RunActivityToolCall,
} from '../../features/runActivity/runActivityJournal.js';
import { selectCurrentRunActivityRoot } from '../../features/runActivity/runActivityJournal.js';
import type { NodeRunDataWithRefs, StoredDataValue } from '../../state/dataFlow.js';
import type {
  RunActivityCategory,
  RunActivityAccountingSummary,
  RunActivityChildViewModel,
  RunActivityDetailRow,
  RunActivityItemStatus,
  RunActivityItemViewModel,
  RunActivityResultOriginView,
  RunActivityStatus,
  RunActivityViewModel,
} from './types.js';
import { previewStoredDataValue } from '../../features/runActivity/storedValuePreview.js';

export {
  RUN_ACTIVITY_PREVIEW_MAX_CHARS,
  previewStoredDataValue,
} from '../../features/runActivity/storedValuePreview.js';

export type RunActivityInvocationResolution = {
  graphName?: string;
  nodeTitle?: string;
  nodeType?: string;
  category?: Exclude<RunActivityCategory, 'error'>;
  primaryOutputPortId?: PortId;
  contextInputPortIds?: PortId[];
  runData?: NodeRunDataWithRefs;
  navigable?: boolean;
  fullOutputAvailable?: boolean;
  inspectable?: boolean;
  searchTerms?: string[];
};

export type ResolveRunActivityInvocation = (context: {
  root: RunActivityRoot;
  graphRun?: RunActivityGraphRun;
  invocation: RunActivityNodeInvocation;
}) => RunActivityInvocationResolution | undefined;

export type BuildRunActivityViewModelOptions = {
  /** Required for deterministic live-duration projections in tests and recordings. */
  now?: number;
};

/**
 * Projects the metadata-only execution journal into the presentation contract.
 * The resolver may expose already-stored inline/ref values, but this adapter
 * deliberately never dereferences StoredDataValue refs.
 */
export function buildRunActivityViewModel(
  journal: RunActivityJournal,
  resolveInvocation: ResolveRunActivityInvocation,
  options: BuildRunActivityViewModelOptions = {},
): RunActivityViewModel {
  const root = selectRunActivityRoot(journal);
  if (root == null) {
    return {
      status: 'idle',
      items: [],
      ...(journal.ignoredLegacyEventCount > 0
        ? { partialReason: `${journal.ignoredLegacyEventCount} legacy execution events lacked exact run identity.` }
        : {}),
    };
  }

  const now = options.now ?? Date.now();
  const items = root.nodeInvocationOrder
    .map((key) => root.nodeInvocationsByKey[key])
    .filter((invocation): invocation is RunActivityNodeInvocation => invocation != null)
    .map((invocation) => buildInvocationViewModel(root, invocation, resolveInvocation))
    .sort((left, right) => left.sequence - right.sequence);
  const partialReason = getPartialReason(journal, root);
  const accounting = buildAccountingSummary(root);

  return {
    rootRunId: root.rootRunId,
    status: mapRootStatus(root.status),
    items,
    ...(root.startedAt == null ? {} : { startedAt: root.startedAt }),
    ...(root.graphOutputsReadyAt == null ? {} : { outputsReadyAt: root.graphOutputsReadyAt }),
    ...(root.startedAt == null ? {} : { durationMs: Math.max(0, (root.finishedAt ?? now) - root.startedAt) }),
    ...(root.status === 'outputs-ready' ? { backgroundWorkPending: true } : {}),
    ...(accounting == null ? {} : { accounting }),
    graphOptions: buildGraphOptions(root, items),
    ...(root.omittedNodeInvocationCount > 0 ? { omittedItemCount: root.omittedNodeInvocationCount } : {}),
    ...(partialReason ? { partialReason } : {}),
  };
}

function buildAccountingSummary(root: RunActivityRoot): RunActivityAccountingSummary | undefined {
  const invocations = root.nodeInvocationOrder
    .map((key) => root.nodeInvocationsByKey[key])
    .filter((invocation): invocation is RunActivityNodeInvocation => invocation != null);
  const modelCallCount = invocations.reduce((total, invocation) => total + invocation.modelCallCount, 0);
  const toolCallCount = invocations.reduce((total, invocation) => total + invocation.toolCallCount, 0);
  if (modelCallCount === 0 && toolCallCount === 0) return undefined;
  const calls = invocations.flatMap((invocation) => invocation.modelCalls);
  const omittedCount = invocations.reduce((total, invocation) => total + invocation.omittedModelCallCount, 0);
  const totalUsage = (key: 'promptTokens' | 'completionTokens' | 'cachedTokens' | 'reasoningTokens') => {
    const total = calls.reduce((sum, call) => sum + (call.usage?.[key] ?? 0), 0);
    return total > 0 ? total : undefined;
  };
  const knownCosts = calls
    .filter((call) => call.pricing.status === 'known' && call.pricing.costUsd != null)
    .reduce((total, call) => total + call.pricing.costUsd!, 0);
  const hasUnknownCost = calls.some((call) => call.pricing.status !== 'known' || call.pricing.costUsd == null);
  const costStatus =
    modelCallCount === 0 || (knownCosts === 0 && (hasUnknownCost || omittedCount > 0))
      ? 'unknown'
      : hasUnknownCost || omittedCount > 0
        ? 'partial'
        : 'known';

  const promptTokens = totalUsage('promptTokens');
  const completionTokens = totalUsage('completionTokens');
  const cachedTokens = totalUsage('cachedTokens');
  const reasoningTokens = totalUsage('reasoningTokens');

  return {
    modelCallCount,
    toolCallCount,
    ...(promptTokens == null ? {} : { promptTokens }),
    ...(completionTokens == null ? {} : { completionTokens }),
    ...(cachedTokens == null ? {} : { cachedTokens }),
    ...(reasoningTokens == null ? {} : { reasoningTokens }),
    knownCostUsd: knownCosts,
    costStatus,
  };
}

export function selectRunActivityRoot(journal: RunActivityJournal): RunActivityRoot | undefined {
  return selectCurrentRunActivityRoot(journal);
}

function buildInvocationViewModel(
  root: RunActivityRoot,
  invocation: RunActivityNodeInvocation,
  resolveInvocation: ResolveRunActivityInvocation,
): RunActivityItemViewModel {
  const graphRun = root.graphRunsById[invocation.graphRunId];
  const resolved = resolveInvocation({ root, graphRun, invocation }) ?? {};
  const graphName = resolved.graphName ?? invocation.graphName ?? graphRun?.graphName ?? 'Unknown graph';
  const nodeTitle =
    normalizeNonEmptyLabel(resolved.nodeTitle) ??
    normalizeNonEmptyLabel(invocation.nodeTitle) ??
    'Deleted or unavailable node';
  const nodeType = resolved.nodeType ?? invocation.nodeType ?? 'Unknown node type';
  const category = resolveCategory(invocation, resolved.category);
  const status = mapNodeStatus(invocation.status);
  const preview = getInvocationPreview(invocation, resolved);
  const children = buildChildRows(invocation);
  const hasErrors =
    status === 'error' ||
    status === 'interrupted' ||
    children.some((child) => child.status === 'error' || child.status === 'interrupted');
  const detailRows = buildDetailRows(root, graphRun, invocation, resolved, category);
  const primaryModelCall = getEffectiveModelCall(invocation.modelCalls);
  const searchTerms = buildInvocationSearchTerms(invocation, resolved.searchTerms);

  return {
    activityKey: invocation.key,
    identity: {
      rootRunId: invocation.rootRunId,
      graphRunId: invocation.graphRunId,
      graphId: invocation.graphId,
      nodeId: invocation.nodeId,
      processId: invocation.processId,
    },
    sequence: invocation.sequence,
    graphId: invocation.graphId,
    graphName,
    nodeTitle,
    nodeType,
    status,
    category,
    resultOrigin: invocation.resultOrigin as RunActivityResultOriginView,
    ...(invocation.startedAt == null ? {} : { startedAt: invocation.startedAt }),
    ...(invocation.durationMs == null ? {} : { durationMs: invocation.durationMs }),
    ...(preview == null ? {} : { preview }),
    ...(invocation.errorSummary == null ? {} : { error: invocation.errorSummary }),
    ...(invocation.splitOutputIndices.length === 0 ? {} : { splitCount: invocation.splitOutputIndices.length }),
    ...(primaryModelCall?.provider == null ? {} : { provider: primaryModelCall.provider }),
    ...(primaryModelCall?.model == null ? {} : { model: primaryModelCall.model }),
    ...(invocation.toolCalls[0]?.toolName == null ? {} : { toolName: invocation.toolCalls[0].toolName }),
    ...(invocation.modelCallCount > 0 ? { modelCallCount: invocation.modelCallCount } : {}),
    ...(invocation.toolCallCount > 0 ? { toolCallCount: invocation.toolCallCount } : {}),
    ...(detailRows.length === 0 ? {} : { detailRows }),
    ...(children.length === 0 ? {} : { children }),
    ...(searchTerms.length === 0 ? {} : { searchTerms }),
    navigable: resolved.navigable ?? false,
    fullOutputAvailable: resolved.fullOutputAvailable ?? (resolved.runData != null && invocation.outputsAvailable),
    inspectable: resolved.inspectable ?? false,
    inputProvenanceAvailable:
      Object.keys(resolved.runData?.inputData ?? {}).length > 0 ||
      invocation.inputPortIds.length > 0 ||
      (invocation.inputConnections?.length ?? 0) > 0,
    ...(hasErrors ? { hasErrors: true } : {}),
  };
}

function buildInvocationSearchTerms(
  invocation: RunActivityNodeInvocation,
  resolvedSearchTerms: readonly string[] | undefined,
): string[] {
  const terms = [
    ...(resolvedSearchTerms ?? []),
    ...invocation.modelCalls.flatMap((call) => [call.provider, call.model]),
    ...invocation.toolCalls.map((call) => call.toolName),
  ];
  return [...new Set(terms.map(normalizeNonEmptyLabel).filter((term): term is string => term != null))];
}

function normalizeNonEmptyLabel(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function buildGraphOptions(root: RunActivityRoot, items: RunActivityItemViewModel[]) {
  const byId = new Map<string, { graphId: RunActivityItemViewModel['graphId']; graphName: string; sequence: number }>();
  for (const graphRunId of root.graphRunOrder) {
    const graphRun = root.graphRunsById[graphRunId];
    if (graphRun == null) continue;
    byId.set(graphRun.graphId, {
      graphId: graphRun.graphId,
      graphName: graphRun.graphName ?? 'Unknown graph',
      sequence: graphRun.sequence,
    });
  }
  for (const item of items) {
    const current = byId.get(item.graphId);
    byId.set(item.graphId, {
      graphId: item.graphId,
      graphName: item.graphName,
      sequence: Math.min(current?.sequence ?? item.sequence, item.sequence),
    });
  }
  return [...byId.values()]
    .sort((left, right) => left.sequence - right.sequence)
    .map(({ graphId, graphName }) => ({ graphId, graphName }));
}

function getInvocationPreview(
  invocation: RunActivityNodeInvocation,
  resolved: RunActivityInvocationResolution,
): string | undefined {
  if (invocation.errorSummary) return undefined;
  if (!invocation.outputsAvailable) {
    return invocation.outputsClearedAt == null
      ? describeUnavailableOutput(invocation)
      : 'Output cleared from execution history';
  }
  const runData = resolved.runData;
  if (runData == null) return 'Output metadata recorded; value unavailable';

  const primaryPortId = resolved.primaryOutputPortId;
  const direct = selectStoredPortValue(runData.outputData, invocation.outputPortIds, primaryPortId);
  if (direct) return previewStoredDataValue(direct);

  for (const splitIndex of invocation.splitOutputIndices) {
    const splitValues = runData.splitOutputData?.[splitIndex];
    const value = selectStoredPortValue(splitValues, invocation.splitOutputPortIds[splitIndex] ?? [], primaryPortId);
    if (value) {
      const preview = previewStoredDataValue(value);
      return invocation.splitOutputIndices.length > 1 ? `Split ${splitIndex}: ${preview}` : preview;
    }
  }

  return 'Output metadata recorded; no previewable value';
}

function selectStoredPortValue(
  stored: NodeRunDataWithRefs['outputData'] | undefined,
  orderedPortIds: readonly PortId[],
  primaryPortId: PortId | undefined,
): StoredDataValue | undefined {
  if (stored == null) return undefined;
  if (primaryPortId != null && stored[primaryPortId] != null) return stored[primaryPortId];
  for (const portId of orderedPortIds) {
    if (stored[portId] != null) return stored[portId];
  }
  return Object.values(stored)[0];
}

function buildChildRows(invocation: RunActivityNodeInvocation): RunActivityChildViewModel[] {
  return [
    ...invocation.modelCalls.map((call) => ({ sequence: call.sequence, child: modelCallToChild(call) })),
    ...invocation.toolCalls.map((call) => ({ sequence: call.sequence, child: toolCallToChild(call) })),
  ]
    .sort((left, right) => left.sequence - right.sequence || left.child.id.localeCompare(right.child.id))
    .map(({ child }) => child);
}

function getEffectiveModelCall(calls: readonly RunActivityModelCall[]): RunActivityModelCall | undefined {
  const ordered = [...calls].sort((left, right) => left.sequence - right.sequence);
  return ordered.findLast((call) => call.outcome === 'success') ?? ordered.at(-1);
}

function modelCallToChild(call: RunActivityModelCall): RunActivityChildViewModel {
  const context = [
    call.outcome,
    call.profileIndex == null ? undefined : `profile ${call.profileIndex + 1}`,
    call.roundIndex == null ? undefined : `round ${call.roundIndex + 1}`,
    `attempt ${call.attemptIndex + 1}`,
  ].filter((value): value is string => value != null);
  return {
    id: `model:${call.callId}:${call.sequence}`,
    label: `${call.provider} / ${call.model}`,
    secondaryText: context.join(' / '),
    status: call.outcome === 'success' ? 'success' : call.outcome === 'aborted' ? 'interrupted' : 'error',
    ...(call.durationMs == null ? {} : { durationMs: call.durationMs }),
  };
}

function toolCallToChild(call: RunActivityToolCall): RunActivityChildViewModel {
  const context = [call.outcome, call.handlerKind, call.handlerName].filter((value): value is string => value != null);
  return {
    id: `tool:${call.toolCallId ?? call.toolName}:${call.sequence}`,
    label: call.toolName,
    secondaryText: context.join(' / '),
    status: call.outcome === 'success' ? 'success' : call.outcome === 'aborted' ? 'interrupted' : 'error',
    ...(call.durationMs == null ? {} : { durationMs: call.durationMs }),
  };
}

function buildDetailRows(
  root: RunActivityRoot,
  graphRun: RunActivityGraphRun | undefined,
  invocation: RunActivityNodeInvocation,
  resolved: RunActivityInvocationResolution,
  category: RunActivityCategory,
): RunActivityDetailRow[] {
  // A normal physical execution is the expected case and does not need a
  // provenance badge on every row. Replay and legacy origins are exceptional,
  // actionable metadata, so keep those visible.
  const rows: RunActivityDetailRow[] =
    invocation.resultOrigin === 'executed'
      ? []
      : [{ label: 'Result origin', value: describeResultOrigin(invocation.resultOrigin) }];
  const graphPath = getGraphRunPath(root, invocation.graphRunId);
  if (graphPath.length > 1) rows.push({ label: 'Graph path', value: graphPath.join(' \u203a ') });
  if (graphRun?.executor) {
    rows.push({
      label: 'Subgraph caller',
      value: `Node ${graphRun.executor.nodeId} in ${graphRun.executor.parentGraphId}`,
    });
  }
  for (const portId of resolved.contextInputPortIds ?? []) {
    const value = resolved.runData?.inputData?.[portId];
    if (value != null) rows.push({ label: `Input: ${portId}`, value: previewStoredDataValue(value) });
  }
  if (invocation.waitingForUserInput) {
    rows.push({
      label: 'Waiting for',
      value: `${invocation.waitingForUserInput.questionCount} user ${
        invocation.waitingForUserInput.questionCount === 1 ? 'question' : 'questions'
      } (${invocation.waitingForUserInput.renderingType})`,
    });
  }
  if (invocation.progress) {
    rows.push({
      label: 'Progress',
      value: [
        invocation.progress.percent == null ? undefined : `${Math.round(invocation.progress.percent)}%`,
        invocation.progress.message,
      ]
        .filter((value): value is string => value != null)
        .join(' · '),
    });
  }
  if (invocation.partialOutputCount > 0) {
    rows.push({ label: 'Partial output updates', value: String(invocation.partialOutputCount) });
  }
  if (invocation.omittedModelCallCount > 0) {
    rows.push({ label: 'Model call rows omitted', value: String(invocation.omittedModelCallCount) });
  }
  if (invocation.omittedToolCallCount > 0) {
    rows.push({ label: 'Tool call rows omitted', value: String(invocation.omittedToolCallCount) });
  }
  if (invocation.terminalEventMissing) rows.push({ label: 'Execution record', value: 'Terminal event unavailable' });
  if (invocation.exclusionReason) rows.push({ label: 'Not run because', value: invocation.exclusionReason });
  if (invocation.status !== 'running' && category === 'model' && invocation.modelCallCount === 0) {
    rows.push({
      label: 'Model call details',
      value:
        invocation.resultOrigin === 'executed'
          ? 'No physical provider-call event was recorded'
          : 'Unavailable for this replayed result',
    });
  }
  if (invocation.status !== 'running' && category === 'tool' && invocation.toolCallCount === 0) {
    rows.push({
      label: 'Tool call details',
      value:
        invocation.resultOrigin === 'executed'
          ? 'No physical tool-call event was recorded'
          : 'Unavailable for this replayed result',
    });
  }
  return rows;
}

function getGraphRunPath(root: RunActivityRoot, graphRunId: string): string[] {
  const path: string[] = [];
  const seen = new Set<string>();
  let current = root.graphRunsById[graphRunId];
  while (current && !seen.has(current.graphRunId)) {
    seen.add(current.graphRunId);
    path.unshift(current.graphName ?? String(current.graphId));
    current = current.parentGraphRunId == null ? undefined : root.graphRunsById[current.parentGraphRunId];
  }
  return path;
}

function resolveCategory(
  invocation: RunActivityNodeInvocation,
  resolvedCategory: RunActivityInvocationResolution['category'],
): RunActivityCategory {
  if (resolvedCategory) return resolvedCategory;
  if (invocation.modelCallCount > 0) return 'model';
  if (invocation.toolCallCount > 0) return 'tool';
  return 'generic';
}

function mapRootStatus(status: RunActivityRoot['status']): RunActivityStatus {
  if (status === 'error') return 'failed';
  return status;
}

function mapNodeStatus(status: RunActivityNodeInvocation['status']): RunActivityItemStatus {
  const mapped: Record<RunActivityNodeInvocation['status'], RunActivityItemStatus> = {
    unknown: 'unknown',
    waiting: 'waiting',
    running: 'running',
    completed: 'success',
    error: 'error',
    aborted: 'interrupted',
    excluded: 'not-ran',
  };
  return mapped[status];
}

function describeResultOrigin(origin: RunActivityNodeInvocation['resultOrigin']): string {
  const labels: Record<RunActivityNodeInvocation['resultOrigin'], string> = {
    executed: 'Executed in this run',
    preloaded: 'Preloaded result',
    frozen: 'Frozen result replay',
    'editor-cache': 'Editor cache replay',
    unknown: 'Unknown or legacy origin',
  };
  return labels[origin];
}

function describeUnavailableOutput(invocation: RunActivityNodeInvocation): string {
  if (invocation.status === 'waiting') return 'Waiting for user input';
  if (invocation.status === 'running') return 'Running';
  if (invocation.status === 'excluded') return invocation.exclusionReason ?? 'Not run';
  if (invocation.resultOrigin !== 'executed') return describeResultOrigin(invocation.resultOrigin);
  return 'No output recorded';
}

function getPartialReason(journal: RunActivityJournal, root: RunActivityRoot): string | undefined {
  const reasons: string[] = [];
  if (root.isPartial) reasons.push('Some execution events lacked exact run identity.');
  if (journal.ignoredLegacyEventCount > 0) {
    reasons.push(
      `${journal.ignoredLegacyEventCount} legacy events in the activity journal could not be associated with an exact run.`,
    );
  }
  if (root.omittedLegacyEventCount > 0) {
    reasons.push(`${root.omittedLegacyEventCount} legacy events could not be associated with this exact run.`);
  }
  const incompleteGraphCount = Object.values(root.graphRunsById).filter((graph) => graph.terminalEventMissing).length;
  const incompleteNodeCount = Object.values(root.nodeInvocationsByKey).filter(
    (invocation) => invocation.terminalEventMissing,
  ).length;
  if (incompleteGraphCount + incompleteNodeCount > 0) {
    reasons.push(`${incompleteGraphCount + incompleteNodeCount} activity records lack a terminal event.`);
  }
  const unknownOriginCount = Object.values(root.nodeInvocationsByKey).filter(
    (invocation) => invocation.resultOrigin === 'unknown',
  ).length;
  if (unknownOriginCount > 0) {
    reasons.push(`${unknownOriginCount} activity records have unknown or legacy result provenance.`);
  }
  return reasons.join(' ') || undefined;
}
