import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  GraphProcessor,
  canUseNodeAsPrefabSource,
  detachNodePrefabInstance,
  globalRivetNodeRegistry,
  resolveNodePrefabInstance,
  type ChartNode,
  type GraphId,
  type NodeId,
  type NodePrefabId,
  type PortId,
  type Project,
} from '../../src/index.js';
import { testProcessContext } from '../testUtils.js';

const prefabId = 'prefab-text' as NodePrefabId;
const graphId = 'main-graph' as GraphId;

function makeTextSourceNode(overrides: Partial<ChartNode> = {}): ChartNode<'text'> {
  return {
    id: 'source-node' as NodeId,
    type: 'text',
    title: 'Shared Text',
    visualData: { x: 0, y: 0, width: 240, color: { bg: 'source-bg', border: 'source-border' }, zIndex: 99 },
    data: { text: 'hello from prefab' },
    ...overrides,
  } as ChartNode<'text'>;
}

function makePrefabInstance(overrides: Partial<ChartNode> = {}): ChartNode<'nodePrefabInstance'> {
  return {
    id: 'instance-node' as NodeId,
    type: 'nodePrefabInstance',
    title: 'Linked Text',
    visualData: { x: 100, y: 200, width: 260 },
    data: { prefabId },
    ...overrides,
  } as ChartNode<'nodePrefabInstance'>;
}

function makeProject(instanceNode: ChartNode = makePrefabInstance()): Project {
  return {
    metadata: {
      id: 'project-node-prefabs',
      title: 'Node Prefab Test',
      description: '',
      mainGraphId: graphId,
    },
    graphs: {
      [graphId]: {
        metadata: { id: graphId, name: 'Main Graph', description: '' },
        nodes: [
          instanceNode,
          {
            id: 'result-output-node' as NodeId,
            type: 'graphOutput',
            title: 'Graph Output',
            visualData: { x: 400, y: 0, width: 240 },
            data: { id: 'result', dataType: 'string' },
          } as ChartNode<'graphOutput'>,
        ],
        connections: [
          {
            outputNodeId: instanceNode.id,
            outputId: 'output' as PortId,
            inputNodeId: 'result-output-node' as NodeId,
            inputId: 'value' as PortId,
          },
        ],
      },
    },
    nodePrefabs: {
      [prefabId]: {
        id: prefabId,
        sourceNode: makeTextSourceNode(),
      },
    },
    plugins: [],
    references: [],
  };
}

