import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import React from 'react';
import { JSDOM } from 'jsdom';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { createStore, getDefaultStore, Provider } from 'jotai';
import { type ChartNode, type NodeId } from '@valerypopoff/rivet2-core';
import { HostUiConfigProvider, type RivetAppHostUiConfig } from '../providers/HostUiConfigContext.js';
import { graphState, nodesState } from '../state/graph.js';
import { projectState } from '../state/savedGraphs.js';
import { clipboardState } from '../state/clipboard.js';
import {
  canvasPositionState,
  editingNodeState,
  hoveringNodeState,
  lastMousePositionState,
  selectedNodesState,
} from '../state/graphBuilder.js';
import {
  dataBusFullRowCountState,
  deleteGraphInputConfirmState,
  overlayOpenState,
  uiFontSizeState,
  type GraphInputDeletionTarget,
} from '../state/ui.js';
import { projectBindingRegistryState } from '../state/projectBindings.js';
import { configureHybridStorageBackend, MemoryAsyncStorage } from '../state/storage.js';
import { createBlankProjectWithDefaultGraph } from '../utils/blankProject.js';
import { commandHistoryStackStatePerGraph, useRedo, useUndo } from '../commands/Command.js';
import { getCanvasClientOffset } from './useCanvasPositioning.js';
import { useCopyNodesHotkeys } from './useCopyNodesHotkeys.js';
import { useCopyNodes } from './useCopyNodes.js';
import { useDeleteNodesCommand } from '../commands/deleteNodeCommand.js';
import {
  makeGraph,
  makeGraphInputNode,
  makeSubGraphNode,
  makeTextNode,
  makeConnection,
} from '../domain/graphEditing/testGraphBuilders.js';

async function mount(t: TestContext, policy?: RivetAppHostUiConfig['nodeClipboard']) {
  const dom = new JSDOM(
    '<div id="root"></div><input/><textarea></textarea><select><option>x</option></select><div role="dialog"><button>Confirm</button></div>',
    { url: 'https://rivet.test/' },
  );
  const keys = ['React', 'document', 'localStorage', 'navigator', 'window', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const previous = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  const values = [React, dom.window.document, dom.window.localStorage, dom.window.navigator, dom.window, true];
  keys.forEach((key, index) => Object.defineProperty(globalThis, key, { configurable: true, value: values[index] }));
  const oldStorage = configureHybridStorageBackend(new MemoryAsyncStorage());
  const root = createRoot(dom.window.document.getElementById('root')!);
  t.after(async () => {
    try {
      await act(async () => root.unmount());
    } finally {
      configureHybridStorageBackend(oldStorage);
      keys.forEach((key, index) => {
        if (previous[index]) Object.defineProperty(globalThis, key, previous[index]!);
        else Reflect.deleteProperty(globalThis, key);
      });
      dom.window.close();
    }
  });
  const store = createStore();
  const project = createBlankProjectWithDefaultGraph();
  const graph = project.graphs[project.metadata.mainGraphId!]!;
  graph.nodes = ['a', 'b'].map(
    (id, index) =>
      ({
        id: id as NodeId,
        type: 'text',
        title: id,
        data: { text: id },
        visualData: { x: 100 + index * 400, y: 100, width: 200 },
      }) as ChartNode,
  );
  store.set(projectState, project);
  store.set(graphState, graph);
  let undo!: () => void;
  let redo!: () => void;
  let copy!: ReturnType<typeof useCopyNodes>;
  let remove!: ReturnType<typeof useDeleteNodesCommand>;
  function Harness() {
    useCopyNodesHotkeys();
    undo = useUndo();
    redo = useRedo();
    copy = useCopyNodes();
    remove = useDeleteNodesCommand();
    return null;
  }
  const render = (nextPolicy = policy) =>
    act(async () =>
      root.render(
        <Provider store={store}>
          <HostUiConfigProvider config={{ nodeClipboard: nextPolicy }}>
            <Harness />
          </HostUiConfigProvider>
        </Provider>,
      ),
    );
  await render();
  const fire = (key: string, target: EventTarget = dom.window.document.body, options: KeyboardEventInit = {}) => {
    const event = new dom.window.KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key,
      code: `Key${key.toUpperCase()}`,
      ctrlKey: true,
      ...options,
    });
    target.dispatchEvent(event);
    return event;
  };
  const native = (type: string, target: EventTarget = dom.window.document.body) => {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  };
  return {
    dom,
    store,
    graph,
    fire,
    native,
    undo: () => undo(),
    redo: () => redo(),
    copy: () => copy(),
    remove: (...args: Parameters<typeof remove>) => remove(...args),
    root,
    render,
  };
}

