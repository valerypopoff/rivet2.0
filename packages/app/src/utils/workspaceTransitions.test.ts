import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyNodeGraph, type GraphId, type NodeGraph, type Project, type ProjectId } from '@valerypopoff/rivet2-core';
import { createRootGraphViewContext, createSubgraphGraphViewContext } from '../domain/graphEditing/navigationActions.js';
import {
  chooseProjectGraph,
  createDefaultTrivetState,
  createGraphSwitchTransition,
  createProjectLoadTransition,
  mergeCurrentGraphIntoProject,
  resolveProjectGraphForLoad,
  shouldPersistProjectBeforeLoad,
} from './workspaceTransitions.js';

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

function makeProject(graphs: NodeGraph[], options: { mainGraphId?: string } = {}): Omit<Project, 'data'> {
  return {
    metadata: {
      id: 'project-1' as ProjectId,
      title: 'Project',
      description: '',
      mainGraphId: options.mainGraphId as GraphId | undefined,
    },
    graphs: Object.fromEntries(graphs.map((graph) => [graph.metadata!.id!, graph])),
    plugins: [],
  };
}

describe('workspaceTransitions', () => {
  test('createDefaultTrivetState resets transient trivet state', () => {
    const state = createDefaultTrivetState([{ id: 'suite-1', name: 'Suite', testCases: [] } as any]);

    assert.deepEqual(state, {
      testSuites: [{ id: 'suite-1', name: 'Suite', testCases: [] }],
      selectedTestSuiteId: undefined,
      editingTestCaseId: undefined,
      recentTestResults: undefined,
      runningTests: false,
    });
  });

  test('chooseProjectGraph prefers explicit graph, then main graph, then sorted fallback', () => {
    const alpha = makeGraph('g-1', 'Alpha');
    const beta = makeGraph('g-2', 'Beta');
    const project = makeProject([beta, alpha], { mainGraphId: 'g-2' });

    assert.equal(chooseProjectGraph(project, { openedGraphId: 'g-1' as GraphId }).metadata?.id, 'g-1');
    assert.equal(chooseProjectGraph(project, { fallbackToMainGraph: true }).metadata?.id, 'g-2');
    assert.equal(chooseProjectGraph(project, { fallbackToSortedProjectGraph: true }).metadata?.id, 'g-1');
  });

  test('resolveProjectGraphForLoad returns the project-owned graph for a valid explicit graph id', () => {
    const alpha = makeGraph('g-1', 'Alpha');
    const detachedAlpha = makeGraph('g-1', 'Detached Alpha');
    const project = makeProject([alpha]);

    const resolved = resolveProjectGraphForLoad(project, { graphToLoad: detachedAlpha });

    assert.equal(resolved, alpha);
  });

  test('resolveProjectGraphForLoad falls back from invalid explicit graph to opened graph, main graph, and sorted graph', () => {
    const alpha = makeGraph('g-1', 'Alpha');
    const beta = makeGraph('g-2', 'Beta');

    const withOpenedGraph = makeProject([beta, alpha], { mainGraphId: 'g-2' });
    assert.equal(
      resolveProjectGraphForLoad(withOpenedGraph, {
        graphToLoad: makeGraph('missing', 'Missing'),
        openedGraphId: 'g-1' as GraphId,
      }).metadata?.id,
      'g-1',
    );

    const withMainGraph = makeProject([beta, alpha], { mainGraphId: 'g-2' });
    assert.equal(
      resolveProjectGraphForLoad(withMainGraph, {
        graphToLoad: makeGraph('missing', 'Missing'),
      }).metadata?.id,
      'g-2',
    );

    const withSortedFallback = makeProject([beta, alpha]);
    assert.equal(
      resolveProjectGraphForLoad(withSortedFallback, {
        graphToLoad: makeGraph('missing', 'Missing'),
      }).metadata?.id,
      'g-1',
    );
  });

  test('resolveProjectGraphForLoad returns a temporary empty graph only when the project has zero graphs', () => {
    const emptyProject = makeProject([]);

    const resolved = resolveProjectGraphForLoad(emptyProject, {
      graphToLoad: makeGraph('missing', 'Missing'),
      openedGraphId: 'missing' as GraphId,
    });

    assert.equal(Object.keys(emptyProject.graphs).length, 0);
    assert.equal(resolved.metadata?.name, 'Untitled graph');
    assert.equal(resolved.nodes.length, 0);
    assert.equal(resolved.connections.length, 0);
  });

  test('createProjectLoadTransition resets workspace state and loads requested graph', () => {
    const currentGraph = makeGraph('current', 'Current', [{ id: 'n-1' } as any]);
    const targetGraph = makeGraph('next', 'Next', [{ id: 'n-2', visualData: { x: 0, y: 0 } } as any]);
    const project = makeProject([targetGraph]);

    const transition = createProjectLoadTransition({
      currentGraph,
      graphToLoad: targetGraph,
      path: '/tmp/project.rivet-project',
      project,
    });

    assert.deepEqual(transition.cleanupNodeIds, ['n-1']);
    assert.equal(transition.graph.metadata?.id, 'next');
    assert.deepEqual(transition.navigationStack, { stack: [createRootGraphViewContext('next' as GraphId)], index: 0 });
    assert.deepEqual(transition.loadedProject, { loaded: true, path: '/tmp/project.rivet-project' });
    assert.deepEqual(transition.viewport, { type: 'center' });
  });

  test('createProjectLoadTransition preserves a missing project path as null', () => {
    const currentGraph = makeGraph('current', 'Current');
    const targetGraph = makeGraph('next', 'Next');
    const project = makeProject([targetGraph]);

    const transition = createProjectLoadTransition({
      currentGraph,
      graphToLoad: targetGraph,
      path: null,
      project,
    });

    assert.deepEqual(transition.loadedProject, { loaded: true, path: null });
    assert.deepEqual(transition.viewport, { type: 'reset' });
  });

  test('createProjectLoadTransition accepts an explicit restored navigation stack and viewport', () => {
    const currentGraph = makeGraph('current', 'Current');
    const targetGraph = makeGraph('next', 'Next', [{ id: 'n-2', visualData: { x: 0, y: 0 } } as any]);
    const project = makeProject([targetGraph]);
    const restoredNavigationStack = {
      stack: [
        createRootGraphViewContext('current' as GraphId),
        createSubgraphGraphViewContext({
          graphId: 'next' as GraphId,
          parentGraphId: 'current' as GraphId,
          parentNodeId: 'n-1' as any,
        }),
      ],
      index: 1,
    };

    const transition = createProjectLoadTransition({
      currentGraph,
      graphToLoad: targetGraph,
      path: '/tmp/project.rivet-project',
      project,
      navigationStack: restoredNavigationStack,
      viewport: {
        type: 'saved',
        position: { x: 12, y: 24, zoom: 1.5 },
      },
    });

    assert.deepEqual(transition.navigationStack, restoredNavigationStack);
    assert.deepEqual(transition.viewport, {
      type: 'saved',
      position: { x: 12, y: 24, zoom: 1.5 },
    });
  });

  test('createGraphSwitchTransition computes cleanup, history, and saved-position restoration', () => {
    const currentGraph = makeGraph('current', 'Current', [{ id: 'n-1' } as any]);
    const nextGraph = makeGraph('next', 'Next', [{ id: 'n-2', visualData: { x: 0, y: 0 } } as any]);

    const transition = createGraphSwitchTransition({
      currentGraph,
      graphToLoad: nextGraph,
      lastSavedPositions: {
        next: { x: 10, y: 20, zoom: 2 },
      } as Record<GraphId, any>,
      previousNavigationStack: { stack: [createRootGraphViewContext('current' as GraphId)], index: 0 },
      pushHistory: true,
    });

    assert.deepEqual(transition.cleanupNodeIds, ['n-1']);
    assert.deepEqual(transition.navigationStack, {
      index: 1,
      stack: [createRootGraphViewContext('current' as GraphId), createRootGraphViewContext('next' as GraphId)],
    });
    assert.deepEqual(transition.viewport, {
      type: 'saved',
      position: { x: 10, y: 20, zoom: 2 },
    });
  });

  test('mergeCurrentGraphIntoProject replaces the current graph in project state', () => {
    const oldGraph = makeGraph('g-1', 'Old');
    const newGraph = makeGraph('g-1', 'New');
    const project = makeProject([oldGraph]);

    const merged = mergeCurrentGraphIntoProject(project, newGraph);

    assert.equal(merged.graphs['g-1' as GraphId]?.metadata?.name, 'New');
    assert.notEqual(merged, project);
  });

  test('mergeCurrentGraphIntoProject preserves sibling graphs while persisting source graph changes', () => {
    const originalGraph = makeGraph('g-1', 'Alpha');
    const updatedGraph = makeGraph('g-1', 'Alpha', [{ id: 'node-1' } as any]);
    const siblingGraph = makeGraph('g-2', 'Beta');
    const project = makeProject([originalGraph, siblingGraph]);

    const merged = mergeCurrentGraphIntoProject(project, updatedGraph);

    assert.equal(merged.graphs['g-1' as GraphId], updatedGraph);
    assert.equal(merged.graphs['g-2' as GraphId], siblingGraph);
  });

  test('mergeCurrentGraphIntoProject preserves unusual sibling graph map entries', () => {
    const legacyGraph = {
      metadata: {
        name: 'Legacy',
        description: '',
      },
      nodes: [],
      connections: [],
    } as NodeGraph;
    const updatedGraph = makeGraph('g-1', 'Updated', [{ id: 'node-1' } as any]);
    const project = {
      ...makeProject([makeGraph('g-1', 'Original')]),
      graphs: {
        ['legacy-key' as GraphId]: legacyGraph,
        ['g-1' as GraphId]: makeGraph('g-1', 'Original'),
      },
    };

    const merged = mergeCurrentGraphIntoProject(project, updatedGraph);

    assert.equal(merged.graphs['g-1' as GraphId], updatedGraph);
    assert.equal(merged.graphs['legacy-key' as GraphId], legacyGraph);
    assert.equal(merged.graphs['undefined' as GraphId], undefined);
  });

  test('mergeCurrentGraphIntoProject ignores temporary empty graphs that are not part of the project', () => {
    const project = makeProject([]);
    const temporaryEmptyGraph = emptyNodeGraph();

    const merged = mergeCurrentGraphIntoProject(project, temporaryEmptyGraph);

    assert.equal(merged, project);
    assert.deepEqual(Object.keys(merged.graphs), []);
  });

  test('mergeCurrentGraphIntoProject preserves an existing empty project graph', () => {
    const existingEmptyGraph = makeGraph('g-1', 'Empty');
    const project = makeProject([existingEmptyGraph]);

    const merged = mergeCurrentGraphIntoProject(project, existingEmptyGraph);

    assert.equal(merged.graphs['g-1' as GraphId], existingEmptyGraph);
  });

  test('shouldPersistProjectBeforeLoad keeps empty opened tabs snapshot-eligible', () => {
    const emptyProject = makeProject([]);
    const emptyNavigationStack = { stack: [], index: undefined };

    assert.equal(
      shouldPersistProjectBeforeLoad({
        currentProjectHasOpenTab: true,
        loadedProject: { loaded: false },
        navigationStack: emptyNavigationStack,
        project: emptyProject,
      }),
      true,
    );
    assert.equal(
      shouldPersistProjectBeforeLoad({
        currentProjectHasOpenTab: false,
        loadedProject: { loaded: false },
        navigationStack: emptyNavigationStack,
        project: emptyProject,
      }),
      false,
    );
  });
});
