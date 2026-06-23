import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { type GraphId, type NodeGraph, type Project, type ProjectId } from '@valerypopoff/rivet2-core';
import { createRootGraphViewContext, createSubgraphGraphViewContext } from '../domain/graphEditing/navigationActions.js';
import {
  buildCurrentProjectEditorStateSnapshot,
  getActiveGraphId,
  pruneCanvasPositionsForProject,
  resolveCanvasPositionsForProject,
  resolvePersistedCanvasPositionsForLegacyCache,
  resolveProjectEditorRestoreTarget,
  sanitizeNavigationStackForProject,
} from './projectEditorState.js';

function makeGraph(
  id: string,
  name: string,
  nodes: NodeGraph['nodes'] = [],
): NodeGraph {
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

function makeCanvasPositions(
  positions: Record<string, { x: number; y: number; zoom: number }>,
): Record<GraphId, { x: number; y: number; zoom: number }> {
  return positions as Record<GraphId, { x: number; y: number; zoom: number }>;
}

describe('projectEditorState', () => {
  test('sanitizeNavigationStackForProject drops invalid entries and clamps the active index', () => {
    const rootGraph = makeGraph('root', 'Root', [{ id: 'sub-node', type: 'subGraph', data: {}, visualData: { x: 0, y: 0 } } as any]);
    const subGraph = makeGraph('sub', 'Sub');
    const project = makeProject([rootGraph, subGraph]);

    const sanitized = sanitizeNavigationStackForProject(project, {
      stack: [
        createRootGraphViewContext('root' as GraphId),
        createSubgraphGraphViewContext({
          graphId: 'sub' as GraphId,
          parentGraphId: 'root' as GraphId,
          parentNodeId: 'sub-node' as any,
        }),
        createRootGraphViewContext('missing' as GraphId),
        createSubgraphGraphViewContext({
          graphId: 'sub' as GraphId,
          parentGraphId: 'missing-root' as GraphId,
          parentNodeId: 'sub-node' as any,
        }),
        createSubgraphGraphViewContext({
          graphId: 'sub' as GraphId,
          parentGraphId: 'root' as GraphId,
          parentNodeId: 'missing-node' as any,
        }),
      ],
      index: 99,
    });

    assert.deepEqual(sanitized, {
      stack: [
        createRootGraphViewContext('root' as GraphId),
        createSubgraphGraphViewContext({
          graphId: 'sub' as GraphId,
          parentGraphId: 'root' as GraphId,
          parentNodeId: 'sub-node' as any,
        }),
      ],
      index: 1,
    });
  });

  test('sanitizeNavigationStackForProject falls back cleanly for malformed persisted stack shapes', () => {
    const project = makeProject([makeGraph('root', 'Root')]);

    assert.deepEqual(
      sanitizeNavigationStackForProject(project, {
        stack: [null, 'bad-data', { graphId: 'root' }, { graphId: 'missing' }] as any,
        index: 'bad-index' as any,
      }),
      {
        stack: [createRootGraphViewContext('root' as GraphId)],
        index: 0,
      },
    );
  });

  test('pruneCanvasPositionsForProject keeps only positions for graphs that still exist', () => {
    const project = makeProject([makeGraph('alpha', 'Alpha'), makeGraph('beta', 'Beta')]);

    const pruned = pruneCanvasPositionsForProject(project, {
      alpha: { x: 1, y: 2, zoom: 3 } as any,
      beta: { x: 4, y: 5, zoom: 6 } as any,
      missing: { x: 7, y: 8, zoom: 9 } as any,
    } as Record<GraphId, any>);

    assert.deepEqual(pruned, {
      alpha: { x: 1, y: 2, zoom: 3 },
      beta: { x: 4, y: 5, zoom: 6 },
    });
  });

  test('pruneCanvasPositionsForProject drops malformed persisted positions', () => {
    const project = makeProject([makeGraph('alpha', 'Alpha'), makeGraph('beta', 'Beta')]);

    const pruned = pruneCanvasPositionsForProject(project, {
      alpha: { x: 1, y: 2, zoom: 3 } as any,
      beta: { x: 'bad', y: 5, zoom: 6 } as any,
    } as any);

    assert.deepEqual(pruned, {
      alpha: { x: 1, y: 2, zoom: 3 },
    });
  });

  test('buildCurrentProjectEditorStateSnapshot preserves the currently visible graph and only backfills the active legacy position', () => {
    const project = makeProject([makeGraph('alpha', 'Alpha'), makeGraph('beta', 'Beta'), makeGraph('gamma', 'Gamma')]);

    const snapshot = buildCurrentProjectEditorStateSnapshot({
      project,
      currentGraphId: 'beta' as GraphId,
      navigationStack: {
        stack: [createRootGraphViewContext('alpha' as GraphId)],
        index: 0,
      },
      canvasPosition: { x: 10, y: 20, zoom: 2 },
      existingProjectEditorState: {
        navigationStack: {
          stack: [createRootGraphViewContext('alpha' as GraphId)],
          index: 0,
        },
        canvasPositionsByGraph: makeCanvasPositions({
          alpha: { x: 1, y: 2, zoom: 1 },
        }),
      },
      legacyCanvasPositionsByGraph: makeCanvasPositions({
        beta: { x: 7, y: 8, zoom: 1.5 },
        gamma: { x: 30, y: 40, zoom: 2.5 },
      }),
    });

    assert.equal(getActiveGraphId(snapshot.navigationStack), 'beta');
    assert.deepEqual(snapshot.canvasPositionsByGraph, {
      alpha: { x: 1, y: 2, zoom: 1 },
      beta: { x: 10, y: 20, zoom: 2 },
    });
  });

  test('resolveProjectEditorRestoreTarget prefers explicit graph overrides over persisted editor state', () => {
    const alpha = makeGraph('alpha', 'Alpha');
    const beta = makeGraph('beta', 'Beta');
    const project = makeProject([alpha, beta], { mainGraphId: 'alpha' });

    const restoreTarget = resolveProjectEditorRestoreTarget({
      project,
      explicitGraphToLoad: beta,
      persistedProjectEditorState: {
        navigationStack: {
          stack: [createRootGraphViewContext('alpha' as GraphId)],
          index: 0,
        },
        canvasPositionsByGraph: makeCanvasPositions({
          beta: { x: 4, y: 5, zoom: 1.5 },
        }),
      },
    });

    assert.equal(restoreTarget.graph.metadata?.id, 'beta');
    assert.deepEqual(restoreTarget.navigationStack, {
      stack: [createRootGraphViewContext('beta' as GraphId)],
      index: 0,
    });
    assert.deepEqual(restoreTarget.viewport, {
      type: 'saved',
      position: { x: 4, y: 5, zoom: 1.5, fromSaved: true },
    });
  });

  test('resolveProjectEditorRestoreTarget normalizes explicit graphView inputs before restoring them', () => {
    const rootGraph = makeGraph('root', 'Root', [{ id: 'sub-node', type: 'subGraph', data: {}, visualData: { x: 0, y: 0 } } as any]);
    const subGraph = makeGraph('sub', 'Sub');
    const project = makeProject([rootGraph, subGraph], { mainGraphId: 'root' });

    const restoreTarget = resolveProjectEditorRestoreTarget({
      project,
      explicitGraphView: {
        graphId: 'sub' as GraphId,
        parent: {
          parentGraphId: 'root' as GraphId,
          parentNodeId: 'sub-node' as any,
        },
      } as any,
    });

    assert.equal(restoreTarget.graph.metadata?.id, 'sub');
    assert.deepEqual(restoreTarget.navigationStack, {
      stack: [
        createSubgraphGraphViewContext({
          graphId: 'sub' as GraphId,
          parentGraphId: 'root' as GraphId,
          parentNodeId: 'sub-node' as any,
        }),
      ],
      index: 0,
    });
  });

  test('resolveProjectEditorRestoreTarget restores persisted navigation state and viewport', () => {
    const rootGraph = makeGraph('root', 'Root', [{ id: 'sub-node', type: 'subGraph', data: {}, visualData: { x: 0, y: 0 } } as any]);
    const subGraph = makeGraph('sub', 'Sub');
    const project = makeProject([rootGraph, subGraph], { mainGraphId: 'root' });

    const restoreTarget = resolveProjectEditorRestoreTarget({
      project,
      persistedProjectEditorState: {
        navigationStack: {
          stack: [
            createRootGraphViewContext('root' as GraphId),
            createSubgraphGraphViewContext({
              graphId: 'sub' as GraphId,
              parentGraphId: 'root' as GraphId,
              parentNodeId: 'sub-node' as any,
            }),
          ],
          index: 1,
        },
        canvasPositionsByGraph: makeCanvasPositions({
          sub: { x: 10, y: 20, zoom: 2 },
        }),
      },
    });

    assert.equal(restoreTarget.graph.metadata?.id, 'sub');
    assert.deepEqual(restoreTarget.navigationStack, {
      stack: [
        createRootGraphViewContext('root' as GraphId),
        createSubgraphGraphViewContext({
          graphId: 'sub' as GraphId,
          parentGraphId: 'root' as GraphId,
          parentNodeId: 'sub-node' as any,
        }),
      ],
      index: 1,
    });
    assert.deepEqual(restoreTarget.viewport, {
      type: 'saved',
      position: { x: 10, y: 20, zoom: 2, fromSaved: true },
    });
  });

  test('resolveProjectEditorRestoreTarget only uses legacy viewport fallback while the project has no scoped positions yet', () => {
    const alpha = makeGraph('alpha', 'Alpha');
    const beta = makeGraph('beta', 'Beta');
    const project = makeProject([alpha, beta], { mainGraphId: 'beta' });

    const restoreTarget = resolveProjectEditorRestoreTarget({
      project,
      persistedProjectEditorState: {
        navigationStack: {
          stack: [createRootGraphViewContext('beta' as GraphId)],
          index: 0,
        },
        canvasPositionsByGraph: makeCanvasPositions({
          alpha: { x: 1, y: 2, zoom: 1.2 },
        }),
      },
      legacyCanvasPositionsByGraph: makeCanvasPositions({
        beta: { x: 100, y: 200, zoom: 3 },
      }),
    });

    assert.deepEqual(restoreTarget.viewport, { type: 'reset' });
  });

  test('resolveCanvasPositionsForProject prefers project-scoped positions over the legacy graph-id cache', () => {
    const alpha = makeGraph('alpha', 'Alpha');
    const beta = makeGraph('beta', 'Beta');
    const project = makeProject([alpha, beta], { mainGraphId: 'alpha' });

    const resolved = resolveCanvasPositionsForProject({
      project,
      persistedProjectEditorState: {
        navigationStack: {
          stack: [createRootGraphViewContext('alpha' as GraphId)],
          index: 0,
        },
        canvasPositionsByGraph: makeCanvasPositions({
          alpha: { x: 1, y: 2, zoom: 1.2 },
        }),
      },
      legacyCanvasPositionsByGraph: makeCanvasPositions({
        alpha: { x: 10, y: 20, zoom: 3 },
        beta: { x: 30, y: 40, zoom: 4 },
      }),
    });

    assert.deepEqual(resolved, {
      alpha: { x: 1, y: 2, zoom: 1.2 },
    });
  });

  test('resolvePersistedCanvasPositionsForLegacyCache converts persisted project-scoped positions to saved canvas entries', () => {
    const alpha = makeGraph('alpha', 'Alpha');
    const beta = makeGraph('beta', 'Beta');
    const project = makeProject([alpha, beta], { mainGraphId: 'alpha' });

    const resolved = resolvePersistedCanvasPositionsForLegacyCache({
      project,
      persistedProjectEditorState: {
        navigationStack: {
          stack: [createRootGraphViewContext('alpha' as GraphId)],
          index: 0,
        },
        canvasPositionsByGraph: makeCanvasPositions({
          alpha: { x: 1, y: 2, zoom: 1.2 },
          beta: { x: 3, y: 4, zoom: 1.5 },
        }),
      },
    });

    assert.deepEqual(resolved, {
      alpha: { x: 1, y: 2, zoom: 1.2, fromSaved: true },
      beta: { x: 3, y: 4, zoom: 1.5, fromSaved: true },
    });
  });

  test('resolveProjectEditorRestoreTarget falls back from openedGraph to main graph to sorted graph to empty graph', () => {
    const alpha = makeGraph('alpha', 'Alpha');
    const beta = makeGraph('beta', 'Beta');

    assert.equal(
      resolveProjectEditorRestoreTarget({
        project: makeProject([beta, alpha], { mainGraphId: 'beta' }),
        openedGraphId: 'alpha' as GraphId,
      }).graph.metadata?.id,
      'alpha',
    );

    assert.equal(
      resolveProjectEditorRestoreTarget({
        project: makeProject([beta, alpha], { mainGraphId: 'beta' }),
      }).graph.metadata?.id,
      'beta',
    );

    assert.equal(
      resolveProjectEditorRestoreTarget({
        project: makeProject([beta, alpha]),
      }).graph.metadata?.id,
      'alpha',
    );

    const emptyRestoreTarget = resolveProjectEditorRestoreTarget({
      project: makeProject([]),
    });
    assert.equal(emptyRestoreTarget.graph.metadata?.name, 'Untitled graph');
    assert.deepEqual(emptyRestoreTarget.viewport, { type: 'reset' });
  });
});
