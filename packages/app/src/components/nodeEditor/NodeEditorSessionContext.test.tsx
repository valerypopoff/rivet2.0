import assert from 'node:assert/strict';
import test from 'node:test';
import React, { StrictMode, type ReactNode } from 'react';
import { act } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { createStore, Provider, useAtomValue } from 'jotai';
import {
  getSubgraphProjectKey,
  type ChartNode,
  type NodeGraph,
  type Project,
  type SubGraphNode,
} from '@valerypopoff/rivet2-core';
import { graphState, nodesState, isReadOnlyGraphState } from '../../state/graph.js';
import { projectState, projectsState, referencedProjectsState } from '../../state/savedGraphs.js';
import { editingNodeState, nodeEditorSessionRevisionState } from '../../state/graphBuilder.js';
import { projectWorkspaceTargetsState } from '../../state/workspaceTarget.js';
import { configureHybridStorageBackend, MemoryAsyncStorage, memoryStorage } from '../../state/storage.js';
import {
  NodeEditorSessionContext,
  useNodeEditorDataChange,
  useNodeEditorSession,
  useNodeEditorSessionCallback,
} from './NodeEditorSessionContext.js';
import {
  readGraphCommandState,
  useCommand,
  useUndo,
  useRedo,
  commandHistoryStackStatePerGraph,
} from '../../commands/Command.js';
import { recoverableNodeConnectionsStatePerGraph } from '../../state/recoverableNodeConnections.js';
import { mergeNodeEditorChange } from '../../utils/nodeEditorSession.js';
import { SubgraphTargetEditor } from '../editors/custom/SubgraphTargetEditor.js';
import { ProvidersProvider } from '../../providers/ProvidersContext.js';

const node = {
  id: 'n',
  type: 'code',
  title: 'Node',
  data: { code: 'original', sibling: false },
  visualData: { x: 0, y: 0, width: 200 },
} as ChartNode<'code', { code: string; sibling: boolean }>;
const graph = { metadata: { id: 'g', name: 'Main' }, nodes: [node], connections: [] } as unknown as NodeGraph;
const project = {
  metadata: { id: 'A', title: 'A' },
  graphs: { g: graph },
  plugins: [],
  references: [],
} as unknown as Project;

