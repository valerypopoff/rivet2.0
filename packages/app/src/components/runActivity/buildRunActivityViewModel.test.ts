import assert from 'node:assert/strict';
import test from 'node:test';
import type { GraphId, GraphRunId, NodeId, PortId, ProcessId, RootRunId } from '@valerypopoff/rivet2-core';
import {
  createRunActivityJournal,
  type RunActivityJournal,
  type RunActivityNodeInvocation,
  type RunActivityRoot,
} from '../../features/runActivity/runActivityJournal.js';
import type { NodeRunDataWithRefs, StoredDataValue } from '../../state/dataFlow.js';
import {
  RUN_ACTIVITY_PREVIEW_MAX_CHARS,
  buildRunActivityViewModel,
  previewStoredDataValue,
  selectRunActivityRoot,
} from './buildRunActivityViewModel.js';
import { filterRunActivityItems } from './filterRunActivityItems.js';

const completedRootId = 'completed-root' as RootRunId;
const olderActiveRootId = 'older-active' as RootRunId;
const newerActiveRootId = 'newer-active' as RootRunId;

test('selects the newest active root before the latest completed root', () => {
  const journal = createRunActivityJournal();
  journal.rootsById[completedRootId] = root(completedRootId, 1, 'completed');
  journal.rootsById[olderActiveRootId] = root(olderActiveRootId, 2, 'running');
  journal.rootsById[newerActiveRootId] = root(newerActiveRootId, 3, 'outputs-ready');
  journal.rootOrder = [completedRootId, olderActiveRootId, newerActiveRootId];
  journal.activeRootRunIds = [newerActiveRootId, olderActiveRootId];
  journal.latestCompletedRootRunId = completedRootId;

  assert.equal(selectRunActivityRoot(journal)?.rootRunId, newerActiveRootId);
  journal.activeRootRunIds = [];
  assert.equal(selectRunActivityRoot(journal)?.rootRunId, completedRootId);
});

test('projects stable exact invocation rows, bounded stored previews, children, and filters', () => {
  const journal = createRunActivityJournal();
  const selectedRoot = root(newerActiveRootId, 7, 'outputs-ready');
  selectedRoot.startedAt = 1_000;
  selectedRoot.graphOutputsReadyAt = 1_500;
  selectedRoot.omittedNodeInvocationCount = 3;
  selectedRoot.isPartial = true;
  selectedRoot.omittedLegacyEventCount = 2;

  const laterInvocation = invocation({
    key: 'later',
    sequence: 12,
    graphId: 'tools',
    graphRunId: 'tools-run',
    nodeId: 'delegate',
    processId: 'delegate-process',
  });
  laterInvocation.resultOrigin = 'frozen';
  laterInvocation.toolCallCount = 1;
  laterInvocation.toolCalls = [
    {
      sequence: 15,
      toolCallId: 'tool-call',
      toolName: 'searchKnowledge',
      sourceNodeId: laterInvocation.nodeId,
      sourceProcessId: laterInvocation.processId,
      handlerKind: 'graph',
      handlerName: 'Search knowledge',
      outcome: 'failure',
      durationMs: 80,
    },
  ];

  const earlierInvocation = invocation({
    key: 'earlier',
    sequence: 8,
    graphId: 'main',
    graphRunId: 'main-run',
    nodeId: 'chat',
    processId: 'chat-process',
  });
  earlierInvocation.modelCallCount = 2;
  earlierInvocation.modelCalls = [
    {
      sequence: 9,
      callId: 'failed-call',
      nodeId: earlierInvocation.nodeId,
      processId: earlierInvocation.processId,
      provider: 'openai',
      model: 'fallback-a',
      outcome: 'provider-failure',
      attemptIndex: 0,
      profileIndex: 0,
      pricing: { status: 'unknown' },
      durationMs: 30,
    },
    {
      sequence: 10,
      callId: 'successful-call',
      nodeId: earlierInvocation.nodeId,
      processId: earlierInvocation.processId,
      provider: 'anthropic',
      model: 'fallback-b',
      outcome: 'success',
      attemptIndex: 0,
      profileIndex: 1,
      pricing: { status: 'known', costUsd: 0.01 },
      durationMs: 50,
    },
  ];
  earlierInvocation.outputPortIds = ['response' as PortId];

  selectedRoot.graphRunsById[laterInvocation.graphRunId] = {
    sequence: 4,
    rootRunId: selectedRoot.rootRunId,
    graphRunId: laterInvocation.graphRunId,
    graphId: laterInvocation.graphId,
    graphName: 'Tool graph from journal',
    status: 'completed',
  };
  selectedRoot.graphRunsById[earlierInvocation.graphRunId] = {
    sequence: 2,
    rootRunId: selectedRoot.rootRunId,
    graphRunId: earlierInvocation.graphRunId,
    graphId: earlierInvocation.graphId,
    graphName: 'Main graph from journal',
    status: 'running',
  };
  selectedRoot.graphRunOrder = [earlierInvocation.graphRunId, laterInvocation.graphRunId];
  selectedRoot.nodeInvocationsByKey[laterInvocation.key] = laterInvocation;
  selectedRoot.nodeInvocationsByKey[earlierInvocation.key] = earlierInvocation;
  selectedRoot.nodeInvocationOrder = [laterInvocation.key, earlierInvocation.key];
  journal.rootsById[selectedRoot.rootRunId] = selectedRoot;
  journal.rootOrder = [selectedRoot.rootRunId];
  journal.activeRootRunIds = [selectedRoot.rootRunId];

  const refValue: StoredDataValue = {
    type: 'string',
    storage: 'ref',
    refId: 'must-not-be-resolved',
    preview: {
      kind: 'text',
      excerpt: `Visible preview ${'x'.repeat(RUN_ACTIVITY_PREVIEW_MAX_CHARS * 2)}`,
      totalChars: 1_000,
      lineCount: 1,
    },
  };
  const runData: NodeRunDataWithRefs = {
    inputData: { ['prompt' as PortId]: { type: 'string', storage: 'inline', value: 'Compact prompt context' } },
    outputData: { ['response' as PortId]: refValue },
  };
  const seenKeys: string[] = [];
  const viewModel = buildRunActivityViewModel(
    journal,
    ({ invocation: current }) => {
      seenKeys.push(current.key);
      if (current.key === earlierInvocation.key) {
        return {
          graphName: 'Current Main graph',
          nodeTitle: 'Answer user',
          nodeType: 'LLM Chat',
          category: 'model',
          primaryOutputPortId: 'response' as PortId,
          runData,
          navigable: true,
          inspectable: true,
          fullOutputAvailable: true,
        };
      }
      return {
        graphName: 'Current Tool graph',
        nodeTitle: 'Search docs',
        nodeType: 'Delegate Tool Call',
        category: 'tool',
        navigable: true,
      };
    },
    { now: 1_750 },
  );

  assert.deepEqual(seenKeys, [laterInvocation.key, earlierInvocation.key]);
  assert.equal(viewModel.rootRunId, selectedRoot.rootRunId);
  assert.equal(viewModel.status, 'outputs-ready');
  assert.equal(viewModel.backgroundWorkPending, true);
  assert.equal(viewModel.durationMs, 750);
  assert.deepEqual(viewModel.accounting, {
    modelCallCount: 2,
    toolCallCount: 1,
    knownCostUsd: 0.01,
    costStatus: 'partial',
    incomplete: true,
  });
  assert.equal(viewModel.omittedItemCount, 3);
  assert.match(viewModel.partialReason ?? '', /exact run identity/);
  assert.match(viewModel.partialReason ?? '', /2 legacy events/);
  assert.deepEqual(
    viewModel.items.map((item) => item.activityKey),
    [earlierInvocation.key, laterInvocation.key],
  );
  assert.deepEqual(
    viewModel.graphOptions?.map((option) => [option.graphId, option.graphName]),
    [
      [earlierInvocation.graphId, 'Current Main graph'],
      [laterInvocation.graphId, 'Current Tool graph'],
    ],
  );

  const modelItem = viewModel.items[0]!;
  assert.deepEqual(modelItem.identity, {
    rootRunId: selectedRoot.rootRunId,
    graphRunId: earlierInvocation.graphRunId,
    graphId: earlierInvocation.graphId,
    nodeId: earlierInvocation.nodeId,
    processId: earlierInvocation.processId,
  });
  assert.equal(modelItem.preview?.startsWith('Visible preview'), true);
  assert.equal(modelItem.preview?.length, RUN_ACTIVITY_PREVIEW_MAX_CHARS);
  assert.equal(modelItem.preview?.includes('must-not-be-resolved'), false);
  assert.equal(modelItem.provider, 'anthropic');
  assert.equal(modelItem.model, 'fallback-b');
  assert.equal(modelItem.detailRows?.some((row) => row.label === 'Result origin') ?? false, false);
  assert.equal(modelItem.children?.length, 2);
  assert.deepEqual(
    modelItem.children?.map((child) => child.status),
    ['error', 'success'],
  );
  assert.equal(modelItem.hasErrors, true);
  assert.equal(modelItem.navigable, true);
  assert.equal(modelItem.inspectable, true);

  const toolItem = viewModel.items[1]!;
  assert.equal(toolItem.resultOrigin, 'frozen');
  assert.deepEqual(
    toolItem.detailRows?.find((row) => row.label === 'Result origin'),
    { label: 'Result origin', value: 'Frozen result replay' },
  );
  assert.equal(toolItem.hasErrors, true);
  assert.equal(toolItem.children?.[0]?.label, 'searchKnowledge');
  assert.equal(toolItem.fullOutputAvailable, false);
});

