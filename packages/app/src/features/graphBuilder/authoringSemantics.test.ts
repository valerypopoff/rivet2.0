import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NODE_PREFAB_INSTANCE_TYPE,
  NodeImpl,
  NodeRegistration,
  nodeDefinition,
  registerBuiltInNodes,
  type ChartNode,
  type GraphId,
  type Inputs,
  type InternalProcessContext,
  type NodeConnection,
  type NodeId,
  type NodeInputDefinition,
  type NodeOutputDefinition,
  type NodePrefabId,
  type Outputs,
  type PortId,
  type Project,
  type ProjectId,
  type RivetPlugin,
} from '@valerypopoff/rivet2-core';
import {
  GRAPH_BUILDER_LIMITS,
  GRAPH_BUILDER_PROTOCOL_VERSION,
  GraphBuilderTransactionKernel,
  type GraphBuilderAuthoringProject,
  type GraphBuilderTouchedScope,
} from '../../domain/graphBuilder/index.js';
import { createGraphBuilderAuthoringCatalog, type GraphBuilderNodeAuthoringAdapter } from './authoringCatalog.js';
import { createAppGraphBuilderAuthoringSemantics } from './authoringSemantics.js';
import { buildGraphBuilderProjection, createGraphBuilderReadExecutor } from './readExecutor.js';

const activeGraphId = 'main' as GraphId;
const childGraphId = 'child' as GraphId;

function node(type: string, id: string, data: Record<string, unknown> = {}, title = type): ChartNode {
  return {
    id: id as NodeId,
    type,
    title,
    visualData: { x: 0, y: 0 },
    data,
  };
}

function project(nodes: ChartNode[] = [], connections: NodeConnection[] = []): GraphBuilderAuthoringProject {
  return {
    metadata: {
      id: 'project' as ProjectId,
      title: 'Project',
      description: '',
      mainGraphId: activeGraphId,
      knowledgeStores: {
        books: { displayName: 'Books', provider: 'test', config: { apiKey: 'must-not-leak' } },
      },
      mcpServer: {
        mcpServers: {
          local: { command: 'secret-command', env: { PASSWORD: 'must-not-leak' } },
        },
      },
    },
    graphs: {
      [activeGraphId]: {
        metadata: { id: activeGraphId, name: 'Main' },
        nodes,
        connections,
      },
      [childGraphId]: {
        metadata: { id: childGraphId, name: 'Child' },
        nodes: [
          node('graphInput', 'child-input', { id: 'question', dataType: 'string' }),
          node('graphOutput', 'child-output', { id: 'answer', dataType: 'string' }),
        ],
        connections: [],
      },
    },
    nodePrefabs: {
      ['linkedText' as NodePrefabId]: {
        id: 'linkedText' as NodePrefabId,
        sourceNode: node('text', 'prefab-source', { text: 'Hello {{name}}', normalizeLineEndings: true }, 'Greeting'),
      },
    },
  };
}

function touched(): GraphBuilderTouchedScope {
  return {
    graphIds: [activeGraphId],
    nodeIds: [],
    connectionKeys: [],
    operationIndices: [],
  };
}

function setup(
  inputProject = project(),
  registry: NodeRegistration<any, any> = registerBuiltInNodes(new NodeRegistration()),
  options: {
    additiveBoundaryGraphIds?: readonly GraphId[];
    mutableBoundaryGraphIds?: readonly GraphId[];
  } = {},
) {
  const referencedProject = {
    metadata: {
      id: 'reference' as ProjectId,
      title: 'Reference',
      description: '',
      mainGraphId: 'remote' as GraphId,
    },
    graphs: {
      remote: {
        metadata: { id: 'remote' as GraphId, name: 'Remote Graph' },
        nodes: [
          node('graphInput', 'remote-in', { id: 'query', dataType: 'string' }),
          node('graphOutput', 'remote-out', { id: 'result', dataType: 'string' }),
        ],
        connections: [],
      },
    },
  } as Project;
  const referencedProjects = { [referencedProject.metadata.id]: referencedProject };
  const catalog = createGraphBuilderAuthoringCatalog({
    registry,
    project: inputProject,
    referencedProjects,
  });
  const semantics = createAppGraphBuilderAuthoringSemantics({
    registry,
    catalog,
    referencedProjects,
    ...options,
  });
  return { catalog, semantics, referencedProjects };
}

test('project-boundary validation cannot alias distinct graph-key tuples', () => {
  const base = project();
  const { semantics } = setup(base);
  const candidate = structuredClone(base);
  candidate.graphs = {
    ['child\0main' as GraphId]: structuredClone(base.graphs[activeGraphId]!),
  };

  const validation = semantics.validateCandidate({
    base,
    candidate,
    touchedScope: {
      graphIds: [],
      nodeIds: [],
      connectionKeys: [],
      operationIndices: [],
    },
  });

  assert.ok(validation.diagnostics.some((entry) => entry.ruleId === 'project-shell-identity'));
});

test('conditional ports and project-aware Subgraph boundaries are resolved from the active authoring project', () => {
  const subgraph = {
    ...node('subGraph', 'subgraph', { graphId: childGraphId, useErrorOutput: false }),
    isConditional: true,
  };
  const inputProject = project([subgraph]);
  const { semantics } = setup(inputProject);

  const ports = semantics.resolvePorts({
    graphId: activeGraphId,
    nodeId: subgraph.id,
    project: inputProject,
  });

  assert.deepEqual(
    ports.inputs.map((port) => port.id),
    ['question', '$if'],
  );
  assert.deepEqual(
    ports.outputs.map((port) => port.id),
    ['answer'],
  );
});

test('transactional authoring rejects a Data Bus relay cycle before accepting the draft', () => {
  const source = node('graphInput', 'source', { id: 'source', dataType: 'any' }, 'Source');
  const bus = node('dataBus', 'bus', {}, 'Shared values');
  const output = node('graphOutput', 'result', { id: 'result', dataType: 'any' }, 'Result');
  const inputProject = project(
    [source, bus, output],
    [
      {
        outputNodeId: source.id,
        outputId: 'data' as PortId,
        inputNodeId: bus.id,
        inputId: 'input1' as PortId,
      },
      {
        outputNodeId: bus.id,
        outputId: 'output1' as PortId,
        inputNodeId: output.id,
        inputId: 'value' as PortId,
      },
    ],
  );
  const { semantics } = setup(inputProject);
  const kernel = new GraphBuilderTransactionKernel({
    project: inputProject,
    activeGraphId,
    authorization: {
      allowedGraphIds: [activeGraphId],
      allowedOperations: ['connect', 'disconnect'],
      allowSemanticCrossGraphPropagation: false,
      sensitiveFieldAccess: 'none',
    },
    semantics,
    idGenerator: () => 'unused' as NodeId,
  });

  const result = kernel.applyPatch({
    protocolVersion: GRAPH_BUILDER_PROTOCOL_VERSION,
    patchId: 'reject-data-bus-relay-cycle',
    expectedDraftRevision: 0,
    operations: [
      {
        op: 'connect',
        from: { node: { kind: 'existing', nodeId: bus.id }, port: 'output1' },
        to: { node: { kind: 'existing', nodeId: bus.id }, port: 'input2' },
      },
      {
        op: 'disconnect',
        from: { node: { kind: 'existing', nodeId: source.id }, port: 'data' },
        to: { node: { kind: 'existing', nodeId: bus.id }, port: 'input1' },
      },
      {
        op: 'connect',
        from: { node: { kind: 'existing', nodeId: bus.id }, port: 'output2' },
        to: { node: { kind: 'existing', nodeId: bus.id }, port: 'input1' },
      },
    ],
  });

  assert.equal(result.disposition, 'rejected');
  assert.ok(result.diagnostics.some((entry) => entry.ruleId === 'data-bus-topology'));
  assert.ok(result.diagnostics.some((entry) => /relay cycle/u.test(entry.message)));
  assert.equal(kernel.getDraftRevision(), 0);
  assert.deepEqual(
    kernel.getDraft().graphs[activeGraphId]!.connections,
    inputProject.graphs[activeGraphId]!.connections,
  );
});

test('Subgraph output pruning is an independently authored, default-off boolean setting', () => {
  const inputProject = project();
  const { catalog } = setup(inputProject);
  const createSubgraph = (id: string) =>
    catalog.createNode({
      authoringChoiceId: 'registered:subGraph',
      allocatedNodeId: id as NodeId,
      project: inputProject,
      settings: { graphId: childGraphId },
    });
  const first = createSubgraph('first');
  const second = createSubgraph('second');
  assert.equal((first.data as Record<string, unknown>).skipUnusedOutputs, false);
  const optimized = catalog.applyNodeSettings({
    node: first,
    project: inputProject,
    settings: { skipUnusedOutputs: true },
  });
  assert.equal(catalog.projectNodeSafeSettings(optimized, inputProject)?.skipUnusedOutputs, true);
  assert.equal(catalog.projectNodeSafeSettings(first, inputProject)?.skipUnusedOutputs, false);
  assert.equal(catalog.projectNodeSafeSettings(second, inputProject)?.skipUnusedOutputs, false);

  const descriptor = catalog
    .getEntry('registered:subGraph')!
    .settings.find((setting) => setting.key === 'skipUnusedOutputs');
  assert.equal(descriptor?.valueKind, 'boolean');
  assert.match(descriptor!.description, /side effects and errors/);
  assert.throws(
    () =>
      catalog.applyNodeSettings({
        node: first,
        project: inputProject,
        settings: { skipUnusedOutputs: 'true' },
      }),
    /boolean/i,
  );
});

