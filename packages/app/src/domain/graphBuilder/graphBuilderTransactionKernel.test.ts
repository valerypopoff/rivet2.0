import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type ChartNode,
  type GraphId,
  type NodeConnection,
  type NodeId,
  type PortId,
  type ProjectId,
} from '@valerypopoff/rivet2-core';
import { cloneDeep } from 'lodash-es';
import {
  type GraphBuilderAuthoringProject,
  type GraphBuilderAuthoringSemantics,
  type GraphBuilderResolvedNodePorts,
  type GraphBuilderTouchedScope,
  GRAPH_BUILDER_PROTOCOL_VERSION,
  GraphBuilderProtocolError,
  GraphBuilderTransactionKernel,
  parseApplyPatchResult,
  type GraphPatch,
} from './index.js';

const graphId = 'graph' as GraphId;

function makeNode(
  id: string,
  options: {
    title?: string;
    inputPort?: string;
    outputPort?: string;
    data?: Record<string, unknown>;
  } = {},
): ChartNode {
  return {
    id: id as NodeId,
    type: 'test',
    title: options.title ?? id,
    visualData: { x: 10, y: 20 },
    data: {
      inputPort: options.inputPort ?? 'input',
      outputPort: options.outputPort ?? 'output',
      ...(options.data ?? {}),
    },
  };
}

function makeConnection(outputNodeId: string, inputNodeId: string, outputId = 'output', inputId = 'input') {
  return {
    outputNodeId: outputNodeId as NodeId,
    outputId: outputId as PortId,
    inputNodeId: inputNodeId as NodeId,
    inputId: inputId as PortId,
  } satisfies NodeConnection;
}

function makeProject(nodes: ChartNode[] = [], connections: NodeConnection[] = []): GraphBuilderAuthoringProject {
  return {
    metadata: {
      id: 'project' as ProjectId,
      title: 'Project',
      description: '',
      mainGraphId: graphId,
    },
    graphs: {
      [graphId]: {
        metadata: { id: graphId, name: 'Graph' },
        nodes,
        connections,
      },
    },
  };
}

function completeValidation() {
  return {
    completeness: 'complete' as const,
    diagnostics: [],
    blockingDiagnosticKeys: [],
  };
}

function makeSemantics(overrides: Partial<GraphBuilderAuthoringSemantics> = {}): GraphBuilderAuthoringSemantics {
  const semantics: GraphBuilderAuthoringSemantics = {
    createNodeFromAuthoringChoice: ({ operation, allocatedNodeId }) => {
      if (operation.authoringChoiceId !== 'registered:test') {
        throw new Error('Unsupported authoring choice');
      }
      return makeNode(allocatedNodeId, {
        title: 'Test',
        data: operation.settings,
        inputPort: typeof operation.settings?.inputPort === 'string' ? operation.settings.inputPort : undefined,
        outputPort: typeof operation.settings?.outputPort === 'string' ? operation.settings.outputPort : undefined,
      });
    },
    applyNodeSettings: ({ operation, node }) => {
      const supported = new Set(['inputPort', 'outputPort', 'value']);
      for (const key of Object.keys(operation.settings)) {
        if (!supported.has(key)) {
          throw new Error(`Unsupported setting ${key}`);
        }
      }
      return {
        ...cloneDeep(node),
        data: {
          ...(node.data as Record<string, unknown>),
          ...operation.settings,
        },
      };
    },
    resolvePorts: ({ nodeId, project }): GraphBuilderResolvedNodePorts => {
      const node = project.graphs[graphId]!.nodes.find((candidate) => candidate.id === nodeId);
      if (!node) {
        throw new Error('Missing node');
      }
      const data = node.data as Record<string, unknown>;
      return {
        inputs: [{ id: String(data.inputPort ?? 'input') as PortId, dataType: 'string' }],
        outputs: [{ id: String(data.outputPort ?? 'output') as PortId, dataType: 'string' }],
      };
    },
    validateConnection: completeValidation,
    normalizeCandidate: ({ project }) => ({ project: cloneDeep(project) }),
    validateCandidate: completeValidation,
  };
  return { ...semantics, ...overrides };
}

