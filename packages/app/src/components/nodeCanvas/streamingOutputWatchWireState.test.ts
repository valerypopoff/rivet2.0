import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBuiltInRegistry,
  getGraphBoundary,
  getProjectStreamableGraphOutputNodeIdsByGraph,
  getSubgraphProjectKey,
  type ChartNode,
  type GraphId,
  type NodeGraph,
  type Project,
  type ProjectId,
  type NodeConnection,
  type NodeId,
  type NodePrefabId,
  type PortId,
} from '@valerypopoff/rivet2-core';
import {
  getStreamingOutputWatchBranchNodeIds,
  getProjectStreamingOutputWatchConnections,
} from './streamingOutputWatchWireState.js';

function node(id: string, type: ChartNode['type'], disabled = false): ChartNode {
  return {
    data: {},
    disabled,
    id: id as NodeId,
    title: id,
    type,
    visualData: { x: 0, y: 0 },
  };
}

function connection(inputId: string): NodeConnection {
  return {
    inputId: inputId as PortId,
    inputNodeId: 'watch' as NodeId,
    outputId: 'response' as PortId,
    outputNodeId: 'llm' as NodeId,
  };
}

const registry = createBuiltInRegistry();

function streamFixture() {
  const make = (id: string, type: Parameters<typeof registry.createDynamic>[0], data = {}) => {
    const created = registry.createDynamic(type);
    return {
      ...created,
      id: id as NodeId,
      data: { ...(created.data as object), ...(type === 'llmChatV2' ? { useAsGraphPartialOutput: true } : {}), ...data },
    };
  };
  const edge = (source: string, output: string, target: string, input: string): NodeConnection => ({
    outputNodeId: source as NodeId,
    outputId: output as PortId,
    inputNodeId: target as NodeId,
    inputId: input as PortId,
  });
  const leaf: NodeGraph = {
    metadata: { id: 'leaf' as GraphId, name: 'Leaf' },
    nodes: [make('producer', 'llmChatV2'), make('out', 'graphOutput', { id: 'answer', dataType: 'string' })],
    connections: [edge('producer', 'response', 'out', 'value')],
  };
  const middle: NodeGraph = {
    metadata: { id: 'middle' as GraphId, name: 'Middle' },
    nodes: [
      make('caller', 'subGraph', { graphId: 'leaf' }),
      make('out', 'graphOutput', { id: 'renamed', dataType: 'string' }),
    ],
    connections: [edge('caller', 'answer', 'out', 'value')],
  };
  const root: NodeGraph = {
    metadata: { id: 'root' as GraphId, name: 'Root' },
    nodes: [make('caller', 'subGraph', { graphId: 'middle' }), make('watch', 'watchStreamingOutput')],
    connections: [edge('caller', 'renamed', 'watch', 'stream')],
  };
  const project: Project = {
    metadata: { id: 'project' as ProjectId, title: 'Test', description: '' },
    graphs: { [leaf.metadata!.id!]: leaf, [middle.metadata!.id!]: middle, [root.metadata!.id!]: root },
    plugins: [],
  };
  const marked = (graph: NodeGraph) =>
    getProjectStreamingOutputWatchConnections({ project, graph, registry, referencedProjects: {}, onlyStreamCapableSources: true });
  return { project, root, middle, leaf, marked, make, edge };
}

function inputStreamFixture() {
  const fixture = streamFixture();
  const { root, middle, leaf, make, edge } = fixture;
  root.nodes = [make('producer', 'llmChatV2'), make('caller', 'subGraph', { graphId: 'middle' })];
  root.connections = [edge('producer', 'response', 'caller', 'outer')];
  middle.nodes = [make('input', 'graphInput', { id: 'outer' }), make('caller', 'subGraph', { graphId: 'leaf' })];
  middle.connections = [edge('input', 'data', 'caller', 'stream')];
  leaf.nodes = [make('input', 'graphInput', { id: 'stream' }), make('watch', 'watchStreamingOutput')];
  leaf.connections = [edge('input', 'data', 'watch', 'stream')];
  return fixture;
}

