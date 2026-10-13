import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  AgentTraceEvent,
  ChartNode,
  GraphId,
  GraphRunId,
  NodeGraph,
  NodeId,
  ProcessId,
  Project,
  ProjectId,
  RootRunId,
} from '@valerypopoff/rivet2-core';
import type { ProcessDataForNode, RunDataByNodeId } from '../../state/dataFlow.js';
import type { RunActivityInvocationIdentity } from './types.js';
import { resolveRunActivityInspectorTrace, shouldCloseRunActivityInspector } from './runActivityInspectorLifecycle.js';

const rootA = 'root-a' as RootRunId;
const rootB = 'root-b' as RootRunId;

for (const nodeType of ['classifierEvaluate', 'llmChatV2']) {
  test(`${nodeType} inspector follows its exact live invocation and handles removed evidence`, () => {
    const identity: RunActivityInvocationIdentity = {
      rootRunId: rootA,
      graphRunId: 'graph-run' as GraphRunId,
      graphId: 'graph' as GraphId,
      nodeId: 'model' as NodeId,
      processId: 'process' as ProcessId,
    };
    const node: ChartNode = {
      id: identity.nodeId,
      type: nodeType,
      title: 'Model',
      data: {},
      visualData: { x: 0, y: 0 },
    };
    const graph: NodeGraph = { metadata: { id: identity.graphId }, nodes: [node], connections: [] };
    const project: Project = {
      metadata: { id: 'project' as ProjectId, title: '', description: '' },
      graphs: { [identity.graphId]: graph },
    };
    const initial: ProcessDataForNode = {
      ...identity,
      data: { status: { type: 'running' }, startedAt: 100, agentTraceEvents: [] },
    };
    let runData: RunDataByNodeId = { [identity.nodeId]: [initial] };
    const initialTrace = resolveRunActivityInspectorTrace(project, graph, runData, identity)!;
    assert.equal(initialTrace.status, 'running');
    const event: AgentTraceEvent =
      nodeType === 'classifierEvaluate'
        ? {
            type: 'llm-profile-attempt',
            execution: identity,
            eventId: 'request',
            family: 'classifier',
            nodeId: identity.nodeId,
            processId: identity.processId,
            provider: 'perplexity',
            model: 'decider',
            roundIndex: 0,
            attemptIndex: 0,
            stage: 'request',
            outcome: 'success',
            durationMs: 250,
          }
        : {
            type: 'llm-call-finished',
            execution: identity,
            callId: 'call' as never,
            attemptIndex: 0,
            nodeId: identity.nodeId,
            processId: identity.processId,
            provider: 'openai',
            model: 'gpt-test',
            outcome: 'success',
            pricing: { status: 'unknown' },
          };
    const completed: ProcessDataForNode = {
      ...initial,
      data: { ...initial.data, status: { type: 'ok' }, finishedAt: 350, agentTraceEvents: [event] },
    };
    runData = {
      [identity.nodeId]: [
        { ...initial, rootRunId: rootB },
        { ...initial, graphRunId: 'other-graph-run' as GraphRunId },
        { ...initial, processId: 'other-process' as ProcessId },
        { ...initial, graphId: 'other-graph' as GraphId },
        completed,
      ],
    };
    const currentTrace = resolveRunActivityInspectorTrace(project, graph, runData, identity)!;
    assert.equal(currentTrace.status, 'completed');
    assert.equal(currentTrace.durationMs, 250);
    assert.equal(currentTrace.summary.classifierRequestCount ?? currentTrace.summary.modelCallCount, 1);
    assert.equal(initialTrace.status, 'running');
    assert.equal(
      resolveRunActivityInspectorTrace(
        project,
        graph,
        {
          [identity.nodeId]: runData[identity.nodeId]!.filter((process) => process !== completed),
        },
        identity,
      ),
      undefined,
    );
    assert.equal(resolveRunActivityInspectorTrace(project, { ...graph, nodes: [] }, runData, identity), undefined);
    // The unsaved current graph is authoritative, even if a saved graph still has the node.
    assert.equal(
      resolveRunActivityInspectorTrace(project, { ...graph, nodes: [{ ...node, type: 'text' }] }, runData, identity),
      undefined,
    );
  });
}

test('response inspector remains open only for its selected root', () => {
  assert.equal(
    shouldCloseRunActivityInspector({ drawerOpen: true, inspectedRootRunId: rootA, selectedRootRunId: rootA }),
    false,
  );
  assert.equal(
    shouldCloseRunActivityInspector({ drawerOpen: true, inspectedRootRunId: rootA, selectedRootRunId: rootB }),
    true,
  );
  assert.equal(
    shouldCloseRunActivityInspector({ drawerOpen: true, inspectedRootRunId: rootA, selectedRootRunId: undefined }),
    true,
  );
});

test('closing the drawer always closes its response inspector', () => {
  assert.equal(
    shouldCloseRunActivityInspector({ drawerOpen: false, inspectedRootRunId: rootA, selectedRootRunId: rootA }),
    true,
  );
});

test('a closed drawer without an inspector does not schedule a redundant state reset', () => {
  assert.equal(
    shouldCloseRunActivityInspector({ drawerOpen: false, inspectedRootRunId: undefined, selectedRootRunId: rootA }),
    false,
  );
});