function makeKernel(input: {
  project?: GraphBuilderAuthoringProject;
  semantics?: GraphBuilderAuthoringSemantics;
  ids?: string[];
  idGenerator?: () => NodeId;
}) {
  const ids = [...(input.ids ?? ['generated'])];
  return new GraphBuilderTransactionKernel({
    project: input.project ?? makeProject(),
    activeGraphId: graphId,
    authorization: {
      allowedGraphIds: [graphId],
      allowedOperations: [
        'createNode',
        'cloneNode',
        'updateNodeSettings',
        'updateNodeEnvelope',
        'deleteNode',
        'connect',
        'disconnect',
      ],
      allowSemanticCrossGraphPropagation: false,
      sensitiveFieldAccess: 'none',
    },
    semantics: input.semantics ?? makeSemantics(),
    idGenerator:
      input.idGenerator ??
      (() => {
        const next = ids.shift();
        if (!next) {
          throw new Error('Test ID generator exhausted');
        }
        return next as NodeId;
      }),
  });
}

function patch(patchId: string, expectedDraftRevision: number, operations: GraphPatch['operations']): GraphPatch {
  return { protocolVersion: GRAPH_BUILDER_PROTOCOL_VERSION, patchId, expectedDraftRevision, operations };
}

test('applies one atomic symbolic-ID patch, owns node IDs, and replays it idempotently', () => {
  const kernel = makeKernel({ ids: ['real-source', 'real-target'] });
  const input = patch('patch-1', 0, [
    { op: 'createNode', clientId: 'source', authoringChoiceId: 'registered:test' },
    { op: 'createNode', clientId: 'target', authoringChoiceId: 'registered:test' },
    {
      op: 'connect',
      from: { node: { kind: 'created', clientId: 'source' }, port: 'output' },
      to: { node: { kind: 'created', clientId: 'target' }, port: 'input' },
    },
  ]);

  const result = kernel.applyPatch(input);
  assert.equal(result.disposition, 'applied');
  assert.equal(kernel.getDraftRevision(), 1);
  if (result.disposition !== 'applied') {
    return;
  }
  assert.deepEqual(
    { ...result.createdNodeIds },
    {
      source: 'real-source',
      target: 'real-target',
    },
  );
  assert.deepEqual(kernel.getDraft().graphs[graphId]!.connections, [makeConnection('real-source', 'real-target')]);
  assert.equal(parseApplyPatchResult(result).disposition, 'applied');
  assert.deepEqual(
    kernel.getDraft().graphs[graphId]!.nodes.map((node) => node.visualData),
    [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ],
  );

  const replay = kernel.applyPatch(input);
  assert.equal(replay.disposition, 'replayed');
  assert.equal(kernel.getDraftRevision(), 1);
  assert.throws(
    () =>
      kernel.applyPatch(
        patch('patch-1', 0, [{ op: 'createNode', clientId: 'different', authoringChoiceId: 'registered:test' }]),
      ),
    (error: unknown) => error instanceof GraphBuilderProtocolError && error.code === 'patch-identity-content-mismatch',
  );
});