test('does not recursively materialize large or cyclic inline values', () => {
  const cyclic: Record<string, unknown> = { visible: 'yes' };
  cyclic.self = cyclic;
  const value = {
    type: 'any',
    storage: 'inline',
    value: cyclic,
  } as StoredDataValue;
  const preview = previewStoredDataValue(value);
  assert.match(preview, /visible/);
  assert.match(preview, /Circular/);
  assert.ok(preview.length <= RUN_ACTIVITY_PREVIEW_MAX_CHARS);
});

test('uses a ref-backed summary excerpt when it is available and preserves summary-only fallbacks', () => {
  const chatPreview: StoredDataValue = {
    type: 'chat-message',
    storage: 'ref',
    refId: 'prompt-output',
    preview: {
      kind: 'summary',
      label: 'Chat Message (developer)',
      excerpt: 'Answer the user question with concise facts.',
      totalBytes: 42,
    },
  };
  const mediaPreview: StoredDataValue = {
    type: 'image',
    storage: 'ref',
    refId: 'image-output',
    preview: {
      kind: 'summary',
      label: 'Image (image/png)',
      totalBytes: 128,
    },
  };

  assert.equal(previewStoredDataValue(chatPreview), 'Answer the user question with concise facts.');
  assert.equal(previewStoredDataValue(mediaPreview), 'Image (image/png)');
});

test('does not replace an explicitly recorded empty error with an output preview', () => {
  const journal = createRunActivityJournal();
  const selectedRoot = root(newerActiveRootId, 1, 'completed');
  const erroredInvocation = invocation({
    key: 'empty-error',
    sequence: 1,
    graphId: 'main',
    graphRunId: 'main-run',
    nodeId: 'chat',
    processId: 'chat-process',
  });
  erroredInvocation.errorSummary = '';
  erroredInvocation.outputPortIds = ['response' as PortId];
  selectedRoot.nodeInvocationsByKey[erroredInvocation.key] = erroredInvocation;
  selectedRoot.nodeInvocationOrder = [erroredInvocation.key];
  journal.rootsById[selectedRoot.rootRunId] = selectedRoot;
  journal.latestCompletedRootRunId = selectedRoot.rootRunId;

  const item = buildRunActivityViewModel(journal, () => ({
    nodeTitle: 'Answer user',
    nodeType: 'LLM Chat',
    category: 'model',
  })).items[0]!;
  assert.equal(item.error, '');
  assert.equal(item.preview, undefined);
});

