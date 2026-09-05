import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Emittery from 'emittery';
import {
  GraphProcessor,
  createBuiltInRegistry,
  externalCallNode,
  graphOutputNode,
  raiseEventNode,
  waitForEventNode,
  type GraphId,
  type NodeId,
  type PortId,
  type Project,
  type ProjectId,
} from '../../src/index.js';
import { testProcessContext } from '../testUtils.js';

function fixture(waitAfterAbort = false) {
  const eventName = 'selected-event-wait';
  const reader = waitAfterAbort ? externalCallNode.impl.create() : waitForEventNode.impl.create();
  if (reader.type === 'externalCall') reader.data.functionName = 'wait-after-abort';
  else reader.data.eventName = eventName;
  const sender = raiseEventNode.impl.create();
  sender.data.eventName = eventName;
  const output = graphOutputNode.impl.create();
  output.data.id = 'requested';
  const graphId = 'event-wait-graph' as GraphId;
  const project: Project = {
    metadata: { id: 'event-wait-project' as ProjectId, title: 'Event wait', description: '', mainGraphId: graphId },
    graphs: {
      [graphId]: {
        metadata: { id: graphId, name: 'Event wait' },
        nodes: [reader, sender, output],
        connections: [
          {
            outputNodeId: reader.id,
            outputId: (waitAfterAbort ? 'result' : 'eventData') as PortId,
            inputNodeId: output.id,
            inputId: 'value' as PortId,
          },
        ],
      },
    },
    plugins: [],
  };
  const processor = new GraphProcessor(project, graphId, createBuiltInRegistry());
  const started = new Set<NodeId>();
  processor.on('nodeStart', ({ node }) => started.add(node.id));
  let subscriptions = 0;
  let removals = 0;
  let notifyWaiter = () => {};
  processor.on(Emittery.listenerAdded, ({ eventName: addedEventName }) => {
    if (addedEventName === `userEvent:${eventName}`) {
      subscriptions++;
      notifyWaiter();
    }
  });
  processor.on(Emittery.listenerRemoved, ({ eventName: removedEventName }) => {
    if (removedEventName === `userEvent:${eventName}`) removals++;
  });

  return {
    processor,
    eventName,
    waitForSubscription: () =>
      new Promise<void>((resolve) => {
        notifyWaiter = resolve;
      }),
    getSubscriptions: () => subscriptions,
    assertClean: () => {
      assert.ok(subscriptions > 0, 'The real Wait For Event node attached its subscription');
      assert.equal(removals, subscriptions, 'Cancelled event waits must remove their subscriptions');
      assert.equal(started.has(sender.id), false, 'The hidden sender is not a selected prerequisite');
    },
  };
}

void describe('output selection with hidden event dependencies', { timeout: 5_000 }, () => {
  void it('cleans event waits after repeated cancellation without requiring the skipped sender to run', async () => {
    const { processor, waitForSubscription, assertClean } = fixture();
    for (let attempt = 0; attempt < 2; attempt++) {
      const attached = waitForSubscription();
      const completion = processor.processGraph(
        testProcessContext(),
        {},
        {},
        { requestedGraphOutputIds: ['requested'] },
      );
      const rejected = assert.rejects(completion);
      await attached;
      await Promise.all([processor.abort(false, 'Cancel event wait'), rejected]);
      assertClean();
    }
  });

  void it('cleans event waits after successful abort', async () => {
    const { processor, waitForSubscription, assertClean } = fixture();
    const attached = waitForSubscription();
    const completion = processor.processGraph(testProcessContext(), {}, {}, { requestedGraphOutputIds: ['requested'] });
    await attached;
    await Promise.all([processor.abort(true), completion]);
    assertClean();
  });

  void it('cleans normally delivered event waits and preserves the event value', async () => {
    const { processor, eventName, waitForSubscription, assertClean } = fixture();
    const attached = waitForSubscription();
    const completion = processor.processGraph(testProcessContext(), {}, {}, { requestedGraphOutputIds: ['requested'] });
    await attached;
    processor.raiseEvent(eventName, { type: 'string', value: 'external response' });
    const outputs = await completion;
    assert.deepEqual(outputs.requested, { type: 'string', value: 'external response' });
    assertClean();
  });

  void it('rejects a wait started after node cancellation without attaching an event listener', async () => {
    const { processor, eventName, getSubscriptions } = fixture(true);
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    processor.setExternalFunction('wait-after-abort', async (context) => {
      const cancelled = new Promise<void>((resolve) =>
        context.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      notifyStarted();
      await cancelled;
      await context.waitEvent(eventName);
      assert.fail('A wait started on an aborted node must reject');
    });
    const completion = processor.processGraph(testProcessContext(), {}, {}, { requestedGraphOutputIds: ['requested'] });
    const rejected = assert.rejects(completion);
    await started;
    await Promise.all([processor.abort(false, 'Cancel before waiting'), rejected]);
    assert.equal(getSubscriptions(), 0);
  });
});
