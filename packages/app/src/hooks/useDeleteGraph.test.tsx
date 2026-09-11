import assert from 'node:assert/strict';
import test from 'node:test';
import type { GraphId, NodeGraph, Project, ProjectId } from '@valerypopoff/rivet2-core';
import React from 'react';
import { JSDOM } from 'jsdom';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { getDefaultStore } from 'jotai';

import { useDeleteGraphs } from './useDeleteGraph.js';
import { graphState } from '../state/graph.js';
import { frozenNodeOutputsState, runningGraphsState } from '../state/dataFlow.js';
import { projectState } from '../state/savedGraphs.js';
import { graphNavigationStackState, lastCanvasPositionByGraphState } from '../state/graphBuilder.js';
import { recoverableNodeConnectionsStatePerGraph } from '../state/recoverableNodeConnections.js';
import { projectEditorStateByProjectIdState } from '../state/projectEditor.js';
import { projectWorkspaceTargetsState, setProjectWorkspaceTargetState } from '../state/workspaceTarget.js';
import { createRootGraphViewContext } from '../domain/graphEditing/navigationActions.js';

function makeGraph(id: string, name: string, nodes: NodeGraph['nodes'] = []): NodeGraph {
  return {
    metadata: {
      id: id as GraphId,
      name,
      description: '',
    },
    nodes,
    connections: [],
  };
}

function makeProject(graphs: NodeGraph[], mainGraphId?: string): Omit<Project, 'data'> {
  return {
    metadata: {
      id: 'delete-graph-project' as ProjectId,
      title: 'Delete graph project',
      description: '',
      mainGraphId: mainGraphId as GraphId | undefined,
    },
    graphs: Object.fromEntries(graphs.map((graph) => [graph.metadata!.id!, graph])),
    plugins: [],
  };
}

test('deleting an inactive graph keeps the active graph and its unsaved edits intact', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const restoreGlobals = installDomGlobals(dom);
  const root = createRoot(dom.window.document.getElementById('root')!);
  const store = getDefaultStore();
  const previousProject = store.get(projectState);
  const previousGraph = store.get(graphState);
  const previousFrozenOutputs = store.get(frozenNodeOutputsState);
  const activeGraph = makeGraph('active-graph', 'Active graph', [{ id: 'unsaved-node' } as never]);
  const deletedGraph = makeGraph('deleted-graph', 'Deleted graph');
  let deleteGraphs: ReturnType<typeof useDeleteGraphs> | undefined;

  const Harness = () => {
    deleteGraphs = useDeleteGraphs();
    return null;
  };

  try {
    store.set(projectState, makeProject([activeGraph, deletedGraph], activeGraph.metadata!.id));
    store.set(graphState, activeGraph);
    store.set(frozenNodeOutputsState, {});

    await act(async () => {
      root.render(<Harness />);
    });
    assert.ok(deleteGraphs);

    await act(async () => {
      assert.deepEqual(deleteGraphs!([deletedGraph.metadata!.id!]).deletedGraphIds, [deletedGraph.metadata!.id]);
    });

    assert.deepEqual(store.get(graphState), activeGraph);
    assert.deepEqual(Object.keys(store.get(projectState).graphs), ['active-graph']);
    assert.equal(store.get(projectState).metadata.mainGraphId, activeGraph.metadata!.id);
  } finally {
    await act(async () => {
      root.unmount();
      store.set(projectState, previousProject);
      store.set(graphState, previousGraph);
      store.set(frozenNodeOutputsState, previousFrozenOutputs);
    });
    restoreGlobals();
    dom.window.close();
  }
});