function fixture(selectedNode: ChartNode = node) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const descriptors = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const originalMemory = new Map(memoryStorage);
  memoryStorage.clear();
  const backend = configureHybridStorageBackend(new MemoryAsyncStorage());
  const store = createStore();
  store.set(projectState, project);
  store.set(graphState, { ...graph, nodes: [selectedNode] });
  store.set(editingNodeState, selectedNode.id);
  const root = createRoot(document.getElementById('root')!);
  let session!: ReturnType<typeof useNodeEditorSession>;
  let change!: (key: string, value: unknown) => void;
  let boundary!: (value: string) => void;
  function Field() {
    change = useNodeEditorDataChange(selectedNode, (changed, _, before) =>
      store.set(nodesState, (nodes) =>
        nodes.map((entry) =>
          entry.id === changed.id ? mergeNodeEditorChange(entry, before ?? selectedNode, changed) : entry,
        ),
      ),
    );
    return null;
  }
  function Probe({ library, variant, children }: { library: boolean; variant?: string; children?: ReactNode }) {
    session = useNodeEditorSession(selectedNode, library, variant);
    const owner = session;
    boundary = useNodeEditorSessionCallback(owner, (value: string) => {
      if (owner.canWrite()) change('code', value);
    });
    return (
      <NodeEditorSessionContext.Provider value={session}>
        <Field />
        {children}
      </NodeEditorSessionContext.Provider>
    );
  }
  return {
    store,
    root,
    get session() {
      return session;
    },
    get change() {
      return change;
    },
    get boundary() {
      return boundary;
    },
    render: async (library = false, variant?: string, children?: ReactNode) =>
      act(async () =>
        root.render(
          <StrictMode>
            <Provider store={store}>
              <Probe library={library} variant={variant}>
                {children}
              </Probe>
            </Provider>
          </StrictMode>,
        ),
      ),
    cleanup: async () => {
      await act(async () => root.unmount());
      configureHybridStorageBackend(backend);
      memoryStorage.clear();
      for (const [key, value] of originalMemory) memoryStorage.set(key, value);
      dom.window.close();
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test('the session and field commit use the selected node rather than the fixture default', async () => {
  const selectedNode = { ...node, id: 'another-node' as ChartNode['id'] };
  const f = fixture(selectedNode);
  try {
    await f.render();
    assert.equal(f.session.canWrite(), true);
    assert.equal(f.session.getNode()?.id, selectedNode.id);
    await act(async () => f.change('code', 'selected node edit'));
    assert.equal((f.store.get(nodesState)[0]!.data as typeof node.data).code, 'selected node edit');
  } finally {
    await f.cleanup();
  }
});

test('node data commits synchronously and builds on newer sibling fields without a render', async () => {
  const f = fixture();
  try {
    await f.render();
    assert.equal(f.session.canWrite(), true, 'StrictMode cleanup must not invalidate the mounted owner');
    await act(async () => {
      f.change('sibling', true);
      f.change('code', 'last keystroke');
      assert.deepEqual(f.store.get(nodesState)[0]!.data, { code: 'last keystroke', sibling: true });
      assert.deepEqual(readGraphCommandState(f.store).nodes[0]!.data, { code: 'last keystroke', sibling: true });
      f.change('code', 'original');
      assert.deepEqual(f.store.get(nodesState)[0]!.data, { code: 'original', sibling: true });
    });
  } finally {
    await f.cleanup();
  }
});

test('batched A -> B -> A expires old callbacks and cancels async work before React renders', async () => {
  const f = fixture();
  try {
    await f.render();
    const old = f.session;
    const oldChange = f.change;
    const abort = new AbortController();
    old.onRetire(() => abort.abort());
    await act(async () => {
      f.store.set(projectState, {
        ...project,
        metadata: { ...project.metadata, id: 'B' as Project['metadata']['id'] },
      });
      f.store.set(projectState, project);
      oldChange('code', 'late stale callback');
    });
    assert.equal(old.canWrite(), false);
    assert.equal(abort.signal.aborted, true);
    assert.equal((f.store.get(nodesState)[0]!.data as typeof node.data).code, 'original');
    assert.notEqual(f.session, old, 'the returned owner must receive a fresh lifetime');
    assert.equal(f.session.canWrite(), true);
    await act(async () => f.change('code', 'fresh owner edit'));
    assert.equal((f.store.get(nodesState)[0]!.data as typeof node.data).code, 'fresh owner edit');
  } finally {
    await f.cleanup();
  }
});

test('a retained boundary callback cannot borrow a fresh session after a batched round trip', async () => {
  const f = fixture();
  try {
    await f.render();
    const oldBoundary = f.boundary;
    await act(async () => {
      f.store.set(projectState, {
        ...project,
        metadata: { ...project.metadata, id: 'B' as Project['metadata']['id'] },
      });
      f.store.set(projectState, project);
    });
    assert.equal(f.session.canWrite(), true);
    await act(async () => oldBoundary('retired request result'));
    assert.equal((f.store.get(nodesState)[0]!.data as typeof node.data).code, 'original');
    await act(async () => f.boundary('current request result'));
    assert.equal((f.store.get(nodesState)[0]!.data as typeof node.data).code, 'current request result');
  } finally {
    await f.cleanup();
  }
});

test('same-ID replacement, read-only entry and deleted nodes fail closed', async () => {
  for (const invalidate of [
    (store: ReturnType<typeof createStore>) => store.set(nodeEditorSessionRevisionState, (revision) => revision + 1),
    (store: ReturnType<typeof createStore>) => store.set(isReadOnlyGraphState, true),
    (store: ReturnType<typeof createStore>) => store.set(nodesState, []),
    (store: ReturnType<typeof createStore>) => store.set(editingNodeState, null),
  ]) {
    const f = fixture();
    try {
      await f.render();
      const old = f.session;
      const oldChange = f.change;
      await act(async () => {
        invalidate(f.store);
        oldChange('code', 'stale');
      });
      assert.equal(old.canWrite(), false);
      assert.equal(
        f.store.get(nodesState).some((entry) => (entry.data as typeof node.data).code === 'stale'),
        false,
      );
    } finally {
      await f.cleanup();
    }
  }
});

test('a renewed Subgraph session releases retired loading and rejects its reference writes', async () => {
  const subgraph = {
    ...node,
    type: 'subGraph',
    data: { graphId: 'g', targetScope: 'other-projects', targetProjectId: 'external', targetVersion: 'latest' },
  } as SubGraphNode;
  const f = fixture(subgraph);
  try {
    const externalProject = {
      ...project,
      metadata: { ...project.metadata, id: 'external' as Project['metadata']['id'] },
    };
    let hold = false;
    let resolve!: (value: Project) => void;
    const pending = new Promise<Project>((done) => {
      resolve = done;
    });
    const catalog = {
      listTree: async () => ({ folders: [], projects: [] }),
      preview: async () => (hold ? pending : externalProject),
      openGraph() {},
    };
    function Editor() {
      const current = useAtomValue(nodesState)[0]!;
      return (
        <ProvidersProvider providers={{ subgraphProjectCatalog: catalog }}>
          <SubgraphTargetEditor
            node={current}
            isReadonly={false}
            isDisabled={false}
            onChange={(changed) => f.store.set(nodesState, [changed])}
          />
        </ProvidersProvider>
      );
    }
    await f.render(false, undefined, <Editor />);
    const publishedButton = () =>
      [...document.querySelectorAll('button')].find((button) => button.textContent === 'Published')!;
    const latestButton = () =>
      [...document.querySelectorAll('button')].find((button) => button.textContent === 'Saved latest')!;
    assert.equal(publishedButton().disabled, false);
    hold = true;
    await act(async () => publishedButton().dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    assert.equal(publishedButton().disabled, true);
    assert.equal(latestButton().disabled, true);
    await act(async () => {
      f.store.set(projectState, {
        ...project,
        metadata: { ...project.metadata, id: 'B' as Project['metadata']['id'] },
      });
      f.store.set(projectState, project);
    });
    assert.equal(f.session.canWrite(), true);
    assert.equal(latestButton().disabled, false, 'retired work cannot leave the fresh session blocked');
    await act(async () => resolve(externalProject));
    assert.equal((f.store.get(nodesState)[0]!.data as typeof subgraph.data).targetVersion, 'latest');
    assert.equal(
      Object.hasOwn(
        f.store.get(referencedProjectsState),
        getSubgraphProjectKey({ projectId: 'external' as Project['metadata']['id'], version: 'published' }),
      ),
      false,
    );
    hold = false;
    await act(async () => publishedButton().dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    assert.equal((f.store.get(nodesState)[0]!.data as typeof subgraph.data).targetVersion, 'published');
  } finally {
    await f.cleanup();
  }
});

test('closing and reopening a tab cannot revive its field callbacks', async () => {
  const f = fixture();
  try {
    const opened = {
      openedProjects: { [project.metadata.id]: { projectId: project.metadata.id, title: 'A' } },
      openedProjectsSortedIds: [project.metadata.id],
    };
    f.store.set(projectsState, opened);
    await f.render();
    const old = f.session;
    const oldChange = f.change;
    await act(async () => {
      f.store.set(projectsState, { openedProjects: {}, openedProjectsSortedIds: [] });
      f.store.set(projectsState, opened);
      oldChange('code', 'late');
    });
    assert.equal(old.canWrite(), false);
    assert.equal((f.store.get(nodesState)[0]!.data as typeof node.data).code, 'original');
    assert.notEqual(f.session, old);
    assert.equal(f.session.canWrite(), true);
  } finally {
    await f.cleanup();
  }
});

test('variant fields are read-only while library sources retain their own live authority', async () => {
  const f = fixture();
  try {
    await f.render(false, 'preview');
    assert.equal(f.session.isCurrent(), true);
    assert.equal(f.session.canWrite(), false);
    await act(async () => {
      f.store.set(projectState, {
        ...project,
        nodePrefabs: { prefab: { id: 'prefab', sourceNode: node } },
      } as unknown as Project);
      f.store.set(projectWorkspaceTargetsState, { A: { type: 'nodeLibrary', editingPrefabId: 'prefab' } } as any);
    });
    await f.render(true);
    assert.equal(f.session.canWrite(), true);
    assert.equal(f.session.getNode()?.id, node.id);
    const old = f.session;
    await act(async () =>
      f.store.set(projectWorkspaceTargetsState, { A: { type: 'uiGraph', uiGraphId: 'ui' } } as any),
    );
    assert.equal(old.canWrite(), false);
  } finally {
    await f.cleanup();
  }
});

test('library sessions use the exact prefab even when imported sources share node IDs', async () => {
  const f = fixture();
  try {
    f.store.set(projectState, {
      ...project,
      nodePrefabs: {
        first: { id: 'first', sourceNode: node },
        second: { id: 'second', sourceNode: { ...node, data: { ...node.data, code: 'second' } } },
      },
    } as unknown as Project);
    f.store.set(projectWorkspaceTargetsState, { A: { type: 'nodeLibrary', editingPrefabId: 'second' } } as any);
    await f.render(true);
    const second = f.session;
    assert.equal(second.canWrite(), true);
    assert.equal((second.getNode()!.data as typeof node.data).code, 'second');
    await act(async () =>
      f.store.set(projectWorkspaceTargetsState, {
        A: { type: 'nodeLibrary', editingPrefabId: 'first' },
      } as any),
    );
    assert.equal(second.canWrite(), false);
    assert.equal(f.session.canWrite(), true);
    assert.notEqual(f.session.modelScope, second.modelScope);
    assert.equal((f.session.getNode()!.data as typeof node.data).code, 'original');
  } finally {
    await f.cleanup();
  }
});

test('consecutive graph commands see preceding writes instead of the React render snapshot', async () => {
  const f = fixture();
  try {
    let command!: (text: string) => unknown;
    function Commands() {
      command = useCommand<string, string>({
        type: 'test',
        apply(text, _, current) {
          const data = current.nodes[0]!.data as typeof node.data;
          const previous = data.code;
          f.store.set(nodesState, [{ ...current.nodes[0]!, data: { ...data, code: previous + text } }]);
          return previous;
        },
        undo() {},
      });
      return null;
    }
    await act(async () =>
      f.root.render(
        <Provider store={f.store}>
          <Commands />
        </Provider>,
      ),
    );
    await act(async () => {
      command('-one');
      command('-two');
    });
    assert.equal((f.store.get(nodesState)[0]!.data as typeof node.data).code, 'original-one-two');
  } finally {
    await f.cleanup();
  }
});

test('cloned graph IDs have independent Undo, Redo and wire-recovery authority', async () => {
  const f = fixture();
  try {
    let command!: (text: string) => unknown;
    let undo!: () => void;
    let redo!: () => void;
    function Commands() {
      undo = useUndo();
      redo = useRedo();
      command = useCommand<string, string>({
        type: 'test',
        apply(text, _, current) {
          const previous = (current.nodes[0]!.data as typeof node.data).code;
          f.store.set(nodesState, [{ ...current.nodes[0]!, data: { ...node.data, code: text } }]);
          return previous;
        },
        undo(_, previous, current) {
          f.store.set(nodesState, [{ ...current.nodes[0]!, data: { ...node.data, code: previous } }]);
        },
      });
      return null;
    }
    await act(async () =>
      f.root.render(
        <Provider store={f.store}>
          <Commands />
        </Provider>,
      ),
    );
    const b = { ...project, metadata: { ...project.metadata, id: 'B' as Project['metadata']['id'] } };
    await act(async () => {
      command('edited-A');
      f.store.set(recoverableNodeConnectionsStatePerGraph, { g: { n: [] } } as any);
      f.store.set(projectState, b);
      f.store.set(graphState, graph);
      assert.equal(f.store.get(commandHistoryStackStatePerGraph)[graph.metadata!.id!] ?? null, null);
      assert.deepEqual(f.store.get(recoverableNodeConnectionsStatePerGraph), {});
      command('edited-B');
    });
    const bGraph = f.store.get(graphState);
    await act(async () => {
      f.store.set(projectState, project);
      f.store.set(graphState, { ...graph, nodes: [{ ...node, data: { ...node.data, code: 'edited-A' } }] });
      undo();
      assert.equal((f.store.get(nodesState)[0]!.data as typeof node.data).code, 'original');
      redo();
      assert.equal((f.store.get(nodesState)[0]!.data as typeof node.data).code, 'edited-A');
      f.store.set(projectState, b);
      f.store.set(graphState, bGraph);
      assert.equal(f.store.get(commandHistoryStackStatePerGraph)[graph.metadata!.id!]!.length, 1);
      undo();
      assert.equal((f.store.get(nodesState)[0]!.data as typeof node.data).code, 'original');
    });
  } finally {
    await f.cleanup();
  }
});
