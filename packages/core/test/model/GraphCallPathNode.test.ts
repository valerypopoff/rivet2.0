import { strict as assert } from 'node:assert';
import { it } from 'node:test';
import {
  CallGraphNodeImpl,
  GraphCallPathNodeImpl,
  GraphOutputNodeImpl,
  GraphProcessor,
  GraphReferenceNodeImpl,
  SubGraphNodeImpl,
  createBuiltInRegistry,
  type DataValue,
  type GraphId,
  type InternalProcessContext,
  type NodeConnection,
  type NodeGraph,
  type NodeId,
  type PortId,
  type Project,
  type ProjectId,
} from '../../src/index.js';
import { testProcessContext } from '../testUtils.js';

function connect(source: NodeId, output: string, target: NodeId, input = 'value'): NodeConnection {
  return { outputNodeId: source, outputId: output as PortId, inputNodeId: target, inputId: input as PortId };
}

function graph(id: string, name: string | undefined, nodes: NodeGraph['nodes'], connections: NodeConnection[]): NodeGraph {
  return { metadata: { id: id as GraphId, name }, nodes, connections };
}

function output(id: string, dataType: 'string' | 'string[]' | 'object') {
  const node = GraphOutputNodeImpl.create();
  node.id = `${id}-output-node` as NodeId;
  node.data = { id, dataType };
  return node;
}

function pathGraph(id: string, name: string | undefined, childId?: GraphId): NodeGraph {
  const source = childId ? SubGraphNodeImpl.create() : GraphCallPathNodeImpl.create();
  source.id = `${id}-source` as NodeId;
  if (childId) (source as ReturnType<typeof SubGraphNodeImpl.create>).data.graphId = childId;
  const pathOutput = output('graphPath', 'string[]');
  const nameOutput = output('currentGraphName', 'string');
  pathOutput.id = `${id}-path-output` as NodeId;
  nameOutput.id = `${id}-name-output` as NodeId;
  return graph(id, name, [source, pathOutput, nameOutput], [
    connect(source.id, 'graphPath', pathOutput.id),
    connect(source.id, 'currentGraphName', nameOutput.id),
  ]);
}

function project(main: NodeGraph, otherGraphs: NodeGraph[] = []): Project {
  return {
    graphs: Object.fromEntries([main, ...otherGraphs].map((value) => [value.metadata!.id!, value])),
    metadata: {
      id: 'graph-call-path-test-project' as ProjectId,
      title: 'Graph Call Path Test',
      mainGraphId: main.metadata!.id!,
    },
    plugins: [],
  };
}

async function run(source: Project, graphId: GraphId) {
  return new GraphProcessor(source, graphId, createBuiltInRegistry()).processGraph(testProcessContext());
}

it('reports the executed entry graph through both node outputs', async () => {
  const main = pathGraph('main', 'Main');
  const result = await run(project(main), main.metadata!.id!);
  assert.deepEqual(result.graphPath, { type: 'string[]', value: ['Main'] });
  assert.deepEqual(result.currentGraphName, { type: 'string', value: 'Main' });
});

it('starts with the actual entry graph, even when the project has another main graph', async () => {
  const main = pathGraph('main', 'Main');
  const other = pathGraph('other', 'Direct entry');
  const result = await run(project(main, [other]), other.metadata!.id!);
  assert.deepEqual(result.graphPath?.value, ['Direct entry']);
  assert.equal(result.currentGraphName?.value, 'Direct entry');
});

it('includes every nested graph call and preserves repeated names', async () => {
  const inner = pathGraph('inner', 'Shared');
  const middle = pathGraph('middle', 'Shared', inner.metadata!.id!);
  const main = pathGraph('main', 'Main', middle.metadata!.id!);
  const result = await run(project(main, [middle, inner]), main.metadata!.id!);
  assert.deepEqual(result.graphPath?.value, ['Main', 'Shared', 'Shared']);
  assert.equal(result.currentGraphName?.value, 'Shared');
});

it('uses a readable placeholder when graph metadata has no name', async () => {
  const main = pathGraph('main', undefined);
  const result = await run(project(main), main.metadata!.id!);
  assert.deepEqual(result.graphPath?.value, ['(Unnamed Graph)']);
  assert.equal(result.currentGraphName?.value, '(Unnamed Graph)');
});

it('keeps its string output valid for a direct custom invocation with no path', async () => {
  const node = new GraphCallPathNodeImpl(GraphCallPathNodeImpl.create());
  const outputs = await node.process({}, { graphCallPath: [] } as InternalProcessContext);
  assert.deepEqual(outputs, {
    currentGraphName: { type: 'string', value: '(Unnamed Graph)' },
    graphPath: { type: 'string[]', value: [] },
  });
});

it('includes a graph chosen through Call Graph, not only Subgraph nodes', async () => {
  const child = pathGraph('child', 'Selected graph');
  const reference = GraphReferenceNodeImpl.create();
  reference.data.graphId = child.metadata!.id!;
  const caller = CallGraphNodeImpl.create();
  const resultOutput = output('result', 'object');
  const main = graph('main', 'Main', [reference, caller, resultOutput], [
    connect(reference.id, 'graph', caller.id, 'graph'),
    connect(caller.id, 'outputs', resultOutput.id),
  ]);
  const result = await run(project(main, [child]), main.metadata!.id!);
  const childOutputs = result.result?.value as Record<string, DataValue>;
  assert.deepEqual(childOutputs.graphPath, { type: 'string[]', value: ['Main', 'Selected graph'] });
  assert.deepEqual(childOutputs.currentGraphName, { type: 'string', value: 'Selected graph' });
});
