import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { GraphId, Project, ProjectId } from '@valerypopoff/rivet2-core';
import {
  addOpenedProject,
  moveOpenedProjectPaths,
  removeOpenedProject,
  resolveSyncedOpenedProjectFsPathOptions,
  updateOpenedProjectMetadata,
} from './openedProjects.js';

function makeProject(id: string, title: string): Project {
  return {
    metadata: {
      id: id as ProjectId,
      title,
      description: '',
      mainGraphId: 'graph-1' as GraphId,
    },
    graphs: {},
  };
}

describe('openedProjects helpers', () => {
  test('adds a new project without dropping existing open projects', () => {
    const existingProject = makeProject('project-1', 'Existing');
    const nextProject = makeProject('project-2', 'Next');

    const result = addOpenedProject(
      {
        openedProjects: {
          [existingProject.metadata.id]: {
            projectId: existingProject.metadata.id,
            title: existingProject.metadata.title,
            fsPath: '/tmp/existing.rivet-project',
          },
        },
        openedProjectsSortedIds: [existingProject.metadata.id],
      },
      nextProject,
    );

    assert.deepEqual(result.openedProjectsSortedIds, [existingProject.metadata.id, nextProject.metadata.id]);
    assert.equal(result.openedProjects[existingProject.metadata.id]?.title, 'Existing');
    assert.equal(result.openedProjects[nextProject.metadata.id]?.title, 'Next');
    assert.equal(result.openedProjects[nextProject.metadata.id]?.fsPath, null);
    assert.equal(result.openedProjects[nextProject.metadata.id]?.openedGraph, 'graph-1');
  });

  test('does not duplicate an already-open project id', () => {
    const project = makeProject('project-1', 'Existing');

    const result = addOpenedProject(
      {
        openedProjects: {
          [project.metadata.id]: {
            projectId: project.metadata.id,
            title: project.metadata.title,
            fsPath: null,
          },
        },
        openedProjectsSortedIds: [project.metadata.id],
      },
      project,
      { fsPath: '/tmp/project-1.rivet-project' },
    );

    assert.deepEqual(result.openedProjectsSortedIds, [project.metadata.id]);
    assert.equal(result.openedProjects[project.metadata.id]?.fsPath, '/tmp/project-1.rivet-project');
    assert.equal(result.openedProjects[project.metadata.id]?.openedGraph, 'graph-1');
  });

  test('allows callers to seed the opened graph explicitly for a newly opened project', () => {
    const project = makeProject('project-1', 'Existing');

    const result = addOpenedProject(
      {
        openedProjects: {},
        openedProjectsSortedIds: [],
      },
      project,
      {
        openedGraph: 'graph-2' as GraphId,
      },
    );

    assert.equal(result.openedProjects[project.metadata.id]?.openedGraph, 'graph-2');
  });

  test('preserves existing tab metadata when updating an already-open project', () => {
    const project = makeProject('project-1', 'Existing');
    const updatedProject = makeProject('project-1', 'Updated');

    const result = addOpenedProject(
      {
        openedProjects: {
          [project.metadata.id]: {
            projectId: project.metadata.id,
            title: project.metadata.title,
            fsPath: '/tmp/project-1.rivet-project',
            openedGraph: 'graph-2' as GraphId,
            executorMode: {
              type: 'remote-debugger',
              url: 'ws://debugger.example',
            },
          },
        },
        openedProjectsSortedIds: [project.metadata.id],
      },
      updatedProject,
    );

    assert.deepEqual(result.openedProjectsSortedIds, [project.metadata.id]);
    assert.equal(result.openedProjects[project.metadata.id]?.title, 'Updated');
    assert.equal(result.openedProjects[project.metadata.id]?.fsPath, '/tmp/project-1.rivet-project');
    assert.equal(result.openedProjects[project.metadata.id]?.openedGraph, 'graph-2');
    assert.deepEqual(result.openedProjects[project.metadata.id]?.executorMode, {
      type: 'remote-debugger',
      url: 'ws://debugger.example',
    });
  });

  test('allows callers to update executor mode without changing other tab metadata', () => {
    const project = makeProject('project-1', 'Existing');

    const result = addOpenedProject(
      {
        openedProjects: {
          [project.metadata.id]: {
            projectId: project.metadata.id,
            title: project.metadata.title,
            fsPath: '/tmp/project-1.rivet-project',
            openedGraph: 'graph-2' as GraphId,
            executorMode: {
              type: 'local',
              executor: 'browser',
            },
          },
        },
        openedProjectsSortedIds: [project.metadata.id],
      },
      project,
      {
        executorMode: {
          type: 'local',
          executor: 'nodejs',
        },
      },
    );

    assert.equal(result.openedProjects[project.metadata.id]?.fsPath, '/tmp/project-1.rivet-project');
    assert.equal(result.openedProjects[project.metadata.id]?.openedGraph, 'graph-2');
    assert.deepEqual(result.openedProjects[project.metadata.id]?.executorMode, {
      type: 'local',
      executor: 'nodejs',
    });
  });

  test('allows callers to explicitly clear an already-open project path', () => {
    const project = makeProject('project-1', 'Existing');

    const result = addOpenedProject(
      {
        openedProjects: {
          [project.metadata.id]: {
            projectId: project.metadata.id,
            title: project.metadata.title,
            fsPath: '/tmp/project-1.rivet-project',
          },
        },
        openedProjectsSortedIds: [project.metadata.id],
      },
      project,
      { fsPath: null },
    );

    assert.equal(result.openedProjects[project.metadata.id]?.fsPath, null);
  });

  test('does not sync a loaded project path that belongs to another open project', () => {
    const existingProject = makeProject('project-1', 'Existing');
    const nextProject = makeProject('project-2', 'Next');

    const result = resolveSyncedOpenedProjectFsPathOptions(
      {
        openedProjects: {
          [existingProject.metadata.id]: {
            projectId: existingProject.metadata.id,
            title: existingProject.metadata.title,
            fsPath: '/tmp/existing.rivet-project',
          },
        },
        openedProjectsSortedIds: [existingProject.metadata.id],
      },
      nextProject.metadata.id,
      '/tmp/existing.rivet-project',
    );

    assert.deepEqual(result, {});
  });

  test('preserves an existing project path when a stale loaded path belongs to another open project', () => {
    const previousProject = makeProject('project-1', 'Previous');
    const nextProject = makeProject('project-2', 'Next');

    const result = resolveSyncedOpenedProjectFsPathOptions(
      {
        openedProjects: {
          [previousProject.metadata.id]: {
            projectId: previousProject.metadata.id,
            title: previousProject.metadata.title,
            fsPath: '/tmp/previous.rivet-project',
          },
          [nextProject.metadata.id]: {
            projectId: nextProject.metadata.id,
            title: nextProject.metadata.title,
            fsPath: '/tmp/next.rivet-project',
          },
        },
        openedProjectsSortedIds: [previousProject.metadata.id, nextProject.metadata.id],
      },
      nextProject.metadata.id,
      '/tmp/previous.rivet-project',
    );

    assert.deepEqual(result, {});
  });

  test('syncs a loaded project path when no other open project owns it', () => {
    const project = makeProject('project-1', 'Existing');

    const result = resolveSyncedOpenedProjectFsPathOptions(
      {
        openedProjects: {},
        openedProjectsSortedIds: [],
      },
      project.metadata.id,
      '/tmp/project-1.rivet-project',
    );

    assert.deepEqual(result, { fsPath: '/tmp/project-1.rivet-project' });
  });

  test('clears stale tab paths that are already owned by another open project', () => {
    const existingProject = makeProject('project-1', 'Existing');
    const nextProject = makeProject('project-2', 'Next');

    const result = resolveSyncedOpenedProjectFsPathOptions(
      {
        openedProjects: {
          [existingProject.metadata.id]: {
            projectId: existingProject.metadata.id,
            title: existingProject.metadata.title,
            fsPath: '/tmp/existing.rivet-project',
          },
          [nextProject.metadata.id]: {
            projectId: nextProject.metadata.id,
            title: nextProject.metadata.title,
            fsPath: '/tmp/existing.rivet-project',
          },
        },
        openedProjectsSortedIds: [existingProject.metadata.id, nextProject.metadata.id],
      },
      nextProject.metadata.id,
      null,
    );

    assert.deepEqual(result, { fsPath: null });
  });

  test('removes closed projects and prunes stale sorted ids', () => {
    const firstProject = makeProject('project-1', 'First');
    const secondProject = makeProject('project-2', 'Second');

    const result = removeOpenedProject(
      {
        openedProjects: {
          [firstProject.metadata.id]: {
            projectId: firstProject.metadata.id,
            title: firstProject.metadata.title,
          },
          [secondProject.metadata.id]: {
            projectId: secondProject.metadata.id,
            title: secondProject.metadata.title,
          },
        },
        openedProjectsSortedIds: [firstProject.metadata.id, secondProject.metadata.id, 'stale-project' as ProjectId],
      },
      firstProject.metadata.id,
    );

    assert.deepEqual(result.openedProjectsSortedIds, [secondProject.metadata.id]);
    assert.equal(result.openedProjects[firstProject.metadata.id], undefined);
    assert.equal(result.openedProjects[secondProject.metadata.id]?.title, 'Second');
  });

  test('moves open project paths without changing project order', () => {
    const firstProject = makeProject('project-1', 'First');
    const secondProject = makeProject('project-2', 'Second');

    const result = moveOpenedProjectPaths(
      {
        openedProjects: {
          [firstProject.metadata.id]: {
            projectId: firstProject.metadata.id,
            title: firstProject.metadata.title,
            fsPath: '/old/first.rivet-project',
          },
          [secondProject.metadata.id]: {
            projectId: secondProject.metadata.id,
            title: secondProject.metadata.title,
            fsPath: '/old/second.rivet-project',
          },
        },
        openedProjectsSortedIds: [firstProject.metadata.id, secondProject.metadata.id],
      },
      {
        '/old/second.rivet-project': '/new/second.rivet-project',
      },
    );

    assert.deepEqual(result.openedProjectsSortedIds, [firstProject.metadata.id, secondProject.metadata.id]);
    assert.equal(result.openedProjects[firstProject.metadata.id]?.fsPath, '/old/first.rivet-project');
    assert.equal(result.openedProjects[secondProject.metadata.id]?.fsPath, '/new/second.rivet-project');
  });

  test('updates opened project title and optional path without changing order', () => {
    const firstProject = makeProject('project-1', 'First');
    const secondProject = makeProject('project-2', 'Second');

    const result = updateOpenedProjectMetadata(
      {
        openedProjects: {
          [firstProject.metadata.id]: {
            projectId: firstProject.metadata.id,
            title: firstProject.metadata.title,
            fsPath: '/old/first.rivet-project',
          },
          [secondProject.metadata.id]: {
            projectId: secondProject.metadata.id,
            title: secondProject.metadata.title,
            fsPath: '/old/second.rivet-project',
          },
        },
        openedProjectsSortedIds: [firstProject.metadata.id, secondProject.metadata.id],
      },
      secondProject.metadata.id,
      { title: 'Renamed' },
      { fsPath: '/new/second.rivet-project' },
    );

    assert.deepEqual(result.openedProjectsSortedIds, [firstProject.metadata.id, secondProject.metadata.id]);
    assert.equal(result.openedProjects[firstProject.metadata.id]?.title, 'First');
    assert.equal(result.openedProjects[secondProject.metadata.id]?.title, 'Renamed');
    assert.equal(result.openedProjects[secondProject.metadata.id]?.fsPath, '/new/second.rivet-project');
  });

  test('clears an opened project path during metadata update when requested', () => {
    const project = makeProject('project-1', 'Project');

    const result = updateOpenedProjectMetadata(
      {
        openedProjects: {
          [project.metadata.id]: {
            projectId: project.metadata.id,
            title: project.metadata.title,
            fsPath: '/old/project.rivet-project',
          },
        },
        openedProjectsSortedIds: [project.metadata.id],
      },
      project.metadata.id,
      {},
      { fsPath: null },
    );

    assert.equal(result.openedProjects[project.metadata.id]?.title, 'Project');
    assert.equal(result.openedProjects[project.metadata.id]?.fsPath, null);
  });

  test('preserves an opened project path when metadata update receives an undefined path', () => {
    const project = makeProject('project-1', 'Project');

    const result = updateOpenedProjectMetadata(
      {
        openedProjects: {
          [project.metadata.id]: {
            projectId: project.metadata.id,
            title: project.metadata.title,
            fsPath: '/old/project.rivet-project',
          },
        },
        openedProjectsSortedIds: [project.metadata.id],
      },
      project.metadata.id,
      { title: 'Renamed' },
      { fsPath: undefined },
    );

    assert.equal(result.openedProjects[project.metadata.id]?.title, 'Renamed');
    assert.equal(result.openedProjects[project.metadata.id]?.fsPath, '/old/project.rivet-project');
  });

  test('treats empty runtime metadata updates as path-only or no-op tab updates', () => {
    const project = makeProject('project-1', 'Project');
    const current = {
      openedProjects: {
        [project.metadata.id]: {
          projectId: project.metadata.id,
          title: project.metadata.title,
          fsPath: '/old/project.rivet-project',
        },
      },
      openedProjectsSortedIds: [project.metadata.id],
    };

    assert.equal(updateOpenedProjectMetadata(current, project.metadata.id, undefined), current);

    const pathOnlyResult = updateOpenedProjectMetadata(current, project.metadata.id, undefined, {
      fsPath: '/new/project.rivet-project',
    });

    assert.equal(pathOnlyResult.openedProjects[project.metadata.id]?.title, 'Project');
    assert.equal(pathOnlyResult.openedProjects[project.metadata.id]?.fsPath, '/new/project.rivet-project');
  });
});
