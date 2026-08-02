import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ChartNode,
  GraphExecutionMetadata,
  GraphId,
  GraphRunId,
  NodeId,
  ProcessEventMessageMap,
  ProcessId,
  RootRunId,
} from '@valerypopoff/rivet2-core';
import { createRunActivityNodeKey, createRunActivityJournal } from './runActivityJournal.js';
import { applyProcessEventToRunActivityJournal } from './runActivityProcessEvents.js';

const execution: GraphExecutionMetadata = {
  rootRunId: 'root' as RootRunId,
  graphRunId: 'graph-run' as GraphRunId,
  graphId: 'graph' as GraphId,
};
const node: ChartNode = {
  id: 'node' as NodeId,
  type: 'text',
  title: 'Text',
  data: {},
  visualData: { x: 0, y: 0 },
};

test('preserves explicit runtime provenance and leaves legacy provenance unknown', () => {
  const explicitProcessId = 'explicit' as ProcessId;
  const legacyProcessId = 'legacy' as ProcessId;
  let journal = createRunActivityJournal();

  journal = applyProcessEventToRunActivityJournal({
    journal,
    message: 'nodeStart',
    occurredAt: 1,
    data: {
      node,
      processId: explicitProcessId,
      inputs: {},
      resultOrigin: 'executed',
      execution,
    } satisfies ProcessEventMessageMap['nodeStart'],
  });
  journal = applyProcessEventToRunActivityJournal({
    journal,
    message: 'nodeStart',
    occurredAt: 2,
    data: {
      node,
      processId: legacyProcessId,
      inputs: {},
      execution,
    } satisfies ProcessEventMessageMap['nodeStart'],
  });

  const root = journal.rootsById[execution.rootRunId]!;
  assert.equal(
    root.nodeInvocationsByKey[createRunActivityNodeKey({ ...execution, nodeId: node.id, processId: explicitProcessId })]
      ?.resultOrigin,
    'executed',
  );
  assert.equal(
    root.nodeInvocationsByKey[createRunActivityNodeKey({ ...execution, nodeId: node.id, processId: legacyProcessId })]
      ?.resultOrigin,
    'unknown',
  );
});

test('recognizes the reserved legacy preload process identity', () => {
  const processId = 'preload' as ProcessId;
  const journal = applyProcessEventToRunActivityJournal({
    journal: createRunActivityJournal(),
    message: 'nodeFinish',
    occurredAt: 1,
    data: {
      node,
      processId,
      outputs: {},
      execution,
    } satisfies ProcessEventMessageMap['nodeFinish'],
  });

  assert.equal(
    journal.rootsById[execution.rootRunId]!.nodeInvocationsByKey[
      createRunActivityNodeKey({ ...execution, nodeId: node.id, processId })
    ]?.resultOrigin,
    'preloaded',
  );
});