test('projects only successful and passthrough tool results to their exact Delegate invocation', () => {
  const journal = createRunActivityJournal();
  const selectedRoot = root(newerActiveRootId, 1, 'completed');
  const source = invocation({
    key: 'tool-result-source',
    sequence: 1,
    graphId: 'main',
    graphRunId: 'main-run',
    nodeId: 'chat',
    processId: 'chat-process',
  });
  source.toolCallCount = 3;
  source.toolCalls = [
    {
      sequence: 2,
      toolCallId: 'successful-tool',
      toolName: 'searchKnowledge',
      sourceNodeId: source.nodeId,
      sourceProcessId: source.processId,
      handlerKind: 'graph',
      outcome: 'success',
      resultOwner: {
        nodeId: 'delegate' as NodeId,
        processId: 'delegate-success' as ProcessId,
        outputPortId: 'output' as PortId,
      },
    },
    {
      sequence: 3,
      toolCallId: 'passthrough-tool',
      toolName: 'fetchMetadata',
      sourceNodeId: source.nodeId,
      sourceProcessId: source.processId,
      handlerKind: 'external',
      outcome: 'passthrough-error',
      resultOwner: {
        nodeId: 'delegate' as NodeId,
        processId: 'delegate-passthrough' as ProcessId,
        outputPortId: 'output' as PortId,
      },
    },
    {
      sequence: 4,
      toolCallId: 'failed-tool',
      toolName: 'deleteAllKnowledge',
      sourceNodeId: source.nodeId,
      sourceProcessId: source.processId,
      handlerKind: 'graph',
      outcome: 'failure',
    },
  ];
  selectedRoot.nodeInvocationsByKey[source.key] = source;
  selectedRoot.nodeInvocationOrder = [source.key];
  journal.rootsById[selectedRoot.rootRunId] = selectedRoot;
  journal.latestCompletedRootRunId = selectedRoot.rootRunId;

  const viewModel = buildRunActivityViewModel(journal, () => ({
    nodeTitle: 'Answer user',
    nodeType: 'LLM Chat',
    category: 'model',
  }));

  const children = viewModel.items[0]?.children;
  assert.deepEqual(children?.[0]?.toolResultTarget, {
    rootRunId: source.rootRunId,
    graphRunId: source.graphRunId,
    graphId: source.graphId,
    nodeId: 'delegate',
    processId: 'delegate-success',
    outputPortId: 'output',
  });
  assert.deepEqual(children?.[1]?.toolResultTarget, {
    rootRunId: source.rootRunId,
    graphRunId: source.graphRunId,
    graphId: source.graphId,
    nodeId: 'delegate',
    processId: 'delegate-passthrough',
    outputPortId: 'output',
  });
  assert.equal(children?.[2]?.toolResultTarget, undefined);
});

test('describes a subgraph caller with resolved node and graph names', () => {
  const journal = createRunActivityJournal();
  const selectedRoot = root(newerActiveRootId, 1, 'completed');
  const childInvocation = invocation({
    key: 'tool-handler',
    sequence: 2,
    graphId: 'get-current-time',
    graphRunId: 'get-current-time-run',
    nodeId: 'graph-output',
    processId: 'graph-output-process',
  });
  selectedRoot.graphRunsById[childInvocation.graphRunId] = {
    sequence: 2,
    rootRunId: selectedRoot.rootRunId,
    graphRunId: childInvocation.graphRunId,
    graphId: childInvocation.graphId,
    graphName: 'Get current time',
    parentGraphRunId: 'main-run' as GraphRunId,
    executor: {
      nodeId: 'agent-delegate' as NodeId,
      parentGraphId: 'main' as GraphId,
      processId: 'delegate-process' as ProcessId,
    },
    status: 'completed',
  };
  selectedRoot.graphRunsById['main-run' as GraphRunId] = {
    sequence: 1,
    rootRunId: selectedRoot.rootRunId,
    graphRunId: 'main-run' as GraphRunId,
    graphId: 'main' as GraphId,
    graphName: 'LLM agent',
    status: 'completed',
  };
  selectedRoot.graphRunOrder = ['main-run' as GraphRunId, childInvocation.graphRunId];
  selectedRoot.nodeInvocationsByKey[childInvocation.key] = childInvocation;
  selectedRoot.nodeInvocationOrder = [childInvocation.key];
  journal.rootsById[selectedRoot.rootRunId] = selectedRoot;
  journal.latestCompletedRootRunId = selectedRoot.rootRunId;

  const viewModel = buildRunActivityViewModel(journal, () => ({
    subgraphCaller: {
      nodeTitle: 'Delegate Tool Call',
      graphName: 'LLM agent',
    },
  }));

  assert.deepEqual(
    viewModel.items[0]?.detailRows?.find((row) => row.label === 'Subgraph caller'),
    {
      label: 'Subgraph caller',
      value: '‘Delegate Tool Call’ node in ‘LLM agent’ graph',
    },
  );
});

test('does not present zero tool-call events as a problem for Tool or Delegate rows', () => {
  const journal = createRunActivityJournal();
  const selectedRoot = root(newerActiveRootId, 1, 'completed');
  const toolDefinition = invocation({
    key: 'tool-definition',
    sequence: 1,
    graphId: 'main',
    graphRunId: 'main-run',
    nodeId: 'tool',
    processId: 'tool-process',
  });
  const delegate = invocation({
    key: 'delegate-without-call',
    sequence: 2,
    graphId: 'main',
    graphRunId: 'main-run',
    nodeId: 'delegate',
    processId: 'delegate-process',
  });
  selectedRoot.nodeInvocationsByKey[toolDefinition.key] = toolDefinition;
  selectedRoot.nodeInvocationsByKey[delegate.key] = delegate;
  selectedRoot.nodeInvocationOrder = [toolDefinition.key, delegate.key];
  journal.rootsById[selectedRoot.rootRunId] = selectedRoot;
  journal.latestCompletedRootRunId = selectedRoot.rootRunId;

  const viewModel = buildRunActivityViewModel(journal, ({ invocation: current }) => ({
    nodeTitle: current.nodeId === toolDefinition.nodeId ? 'Search documentation' : 'Delegate Tool Call',
    category: 'tool',
  }));

  for (const item of viewModel.items) {
    assert.equal(item.toolCallCount, undefined);
    assert.equal(item.detailRows?.some((row) => row.label === 'Tool call details') ?? false, false);
  }
});