test('deleting the active graph removes it and displays an unsaved placeholder', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const restoreGlobals = installDomGlobals(dom);
  const root = createRoot(dom.window.document.getElementById('root')!);
  const store = getDefaultStore();
  const previousProject = store.get(projectState);
  const previousGraph = store.get(graphState);
  const previousFrozenOutputs = store.get(frozenNodeOutputsState);
  const deletedGraph = makeGraph('deleted-graph', 'Deleted graph');
  let deleteGraphs: ReturnType<typeof useDeleteGraphs> | undefined;

  const Harness = () => {
    deleteGraphs = useDeleteGraphs();
    return null;
  };

  try {
    store.set(projectState, makeProject([deletedGraph], deletedGraph.metadata!.id));
    store.set(graphState, deletedGraph);
    store.set(frozenNodeOutputsState, {});

    await act(async () => {
      root.render(<Harness />);
    });
    assert.ok(deleteGraphs);

    await act(async () => {
      assert.deepEqual(deleteGraphs!([deletedGraph.metadata!.id!]).deletedGraphIds, [deletedGraph.metadata!.id]);
    });

    const placeholder = store.get(graphState);
    assert.deepEqual(store.get(projectState).graphs, {});
    assert.equal(store.get(projectState).metadata.mainGraphId, undefined);
    assert.notEqual(placeholder.metadata?.id, deletedGraph.metadata?.id);
    assert.deepEqual(placeholder.nodes, []);
    assert.deepEqual(placeholder.connections, []);
  } finally {
    await act(async () => {
      root.unmount();
      store.set(projectState, previousProject);
      store.set(graphState, previousGraph);
      store.set(frozenNodeOutputsState, previousFrozenOutputs);
    });
    restoreGlobals();
    dom.window.close();
  }
});

test('deleting a graph clears graph-scoped state and remaps the surviving navigation selection', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const restoreGlobals = installDomGlobals(dom);
  const root = createRoot(dom.window.document.getElementById('root')!);
  const store = getDefaultStore();
  const previousProject = store.get(projectState);
  const previousGraph = store.get(graphState);
  const previousFrozenOutputs = store.get(frozenNodeOutputsState);
  const previousRunningGraphs = store.get(runningGraphsState);
  const previousNavigationStack = store.get(graphNavigationStackState);
  const previousCanvasPositions = store.get(lastCanvasPositionByGraphState);
  const previousRecoverableConnections = store.get(recoverableNodeConnectionsStatePerGraph);
  const previousProjectEditorState = store.get(projectEditorStateByProjectIdState);
  const previousWorkspaceTargets = store.get(projectWorkspaceTargetsState);
  const retainedGraph = makeGraph('retained-graph', 'Retained graph');
  const deletedGraph = makeGraph('deleted-graph', 'Deleted graph');
  const project = makeProject([retainedGraph, deletedGraph], retainedGraph.metadata!.id);
  const projectId = project.metadata.id;
  let deleteGraphs: ReturnType<typeof useDeleteGraphs> | undefined;

  const Harness = () => {
    deleteGraphs = useDeleteGraphs();
    return null;
  };

  try {
    store.set(projectState, project);
    store.set(graphState, retainedGraph);
    store.set(frozenNodeOutputsState, { [deletedGraph.metadata!.id!]: {} } as never);
    store.set(recoverableNodeConnectionsStatePerGraph, {
      [deletedGraph.metadata!.id!]: { 'deleted-node': [] },
    } as never);
    store.set(lastCanvasPositionByGraphState, {
      [deletedGraph.metadata!.id!]: { x: 1, y: 2, zoom: 1 },
      [retainedGraph.metadata!.id!]: { x: 3, y: 4, zoom: 2 },
    });
    store.set(graphNavigationStackState, {
      stack: [
        createRootGraphViewContext(deletedGraph.metadata!.id!),
        createRootGraphViewContext(retainedGraph.metadata!.id!),
      ],
      index: 1,
    });
    store.set(projectEditorStateByProjectIdState, {
      [projectId]: {
        navigationStack: {
          stack: [
            createRootGraphViewContext(deletedGraph.metadata!.id!),
            createRootGraphViewContext(retainedGraph.metadata!.id!),
          ],
          index: 1,
        },
        canvasPositionsByGraph: {
          [deletedGraph.metadata!.id!]: { x: 1, y: 2, zoom: 1 },
          [retainedGraph.metadata!.id!]: { x: 3, y: 4, zoom: 2 },
        },
      },
    });
    store.set(setProjectWorkspaceTargetState, {
      projectId,
      target: { graphView: createRootGraphViewContext(deletedGraph.metadata!.id!), type: 'graph' },
    });

    await act(async () => {
      root.render(<Harness />);
    });
    assert.ok(deleteGraphs);

    await act(async () => {
      assert.deepEqual(deleteGraphs!([deletedGraph.metadata!.id!]).deletedGraphIds, [deletedGraph.metadata!.id]);
    });

    assert.equal(store.get(projectState).graphs[deletedGraph.metadata!.id!], undefined);
    assert.equal(store.get(frozenNodeOutputsState)[deletedGraph.metadata!.id!], undefined);
    assert.equal(store.get(recoverableNodeConnectionsStatePerGraph)[deletedGraph.metadata!.id!], undefined);
    assert.equal(store.get(lastCanvasPositionByGraphState)[deletedGraph.metadata!.id!], undefined);
    assert.deepEqual(store.get(graphNavigationStackState), {
      stack: [createRootGraphViewContext(retainedGraph.metadata!.id!)],
      index: 0,
    });
    assert.deepEqual(store.get(projectEditorStateByProjectIdState)[projectId], {
      navigationStack: {
        stack: [createRootGraphViewContext(retainedGraph.metadata!.id!)],
        index: 0,
      },
      canvasPositionsByGraph: {
        [retainedGraph.metadata!.id!]: { x: 3, y: 4, zoom: 2 },
      },
    });
    assert.equal(store.get(projectWorkspaceTargetsState)[projectId], undefined);
  } finally {
    await act(async () => {
      root.unmount();
      store.set(projectState, previousProject);
      store.set(graphState, previousGraph);
      store.set(frozenNodeOutputsState, previousFrozenOutputs);
      store.set(runningGraphsState, previousRunningGraphs);
      store.set(graphNavigationStackState, previousNavigationStack);
      store.set(lastCanvasPositionByGraphState, previousCanvasPositions);
      store.set(recoverableNodeConnectionsStatePerGraph, previousRecoverableConnections);
      store.set(projectEditorStateByProjectIdState, previousProjectEditorState);
      store.set(projectWorkspaceTargetsState, previousWorkspaceTargets);
    });
    restoreGlobals();
    dom.window.close();
  }
});

