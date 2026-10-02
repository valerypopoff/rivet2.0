import assert from 'node:assert/strict';
import test from 'node:test';
import { createStore } from 'jotai';
import type {
  ChartNode,
  GraphId,
  NodeGraph,
  NodePrefabId,
  NodeRegistration,
  Project,
  PortId,
} from '@valerypopoff/rivet2-core';
import { graphState, isReadOnlyGraphState } from './graph.js';
import { projectState } from './savedGraphs.js';
import { nodeEditorSessionRevisionState } from './graphBuilder.js';
import { projectWorkspaceTargetsState } from './workspaceTarget.js';
import { configureHybridStorageBackend, MemoryAsyncStorage, memoryStorage } from './storage.js';
import { updateNodeLibraryState } from './nodeLibrary.js';
import { recoverableNodeConnectionsStatePerGraph } from './recoverableNodeConnections.js';

const node = {
  id: 'source',
  type: 'code',
  title: 'Source',
  data: { code: 'original' },
  visualData: { x: 0, y: 0 },
} as ChartNode;
const graph = { metadata: { id: 'g', name: 'Main' }, nodes: [node], connections: [] } as unknown as NodeGraph;
const project = {
  metadata: { id: 'A', title: 'A' },
  graphs: { g: graph },
  plugins: [],
  references: [],
  nodePrefabs: {
    first: { id: 'first', sourceNode: node },
    second: { id: 'second', sourceNode: { ...node, id: 'second-source' } },
  },
} as unknown as Project;
const registry = {} as NodeRegistration<any, any>;
const graphId = 'g' as GraphId;

function fixture() {
  const original = new Map(memoryStorage);
  memoryStorage.clear();
  const backend = configureHybridStorageBackend(new MemoryAsyncStorage());
  const store = createStore();
  store.set(projectState, project);
  store.set(graphState, graph);
  store.set(projectWorkspaceTargetsState, { A: { type: 'nodeLibrary' } } as any);
  const input = { projectId: project.metadata.id, revision: store.get(nodeEditorSessionRevisionState), registry };
  return {
    store,
    input,
    cleanup() {
      configureHybridStorageBackend(backend);
      memoryStorage.clear();
      for (const [key, value] of original) memoryStorage.set(key, value);
    },
  };
}

test('library transactions preserve consecutive source edits, project changes and the live graph overlay', () => {
  const f = fixture();
  try {
    f.store.set(projectState, { ...project, metadata: { ...project.metadata, title: 'New title' } });
    const liveGraph = { ...graph, nodes: [{ ...node, title: 'Live unsaved graph node' }] };
    f.store.set(graphState, liveGraph);
    let inconsistent = false;
    const stop = f.store.sub(projectState, () => {
      if (f.store.get(projectState).graphs[graphId] !== f.store.get(graphState)) inconsistent = true;
    });
    for (const prefabId of ['first', 'second']) {
      assert.equal(
        f.store.set(updateNodeLibraryState, {
          ...f.input,
          update(prefabs) {
            const prefab = prefabs[prefabId as keyof typeof prefabs]!;
            prefab.sourceNode.data = { code: `edited-${prefabId}` };
          },
        }),
        true,
      );
    }
    stop();
    const result = f.store.get(projectState);
    assert.equal(result.metadata.title, 'New title');
    assert.deepEqual(
      Object.values(result.nodePrefabs!).map((entry) => entry.sourceNode.data),
      [{ code: 'edited-first' }, { code: 'edited-second' }],
    );
    assert.equal(result.graphs[graphId]!.nodes[0]!.title, 'Live unsaved graph node');
    assert.equal(result.graphs[graphId], f.store.get(graphState));
    assert.equal(inconsistent, false, 'subscribers must see the committed project and overlay together');
  } finally {
    f.cleanup();
  }
});

