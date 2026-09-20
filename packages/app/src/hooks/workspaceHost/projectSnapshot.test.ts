import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { GraphId, NodeGraph, NodeId, Project, UiGraphId } from '@valerypopoff/rivet2-core';
import { normalizeProjectSnapshot } from './projectSnapshot.js';

const uiGraphId = 'app' as UiGraphId;

void describe('hosted project snapshot normalization', () => {
  void it('repairs legacy UI component IDs before the project enters app state', () => {
    const project = makeProject();
    project.uiGraphs![uiGraphId]!.components = [{ text: 'Legacy', type: 'text' } as never];

    const normalized = normalizeProjectSnapshot({ project });

    assert.equal(normalized.project.uiGraphs?.[uiGraphId]?.components[0]?.id, 'app-component-1');
    assert.equal('id' in project.uiGraphs![uiGraphId]!.components[0]!, false);
  });

  void it('rejects malformed UI components at the hosted boundary', () => {
    const project = makeProject();
    project.uiGraphs![uiGraphId]!.components = [{ id: 'input', label: 'Input', type: 'input' } as never];

    assert.throws(() => normalizeProjectSnapshot({ project }), /UI graph "app" component at index 0\.stateKey/);
  });

  void it('keeps attached data separate without cloning already-valid UI graphs', () => {
    const project = makeProject();
    project.data = { value: { type: 'string', value: 'attached' } } as never;

    const normalized = normalizeProjectSnapshot({ project });

    assert.equal(normalized.project.uiGraphs, project.uiGraphs);
    assert.equal('data' in normalized.project, false);
    assert.equal(normalized.data, project.data);
  });

  void it('migrates legacy Jev nodes and the removed built-in plugin without mutating a host snapshot', () => {
    const graphId = 'main' as GraphId;
    const project = makeProject();
    project.plugins = [{ type: 'built-in', id: 'typesafe', name: 'TypeSafe AI (Jev)' }];
    project.graphs = {
      [graphId]: {
        connections: [],
        metadata: { id: graphId, name: 'Main' },
        nodes: [
          {
            data: { instructions: 'Route?', questionId: 'route' },
            id: 'legacy-question' as NodeId,
            title: 'Jev Noul Question',
            type: 'jevNoulQuestion',
            visualData: { x: 0, y: 0 },
          },
        ],
      },
    };

    const normalized = normalizeProjectSnapshot({ project });

    assert.notEqual(normalized.project, project);
    assert.equal(normalized.project.graphs[graphId]?.nodes[0]?.type, 'classifierQuestion');
    assert.deepEqual(normalized.project.plugins, []);
    assert.equal(project.graphs[graphId]?.nodes[0]?.type, 'jevNoulQuestion');
    assert.equal(project.plugins?.[0]?.id, 'typesafe');
  });

  void it('migrates an explicit graph-to-load without mutating the host graph', () => {
    const graphToLoad = {
      connections: [],
      metadata: { id: 'main' as never, name: 'Main' },
      nodes: [
        {
          data: { instructions: 'Route?', questionId: 'route' },
          id: 'legacy-question' as NodeId,
          title: 'Jev Noul Question',
          type: 'jevNoulQuestion',
          visualData: { x: 0, y: 0 },
        },
      ],
    } as NodeGraph;

    const normalized = normalizeProjectSnapshot({ graphToLoad, project: makeProject() });

    assert.equal(normalized.graphToLoad?.nodes[0]?.type, 'classifierQuestion');
    assert.equal(graphToLoad.nodes[0]?.type, 'jevNoulQuestion');
  });
});

function makeProject(): Project {
  return {
    graphs: {},
    metadata: { description: '', id: 'project' as never, title: 'Project' },
    uiGraphs: {
      app: {
        components: [{ id: 'text' as never, text: 'Text', type: 'text' }],
        id: 'app' as never,
        name: 'App',
      },
    } as Project['uiGraphs'],
  };
}
