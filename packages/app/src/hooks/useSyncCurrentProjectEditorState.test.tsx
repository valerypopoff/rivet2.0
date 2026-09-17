import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { JSDOM } from 'jsdom';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { createStore, Provider } from 'jotai';
import { createBlankProjectWithDefaultGraph } from '../utils/blankProject.js';
import { createRootGraphViewContext } from '../domain/graphEditing/navigationActions.js';
import { addOpenedProject } from '../utils/openedProjects.js';
import { graphState } from '../state/graph.js';
import { canvasPositionState, graphNavigationStackState } from '../state/graphBuilder.js';
import { projectState, projectsState } from '../state/savedGraphs.js';
import { projectEditorHydratedState, projectEditorStateByProjectIdState } from '../state/projectEditor.js';
import { projectWorkspaceTargetsState } from '../state/workspaceTarget.js';
import { configureHybridStorageBackend, flushHybridStorageGroup, MemoryAsyncStorage } from '../state/storage.js';
import { useCurrentProjectEditorSnapshot } from './useCurrentProjectEditorSnapshot.js';
import { useSyncCurrentProjectEditorState } from './useSyncCurrentProjectEditorState.js';

test('only an open graph workspace can replace its remembered viewport or create a reload checkpoint', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://rivet.test' });
  const globals = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const descriptors = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window },
    document: { configurable: true, value: dom.window.document },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  const previousBackend = configureHybridStorageBackend(new MemoryAsyncStorage());
  const store = createStore();
  const root = createRoot(dom.window.document.getElementById('root')!);
  const project = createBlankProjectWithDefaultGraph();
  const graphId = project.metadata.mainGraphId!;
  const graph = project.graphs[graphId]!;
  const emptyTabs = { openedProjects: {}, openedProjectsSortedIds: [] };
  const remembered = {
    navigationStack: { stack: [createRootGraphViewContext(graphId)], index: 0 },
    canvasPositionsByGraph: { [graphId]: { x: 190, y: 30, zoom: 0.75 } },
  };
  let snapshot: ReturnType<typeof useCurrentProjectEditorSnapshot>;
  function Harness() {
    snapshot = useCurrentProjectEditorSnapshot();
    useSyncCurrentProjectEditorState();
    return null;
  }

  try {
    // An empty workspace still hydrates its last loaded project and graph,
    // but its runtime-only canvas position starts at the default origin.
    store.set(projectState, project);
    store.set(graphState, graph);
    store.set(projectsState, emptyTabs);
    store.set(projectEditorStateByProjectIdState, { [project.metadata.id]: remembered });
    store.set(projectEditorHydratedState, true);
    await act(async () => root.render(<Provider store={store}><Harness /></Provider>));
    assert.deepEqual(store.get(projectEditorStateByProjectIdState)[project.metadata.id], remembered);
    assert.equal(snapshot!.persistCurrentProjectEditorSnapshot(), undefined);
    dom.window.dispatchEvent(new dom.window.PageTransitionEvent('pagehide'));
    assert.equal(dom.window.sessionStorage.length, 0);

    // Restoring and opening the tab gives it ownership; subsequent pans save.
    await act(async () => {
      store.set(canvasPositionState, remembered.canvasPositionsByGraph[graphId]!);
      store.set(graphNavigationStackState, remembered.navigationStack);
      store.set(projectsState, addOpenedProject(emptyTabs, project));
    });
    await act(async () => store.set(canvasPositionState, { x: 500, y: 600, zoom: 1.5 }));
    const updated = store.get(projectEditorStateByProjectIdState)[project.metadata.id]!;
    assert.deepEqual(updated.canvasPositionsByGraph[graphId], { x: 500, y: 600, zoom: 1.5 });

    // A resource canvas cannot be mistaken for that graph on save/close.
    await act(async () => {
      store.set(projectWorkspaceTargetsState, { [project.metadata.id]: { type: 'nodeLibrary' } });
      store.set(canvasPositionState, { x: 900, y: 800, zoom: 2 });
    });
    assert.equal(snapshot!.persistCurrentProjectEditorSnapshot(), undefined);
    dom.window.dispatchEvent(new dom.window.PageTransitionEvent('pagehide'));
    assert.deepEqual(store.get(projectEditorStateByProjectIdState)[project.metadata.id], updated);
    const checkpoint = JSON.parse(dom.window.sessionStorage.getItem('rivet-project-editor-reload-v1')!);
    assert.deepEqual(checkpoint.state, updated);
    dom.window.sessionStorage.clear();

    await act(async () => {
      store.set(projectsState, emptyTabs);
      store.set(projectWorkspaceTargetsState, {});
      store.set(canvasPositionState, { x: 0, y: 0, zoom: 1 });
    });
    dom.window.dispatchEvent(new dom.window.PageTransitionEvent('pagehide'));
    assert.equal(dom.window.sessionStorage.length, 0);
    assert.deepEqual(store.get(projectEditorStateByProjectIdState)[project.metadata.id], updated);
  } finally {
    await act(async () => root.unmount());
    await flushHybridStorageGroup('project');
    await flushHybridStorageGroup('graph');
    configureHybridStorageBackend(previousBackend);
    globals.forEach((key, index) => {
      const descriptor = descriptors[index];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    });
    dom.window.close();
  }
});
