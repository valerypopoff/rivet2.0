import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GraphProcessor,
  createBuiltInRegistry,
  resolveProcessSettings,
  type ChartNode,
  type DataValue,
  type GraphId,
  type GraphRunId,
  type NodeConnection,
  type NodeId,
  type PortId,
  type ProcessEventMessageMap,
  type ProcessId,
  type Project,
  type ProjectId,
} from '@valerypopoff/rivet2-core';
import {
  createRootGraphViewContext,
  createSubgraphGraphViewContext,
} from '../domain/graphEditing/navigationActions.js';
import type { DataRefStore } from '../providers/ProvidersContext.js';
import type { ProjectExecutionSnapshot } from '../state/dataFlow.js';
import {
  getGraphSelectionOptions,
  getSelectedGraphRunId,
  getSelectedProcessData,
  getSubgraphCallerRunSelection,
  shouldFollowLatestNodeProcess,
} from '../state/selectors/executionSelectors.js';
import { canFreezeNodeOutputs } from '../utils/frozenNodeOutputs.js';
import { applyProcessEventToProjectExecutionSnapshot } from './projectExecutionSnapshotEvents.js';

const mainId = 'navigation-main' as GraphId;
const childId = 'navigation-child' as GraphId;
const leafId = 'navigation-leaf' as GraphId;
const projectId = 'navigation-project' as ProjectId;

function node(type: string, id: string, data: Record<string, unknown>): ChartNode {
  return { type, id: id as NodeId, title: id, data, visualData: { x: 0, y: 0, width: 240 } };
}

function connect(outputNodeId: string, outputId: string, inputNodeId: string, inputId: string): NodeConnection {
  return {
    outputNodeId: outputNodeId as NodeId,
    outputId: outputId as PortId,
    inputNodeId: inputNodeId as NodeId,
    inputId: inputId as PortId,
  };
}

type CapturedEvent = {
  message: keyof ProcessEventMessageMap;
  data: ProcessEventMessageMap[keyof ProcessEventMessageMap];
};

async function recordFixture() {
  const project: Project = {
    metadata: { id: projectId, title: 'Navigation', description: '', mainGraphId: mainId },
    graphs: {
      [mainId]: {
        metadata: { id: mainId, name: 'Main' },
        nodes: [
          node('subGraph', 'pruned', { graphId: childId, skipUnusedOutputs: true }),
          node('subGraph', 'full', { graphId: childId }),
          node('subGraph', 'skipped', { graphId: childId, skipUnusedOutputs: true }),
          node('graphOutput', 'result', { id: 'result', dataType: 'string' }),
        ],
        connections: [
          // Force the full invocation to start after the pruned invocation.
          connect('pruned', 'wanted', 'full', 'gate'),
          connect('full', 'wanted', 'result', 'value'),
        ],
      },
      [childId]: {
        metadata: { id: childId, name: 'Child' },
        nodes: [
          node('graphInput', 'gate', { id: 'gate', dataType: 'any' }),
          node('text', 'wanted', { text: 'wanted result' }),
          node('text', 'unused', { text: 'unused result' }),
          node('graphOutput', 'wanted-output', { id: 'wanted', dataType: 'string' }),
          node('graphOutput', 'unused-output', { id: 'unused', dataType: 'string' }),
          node('subGraph', 'nested', { graphId: leafId }),
          node('graphOutput', 'nested-output', { id: 'nested', dataType: 'string' }),
        ],
        connections: [
          connect('wanted', 'output', 'wanted-output', 'value'),
          connect('unused', 'output', 'unused-output', 'value'),
          connect('nested', 'value', 'nested-output', 'value'),
        ],
      },
      [leafId]: {
        metadata: { id: leafId, name: 'Leaf' },
        nodes: [
          node('text', 'leaf-source', { text: 'leaf result' }),
          node('graphOutput', 'leaf-output', { id: 'value', dataType: 'string' }),
        ],
        connections: [connect('leaf-source', 'output', 'leaf-output', 'value')],
      },
    },
    plugins: [],
  };
  const events: CapturedEvent[] = [];
  const processor = new GraphProcessor(project, mainId, createBuiltInRegistry());
  const messages = ['start', 'graphStart', 'nodeStart', 'nodeFinish', 'nodeExcluded', 'graphFinish', 'done'] as const;
  for (const message of messages) {
    processor.on(message, (data) => {
      events.push({ message, data });
    });
  }
  await processor.processGraph({
    settings: resolveProcessSettings(),
    tokenizer: {
      on: () => undefined,
      getTokenCountForString: async () => {
        throw new Error('This fixture must not tokenize model requests');
      },
      getTokenCountForMessages: async () => {
        throw new Error('This fixture must not tokenize model requests');
      },
    },
  });
  return events;
}

