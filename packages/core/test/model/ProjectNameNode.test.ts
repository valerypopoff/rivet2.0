import { strict as assert } from 'node:assert';
import { it } from 'node:test';
import {
  GraphOutputNodeImpl,
  GraphProcessor,
  ProjectNameNodeImpl,
  ReferencedGraphAliasNodeImpl,
  SubGraphNodeImpl,
  createBuiltInRegistry,
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

function projectNameGraph(id: string): NodeGraph {
  const source = ProjectNameNodeImpl.create();
  const output = GraphOutputNodeImpl.create();
  output.data = { id: 'projectName', dataType: 'string' };
  return {
    metadata: { id: id as GraphId, name: id },
    nodes: [source, output],
    connections: [connect(source.id, 'projectName', output.id)],
  };
}

function project(id: string, title: string, main: NodeGraph, otherGraphs: NodeGraph[] = []): Project {
  return {
    graphs: Object.fromEntries([main, ...otherGraphs].map((graph) => [graph.metadata!.id!, graph])),
    metadata: {
      id: id as ProjectId,
      title,
      description: '',
      mainGraphId: main.metadata!.id!,
    },
    plugins: [],
  };
}

it('returns the executing project title', async () => {
  const graph = projectNameGraph('main');
  const result = await new GraphProcessor(
    project('root-project', 'Root project', graph),
    graph.metadata!.id!,
    createBuiltInRegistry(),
  ).processGraph(testProcessContext());

  assert.deepEqual(result.projectName, { type: 'string', value: 'Root project' });
});

it('keeps the same project title in an ordinary subgraph', async () => {
  const child = projectNameGraph('child');
  const subgraph = SubGraphNodeImpl.create();
  subgraph.data.graphId = child.metadata!.id!;
  const output = GraphOutputNodeImpl.create();
  output.data = { id: 'projectName', dataType: 'string' };
  const main: NodeGraph = {
    metadata: { id: 'main' as GraphId, name: 'main' },
    nodes: [subgraph, output],
    connections: [connect(subgraph.id, 'projectName', output.id)],
  };

  const result = await new GraphProcessor(
    project('root-project', 'Root project', main, [child]),
    main.metadata!.id!,
    createBuiltInRegistry(),
  ).processGraph(testProcessContext());

  assert.deepEqual(result.projectName, { type: 'string', value: 'Root project' });
});

it('returns the referenced project title through a newly-created referenced graph alias', async () => {
  const referencedGraph = projectNameGraph('referenced-graph');
  const referencedProject = project('referenced-project', 'Referenced project', referencedGraph);
  const alias = ReferencedGraphAliasNodeImpl.create();
  alias.data.projectId = referencedProject.metadata.id;
  alias.data.graphId = referencedGraph.metadata!.id!;
  alias.data.inputData = {};
  const output = GraphOutputNodeImpl.create();
  output.data = { id: 'projectName', dataType: 'string' };
  const main: NodeGraph = {
    metadata: { id: 'main' as GraphId, name: 'main' },
    nodes: [alias, output],
    connections: [connect(alias.id, 'projectName', output.id)],
  };
  const rootProject = project('root-project', 'Root project', main);
  rootProject.references = [{ id: referencedProject.metadata.id }];

  const result = await new GraphProcessor(rootProject, main.metadata!.id!, createBuiltInRegistry()).processGraph({
    ...testProcessContext(),
    projectReferenceLoader: { loadProject: async () => referencedProject },
  });

  assert.deepEqual(result.projectName, { type: 'string', value: 'Referenced project' });
});

it('uses the project from a direct node invocation', async () => {
  const graph = projectNameGraph('main');
  const node = new ProjectNameNodeImpl(ProjectNameNodeImpl.create());
  const outputs = await node.process({}, {
    project: project('direct-project', 'Direct project', graph),
  } as InternalProcessContext);

  assert.deepEqual(outputs, { projectName: { type: 'string', value: 'Direct project' } });
});
