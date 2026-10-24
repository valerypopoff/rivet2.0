import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectId } from '@valerypopoff/rivet2-core';
import type { OpenedProjectSnapshot, OpenedProjectsInfo } from '../state/savedGraphs.js';
import { createBlankProjectWithDefaultGraph } from './blankProject.js';
import { addOpenedProject } from './openedProjects.js';
import { reconcileOpenedProjectRegistry } from './openedProjectSynchronization.js';

test('legacy recovery repairs snapshots before dropping full payloads and is idempotent', () => {
  for (const damagedSnapshot of [false, true]) {
    const project = createBlankProjectWithDefaultGraph();
    const id = project.metadata.id;
    const legacy = {
      openedProjects: { [id]: { project, projectId: id, fsPath: null, title: 'Old title' } },
      openedProjectsSortedIds: [id],
    } as unknown as OpenedProjectsInfo;
    const result = reconcileOpenedProjectRegistry(legacy, {
      openedProjectSnapshots: damagedSnapshot ? { [id]: {} as OpenedProjectSnapshot } : {},
      resolveTitle: () => 'Recovered title',
    });
    assert.equal('project' in result.projects.openedProjects[id]!, false);
    assert.equal(result.snapshots[id]!.project.metadata.title, 'Recovered title');
    assert.equal(result.snapshots[id]!.project.graphs, project.graphs);
    assert.deepEqual(result.projects.openedProjectsSortedIds, [id]);
    const stable = reconcileOpenedProjectRegistry(result.projects, { openedProjectSnapshots: result.snapshots });
    assert.equal(stable.projects, result.projects);
    assert.equal(stable.snapshots, result.snapshots);
  }
});

test('recovery retains authoritative snapshots, bundle identity and file-backed duplicates', () => {
  const project = createBlankProjectWithDefaultGraph();
  const id = project.metadata.id;
  const other = 'legacy-alias' as ProjectId;
  const snapshot = { project, data: undefined };
  const registry = addOpenedProject({ openedProjects: {}, openedProjectsSortedIds: [] }, project, { fsPath: null });
  const previous = {
    openedProjects: {
      ...registry.openedProjects,
      [id]: { ...registry.openedProjects[id]!, hostedBundleKey: 'server:bundle', bundleMember: true },
      [other]: {
        projectId: id,
        title: 'File backed',
        fsPath: 'saved.rivet-project',
        bundleManifestPath: 'rivet-bundle.json',
        bundleMember: false,
        hostedBundleKey: null,
      },
    },
    openedProjectsSortedIds: [id, other],
  };
  const result = reconcileOpenedProjectRegistry(previous, { openedProjectSnapshots: { [id]: snapshot } });
  assert.deepEqual(result.projects.openedProjectsSortedIds, [id]);
  assert.equal(result.projects.openedProjects[id]!.fsPath, 'saved.rivet-project');
  assert.equal(result.projects.openedProjects[id]!.bundleMember, false);
  assert.equal(result.projects.openedProjects[id]!.hostedBundleKey, null);
  assert.equal(result.projects.openedProjects[id]!.bundleManifestPath, 'rivet-bundle.json');
  assert.equal(result.snapshots[id], snapshot);
});

test('invalid membership and executor values are repaired without dropping a valid tab', () => {
  const project = createBlankProjectWithDefaultGraph();
  const id = project.metadata.id;
  const previous = addOpenedProject({ openedProjects: {}, openedProjectsSortedIds: [] }, project, {
    fsPath: 'a.rivet-project',
  });
  const raw = previous.openedProjects[id]! as unknown as Record<string, unknown>;
  raw.bundleMember = 'invalid';
  raw.bundleManifestPath = 42;
  raw.executorMode = 42;
  const result = reconcileOpenedProjectRegistry(previous, { openedProjectSnapshots: {} });
  assert.notEqual(result.projects, previous);
  assert.equal(result.projects.openedProjects[id]!.executorMode, undefined);
  assert.equal(result.projects.openedProjects[id]!.bundleMember, undefined);
  assert.equal(result.projects.openedProjects[id]!.bundleManifestPath, undefined);
  assert.equal(raw.bundleMember, 'invalid', 'Input metadata is never mutated');
});

test('valid project IDs that match Object prototype names survive registry and legacy snapshot recovery', () => {
  for (const key of ['constructor', '__proto__', 'toString']) {
    const project = createBlankProjectWithDefaultGraph();
    project.metadata.id = key as ProjectId;
    const previous: OpenedProjectsInfo = {
      openedProjects: { [key]: { projectId: project.metadata.id, title: 'Recovered', fsPath: null, project } },
      openedProjectsSortedIds: [project.metadata.id],
    } as unknown as OpenedProjectsInfo;
    const result = reconcileOpenedProjectRegistry(previous, { openedProjectSnapshots: {} });
    assert.deepEqual(result.projects.openedProjectsSortedIds, [key]);
    assert.equal(Object.hasOwn(result.projects.openedProjects, key), true);
    assert.equal(result.projects.openedProjects[key as ProjectId]!.projectId, key);
    assert.equal(Object.hasOwn(result.snapshots, key), true);
    assert.equal(result.snapshots[key as ProjectId]!.project.metadata.id, key);
    assert.equal(Object.getPrototypeOf(result.projects.openedProjects), Object.prototype);
    assert.equal(Object.getPrototypeOf(result.snapshots), Object.prototype);
    const stable = reconcileOpenedProjectRegistry(result.projects, { openedProjectSnapshots: result.snapshots });
    assert.equal(stable.projects, result.projects);
    assert.equal(stable.snapshots, result.snapshots);
  }
});
