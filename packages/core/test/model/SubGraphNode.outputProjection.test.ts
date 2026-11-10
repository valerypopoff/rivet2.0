import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  GraphProcessor,
  NodeImpl,
  createBuiltInRegistry,
  getGraphBoundary,
  nodeDefinition,
  type ChartNode,
  type GraphId,
  type NodeConnection,
  type NodeId,
  type NodeOutputDefinition,
  type Outputs,
  type PortId,
  type Project,
  type ProjectId,
} from '../../src/index.js';
import { testProcessContext } from '../testUtils.js';

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

class ProjectionSource extends NodeImpl<ChartNode> {
  static create() {
    return node('projectionSource', 'child-source', {});
  }
  static getUIData() {
    return {};
  }
  getInputDefinitions() {
    return [];
  }
  getOutputDefinitions(): NodeOutputDefinition[] {
    return [{ id: 'output' as PortId, title: 'Output', dataType: 'string' }];
  }
  async process(): Promise<Outputs> {
    return { output: { type: 'string', value: '73' }, cost: { type: 'number', value: 1 } };
  }
}

function fixture(skipUnusedOutputs: boolean, excluded: boolean) {
  const mainId = 'projection-main' as GraphId;
  const childId = 'projection-child' as GraphId;
  const project: Project = {
    metadata: { id: 'projection' as ProjectId, title: 'Projection', description: '', mainGraphId: mainId },
    graphs: {
      [mainId]: {
        metadata: { id: mainId, name: 'Main' },
        nodes: [
          node('subGraph', 'caller', { graphId: childId, skipUnusedOutputs }),
          // Number's optional input normally falls back to its authored value.
          // An excluded input instead prevents the whole consumer from running.
          node('number', 'default-consumer', { useValueInput: true, value: 42 }),
          node('graphOutput', 'result', { id: 'result', dataType: 'number' }),
        ],
        connections: [
          connect('caller', 'wanted', 'default-consumer', 'input'),
          connect('default-consumer', 'value', 'result', 'value'),
        ],
      },
      [childId]: {
        metadata: { id: childId, name: 'Child' },
        nodes: [
          node('graphOutput', 'wanted-output', { id: 'wanted', dataType: 'any' }),
          node('text', 'unused-source', { text: 'unused result' }),
          node('graphOutput', 'unused-output', { id: 'unused', dataType: 'string' }),
          ...(excluded ? [node('if', 'excluded-source', { unconnectedControlFlowExcluded: true })] : []),
        ],
        connections: [
          connect('unused-source', 'output', 'unused-output', 'value'),
          ...(excluded ? [connect('excluded-source', 'output', 'wanted-output', 'value')] : []),
        ],
      },
    },
    plugins: [],
  };
  const processor = new GraphProcessor(project, mainId, createBuiltInRegistry());
  const finished = new Map<NodeId, Outputs>();
  processor.on('nodeFinish', ({ node, outputs }) => {
    finished.set(node.id, outputs);
  });
  return { processor, finished };
}

void describe('Subgraph requested-output projection', () => {
  for (const skipUnusedOutputs of [false, true]) {
    void it(`preserves an absent requested output and downstream defaults with pruning ${skipUnusedOutputs}`, async () => {
      const { processor, finished } = fixture(skipUnusedOutputs, false);
      const outputs = await processor.processGraph(testProcessContext());

      assert.deepEqual(outputs.result, { type: 'number', value: 42 });
      assert.equal(finished.has('default-consumer' as NodeId), true);
      assert.equal(Object.hasOwn(finished.get('caller' as NodeId)!, 'wanted'), false);
      assert.equal(finished.has('wanted-output' as NodeId), true);
      assert.equal(finished.has('unused-source' as NodeId), !skipUnusedOutputs);
      assert.deepEqual(
        finished.get('caller' as NodeId)?.unused,
        skipUnusedOutputs
          ? { type: 'control-flow-excluded', value: undefined }
          : { type: 'string', value: 'unused result' },
      );
    });

    void it(`preserves a genuinely excluded requested output with pruning ${skipUnusedOutputs}`, async () => {
      const { processor, finished } = fixture(skipUnusedOutputs, true);
      const outputs = await processor.processGraph(testProcessContext());

      assert.deepEqual(outputs.result, { type: 'control-flow-excluded', value: undefined });
      assert.deepEqual(finished.get('caller' as NodeId)?.wanted, {
        type: 'control-flow-excluded',
        value: undefined,
      });
      assert.equal(finished.has('default-consumer' as NodeId), false);
      assert.equal(finished.has('unused-source' as NodeId), !skipUnusedOutputs);
    });
  }
});

for (const alias of ['cost', 'costBreakdown', 'duration']) {
  for (const skipUnusedOutputs of [false, true]) {
    testRenamedMetricOutput(alias, skipUnusedOutputs);
  }
}

function testRenamedMetricOutput(alias: string, skipUnusedOutputs: boolean) {
  void it(`preserves renamed ${alias} values and missing outputs with pruning ${skipUnusedOutputs}`, async () => {
    for (const hasValue of [true, false]) {
      const childId = 'external-child' as GraphId;
      const childOutput = node('graphOutput', 'child-output', { id: alias, dataType: 'any' });
      const target: Project = {
        metadata: { id: 'external-target' as ProjectId, title: 'Target', description: '' },
        graphs: {
          [childId]: {
            metadata: { id: childId, name: 'Child' },
            nodes: [ProjectionSource.create(), childOutput],
            connections: hasValue ? [connect('child-source', 'output', 'child-output', 'value')] : [],
          },
        },
        plugins: [],
      };
      const savedBoundary = getGraphBoundary(target, childId);
      (childOutput.data as { id: string }).id = 'answer';
      const mainId = 'external-main' as GraphId;
      const owner: Project = {
        metadata: { id: 'external-owner' as ProjectId, title: 'Owner', description: '', mainGraphId: mainId },
        graphs: {
          [mainId]: {
            metadata: { id: mainId, name: 'Main' },
            nodes: [
              node('subGraph', 'caller', {
                graphId: childId,
                targetProjectId: target.metadata.id,
                targetBoundary: savedBoundary,
                skipUnusedOutputs,
              }),
              node('number', 'consumer', { useValueInput: true, value: 42 }),
              node('graphOutput', 'result', { id: 'result', dataType: 'number' }),
            ],
            connections: [
              connect('caller', alias, 'consumer', 'input'),
              connect('consumer', 'value', 'result', 'value'),
            ],
          },
        },
        plugins: [],
      };
      const registry = createBuiltInRegistry().register(nodeDefinition(ProjectionSource, 'Projection source'));
      const processor = new GraphProcessor(owner, mainId, registry);
      let callerOutputs: Outputs | undefined;
      processor.on('nodeFinish', ({ node: finished, outputs }) => {
        if (finished.id === 'caller') callerOutputs = outputs;
      });
      const outputs = await processor.processGraph({
        ...testProcessContext(),
        subgraphProjectLoader: { loadTarget: async () => ({ project: target }) },
      });
      assert.equal(outputs.result?.value, hasValue ? 73 : 42);
      assert.ok(callerOutputs);
      if (hasValue) assert.deepEqual(callerOutputs[alias as PortId], { type: 'string', value: '73' });
      else assert.equal(Object.hasOwn(callerOutputs, alias), false);
    }
  });
}