test('uses plain provider-request wording when a model row has no recorded request', () => {
  const journal = createRunActivityJournal();
  const selectedRoot = root(newerActiveRootId, 1, 'completed');
  const model = invocation({
    key: 'model-without-request',
    sequence: 1,
    graphId: 'main',
    graphRunId: 'main-run',
    nodeId: 'chat',
    processId: 'chat-process',
  });
  selectedRoot.nodeInvocationsByKey[model.key] = model;
  selectedRoot.nodeInvocationOrder = [model.key];
  journal.rootsById[selectedRoot.rootRunId] = selectedRoot;
  journal.latestCompletedRootRunId = selectedRoot.rootRunId;

  const viewModel = buildRunActivityViewModel(journal, () => ({ category: 'model' }));
  assert.deepEqual(viewModel.items[0]?.detailRows, [
    { label: 'Model call details', value: 'No provider request was recorded' },
  ]);
});

test('presents a compact Watch Streaming Output summary without recreating omitted iterations', () => {
  const journal = createRunActivityJournal();
  const selectedRoot = root(newerActiveRootId, 1, 'completed');
  const watch = invocation({
    key: 'streaming-watch-summary',
    sequence: 1,
    graphId: 'main',
    graphRunId: 'main-run',
    nodeId: 'watch',
    processId: 'streaming-watch-summary:watch',
  });
  watch.streamingOutputWatchSummary = {
    receivedUpdates: 6,
    coalescedUpdates: 1,
    droppedUpdates: 2,
    maximumQueuedUpdates: 3,
    completedIterations: 4,
    failedIterations: 0,
    cancelledIterations: 0,
    omittedIterations: 2,
    retainedIterationUpdateIndexes: [1, 2, 3, 6],
    selectedIteration: { updateIndex: 6, reason: 'latest' },
  };
  selectedRoot.nodeInvocationsByKey[watch.key] = watch;
  selectedRoot.nodeInvocationOrder = [watch.key];
  journal.rootsById[selectedRoot.rootRunId] = selectedRoot;
  journal.latestCompletedRootRunId = selectedRoot.rootRunId;

  const item = buildRunActivityViewModel(journal, () => ({
    nodeTitle: 'Watch response',
    nodeType: 'Watch Streaming Output',
  })).items[0]!;

  assert.deepEqual(item.detailRows, [
    { label: 'Streaming updates', value: '6 received · 1 coalesced · 2 dropped' },
    { label: 'Watch iterations', value: '4 completed · 0 failed · 0 cancelled · 2 omitted' },
    { label: 'Retained updates', value: '1, 2, 3, 6 · latest' },
  ]);
});

test('labels a coordinator-level Watch failure even when no child iteration failed', () => {
  const journal = createRunActivityJournal();
  const selectedRoot = root(newerActiveRootId, 1, 'error');
  const watch = invocation({
    key: 'streaming-watch-overflow',
    sequence: 1,
    graphId: 'main',
    graphRunId: 'main-run',
    nodeId: 'watch',
    processId: 'streaming-watch-summary:watch',
  });
  watch.status = 'error';
  watch.streamingOutputWatchSummary = {
    receivedUpdates: 3,
    coalescedUpdates: 0,
    droppedUpdates: 0,
    maximumQueuedUpdates: 1,
    failureKind: 'queue-overflow',
    completedIterations: 1,
    failedIterations: 0,
    cancelledIterations: 0,
    omittedIterations: 0,
    retainedIterationUpdateIndexes: [1],
    selectedIteration: { updateIndex: 1, reason: 'latest' },
  };
  selectedRoot.nodeInvocationsByKey[watch.key] = watch;
  selectedRoot.nodeInvocationOrder = [watch.key];
  journal.rootsById[selectedRoot.rootRunId] = selectedRoot;
  journal.latestCompletedRootRunId = selectedRoot.rootRunId;

  const item = buildRunActivityViewModel(journal, () => ({
    nodeTitle: 'Watch response',
    nodeType: 'Watch Streaming Output',
  })).items[0]!;

  assert.equal(item.status, 'error');
  assert.ok(item.detailRows?.some((row) => row.label === 'Watch failure' && row.value === 'Queue overflow'));
});

test('keeps historical missing-Stop Watch summaries visible as their recorded failure', () => {
  const journal = createRunActivityJournal();
  const selectedRoot = root(newerActiveRootId, 1, 'error');
  const watch = invocation({
    key: 'historical-missing-stop',
    sequence: 1,
    graphId: 'main',
    graphRunId: 'main-run',
    nodeId: 'watch',
    processId: 'streaming-watch-summary:watch',
  });
  watch.status = 'error';
  watch.streamingOutputWatchSummary = {
    receivedUpdates: 2,
    coalescedUpdates: 0,
    droppedUpdates: 0,
    maximumQueuedUpdates: 1,
    failureKind: 'missing-stop',
    completedIterations: 2,
    failedIterations: 0,
    cancelledIterations: 0,
    omittedIterations: 0,
    retainedIterationUpdateIndexes: [1, 2],
    selectedIteration: { updateIndex: 2, reason: 'latest' },
  };
  selectedRoot.nodeInvocationsByKey[watch.key] = watch;
  selectedRoot.nodeInvocationOrder = [watch.key];
  journal.rootsById[selectedRoot.rootRunId] = selectedRoot;
  journal.latestCompletedRootRunId = selectedRoot.rootRunId;

  const item = buildRunActivityViewModel(journal, () => ({
    nodeTitle: 'Watch response',
    nodeType: 'Watch Streaming Output',
  })).items[0]!;

  assert.equal(item.status, 'error');
  assert.ok(item.detailRows?.some((row) => row.label === 'Watch failure' && row.value === 'No Stop value accepted'));
});

