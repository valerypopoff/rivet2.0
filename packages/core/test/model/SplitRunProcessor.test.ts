import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { processSplitRunNode } from '../../src/model/SplitRunProcessor.js';
import type { ChartNode, NodeInputDefinition, PortId } from '../../src/model/NodeBase.js';
import type { Inputs, Outputs } from '../../src/model/GraphProcessor.js';

function createSplitNode(): ChartNode {
  return {
    id: 'split-node' as ChartNode['id'],
    type: 'test' as ChartNode['type'],
    title: 'Split node',
    data: {},
    visualData: { x: 0, y: 0, width: 200 },
    isSplitRun: true,
    splitRunMax: 10,
  };
}

async function runSplitOriginScenario(options: {
  cachedIndexes: ReadonlySet<number>;
  isSplitSequential: boolean;
}): Promise<'executed' | 'editor-cache' | undefined> {
  const node = createSplitNode();
  node.isSplitSequential = options.isSplitSequential;
  let finishOrigin: 'executed' | 'editor-cache' | undefined;

  await processSplitRunNode(node, 'process' as any, {
    getInputValues: () => ({
      prompts: { type: 'string[]', value: ['first', 'second'] },
    }),
    getInputConnections: () => [],
    getInputDefinitions: () => [
      {
        id: 'prompts' as PortId,
        title: 'Prompts',
        dataType: 'string[]',
      },
    ],
    isExcludedDueToControlFlow: () => false,
    processNodeWithInputData: async (_node, _inputs, index, _processId, _partialOutput, markCacheHit) => {
      if (options.cachedIndexes.has(index)) {
        markCacheHit?.();
      }
      return { output: { type: 'string', value: `result-${index}` } } as Outputs;
    },
    splitRunConcurrency: 2,
    accumulateCost: () => {},
    setNodeResults: () => {},
    markNodeVisited: () => {},
    nodeErrored: async (_node, error) => {
      throw error;
    },
    isAborted: () => false,
    getAbortError: () => new Error('aborted'),
    emit: async (event, data) => {
      if (event === 'nodeFinish') {
        finishOrigin = data.resultOrigin;
      }
    },
  });

  return finishOrigin;
}

describe('SplitRunProcessor', () => {
  it('keeps preserve-array inputs intact while splitting ordinary array inputs', async () => {
    const received: Inputs[] = [];
    const inputs: Inputs = {
      profiles: {
        type: 'llm-config[]',
        value: [{ id: 'primary' }, { id: 'backup' }],
      },
      prompts: {
        type: 'string[]',
        value: ['first', 'second'],
      },
    };
    const inputDefinitions: NodeInputDefinition[] = [
      {
        id: 'profiles' as PortId,
        title: 'Profiles',
        dataType: 'llm-config[]',
        splitRunBehavior: 'preserve-array',
      },
      {
        id: 'prompts' as PortId,
        title: 'Prompts',
        dataType: 'string[]',
      },
    ];

    await processSplitRunNode(createSplitNode(), 'process' as any, {
      getInputValues: () => inputs,
      getInputConnections: () => [],
      getInputDefinitions: () => inputDefinitions,
      isExcludedDueToControlFlow: () => false,
      processNodeWithInputData: async (_node, invocationInputs) => {
        received.push(invocationInputs);
        return { output: { type: 'string', value: 'ok' } } as Outputs;
      },
      splitRunConcurrency: 2,
      accumulateCost: () => {},
      setNodeResults: () => {},
      markNodeVisited: () => {},
      nodeErrored: async (_node, error) => {
        throw error;
      },
      isAborted: () => false,
      getAbortError: () => new Error('aborted'),
      emit: async () => {},
      startNodeTiming: () => undefined,
      finishNodeTiming: () => undefined,
    });

    assert.equal(received.length, 2);
    assert.deepEqual(
      received.map((invocationInputs) => invocationInputs.profiles?.value),
      [
        [{ id: 'primary' }, { id: 'backup' }],
        [{ id: 'primary' }, { id: 'backup' }],
      ],
    );
    assert.deepEqual(
      received.map((invocationInputs) => invocationInputs.prompts?.value),
      ['first', 'second'],
    );
  });

  void it('reports editor-cache when every sequential split replays cached output', async () => {
    assert.equal(
      await runSplitOriginScenario({ cachedIndexes: new Set([0, 1]), isSplitSequential: true }),
      'editor-cache',
    );
  });

  void it('reports executed when a parallel split run mixes cached and physical outputs', async () => {
    assert.equal(await runSplitOriginScenario({ cachedIndexes: new Set([0]), isSplitSequential: false }), 'executed');
  });
});
