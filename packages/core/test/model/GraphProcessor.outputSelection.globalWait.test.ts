import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Emittery from 'emittery';
import {
  GraphProcessor,
  createBuiltInRegistry,
  externalCallNode,
  getGlobalNode,
  graphOutputNode,
  raceInputsNode,
  setGlobalNode,
  subGraphNode,
  textNode,
  type ChartNode,
  type GraphId,
  type NodeConnection,
  type NodeId,
  type PortId,
  type ProcessEvents,
  type Project,
  type ProjectId,
} from '../../src/index.js';
import { testProcessContext } from '../testUtils.js';

const globalId = 'output-selection-global';

function connect(source: ChartNode, outputId: string, target: ChartNode, inputId: string): NodeConnection {
  return { outputNodeId: source.id, outputId: outputId as PortId, inputNodeId: target.id, inputId: inputId as PortId };
}

function fixture(skipUnusedOutputs: boolean, race = false) {
  const reader = getGlobalNode.impl.create();
  reader.data.id = globalId;
  const writer = setGlobalNode.impl.create();
  writer.data.id = globalId;
  const source = textNode.impl.create();
  source.data.text = 'ready';
  const requested = graphOutputNode.impl.create();
  requested.data.id = 'requested';
  const unused = graphOutputNode.impl.create();
  unused.data.id = 'unused';
  const childId = 'global-wait-child' as GraphId;
  const parentId = 'global-wait-parent' as GraphId;
  const caller = subGraphNode.impl.create();
  caller.data.graphId = childId;
  caller.data.skipUnusedOutputs = skipUnusedOutputs;
  const result = graphOutputNode.impl.create();
  result.data.id = 'result';
  const childNodes: ChartNode[] = [reader, source, writer, requested, unused];
  const childConnections = [
    connect(source, 'output', writer, 'value'),
    connect(writer, 'saved-value', unused, 'value'),
  ];

  if (race) {
    const raceNode = raceInputsNode.impl.create();
    const winner = externalCallNode.impl.create();
    winner.data.functionName = 'race-winner';
    childNodes.push(raceNode, winner);
    childConnections.push(
      connect(reader, 'value', raceNode, 'input1'),
      connect(winner, 'result', raceNode, 'input2'),
      connect(raceNode, 'result', requested, 'value'),
    );
  } else {
    childConnections.push(connect(reader, 'value', requested, 'value'));
  }

  const project: Project = {
    metadata: { id: 'global-wait-project' as ProjectId, title: 'Global wait', description: '', mainGraphId: parentId },
    graphs: {
      [parentId]: {
        metadata: { id: parentId, name: 'Parent' },
        nodes: [caller, result],
        connections: [connect(caller, 'requested', result, 'value')],
      },
      [childId]: {
        metadata: { id: childId, name: 'Child' },
        nodes: childNodes,
        connections: childConnections,
      },
    },
    plugins: [],
  };
  const processor = new GraphProcessor(project, parentId, createBuiltInRegistry());
  const started = new Set<NodeId>();
  processor.on('nodeStart', ({ node }) => {
    started.add(node.id);
  });

  let notifyWaiter!: () => void;
  const waiterAttached = new Promise<void>((resolve) => {
    notifyWaiter = resolve;
  });
  let subscriptions = 0;
  let removals = 0;
  processor.on(Emittery.listenerAdded, ({ eventName }) => {
    if (eventName === `globalSet:${globalId}`) {
      subscriptions++;
      notifyWaiter();
    }
  });
  processor.on(Emittery.listenerRemoved, ({ eventName }) => {
    if (eventName === `globalSet:${globalId}`) removals++;
  });
  const assertWaiterCleanedUp = () => {
    assert.ok(subscriptions > 0, 'The real Get Global node subscribed before it settled');
    assert.equal(removals, subscriptions, 'Every global wait subscription was removed');
  };

  return { processor, caller, reader, writer, started, waiterAttached, assertWaiterCleanedUp };
}

void describe('output selection with hidden global dependencies', { timeout: 5_000 }, () => {
  void it('runs the hidden writer normally and removes the completed Get Global wait listener', async () => {
    const { processor, writer, started, assertWaiterCleanedUp } = fixture(false);
    const outputs = await processor.processGraph(testProcessContext());

    assert.deepEqual(outputs.result, { type: 'string', value: 'ready' });
    assert.ok(started.has(writer.id));
    assertWaiterCleanedUp();
  });

  void it('cancels a wait whose writer was skipped and can reuse the same processor for a full run', async () => {
    const { processor, caller, writer, started, waiterAttached, assertWaiterCleanedUp } = fixture(true);
    const completion = processor.processGraph(testProcessContext());
    const rejected = assert.rejects(completion);
    await waiterAttached;
    assert.equal(started.has(writer.id), false);

    await Promise.all([processor.abort(false, 'Stop the waiting run'), rejected]);
    assertWaiterCleanedUp();

    caller.data.skipUnusedOutputs = false;
    assert.deepEqual((await processor.processGraph(testProcessContext())).result, { type: 'string', value: 'ready' });
    assert.ok(started.has(writer.id));
    assertWaiterCleanedUp();
  });

  void it('releases a losing Get Global wait when a race succeeds without aborting the child graph', async () => {
    const { processor, reader, writer, started, waiterAttached, assertWaiterCleanedUp } = fixture(true, true);
    processor.setExternalFunction('race-winner', async () => {
      await waiterAttached;
      return { type: 'string', value: 'winner' };
    });
    const readerExcluded = new Promise<ProcessEvents['nodeExcluded']>((resolve) => {
      processor.on('nodeExcluded', (event) => {
        if (event.node.id === reader.id) resolve(event);
      });
    });

    const [outputs, excluded] = await Promise.all([processor.processGraph(testProcessContext()), readerExcluded]);

    assert.deepEqual(outputs.result, { type: 'string', value: 'winner' });
    assert.match(excluded.reason, /Race branch lost/);
    assert.equal(started.has(writer.id), false);
    assertWaiterCleanedUp();
  });
});