test('cloneNode deep-clones the complete node, resets position, and copies no connections', () => {
  const source = {
    ...makeNode('source'),
    type: 'nodePrefabInstance',
    title: 'Linked node',
    description: 'Keep the complete host-owned envelope',
    isSplitRun: true,
    isSplitSequential: true,
    splitRunMax: 4,
    splitRunConcurrency: 2,
    disabled: true,
    isConditional: true,
    visualData: {
      x: 125,
      y: -40,
      width: 320,
      color: { border: '#112233', bg: '#ddeeff' },
      zIndex: 7,
    },
    data: {
      prefabId: 'linked-prefab',
      opaqueConfig: {
        secretMarker: 'opaque-secret',
        nested: [{ enabled: true }],
      },
    },
    variants: [{ id: 'variant', data: { opaqueVariant: ['preserve', 2] } }],
    tests: [
      {
        id: 'test-group',
        evaluatorGraphId: graphId,
        tests: [{ conditionText: 'preserve test metadata' }],
      },
    ],
  } satisfies ChartNode;
  const target = makeNode('target');
  let normalizedCreatedNodeIds: readonly NodeId[] = [];
  let normalizedTouchedScope: GraphBuilderTouchedScope | undefined;
  const kernel = makeKernel({
    project: makeProject([source, target], [makeConnection('source', 'target')]),
    ids: ['cloned'],
    semantics: makeSemantics({
      normalizeCandidate: ({ project, createdNodeIds, touchedScope }) => {
        normalizedCreatedNodeIds = [...createdNodeIds];
        normalizedTouchedScope = cloneDeep(touchedScope);
        return { project: cloneDeep(project) };
      },
    }),
  });

  const result = kernel.applyPatch(
    patch('clone-complete-node', 0, [
      {
        op: 'cloneNode',
        clientId: 'copy',
        source: { kind: 'existing', nodeId: 'source' },
        precondition: {
          type: 'nodePrefabInstance',
          title: 'Linked node',
          disabled: true,
          isConditional: true,
          isSplitRun: true,
          splitRunMax: 4,
        },
      },
    ]),
  );

  assert.equal(result.disposition, 'applied');
  if (result.disposition !== 'applied') {
    return;
  }
  assert.deepEqual({ ...result.createdNodeIds }, { copy: 'cloned' });
  assert.doesNotMatch(JSON.stringify(result), /opaque-secret/);

  const draft = kernel.getDraft();
  const sourceInDraft = draft.graphs[graphId]!.nodes.find((node) => node.id === ('source' as NodeId))!;
  const clone = draft.graphs[graphId]!.nodes.find((node) => node.id === ('cloned' as NodeId))!;
  const expectedClone = cloneDeep(source);
  expectedClone.id = 'cloned' as NodeId;
  expectedClone.visualData = { ...expectedClone.visualData, x: 0, y: 0 };
  assert.deepEqual(clone, expectedClone);
  assert.notStrictEqual(clone.data, sourceInDraft.data);
  assert.notStrictEqual(clone.visualData, sourceInDraft.visualData);
  assert.deepEqual(draft.graphs[graphId]!.connections, [makeConnection('source', 'target')]);
  assert.deepEqual(normalizedCreatedNodeIds, ['cloned']);
  assert.deepEqual(normalizedTouchedScope, {
    graphIds: [graphId],
    nodeIds: ['cloned'],
    connectionKeys: [],
    operationIndices: [0],
  });
});

test('cloneNode rejects patch-local sources and failed preconditions atomically', () => {
  const missingSourceKernel = makeKernel({ ids: ['unused'] });
  const missingSourceResult = missingSourceKernel.applyPatch(
    patch('missing-clone-source', 0, [
      {
        op: 'cloneNode',
        clientId: 'copy',
        source: { kind: 'existing', nodeId: 'missing' },
      },
    ]),
  );
  assert.equal(missingSourceResult.disposition, 'rejected');
  assert.match(missingSourceResult.diagnostics[0]?.message ?? '', /referenced node does not exist/i);

  const patchLocalKernel = makeKernel({ ids: ['patch-created'] });
  const patchLocalResult = patchLocalKernel.applyPatch(
    patch('patch-local-clone-source', 0, [
      { op: 'createNode', clientId: 'source', authoringChoiceId: 'registered:test' },
      {
        op: 'cloneNode',
        clientId: 'copy',
        source: { kind: 'existing', nodeId: 'patch-created' },
      },
    ]),
  );
  assert.equal(patchLocalResult.disposition, 'rejected');
  assert.deepEqual(patchLocalKernel.getDraft().graphs[graphId]!.nodes, []);

  const preconditionKernel = makeKernel({
    project: makeProject([makeNode('source', { title: 'Current' })]),
    ids: ['unused'],
  });
  const preconditionResult = preconditionKernel.applyPatch(
    patch('clone-precondition', 0, [
      {
        op: 'cloneNode',
        clientId: 'copy',
        source: { kind: 'existing', nodeId: 'source' },
        precondition: { title: 'Stale' },
      },
    ]),
  );
  assert.equal(preconditionResult.disposition, 'rejected');
  assert.deepEqual(
    preconditionKernel.getDraft().graphs[graphId]!.nodes.map((node) => node.id),
    ['source'],
  );
});

