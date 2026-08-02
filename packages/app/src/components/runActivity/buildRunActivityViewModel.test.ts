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

test('projects stable exact invocation rows, bounded stored previews, children, filters, and provenance', () => {
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
          contextInputPortIds: ['prompt' as PortId],
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
  assert.deepEqual(
    modelItem.detailRows?.find((row) => row.label === 'Input: prompt'),
    { label: 'Input: prompt', value: 'Compact prompt context' },
  );
  assert.equal(
    modelItem.detailRows?.some((row) => row.label === 'Result origin'),
    false,
  );
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