test('empty journal discloses ignored legacy events without inventing a run', () => {
  const journal = createRunActivityJournal();
  journal.ignoredLegacyEventCount = 4;
  const viewModel = buildRunActivityViewModel(journal, () => {
    throw new Error('resolver must not run without a selected root');
  });
  assert.equal(viewModel.status, 'idle');
  assert.deepEqual(viewModel.items, []);
  assert.match(viewModel.partialReason ?? '', /4 legacy execution events/);
});

test('preserves the captured node title when the current graph title is blank', () => {
  const journal = createRunActivityJournal();
  const selectedRoot = root(newerActiveRootId, 1, 'completed');
  const capturedInvocation = invocation({
    key: 'captured-title',
    sequence: 1,
    graphId: 'main',
    graphRunId: 'main-run',
    nodeId: 'text',
    processId: 'text-process',
  });
  capturedInvocation.nodeTitle = 'Captured Text Title';
  selectedRoot.nodeInvocationsByKey[capturedInvocation.key] = capturedInvocation;
  selectedRoot.nodeInvocationOrder = [capturedInvocation.key];
  journal.rootsById[selectedRoot.rootRunId] = selectedRoot;
  journal.latestCompletedRootRunId = selectedRoot.rootRunId;

  const viewModel = buildRunActivityViewModel(journal, () => ({ nodeTitle: '   ' }));
  assert.equal(viewModel.items[0]?.nodeTitle, 'Captured Text Title');
});

test('Decision AI activity titles alias legacy defaults without changing recorded titles or custom names', () => {
  const journal = createRunActivityJournal();
  const selectedRoot = root(newerActiveRootId, 1, 'completed');
  const captured = invocation({
    key: 'decision',
    sequence: 1,
    graphId: 'main',
    graphRunId: 'main-run',
    nodeId: 'evaluate',
    processId: 'run',
  });
  selectedRoot.nodeInvocationsByKey[captured.key] = captured;
  selectedRoot.nodeInvocationOrder = [captured.key];
  journal.rootsById[selectedRoot.rootRunId] = selectedRoot;
  journal.latestCompletedRootRunId = selectedRoot.rootRunId;
  for (const [nodeType, nodeTitle, expected] of [
    ['classifierEvaluate', 'Classifier Evaluate', 'Decision AI run'],
    ['classifierQuestion', 'Classifier Question', 'Decision AI Question'],
    ['classifierProfile', 'Classifier Profile', 'Decision AI Profile'],
    ['classifierEvaluate', 'My Classifier route', 'My Classifier route'],
    ['classifierEvaluate', ' Classifier Evaluate ', 'Classifier Evaluate'],
    ['text', 'Classifier Evaluate', 'Classifier Evaluate'],
  ] as const) {
    captured.nodeType = nodeType;
    captured.nodeTitle = nodeTitle;
    const before = structuredClone(journal);
    for (const resolved of [undefined, { nodeType, nodeTitle }]) {
      const model = buildRunActivityViewModel(journal, () => resolved);
      assert.equal(model.items[0]?.nodeTitle, expected);
      assert.equal(filterRunActivityItems(model.items, { filter: 'all', graphId: '', query: expected }).length, 1);
    }
    assert.deepEqual(journal, before);
  }
});

test('searches every displayed model attempt and tool call instead of only row summaries', () => {
  const journal = createRunActivityJournal();
  const selectedRoot = root(newerActiveRootId, 1, 'completed');
  const capturedInvocation = invocation({
    key: 'multi-call-search',
    sequence: 1,
    graphId: 'main',
    graphRunId: 'main-run',
    nodeId: 'chat',
    processId: 'chat-process',
  });
  capturedInvocation.modelCallCount = 2;
  capturedInvocation.modelCalls = [
    {
      sequence: 2,
      callId: 'failed-profile',
      nodeId: capturedInvocation.nodeId,
      processId: capturedInvocation.processId,
      provider: 'custom',
      model: 'failed-profile-model',
      customProviderApi: 'responses',
      outcome: 'provider-failure',
      attemptIndex: 0,
      profileIndex: 0,
      pricing: { status: 'unknown' },
    },
    {
      sequence: 3,
      callId: 'successful-profile',
      nodeId: capturedInvocation.nodeId,
      processId: capturedInvocation.processId,
      provider: 'anthropic',
      model: 'effective-model',
      outcome: 'success',
      attemptIndex: 0,
      profileIndex: 1,
      pricing: { status: 'unknown' },
    },
  ];
  capturedInvocation.toolCallCount = 2;
  capturedInvocation.toolCalls = [
    {
      sequence: 4,
      toolCallId: 'first-tool',
      toolName: 'searchKnowledge',
      sourceNodeId: capturedInvocation.nodeId,
      sourceProcessId: capturedInvocation.processId,
      handlerKind: 'graph',
      outcome: 'success',
    },
    {
      sequence: 5,
      toolCallId: 'second-tool',
      toolName: 'loadFullDocument',
      sourceNodeId: capturedInvocation.nodeId,
      sourceProcessId: capturedInvocation.processId,
      handlerKind: 'graph',
      outcome: 'success',
    },
  ];
  selectedRoot.nodeInvocationsByKey[capturedInvocation.key] = capturedInvocation;
  selectedRoot.nodeInvocationOrder = [capturedInvocation.key];
  journal.rootsById[selectedRoot.rootRunId] = selectedRoot;
  journal.latestCompletedRootRunId = selectedRoot.rootRunId;

  const viewModel = buildRunActivityViewModel(journal, () => ({
    nodeTitle: 'Answer user',
    searchTerms: ['designer alias'],
  }));
  const item = viewModel.items[0]!;

  assert.equal(item.children?.[0]?.label, 'Custom Responses / failed-profile-model');
  assert.deepEqual(item.searchTerms, [
    'designer alias',
    'Custom Responses',
    'failed-profile-model',
    'anthropic',
    'effective-model',
    'searchKnowledge',
    'loadFullDocument',
  ]);
  assert.deepEqual(
    filterRunActivityItems(viewModel.items, { filter: 'all', graphId: '', query: 'failed-profile-model' }).map(
      (entry) => entry.activityKey,
    ),
    [capturedInvocation.key],
  );
  assert.deepEqual(
    filterRunActivityItems(viewModel.items, { filter: 'all', graphId: '', query: 'Custom Responses' }).map(
      (entry) => entry.activityKey,
    ),
    [capturedInvocation.key],
  );
  assert.deepEqual(
    filterRunActivityItems(viewModel.items, { filter: 'all', graphId: '', query: 'loadFullDocument' }).map(
      (entry) => entry.activityKey,
    ),
    [capturedInvocation.key],
  );
});

