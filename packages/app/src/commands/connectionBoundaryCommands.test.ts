import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getGraphBoundary,
  getSubgraphProjectKey,
  type GraphId,
  type NodeGraph,
  type PortId,
  type ProjectId,
  type SubGraphNode,
} from '@valerypopoff/rivet2-core';
import { createMakeConnectionCommand } from './makeConnectionCommand.js';
import { createRewireConnectionCommand } from './rewireConnectionCommand.js';
import { makeCommandState, registry } from './editNodeCommandTestUtils.js';
import {
  makeConnection,
  makeGraph,
  makeGraphInputNode,
  makeGraphOutputNode,
  makeProject,
  makeSubGraphNode,
  makeTextNode,
} from '../domain/graphEditing/testGraphBuilders.js';
import { filterValidSubGraphConnections } from '../domain/graphEditing/connectionValidation.js';
import { captureSubgraphConnectionBoundaries } from '../domain/graphEditing/subgraphConnectionBoundary.js';

for (const version of ['latest', 'published'] as const) {
  for (const side of ['input', 'output'] as const) {
    for (const rewire of [false, true]) {
      test(`${version} ${side} ${rewire ? 'rewire' : 'wire'} persists expanded contract atomically with undo/redo`, () => {
        const projectId = 'external' as ProjectId;
        const oldInput = makeGraphInputNode('in-old', 'old');
        const oldOutput = makeGraphOutputNode('out-old', 'old');
        const oldTarget = makeProject([makeGraph('child', [oldInput, oldOutput])]);
        const target = makeProject([
          makeGraph('child', [
            oldInput,
            oldOutput,
            makeGraphInputNode('in-new', 'new'),
            makeGraphOutputNode('out-new', 'new'),
          ]),
        ]);
        const oldBoundary = getGraphBoundary(oldTarget, 'child' as GraphId)!;
        const subgraph = makeSubGraphNode('external-call', 'child', {
          data: { targetProjectId: projectId, targetVersion: version, targetBoundary: oldBoundary },
        });
        const source = makeTextNode('source');
        const sink = makeTextNode('sink', '{{value}}');
        const original = makeConnection(
          side === 'input'
            ? { inputNodeId: subgraph.id, inputId: 'old' as PortId }
            : {
                outputNodeId: subgraph.id,
                outputId: 'old' as PortId,
                inputNodeId: sink.id,
                inputId: 'value' as PortId,
              },
        );
        const next = { ...original, [side === 'input' ? 'inputId' : 'outputId']: 'new' as PortId };
        let graph = makeGraph('main', [source, subgraph, sink], [original]);
        let commits = 0;
        const setGraph = (update: (graph: NodeGraph) => NodeGraph) => {
          graph = update(graph);
          commits++;
        };
        const readState = () => ({
          ...makeCommandState({ nodes: graph.nodes, connections: graph.connections }),
          referencedProjects: { [getSubgraphProjectKey({ projectId, version })]: target },
        });
        const command = rewire ? createRewireConnectionCommand(setGraph) : createMakeConnectionCommand(setGraph);
        const params = { ...next, originalConnection: original };
        const applied = command.apply(params, undefined, readState());
        assert.equal(commits, 1);
        const boundary = (graph.nodes.find((node) => node.id === subgraph.id) as SubGraphNode).data.targetBoundary!;
        assert.equal(boundary.inputs.length, 2);
        assert.equal(boundary.outputs.length, 2);
        assert.ok(
          graph.connections.some(
            (connection) => connection.inputId === next.inputId && connection.outputId === next.outputId,
          ),
        );
        // A cache reset/tab switch cannot erase the new authored connection.
        assert.equal(
          filterValidSubGraphConnections({
            connections: graph.connections,
            nodesById: Object.fromEntries(graph.nodes.map((node) => [node.id, node])),
            project: makeProject(),
            referencedProjects: {},
            projectNodeRegistry: registry,
          }),
          graph.connections,
        );
        command.undo(params, applied as any, readState());
        assert.deepEqual(graph.connections, [original]);
        assert.deepEqual(
          (graph.nodes.find((node) => node.id === subgraph.id) as SubGraphNode).data.targetBoundary,
          oldBoundary,
        );
        // Redo uses the accepted contract even when preview data is gone.
        command.apply(params, applied as any, { ...readState(), referencedProjects: {} });
        assert.deepEqual(
          (graph.nodes.find((node) => node.id === subgraph.id) as SubGraphNode).data.targetBoundary,
          boundary,
        );
      });
    }
  }
}

