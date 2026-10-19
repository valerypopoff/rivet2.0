import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChartNode, GraphId, Project, ProjectId } from '@valerypopoff/rivet2-core';
import type { OpenedProjectInfo } from '../state/savedGraphs.js';
import { getRemoteDebuggerBundleProjects } from './remoteDebuggerBundle.js';

const id = (value: string) => value as ProjectId;
const main = 'main' as GraphId;
function project(name: string, target?: string): Project {
  return {
    metadata: { id: id(name), title: name, description: '' },
    plugins: [],
    graphs: {
      [main]: {
        metadata: { id: main },
        connections: [],
        nodes: target
          ? [
              {
                id: 'call',
                type: 'subGraph',
                data: { targetProjectId: target, graphId: 'main' },
                visualData: { x: 0, y: 0 },
                title: 'Call',
              } as ChartNode,
            ]
          : [],
      },
    },
  };
}
test('connecting from a dependency finds the complete open component without grouping unrelated folders', () => {
  const projects = [project('a', 'b'), project('b', 'c'), project('c'), project('d')];
  const opened = Object.fromEntries(
    projects.map((p) => [
      p.metadata.id,
      { projectId: p.metadata.id, title: p.metadata.title, fsPath: `/same-folder/${p.metadata.id}` },
    ]),
  );
  const snapshots = Object.fromEntries(projects.map((p) => [p.metadata.id, { project: p }]));
  for (const active of projects.slice(0, 3))
    assert.deepEqual(getRemoteDebuggerBundleProjects(active.metadata.id, opened, snapshots, active).sort(), [
      'a',
      'b',
      'c',
    ]);
  assert.deepEqual(getRemoteDebuggerBundleProjects(id('d'), opened, snapshots, projects[3]!), ['d']);
});
test('explicit bundle manifests include unreferenced members but not a different manifest', () => {
  const active = project('a');
  const opened = Object.fromEntries(
    ['a', 'b', 'c'].map((name) => [
      name,
      {
        projectId: id(name),
        title: name,
        bundleManifestPath: name === 'c' ? '/other/rivet-bundle.json' : '/bundle/rivet-bundle.json',
      },
    ]),
  ) as Record<ProjectId, OpenedProjectInfo>;
  assert.deepEqual(getRemoteDebuggerBundleProjects(id('b'), opened, {}, active).sort(), ['a', 'b']);
});

test('legacy project references connect open callers and dependencies without requiring targetProjectId nodes', () => {
  const a = project('a'),
    b = project('b'),
    c = project('c');
  a.references = [{ id: id('b') }];
  b.references = [{ id: id('c') }, { id: id('closed') }];
  const projects = [a, b, c, project('d')];
  const opened = Object.fromEntries(
    projects.map((p) => [p.metadata.id, { projectId: p.metadata.id, title: p.metadata.title }]),
  );
  const snapshots = Object.fromEntries(projects.map((p) => [p.metadata.id, { project: p }]));
  assert.deepEqual(getRemoteDebuggerBundleProjects(id('c'), opened, snapshots, c).sort(), ['a', 'b', 'c']);
});
test('library Subgraph definitions participate, missing library definitions do not hide ordinary calls', () => {
  const active = project('a', 'b');
  const call = active.graphs[main]!.nodes[0]!;
  active.nodePrefabs = {
    library: { sourceNode: { ...call, data: { targetProjectId: 'c', graphId: 'main' } } },
  } as never;
  active.graphs[main]!.nodes.push({
    ...call,
    id: 'library-call' as never,
    type: 'nodePrefabInstance',
    data: { prefabId: 'library' },
  });
  active.graphs[main]!.nodes.push({
    ...call,
    id: 'missing-call' as never,
    type: 'nodePrefabInstance',
    data: { prefabId: 'missing' },
  });
  const opened = Object.fromEntries(['a', 'b', 'c'].map((name) => [name, { projectId: id(name), title: name }]));
  assert.deepEqual(getRemoteDebuggerBundleProjects(id('b'), opened, {}, active).sort(), ['a', 'b', 'c']);
});