test('tool-delegation built-ins expose only the safe settings needed for auto-continuation', () => {
  const inputProject = project();
  const { catalog, semantics } = setup(inputProject);
  const llm = catalog.createNode({
    authoringChoiceId: 'registered:llmChatV2',
    allocatedNodeId: 'llm' as NodeId,
    project: inputProject,
    settings: {
      useToolCalling: true,
      autoContinueToolCalls: true,
      parallelToolCalls: true,
      maxToolRounds: 4,
    },
  });
  const firstDelegate = catalog.createNode({
    authoringChoiceId: 'registered:delegateFunctionCall',
    allocatedNodeId: 'delegate-a' as NodeId,
    project: inputProject,
    settings: {
      autoDelegate: true,
      fallBackToExternalCall: true,
      passthroughErrors: true,
    },
  });
  const secondDelegate = catalog.createNode({
    authoringChoiceId: 'registered:delegateFunctionCall',
    allocatedNodeId: 'delegate-b' as NodeId,
    project: inputProject,
  });
  const tool = catalog.createNode({
    authoringChoiceId: 'registered:gptFunction',
    allocatedNodeId: 'tool' as NodeId,
    project: inputProject,
    settings: {
      name: 'weather',
      description: 'Fetch the weather.',
    },
  });
  const candidate = project(
    [tool, llm, firstDelegate, secondDelegate],
    [
      {
        outputNodeId: tool.id,
        outputId: 'function' as PortId,
        inputNodeId: llm.id,
        inputId: 'functions' as PortId,
      },
      {
        outputNodeId: llm.id,
        outputId: 'function-calls' as PortId,
        inputNodeId: firstDelegate.id,
        inputId: 'function-call' as PortId,
      },
    ],
  );

  assert.deepEqual(
    semantics
      .resolvePorts({ graphId: activeGraphId, nodeId: llm.id, project: candidate })
      .inputs.map((port) => port.id),
    ['systemPrompt', 'functions', 'prompt'],
  );
  assert.ok(
    semantics
      .resolvePorts({ graphId: activeGraphId, nodeId: llm.id, project: candidate })
      .outputs.some((port) => port.id === ('function-calls' as PortId)),
  );
  assert.deepEqual(
    { ...catalog.projectNodeSafeSettings(llm, candidate) },
    {
      useToolCalling: true,
      autoContinueToolCalls: true,
      parallelToolCalls: true,
      maxToolRounds: 4,
    },
  );
  assert.deepEqual(
    { ...catalog.projectNodeSafeSettings(firstDelegate, candidate) },
    {
      autoDelegate: true,
      fallBackToExternalCall: true,
      passthroughErrors: true,
    },
  );
  assert.throws(
    () =>
      catalog.applyNodeSettings({
        node: firstDelegate,
        project: candidate,
        settings: { autoDelegate: false },
      }),
    /Auto Delegate mode/,
  );
  assert.throws(
    () =>
      catalog.applyNodeSettings({
        node: llm,
        project: candidate,
        settings: { useToolCalling: false },
      }),
    /must enable tool calling/,
  );

  const ambiguous = structuredClone(candidate);
  ambiguous.graphs[activeGraphId]!.connections.push({
    outputNodeId: llm.id,
    outputId: 'function-calls' as PortId,
    inputNodeId: secondDelegate.id,
    inputId: 'function-call' as PortId,
  });
  const validation = semantics.validateCandidate({
    base: inputProject,
    candidate: ambiguous,
    touchedScope: {
      ...touched(),
      nodeIds: ambiguous.graphs[activeGraphId]!.nodes.map((candidateNode) => candidateNode.id),
    },
  });
  assert.ok(validation.diagnostics.some((entry) => entry.ruleId === 'tool-delegate-mismatch'));
});

test('full-document Delegate Tool Call edits preserve auto-delegation invariants', () => {
  const delegate = node('delegateFunctionCall', 'delegate', {
    autoDelegate: true,
    fallBackToExternalCall: true,
    passthroughErrors: true,
  });
  const base = project([delegate]);
  const { semantics } = setup(base);
  const cases: ReadonlyArray<{
    name: string;
    mutate: (candidate: GraphBuilderAuthoringProject) => void;
    expected: RegExp;
  }> = [
    {
      name: 'manual delegation',
      mutate: (candidate) => {
        (
          candidate.graphs[activeGraphId]!.nodes[0]!.data as {
            autoDelegate: boolean;
          }
        ).autoDelegate = false;
      },
      expected: /must use Auto Delegate mode/u,
    },
    {
      name: 'passthrough without fallback',
      mutate: (candidate) => {
        Object.assign(candidate.graphs[activeGraphId]!.nodes[0]!.data as Record<string, unknown>, {
          fallBackToExternalCall: false,
          passthroughErrors: true,
        });
      },
      expected: /only when external-call fallback is enabled/u,
    },
    {
      name: 'malformed fallback flag',
      mutate: (candidate) => {
        (candidate.graphs[activeGraphId]!.nodes[0]!.data as Record<string, unknown>).fallBackToExternalCall = 'yes';
      },
      expected: /boolean external-call fallback setting/u,
    },
    {
      name: 'unsafe variant',
      mutate: (candidate) => {
        candidate.graphs[activeGraphId]!.nodes[0]!.variants = [
          {
            id: 'manual-variant',
            data: {
              autoDelegate: false,
              fallBackToExternalCall: true,
              passthroughErrors: true,
            },
          },
        ];
      },
      expected: /variant 1 settings must use Auto Delegate mode/u,
    },
  ];

  for (const testCase of cases) {
    const candidate = structuredClone(base);
    testCase.mutate(candidate);
    const validation = semantics.validateCandidate({
      base,
      candidate,
      touchedScope: {
        ...touched(),
        nodeIds: [delegate.id],
      },
    });

    assert.ok(
      validation.diagnostics.some(
        (entry) => entry.ruleId === 'protected-node-mutation' && testCase.expected.test(entry.message),
      ),
      testCase.name,
    );
  }

  const emptyBase = project();
  const { semantics: emptySemantics } = setup(emptyBase);
  const createdCandidate = structuredClone(emptyBase);
  const createdDelegate = node('delegateFunctionCall', 'created-delegate', {
    autoDelegate: false,
  });
  createdCandidate.graphs[activeGraphId]!.nodes.push(createdDelegate);
  const createdValidation = emptySemantics.validateCandidate({
    base: emptyBase,
    candidate: createdCandidate,
    touchedScope: {
      ...touched(),
      nodeIds: [createdDelegate.id],
    },
  });
  assert.ok(
    createdValidation.diagnostics.some(
      (entry) => entry.ruleId === 'protected-node-mutation' && /must use Auto Delegate mode/u.test(entry.message),
    ),
  );
});

test('Loop Until is authorable only with an existing non-recursive target and a positive bound', () => {
  const inputProject = project();
  const { catalog, semantics } = setup(inputProject);
  const loop = catalog.createNode({
    authoringChoiceId: 'registered:loopUntil',
    allocatedNodeId: 'loop' as NodeId,
    project: inputProject,
    settings: {
      targetGraph: childGraphId,
      conditionType: 'inputEqual',
      maxIterations: 12,
      inputToCheck: 'answer',
      targetValue: 'done',
    },
  });
  const candidate = structuredClone(inputProject);
  candidate.graphs[activeGraphId]!.nodes.push(loop);
  const ports = semantics.resolvePorts({
    graphId: activeGraphId,
    nodeId: loop.id,
    project: candidate,
  });

  assert.deepEqual(
    ports.inputs.map((port) => port.id),
    ['question'],
  );
  assert.deepEqual(
    ports.outputs.map((port) => port.id),
    ['answer', 'iteration', 'completed'],
  );
  assert.deepEqual(
    { ...catalog.projectNodeSafeSettings(loop, candidate) },
    {
      targetGraph: childGraphId,
      conditionType: 'inputEqual',
      maxIterations: 12,
      inputToCheck: 'answer',
      targetValue: 'done',
    },
  );
  assert.throws(
    () =>
      catalog.createNode({
        authoringChoiceId: 'registered:loopUntil',
        allocatedNodeId: 'unbounded' as NodeId,
        project: inputProject,
        settings: {
          targetGraph: childGraphId,
          conditionType: 'allOutputsSet',
          maxIterations: 0,
        },
      }),
    /positive safe integer/,
  );

  const recursive = structuredClone(inputProject);
  recursive.graphs[activeGraphId]!.nodes.push(
    catalog.createNode({
      authoringChoiceId: 'registered:loopUntil',
      allocatedNodeId: 'recursive' as NodeId,
      project: inputProject,
      settings: {
        targetGraph: activeGraphId,
        conditionType: 'allOutputsSet',
        maxIterations: 2,
      },
    }),
  );
  const validation = semantics.validateCandidate({
    base: inputProject,
    candidate: recursive,
    touchedScope: {
      ...touched(),
      nodeIds: ['recursive' as NodeId],
    },
  });
  assert.ok(validation.diagnostics.some((entry) => entry.ruleId === 'loop-target-graph'));

  const inheritedTarget = structuredClone(inputProject);
  const invalidTargetLoop = structuredClone(loop);
  invalidTargetLoop.id = 'inherited-target' as NodeId;
  (invalidTargetLoop.data as { targetGraph: string }).targetGraph = 'toString';
  inheritedTarget.graphs[activeGraphId]!.nodes.push(invalidTargetLoop);
  const inheritedTargetValidation = semantics.validateCandidate({
    base: inputProject,
    candidate: inheritedTarget,
    touchedScope: {
      ...touched(),
      nodeIds: [invalidTargetLoop.id],
    },
  });
  assert.ok(inheritedTargetValidation.diagnostics.some((entry) => entry.ruleId === 'loop-target-graph'));
});