test('boundary capture does not refresh existing ports, unavailable targets or breaking contracts', () => {
  const projectId = 'external' as ProjectId;
  const input = makeGraphInputNode('in', 'old');
  const oldTarget = makeProject([makeGraph('child', [input])]);
  const subgraph = makeSubGraphNode('target', 'child', {
    data: { targetProjectId: projectId, targetBoundary: getGraphBoundary(oldTarget, 'child' as GraphId) },
  });
  const oldWire = makeConnection({ inputId: 'old' as PortId });
  const newWire = makeConnection({ inputId: 'new' as PortId });
  const target = makeProject([makeGraph('child', [input, makeGraphInputNode('new', 'new')])]);
  const latestKey = getSubgraphProjectKey({ projectId, version: 'latest' });
  assert.deepEqual(captureSubgraphConnectionBoundaries([subgraph], oldWire, { [latestKey]: target }), []);
  assert.deepEqual(captureSubgraphConnectionBoundaries([subgraph], newWire, {}), []);
  assert.deepEqual(
    captureSubgraphConnectionBoundaries([subgraph], newWire, {
      [getSubgraphProjectKey({ projectId, version: 'published' })]: target,
    }),
    [],
  );
  const breaking = makeProject([makeGraph('child', [makeGraphInputNode('new', 'new')])]);
  assert.deepEqual(captureSubgraphConnectionBoundaries([subgraph], newWire, { [latestKey]: breaking }), []);
});

test('boundary capture upgrades older nodes without a contract and retains stable renamed port IDs', () => {
  const projectId = 'external' as ProjectId;
  const oldTarget = makeProject([makeGraph('child', [makeGraphInputNode('in', 'old')])]);
  const target = makeProject([
    makeGraph('child', [makeGraphInputNode('in', 'renamed'), makeGraphInputNode('new', 'new')]),
  ]);
  const subgraph = makeSubGraphNode('target', 'child', {
    data: { targetProjectId: projectId, targetBoundary: getGraphBoundary(oldTarget, 'child' as GraphId) },
  });
  const wire = makeConnection({ inputId: 'new' as PortId });
  const references = { [getSubgraphProjectKey({ projectId, version: 'latest' })]: target };
  const [change] = captureSubgraphConnectionBoundaries([subgraph], wire, references);
  assert.deepEqual(Object.fromEntries(change!.next.inputs.map((port) => [port.id, port.portId])), {
    renamed: 'old',
    new: 'new',
  });
  const older = makeSubGraphNode('target', 'child', { data: { targetProjectId: projectId } });
  const [upgrade] = captureSubgraphConnectionBoundaries([older], wire, references);
  assert.equal(upgrade!.previous, undefined);
  assert.equal(upgrade!.next.inputs.length, 2);
});