test('traces a nested Watch back through differently named Graph Inputs to every caller', () => {
  const { root, middle, leaf, marked, make, edge } = inputStreamFixture();
  for (const graph of [root, middle, leaf]) assert.deepEqual(marked(graph), new Set(graph.connections));
  middle.nodes.push(make('other', 'graphInput', { id: 'unwatched' }));
  root.connections.push(edge('producer', 'response', 'caller', 'unwatched'));
  assert.deepEqual(marked(root), new Set([root.connections[0]]));
  leaf.nodes[1]!.disabled = true;
  assert.equal(marked(root).size, 0);
});

test('input routes ignore disabled callers, invalid ports, and ordinary processing nodes', () => {
  for (const mode of ['disabled', 'invalid', 'ordinary']) {
    const { root, middle, marked, make, edge } = inputStreamFixture();
    if (mode === 'disabled') root.nodes[1]!.disabled = true;
    if (mode === 'invalid') root.connections[0]!.inputId = 'missing' as PortId;
    if (mode === 'ordinary') {
      middle.nodes.push(make('plain', 'passthrough'));
      middle.connections = [edge('input', 'data', 'plain', 'input1'), edge('plain', 'output1', 'caller', 'stream')];
    }
    assert.equal(marked(root).size, 0, mode);
  }
});

test('input routes reject duplicate providers for the same caller input', () => {
  const { root, middle, leaf, marked, make, edge } = inputStreamFixture();
  root.nodes.push(make('second', 'llmChatV2'));
  root.connections.push(edge('second', 'response', 'caller', 'outer'));

  for (const graph of [root, middle, leaf]) assert.equal(marked(graph).size, 0);
});

test('input routes stop at final-only callers and output-selection pruning', () => {
  for (const mode of ['conditional', 'split', 'error-output', 'pruned', 'default-input']) {
    const { root, middle, leaf, marked } = inputStreamFixture();
    const caller = middle.nodes[1]!;
    if (mode === 'conditional') caller.isConditional = true;
    if (mode === 'split') caller.isSplitRun = true;
    if (mode === 'error-output') Object.assign(caller.data as object, { useErrorOutput: true });
    if (mode === 'pruned') Object.assign(caller.data as object, { skipUnusedOutputs: true });
    if (mode === 'default-input') Object.assign(middle.nodes[0]!.data as object, { useDefaultValueInput: true });
    for (const graph of [root, middle, leaf]) assert.equal(marked(graph).size, 0, mode);
  }
});

test('traces across a producer output and a consumer input in the same route', () => {
  const { project, root, middle, leaf, marked, make, edge } = inputStreamFixture();
  const producer: NodeGraph = {
    metadata: { id: 'producer-graph' as GraphId, name: 'Producer' },
    nodes: [make('llm', 'llmChatV2'), make('out', 'graphOutput', { id: 'answer' })],
    connections: [edge('llm', 'response', 'out', 'value')],
  };
  project.graphs[producer.metadata!.id!] = producer;
  root.nodes[0] = make('producer', 'subGraph', { graphId: producer.metadata!.id });
  root.connections[0] = edge('producer', 'answer', 'caller', 'outer');
  for (const graph of [root, middle, leaf, producer]) assert.deepEqual(marked(graph), new Set(graph.connections));
  root.nodes[0]!.isConditional = true;
  for (const graph of [root, middle, leaf, producer]) assert.deepEqual(marked(graph), new Set(graph.connections));
});