test('full incident connections drive variadic ports and incompatible connection types fail closed', () => {
  const text = node('text', 'text', { text: 'Hello', normalizeLineEndings: true });
  const array = node('array', 'array', { flatten: true, flattenDeep: false });
  const booleanOutput = node('graphOutput', 'boolean-output', { id: 'flag', dataType: 'boolean' });
  const number = node('number', 'number', { value: 1 });
  const firstConnection = {
    outputNodeId: text.id,
    outputId: 'output' as PortId,
    inputNodeId: array.id,
    inputId: 'input1' as PortId,
  };
  const inputProject = project([text, array, booleanOutput, number], [firstConnection]);
  const { semantics } = setup(inputProject);

  const arrayPorts = semantics.resolvePorts({
    graphId: activeGraphId,
    nodeId: array.id,
    project: inputProject,
  });
  assert.deepEqual(
    arrayPorts.inputs.map((port) => port.id),
    ['input1', 'input2'],
  );

  const badConnection = {
    outputNodeId: number.id,
    outputId: 'value' as PortId,
    inputNodeId: booleanOutput.id,
    inputId: 'value' as PortId,
  };
  const candidate = structuredClone(inputProject);
  candidate.graphs[activeGraphId]!.connections.push(badConnection);
  const result = semantics.validateConnection({
    graphId: activeGraphId,
    connection: badConnection,
    project: candidate,
    touchedScope: touched(),
  });
  assert.match(result.diagnostics[0]!.message, /incompatible/);

  const inheritedNodeIdResult = semantics.validateConnection({
    graphId: activeGraphId,
    connection: {
      ...badConnection,
      outputNodeId: 'toString' as NodeId,
    },
    project: candidate,
    touchedScope: touched(),
  });
  assert.equal(inheritedNodeIdResult.completeness, 'complete');
  assert.equal(inheritedNodeIdResult.diagnostics[0]!.ruleId, 'connection-node-existence');
});

test('async branch topology is part of complete candidate validation', () => {
  const trigger = node('startBackgroundBranch', 'async', {});
  const output = node('graphOutput', 'output', { id: 'result', dataType: 'string' });
  const connection = {
    outputNodeId: trigger.id,
    outputId: 'output1' as PortId,
    inputNodeId: output.id,
    inputId: 'value' as PortId,
  };
  const base = project([trigger, output]);
  const candidate = project([trigger, output], [connection]);
  const { semantics } = setup(candidate);

  const result = semantics.validateCandidate({ base, candidate, touchedScope: touched() });
  assert.ok(result.diagnostics.some((entry) => entry.ruleId === 'async-branch-graphOutput'));
});

test('normalization preserves existing positions and places connected created nodes deterministically', () => {
  const existing = {
    ...node('text', 'existing', { text: 'Existing', normalizeLineEndings: true }),
    visualData: { x: 100, y: 200, width: 250 },
  };
  const created = node('text', 'created', { text: 'Created', normalizeLineEndings: true });
  const base = project([existing]);
  const candidate = project(
    [existing, created],
    [
      {
        outputNodeId: existing.id,
        outputId: 'output' as PortId,
        inputNodeId: created.id,
        inputId: 'input' as PortId,
      },
    ],
  );
  const { semantics } = setup(candidate);

  const first = semantics.normalizeCandidate({
    base,
    project: candidate,
    createdNodeIds: [created.id],
    touchedScope: { ...touched(), nodeIds: [created.id] },
  }).project;
  const second = semantics.normalizeCandidate({
    base,
    project: candidate,
    createdNodeIds: [created.id],
    touchedScope: { ...touched(), nodeIds: [created.id] },
  }).project;
  const firstExisting = first.graphs[activeGraphId]!.nodes.find((candidateNode) => candidateNode.id === existing.id)!;
  const firstCreated = first.graphs[activeGraphId]!.nodes.find((candidateNode) => candidateNode.id === created.id)!;

  assert.deepEqual(firstExisting.visualData, existing.visualData);
  assert.ok(firstCreated.visualData.x > existing.visualData.x + existing.visualData.width);
  assert.deepEqual(first, second);
});

test('normalization places disconnected created nodes relative to an all-negative existing canvas', () => {
  const existing = {
    ...node('text', 'existing-negative', { text: 'Existing', normalizeLineEndings: true }),
    visualData: { x: -1_000, y: -500, width: 250 },
  };
  const created = node('text', 'created-negative', { text: 'Created', normalizeLineEndings: true });
  const base = project([existing]);
  const candidate = project([existing, created]);
  const { semantics } = setup(candidate);

  const normalized = semantics.normalizeCandidate({
    base,
    project: candidate,
    createdNodeIds: [created.id],
    touchedScope: { ...touched(), nodeIds: [created.id] },
  }).project;
  const positioned = normalized.graphs[activeGraphId]!.nodes.find((candidateNode) => candidateNode.id === created.id)!;

  assert.ok(positioned.visualData.x > existing.visualData.x + existing.visualData.width);
  assert.ok(positioned.visualData.x < 0);
  assert.equal(positioned.visualData.y, existing.visualData.y);
});

test('normalization terminates and produces distinct finite positions for a newly created cycle', () => {
  const base = project();
  const created = [
    node('text', 'cycle-a', { text: 'A', normalizeLineEndings: true }),
    node('text', 'cycle-b', { text: 'B', normalizeLineEndings: true }),
    node('text', 'cycle-c', { text: 'C', normalizeLineEndings: true }),
  ];
  const candidate = project(created, [
    {
      outputNodeId: created[0]!.id,
      outputId: 'output' as PortId,
      inputNodeId: created[1]!.id,
      inputId: 'input' as PortId,
    },
    {
      outputNodeId: created[1]!.id,
      outputId: 'output' as PortId,
      inputNodeId: created[2]!.id,
      inputId: 'input' as PortId,
    },
    {
      outputNodeId: created[2]!.id,
      outputId: 'output' as PortId,
      inputNodeId: created[0]!.id,
      inputId: 'input' as PortId,
    },
  ]);
  const { semantics } = setup(candidate);

  const normalized = semantics.normalizeCandidate({
    base,
    project: candidate,
    createdNodeIds: created.map((createdNode) => createdNode.id),
    touchedScope: { ...touched(), nodeIds: created.map((createdNode) => createdNode.id) },
  }).project;
  const positions = normalized.graphs[activeGraphId]!.nodes.map((createdNode) => [
    createdNode.visualData.x,
    createdNode.visualData.y,
  ]);

  assert.ok(positions.flat().every(Number.isFinite));
  assert.equal(new Set(positions.map(([x, y]) => `${x}:${y}`)).size, created.length);
});