test('renders suspension skips, reliability-service decisions, timeouts, and omitted profile attempts', () => {
  const journal = createRunActivityJournal();
  const selectedRoot = root(newerActiveRootId, 1, 'completed');
  const capturedInvocation = invocation({
    key: 'profile-health',
    sequence: 1,
    graphId: 'main',
    graphRunId: 'main-run',
    nodeId: 'chat',
    processId: 'chat-process',
  });
  capturedInvocation.profileAttempts = [
    {
      sequence: 2,
      eventId: 'open-gate',
      roundIndex: 0,
      profileIndex: 0,
      nodeId: capturedInvocation.nodeId,
      processId: capturedInvocation.processId,
      provider: 'custom',
      model: 'fast-but-unhealthy',
      customProviderApi: 'responses',
      stage: 'health-gate',
      outcome: 'skipped',
      healthState: 'open',
      healthDisposition: 'deny',
      retryAt: 2_000,
    },
    {
      sequence: 3,
      eventId: 'store-fail-open',
      roundIndex: 0,
      profileIndex: 1,
      nodeId: capturedInvocation.nodeId,
      processId: capturedInvocation.processId,
      provider: 'anthropic',
      model: 'backup',
      stage: 'health-gate',
      outcome: 'failure',
      healthDisposition: 'fail-open',
      error: 'Health store unavailable',
    },
    {
      sequence: 4,
      eventId: 'first-output-timeout',
      roundIndex: 0,
      profileIndex: 1,
      nodeId: capturedInvocation.nodeId,
      processId: capturedInvocation.processId,
      provider: 'anthropic',
      model: 'backup',
      stage: 'request',
      outcome: 'failure',
      timeoutKind: 'first-output',
    },
  ];
  capturedInvocation.omittedProfileAttemptCount = 2;
  selectedRoot.nodeInvocationsByKey[capturedInvocation.key] = capturedInvocation;
  selectedRoot.nodeInvocationOrder = [capturedInvocation.key];
  journal.rootsById[selectedRoot.rootRunId] = selectedRoot;
  journal.latestCompletedRootRunId = selectedRoot.rootRunId;

  const viewModel = buildRunActivityViewModel(journal, () => ({ nodeTitle: 'Answer user' }));
  const item = viewModel.items[0]!;

  assert.equal(item.category, 'model');
  assert.equal(item.children?.[0]?.status, 'not-ran');
  assert.match(
    item.children?.[0]?.secondaryText ?? '',
    /^reliability check \/ profile suspended until .+ \/ profile 1 \/ round 1$/,
  );
  assert.deepEqual(
    item.children?.slice(1).map((child) => [child.status, child.secondaryText]),
    [
      [
        'error',
        'reliability check / reliability service unavailable; profile request continued / profile 2 / round 1: Health store unavailable',
      ],
      ['error', 'request / first output timed out / profile 2 / round 1'],
    ],
  );
  assert.equal(item.hasErrors, true);
  assert.deepEqual(
    item.detailRows?.find((row) => row.label === 'Profile attempt rows omitted'),
    {
      label: 'Profile attempt rows omitted',
      value: '2',
    },
  );
  assert.ok(item.searchTerms?.includes('first-output'));
  assert.ok(item.searchTerms?.includes('fail-open'));
});

test('Run Activity retains timeout explanations for LLM and classifier attempts', () => {
  for (const timeoutKind of ['first-output', 'stream-inactivity', 'response'] as const) {
    const journal = createRunActivityJournal();
    const selectedRoot = root(newerActiveRootId, 1, 'error');
    const capturedInvocation = invocation({
      key: 'timeout',
      sequence: 1,
      graphId: 'graph',
      graphRunId: 'run',
      nodeId: 'evaluate',
      processId: 'process',
    });
    capturedInvocation.profileAttempts = [
      {
        sequence: 2,
        eventId: 'timeout',
        roundIndex: 0,
        profileIndex: 0,
        nodeId: capturedInvocation.nodeId,
        processId: capturedInvocation.processId,
        ...(timeoutKind === 'response' ? { family: 'classifier' as const } : {}),
        provider: timeoutKind === 'response' ? 'perplexity' : 'openai',
        model: 'model',
        stage: 'request',
        outcome: 'failure',
        timeoutKind,
        error: 'Provider request timed out after 500 ms.',
      },
    ];
    selectedRoot.nodeInvocationsByKey[capturedInvocation.key] = capturedInvocation;
    selectedRoot.nodeInvocationOrder = [capturedInvocation.key];
    journal.rootsById[selectedRoot.rootRunId] = selectedRoot;
    journal.latestCompletedRootRunId = selectedRoot.rootRunId;
    const item = buildRunActivityViewModel(journal, () => ({ nodeTitle: 'Evaluate' })).items[0]!;
    assert.match(item.children?.[0]?.secondaryText ?? '', /Provider request timed out after 500 ms/);
    assert.equal(item.children?.[0]?.status, 'error');
  }
});

test('keeps older Run Activity journals without profile-attempt fields readable', () => {
  const journal = createRunActivityJournal();
  const selectedRoot = root(newerActiveRootId, 1, 'completed');
  const legacyInvocation = invocation({
    key: 'legacy-without-profile-attempts',
    sequence: 1,
    graphId: 'main',
    graphRunId: 'main-run',
    nodeId: 'text',
    processId: 'text-process',
  });
  selectedRoot.nodeInvocationsByKey[legacyInvocation.key] = legacyInvocation;
  selectedRoot.nodeInvocationOrder = [legacyInvocation.key];
  journal.rootsById[selectedRoot.rootRunId] = selectedRoot;
  journal.latestCompletedRootRunId = selectedRoot.rootRunId;

  const item = buildRunActivityViewModel(journal, () => ({ nodeTitle: 'Legacy node' })).items[0]!;
  assert.equal(item.children, undefined);
  assert.equal(item.detailRows, undefined);
});