test('a conditional Referenced Graph Alias relays named outputs', () => {
  const { project, root, middle, leaf, make } = streamFixture();
  const referenced: Project = {
    metadata: { id: 'referenced' as ProjectId, title: 'Referenced', description: '' },
    graphs: { [leaf.metadata!.id!]: leaf },
    plugins: [],
  };
  delete project.graphs[leaf.metadata!.id!];
  middle.nodes[0] = {
    ...make('caller', 'referencedGraphAlias', { projectId: 'referenced', graphId: 'leaf' }),
    isConditional: true,
  };
  for (const graph of [root, middle, leaf]) {
    const owner = graph === leaf ? referenced : project;
    assert.deepEqual(
      getProjectStreamingOutputWatchConnections({
        project: owner,
        graph,
        registry,
        referencedProjects: { [project.metadata.id]: project, [referenced.metadata.id]: referenced },
      }),
      new Set(graph.connections),
    );
  }
});

test('input routes cross referenced graph callers and terminate recursive calls', () => {
  const { project, root, middle, leaf, make, edge } = inputStreamFixture();
  const external: Project = {
    metadata: { id: 'external' as ProjectId, title: 'External', description: '' },
    graphs: { [leaf.metadata!.id!]: leaf },
    plugins: [],
  };
  delete project.graphs[leaf.metadata!.id!];
  middle.nodes[1] = make('caller', 'referencedGraphAlias', { projectId: 'external', graphId: 'leaf' });
  middle.nodes.push(make('recursive', 'subGraph', { graphId: 'middle' }));
  middle.connections.push(edge('input', 'data', 'recursive', 'outer'));
  assert.deepEqual(
    getProjectStreamingOutputWatchConnections({
      project,
      graph: root,
      registry,
      referencedProjects: { [external.metadata.id]: external },
    }),
    new Set(root.connections),
  );
});

test('frozen input boundaries and callers do not propagate Watch demand to their parents', () => {
  for (const frozen of ['input', 'caller', 'watch'] as const) {
    const { project, root, middle, leaf } = inputStreamFixture();
    const frozenGraph = frozen === 'caller' ? middle : leaf;
    const frozenNode = frozen === 'caller' ? middle.nodes[1]! : leaf.nodes[frozen === 'input' ? 0 : 1]!;
    assert.equal(
      getProjectStreamingOutputWatchConnections({
        project,
        graph: root,
        registry,
        referencedProjects: {},
        frozenNodeOutputs: { [frozenGraph.metadata!.id!]: { [frozenNode.id]: [{}] } },
      }).size,
      0,
      frozen,
    );
  }
});

test('a frozen producer Subgraph has no streaming route at any depth', () => {
  const { project, root, leaf } = streamFixture();
  const options = {
    project,
    registry,
    referencedProjects: {},
    frozenNodeOutputs: { [root.metadata!.id!]: { [root.nodes[0]!.id]: [{}] } },
  };
  assert.equal(getProjectStreamingOutputWatchConnections({ ...options, graph: root }).size, 0);
  assert.equal(getProjectStreamingOutputWatchConnections({ ...options, graph: leaf }).size, 0);
});

test('ambiguous Watch inputs do not mark either route', () => {
  const { root, leaf, marked, make, edge } = streamFixture();
  root.nodes.push(make('second', 'llmChatV2'));
  root.connections.push(edge('second', 'response', 'watch', 'stream'));
  assert.equal(marked(root).size, 0);
  assert.equal(marked(leaf).size, 0);
});

test('port definitions are resolved once per visited node and never for unrelated branches', (t) => {
  const { root, project, make, edge } = inputStreamFixture();
  root.nodes.push(make('unrelated', 'llmChatV2'), make('sink', 'passthrough'));
  root.connections.push(edge('unrelated', 'response', 'sink', 'input1'));
  const localRegistry = createBuiltInRegistry();
  const lookup = t.mock.method(localRegistry, 'createDynamicImpl');
  getProjectStreamingOutputWatchConnections({ project, graph: root, registry: localRegistry, referencedProjects: {} });
  const resolved = lookup.mock.calls.map((call) => call.arguments[0]);
  assert.ok(resolved.length > 0);
  assert.ok(resolved.every((node) => node.id !== 'unrelated' && node.id !== 'sink'));
  assert.equal(new Set(resolved).size, resolved.length);
});