test('deleting a running graph leaves the project unchanged', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const restoreGlobals = installDomGlobals(dom);
  const root = createRoot(dom.window.document.getElementById('root')!);
  const store = getDefaultStore();
  const previousProject = store.get(projectState);
  const previousGraph = store.get(graphState);
  const previousRunningGraphs = store.get(runningGraphsState);
  const graph = makeGraph('running-graph', 'Running graph');
  let deleteGraphs: ReturnType<typeof useDeleteGraphs> | undefined;

  const Harness = () => {
    deleteGraphs = useDeleteGraphs();
    return null;
  };

  try {
    store.set(projectState, makeProject([graph], graph.metadata!.id));
    store.set(graphState, graph);
    store.set(runningGraphsState, [graph.metadata!.id!]);

    await act(async () => {
      root.render(<Harness />);
    });
    assert.ok(deleteGraphs);

    await act(async () => {
      assert.deepEqual(deleteGraphs!([graph.metadata!.id!]).blockedGraphIds, [graph.metadata!.id]);
    });

    assert.equal(store.get(projectState).graphs[graph.metadata!.id!], graph);
    assert.deepEqual(store.get(graphState), graph);
  } finally {
    await act(async () => {
      root.unmount();
      store.set(projectState, previousProject);
      store.set(graphState, previousGraph);
      store.set(runningGraphsState, previousRunningGraphs);
    });
    restoreGlobals();
    dom.window.close();
  }
});