test('projects a recorded replay duration instead of its near-instant delivery duration', () => {
  const journal = createRunActivityJournal();
  const selectedRoot = root(newerActiveRootId, 1, 'completed');
  selectedRoot.startedAt = 1_000_000;
  selectedRoot.finishedAt = 1_000_013;
  selectedRoot.recordedTiming = {
    startedAt: 10_000,
    latestAt: 28_490,
    finishedAt: 28_490,
  };
  journal.rootsById[selectedRoot.rootRunId] = selectedRoot;
  journal.latestCompletedRootRunId = selectedRoot.rootRunId;

  const viewModel = buildRunActivityViewModel(journal, () => undefined, { now: 9_999_999 });
  assert.equal(viewModel.durationMs, 18_490);
  assert.equal(viewModel.startedAt, 10_000);
});

test('does not fall back to local replay timestamps for a truncated historical root', () => {
  const journal = createRunActivityJournal();
  const selectedRoot = root(newerActiveRootId, 1, 'completed');
  selectedRoot.startedAt = 1_000_000;
  selectedRoot.finishedAt = 1_000_001;
  selectedRoot.graphOutputsReadyAt = 1_000_000;
  selectedRoot.recordedTiming = {
    latestAt: 28_490,
    finishedAt: 28_490,
  };
  journal.rootsById[selectedRoot.rootRunId] = selectedRoot;
  journal.latestCompletedRootRunId = selectedRoot.rootRunId;

  const viewModel = buildRunActivityViewModel(journal, () => undefined, { now: 9_999_999 });
  assert.equal(viewModel.durationMs, undefined);
  assert.equal(viewModel.durationUnavailable, true);
  assert.equal(viewModel.startedAt, undefined);
  assert.equal(viewModel.outputsReadyAt, undefined);
});

test('discloses an unavailable duration for a terminally incomplete invocation', () => {
  const journal = createRunActivityJournal();
  const selectedRoot = root(newerActiveRootId, 1, 'aborted');
  const incompleteInvocation = invocation({
    key: 'incomplete',
    sequence: 1,
    graphId: 'main',
    graphRunId: 'main-run',
    nodeId: 'text',
    processId: 'text-process',
  });
  incompleteInvocation.status = 'aborted';
  incompleteInvocation.durationMs = undefined;
  incompleteInvocation.terminalEventMissing = true;
  selectedRoot.nodeInvocationsByKey[incompleteInvocation.key] = incompleteInvocation;
  selectedRoot.nodeInvocationOrder = [incompleteInvocation.key];
  journal.rootsById[selectedRoot.rootRunId] = selectedRoot;
  journal.latestCompletedRootRunId = selectedRoot.rootRunId;

  const item = buildRunActivityViewModel(journal, () => ({ nodeTitle: 'Interrupted node' })).items[0]!;
  assert.equal(item.durationMs, undefined);
  assert.equal(item.durationUnavailable, true);
  assert.deepEqual(
    item.detailRows?.find((row) => row.label === 'Execution record'),
    {
      label: 'Execution record',
      value: 'Terminal event unavailable',
    },
  );
});

test('uses a replayed node start rather than the local playback receipt time', () => {
  const journal = createRunActivityJournal();
  const selectedRoot = root(newerActiveRootId, 1, 'completed');
  const replayedInvocation = invocation({
    key: 'replayed',
    sequence: 1,
    graphId: 'main',
    graphRunId: 'main-run',
    nodeId: 'text',
    processId: 'text-process',
  });
  replayedInvocation.startedAt = 1_000_001;
  replayedInvocation.recordedTiming = { startedAt: 10_200, finishedAt: 28_200 };
  selectedRoot.nodeInvocationsByKey[replayedInvocation.key] = replayedInvocation;
  selectedRoot.nodeInvocationOrder = [replayedInvocation.key];
  journal.rootsById[selectedRoot.rootRunId] = selectedRoot;
  journal.latestCompletedRootRunId = selectedRoot.rootRunId;

  const item = buildRunActivityViewModel(journal, () => undefined).items[0]!;
  assert.equal(item.startedAt, 10_200);
});