test('traces renamed streaming outputs at every nesting level with graph-local node IDs', () => {
  const { root, middle, leaf, marked } = streamFixture();
  for (const graph of [root, middle, leaf]) assert.deepEqual(marked(graph), new Set(graph.connections));
});

test('uses unsaved active graph changes and removes arrows when the Watch is disabled', () => {
  const { root, leaf, marked } = streamFixture();
  const live = { ...leaf, connections: [] };
  assert.equal(marked(live).size, 0);
  root.nodes[1]!.disabled = true;
  assert.equal(marked(leaf).size, 0);
});

test('stops at ordinary processing nodes and leaves unrelated fanout ordinary', () => {
  const { leaf, marked, make, edge } = streamFixture();
  leaf.nodes.push(make('plain', 'passthrough'));
  const fanout = edge('producer', 'response', 'plain', 'input1');
  leaf.connections.push(fanout);
  assert.deepEqual(marked(leaf), new Set([leaf.connections[0]]));
  leaf.connections[0] = edge('plain', 'output1', 'out', 'value');
  assert.equal(marked(leaf).size, 0);
});

test('ordinary values and non-streaming LLM outputs never receive stream arrows', () => {
  const { root, project, make, edge } = streamFixture();
  root.nodes = [make('plain', 'text'), make('watch', 'watchStreamingOutput')];
  root.connections = [edge('plain', 'output', 'watch', 'stream')];
  const marked = () => getProjectStreamingOutputWatchConnections({ project, graph: root, registry, referencedProjects: {}, onlyStreamCapableSources: true });
  assert.equal(marked().size, 0);
  assert.deepEqual(
    getProjectStreamingOutputWatchConnections({ project, graph: root, registry, referencedProjects: {} }),
    new Set(root.connections),
    'ordinary final values still reach Watch at runtime',
  );

  root.nodes[0] = make('plain', 'llmChatV2', { useAsGraphPartialOutput: false });
  root.connections[0] = edge('plain', 'response', 'watch', 'stream');
  assert.equal(marked().size, 0);

  root.nodes[0] = make('plain', 'streamValue');
  root.connections[0] = edge('plain', 'value', 'watch', 'stream');
  assert.deepEqual(marked(), new Set(root.connections));
});

test('cross-project preview derives all graph outputs in one pass', (t) => {
  const { project: target, leaf, middle, root: targetRoot, make, edge } = streamFixture();
  const targetId = 'stream-target' as ProjectId;
  target.metadata.id = targetId;
  const previewRegistry = createBuiltInRegistry();
  const lookup = t.mock.method(previewRegistry, 'createDynamicImpl');
  const streamableByGraph = getProjectStreamableGraphOutputNodeIdsByGraph({
    project: target,
    registry: previewRegistry,
    referencedProjects: {},
  });
  assert.deepEqual(streamableByGraph[leaf.metadata!.id!], ['out' as NodeId]);
  assert.deepEqual(streamableByGraph[middle.metadata!.id!], ['out' as NodeId]);
  assert.deepEqual(streamableByGraph[targetRoot.metadata!.id!], []);
  assert.equal(lookup.mock.calls.filter((call) => call.arguments[0].id === 'producer').length, 1);
  const streamable = new Set(streamableByGraph[leaf.metadata!.id!]);
  const preview: Project = {
    ...target,
    graphs: {
      [leaf.metadata!.id!]: {
        ...leaf,
        nodes: leaf.nodes.filter((node) => node.type === 'graphOutput'),
        connections: [],
      },
    },
  };
  const caller = make('caller', 'subGraph', {
    graphId: leaf.metadata!.id,
    targetProjectId: targetId,
    targetVersion: 'latest',
    targetBoundary: getGraphBoundary(target, leaf.metadata!.id),
  });
  const root: NodeGraph = {
    metadata: { id: 'root' as GraphId, name: 'Root' },
    nodes: [caller, make('watch', 'watchStreamingOutput')],
    connections: [edge('caller', 'answer', 'watch', 'stream')],
  };
  const owner: Project = {
    ...target,
    metadata: { ...target.metadata, id: 'owner' as ProjectId },
    graphs: { [root.metadata!.id!]: root },
  };
  const options = {
    project: owner,
    graph: root,
    registry,
    referencedProjects: { [getSubgraphProjectKey({ projectId: targetId, version: 'latest' })]: preview },
    onlyStreamCapableSources: true,
  };
  assert.deepEqual(
    getProjectStreamingOutputWatchConnections({
      ...options,
      getPreviewGraphOutputStreamingCapability: (project, _graph, nodeId) =>
        project === preview ? streamable.has(nodeId) : undefined,
    }),
    new Set(root.connections),
  );
  assert.equal(
    getProjectStreamingOutputWatchConnections({
      ...options,
      getPreviewGraphOutputStreamingCapability: (project) => project === preview ? false : undefined,
    }).size,
    0,
  );
});

