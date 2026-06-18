import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { DataId, GraphId, NodeGraph, Project, ProjectId } from '@valerypopoff/rivet2-core';
import {
  buildCurrentProjectContentSnapshot,
  getProjectContentDigest,
  hasProjectUnsavedChanges,
  markProjectClean,
  markProjectDirtyFlag,
  removeProjectUnsavedState,
} from './projectUnsavedChanges.js';

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

function makeProject(graphs: NodeGraph[]): Omit<Project, 'data'> {
  return {
    metadata: {
      id: 'project-1' as ProjectId,
      title: 'Project',
      description: '',
    },
    graphs: Object.fromEntries(graphs.map((graph) => [graph.metadata!.id!, graph])),
    plugins: [],
  };
}

describe('project unsaved changes helpers', () => {
  test('digests are stable for equivalent project content', () => {
    const graph = makeGraph('graph-1', 'Graph');
    const project = makeProject([graph]);

    assert.equal(getProjectContentDigest({ project }), getProjectContentDigest({ project: structuredClone(project) }));
  });

  test('digests still track graph content changes', () => {
    const graph = makeGraph('graph-1', 'Graph');
    const changedGraph = makeGraph('graph-1', 'Graph', [{ id: 'node-1' } as any]);

    assert.notEqual(
      getProjectContentDigest({ project: makeProject([graph]) }),
      getProjectContentDigest({ project: makeProject([changedGraph]) }),
    );
  });

  test('digests ignore derived project plugin specs', () => {
    const graph = makeGraph('graph-1', 'Graph');
    const project = makeProject([graph]);
    const projectWithDerivedPlugins: Omit<Project, 'data'> = {
      ...project,
      plugins: [
        {
          id: 'plugin-1',
          name: 'Plugin',
          type: 'built-in',
        },
      ],
    };

    assert.equal(getProjectContentDigest({ project }), getProjectContentDigest({ project: projectWithDerivedPlugins }));
  });

  test('digests ignore attached static data even when a full project is passed', () => {
    const graph = makeGraph('graph-1', 'Graph');
    const project = makeProject([graph]);
    const projectWithData: Project = {
      ...project,
      data: {
        ['data-1' as DataId]: 'cached value',
      },
    };

    assert.equal(getProjectContentDigest({ project }), getProjectContentDigest({ project: projectWithData }));
  });

  test('current project snapshots include unsaved current graph edits', () => {
    const graph = makeGraph('graph-1', 'Graph');
    const changedGraph = makeGraph('graph-1', 'Graph', [{ id: 'node-1' } as any]);
    const project = makeProject([graph]);

    const snapshot = buildCurrentProjectContentSnapshot({
      project,
      graph: changedGraph,
    });

    assert.equal(snapshot.project.graphs['graph-1' as GraphId], changedGraph);
  });

  test('markProjectClean records the clean digest for a project', () => {
    const project = makeProject([makeGraph('graph-1', 'Graph')]);
    const result = markProjectClean({}, { project });

    assert.equal(result[project.metadata.id], getProjectContentDigest({ project }));
  });

  test('dirty flags and cleanup preserve unchanged records', () => {
    const projectId = 'project-1' as ProjectId;
    const otherProjectId = 'project-2' as ProjectId;
    const flags = markProjectDirtyFlag({ [otherProjectId]: true }, projectId, true);

    assert.deepEqual(flags, {
      [projectId]: true,
      [otherProjectId]: true,
    });
    assert.deepEqual(removeProjectUnsavedState(flags, projectId), {
      [otherProjectId]: true,
    });
  });

  test('unsaved changes are true when either content or static data is dirty', () => {
    const projectId = 'project-1' as ProjectId;

    assert.equal(hasProjectUnsavedChanges({ [projectId]: true }, {}, projectId), true);
    assert.equal(hasProjectUnsavedChanges({}, { [projectId]: true }, projectId), true);
    assert.equal(hasProjectUnsavedChanges({ [projectId]: false }, { [projectId]: false }, projectId), false);
    assert.equal(hasProjectUnsavedChanges({}, {}, projectId), false);
  });
});