test('classifier activity includes winning routing, failed usage, physical requests and searchable profile names', () => {
  const journal = createRunActivityJournal();
  const selectedRoot = root(newerActiveRootId, 1, 'completed');
  const classifier = invocation({
    key: 'classifier',
    sequence: 1,
    graphId: 'main',
    graphRunId: 'main-run',
    nodeId: 'evaluate',
    processId: 'classify',
  });
  classifier.nodeType = 'classifierEvaluate';
  classifier.status = 'completed';
  const base = {
    nodeId: classifier.nodeId,
    processId: classifier.processId,
    roundIndex: 0,
    family: 'classifier' as const,
    provider: 'perplexity',
    model: 'decider',
    stage: 'request' as const,
  };
  classifier.profileAttempts = [
    {
      ...base,
      eventId: 'bad',
      sequence: 2,
      profileIndex: 0,
      profileName: 'First classifier',
      attemptIndex: 0,
      outcome: 'failure',
      failureKind: 'response-validation',
      status: 200,
      classifierUsage: { inputTokens: 1000, outputTokens: 0, estimatedCostUsd: 0.00004 },
    },
    {
      ...base,
      eventId: 'winner',
      sequence: 3,
      profileIndex: 1,
      profileName: 'Fast backup',
      attemptIndex: 0,
      provider: 'liquid',
      model: 'd1',
      outcome: 'success',
      status: 200,
      classifierUsage: { inputTokens: 50, outputTokens: 5, estimatedCostUsd: 0.00002 },
    },
    { ...base, eventId: 'health', sequence: 4, profileIndex: 1, stage: 'health-update', outcome: 'success' },
    {
      ...base,
      eventId: 'unused',
      sequence: 5,
      profileIndex: 2,
      stage: 'configuration',
      outcome: 'skipped',
      skipReason: 'unreached',
    },
  ];
  selectedRoot.nodeInvocationsByKey[classifier.key] = classifier;
  selectedRoot.nodeInvocationOrder = [classifier.key];
  journal.rootsById[selectedRoot.rootRunId] = selectedRoot;
  journal.latestCompletedRootRunId = selectedRoot.rootRunId;
  const model = buildRunActivityViewModel(journal, () => ({ inspectable: true }));
  const item = model.items[0]!;
  assert.equal(item.category, 'model');
  assert.equal(item.provider, 'liquid');
  assert.equal(item.model, 'd1');
  assert.equal(item.classifierRequestCount, 2);
  assert.equal(item.modelCallCount, undefined);
  assert.equal(item.hasErrors, true);
  assert.equal(item.inspectable, true);
  assert.equal(item.detailRows?.some((row) => row.value === 'No provider request was recorded') ?? false, false);
  assert.match(item.children![0]!.secondaryText!, /HTTP 200/);
  assert.match(item.children![0]!.secondaryText!, /1000 input \/ 0 output tokens/);
  assert.equal(
    item.children!.some((row) => row.secondaryText?.includes('round')),
    false,
  );
  assert.equal(
    filterRunActivityItems(model.items, { filter: 'llm-tools', graphId: '', query: 'Fast backup' }).length,
    1,
  );
  assert.equal(filterRunActivityItems(model.items, { filter: 'errors', graphId: '', query: '' }).length, 1);
  assert.equal(model.accounting?.classifierRequestCount, 2);
  assert.equal(model.accounting?.promptTokens, 1050);
  assert.equal(model.accounting?.completionTokens, 5);
  assert.equal(model.accounting?.knownCostUsd, 0.00004 + 0.00002);
  assert.equal(model.accounting?.costStatus, 'known');
  const retainedAttempt = classifier.profileAttempts[0]!;
  for (const name of ['Classifier Profile', 'My Classifier route', ' Classifier Profile ']) {
    retainedAttempt.profileName = name;
    const renamed = buildRunActivityViewModel(journal, () => ({ inspectable: true }));
    const displayed = name === 'Classifier Profile' ? 'Decision AI Profile' : name.trim();
    assert.ok(renamed.items[0]!.children![0]!.label.startsWith(`Profile: ${displayed} · `));
    assert.equal(filterRunActivityItems(renamed.items, { filter: 'all', graphId: '', query: displayed }).length, 1);
    assert.equal(retainedAttempt.profileName, name, 'Presentation/search must not mutate the journal');
  }
  retainedAttempt.profileName = 'First classifier';
  selectedRoot.omittedNodeInvocationCount = 1;
  const cappedRoot = buildRunActivityViewModel(journal, () => undefined).accounting!;
  assert.equal(cappedRoot.incomplete, true);
  assert.equal(cappedRoot.costStatus, 'partial');
  assert.equal(cappedRoot.classifierRequestCount, 2);
  assert.equal(cappedRoot.knownCostUsd, model.accounting?.knownCostUsd);
  selectedRoot.omittedNodeInvocationCount = 0;
  classifier.profileAttempts[1]!.classifierUsage = undefined;
  assert.equal(buildRunActivityViewModel(journal, () => undefined).accounting?.costStatus, 'partial');
  classifier.omittedProfileAttemptCount = 1;
  assert.equal(buildRunActivityViewModel(journal, () => undefined).accounting?.incomplete, true);
  classifier.profileAttempts = [];
  const omitted = buildRunActivityViewModel(journal, () => undefined).accounting!;
  assert.equal(omitted.incomplete, true);
  assert.equal(omitted.costStatus, 'unknown');
});

test('omitted whole invocations never imply complete accounting even without retained calls', () => {
  const journal = createRunActivityJournal();
  const selectedRoot = root(newerActiveRootId, 1, 'completed');
  selectedRoot.omittedNodeInvocationCount = 1;
  journal.rootsById[selectedRoot.rootRunId] = selectedRoot;
  journal.latestCompletedRootRunId = selectedRoot.rootRunId;
  const accounting = buildRunActivityViewModel(journal, () => undefined).accounting!;
  assert.equal(accounting.incomplete, true);
  assert.equal(accounting.costStatus, 'unknown');
  assert.equal(accounting.knownCostUsd, 0);
  assert.equal(accounting.modelCallCount, 0);
});

function root(rootRunId: RootRunId, sequence: number, status: RunActivityRoot['status']): RunActivityRoot {
  return {
    sequence,
    rootRunId,
    status,
    paused: false,
    isPartial: false,
    graphRunsById: {},
    graphRunOrder: [],
    nodeInvocationsByKey: {},
    nodeInvocationOrder: [],
    omittedNodeInvocationCount: 0,
    omittedLegacyEventCount: 0,
  };
}

function invocation(options: {
  key: string;
  sequence: number;
  graphId: string;
  graphRunId: string;
  nodeId: string;
  processId: string;
}): RunActivityNodeInvocation {
  return {
    key: options.key as RunActivityNodeInvocation['key'],
    sequence: options.sequence,
    rootRunId: newerActiveRootId,
    graphId: options.graphId as GraphId,
    graphRunId: options.graphRunId as GraphRunId,
    nodeId: options.nodeId as NodeId,
    processId: options.processId as ProcessId,
    status: 'completed',
    resultOrigin: 'executed',
    startedAt: 1_100,
    finishedAt: 1_200,
    durationMs: 100,
    inputPortIds: [],
    outputPortIds: [],
    splitOutputPortIds: {},
    splitOutputIndices: [],
    partialOutputCount: 0,
    outputRevision: 1,
    outputsAvailable: true,
    modelCalls: [],
    toolCalls: [],
    modelCallCount: 0,
    toolCallCount: 0,
    omittedModelCallCount: 0,
    omittedToolCallCount: 0,
  };
}