test('persisted boundaries stay immutable while additive and transient boundary authoring remain explicit', () => {
  const boundary = node('graphInput', 'boundary', { id: 'question', dataType: 'string' });
  const base = project([boundary]);
  const changed = structuredClone(base);
  (changed.graphs[activeGraphId]!.nodes[0]!.data as { id: string }).id = 'renamed';
  const { semantics } = setup(changed);

  const changedResult = semantics.validateCandidate({
    base,
    candidate: changed,
    touchedScope: touched(),
  });
  assert.ok(
    changedResult.diagnostics.some(
      (entry) => entry.ruleId === 'graph-boundary-identity' && entry.nodeId === boundary.id,
    ),
  );

  const nonEmptyBase = project([node('text', 'existing', { text: 'Existing' })]);
  const addedBoundary = node('graphOutput', 'added-boundary', { id: 'answer', dataType: 'string' });
  const nonEmptyCandidate = structuredClone(nonEmptyBase);
  nonEmptyCandidate.graphs[activeGraphId]!.nodes.push(addedBoundary);
  const { semantics: nonEmptySemantics } = setup(nonEmptyCandidate);
  const nonEmptyResult = nonEmptySemantics.validateCandidate({
    base: nonEmptyBase,
    candidate: nonEmptyCandidate,
    touchedScope: touched(),
  });
  assert.ok(nonEmptyResult.diagnostics.some((entry) => entry.diagnosticKey.includes('new-boundary')));

  const { semantics: additiveSemantics } = setup(nonEmptyCandidate, undefined, {
    additiveBoundaryGraphIds: [activeGraphId],
  });
  const additiveResult = additiveSemantics.validateCandidate({
    base: nonEmptyBase,
    candidate: nonEmptyCandidate,
    touchedScope: touched(),
  });
  assert.ok(
    !additiveResult.diagnostics.some((entry) => entry.diagnosticKey.includes('new-boundary')),
    'an explicitly additive graph may gain a boundary without weakening existing boundary identity',
  );

  const emptyBase = project();
  const transientCandidate = project([
    node('graphInput', 'transient-input', { id: 'question', dataType: 'string' }),
    node('graphOutput', 'transient-output', { id: 'answer', dataType: 'string' }),
  ]);
  const { semantics: transientSemantics } = setup(transientCandidate, undefined, {
    mutableBoundaryGraphIds: [activeGraphId],
  });
  const transientResult = transientSemantics.validateCandidate({
    base: emptyBase,
    candidate: transientCandidate,
    touchedScope: touched(),
  });
  assert.ok(!transientResult.diagnostics.some((entry) => entry.ruleId === 'graph-boundary-identity'));

  const laterDraft = structuredClone(transientCandidate);
  (laterDraft.graphs[activeGraphId]!.nodes[0]!.data as { id: string }).id = 'revised-question';
  laterDraft.graphs[activeGraphId]!.nodes.push(
    node('graphOutput', 'transient-output-2', { id: 'explanation', dataType: 'string' }),
  );
  const laterResult = transientSemantics.validateCandidate({
    base: transientCandidate,
    candidate: laterDraft,
    touchedScope: touched(),
  });
  assert.ok(
    !laterResult.diagnostics.some((entry) => entry.ruleId === 'graph-boundary-identity'),
    'boundary authoring on a transient empty canvas remains editable across patch batches',
  );
});

type OpaquePluginNode = ChartNode<'opaquePlugin', { apiKey: string; visible: string }>;

class OpaquePluginNodeImpl extends NodeImpl<OpaquePluginNode> {
  static create(): OpaquePluginNode {
    return {
      id: 'opaque-default' as NodeId,
      type: 'opaquePlugin',
      title: 'Opaque Plugin',
      visualData: { x: 0, y: 0 },
      data: { apiKey: 'secret-default', visible: 'not-classified' },
    };
  }

  static getUIData(): never {
    throw new Error('Graph Builder must not invoke getUIData');
  }

  getInputDefinitions(): NodeInputDefinition[] {
    return [{ id: 'input' as PortId, title: 'Input', dataType: 'string' }];
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    return [{ id: 'output' as PortId, title: 'Output', dataType: 'string' }];
  }

  async process(_inputs: Inputs, _context: InternalProcessContext): Promise<Outputs> {
    return {};
  }
}

let accessorPluginGetterCalls = 0;
type AccessorPluginNode = ChartNode<'accessorPlugin', Record<string, unknown>>;

class AccessorPluginNodeImpl extends NodeImpl<AccessorPluginNode> {
  static create(): AccessorPluginNode {
    const created = node('accessorPlugin', 'accessor-default') as AccessorPluginNode;
    Object.defineProperty(created.data, 'visible', {
      enumerable: true,
      get() {
        accessorPluginGetterCalls += 1;
        return 'must-not-run';
      },
    });
    return created;
  }

  static getUIData(): never {
    throw new Error('Graph Builder must not invoke getUIData');
  }

  getInputDefinitions(): NodeInputDefinition[] {
    return [];
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    return [];
  }

  async process(_inputs: Inputs, _context: InternalProcessContext): Promise<Outputs> {
    return {};
  }
}

test('catalog boundaries reject accessors without invoking plugin or adapter getters', () => {
  accessorPluginGetterCalls = 0;
  const registry = registerBuiltInNodes(new NodeRegistration()).register(
    nodeDefinition(AccessorPluginNodeImpl, 'Accessor Plugin'),
    { id: 'accessor-plugin' } as RivetPlugin,
  );
  const inputProject = project();
  const catalog = createGraphBuilderAuthoringCatalog({
    registry,
    project: inputProject,
    referencedProjects: {},
  });
  assert.equal(accessorPluginGetterCalls, 0);
  assert.equal(catalog.getEntry('registered:accessorPlugin'), undefined);

  let metadataGetterCalls = 0;
  const accessorAdapter = {};
  Object.defineProperty(accessorAdapter, 'description', {
    enumerable: true,
    get() {
      metadataGetterCalls += 1;
      return 'must-not-run';
    },
  });
  assert.throws(
    () =>
      createGraphBuilderAuthoringCatalog({
        registry: registerBuiltInNodes(new NodeRegistration()),
        project: inputProject,
        referencedProjects: {},
        safeSettingsAdapters: { text: accessorAdapter as GraphBuilderNodeAuthoringAdapter },
      }),
    /data property/,
  );
  assert.equal(metadataGetterCalls, 0);

  let resultGetterCalls = 0;
  const settingsAdapter: GraphBuilderNodeAuthoringAdapter = {
    settings: [{ key: 'text', valueKind: 'string', description: 'Text value.' }],
    applySettings: ({ node: currentNode }) => {
      const updated = structuredClone(currentNode);
      Object.defineProperty(updated.data, 'text', {
        enumerable: true,
        get() {
          resultGetterCalls += 1;
          return 'must-not-run';
        },
      });
      return updated;
    },
  };
  const settingsCatalog = createGraphBuilderAuthoringCatalog({
    registry: registerBuiltInNodes(new NodeRegistration()),
    project: inputProject,
    referencedProjects: {},
    safeSettingsAdapters: { text: settingsAdapter },
  });
  assert.throws(
    () =>
      settingsCatalog.applyNodeSettings({
        node: node('text', 'text-node', { text: 'old' }),
        project: inputProject,
        settings: { text: 'new' },
      }),
    /accessor/,
  );
  assert.equal(resultGetterCalls, 0);
});

test('catalog preflights referenced projects before cloning them', () => {
  let getterCalls = 0;
  const referenced = project() as Project;
  Object.defineProperty(referenced.metadata, 'title', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'must-not-run';
    },
  });

  assert.throws(
    () =>
      createGraphBuilderAuthoringCatalog({
        registry: registerBuiltInNodes(new NodeRegistration()),
        project: project(),
        referencedProjects: { [referenced.metadata.id]: referenced },
      }),
    /accessor/,
  );
  assert.equal(getterCalls, 0);
});

test('opaque plugins are create-only and neither defaults nor unknown fields enter projections', async () => {
  const registry = registerBuiltInNodes(new NodeRegistration()).register(
    nodeDefinition(OpaquePluginNodeImpl, 'Opaque Plugin'),
    { id: 'opaque-plugin' } as RivetPlugin,
  );
  const opaque = node('opaquePlugin', 'opaque', { apiKey: 'live-secret', visible: 'also-hidden' });
  const inputProject = project([opaque]);
  const { catalog, semantics } = setup(inputProject, registry);
  const entry = catalog.getEntry('registered:opaquePlugin')!;

  assert.deepEqual(entry.capabilities, {
    createWithDefaults: true,
    inspectSafeProjection: false,
    resolvePorts: false,
    configureSettings: false,
    editLinkedPrefabInstance: false,
  });
  assert.equal(entry.safeDefaults, undefined);

  const projection = buildGraphBuilderProjection({
    project: inputProject,
    activeGraphId,
    draftRevision: 0,
    catalog,
    diagnostics: [],
  });
  assert.equal(projection.nodes[0]!.safeSettings, undefined);
  assert.doesNotMatch(JSON.stringify(projection), /live-secret|also-hidden|secret-default/);

  const executor = createGraphBuilderReadExecutor({
    activeGraphId,
    projectDataContext: { manifest: [] },
    catalog,
    semantics,
    getDraft: () => inputProject,
    getDraftRevision: () => 0,
    getDiagnostics: () => [],
    getDraftDelta: () => undefined,
  });
  const configuredSpecification = await executor.execute(
    {
      type: 'get-node-specs',
      authoringChoiceIds: ['registered:opaquePlugin'],
      authoringSettings: { visible: 'attempted' },
    },
    {
      requestId: 'reject-opaque-configuration',
      requestIndex: 0,
      observedDraftRevision: 0,
      draft: inputProject,
      abortSignal: new AbortController().signal,
    },
  );

  assert.equal(configuredSpecification.status, 'ok');
  assert.deepEqual(
    configuredSpecification.status === 'ok'
      ? (configuredSpecification.payload as { specs: Array<Record<string, unknown>> }).specs[0]
      : undefined,
    {
      authoringChoiceId: 'registered:opaquePlugin',
      status: 'ok',
      family: 'registered',
      nodeType: 'opaquePlugin',
      displayName: 'Opaque Plugin',
      description: entry.description,
      aliases: [],
      capabilities: entry.capabilities,
      settings: [],
      configurationStatus: 'rejected',
      configurationReason:
        'The requested configuration was rejected because this authoring choice has no captured settings or port adapter.',
    },
  );
});

