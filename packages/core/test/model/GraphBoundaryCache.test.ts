import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyGraphBoundaryPortOrder,
  buildExcludedGraphBoundaryOutputs,
  buildGraphBoundaryInputData,
  getGraphBoundary,
  getGraphBoundaryInputDefinitions,
  getGraphBoundaryOutputDefinitions,
} from '../../src/model/GraphBoundaryCache.js';
import {
  type ChartNode,
  type DataType,
  type DataValue,
  type DynamicEditorEditor,
  type GraphId,
  type NodeGraph,
  type NodeId,
  type Project,
  type ProjectId,
} from '../../src/index.js';

const graphId = 'boundary-graph' as GraphId;

void describe('GraphBoundaryCache', () => {
  void it('derives sorted unique graph boundary definitions with first duplicate node winning', () => {
    const project = makeProject([
      makeTextNode('ordinary-node'),
      makeGraphInputNode('input-b-first', 'b', 'number', 'number'),
      makeGraphInputNode('input-a', 'a', 'string', 'string'),
      makeGraphInputNode('input-b-second', 'b', 'boolean', 'toggle'),
      makeGraphOutputNode('output-z-first', 'z', 'object'),
      makeGraphOutputNode('output-a', 'a', 'string'),
      makeGraphOutputNode('output-z-second', 'z', 'number'),
    ]);

    const boundary = getGraphBoundary(project, graphId);

    assert.ok(boundary);
    assert.deepEqual(boundary.inputs, [
      { dataType: 'string', editor: 'string', id: 'a', portId: 'a' },
      { dataType: 'number', editor: 'number', id: 'b', portId: 'b' },
    ]);
    assert.deepEqual(boundary.outputs, [
      { dataType: 'string', id: 'a', nodeId: 'output-a', portId: 'a' },
      { dataType: 'object', id: 'z', nodeId: 'output-z-first', portId: 'z' },
    ]);
    assert.deepEqual(getGraphBoundaryInputDefinitions(boundary), [
      { dataType: 'string', id: 'a', title: 'a' },
      { dataType: 'number', id: 'b', title: 'b' },
    ]);
    assert.deepEqual(getGraphBoundaryOutputDefinitions(boundary), [
      { dataType: 'string', id: 'a', title: 'a' },
      { dataType: 'object', id: 'z', title: 'z' },
    ]);
  });

  void it('applies persisted boundary port order while ignoring stale and duplicate ids', () => {
    const project = makeProject([
      makeGraphInputNode('input-a', 'a', 'string'),
      makeGraphInputNode('input-b', 'b', 'number'),
      makeGraphInputNode('input-c', 'c', 'boolean'),
      makeGraphOutputNode('output-a', 'a', 'string'),
      makeGraphOutputNode('output-b', 'b', 'number'),
      makeGraphOutputNode('output-c', 'c', 'boolean'),
    ]);
    const boundary = getGraphBoundary(project, graphId)!;

    assert.deepEqual(
      applyGraphBoundaryPortOrder(boundary.inputs, ['c', 'missing', 'a', 'c']).map((input) => input.id),
      ['c', 'a', 'b'],
    );
    assert.deepEqual(getGraphBoundaryInputDefinitions(boundary, ['c', 'missing', 'a', 'c']), [
      { dataType: 'boolean', id: 'c', title: 'c' },
      { dataType: 'string', id: 'a', title: 'a' },
      { dataType: 'number', id: 'b', title: 'b' },
    ]);
    assert.deepEqual(getGraphBoundaryOutputDefinitions(boundary, ['b', 'b', 'missing']), [
      { dataType: 'number', id: 'b', title: 'b' },
      { dataType: 'string', id: 'a', title: 'a' },
      { dataType: 'boolean', id: 'c', title: 'c' },
    ]);
  });

  void it('preserves default boundary order when persisted port order is absent', () => {
    const project = makeProject([
      makeGraphInputNode('input-c', 'c', 'boolean'),
      makeGraphInputNode('input-a', 'a', 'string'),
      makeGraphInputNode('input-b', 'b', 'number'),
    ]);
    const boundary = getGraphBoundary(project, graphId)!;

    assert.deepEqual(
      getGraphBoundaryInputDefinitions(boundary).map((input) => input.id),
      ['a', 'b', 'c'],
    );
  });

  void it('keeps boundary caches scoped to the provided cache object', () => {
    const project = makeProject([makeGraphInputNode('input-a', 'a', 'string')]);
    const graph = project.graphs[graphId]!;
    const cache = new WeakMap<NodeGraph, NonNullable<ReturnType<typeof getGraphBoundary>>>();

    const cachedBoundary = getGraphBoundary(project, graphId, cache);
    graph.nodes.push(makeGraphInputNode('input-b', 'b', 'number'));
    const reusedBoundary = getGraphBoundary(project, graphId, cache);
    const uncachedBoundary = getGraphBoundary(project, graphId);

    assert.equal(reusedBoundary, cachedBoundary);
    assert.deepEqual(
      reusedBoundary?.inputs.map((input) => input.id),
      ['a'],
    );
    assert.deepEqual(
      uncachedBoundary?.inputs.map((input) => input.id),
      ['a', 'b'],
    );
  });

  void it('builds subgraph input maps without dropping explicit null or undefined any values', () => {
    const project = makeProject([
      makeGraphInputNode('input-connected', 'connected', 'string'),
      makeGraphInputNode('input-defaulted', 'defaulted', 'string'),
      makeGraphInputNode('input-null', 'nullValue', 'any'),
      makeGraphInputNode('input-undefined', 'undefinedValue', 'any'),
      makeGraphInputNode('input-missing', 'missing', 'string'),
    ]);
    const boundary = getGraphBoundary(project, graphId)!;

    const inputData = buildGraphBoundaryInputData(
      boundary,
      {
        connected: { type: 'string', value: 'from connection' },
        nullValue: { type: 'any', value: null },
        undefinedValue: { type: 'any', value: undefined },
      },
      {
        connected: { type: 'string', value: 'from default' },
        defaulted: { type: 'string', value: 'default value' },
        missing: undefined as unknown as DataValue,
      },
    );

    assert.deepEqual(inputData, {
      connected: { type: 'string', value: 'from connection' },
      defaulted: { type: 'string', value: 'default value' },
      nullValue: { type: 'any', value: null },
      undefinedValue: { type: 'any', value: undefined },
    });
  });

  void it('builds excluded output maps for every graph output boundary port', () => {
    const project = makeProject([
      makeGraphOutputNode('output-b', 'b', 'number'),
      makeGraphOutputNode('output-a', 'a', 'string'),
    ]);
    const boundary = getGraphBoundary(project, graphId)!;

    assert.deepEqual(buildExcludedGraphBoundaryOutputs(boundary), {
      a: { type: 'control-flow-excluded', value: undefined },
      b: { type: 'control-flow-excluded', value: undefined },
    });
  });

  void it('returns undefined for missing graph ids', () => {
    assert.equal(getGraphBoundary(makeProject([]), undefined), undefined);
    assert.equal(getGraphBoundary(makeProject([]), 'missing-graph' as GraphId), undefined);
  });
});