test('cloneNode requires a fresh bounded host ID even after an earlier delete', () => {
  const project = makeProject([makeNode('source'), makeNode('retired')]);
  const reusedIdKernel = makeKernel({ project, ids: ['retired'] });
  const reusedIdResult = reusedIdKernel.applyPatch(
    patch('clone-reused-id', 0, [
      { op: 'deleteNode', node: { kind: 'existing', nodeId: 'retired' } },
      {
        op: 'cloneNode',
        clientId: 'copy',
        source: { kind: 'existing', nodeId: 'source' },
      },
    ]),
  );
  assert.equal(reusedIdResult.disposition, 'rejected');
  assert.deepEqual(reusedIdKernel.getDraft(), project);

  const unboundedIdKernel = makeKernel({ project, ids: [' padded '] });
  const unboundedIdResult = unboundedIdKernel.applyPatch(
    patch('clone-unbounded-id', 0, [
      {
        op: 'cloneNode',
        clientId: 'copy',
        source: { kind: 'existing', nodeId: 'source' },
      },
    ]),
  );
  assert.equal(unboundedIdResult.disposition, 'rejected');
  assert.deepEqual(unboundedIdKernel.getDraft(), project);
});

test('cloneNode copies Code source types, including ignored legacy fields', () => {
  for (const sourceType of ['code', 'codeNew']) {
    const source = {
      ...makeNode('source', {
        data: {
          code: 'return process.env.SECRET;',
          allowFetch: true,
          allowRequire: true,
          allowRivet: true,
          allowProcess: true,
          allowConsole: true,
        },
      }),
      type: sourceType,
    } satisfies ChartNode;
    const project = makeProject([source, makeNode('other', { title: 'Original' })]);
    const kernel = makeKernel({
      project,
      ids: ['copy'],
    });

    const result = kernel.applyPatch(
      patch(`clone-${sourceType}`, 0, [
        {
          op: 'updateNodeEnvelope',
          node: { kind: 'existing', nodeId: 'other' },
          envelope: { title: 'Updated before clone' },
        },
        {
          op: 'cloneNode',
          clientId: 'copy',
          source: { kind: 'existing', nodeId: 'source' },
        },
      ]),
    );

    assert.equal(result.disposition, 'applied');
    if (result.disposition !== 'applied') {
      continue;
    }
    const draft = kernel.getDraft();
    const draftNodes = draft.graphs[graphId]!.nodes;
    assert.equal(draftNodes.find((node) => node.id === 'other')?.title, 'Updated before clone');
    const copy = draftNodes.find((node) => node.id === 'copy');
    assert.ok(copy);
    assert.equal(copy.type, sourceType);
    assert.deepEqual(copy.data, source.data);
    assert.equal(kernel.getDraftRevision(), 1);
  }
});

test('rejects non-data base and adapter results without invoking getters', () => {
  let baseGetterCalls = 0;
  const accessorProject = makeProject();
  Object.defineProperty(accessorProject.metadata, 'title', {
    enumerable: true,
    get() {
      baseGetterCalls += 1;
      return 'must-not-run';
    },
  });
  assert.throws(
    () => makeKernel({ project: accessorProject }),
    (error: unknown) => error instanceof GraphBuilderProtocolError && error.code === 'invalid-authoring-project',
  );
  assert.equal(baseGetterCalls, 0);

  let createGetterCalls = 0;
  const createKernel = makeKernel({
    semantics: makeSemantics({
      createNodeFromAuthoringChoice: ({ allocatedNodeId }) => {
        const node = makeNode(allocatedNodeId);
        Object.defineProperty(node.data, 'value', {
          enumerable: true,
          get() {
            createGetterCalls += 1;
            return 'must-not-run';
          },
        });
        return node;
      },
    }),
  });
  assert.equal(
    createKernel.applyPatch(
      patch('create-accessor', 0, [{ op: 'createNode', clientId: 'created', authoringChoiceId: 'registered:test' }]),
    ).disposition,
    'rejected',
  );
  assert.equal(createGetterCalls, 0);

  let updateGetterCalls = 0;
  const updateKernel = makeKernel({
    project: makeProject([makeNode('existing')]),
    semantics: makeSemantics({
      applyNodeSettings: ({ node }) => {
        const updated = cloneDeep(node);
        Object.defineProperty(updated.data, 'value', {
          enumerable: true,
          get() {
            updateGetterCalls += 1;
            return 'must-not-run';
          },
        });
        return updated;
      },
    }),
  });
  assert.equal(
    updateKernel.applyPatch(
      patch('update-accessor', 0, [
        {
          op: 'updateNodeSettings',
          node: { kind: 'existing', nodeId: 'existing' },
          settings: { value: 'changed' },
        },
      ]),
    ).disposition,
    'rejected',
  );
  assert.equal(updateGetterCalls, 0);

  let normalizationGetterCalls = 0;
  const normalizationKernel = makeKernel({
    project: makeProject([makeNode('existing')]),
    semantics: makeSemantics({
      normalizeCandidate: () => {
        const result = {};
        Object.defineProperty(result, 'project', {
          enumerable: true,
          get() {
            normalizationGetterCalls += 1;
            return makeProject([makeNode('existing')]);
          },
        });
        return result as { project: GraphBuilderAuthoringProject };
      },
    }),
  });
  assert.equal(
    normalizationKernel.applyPatch(
      patch('normalization-accessor', 0, [
        {
          op: 'updateNodeEnvelope',
          node: { kind: 'existing', nodeId: 'existing' },
          envelope: { title: 'Changed' },
        },
      ]),
    ).disposition,
    'rejected',
  );
  assert.equal(normalizationGetterCalls, 0);
});