test('does not descend through final-only, ambiguous, missing, or stale named outputs', () => {
  for (const mode of [
    'conditional',
    'split-output',
    'split-source',
    'duplicate',
    'error',
    'missing-port',
    'disabled',
  ] as const) {
    const { root, leaf, middle, marked, make } = streamFixture();
    if (mode === 'conditional') leaf.nodes[1]!.isConditional = true;
    if (mode === 'split-output') leaf.nodes[1]!.isSplitRun = true;
    if (mode === 'split-source') leaf.nodes[0]!.isSplitRun = true;
    if (mode === 'duplicate') leaf.nodes.push(make('duplicate', 'graphOutput', { id: 'answer', dataType: 'string' }));
    if (mode === 'error') (middle.nodes[0]!.data as { useErrorOutput: boolean }).useErrorOutput = true;
    if (mode === 'missing-port') leaf.connections[0]!.outputId = 'removed' as PortId;
    if (mode === 'disabled') leaf.nodes[0]!.disabled = true;
    for (const graph of [root, middle, leaf]) assert.equal(marked(graph).size, 0, mode);
  }
});

test('frozen Graph Outputs and unresolved recursive callers have no streaming route', () => {
  const { project, leaf, middle, root } = streamFixture();
  assert.equal(
    getProjectStreamingOutputWatchConnections({
      project,
      graph: leaf,
      registry,
      referencedProjects: {},
      frozenNodeOutputs: { [leaf.metadata!.id!]: { ['out' as NodeId]: [{}] } },
    }).size,
    0,
  );
  (middle.nodes[0]!.data as { graphId: string }).graphId = 'middle';
  middle.connections[0]!.outputId = 'renamed' as PortId;
  assert.equal(
    getProjectStreamingOutputWatchConnections({ project, graph: root, registry, referencedProjects: {} }).size,
    0,
  );
});

test('a shadowed Graph Output provider is not presented as a streaming route', () => {
  const { root, middle, leaf, marked, make, edge } = streamFixture();
  leaf.nodes.push(make('shadowed', 'llmChatV2'));
  leaf.connections.push(edge('shadowed', 'response', 'out', 'value'));

  assert.deepEqual(marked(root), new Set(root.connections));
  assert.deepEqual(marked(middle), new Set(middle.connections));
  assert.deepEqual(marked(leaf), new Set([leaf.connections[0]]));
});

test('an ineligible first Graph Output provider does not expose a shadowed streaming provider', () => {
  const { root, middle, leaf, marked, make, edge } = streamFixture();
  const shadowed = leaf.nodes[0]!;
  const selected = make('selected', 'llmChatV2');
  selected.isSplitRun = true;
  leaf.nodes.splice(0, 1, selected, shadowed);
  leaf.connections = [edge('selected', 'response', 'out', 'value'), edge('producer', 'response', 'out', 'value')];

  for (const graph of [root, middle, leaf]) assert.equal(marked(graph).size, 0);
});