test('retired library owners cannot invoke mutations, while explicit rejection discards a draft', () => {
  const invalidations = [
    (store: ReturnType<typeof createStore>) =>
      store.set(projectState, { ...project, metadata: { ...project.metadata, id: 'B' as any } }),
    (store: ReturnType<typeof createStore>) => store.set(nodeEditorSessionRevisionState, (n) => n + 1),
    (store: ReturnType<typeof createStore>) =>
      store.set(projectWorkspaceTargetsState, { A: { type: 'graph', graphId: 'g' } } as any),
    (store: ReturnType<typeof createStore>) => store.set(isReadOnlyGraphState, true),
    () => {},
  ];
  for (const [index, invalidate] of invalidations.entries()) {
    const f = fixture();
    try {
      invalidate(f.store);
      const before = f.store.get(projectState);
      const overlay = f.store.get(graphState);
      let called = false;
      assert.equal(
        f.store.set(updateNodeLibraryState, {
          ...f.input,
          update(prefabs) {
            called = true;
            delete prefabs['first' as NodePrefabId];
            return false;
          },
        }),
        false,
      );
      assert.equal(f.store.get(projectState), before);
      assert.equal(f.store.get(graphState), overlay);
      assert.equal(called, index === invalidations.length - 1);
    } finally {
      f.cleanup();
    }
  }
});

test('failed linked-node reconciliation leaves sources, graphs and recovery state unchanged', () => {
  const f = fixture();
  try {
    const linkedGraph = {
      ...graph,
      nodes: [{ ...node, type: 'nodePrefabInstance', data: { prefabId: 'first' } }],
    };
    f.store.set(graphState, linkedGraph);
    const before = f.store.get(projectState);
    const recoveryBefore = f.store.get(recoverableNodeConnectionsStatePerGraph);
    const brokenRegistry = {
      createDynamicImpl() {
        throw new Error('Unavailable plugin');
      },
    } as unknown as NodeRegistration<any, any>;
    assert.throws(
      () =>
        f.store.set(updateNodeLibraryState, {
          ...f.input,
          registry: brokenRegistry,
          update(prefabs) {
            prefabs['first' as NodePrefabId]!.sourceNode.title = 'Must not commit';
          },
        }),
      /Unavailable plugin/,
    );
    assert.equal(f.store.get(projectState), before);
    assert.equal(f.store.get(graphState), linkedGraph);
    assert.equal(f.store.get(recoverableNodeConnectionsStatePerGraph), recoveryBefore);
  } finally {
    f.cleanup();
  }
});

test('a wire deleted in the live graph is not reintroduced through stale snapshot reconciliation', () => {
  const f = fixture();
  try {
    const linkedGraph = {
      ...graph,
      nodes: [
        { ...node, id: 'upstream', type: 'upstream' },
        { ...node, id: 'instance', type: 'nodePrefabInstance', data: { prefabId: 'first' } },
      ],
      connections: [{ outputNodeId: 'upstream', outputId: 'out', inputNodeId: 'instance', inputId: 'optional' }],
    } as unknown as NodeGraph;
    const firstId = 'first' as NodePrefabId;
    f.store.set(projectState, {
      ...project,
      graphs: { [graphId]: linkedGraph },
      nodePrefabs: {
        ...project.nodePrefabs,
        [firstId]: { ...project.nodePrefabs![firstId]!, sourceNode: { ...node, data: { exposed: true } } },
      },
    });
    f.store.set(graphState, { ...linkedGraph, connections: [] });
    const portsRegistry = {
      createDynamicImpl(source: ChartNode) {
        return {
          getInputDefinitionsIncludingBuiltIn() {
            return (source.data as { exposed?: boolean }).exposed
              ? [{ id: 'optional' as PortId, title: 'Optional', dataType: 'string' }]
              : [];
          },
          getOutputDefinitions() {
            return source.type === 'upstream' ? [{ id: 'out' as PortId, title: 'Output', dataType: 'string' }] : [];
          },
        };
      },
    } as unknown as NodeRegistration<any, any>;
    for (const exposed of [false, true]) {
      f.store.set(updateNodeLibraryState, {
        ...f.input,
        registry: portsRegistry,
        update(prefabs) {
          prefabs['first' as NodePrefabId]!.sourceNode.data = { exposed };
        },
      });
      assert.deepEqual(f.store.get(graphState).connections, []);
      assert.deepEqual(Object.values(f.store.get(recoverableNodeConnectionsStatePerGraph)[graphId] ?? {}).flat(), []);
    }
  } finally {
    f.cleanup();
  }
});
