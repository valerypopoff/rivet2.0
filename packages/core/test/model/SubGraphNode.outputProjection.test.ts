import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  GraphProcessor,
  createBuiltInRegistry,
  type ChartNode,
  type GraphId,
  type NodeConnection,
  type NodeId,
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