function makeProject(nodes: ChartNode[]): Project {
  return {
    graphs: {
      [graphId]: {
        connections: [],
        metadata: {
          id: graphId,
          name: 'Boundary Graph',
        },
        nodes,
      },
    },
    metadata: {
      description: '',
      id: 'boundary-project' as ProjectId,
      mainGraphId: graphId,
      title: 'Boundary Project',
    },
    plugins: [],
  };
}

function makeGraphInputNode(
  nodeId: string,
  inputId: string,
  dataType: DataType,
  editor?: DynamicEditorEditor,
): ChartNode {
  return {
    data: {
      dataType,
      editor,
      id: inputId,
      useDefaultValueInput: false,
    },
    id: nodeId as NodeId,
    title: 'Graph Input',
    type: 'graphInput',
    visualData: { x: 0, y: 0, width: 240 },
  };
}

function makeGraphOutputNode(nodeId: string, outputId: string, dataType: DataType): ChartNode {
  return {
    data: {
      dataType,
      id: outputId,
    },
    id: nodeId as NodeId,
    title: 'Graph Output',
    type: 'graphOutput',
    visualData: { x: 300, y: 0, width: 240 },
  };
}

function makeTextNode(nodeId: string): ChartNode {
  return {
    data: {
      normalizeLineEndings: true,
      text: 'ordinary node',
    },
    id: nodeId as NodeId,
    title: 'Text',
    type: 'text',
    visualData: { x: 150, y: 0, width: 240 },
  };
}