test('node-type search preserves non-Latin names and queries', async () => {
  const registry = new NodeRegistration().register(
    nodeDefinition(
      OpaquePluginNodeImpl,
      '\u0422\u0435\u043a\u0441\u0442\u043e\u0432\u044b\u0439 \u0443\u0437\u0435\u043b',
    ),
    { id: 'localized-plugin' } as RivetPlugin,
  );
  const inputProject = project();
  const { catalog, semantics } = setup(inputProject, registry);
  const executor = createGraphBuilderReadExecutor({
    activeGraphId,
    projectDataContext: { manifest: [] },
    catalog,
    semantics,
    getDraft: () => inputProject,
    getDraftRevision: () => 0,
    getDiagnostics: () => [],
    getDraftDelta: () => undefined,
  });

  const result = await executor.execute(
    {
      type: 'search-node-types',
      queries: ['\u0442\u0435\u043a\u0441\u0442\u043e\u0432\u044b\u0439'],
      limit: 3,
    },
    {
      requestId: 'localized-search',
      requestIndex: 0,
      observedDraftRevision: 0,
      draft: inputProject,
      abortSignal: new AbortController().signal,
    },
  );

  assert.equal(result.status, 'ok');
  assert.match(JSON.stringify(result), /registered:opaquePlugin/);
});

test('projection lookup is own-property-safe and truncation preserves Unicode pairs', () => {
  const longTitle = `${'a'.repeat(1_998)}😀tail`;
  const inputProject = project([node('text', 'long-title', { text: 'safe' }, longTitle)]);
  const { catalog } = setup(inputProject);
  const projection = buildGraphBuilderProjection({
    project: inputProject,
    activeGraphId,
    draftRevision: 0,
    catalog,
    diagnostics: [],
  });

  assert.doesNotMatch(projection.nodes[0]!.title, /[\uD800-\uDFFF]/u);
  assert.match(projection.nodes[0]!.title, /…$/);
  assert.throws(
    () =>
      buildGraphBuilderProjection({
        project: inputProject,
        activeGraphId: 'toString' as GraphId,
        draftRevision: 0,
        catalog,
        diagnostics: [],
      }),
    /missing active graph/,
  );
});

test('projections and specification reads share canonical registered authoring choice IDs', async () => {
  const inputProject = project([
    node('codeNew', 'code', { code: 'return {{bookContent}};' }),
    node('llmChatV2', 'chat'),
    node('text', 'text', { text: 'Hello {{name}}' }),
  ]);
  const { catalog, semantics } = setup(inputProject);
  const projection = buildGraphBuilderProjection({
    project: inputProject,
    activeGraphId,
    draftRevision: 0,
    catalog,
    diagnostics: [],
  });

  assert.deepEqual(
    projection.nodes.map(({ type, authoringChoiceId }) => ({ type, authoringChoiceId })),
    [
      { type: 'codeNew', authoringChoiceId: 'registered:codeNew' },
      { type: 'llmChatV2', authoringChoiceId: 'registered:llmChatV2' },
      { type: 'text', authoringChoiceId: 'registered:text' },
    ],
  );

  const executor = createGraphBuilderReadExecutor({
    activeGraphId,
    projectDataContext: { manifest: [] },
    catalog,
    semantics,
    getDraft: () => inputProject,
    getDraftRevision: () => 0,
    getDiagnostics: () => [],
    getDraftDelta: () => undefined,
  });
  const specifications = await executor.execute(
    {
      type: 'get-node-specs',
      authoringChoiceIds: ['codeNew', 'llmChatV2', 'text'],
    },
    {
      requestId: 'specify-raw-registered-types',
      requestIndex: 0,
      observedDraftRevision: 0,
      draft: inputProject,
      abortSignal: new AbortController().signal,
    },
  );

  assert.equal(specifications.status, 'ok');
  const specs =
    specifications.status === 'ok' ? (specifications.payload as { specs: Array<Record<string, unknown>> }).specs : [];
  assert.deepEqual(
    specs.map(({ authoringChoiceId, nodeType, status }) => ({ authoringChoiceId, nodeType, status })),
    [
      { authoringChoiceId: 'registered:codeNew', nodeType: 'codeNew', status: 'ok' },
      { authoringChoiceId: 'registered:llmChatV2', nodeType: 'llmChatV2', status: 'ok' },
      { authoringChoiceId: 'registered:text', nodeType: 'text', status: 'ok' },
    ],
  );

  const configuredCodeSpecification = await executor.execute(
    {
      type: 'get-node-specs',
      authoringChoiceIds: ['codeNew'],
      authoringSettings: { code: 'return {{chapters}};' },
    },
    {
      requestId: 'specify-raw-code-type',
      requestIndex: 1,
      observedDraftRevision: 0,
      draft: inputProject,
      abortSignal: new AbortController().signal,
    },
  );
  assert.equal(configuredCodeSpecification.status, 'ok');
  assert.deepEqual(
    configuredCodeSpecification.status === 'ok'
      ? (configuredCodeSpecification.payload as { specs: Array<Record<string, unknown>> }).specs.map(
          ({ authoringChoiceId, configurationStatus, ports }) => ({
            authoringChoiceId,
            configurationStatus,
            ports,
          }),
        )
      : [],
    [
      {
        authoringChoiceId: 'registered:codeNew',
        configurationStatus: 'resolved',
        ports: {
          inputs: [{ id: 'chapters', dataType: 'any' }],
          outputs: [{ id: 'output', dataType: 'any' }],
        },
      },
    ],
  );

  const inspected = await executor.execute(
    { type: 'inspect-draft', nodeIds: ['code'], fields: ['identity'] },
    {
      requestId: 'inspect-canonical-identity',
      requestIndex: 2,
      observedDraftRevision: 0,
      draft: inputProject,
      abortSignal: new AbortController().signal,
    },
  );
  assert.deepEqual(inspected.status === 'ok' ? inspected.payload : undefined, {
    nodes: [
      {
        nodeId: 'code',
        identity: {
          nodeId: 'code',
          type: 'codeNew',
          authoringChoiceId: 'registered:codeNew',
        },
      },
    ],
    missingNodeIds: [],
  });

  const unknown = await executor.execute(
    { type: 'get-node-specs', authoringChoiceIds: ['not-a-node-type'] },
    {
      requestId: 'specify-unknown-node-type',
      requestIndex: 3,
      observedDraftRevision: 0,
      draft: inputProject,
      abortSignal: new AbortController().signal,
    },
  );
  assert.deepEqual(unknown.status === 'ok' ? unknown.payload : undefined, {
    specs: [
      {
        authoringChoiceId: 'not-a-node-type',
        status: 'unsupported',
        reason: 'Unknown authoring choice.',
      },
    ],
  });
});

test('the project-aware catalog includes referenced graph aliases and preserves linked-prefab inspection', async () => {
  const inputProject = project();
  const { catalog, semantics } = setup(inputProject);
  const alias = catalog
    .listEntries()
    .find((entry) => entry.family === 'referenced-graph-alias' && entry.displayName === 'Remote Graph')!;
  const prefab = catalog.listEntries().find((entry) => entry.family === 'node-prefab')!;

  assert.ok(alias.authoringChoiceId);
  assert.equal(prefab.nodePrefabId, 'linkedText');
  const linked = catalog.createNode({
    authoringChoiceId: prefab.authoringChoiceId,
    allocatedNodeId: 'linked-instance' as NodeId,
    project: inputProject,
  });
  const referencedAlias = catalog.createNode({
    authoringChoiceId: alias.authoringChoiceId,
    allocatedNodeId: 'referenced-alias' as NodeId,
    project: inputProject,
  });
  assert.equal(linked.type, NODE_PREFAB_INSTANCE_TYPE);
  assert.equal(catalog.getNodeAuthoringChoiceId(linked), prefab.authoringChoiceId);
  assert.equal(catalog.getNodeAuthoringChoiceId(referencedAlias), alias.authoringChoiceId);

  const candidate = structuredClone(inputProject);
  candidate.graphs[activeGraphId]!.nodes.push(linked, referencedAlias);
  const projection = buildGraphBuilderProjection({
    project: candidate,
    activeGraphId,
    draftRevision: 0,
    catalog,
    diagnostics: [],
  });
  assert.deepEqual(
    projection.nodes.map(({ nodeId, authoringChoiceId }) => ({ nodeId, authoringChoiceId })),
    [
      { nodeId: 'linked-instance', authoringChoiceId: prefab.authoringChoiceId },
      { nodeId: 'referenced-alias', authoringChoiceId: alias.authoringChoiceId },
    ],
  );
  const ports = semantics.resolvePorts({
    graphId: activeGraphId,
    nodeId: linked.id,
    project: candidate,
  });
  assert.deepEqual(
    ports.inputs.map((port) => port.id),
    ['name'],
  );
  assert.throws(
    () =>
      catalog.applyNodeSettings({
        node: linked,
        project: candidate,
        settings: { text: 'changed' },
      }),
    /read-only/,
  );

  const executor = createGraphBuilderReadExecutor({
    activeGraphId,
    projectDataContext: { manifest: [] },
    catalog,
    semantics,
    getDraft: () => candidate,
    getDraftRevision: () => 0,
    getDiagnostics: () => [],
    getDraftDelta: () => undefined,
  });
  const inspected = await executor.execute(
    { type: 'inspect-draft', nodeIds: ['linked-instance'], fields: ['settings'] },
    {
      requestId: 'inspect-linked-prefab',
      requestIndex: 0,
      observedDraftRevision: 0,
      draft: candidate,
      abortSignal: new AbortController().signal,
    },
  );
  assert.equal(inspected.status, 'ok');
  assert.deepEqual(inspected.status === 'ok' ? inspected.payload : undefined, {
    nodes: [
      {
        nodeId: 'linked-instance',
        settingsProjectionStatus: 'available',
        safeSettings: {
          prefabId: 'linkedText',
          sourceType: 'text',
          sourceSettings: {
            text: 'Hello {{name}}',
            normalizeLineEndings: true,
          },
        },
      },
    ],
    missingNodeIds: [],
  });
});

