import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { describe, it } from 'node:test';
import {
  GraphProcessor,
  createBuiltInRegistry,
  externalCallNode,
  graphOutputNode,
  raceInputsNode,
  userInputNode,
  type ChartNode,
  type GraphId,
  type NodeConnection,
  type PortId,
  type Project,
  type ProjectId,
} from '../../src/index.js';
import { testProcessContext } from '../testUtils.js';

function connect(source: ChartNode, output: string, target: ChartNode, input: string): NodeConnection {
  return { outputNodeId: source.id, outputId: output as PortId, inputNodeId: target.id, inputId: input as PortId };
}

function fixture(withRace = false, prompt: ChartNode = userInputNode.impl.create()) {
  const result = graphOutputNode.impl.create();
  result.data.id = 'requested';
  result.data.dataType = withRace ? 'string' : 'string[]';
  const winner = externalCallNode.impl.create();
  winner.data.functionName = 'winner';
  const race = raceInputsNode.impl.create();
  const graphId = 'user-input-selection' as GraphId;
  const project: Project = {
    metadata: {
      id: 'user-input-selection-project' as ProjectId,
      title: 'User input',
      description: '',
      mainGraphId: graphId,
    },
    graphs: {
      [graphId]: {
        metadata: { id: graphId, name: 'User input' },
        nodes: withRace ? [prompt, winner, race, result] : [prompt, result],
        connections: withRace
          ? [
              connect(prompt, 'output', race, 'input1'),
              connect(winner, 'result', race, 'input2'),
              connect(race, 'result', result, 'value'),
            ]
          : [connect(prompt, prompt.type === 'externalCall' ? 'result' : 'output', result, 'value')],
      },
    },
    plugins: [],
  };
  return { processor: new GraphProcessor(project, graphId, createBuiltInRegistry()), prompt };
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle`)), 1_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

void describe('selected user input cancellation', { timeout: 5_000 }, () => {
  void it('releases a User Input race loser without aborting the selected graph', async () => {
    const { processor } = fixture(true);
    const prompted = processor.once('userInput');
    processor.setExternalFunction('winner', async () => {
      await prompted;
      return { type: 'string', value: 'winner' };
    });
    const completion = processor.processGraph(testProcessContext(), {}, {}, { requestedGraphOutputIds: ['requested'] });
    const observedCompletion = completion.catch(() => undefined);
    try {
      assert.deepEqual((await within(completion, 'The winning graph')).requested, { type: 'string', value: 'winner' });
    } finally {
      await processor.abort(false, 'Clean up probe');
      await observedCompletion;
    }
  });

  void it('does not let a stale callback remove the next run pending request', async () => {
    const { processor, prompt } = fixture();
    const firstPrompted = processor.once('userInput');
    const firstRun = processor.processGraph(testProcessContext(), {}, {}, { requestedGraphOutputIds: ['requested'] });
    const first = await firstPrompted;
    processor.userInput(prompt.id, { type: 'string[]', value: ['first'] });
    assert.deepEqual((await firstRun).requested, { type: 'string[]', value: ['first'] });

    const secondPrompted = processor.once('userInput');
    const secondRun = processor.processGraph(testProcessContext(), {}, {}, { requestedGraphOutputIds: ['requested'] });
    const observedCompletion = secondRun.catch(() => undefined);
    await secondPrompted;
    first.callback({ type: 'string[]', value: ['stale'] });
    processor.userInput(prompt.id, { type: 'string[]', value: ['second'] });
    try {
      assert.deepEqual((await within(secondRun, 'The next input request')).requested, {
        type: 'string[]',
        value: ['second'],
      });
    } finally {
      await processor.abort(false, 'Clean up probe');
      await observedCompletion;
    }
  });

  for (const answerThrough of ['callback', 'processor'] as const) {
    void it(`removes the node abort listener when answered through ${answerThrough}`, async () => {
      const probe = externalCallNode.impl.create();
      probe.data.functionName = 'request';
      const { processor } = fixture(false, probe);
      let nodeSignal: AbortSignal | undefined;
      let initialListeners = 0;
      processor.setExternalFunction('request', async (context) => {
        nodeSignal = context.signal;
        initialListeners = getEventListeners(nodeSignal, 'abort').length;
        return await context.requestUserInput(['Question'], 'text');
      });
      const prompted = processor.once('userInput');
      const completion = processor.processGraph(
        testProcessContext(),
        {},
        {},
        { requestedGraphOutputIds: ['requested'] },
      );
      const event = await prompted;
      assert.ok(nodeSignal);
      assert.equal(getEventListeners(nodeSignal, 'abort').length, initialListeners + 1);
      const answer = { type: 'string[]' as const, value: ['answer'] };
      if (answerThrough === 'callback') event.callback(answer);
      else processor.userInput(probe.id, answer);
      assert.deepEqual((await completion).requested, answer);
      assert.equal(getEventListeners(nodeSignal, 'abort').length, initialListeners);
    });
  }

  void it('rejects a user request begun after cancellation without emitting a prompt', async () => {
    const probe = externalCallNode.impl.create();
    probe.data.functionName = 'request-after-abort';
    const { processor } = fixture(false, probe);
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    let prompts = 0;
    processor.on('userInput', () => {
      prompts++;
    });
    processor.setExternalFunction('request-after-abort', async (context) => {
      const cancelled = new Promise<void>((resolve) =>
        context.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      notifyStarted();
      await cancelled;
      return await context.requestUserInput(['Too late'], 'text');
    });
    const completion = processor.processGraph(testProcessContext(), {}, {}, { requestedGraphOutputIds: ['requested'] });
    const rejected = assert.rejects(completion);
    await started;
    const abort = processor.abort(false, 'Stop before requesting');
    try {
      await within(Promise.all([abort, rejected]), 'The aborted request');
      assert.equal(prompts, 0);
    } finally {
      processor.userInput(probe.id, { type: 'string[]', value: ['cleanup'] });
      await Promise.all([abort, rejected]);
    }
  });
});