function projection() {
  const values = new Map<string, DataValue>();
  const refStore: DataRefStore = {
    get: (key) => values.get(key),
    set: (key, value) => {
      values.set(key, value);
    },
    delete: (key) => {
      values.delete(key);
    },
  };
  let snapshot: ProjectExecutionSnapshot | undefined;
  return {
    apply(event: CapturedEvent) {
      snapshot = applyProcessEventToProjectExecutionSnapshot({ ...event, projectId, refStore, snapshot }).snapshot;
    },
    followCaller(callerId: string) {
      assert.ok(snapshot);
      const parentSelection = getGraphSelectionOptions({
        ...snapshot,
        currentGraphView: createRootGraphViewContext(mainId),
      });
      const selection = getSubgraphCallerRunSelection(
        callerId as NodeId,
        snapshot.lastRunDataByNode[callerId as NodeId],
        'latest',
        parentSelection,
      );
      assert.ok(selection);
      const view = createSubgraphGraphViewContext({
        graphId: childId,
        parentGraphId: mainId,
        parentNodeId: callerId as NodeId,
      });
      snapshot = { ...snapshot, selectedGraphRunByView: { ...snapshot.selectedGraphRunByView, [view.key]: selection } };
      return view;
    },
    get snapshot() {
      assert.ok(snapshot);
      return snapshot;
    },
  };
}

test('following a pruned caller uses its real child invocation without hiding broader history', async () => {
  const state = projection();
  (await recordFixture()).forEach(state.apply);
  const view = state.followCaller('pruned');
  const selection = getGraphSelectionOptions({ ...state.snapshot, currentGraphView: view });
  const { graphRuns } = selection;
  assert.deepEqual(
    graphRuns?.map((run) => run.executor?.nodeId),
    ['pruned', 'full'],
  );
  assert.equal(getSelectedGraphRunId(graphRuns, selection.selectedGraphRun), graphRuns![0]!.graphRunId);
  assert.equal(shouldFollowLatestNodeProcess(selection.selectedGraphRun, graphRuns![0]), true);
  assert.equal(shouldFollowLatestNodeProcess(selection.selectedGraphRun, graphRuns![1]), false);
  assert.equal(shouldFollowLatestNodeProcess(graphRuns![0]!.graphRunId, graphRuns![0]), false);
  assert.equal(
    getSelectedProcessData(state.snapshot.lastRunDataByNode['unused' as NodeId], 'latest', selection),
    undefined,
  );
  assert.equal(
    canFreezeNodeOutputs({
      graphId: childId,
      processData: state.snapshot.lastRunDataByNode['unused' as NodeId],
      selection,
    }),
    false,
  );
  assert.ok(getSelectedProcessData(state.snapshot.lastRunDataByNode['wanted' as NodeId], 'latest', selection));
  assert.ok(
    getSelectedProcessData(state.snapshot.lastRunDataByNode['unused' as NodeId], 'latest', {
      ...selection,
      selectedGraphRun: 'latest',
    }),
    'explicit broader history navigation remains available',
  );
});

test("a caller with no demanded outputs has no current child execution, not another caller's results", async () => {
  const state = projection();
  (await recordFixture()).forEach(state.apply);
  const view = state.followCaller('skipped');
  const selection = getGraphSelectionOptions({ ...state.snapshot, currentGraphView: view });
  assert.equal(selection.graphRuns?.length, 2);
  assert.equal(getSelectedGraphRunId(selection.graphRuns, selection.selectedGraphRun), undefined);
  assert.equal(
    getSelectedProcessData(state.snapshot.lastRunDataByNode['wanted' as NodeId], 'latest', selection),
    undefined,
  );
  assert.equal(
    getSelectedProcessData(state.snapshot.lastRunDataByNode['unused' as NodeId], 'latest', selection),
    undefined,
  );
  assert.ok(
    getSelectedProcessData(state.snapshot.lastRunDataByNode['unused' as NodeId], 'latest', {
      ...selection,
      selectedGraphRun: selection.graphRuns![1]!.graphRunId,
    }),
    'an explicit historical choice works from a no-run view',
  );
});