test('dynamic port results are data-only and use bounded non-empty identifiers', () => {
  const project = makeProject([makeNode('source'), makeNode('target')]);
  let getterCalls = 0;
  const accessorKernel = makeKernel({
    project,
    semantics: makeSemantics({
      resolvePorts: () => {
        const output = { dataType: 'string' };
        Object.defineProperty(output, 'id', {
          enumerable: true,
          get() {
            getterCalls += 1;
            return 'output';
          },
        });
        return {
          inputs: [{ id: 'input' as PortId, dataType: 'string' }],
          outputs: [output],
        } as unknown as GraphBuilderResolvedNodePorts;
      },
    }),
  });
  assert.equal(
    accessorKernel.applyPatch(
      patch('port-accessor', 0, [
        {
          op: 'connect',
          from: { node: { kind: 'existing', nodeId: 'source' }, port: 'output' },
          to: { node: { kind: 'existing', nodeId: 'target' }, port: 'input' },
        },
      ]),
    ).disposition,
    'rejected',
  );
  assert.equal(getterCalls, 0);

  for (const invalidPortId of ['', ' padded ', 'x'.repeat(161)]) {
    const malformedKernel = makeKernel({
      project,
      semantics: makeSemantics({
        resolvePorts: () => ({
          inputs: [{ id: invalidPortId as PortId, dataType: 'string' }],
          outputs: [{ id: invalidPortId as PortId, dataType: 'string' }],
        }),
      }),
    });
    assert.equal(
      malformedKernel.applyPatch(
        patch(`invalid-port-${invalidPortId.length}`, 0, [
          {
            op: 'connect',
            from: { node: { kind: 'existing', nodeId: 'source' }, port: 'output' },
            to: { node: { kind: 'existing', nodeId: 'target' }, port: 'input' },
          },
        ]),
      ).disposition,
      'rejected',
    );
  }
});

test('active graph lookup ignores inherited object properties', () => {
  const project = makeProject();

  assert.throws(
    () =>
      new GraphBuilderTransactionKernel({
        project,
        activeGraphId: 'toString' as GraphId,
        authorization: {
          allowedGraphIds: ['toString'],
          allowedOperations: ['createNode'],
          allowSemanticCrossGraphPropagation: false,
          sensitiveFieldAccess: 'none',
        },
        semantics: makeSemantics(),
        idGenerator: () => 'generated' as NodeId,
      }),
    (error: unknown) => error instanceof GraphBuilderProtocolError && error.code === 'invalid-authoring-project',
  );

  Object.defineProperty(project.graphs, 'toString', {
    enumerable: true,
    configurable: true,
    writable: true,
    value: {
      metadata: { id: 'toString' as GraphId, name: 'Own graph' },
      nodes: [],
      connections: [],
    },
  });
  const ownGraphKernel = new GraphBuilderTransactionKernel({
    project,
    activeGraphId: 'toString' as GraphId,
    authorization: {
      allowedGraphIds: ['toString'],
      allowedOperations: ['createNode'],
      allowSemanticCrossGraphPropagation: false,
      sensitiveFieldAccess: 'none',
    },
    semantics: makeSemantics(),
    idGenerator: () => 'generated' as NodeId,
  });
  assert.equal(Object.hasOwn(ownGraphKernel.getDraft().graphs, 'toString'), true);
});