for (const nativeEvents of [false, true]) {
  test(`clipboard uses current provider state, canvas coordinates and undo history (native=${nativeEvents})`, async (t) => {
    const { store, fire, native, graph, undo, redo } = await mount(t, { nativeEvents });
    const defaultStore = getDefaultStore();
    const oldClipboard = defaultStore.get(clipboardState);
    t.after(() => defaultStore.set(clipboardState, oldClipboard));
    defaultStore.set(clipboardState, undefined);
    // Consecutive events have no intervening React render.
    act(() => {
      store.set(selectedNodesState, ['b' as NodeId]);
      assert.equal(fire('c').defaultPrevented, true);
      assert.equal(defaultStore.get(clipboardState), undefined);
      const copied = store.get(clipboardState);
      assert.equal(copied?.type, 'nodes');
      if (copied?.type !== 'nodes') throw new Error('Expected copied nodes');
      assert.deepEqual(
        copied.nodes.map((node) => node.id),
        ['b'],
      );
      store.set(canvasPositionState, { x: 20, y: -10, zoom: 2 });
      store.set(dataBusFullRowCountState, 2);
      store.set(uiFontSizeState, 14);
      const offset = getCanvasClientOffset(2, 14);
      assert.deepEqual(offset, { x: 0, y: 100 }, 'Two full Data Bus rows reserve client space');
      store.set(lastMousePositionState, { x: 640, y: 400 + offset.y });
      const event = nativeEvents ? native('paste') : fire('v');
      assert.equal(event.defaultPrevented, true);
      const nodes = store.get(nodesState);
      assert.equal(nodes.length, 3, 'One event must apply exactly one paste');
      assert.equal(nodes[2]!.visualData.x, 300);
      assert.equal(nodes[2]!.visualData.y, 210);
      assert.equal(store.get(commandHistoryStackStatePerGraph)[graph.metadata!.id!]!.length, 1);
    });
    await act(async () => undo());
    assert.equal(store.get(nodesState).length, 2);
    await act(async () => redo());
    assert.equal(store.get(nodesState).length, 3);
    act(() => {
      store.set(selectedNodesState, ['a' as NodeId]);
      const cut = nativeEvents ? native('cut') : fire('x');
      assert.equal(cut.defaultPrevented, true);
      assert.equal(store.get(nodesState).length, 2);
      const clipboard = store.get(clipboardState);
      assert.equal(clipboard?.type === 'nodes' && clipboard.nodes[0]!.id, 'a');
    });
    await act(async () => undo());
    assert.equal(store.get(nodesState).length, 3);
  });
}

test('hosted hovered-node fallback is opt-in and never permits hover-only cut', async (t) => {
  const { store, fire, native, root, render } = await mount(t);
  store.set(hoveringNodeState, 'a' as NodeId);
  assert.equal(fire('c').defaultPrevented, false);
  assert.equal(fire('d').defaultPrevented, false);
  assert.equal(native('copy').defaultPrevented, false);
  // Change policy without remounting the hook; no old listeners may survive.
  await render({ useHoveredNodeFallback: true, nativeEvents: true });
  act(() => {
    assert.equal(native('copy').defaultPrevented, true);
    assert.equal(native('cut').defaultPrevented, false);
    assert.equal(fire('d').defaultPrevented, true);
    assert.equal(store.get(nodesState).length, 3);
  });
  await render({ useHoveredNodeFallback: false, nativeEvents: false });
  assert.equal(native('copy').defaultPrevented, false);
  assert.equal(fire('d').defaultPrevented, false);
  await act(async () => root.unmount());
  assert.equal(fire('d').defaultPrevented, false, 'Unmount releases all clipboard listeners');
  assert.equal(native('paste').defaultPrevented, false);
});

