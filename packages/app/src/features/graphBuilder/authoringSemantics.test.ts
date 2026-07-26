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
import type { GraphBuilderAuthoringProject, GraphBuilderTouchedScope } from '../../domain/graphBuilder/index.js';
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
  options: { mutableBoundaryGraphIds?: readonly GraphId[] } = {},
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

  assert.ok(validation.diagnostics.some((entry) => entry.ruleId === 'active-graph-only'));
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

test('existing graph boundary identity is immutable and new boundaries require a transient empty base', () => {
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

test('opaque plugins are create-only and neither defaults nor unknown fields enter projections', () => {
  const registry = registerBuiltInNodes(new NodeRegistration()).register(
    nodeDefinition(OpaquePluginNodeImpl, 'Opaque Plugin'),
    { id: 'opaque-plugin' } as RivetPlugin,
  );
  const opaque = node('opaquePlugin', 'opaque', { apiKey: 'live-secret', visible: 'also-hidden' });
  const inputProject = project([opaque]);
  const { catalog } = setup(inputProject, registry);
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

test('the project-aware catalog includes referenced graph aliases and linked prefabs', () => {
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
  assert.equal(linked.type, NODE_PREFAB_INSTANCE_TYPE);

  const candidate = structuredClone(inputProject);
  candidate.graphs[activeGraphId]!.nodes.push(linked);
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