test('rejects a failed operation without retaining preceding candidate mutations', () => {
  const project = makeProject([makeNode('existing')]);
  const kernel = makeKernel({ project, ids: ['never-promoted'] });
  const result = kernel.applyPatch(
    patch('atomic-rejection', 0, [
      { op: 'createNode', clientId: 'temporary', authoringChoiceId: 'registered:test' },
      {
        op: 'updateNodeEnvelope',
        node: { kind: 'existing', nodeId: 'missing' },
        envelope: { title: 'Not applied' },
      },
    ]),
  );

  assert.equal(result.disposition, 'rejected');
  assert.equal(kernel.getDraftRevision(), 0);
  assert.deepEqual(kernel.getDraft(), project);
});

test('stale patches reject deterministically and replay without becoming eligible later', () => {
  const kernel = makeKernel({ project: makeProject([makeNode('node')]) });
  const stale = patch('stale', 2, [
    {
      op: 'updateNodeEnvelope',
      node: { kind: 'existing', nodeId: 'node' },
      envelope: { title: 'Changed' },
    },
  ]);

  assert.equal(kernel.applyPatch(stale).disposition, 'rejected');
  assert.equal(kernel.applyPatch(stale).disposition, 'replayed');
  assert.equal(kernel.getDraftRevision(), 0);
  assert.equal(kernel.getDraft().graphs[graphId]!.nodes[0]!.title, 'node');
});

test('a canonical no-op does not advance the draft revision', () => {
  const kernel = makeKernel({ project: makeProject([makeNode('node', { title: 'Same' })]) });
  const result = kernel.applyPatch(
    patch('no-op', 0, [
      {
        op: 'updateNodeEnvelope',
        node: { kind: 'existing', nodeId: 'node' },
        envelope: { title: 'Same' },
      },
    ]),
  );

  assert.equal(result.disposition, 'no-op');
  assert.equal(kernel.getDraftRevision(), 0);
});

test('tracks canonical base-to-draft changes independently from monotonic draft revision', () => {
  const kernel = makeKernel({ project: makeProject([makeNode('existing', { title: 'Original' })]) });
  assert.equal(kernel.hasDraftChanges(), false);

  assert.equal(
    kernel.applyPatch(
      patch('change-title', 0, [
        {
          op: 'updateNodeEnvelope',
          node: { kind: 'existing', nodeId: 'existing' },
          envelope: { title: 'Changed' },
        },
      ]),
    ).disposition,
    'applied',
  );
  assert.equal(kernel.hasDraftChanges(), true);
  assert.deepEqual(kernel.getDraftDelta().updatedNodes, [
    {
      nodeId: 'existing',
      type: 'test',
      title: 'Changed',
      changedFields: ['title'],
    },
  ]);

  assert.equal(
    kernel.applyPatch(
      patch('restore-title', 1, [
        {
          op: 'updateNodeEnvelope',
          node: { kind: 'existing', nodeId: 'existing' },
          envelope: { title: 'Original' },
        },
      ]),
    ).disposition,
    'applied',
  );
  assert.equal(kernel.getDraftRevision(), 2);
  assert.equal(kernel.hasDraftChanges(), false);
  assert.deepEqual(kernel.getDraftDelta(), {
    graphId,
    addedNodeCount: 0,
    removedNodeCount: 0,
    updatedNodeCount: 0,
    addedConnectionCount: 0,
    removedConnectionCount: 0,
    truncated: false,
    addedNodes: [],
    removedNodes: [],
    updatedNodes: [],
    addedConnections: [],
    removedConnections: [],
  });
});