test('text controls, modal focus, consumed events, IME and empty/graph clipboards retain their own keys', async (t) => {
  const { dom, store, fire, native } = await mount(t, { nativeEvents: true });
  act(() => {
    store.set(selectedNodesState, ['a' as NodeId]);
    for (const selector of ['input', 'textarea', 'select', 'button']) {
      const element = dom.window.document.querySelector<HTMLElement>(selector)!;
      element.focus();
      assert.equal(fire('x').defaultPrevented, false, `Active ${selector}`);
      element.blur();
      assert.equal(fire('x', element).defaultPrevented, false, `Target ${selector}`);
      assert.equal(native('cut', element).defaultPrevented, false);
    }
    const editable = dom.window.document.createElement('div');
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    dom.window.document.body.append(editable);
    assert.equal(fire('x', editable).defaultPrevented, false);
    for (const options of [{ altKey: true }, { shiftKey: true }, { isComposing: true }]) {
      assert.equal(fire('x', undefined, options).defaultPrevented, false);
    }
    const consumed = new dom.window.KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'x',
      ctrlKey: true,
    });
    consumed.preventDefault();
    dom.window.document.body.dispatchEvent(consumed);
    store.set(overlayOpenState, 'evaluations');
    assert.equal(fire('x').defaultPrevented, false);
    store.set(overlayOpenState, undefined);
    store.set(editingNodeState, 'a' as NodeId);
    assert.equal(fire('x').defaultPrevented, false);
    store.set(editingNodeState, null);
    store.set(clipboardState, { type: 'nodes', nodes: [], connections: [] });
    assert.equal(fire('v').defaultPrevented, false);
    assert.equal(native('paste').defaultPrevented, false);
    store.set(clipboardState, { type: 'graphs', source: 'graph', graphs: [] });
    assert.equal(fire('v').defaultPrevented, false);
    assert.equal(native('paste').defaultPrevented, false);
    assert.equal(store.get(nodesState).length, 2);
    assert.deepEqual(store.get(commandHistoryStackStatePerGraph), {});
  });
});

test('cut followed immediately by hover-only shortcuts cannot act on the deleted node', async (t) => {
  const { store, fire, native, graph, copy } = await mount(t, { nativeEvents: true, useHoveredNodeFallback: true });
  act(() => {
    store.set(selectedNodesState, ['a' as NodeId]);
    store.set(hoveringNodeState, 'a' as NodeId);
    assert.equal(native('cut').defaultPrevented, true);
    assert.deepEqual(
      store.get(nodesState).map((node) => node.id),
      ['b'],
    );
    const copied = store.get(clipboardState);
    const history = store.get(commandHistoryStackStatePerGraph)[graph.metadata!.id!]!;
    assert.equal(fire('d').defaultPrevented, false);
    assert.equal(native('copy').defaultPrevented, false);
    store.set(selectedNodesState, ['a' as NodeId]);
    for (const key of ['c', 'x', 'd']) assert.equal(fire(key).defaultPrevented, false, `Deleted selection: ${key}`);
    copy(); // Context-menu copy shares the same current-node filtering.
    assert.equal(store.get(clipboardState), copied, 'Stale hover must not erase the clipboard');
    assert.equal(store.get(commandHistoryStackStatePerGraph)[graph.metadata!.id!], history);
  });
});

test('native dialog buttons own clipboard keys even without an explicit ARIA role', async (t) => {
  const { dom, store, fire, native } = await mount(t, { nativeEvents: true });
  const dialog = dom.window.document.createElement('dialog');
  dialog.setAttribute('open', '');
  dialog.innerHTML = '<button>Confirm</button>';
  dom.window.document.body.append(dialog);
  const button = dialog.querySelector('button')!;
  button.focus();
  act(() => {
    store.set(selectedNodesState, ['a' as NodeId]);
    assert.equal(fire('x').defaultPrevented, false);
    assert.equal(native('cut', button).defaultPrevented, false);
    assert.equal(store.get(nodesState).length, 2);
    assert.deepEqual(store.get(commandHistoryStackStatePerGraph), {});
  });
});

test('an unfocused modal owns clipboard commands even when events are sent to the window', async (t) => {
  const { dom, store, fire, native } = await mount(t, { nativeEvents: true });
  const dialog = dom.window.document.querySelector('[role="dialog"]')!;
  act(() => {
    store.set(selectedNodesState, ['a' as NodeId]);
    fire('c');
    const clipboard = store.get(clipboardState);
    dialog.setAttribute('aria-modal', 'true');
    for (const key of ['x', 'd', 'v']) assert.equal(fire(key, dom.window).defaultPrevented, false);
    for (const type of ['copy', 'cut', 'paste']) assert.equal(native(type, dom.window).defaultPrevented, false);
    assert.equal(store.get(clipboardState), clipboard);
    assert.equal(store.get(nodesState).length, 2);
    assert.deepEqual(store.get(commandHistoryStackStatePerGraph), {});
  });
});