test('a caller scope follows a later real child start without being overwritten by graphStart defaults', async () => {
  const events = await recordFixture();
  const childStart = events.findIndex(
    (event) =>
      event.message === 'graphStart' &&
      (event.data as ProcessEventMessageMap['graphStart']).execution?.executor?.nodeId === 'pruned',
  );
  assert.ok(childStart > 0);
  const state = projection();
  events.slice(0, childStart).forEach(state.apply);
  const view = state.followCaller('pruned');
  const before = getGraphSelectionOptions({ ...state.snapshot, currentGraphView: view });
  assert.equal(getSelectedGraphRunId(before.graphRuns, before.selectedGraphRun), undefined);
  events.slice(childStart).forEach(state.apply);
  const after = getGraphSelectionOptions({ ...state.snapshot, currentGraphView: view });
  assert.deepEqual(after.selectedGraphRun, before.selectedGraphRun);
  assert.equal(getSelectedGraphRunId(after.graphRuns, after.selectedGraphRun), after.graphRuns![0]!.graphRunId);
  assert.equal(
    getSelectedProcessData(state.snapshot.lastRunDataByNode['unused' as NodeId], 'latest', after),
    undefined,
  );
});

test('caller navigation respects the parent node process page and preserves legacy unscoped navigation', () => {
  const parentGraphRunId = 'parent-run' as GraphRunId;
  const processes = ['first', 'second'].map((id) => ({
    processId: id as ProcessId,
    graphRunId: parentGraphRunId,
    data: {},
  }));
  const callerId = 'caller' as NodeId;
  assert.deepEqual(getSubgraphCallerRunSelection(callerId, processes, 0, undefined), {
    type: 'caller',
    parentNodeId: callerId,
    parentGraphRunId,
    parentProcessId: 'first',
  });
  assert.deepEqual(getSubgraphCallerRunSelection(callerId, processes, 'latest', undefined), {
    type: 'caller',
    parentNodeId: callerId,
    parentGraphRunId,
    parentProcessId: 'second',
  });
  assert.equal(
    getSubgraphCallerRunSelection(callerId, [{ processId: 'legacy' as ProcessId, data: {} }], 'latest', undefined),
    undefined,
  );
});

test('following a nested caller absent from the selected parent execution cannot restore another invocation', async () => {
  const state = projection();
  (await recordFixture()).forEach(state.apply);
  const prunedView = state.followCaller('pruned');
  const skippedView = state.followCaller('skipped');
  const leafView = createSubgraphGraphViewContext({
    graphId: leafId,
    parentGraphId: childId,
    parentNodeId: 'nested' as NodeId,
  });

  for (const parentView of [prunedView, skippedView]) {
    const parentSelection = getGraphSelectionOptions({ ...state.snapshot, currentGraphView: parentView });
    const selection = getSubgraphCallerRunSelection(
      'nested' as NodeId,
      state.snapshot.lastRunDataByNode['nested' as NodeId],
      'latest',
      parentSelection,
    );
    assert.ok(selection, 'an empty known parent selection must not use the legacy fallback');
    const leafSelection = getGraphSelectionOptions({
      ...state.snapshot,
      currentGraphView: leafView,
      selectedGraphRunByView: { ...state.snapshot.selectedGraphRunByView, [leafView.key]: selection },
    });
    assert.equal(leafSelection.graphRuns?.length, 1, 'another caller really executed this leaf');
    assert.equal(getSelectedGraphRunId(leafSelection.graphRuns, leafSelection.selectedGraphRun), undefined);
    assert.equal(
      getSelectedProcessData(state.snapshot.lastRunDataByNode['leaf-source' as NodeId], 'latest', leafSelection),
      undefined,
    );
  }
});

test('navigation before the parent node starts follows only that node in the selected parent run', async () => {
  const events = await recordFixture();
  const callerStart = events.findIndex(
    (event) =>
      event.message === 'nodeStart' && (event.data as ProcessEventMessageMap['nodeStart']).node.id === 'pruned',
  );
  assert.ok(callerStart > 0);
  const state = projection();
  events.slice(0, callerStart).forEach(state.apply);
  const view = state.followCaller('pruned');
  const before = getGraphSelectionOptions({ ...state.snapshot, currentGraphView: view });
  assert.equal(getSelectedGraphRunId(before.graphRuns, before.selectedGraphRun), undefined);
  events.slice(callerStart).forEach(state.apply);
  const after = getGraphSelectionOptions({ ...state.snapshot, currentGraphView: view });
  assert.equal(getSelectedGraphRunId(after.graphRuns, after.selectedGraphRun), after.graphRuns![0]!.graphRunId);
  assert.equal(
    getSelectedProcessData(state.snapshot.lastRunDataByNode['unused' as NodeId], 'latest', after),
    undefined,
  );
});