test('legacy Code exposes only source and named ports through its safe authoring adapter', async () => {
  const source = 'return { answer: { type: inputs.question.type, value: inputs.question.value } };';
  const legacyCode = node('code', 'legacy-code', {
    code: source,
    inputNames: 'question',
    outputNames: ['answer'],
    allowFetch: true,
    allowRequire: true,
    allowRivet: true,
    allowProcess: true,
    allowConsole: true,
  });
  const inputProject = project([legacyCode]);
  const { catalog, semantics } = setup(inputProject);
  const entry = catalog.getEntry('registered:code')!;

  assert.equal(entry.capabilities.inspectSafeProjection, true);
  assert.equal(entry.capabilities.configureSettings, true);
  assert.deepEqual(
    entry.settings.map(({ key, projection, valueKind }) => ({ key, projection, valueKind })),
    [
      { key: 'code', projection: 'on-demand', valueKind: 'string' },
      { key: 'inputNames', projection: undefined, valueKind: 'string-array' },
      { key: 'outputNames', projection: undefined, valueKind: 'string-array' },
    ],
  );
  assert.equal(typeof entry.safeDefaults?.code, 'string');
  assert.deepEqual(entry.safeDefaults?.inputNames, ['input1']);
  assert.deepEqual(entry.safeDefaults?.outputNames, ['output1']);
  assert.doesNotMatch(
    JSON.stringify(entry.safeDefaults),
    /allowFetch|allowRequire|allowRivet|allowProcess|allowConsole/,
  );

  const projection = buildGraphBuilderProjection({
    project: inputProject,
    activeGraphId,
    draftRevision: 0,
    catalog,
    diagnostics: [],
  });
  assert.deepEqual(projection.nodes[0]!.safeSettings, {
    inputNames: ['question'],
    outputNames: ['answer'],
  });
  assert.doesNotMatch(JSON.stringify(projection), /allowFetch|allowRequire|allowRivet|allowProcess|allowConsole/);

  const executor = createGraphBuilderReadExecutor({
    activeGraphId,
    projectDataContext: { manifest: [] },
    catalog,
    semantics,
    getDraft: () => inputProject,
    getDraftRevision: () => 0,
    getDiagnostics: () => [],
    getDraftDelta: () => undefined,
  });
  const inspected = await executor.execute(
    { type: 'inspect-draft', nodeIds: ['legacy-code'], fields: ['settings', 'ports'] },
    {
      requestId: 'inspect-legacy-code',
      requestIndex: 0,
      observedDraftRevision: 0,
      draft: inputProject,
      abortSignal: new AbortController().signal,
    },
  );
  assert.equal(inspected.status, 'ok');
  assert.deepEqual(inspected.status === 'ok' ? inspected.payload : undefined, {
    nodes: [
      {
        nodeId: 'legacy-code',
        settingsProjectionStatus: 'available',
        safeSettings: {
          code: source,
          inputNames: ['question'],
          outputNames: ['answer'],
        },
        ports: {
          inputs: [{ id: 'question', dataType: 'string' }],
          outputs: [{ id: 'answer', dataType: 'any' }],
        },
      },
    ],
    missingNodeIds: [],
  });
  assert.doesNotMatch(JSON.stringify(inspected), /allowFetch|allowRequire|allowRivet|allowProcess|allowConsole/);

  const configuredSpecification = await executor.execute(
    {
      type: 'get-node-specs',
      authoringChoiceIds: ['registered:code'],
      authoringSettings: {
        code: 'return { result: { type: inputs.value.type, value: inputs.value.value } };',
        inputNames: ['value'],
        outputNames: ['result'],
      },
    },
    {
      requestId: 'configure-legacy-code',
      requestIndex: 1,
      observedDraftRevision: 0,
      draft: inputProject,
      abortSignal: new AbortController().signal,
    },
  );
  assert.equal(configuredSpecification.status, 'ok');
  const configuredSpec =
    configuredSpecification.status === 'ok'
      ? (configuredSpecification.payload as { specs: Array<Record<string, unknown>> }).specs[0]
      : undefined;
  assert.equal(configuredSpec?.configurationStatus, 'resolved');
  assert.deepEqual(configuredSpec?.ports, {
    inputs: [{ id: 'value', dataType: 'string' }],
    outputs: [{ id: 'result', dataType: 'any' }],
  });

  const updated = catalog.applyNodeSettings({
    node: legacyCode,
    project: inputProject,
    settings: {
      code: 'return { result: inputs.value };',
      inputNames: ['value'],
      outputNames: ['result'],
    },
  });
  assert.deepEqual(
    {
      allowFetch: (updated.data as Record<string, unknown>).allowFetch,
      allowRequire: (updated.data as Record<string, unknown>).allowRequire,
      allowRivet: (updated.data as Record<string, unknown>).allowRivet,
      allowProcess: (updated.data as Record<string, unknown>).allowProcess,
      allowConsole: (updated.data as Record<string, unknown>).allowConsole,
    },
    {
      allowFetch: true,
      allowRequire: true,
      allowRivet: true,
      allowProcess: true,
      allowConsole: true,
    },
  );
});

test('Code source is authorable on demand without exposing retired runtime fields in compact projections', async () => {
  const source = 'const value = {{bookContent}};\nreturn value;';
  const code = node('codeNew', 'code', { code: source });
  const inputProject = project([code]);
  const { catalog, semantics } = setup(inputProject);
  const entry = catalog.getEntry('registered:codeNew')!;

  assert.equal(entry.capabilities.inspectSafeProjection, true);
  assert.equal(entry.capabilities.configureSettings, true);
  assert.deepEqual(
    entry.settings.map((descriptor) => ({
      key: descriptor.key,
      projection: descriptor.projection,
      valueKind: descriptor.valueKind,
    })),
    [{ key: 'code', projection: 'on-demand', valueKind: 'string' }],
  );

  const compactProjection = buildGraphBuilderProjection({
    project: inputProject,
    activeGraphId,
    draftRevision: 0,
    catalog,
    diagnostics: [],
  });
  assert.deepEqual({ ...compactProjection.nodes[0]!.safeSettings }, {});
  assert.doesNotMatch(JSON.stringify(compactProjection), /bookContent|allowFetch/);

  const executor = createGraphBuilderReadExecutor({
    activeGraphId,
    projectDataContext: { manifest: [] },
    catalog,
    semantics,
    getDraft: () => inputProject,
    getDraftRevision: () => 0,
    getDiagnostics: () => [],
    getDraftDelta: () => undefined,
  });
  const inspected = await executor.execute(
    {
      type: 'inspect-draft',
      nodeIds: ['code'],
      fields: ['settings', 'ports'],
    },
    {
      requestId: 'inspect-code',
      requestIndex: 0,
      observedDraftRevision: 0,
      draft: inputProject,
      abortSignal: new AbortController().signal,
    },
  );

  assert.equal(inspected.status, 'ok');
  assert.deepEqual(inspected.status === 'ok' ? inspected.payload : undefined, {
    nodes: [
      {
        nodeId: 'code',
        settingsProjectionStatus: 'available',
        safeSettings: { code: source },
        ports: {
          inputs: [{ id: 'bookContent', dataType: 'any' }],
          outputs: [{ id: 'output', dataType: 'any' }],
        },
      },
    ],
    missingNodeIds: [],
  });
  assert.doesNotMatch(JSON.stringify(inspected), /allowFetch/);

  const specification = await executor.execute(
    {
      type: 'get-node-specs',
      authoringChoiceIds: ['registered:codeNew'],
      authoringSettings: { code: 'return {{chapters}};' },
    },
    {
      requestId: 'specify-code',
      requestIndex: 1,
      observedDraftRevision: 0,
      draft: inputProject,
      abortSignal: new AbortController().signal,
    },
  );
  assert.equal(specification.status, 'ok');
  assert.deepEqual(specification.status === 'ok' ? specification.payload : undefined, {
    specs: [
      {
        authoringChoiceId: 'registered:codeNew',
        status: 'ok',
        family: 'registered',
        nodeType: 'codeNew',
        displayName: 'Code',
        description: entry.description,
        aliases: [],
        capabilities: entry.capabilities,
        settings: [
          {
            key: 'code',
            valueKind: 'string',
            description: 'JavaScript source. Use {{name}} for dynamic inputs and return one value.',
            projection: 'on-demand',
          },
        ],
        safeDefaults: entry.safeDefaults,
        configurationStatus: 'resolved',
        ports: {
          inputs: [{ id: 'chapters', dataType: 'any' }],
          outputs: [{ id: 'output', dataType: 'any' }],
        },
      },
    ],
  });

  const rejectedSpecification = await executor.execute(
    {
      type: 'get-node-specs',
      authoringChoiceIds: ['registered:codeNew'],
      authoringSettings: { unsupportedSetting: true },
    },
    {
      requestId: 'reject-unsupported-code-spec',
      requestIndex: 2,
      observedDraftRevision: 0,
      draft: inputProject,
      abortSignal: new AbortController().signal,
    },
  );
  assert.equal(rejectedSpecification.status, 'ok');
  assert.deepEqual(
    rejectedSpecification.status === 'ok'
      ? (rejectedSpecification.payload as { specs: Array<Record<string, unknown>> }).specs[0]
      : undefined,
    {
      authoringChoiceId: 'registered:codeNew',
      status: 'ok',
      family: 'registered',
      nodeType: 'codeNew',
      displayName: 'Code',
      description: entry.description,
      aliases: [],
      capabilities: entry.capabilities,
      settings: [
        {
          key: 'code',
          valueKind: 'string',
          description: 'JavaScript source. Use {{name}} for dynamic inputs and return one value.',
          projection: 'on-demand',
        },
      ],
      safeDefaults: entry.safeDefaults,
      configurationStatus: 'rejected',
      configurationReason: 'The requested configuration was rejected by the captured authoring adapter.',
    },
  );
  assert.equal(JSON.stringify(rejectedSpecification).includes('"configured"'), false);

  const updated = catalog.applyNodeSettings({
    node: code,
    project: inputProject,
    settings: { code: 'return {{chapters}};' },
  });
  const candidate = project([updated]);
  assert.deepEqual(
    semantics
      .resolvePorts({
        graphId: activeGraphId,
        nodeId: updated.id,
        project: candidate,
      })
      .inputs.map((port) => port.id),
    ['chapters'],
  );
});