test('follows the watched Data Bus channel without marking other channels', () => {
  const { leaf, marked, make, edge } = streamFixture();
  leaf.nodes.push(make('bus', 'dataBus'));
  leaf.connections = [
    edge('producer', 'response', 'bus', 'input1'),
    edge('bus', 'output1', 'out', 'value'),
    edge('producer', 'response', 'bus', 'input2'),
  ];
  assert.deepEqual(marked(leaf), new Set(leaf.connections.slice(0, 2)));
  leaf.nodes[0]!.isSplitRun = true;
  assert.equal(marked(leaf).size, 0);
});

test('follows referenced aliases while keeping project identities separate', () => {
  const { project, leaf, middle, root, make } = streamFixture();
  const external: Project = {
    ...project,
    metadata: { ...project.metadata, id: 'external' as ProjectId },
    graphs: { [leaf.metadata!.id!]: leaf },
  };
  delete project.graphs[leaf.metadata!.id!];
  middle.nodes[0] = make('caller', 'referencedGraphAlias', { projectId: 'external', graphId: 'leaf' });
  assert.deepEqual(
    getProjectStreamingOutputWatchConnections({
      project,
      graph: middle,
      registry,
      referencedProjects: { [external.metadata.id]: external },
    }),
    new Set(middle.connections),
  );
  assert.deepEqual(
    getProjectStreamingOutputWatchConnections({
      project,
      graph: root,
      registry,
      referencedProjects: { [external.metadata.id]: external },
    }),
    new Set(root.connections),
  );
});

test('resolves library callers and marks only the watched named output', () => {
  const { project, middle, leaf, marked, make, edge } = streamFixture();
  const source = middle.nodes[0]!;
  const prefabId = 'caller' as NodePrefabId;
  project.nodePrefabs = { [prefabId]: { id: prefabId, sourceNode: source } };
  middle.nodes[0] = { ...source, type: 'nodePrefabInstance', data: { prefabId: 'caller' } };
  leaf.nodes.push(make('other-output', 'graphOutput', { id: 'unwatched', dataType: 'string' }));
  leaf.connections.push(edge('producer', 'response', 'other-output', 'value'));
  assert.deepEqual(marked(middle), new Set(middle.connections));
  assert.deepEqual(marked(leaf), new Set([leaf.connections[0]]));
});

test('leaves disabled and non-watch targets visually ordinary', () => {
  const { leaf, root, marked, make, edge } = streamFixture();
  root.nodes[1]!.disabled = true;
  assert.equal(marked(root).size, 0);
  assert.equal(marked(leaf).size, 0);
  root.nodes[1] = make('plain', 'passthrough');
  root.connections = [edge('caller', 'renamed', 'plain', 'input1')];
  assert.equal(marked(root).size, 0);
  assert.equal(marked(leaf).size, 0);
});

test('finds the Watch branch through Stop but not its ordinary downstream work', () => {
  const connections: NodeConnection[] = [
    connection('stream'),
    {
      inputId: 'input' as PortId,
      inputNodeId: 'transform' as NodeId,
      outputId: 'value' as PortId,
      outputNodeId: 'watch' as NodeId,
    },
    {
      inputId: 'value' as PortId,
      inputNodeId: 'stop' as NodeId,
      outputId: 'output' as PortId,
      outputNodeId: 'transform' as NodeId,
    },
    {
      inputId: 'input' as PortId,
      inputNodeId: 'after-stop' as NodeId,
      outputId: 'value' as PortId,
      outputNodeId: 'stop' as NodeId,
    },
  ];

  const branchNodeIds = getStreamingOutputWatchBranchNodeIds({
    connections,
    nodes: [
      node('llm', 'llmChatV2'),
      node('watch', 'watchStreamingOutput'),
      node('transform', 'passthrough'),
      node('stop', 'stopWatchingStreamingOutput'),
      node('after-stop', 'passthrough'),
    ],
  });

  assert.deepEqual(branchNodeIds, new Set(['transform' as NodeId, 'stop' as NodeId]));
});
