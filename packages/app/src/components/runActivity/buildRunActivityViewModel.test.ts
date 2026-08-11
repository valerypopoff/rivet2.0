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

test('renders circuit skips, fail-open decisions, timeouts, and omitted profile attempts', () => {
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
  assert.match(item.children?.[0]?.secondaryText ?? '', /^skipped until .+ \/ profile 1 \/ round 1$/);
  assert.deepEqual(
    item.children?.slice(1).map((child) => [child.status, child.secondaryText]),
    [
      ['error', 'health store failed open: Health store unavailable / profile 2 / round 1'],
      ['error', 'first output timed out / profile 2 / round 1'],
    ],
  );
  assert.equal(item.hasErrors, true);
  assert.deepEqual(
    item.detailRows?.find((row) => row.label === 'LLM profile attempt rows omitted'),
    {
      label: 'LLM profile attempt rows omitted',
      value: '2',
    },
  );
  assert.ok(item.searchTerms?.includes('first-output'));
  assert.ok(item.searchTerms?.includes('fail-open'));
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