describe('NodePrefabResolver', () => {
  it('blocks graph-boundary and graph-reference nodes as source prefabs', () => {
    assert.equal(canUseNodeAsPrefabSource({ type: 'text' } as ChartNode), true);
    assert.equal(canUseNodeAsPrefabSource({ type: 'comment' } as ChartNode), false);
    assert.equal(canUseNodeAsPrefabSource({ type: 'graphInput' } as ChartNode), false);
    assert.equal(canUseNodeAsPrefabSource({ type: 'graphOutput' } as ChartNode), false);
    assert.equal(canUseNodeAsPrefabSource({ type: 'referencedGraphAlias' } as ChartNode), false);
    assert.equal(canUseNodeAsPrefabSource({ type: 'nodePrefabInstance' } as ChartNode), false);
  });

  it('resolves an instance to the source node semantics while keeping instance identity and placement', () => {
    const instanceNode = makePrefabInstance({
      visualData: { x: 100, y: 200, width: 260, color: { bg: 'instance-bg', border: 'instance-border' }, zIndex: 7 },
    });
    const resolvedNode = resolveNodePrefabInstance(makeProject(instanceNode), instanceNode);

    assert.equal(resolvedNode.id, instanceNode.id);
    assert.equal(resolvedNode.type, 'text');
    assert.equal(resolvedNode.title, 'Shared Text');
    assert.deepEqual(resolvedNode.data, { text: 'hello from prefab' });
    assert.deepEqual(resolvedNode.visualData, {
      x: 100,
      y: 200,
      width: 260,
      color: { bg: 'source-bg', border: 'source-border' },
      zIndex: 7,
    });
  });

  it('detaches a valid instance into an ordinary node without changing its effective behavior or placement', () => {
    const instanceNode = makePrefabInstance({
      visualData: { x: 100, y: 200, width: 260, zIndex: 7 },
    });
    const project = makeProject(instanceNode);
    project.nodePrefabs![prefabId]!.sourceNode = makeTextSourceNode({
      description: 'Library-owned description',
      disabled: true,
      isConditional: true,
      isSplitRun: true,
      splitRunConcurrency: 3,
      variants: [{ id: 'alternative', data: { text: 'alternative text' } }],
      tests: [{ id: 'test', evaluatorGraphId: graphId, tests: [] }],
    });

    const detachedNode = detachNodePrefabInstance(project, instanceNode);

    assert.ok(detachedNode);
    assert.equal(detachedNode.id, instanceNode.id);
    assert.equal(detachedNode.type, 'text');
    assert.equal(detachedNode.title, 'Shared Text');
    assert.equal(detachedNode.description, 'Library-owned description');
    assert.deepEqual(detachedNode.data, { text: 'hello from prefab' });
    assert.equal(detachedNode.disabled, true);
    assert.equal(detachedNode.isConditional, true);
    assert.equal(detachedNode.isSplitRun, true);
    assert.equal(detachedNode.splitRunConcurrency, 3);
    assert.deepEqual(detachedNode.variants, [{ id: 'alternative', data: { text: 'alternative text' } }]);
    assert.deepEqual(detachedNode.tests, [{ id: 'test', evaluatorGraphId: graphId, tests: [] }]);
    assert.deepEqual(detachedNode.visualData, {
      x: 100,
      y: 200,
      width: 260,
      color: { bg: 'source-bg', border: 'source-border' },
      zIndex: 7,
    });
  });

  it('does not detach ordinary or missing-source nodes', () => {
    const project = makeProject();

    assert.equal(detachNodePrefabInstance(project, makeTextSourceNode()), undefined);
    assert.equal(
      detachNodePrefabInstance(
        project,
        makePrefabInstance({ data: { prefabId: 'missing-prefab' as NodePrefabId } }),
      ),
      undefined,
    );
  });

  it('runs linked nodes as the source node and delivers outputs downstream', async () => {
    const project = makeProject();
    const processor = new GraphProcessor(project, graphId, globalRivetNodeRegistry);

    const outputs = await processor.processGraph(testProcessContext());

    assert.equal(outputs.result?.type, 'string');
    assert.equal(outputs.result?.value, 'hello from prefab');
  });

  it('fails clearly when execution reaches an instance whose source prefab is missing', async () => {
    const instanceNode = makePrefabInstance({ data: { prefabId: 'missing-prefab' as NodePrefabId } });
    const project = makeProject(instanceNode);
    project.nodePrefabs = {};
    const processor = new GraphProcessor(project, graphId, globalRivetNodeRegistry);

    await assert.rejects(
      () => processor.processGraph(testProcessContext()),
      /Missing library node \(missing-prefab\)/,
    );
  });

  it('keeps malformed source prefabs on the missing-source fallback node type', () => {
    const instanceNode = makePrefabInstance();
    const project = makeProject(instanceNode);
    project.nodePrefabs![prefabId]!.sourceNode = {
      id: 'invalid-source' as NodeId,
      type: 'graphOutput',
      title: 'Invalid Graph Output Source',
      visualData: { x: 0, y: 0, width: 240 },
      data: { id: 'output' },
    } as ChartNode<'graphOutput'>;

    const resolvedNode = resolveNodePrefabInstance(project, instanceNode);

    assert.equal(resolvedNode.id, instanceNode.id);
    assert.equal(resolvedNode.type, 'nodePrefabInstance');
    assert.equal(resolvedNode.title, `Missing library node (${prefabId})`);
  });
});