test('connecting two external Subgraphs snapshots both boundaries and restores the displaced wire', () => {
  const projectId = 'external' as ProjectId;
  const oldTarget = makeProject([
    makeGraph('child', [makeGraphInputNode('in-old', 'old'), makeGraphOutputNode('out-old', 'old')]),
  ]);
  const target = makeProject([
    makeGraph('child', [
      ...oldTarget.graphs['child' as GraphId]!.nodes,
      makeGraphInputNode('in-new', 'new'),
      makeGraphOutputNode('out-new', 'new'),
    ]),
  ]);
  const oldBoundary = getGraphBoundary(oldTarget, 'child' as GraphId)!;
  const source = makeSubGraphNode('external-source', 'child', {
    data: { targetProjectId: projectId, targetBoundary: oldBoundary },
  });
  const sink = makeSubGraphNode('external-sink', 'child', {
    data: { targetProjectId: projectId, targetBoundary: oldBoundary },
  });
  const displaced = makeConnection({
    inputNodeId: sink.id,
    inputId: 'new' as PortId,
    bendPoint: { x: 123, y: 456 },
  });
  let graph = makeGraph('main', [makeTextNode('source'), source, sink], [displaced]);
  const command = createMakeConnectionCommand((update) => {
    graph = update(graph);
  });
  const state = () => ({
    ...makeCommandState({ nodes: graph.nodes, connections: graph.connections }),
    referencedProjects: { [getSubgraphProjectKey({ projectId, version: 'latest' })]: target },
  });
  const wire = makeConnection({
    outputNodeId: source.id,
    outputId: 'new' as PortId,
    inputNodeId: sink.id,
    inputId: 'new' as PortId,
  });
  const applied = command.apply(wire, undefined, state());
  assert.equal(applied.boundaries.length, 2);
  assert.deepEqual(graph.connections, [wire]);
  for (const change of applied.boundaries) {
    const node = graph.nodes.find((entry) => entry.id === change.nodeId) as SubGraphNode;
    assert.deepEqual(node.data.targetBoundary, change.next);
    assert.notEqual(node.data.targetBoundary, change.next);
    assert.notEqual(change.previous, oldBoundary);
  }
  // Neither later preview edits nor mutations to the active graph may change
  // the accepted contract retained in history.
  target.graphs['child' as GraphId]!.nodes.pop();
  const sourceBoundary = (graph.nodes.find((entry) => entry.id === source.id) as SubGraphNode).data.targetBoundary!;
  sourceBoundary.outputs = sourceBoundary.outputs.slice(0, 1);
  command.undo(wire, applied, state());
  assert.deepEqual(graph.connections, [displaced]);
  for (const node of graph.nodes.filter((entry) => entry.type === 'subGraph')) {
    assert.deepEqual((node as SubGraphNode).data.targetBoundary, oldBoundary);
  }
  command.apply(wire, applied, { ...state(), referencedProjects: {} });
  assert.deepEqual(graph.connections, [wire]);
  for (const change of applied.boundaries) {
    assert.deepEqual(
      (graph.nodes.find((entry) => entry.id === change.nodeId) as SubGraphNode).data.targetBoundary,
      change.next,
    );
  }
});

test('boundary capture refuses type changes and stable-ID rename collisions', () => {
  const projectId = 'external' as ProjectId;
  const oldInput = makeGraphInputNode('in-old', 'old', { data: { dataType: 'string' } });
  const oldTarget = makeProject([makeGraph('child', [oldInput])]);
  const subgraph = makeSubGraphNode('target', 'child', {
    data: { targetProjectId: projectId, targetBoundary: getGraphBoundary(oldTarget, 'child' as GraphId) },
  });
  const wire = makeConnection({ inputId: 'new' as PortId });
  const key = getSubgraphProjectKey({ projectId, version: 'latest' });
  const typeChanged = makeProject([
    makeGraph('child', [
      makeGraphInputNode('in-old', 'old', { data: { dataType: 'number' } }),
      makeGraphInputNode('in-new', 'new'),
    ]),
  ]);
  assert.deepEqual(captureSubgraphConnectionBoundaries([subgraph], wire, { [key]: typeChanged }), []);
  const colliding = makeProject([
    makeGraph('child', [
      makeGraphInputNode('in-old', 'renamed', { data: { dataType: 'string' } }),
      makeGraphInputNode('in-collision', 'old'),
      makeGraphInputNode('in-new', 'new'),
    ]),
  ]);
  assert.deepEqual(captureSubgraphConnectionBoundaries([subgraph], wire, { [key]: colliding }), []);
});