test('run-mode envelope fields update atomically without entering node settings', () => {
  const kernel = makeKernel({ project: makeProject([makeNode('worker')]) });
  const result = kernel.applyPatch(
    patch('split-run', 0, [
      {
        op: 'updateNodeEnvelope',
        node: { kind: 'existing', nodeId: 'worker' },
        envelope: { isSplitRun: true, splitRunMax: 6 },
      },
    ]),
  );

  assert.equal(result.disposition, 'applied');
  const worker = kernel.getDraft().graphs[graphId]!.nodes[0]!;
  assert.equal(worker.isSplitRun, true);
  assert.equal(worker.splitRunMax, 6);
  assert.equal((worker.data as Record<string, unknown>).isSplitRun, undefined);
  assert.equal((worker.data as Record<string, unknown>).splitRunMax, undefined);
});

test('settings cannot invalidate connections unless an exact disconnect precedes the update', () => {
  const project = makeProject([makeNode('source'), makeNode('target')], [makeConnection('source', 'target')]);
  const rejectedKernel = makeKernel({ project });
  const rejected = rejectedKernel.applyPatch(
    patch('invalidates-port', 0, [
      {
        op: 'updateNodeSettings',
        node: { kind: 'existing', nodeId: 'target' },
        settings: { inputPort: 'new-input' },
      },
    ]),
  );
  assert.equal(rejected.disposition, 'rejected');
  assert.equal(rejectedKernel.getDraftRevision(), 0);

  const acceptedKernel = makeKernel({ project });
  const accepted = acceptedKernel.applyPatch(
    patch('disconnect-first', 0, [
      {
        op: 'disconnect',
        from: { node: { kind: 'existing', nodeId: 'source' }, port: 'output' },
        to: { node: { kind: 'existing', nodeId: 'target' }, port: 'input' },
      },
      {
        op: 'updateNodeSettings',
        node: { kind: 'existing', nodeId: 'target' },
        settings: { inputPort: 'new-input' },
      },
    ]),
  );
  assert.equal(accepted.disposition, 'applied');
  assert.equal(acceptedKernel.getDraft().graphs[graphId]!.connections.length, 0);
});

test('connect rejects occupied single inputs and disconnect requires exactly one endpoint tuple', () => {
  const occupiedProject = makeProject(
    [makeNode('source-a'), makeNode('source-b'), makeNode('target')],
    [makeConnection('source-a', 'target')],
  );
  const occupiedKernel = makeKernel({ project: occupiedProject });
  assert.equal(
    occupiedKernel.applyPatch(
      patch('occupied', 0, [
        {
          op: 'connect',
          from: { node: { kind: 'existing', nodeId: 'source-b' }, port: 'output' },
          to: { node: { kind: 'existing', nodeId: 'target' }, port: 'input' },
        },
      ]),
    ).disposition,
    'rejected',
  );

  const missingKernel = makeKernel({ project: makeProject([makeNode('source-a'), makeNode('target')]) });
  assert.equal(
    missingKernel.applyPatch(
      patch('missing-disconnect', 0, [
        {
          op: 'disconnect',
          from: { node: { kind: 'existing', nodeId: 'source-a' }, port: 'output' },
          to: { node: { kind: 'existing', nodeId: 'target' }, port: 'input' },
        },
      ]),
    ).disposition,
    'rejected',
  );
});

test('delete removes every incident connection as a derived effect', () => {
  const kernel = makeKernel({
    project: makeProject(
      [makeNode('source'), makeNode('middle'), makeNode('target')],
      [makeConnection('source', 'middle'), makeConnection('middle', 'target')],
    ),
  });
  const result = kernel.applyPatch(
    patch('delete', 0, [{ op: 'deleteNode', node: { kind: 'existing', nodeId: 'middle' } }]),
  );

  assert.equal(result.disposition, 'applied');
  assert.deepEqual(
    kernel.getDraft().graphs[graphId]!.nodes.map((node) => node.id),
    ['source', 'target'],
  );
  assert.equal(kernel.getDraft().graphs[graphId]!.connections.length, 0);
});

test('expected-value preconditions fail before mutation', () => {
  const kernel = makeKernel({ project: makeProject([makeNode('node', { title: 'Current' })]) });
  const result = kernel.applyPatch(
    patch('precondition', 0, [
      {
        op: 'updateNodeEnvelope',
        node: { kind: 'existing', nodeId: 'node' },
        envelope: { title: 'Next' },
        precondition: { title: 'Stale' },
      },
    ]),
  );

  assert.equal(result.disposition, 'rejected');
  assert.equal(kernel.getDraft().graphs[graphId]!.nodes[0]!.title, 'Current');
});

