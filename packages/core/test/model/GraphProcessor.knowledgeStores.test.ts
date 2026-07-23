import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  globalRivetNodeRegistry,
  GraphProcessor,
  registerKnowledgeStoreProvider,
  type GraphId,
  type NodeGraph,
  type NodeId,
  type PortId,
  type Project,
  type RivetKnowledgeStore,
} from '../../src/index.js';
import { testProcessContext } from '../testUtils.js';

describe('GraphProcessor knowledge-store lifecycle', () => {
  it('shares one lazy provider instance within a root run and recreates it for the next top-level run', async () => {
    const providerId = `processor-knowledge-${Date.now()}`;
    let factoryCalls = 0;
    let statusCalls = 0;
    registerKnowledgeStoreProvider({
      id: providerId,
      displayName: 'Processor test provider',
      supportedExecutors: ['nodejs'],
      connectionConfigSpec: [],
      createStore() {
        factoryCalls += 1;
        const store: RivetKnowledgeStore = {
          capabilities: {},
          async getSourceStatus({ source }) {
            statusCalls += 1;
            return {
              exists: true,
              source: { ...source, version: 'active' },
              activeVersion: 'active',
              message: 'ready',
            };
          },
          async syncSource() {
            throw new Error('not used');
          },
          async search() {
            throw new Error('not used');
          },
        };
        return store;
      },
    });

    const graphId = 'knowledge-lifecycle-graph' as GraphId;
    const sourceNodeId = 'source' as NodeId;
    const firstStatusId = 'first-status' as NodeId;
    const secondStatusId = 'second-status' as NodeId;
    const graph: NodeGraph = {
      metadata: { id: graphId, name: 'Knowledge lifecycle', description: '' },
      nodes: [
        {
          id: sourceNodeId,
          type: 'knowledgeSource',
          title: 'Knowledge Source',
          data: {
            connectionId: 'primary',
            useConnectionIdInput: false,
            sourceId: 'handbook',
            useSourceIdInput: false,
            version: '',
            useVersionInput: false,
          },
          visualData: { x: 0, y: 0, width: 240 },
        },
        ...[firstStatusId, secondStatusId].map((id) => ({
          id,
          type: 'getKnowledgeSourceStatus' as const,
          title: 'Get Knowledge Source Status',
          data: { expectedVersion: '', useExpectedVersionInput: false },
          visualData: { x: 300, y: 0, width: 260 },
        })),
        ...['first', 'second'].map((id, index) => ({
          id: `output-${id}` as NodeId,
          type: 'graphOutput' as const,
          title: 'Graph Output',
          data: { id, dataType: 'boolean' as const },
          visualData: { x: 600, y: index * 100, width: 220 },
        })),
      ],
      connections: [
        ...[firstStatusId, secondStatusId].map((statusId) => ({
          outputNodeId: sourceNodeId,
          outputId: 'source' as PortId,
          inputNodeId: statusId,
          inputId: 'source' as PortId,
        })),
        ...[firstStatusId, secondStatusId].map((statusId, index) => ({
          outputNodeId: statusId,
          outputId: 'exists' as PortId,
          inputNodeId: `output-${index === 0 ? 'first' : 'second'}` as NodeId,
          inputId: 'value' as PortId,
        })),
      ],
    };
    const project = {
      metadata: {
        id: 'knowledge-lifecycle-project',
        title: 'Knowledge lifecycle project',
        description: '',
        knowledgeStores: {
          primary: { displayName: 'Primary', provider: providerId, config: {} },
        },
      },
      graphs: { [graphId]: graph },
      plugins: [],
    } as unknown as Project;
    const processor = new GraphProcessor(project, graphId, globalRivetNodeRegistry);

    const firstRun = await processor.processGraph(testProcessContext());
    assert.deepEqual(
      { first: firstRun.first, second: firstRun.second },
      {
        first: { type: 'boolean', value: true },
        second: { type: 'boolean', value: true },
      },
    );
    assert.equal(factoryCalls, 1);
    assert.equal(statusCalls, 2);

    await processor.processGraph(testProcessContext());
    assert.equal(factoryCalls, 2);
    assert.equal(statusCalls, 4);
  });
});