test('safe-settings inspection reports oversized and invalid fields without mislabeling the adapter', async () => {
  const oversizedCode = node('codeNew', 'oversized-code', {
    code: 'x'.repeat(GRAPH_BUILDER_LIMITS.maxStringLength + 1),
  });
  const invalidText = node('text', 'invalid-text', {
    text: 42,
    normalizeLineEndings: true,
  });
  const absentCode = node('codeNew', 'absent-code', {});
  const inputProject = project([oversizedCode, invalidText, absentCode]);
  const { catalog, semantics } = setup(inputProject);
  const executor = createGraphBuilderReadExecutor({
    activeGraphId,
    projectDataContext: { manifest: [] },
    catalog,
    semantics,
    getDraft: () => inputProject,
    getDraftRevision: () => 0,
    getDiagnostics: () => [],
    getDraftDelta: () => undefined,
  });

  const inspected = await executor.execute(
    {
      type: 'inspect-draft',
      nodeIds: ['oversized-code', 'invalid-text', 'absent-code'],
      fields: ['settings'],
    },
    {
      requestId: 'inspect-omissions',
      requestIndex: 0,
      observedDraftRevision: 0,
      draft: inputProject,
      abortSignal: new AbortController().signal,
    },
  );

  assert.equal(inspected.status, 'ok');
  assert.deepEqual(inspected.status === 'ok' ? inspected.payload : undefined, {
    nodes: [
      {
        nodeId: 'oversized-code',
        settingsProjectionStatus: 'partial',
        safeSettings: {},
        omittedSettings: [{ key: 'code', reason: 'oversized' }],
      },
      {
        nodeId: 'invalid-text',
        settingsProjectionStatus: 'partial',
        safeSettings: { normalizeLineEndings: true },
        omittedSettings: [{ key: 'text', reason: 'invalid' }],
      },
      {
        nodeId: 'absent-code',
        settingsProjectionStatus: 'available',
        safeSettings: {},
      },
    ],
    missingNodeIds: [],
  });
});

test('transactional Code authoring persists source without creating retired runtime fields', () => {
  const inputProject = project();
  const { semantics } = setup(inputProject);
  const allocatedIds = ['generated-code'] as NodeId[];
  const kernel = new GraphBuilderTransactionKernel({
    project: inputProject,
    activeGraphId,
    authorization: {
      allowedGraphIds: [activeGraphId],
      allowedOperations: ['createNode', 'updateNodeSettings'],
      allowSemanticCrossGraphPropagation: false,
      sensitiveFieldAccess: 'none',
    },
    semantics,
    idGenerator: () => allocatedIds.shift()!,
  });

  const created = kernel.applyPatch({
    protocolVersion: GRAPH_BUILDER_PROTOCOL_VERSION,
    patchId: 'create-code',
    expectedDraftRevision: 0,
    operations: [
      {
        op: 'createNode',
        clientId: 'code',
        authoringChoiceId: 'registered:codeNew',
        settings: { code: 'return {{bookContent}};' },
      },
    ],
  });
  assert.equal(created.disposition, 'applied');
  assert.equal(kernel.getDraftRevision(), 1);
  const createdNode = kernel
    .getDraft()
    .graphs[activeGraphId]!.nodes.find((candidate) => candidate.id === 'generated-code')!;
  assert.equal((createdNode.data as { code?: string }).code, 'return {{bookContent}};');
  assert.equal(Object.hasOwn(createdNode.data as object, 'allowFetch'), false);
});

test('Graph Builder creates Expression nodes without retired runtime fields', () => {
  const inputProject = project();
  const { catalog } = setup(inputProject);

  const created = catalog.createNode({
    authoringChoiceId: 'registered:expression',
    allocatedNodeId: 'generated-expression' as NodeId,
    project: inputProject,
    settings: { expression: '{{value}} + 1' },
  });

  assert.equal((created.data as { expression?: string }).expression, '{{value}} + 1');
  assert.equal(Object.hasOwn(created.data as object, 'allowFetch'), false);
});

test('full-document Code edits can change source regardless of retired permission fields', () => {
  const privilegedCode = node('codeNew', 'privileged-code', { code: 'return 1;', allowFetch: true });
  const base = project([privilegedCode]);
  const { semantics } = setup(base);
  const touchedScope = {
    graphIds: [activeGraphId],
    nodeIds: [privilegedCode.id],
    connectionKeys: [],
    operationIndices: [],
  };

  const changedSource = structuredClone(base);
  (
    changedSource.graphs[activeGraphId]!.nodes[0]!.data as {
      code: string;
    }
  ).code = 'return 2;';
  const changedSourceValidation = semantics.validateCandidate({
    base,
    candidate: changedSource,
    touchedScope,
  });
  assert.equal(
    changedSourceValidation.diagnostics.some((entry) => entry.ruleId === 'protected-node-mutation'),
    false,
  );
});

test('bounded reads preserve order/revision and resource selectors withhold commands, env, and store config', async () => {
  const text = node('text', 'text', {
    text: 'Hello',
    normalizeLineEndings: true,
    apiKey: 'must-not-leak',
  });
  const inputProject = project([text]);
  const { catalog, semantics } = setup(inputProject);
  const executor = createGraphBuilderReadExecutor({
    activeGraphId,
    projectDataContext: {
      manifest: [{ id: 'dataset', digest: 'sha256:test', metadata: { title: 'Dataset', apiKey: 'hidden' } }],
    },
    catalog,
    semantics,
    getDraft: () => inputProject,
    getDraftRevision: () => 7,
    getDiagnostics: () => [],
    getDraftDelta: () => undefined,
  });
  const compactProjection = buildGraphBuilderProjection({
    project: inputProject,
    activeGraphId,
    draftRevision: 7,
    catalog,
    diagnostics: [],
  });
  assert.doesNotMatch(JSON.stringify(compactProjection), /Hello|must-not-leak/);

  const results = await executor.executeBatch(
    [
      { type: 'search-node-types', queries: ['text'], limit: 3 },
      {
        type: 'list-project-resources',
        kinds: ['data', 'knowledge-store', 'mcp-server'],
        limit: 20,
      },
      {
        type: 'inspect-draft',
        nodeIds: ['text'],
        fields: ['settings'],
      },
    ],
    { createRequestId: (index) => `request-${index}` },
  );

  assert.deepEqual(
    results.map((result) => [result.requestId, result.requestIndex, result.observedDraftRevision]),
    [
      ['request-0', 0, 7],
      ['request-1', 1, 7],
      ['request-2', 2, 7],
    ],
  );
  assert.doesNotMatch(JSON.stringify(results), /must-not-leak|hidden|secret-command|PASSWORD/);
  assert.match(JSON.stringify(results[2]), /Hello/);
  assert.match(JSON.stringify(results[2]), /"nodeId":"text"/);
  assert.match(JSON.stringify(results[2]), /"settingsProjectionStatus":"available"/);
});

