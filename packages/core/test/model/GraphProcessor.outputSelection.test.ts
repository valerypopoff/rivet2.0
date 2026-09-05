import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  GraphProcessor,
  createBuiltInRegistry,
  textNode,
  graphOutputNode,
  type ChartNode,
  type NodeId,
  type GraphId,
  type Project,
  type ProjectId,
  type PortId,
} from '../../src/index.js';
import { testProcessContext } from '../testUtils.js';

function fixture() {
  const shared = { ...textNode.impl.create(), id: 'shared' as NodeId, data: { text: 'shared value' } };
  const outputs: ChartNode[] = ['left', 'right'].map((id) => ({
    ...graphOutputNode.impl.create(),
    id: id as NodeId,
    data: { id, dataType: 'string' },
  }));
  const graphId = 'selection-validation' as GraphId;
  const project: Project = {
    metadata: { id: 'selection-project' as ProjectId, title: 'Selection', description: '', mainGraphId: graphId },
    graphs: {
      [graphId]: {
        metadata: { id: graphId, name: 'Selection' },
        nodes: [shared, ...outputs],
        connections: outputs.map((output) => ({
          outputNodeId: shared.id,
          outputId: 'output' as PortId,
          inputNodeId: output.id,
          inputId: 'value' as PortId,
        })),
      },
    },
    plugins: [],
  };
  const processor = new GraphProcessor(project, graphId, createBuiltInRegistry());
  const started: NodeId[] = [];
  processor.on('nodeStart', ({ node }) => {
    started.push(node.id);
  });
  return { project, processor, started };
}

void describe('GraphProcessor requested-output options', { timeout: 5_000 }, () => {
  void it('prevents shared ancestors from launching the unrequested sibling output', async () => {
    const { processor, started } = fixture();
    const outputs = await processor.processGraph(testProcessContext(), {}, {}, { requestedGraphOutputIds: ['left'] });
    assert.deepEqual(started, ['shared', 'left']);
    assert.deepEqual(outputs.left, { type: 'string', value: 'shared value' });
    assert.equal(outputs.right, undefined);
  });

  void it('runs no nodes for an empty selection and does not carry that restriction into the next run', async () => {
    const { processor, started } = fixture();
    assert.deepEqual(await processor.processGraph(testProcessContext(), {}, {}, { requestedGraphOutputIds: [] }), {
      cost: { type: 'number', value: 0 },
    });
    assert.deepEqual(started, []);
    const outputs = await processor.processGraph(testProcessContext());
    assert.equal(outputs.left?.value, 'shared value');
    assert.equal(outputs.right?.value, 'shared value');
    assert.equal(started.length, 3);
  });

  void it('rejects unknown output IDs without running nodes and leaves the processor reusable', async () => {
    const { processor, started } = fixture();
    let finishes = 0;
    processor.on('finish', () => {
      finishes++;
    });
    await assert.rejects(
      processor.processGraph(
        testProcessContext(),
        {},
        {},
        {
          requestedGraphOutputIds: ['left', 'missing'],
        },
      ),
      /Unknown requested graph output IDs/,
    );
    assert.deepEqual(started, []);
    assert.equal(finishes, 1);
    assert.equal((await processor.processGraph(testProcessContext())).right?.value, 'shared value');
  });

  void it('rejects combining selection with debugger run-to, including an empty run-to list', async () => {
    for (const targets of [[], ['left' as NodeId]]) {
      const { processor, started } = fixture();
      processor.runToNodeIds = targets;
      await assert.rejects(
        processor.processGraph(
          testProcessContext(),
          {},
          {},
          {
            requestedGraphOutputIds: ['left'],
          },
        ),
        /cannot be combined with runToNodeIds/,
      );
      assert.deepEqual(started, []);
    }
  });

  void it('snapshots caller output IDs before awaiting reference loading', async () => {
    const { processor, project, started } = fixture();
    const referenced = fixture().project;
    referenced.metadata.id = 'referenced' as ProjectId;
    project.references = [{ id: referenced.metadata.id }];
    let release!: () => void;
    let loaded!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loading = new Promise<void>((resolve) => {
      loaded = resolve;
    });
    const requestedGraphOutputIds = ['left', 'left'];
    const result = processor.processGraph(
      {
        ...testProcessContext(),
        projectReferenceLoader: {
          loadProject: async () => {
            loaded();
            await released;
            return referenced;
          },
        },
      },
      {},
      {},
      { requestedGraphOutputIds },
    );
    await loading;
    requestedGraphOutputIds.splice(0, requestedGraphOutputIds.length, 'right');
    release();
    assert.equal((await result).left?.value, 'shared value');
    assert.deepEqual(started, ['shared', 'left']);
  });
});