test('host inert locks block clipboard mutations and release cleanly', async (t) => {
  const { dom, store, fire } = await mount(t, { nativeEvents: true });
  const app = dom.window.document.getElementById('root')!;
  app.classList.add('app');
  act(() => {
    store.set(selectedNodesState, ['a' as NodeId]);
    for (const element of [dom.window.document.documentElement, dom.window.document.body, app]) {
      element.setAttribute('inert', '');
      assert.equal(fire('x', dom.window).defaultPrevented, false);
      element.removeAttribute('inert');
    }
    assert.equal(store.get(nodesState).length, 2);
    assert.equal(fire('d').defaultPrevented, true, 'Releasing the lock restores normal commands');
    assert.equal(store.get(nodesState).length, 3);
  });
});

test('delayed graph-input confirmations reject changed graph, project, binding and workspace identities', async (t) => {
  const { store, graph, remove } = await mount(t);
  const original = store.get(projectState);
  act(() => {
    const bindings = store.get(projectBindingRegistryState);
    for (const change of ['graph', 'project', 'binding', 'workspace']) {
      store.set(projectState, original);
      store.set(graphState, graph);
      bindings.reconcile(change === 'project' ? {} : { [original.metadata.id]: { path: 'Saved.rivet-project' } });
      const target: GraphInputDeletionTarget = {
        projectId: original.metadata.id,
        graphId: graph.metadata!.id,
        workspaceToken: bindings.getWorkspaceToken(),
        bindingToken: bindings.get(original.metadata.id)?.token,
      };
      if (change === 'graph')
        store.set(graphState, {
          ...graph,
          metadata: { ...graph.metadata, id: 'other-graph' as typeof target.graphId },
        });
      if (change === 'project')
        store.set(projectState, {
          ...original,
          metadata: { ...original.metadata, id: 'other-project' as typeof target.projectId },
        });
      if (change === 'binding') bindings.renew(original.metadata.id);
      if (change === 'workspace') {
        bindings.invalidateWorkspace();
        // Isolate the workspace guard rather than also relying on renewal of
        // the project binding, which workspace retirement performs as well.
        target.bindingToken = bindings.get(original.metadata.id)?.token;
      }
      remove({ nodeIds: ['a' as NodeId], skipGraphInputUsageConfirm: true, expectedTarget: target });
      assert.equal(store.get(nodesState).length, 2, change);
      assert.deepEqual(store.get(commandHistoryStackStatePerGraph), {}, change);
    }
  });
});

test('current graph-input confirmation preserves its captured selection and Undo', async (t) => {
  const { store, graph, remove, undo } = await mount(t);
  const original = store.get(projectState);
  const inputGraph = { ...graph, nodes: [makeGraphInputNode('a', 'foo'), graph.nodes[1]!] };
  const caller = makeGraph(
    'caller',
    [makeTextNode('source'), makeSubGraphNode('call', graph.metadata!.id!)],
    [makeConnection({ outputNodeId: 'source' as NodeId, inputNodeId: 'call' as NodeId })],
  );
  act(() => {
    store.set(projectState, { ...original, graphs: { ...original.graphs, [graph.metadata!.id!]: inputGraph, caller } });
    store.set(graphState, inputGraph);
    remove({ nodeIds: ['a' as NodeId] });
    const confirmation = store.get(deleteGraphInputConfirmState);
    assert.equal(confirmation?.usages.length, 1);
    assert.equal(store.get(nodesState).length, 2, 'Admission must not delete before confirmation');
    assert.ok(confirmation);
    store.set(selectedNodesState, ['b' as NodeId]);
    store.set(deleteGraphInputConfirmState, null);
    remove({ nodeIds: confirmation.nodeIds, skipGraphInputUsageConfirm: true, expectedTarget: confirmation.target });
    assert.deepEqual(
      store.get(nodesState).map((node) => node.id),
      ['b'],
    );
  });
  await act(async () => undo());
  assert.deepEqual(new Set(store.get(nodesState).map((node) => node.id)), new Set(['a', 'b']));
});