test('single reads use the controller-captured draft/revision and honor cancellation', async () => {
  const inputProject = project();
  const { catalog, semantics } = setup(inputProject);
  let revision = 3;
  const executor = createGraphBuilderReadExecutor({
    activeGraphId,
    projectDataContext: { manifest: [] },
    catalog,
    semantics,
    getDraft: () => inputProject,
    getDraftRevision: () => revision,
    getDiagnostics: () => [],
    getDraftDelta: () => undefined,
  });
  const signal = new AbortController().signal;

  revision = 4;
  const stale = await executor.execute(
    { type: 'search-node-types', queries: ['text'], limit: 1 },
    {
      requestId: 'stale',
      requestIndex: 0,
      observedDraftRevision: 3,
      draft: inputProject,
      abortSignal: signal,
    },
  );
  assert.equal(stale.status, 'failed');
  assert.equal(stale.status === 'failed' ? stale.error.code : undefined, 'stale-read-context');

  const abortController = new AbortController();
  abortController.abort('test');
  await assert.rejects(
    executor.execute(
      { type: 'search-node-types', queries: ['text'], limit: 1 },
      {
        requestId: 'canceled',
        requestIndex: 0,
        observedDraftRevision: 4,
        draft: inputProject,
        abortSignal: abortController.signal,
      },
    ),
    /canceled/,
  );
});

test('secret-like setting descriptors are rejected even for an explicit plugin adapter', () => {
  const registry = registerBuiltInNodes(new NodeRegistration()).register(
    nodeDefinition(OpaquePluginNodeImpl, 'Opaque Plugin'),
    { id: 'opaque-plugin' } as RivetPlugin,
  );

  assert.throws(
    () =>
      createGraphBuilderAuthoringCatalog({
        registry,
        project: project(),
        referencedProjects: {},
        safeSettingsAdapters: {
          opaquePlugin: {
            settings: [
              {
                key: 'apiKey',
                valueKind: 'string',
                description: 'Unsafe',
              },
            ],
          },
        },
      }),
    /Secret-like/,
  );
});

test('only own safe-adapter entries can grant plugin authoring authority', () => {
  const registry = registerBuiltInNodes(new NodeRegistration()).register(
    nodeDefinition(OpaquePluginNodeImpl, 'Opaque Plugin'),
    { id: 'opaque-plugin' } as RivetPlugin,
  );
  const inheritedAdapters = Object.create({
    opaquePlugin: {
      settings: [
        {
          key: 'visible',
          valueKind: 'string',
          description: 'A prototype-inherited adapter must not be trusted.',
        },
      ],
    },
  }) as Record<string, never>;

  const catalog = createGraphBuilderAuthoringCatalog({
    registry,
    project: project(),
    referencedProjects: {},
    safeSettingsAdapters: inheritedAdapters,
  });
  const entry = catalog.getEntry('registered:opaquePlugin')!;

  assert.deepEqual(entry.settings, []);
  assert.equal(entry.capabilities.inspectSafeProjection, false);
  assert.equal(entry.capabilities.resolvePorts, false);
  assert.equal(entry.capabilities.configureSettings, false);

  const inheritedContractCatalog = createGraphBuilderAuthoringCatalog({
    registry,
    project: project(),
    referencedProjects: {},
    safeSettingsAdapters: {
      opaquePlugin: Object.create({
        settings: [
          {
            key: 'visible',
            valueKind: 'string',
            description: 'Inherited adapter fields must not be trusted.',
          },
        ],
      }),
    },
  });
  const inheritedContractEntry = inheritedContractCatalog.getEntry('registered:opaquePlugin')!;
  assert.deepEqual(inheritedContractEntry.settings, []);
  assert.equal(inheritedContractEntry.capabilities.inspectSafeProjection, false);
  assert.equal(inheritedContractEntry.capabilities.resolvePorts, true);
  assert.equal(inheritedContractEntry.capabilities.configureSettings, false);
});

test('catalog capture owns immutable copies of external descriptor paths and enum values', () => {
  const registry = registerBuiltInNodes(new NodeRegistration()).register(
    nodeDefinition(OpaquePluginNodeImpl, 'Opaque Plugin'),
    { id: 'opaque-plugin' } as RivetPlugin,
  );
  const dataPath = ['visible'];
  const allowedValues = ['first'];
  const aliases = ['visible mode'];
  const catalog = createGraphBuilderAuthoringCatalog({
    registry,
    project: project(),
    referencedProjects: {},
    safeSettingsAdapters: {
      opaquePlugin: {
        aliases,
        settings: [
          {
            key: 'mode',
            dataPath,
            valueKind: 'string-enum',
            description: 'A safe visible mode.',
            allowedValues,
          },
        ],
      },
    },
  });
  const fingerprint = catalog.fingerprint;

  dataPath[0] = 'apiKey';
  allowedValues.push('mutated');
  aliases.push('mutated alias');

  const entry = catalog.getEntry('registered:opaquePlugin')!;
  const descriptor = entry.settings[0]!;
  assert.deepEqual(entry.aliases, ['visible mode']);
  assert.equal(Object.isFrozen(entry.aliases), true);
  assert.deepEqual(descriptor.dataPath, ['visible']);
  assert.deepEqual(descriptor.allowedValues, ['first']);
  assert.equal(Object.isFrozen(descriptor.dataPath), true);
  assert.equal(Object.isFrozen(descriptor.allowedValues), true);
  assert.equal(catalog.fingerprint, fingerprint);

  const created = catalog.createNode({
    authoringChoiceId: 'registered:opaquePlugin',
    allocatedNodeId: 'opaque-created' as NodeId,
    project: project(),
    settings: { mode: 'first' },
  }) as OpaquePluginNode;
  assert.equal(created.data.visible, 'first');
  assert.equal(created.data.apiKey, 'secret-default');
  assert.throws(
    () =>
      catalog.applyNodeSettings({
        node: created,
        project: project(),
        settings: { mode: 'mutated' },
      }),
    /must be one of/,
  );
});

test('catalog capture rejects malformed runtime adapter contracts before they become authoring authority', () => {
  const registry = registerBuiltInNodes(new NodeRegistration()).register(
    nodeDefinition(OpaquePluginNodeImpl, 'Opaque Plugin'),
    { id: 'opaque-plugin' } as RivetPlugin,
  );
  const createWithAdapter = (adapter: unknown) =>
    createGraphBuilderAuthoringCatalog({
      registry,
      project: project(),
      referencedProjects: {},
      safeSettingsAdapters: { opaquePlugin: adapter } as never,
    });

  assert.throws(() => createWithAdapter({ aliases: ['valid', 42] }), /adapter contract is malformed/);
  assert.throws(
    () =>
      createWithAdapter({
        settings: [
          {
            key: 'mode',
            valueKind: 'string-enum',
            description: 'Mode',
            allowedValues: ['first', 'first'],
          },
        ],
      }),
    /invalid or duplicate enum values/,
  );
  assert.throws(
    () =>
      createWithAdapter({
        settings: [
          {
            key: 'mode',
            valueKind: 'unknown',
            description: 'Mode',
          },
        ],
      }),
    /setting descriptor is malformed/,
  );
  assert.throws(
    () =>
      createWithAdapter({
        settings: [
          Object.create({
            key: 'mode',
            valueKind: 'string',
            description: 'Inherited required descriptor fields are not a contract.',
          }),
        ],
      }),
    /setting descriptor is malformed/,
  );
});

test('captured authoring preferences control editor-compatible node defaults and catalog identity', () => {
  const registry = registerBuiltInNodes(new NodeRegistration());
  const inputProject = project();
  const withoutColors = createGraphBuilderAuthoringCatalog({
    registry,
    project: inputProject,
    referencedProjects: {},
    authoringPreferences: { applyDefaultNodeColors: false },
  });
  const withColors = createGraphBuilderAuthoringCatalog({
    registry,
    project: inputProject,
    referencedProjects: {},
    authoringPreferences: { applyDefaultNodeColors: true },
  });

  const noColorNode = withoutColors.createNode({
    authoringChoiceId: 'registered:graphInput',
    allocatedNodeId: 'no-color' as NodeId,
    project: inputProject,
  });
  const coloredNode = withColors.createNode({
    authoringChoiceId: 'registered:graphInput',
    allocatedNodeId: 'color' as NodeId,
    project: inputProject,
  });

  assert.equal(noColorNode.visualData.color, undefined);
  assert.ok(coloredNode.visualData.color);
  assert.notEqual(withoutColors.fingerprint, withColors.fingerprint);
});

test('every built-in catalog choice has bounded runtime help without source or full-document retrieval', () => {
  const { catalog } = setup();
  const registeredEntries = catalog.listEntries().filter((entry) => entry.family === 'registered');

  assert.ok(registeredEntries.length > 0);
  assert.ok(registeredEntries.every((entry) => entry.description.trim().length > 0));
  assert.ok(registeredEntries.every((entry) => entry.description.length <= 900));
  assert.match(catalog.getEntry('registered:httpCall')!.description, /HTTP/i);
  assert.doesNotMatch(
    JSON.stringify(registeredEntries.map((entry) => entry.description)),
    /packages[\\/]core[\\/]src|node-reference[\\/]|getEditors|getUIData/,
  );
});
