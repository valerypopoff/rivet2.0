import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type DataId,
  type GraphId,
  type NodeGraph,
  type NodeId,
  type Project,
  type ProjectId,
} from '@valerypopoff/rivet2-core';
import { createGraphBuilderEditorSnapshot } from './editorSnapshot.js';

const projectId = 'project' as ProjectId;
const activeGraphId = 'active' as GraphId;

function createProject(graphs: Project['graphs'] = {}): Omit<Project, 'data'> {
  return {
    metadata: {
      id: projectId,
      title: 'Project',
      description: '',
    },
    graphs,
    plugins: [],
  };
}

function createGraph(id = activeGraphId): NodeGraph {
  return {
    metadata: { id, name: 'Live', description: '' },
    nodes: [],
    connections: [],
  };
}

test('live graph overlays its persisted project graph in the authoring snapshot', () => {
  const persisted = createGraph();
  persisted.metadata!.name = 'Persisted';
  const live = createGraph();
  live.metadata!.name = 'Live';

  const snapshot = createGraphBuilderEditorSnapshot({
    graph: live,
    project: createProject({ [activeGraphId]: persisted }),
  });

  assert.equal(snapshot.authoringProject.graphs[activeGraphId]?.metadata?.name, 'Live');
  assert.equal(snapshot.transientGraph, false);
});

test('an empty transient canvas is represented in the private authoring project', () => {
  const graph = createGraph();
  const snapshot = createGraphBuilderEditorSnapshot({
    graph,
    project: createProject(),
  });

  assert.deepEqual(snapshot.authoringProject.graphs[activeGraphId], graph);
  assert.equal(snapshot.transientGraph, true);
});

test('an unpersisted canvas with user-authored content is not boundary-mutable', () => {
  const transientGraphId = 'transient' as GraphId;
  const live = createGraph(transientGraphId);
  live.metadata!.name = 'Unsaved';
  live.nodes.push({
    id: 'existing' as NodeId,
    type: 'text',
    title: 'Existing',
    visualData: { x: 0, y: 0 },
    data: { text: 'Keep me' },
  });
  const snapshot = createGraphBuilderEditorSnapshot({
    graph: live,
    project: createProject(),
  });

  assert.equal(snapshot.transientGraph, false);
  assert.equal(snapshot.authoringProject.graphs[transientGraphId]!.nodes.length, 1);
});

test('fingerprints include project plugins and the project-data manifest but not raw data', () => {
  const dataId = 'dataset' as DataId;
  const base = createGraphBuilderEditorSnapshot({
    graph: createGraph(),
    project: createProject(),
    projectData: { [dataId]: 'first' },
  });
  const changedData = createGraphBuilderEditorSnapshot({
    graph: createGraph(),
    project: createProject(),
    projectData: { [dataId]: 'second' },
  });
  const changedPlugin = createGraphBuilderEditorSnapshot({
    graph: createGraph(),
    project: {
      ...createProject(),
      plugins: [{ type: 'package', id: 'example', package: 'example', tag: 'latest' }],
    },
    projectData: { [dataId]: 'first' },
  });

  assert.notEqual(base.canonicalIdentity, changedData.canonicalIdentity);
  assert.notEqual(base.canonicalIdentity, changedPlugin.canonicalIdentity);
  assert.doesNotMatch(base.canonicalIdentity, /first/);
});

test('a missing live graph ID is allocated once through the caller seam', () => {
  let calls = 0;
  const graph = createGraph();
  graph.metadata = { name: 'Transient', description: '' };
  const snapshot = createGraphBuilderEditorSnapshot({
    graph,
    project: createProject(),
    createGraphId: () => {
      calls += 1;
      return 'allocated' as GraphId;
    },
  });

  assert.equal(calls, 1);
  assert.equal(snapshot.activeGraphId, 'allocated');
  assert.equal(snapshot.authoringProject.graphs['allocated' as GraphId]?.metadata?.id, 'allocated');
});

test('snapshot capture rejects accessors before cloning or reading them', () => {
  let getterCalls = 0;
  const graph = createGraph();
  Object.defineProperty(graph.metadata, 'name', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'must-not-run';
    },
  });

  assert.throws(
    () =>
      createGraphBuilderEditorSnapshot({
        graph,
        project: createProject(),
      }),
    /accessor/,
  );
  assert.equal(getterCalls, 0);
});

test('graph lookup ignores inherited names while preserving actual own special-name graphs', () => {
  const generated = createGraph();
  generated.metadata = { name: 'Generated special graph', description: '' };
  const generatedSnapshot = createGraphBuilderEditorSnapshot({
    graph: generated,
    project: createProject(),
    createGraphId: () => 'toString' as GraphId,
  });
  assert.equal(generatedSnapshot.activeGraphId, 'toString');
  assert.equal(Object.hasOwn(generatedSnapshot.authoringProject.graphs, 'toString'), true);
  assert.equal(generatedSnapshot.transientGraph, true);

  const persistedGraphs = {};
  Object.defineProperty(persistedGraphs, 'toString', {
    enumerable: true,
    configurable: true,
    writable: true,
    value: createGraph('toString' as GraphId),
  });
  const persistedSnapshot = createGraphBuilderEditorSnapshot({
    graph: createGraph('toString' as GraphId),
    project: createProject(persistedGraphs),
  });
  assert.equal(persistedSnapshot.transientGraph, false);
  assert.equal(Object.hasOwn(persistedSnapshot.authoringProject.graphs, 'toString'), true);
});

test('authoritative fingerprints support realistic large graphs and omitted optional fields', () => {
  const graph = createGraph();
  graph.nodes = Array.from({ length: 160 }, (_, index) => ({
    id: `node-${index}` as never,
    type: 'text',
    title: `Text ${index}`,
    visualData: { x: index * 10, y: index * 5, width: undefined },
    data: { text: 'x'.repeat(4_000), normalizeLineEndings: true },
  }));

  const snapshot = createGraphBuilderEditorSnapshot({
    graph,
    project: createProject({ [activeGraphId]: graph }),
    projectData: {
      ['large-data' as DataId]: 'y'.repeat(32_000),
    },
  });

  assert.equal(snapshot.authoringProject.graphs[activeGraphId]?.nodes.length, 160);
  assert.match(snapshot.fingerprint, /^fnv1a64:/);
  assert.doesNotMatch(snapshot.canonicalIdentity, /"width"/);
  assert.doesNotMatch(snapshot.canonicalIdentity, /y{100}/);
});