test('settings adapters and normalization are constrained to their declared effect closure', () => {
  const project = makeProject([makeNode('first'), makeNode('second')]);
  const envelopeChangingSemantics = makeSemantics({
    applyNodeSettings: ({ node, operation }) => ({
      ...cloneDeep(node),
      title: 'Illicit title',
      data: { ...(node.data as Record<string, unknown>), ...operation.settings },
    }),
  });
  const envelopeKernel = makeKernel({ project, semantics: envelopeChangingSemantics });
  assert.equal(
    envelopeKernel.applyPatch(
      patch('adapter-envelope', 0, [
        {
          op: 'updateNodeSettings',
          node: { kind: 'existing', nodeId: 'first' },
          settings: { value: 'changed' },
        },
      ]),
    ).disposition,
    'rejected',
  );

  const normalizationSemantics = makeSemantics({
    normalizeCandidate: ({ project: candidate }) => {
      const normalized = cloneDeep(candidate);
      normalized.graphs[graphId]!.nodes.find((node) => node.id === ('second' as NodeId))!.title =
        'Illicit normalization';
      return { project: normalized };
    },
  });
  const normalizationKernel = makeKernel({ project, semantics: normalizationSemantics });
  assert.equal(
    normalizationKernel.applyPatch(
      patch('normalization-effect', 0, [
        {
          op: 'updateNodeSettings',
          node: { kind: 'existing', nodeId: 'first' },
          settings: { value: 'changed' },
        },
      ]),
    ).disposition,
    'rejected',
  );

  const createdPositionSemantics = makeSemantics({
    normalizeCandidate: ({ project: candidate, createdNodeIds }) => {
      const normalized = cloneDeep(candidate);
      for (const node of normalized.graphs[graphId]!.nodes) {
        if (createdNodeIds.includes(node.id)) {
          node.visualData.x = 420;
          node.visualData.y = 240;
        }
      }
      return { project: normalized };
    },
  });
  const createdPositionKernel = makeKernel({
    project: makeProject([makeNode('existing')]),
    semantics: createdPositionSemantics,
    ids: ['created'],
  });
  const positioned = createdPositionKernel.applyPatch(
    patch('normalization-created-position', 0, [
      {
        op: 'createNode',
        clientId: 'created',
        authoringChoiceId: 'registered:test',
      },
    ]),
  );
  assert.equal(positioned.disposition, 'applied');
  assert.deepEqual(
    createdPositionKernel.getDraft().graphs[graphId]!.nodes.map((node) => ({
      id: node.id,
      x: node.visualData.x,
      y: node.visualData.y,
    })),
    [
      { id: 'existing', x: 10, y: 20 },
      { id: 'created', x: 420, y: 240 },
    ],
  );
});

test('mandatory candidate and connection validation fail closed', () => {
  const incompleteCandidateKernel = makeKernel({
    project: makeProject([makeNode('node')]),
    semantics: makeSemantics({
      validateCandidate: () => ({
        completeness: 'incomplete',
        diagnostics: [],
        blockingDiagnosticKeys: [],
      }),
    }),
  });
  assert.equal(
    incompleteCandidateKernel.applyPatch(
      patch('incomplete-candidate', 0, [
        {
          op: 'updateNodeEnvelope',
          node: { kind: 'existing', nodeId: 'node' },
          envelope: { title: 'Changed' },
        },
      ]),
    ).disposition,
    'rejected',
  );

  const failedConnectionKernel = makeKernel({
    project: makeProject([makeNode('source'), makeNode('target')]),
    semantics: makeSemantics({
      validateConnection: () => {
        throw new Error('Rule crashed');
      },
    }),
  });
  assert.equal(
    failedConnectionKernel.applyPatch(
      patch('failed-connection', 0, [
        {
          op: 'connect',
          from: { node: { kind: 'existing', nodeId: 'source' }, port: 'output' },
          to: { node: { kind: 'existing', nodeId: 'target' }, port: 'input' },
        },
      ]),
    ).disposition,
    'rejected',
  );
});