test('deleting a referenced graph leaves its callers and web apps valid', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const restoreGlobals = installDomGlobals(dom);
  const root = createRoot(dom.window.document.getElementById('root')!);
  const store = getDefaultStore();
  const previousProject = store.get(projectState);
  const previousGraph = store.get(graphState);
  const target = makeGraph('target', 'Target');
  const caller = makeGraph('caller', 'Caller', [
    { id: 'subgraph-node', type: 'subGraph', data: { graphId: target.metadata!.id } } as never,
  ]);
  const project = {
    ...makeProject([target, caller], caller.metadata!.id),
    uiGraphs: {
      'web-app': {
        id: 'web-app',
        name: 'Web app',
        components: [{ id: 'run', type: 'button', action: { graphId: target.metadata!.id } }],
      },
    },
  } as never;
  let deleteGraphs: ReturnType<typeof useDeleteGraphs> | undefined;

  const Harness = () => {
    deleteGraphs = useDeleteGraphs();
    return null;
  };

  try {
    store.set(projectState, project);
    store.set(graphState, caller);
    await act(async () => {
      root.render(<Harness />);
    });
    assert.ok(deleteGraphs);

    await act(async () => {
      assert.deepEqual(deleteGraphs!([target.metadata!.id!]), {
        blockedGraphIds: [],
        deletedGraphIds: [],
        referencedGraphIds: [target.metadata!.id],
      });
    });

    assert.equal(store.get(projectState).graphs[target.metadata!.id!], target);
  } finally {
    await act(async () => {
      root.unmount();
      store.set(projectState, previousProject);
      store.set(graphState, previousGraph);
    });
    restoreGlobals();
    dom.window.close();
  }
});

test('deleting a folder may remove graphs that only reference one another', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const restoreGlobals = installDomGlobals(dom);
  const root = createRoot(dom.window.document.getElementById('root')!);
  const store = getDefaultStore();
  const previousProject = store.get(projectState);
  const previousGraph = store.get(graphState);
  const first = makeGraph('first', 'First', [
    { id: 'first-subgraph', type: 'subGraph', data: { graphId: 'second' as GraphId } } as never,
  ]);
  const second = makeGraph('second', 'Second', [
    { id: 'second-subgraph', type: 'subGraph', data: { graphId: 'first' as GraphId } } as never,
  ]);
  let deleteGraphs: ReturnType<typeof useDeleteGraphs> | undefined;

  const Harness = () => {
    deleteGraphs = useDeleteGraphs();
    return null;
  };

  try {
    store.set(projectState, makeProject([first, second], first.metadata!.id));
    store.set(graphState, first);
    await act(async () => {
      root.render(<Harness />);
    });
    assert.ok(deleteGraphs);

    await act(async () => {
      assert.deepEqual(deleteGraphs!([first.metadata!.id!, second.metadata!.id!]), {
        blockedGraphIds: [],
        deletedGraphIds: [first.metadata!.id, second.metadata!.id],
        referencedGraphIds: [],
      });
    });

    assert.deepEqual(store.get(projectState).graphs, {});
  } finally {
    await act(async () => {
      root.unmount();
      store.set(projectState, previousProject);
      store.set(graphState, previousGraph);
    });
    restoreGlobals();
    dom.window.close();
  }
});

function installDomGlobals(dom: JSDOM): () => void {
  const previous = {
    document: globalThis.document,
    Element: globalThis.Element,
    navigator: globalThis.navigator,
    window: globalThis.window,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
  };

  Object.defineProperties(globalThis, {
    document: { configurable: true, value: dom.window.document },
    Element: { configurable: true, value: dom.window.Element },
    navigator: { configurable: true, value: dom.window.navigator },
    window: { configurable: true, value: dom.window },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });

  return () => {
    Object.defineProperties(globalThis, {
      document: { configurable: true, value: previous.document },
      Element: { configurable: true, value: previous.Element },
      navigator: { configurable: true, value: previous.navigator },
      window: { configurable: true, value: previous.window },
      IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: previous.IS_REACT_ACT_ENVIRONMENT },
    });
  };
}
