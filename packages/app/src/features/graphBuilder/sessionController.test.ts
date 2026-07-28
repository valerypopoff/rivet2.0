import assert from 'node:assert/strict';
import test from 'node:test';
import { type GraphId, type NodeGraph, type NodeId, type Project, type ProjectId } from '@valerypopoff/rivet2-core';
import {
  GRAPH_BUILDER_LIMITS,
  GRAPH_BUILDER_PROTOCOL_VERSION,
  type GraphBuilderDecision,
  type GraphBuilderDocumentPatchResult,
  type GraphBuilderProjectDraftDelta,
  type GraphBuilderProjection,
  type GraphBuilderReadResult,
  type GraphDraftDelta,
  type GraphValidationResult,
} from '../../domain/graphBuilder/index.js';
import type { GraphBuilderBaseIdentity } from './identity.js';
import {
  GRAPH_BUILDER_METRICS_VERSION,
  GraphBuilderSessionController,
  type GraphBuilderPolicyExecutionResult,
  type GraphBuilderPolicyTurn,
  type GraphBuilderSessionLimits,
  type GraphBuilderMetricsEvent,
  type GraphBuilderMetricsSink,
} from './sessionController.js';

const projectId = 'project' as ProjectId;
const graphId = 'graph' as GraphId;

function emptyProject(): Omit<Project, 'data'> {
  return {
    metadata: { id: projectId, title: 'Project', description: '' },
    graphs: {
      [graphId]: {
        metadata: { id: graphId, name: 'Graph', description: '' },
        nodes: [],
        connections: [],
      },
    },
    plugins: [],
  };
}

function baseIdentity(): GraphBuilderBaseIdentity {
  return {
    projectId,
    activeGraphId: graphId,
    editorRevision: 0,
    projectFingerprint: 'project-fingerprint',
    projectCanonicalIdentity: '{}',
    registryContractFingerprint: 'registry-fingerprint',
    registryContractCanonicalIdentity: '{}',
    referencedProjectsFingerprint: 'references-fingerprint',
    referencedProjectsCanonicalIdentity: '{}',
    policyConfigFingerprint: 'policy-fingerprint',
    validationRulesVersion: '1',
    protocolVersion: GRAPH_BUILDER_PROTOCOL_VERSION,
  };
}

function delta(): GraphDraftDelta {
  return {
    graphId,
    addedNodes: [{ nodeId: 'created' as NodeId, type: 'text', title: 'Text' }],
    removedNodes: [],
    updatedNodes: [],
    addedConnections: [],
    removedConnections: [],
  };
}

function projectDelta(graphDelta: GraphDraftDelta = delta()): GraphBuilderProjectDraftDelta {
  return { graphDeltas: [graphDelta] };
}

function emptyDelta(): GraphDraftDelta {
  return {
    graphId,
    addedNodes: [],
    removedNodes: [],
    updatedNodes: [],
    addedConnections: [],
    removedConnections: [],
  };
}

class FakeKernel {
  #draft = emptyProject();
  #revision = 0;
  readonly appliedPatchIds: string[] = [];
  readonly replacedDocuments: Array<{ path: string; contents: string }> = [];

  constructor(private readonly appliedDelta: GraphDraftDelta = delta()) {}

  applyDocumentPatch(patch: {
    patchId: string;
    expectedDraftRevision: number;
    unifiedDiff: string;
  }): GraphBuilderDocumentPatchResult {
    return this.#applyAcceptedEdit(patch);
  }

  replaceDocument(patch: {
    patchId: string;
    expectedDraftRevision: number;
    path: string;
    contents: string;
  }): GraphBuilderDocumentPatchResult {
    this.replacedDocuments.push({ path: patch.path, contents: patch.contents });
    return this.#applyAcceptedEdit(patch);
  }

  #applyAcceptedEdit(patch: { patchId: string; expectedDraftRevision: number }): GraphBuilderDocumentPatchResult {
    if (patch.expectedDraftRevision !== this.#revision) {
      return {
        disposition: 'rejected',
        patchId: patch.patchId,
        baseRevision: this.#revision,
        draftRevision: this.#revision,
        diagnostics: [
          {
            diagnosticKey: 'expected-draft-revision',
            ruleId: 'expected-draft-revision',
            rulesVersion: '1',
            severity: 'error',
            verification: 'verified',
            message: 'The document edit was proposed against a stale virtual graph draft revision.',
            expected: patch.expectedDraftRevision,
            actual: this.#revision,
            repairHint: 'Regenerate the edit against the current draft revision.',
          },
        ],
      };
    }
    this.appliedPatchIds.push(patch.patchId);
    const created = {
      id: 'created' as NodeId,
      type: 'text',
      title: 'Text',
      visualData: { x: 0, y: 0 },
      data: { text: 'Hello' },
    };
    this.#draft.graphs[graphId]!.nodes.push(created);
    const baseRevision = this.#revision++;
    return {
      disposition: 'applied',
      patchId: patch.patchId,
      baseRevision,
      draftRevision: this.#revision,
      delta: projectDelta(this.appliedDelta),
      diagnostics: [],
    };
  }

  getDraft() {
    return structuredClone(this.#draft);
  }

  getDraftDelta() {
    return this.hasDraftChanges() ? structuredClone(this.appliedDelta) : emptyDelta();
  }

  getProjectDraftDelta() {
    return this.hasDraftChanges() ? projectDelta(structuredClone(this.appliedDelta)) : { graphDeltas: [] };
  }

  getDraftRevision() {
    return this.#revision;
  }

  hasDraftChanges() {
    return this.#draft.graphs[graphId]!.nodes.length > 0;
  }
}

class RevertingFakeKernel {
  #draft = emptyProject();
  #revision = 0;

  applyDocumentPatch(patch: {
    patchId: string;
    expectedDraftRevision: number;
    unifiedDiff: string;
  }): GraphBuilderDocumentPatchResult {
    if (patch.expectedDraftRevision !== this.#revision) {
      throw new Error('stale revision');
    }
    const baseRevision = this.#revision++;
    const graph = this.#draft.graphs[graphId]!;
    const restoringBase = graph.nodes.length > 0;
    graph.nodes = restoringBase
      ? []
      : [
          {
            id: 'created' as NodeId,
            type: 'text',
            title: 'Text',
            visualData: { x: 0, y: 0 },
            data: { text: 'Hello' },
          },
        ];
    return {
      disposition: 'applied',
      patchId: patch.patchId,
      baseRevision,
      draftRevision: this.#revision,
      delta: projectDelta({
        graphId,
        addedNodes: restoringBase ? [] : [{ nodeId: 'created' as NodeId, type: 'text', title: 'Text' }],
        removedNodes: restoringBase ? [{ nodeId: 'created' as NodeId, type: 'text', title: 'Text' }] : [],
        updatedNodes: [],
        addedConnections: [],
        removedConnections: [],
      }),
      diagnostics: [],
    };
  }

  replaceDocument(patch: {
    patchId: string;
    expectedDraftRevision: number;
    path: string;
    contents: string;
  }): GraphBuilderDocumentPatchResult {
    return this.applyDocumentPatch({ ...patch, unifiedDiff: '' });
  }

  getDraft() {
    return structuredClone(this.#draft);
  }

  getDraftDelta() {
    return this.hasDraftChanges() ? delta() : emptyDelta();
  }

  getProjectDraftDelta() {
    return this.hasDraftChanges() ? projectDelta() : { graphDeltas: [] };
  }

  getDraftRevision() {
    return this.#revision;
  }

  hasDraftChanges() {
    return this.#draft.graphs[graphId]!.nodes.length > 0;
  }
}

class NoOpAfterChangeFakeKernel {
  #draft = emptyProject();
  #revision = 0;

  applyDocumentPatch(patch: {
    patchId: string;
    expectedDraftRevision: number;
    unifiedDiff: string;
  }): GraphBuilderDocumentPatchResult {
    if (patch.expectedDraftRevision !== this.#revision) {
      throw new Error('stale revision');
    }
    if (this.#revision === 0) {
      this.#draft.graphs[graphId]!.nodes.push({
        id: 'created' as NodeId,
        type: 'text',
        title: 'Text',
        visualData: { x: 0, y: 0 },
        data: { text: 'Hello' },
      });
      this.#revision = 1;
      return {
        disposition: 'applied',
        patchId: patch.patchId,
        baseRevision: 0,
        draftRevision: 1,
        delta: projectDelta(),
        diagnostics: [],
      };
    }
    return {
      disposition: 'no-op',
      patchId: patch.patchId,
      baseRevision: this.#revision,
      draftRevision: this.#revision,
      delta: { graphDeltas: [] },
      diagnostics: [],
    };
  }

  replaceDocument(patch: {
    patchId: string;
    expectedDraftRevision: number;
    path: string;
    contents: string;
  }): GraphBuilderDocumentPatchResult {
    return this.applyDocumentPatch({ ...patch, unifiedDiff: '' });
  }

  getDraft() {
    return structuredClone(this.#draft);
  }

  getDraftDelta() {
    return delta();
  }

  getProjectDraftDelta() {
    return projectDelta();
  }

  getDraftRevision() {
    return this.#revision;
  }

  hasDraftChanges() {
    return true;
  }
}

function policyResult(turn: GraphBuilderPolicyTurn, decision: GraphBuilderDecision): GraphBuilderPolicyExecutionResult {
  return {
    protocolVersion: GRAPH_BUILDER_PROTOCOL_VERSION,
    policyVersion: turn.policyVersion,
    sessionId: turn.sessionId,
    turnId: turn.turnId,
    attemptId: turn.attemptId,
    decision,
    usage: { completeness: 'unavailable' },
  };
}

function createController(options: {
  executePolicy: (
    turn: GraphBuilderPolicyTurn,
    abortSignal: AbortSignal,
    reportActivity: () => void,
  ) => Promise<GraphBuilderPolicyExecutionResult>;
  kernel?: ConstructorParameters<typeof GraphBuilderSessionController>[0]['kernel'];
  read?: (
    request: Parameters<NonNullable<ConstructorParameters<typeof GraphBuilderSessionController>[0]['read']>>[0],
    context: Parameters<NonNullable<ConstructorParameters<typeof GraphBuilderSessionController>[0]['read']>>[1],
  ) => Promise<GraphBuilderReadResult>;
  verifyIdentity?: () => { matches: boolean; currentFingerprint: string };
  commit?: ConstructorParameters<typeof GraphBuilderSessionController>[0]['commit'];
  buildProjection?: ConstructorParameters<typeof GraphBuilderSessionController>[0]['buildProjection'];
  buildWorkspaceContext?: ConstructorParameters<typeof GraphBuilderSessionController>[0]['buildWorkspaceContext'];
  limits?: Partial<GraphBuilderSessionLimits>;
  metricsSink?: GraphBuilderMetricsSink;
  request?: string;
  sessionId?: string;
  validateDraft?: ConstructorParameters<typeof GraphBuilderSessionController>[0]['validateDraft'];
}) {
  const kernel = options.kernel ?? new FakeKernel();
  let commitCount = 0;
  const controller = new GraphBuilderSessionController({
    base: baseIdentity(),
    buildProjection:
      options.buildProjection ??
      (({ draftRevision }): GraphBuilderProjection => ({
        protocolVersion: GRAPH_BUILDER_PROTOCOL_VERSION,
        projectId,
        graphId,
        draftRevision,
        nodes: [],
        connections: [],
        diagnostics: [],
      })),
    buildWorkspaceContext:
      options.buildWorkspaceContext ??
      (() => ({
        version: 1,
        activeDocumentPath: 'graphs/graph.yaml',
        delta: { graphDeltas: [] },
        documents: [
          {
            path: 'graphs/graph.yaml',
            graphId,
            name: 'Graph',
            digest: 'digest',
            totalLength: 11,
            totalLines: 1,
            access: 'editable',
          },
        ],
        activeDocument: {
          path: 'graphs/graph.yaml',
          digest: 'digest',
          startOffset: 0,
          endOffset: 11,
          totalLength: 11,
          totalLines: 1,
          startLine: 1,
          endLine: 1,
          content: 'version: 1\n',
          truncated: false,
        },
      })),
    commit:
      options.commit ??
      (({ draftRevision, summary }) => {
        commitCount += 1;
        return {
          status: 'committed',
          commitId: 'commit',
          draftRevision,
          summary,
        };
      }),
    executePolicy: options.executePolicy,
    kernel,
    limits: options.limits,
    metricsSink: options.metricsSink,
    policyVersion: 'policy-v1',
    read:
      options.read ??
      (async (_request, context) => ({
        requestId: context.requestId,
        requestIndex: context.requestIndex,
        observedDraftRevision: context.observedDraftRevision,
        status: 'ok',
        payload: null,
      })),
    request: options.request ?? 'Create a text node',
    ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
    validateDraft:
      options.validateDraft ??
      (() => ({
        completeness: 'complete',
        diagnostics: [],
        blockingDiagnosticKeys: [],
      })),
    verifyIdentity: options.verifyIdentity ?? (() => ({ matches: true, currentFingerprint: 'project-fingerprint' })),
  });
  return { controller, kernel, getCommitCount: () => commitCount };
}

const createPatchDecision = (baseRevision = 0): GraphBuilderDecision => ({
  type: 'apply-patch',
  baseRevision,
  unifiedDiff: ['--- a/graphs/graph.yaml', '+++ b/graphs/graph.yaml', '@@ -1,1 +1,1 @@', '-before', '+after'].join(
    '\n',
  ),
  summary: 'Created a text node.',
});

const createReplacementDecision = (baseRevision = 0): GraphBuilderDecision => ({
  type: 'replace-document',
  baseRevision,
  path: 'graphs/graph.yaml',
  content: 'version: 1\ngraph:\n  metadata:\n    id: graph\n',
  summary: 'Replaced the graph document.',
});

function createPatchOrReadyDecision(turn: GraphBuilderPolicyTurn): GraphBuilderDecision {
  return turn.draftRevision === 0
    ? createPatchDecision(turn.draftRevision)
    : {
        type: 'ready',
        summary: 'Created a text node.',
      };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function waitForTimer(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function settlesWithin(promise: Promise<unknown>, milliseconds = 100): Promise<boolean> {
  return Promise.race([promise.then(() => true), waitForTimer(milliseconds).then(() => false)]);
}

test('a successful policy patch remains private until explicit Apply', async () => {
  const turns: GraphBuilderPolicyTurn[] = [];
  const { controller, getCommitCount } = createController({
    executePolicy: async (turn) => {
      turns.push(structuredClone(turn));
      return policyResult(turn, createPatchOrReadyDecision(turn));
    },
  });

  await controller.start();
  assert.equal(controller.getState().status, 'ready-for-preview');
  assert.equal(turns.length, 2);
  assert.equal(turns[1]!.phase, 'reviewing');
  assert.equal(turns[1]!.draftRevision, 1);
  assert.ok(turns[1]!.transcript.some((item) => item.type === 'patch-result'));
  const prepared = controller.getState();
  assert.equal(prepared.status, 'ready-for-preview');
  assert.deepEqual(prepared.status === 'ready-for-preview' ? prepared.preview.delta : undefined, projectDelta());
  assert.equal(getCommitCount(), 0);

  await controller.apply();
  assert.equal(controller.getState().status, 'committed');
  assert.equal(getCommitCount(), 1);
  await controller.apply();
  assert.equal(getCommitCount(), 1);
});

test('an accepted document replacement enters review before exposing the aggregated preview', async () => {
  const turns: GraphBuilderPolicyTurn[] = [];
  const kernel = new FakeKernel();
  const { controller } = createController({
    kernel,
    executePolicy: async (turn) => {
      turns.push(structuredClone(turn));
      return policyResult(
        turn,
        turn.draftRevision === 0
          ? createReplacementDecision(turn.draftRevision)
          : { type: 'ready', summary: 'Replaced the graph document.' },
      );
    },
  });

  await controller.start();

  assert.equal(turns.length, 2);
  assert.equal(turns[1]!.phase, 'reviewing');
  assert.equal(turns[1]!.draftRevision, 1);
  assert.ok(turns[1]!.transcript.some((item) => item.type === 'decision' && item.decision.type === 'replace-document'));
  assert.ok(turns[1]!.transcript.some((item) => item.type === 'patch-result'));
  assert.deepEqual(kernel.replacedDocuments, [
    {
      path: 'graphs/graph.yaml',
      contents: 'version: 1\ngraph:\n  metadata:\n    id: graph\n',
    },
  ]);
  const state = controller.getState();
  assert.equal(state.status, 'ready-for-preview');
  assert.deepEqual(state.status === 'ready-for-preview' ? state.preview.delta : undefined, projectDelta());
});

test('document replacement requires complete current-document coverage visible to the policy turn', async () => {
  const kernel = new FakeKernel();
  const path = 'graphs/graph.yaml';
  const source = '0123456789abcdefghij';
  let policyCalls = 0;
  const { controller } = createController({
    kernel,
    buildWorkspaceContext: () => ({
      version: 1,
      activeDocumentPath: path,
      delta: { graphDeltas: [] },
      documents: [
        {
          path,
          graphId,
          name: 'Graph',
          digest: 'digest',
          totalLength: source.length,
          totalLines: 1,
          access: 'editable',
        },
      ],
      activeDocument: {
        path,
        digest: 'digest',
        startOffset: 0,
        endOffset: 10,
        totalLength: source.length,
        nextOffset: 10,
        totalLines: 1,
        startLine: 1,
        endLine: 1,
        content: source.slice(0, 10),
        truncated: true,
      },
    }),
    executePolicy: async (turn) => {
      policyCalls += 1;
      if (policyCalls === 1) {
        return policyResult(turn, createReplacementDecision(turn.draftRevision));
      }
      if (policyCalls === 2) {
        assert.ok(
          turn.diagnostics.some((diagnostic) => diagnostic.ruleId === 'replacement-requires-complete-document'),
        );
        return policyResult(turn, {
          type: 'request-context',
          requests: [{ type: 'read-virtual-document', path, startOffset: 10 }],
        });
      }
      if (policyCalls === 3) {
        return policyResult(turn, createReplacementDecision(turn.draftRevision));
      }
      return policyResult(turn, { type: 'ready', summary: 'Replaced the complete graph document.' });
    },
    read: async (request, context) => {
      assert.equal(request.type, 'read-virtual-document');
      return {
        requestId: context.requestId,
        requestIndex: context.requestIndex,
        observedDraftRevision: context.observedDraftRevision,
        status: 'ok',
        payload: {
          contents: source.slice(10),
          digest: 'digest',
          draftRevision: context.observedDraftRevision,
          endOffset: source.length,
          graphId,
          lineCount: 1,
          path,
          startOffset: 10,
          startLine: 1,
          totalLength: source.length,
          totalLineCount: 1,
          truncated: false,
        },
      };
    },
  });

  await controller.start();

  assert.equal(controller.getState().status, 'ready-for-preview');
  assert.equal(policyCalls, 4);
  assert.equal(kernel.replacedDocuments.length, 1);
});

test('document replacement coverage survives transcript compaction across continuation reads', async () => {
  const kernel = new FakeKernel();
  const path = 'graphs/graph.yaml';
  const source = `0123456789${'a'.repeat(20_000)}`;
  const splitOffset = 10_010;
  let policyCalls = 0;
  const { controller } = createController({
    kernel,
    limits: { maxTranscriptBytes: 5_000 },
    buildWorkspaceContext: () => ({
      version: 1,
      activeDocumentPath: path,
      delta: { graphDeltas: [] },
      documents: [
        {
          path,
          graphId,
          name: 'Graph',
          digest: 'digest',
          totalLength: source.length,
          totalLines: 1,
          access: 'editable',
        },
      ],
      activeDocument: {
        path,
        digest: 'digest',
        startOffset: 0,
        endOffset: 10,
        totalLength: source.length,
        nextOffset: 10,
        totalLines: 1,
        startLine: 1,
        endLine: 1,
        content: source.slice(0, 10),
        truncated: true,
      },
    }),
    executePolicy: async (turn) => {
      policyCalls += 1;
      if (policyCalls === 1) {
        return policyResult(turn, {
          type: 'request-context',
          requests: [{ type: 'read-virtual-document', path, startOffset: 10 }],
        });
      }
      if (policyCalls === 2) {
        return policyResult(turn, {
          type: 'request-context',
          requests: [{ type: 'read-virtual-document', path, startOffset: splitOffset }],
        });
      }
      if (policyCalls === 3) {
        assert.ok(turn.transcript.some((item) => item.type === 'compacted' && item.originalType === 'read-result'));
        return policyResult(turn, createReplacementDecision(turn.draftRevision));
      }
      return policyResult(turn, { type: 'ready', summary: 'Replaced the complete graph document.' });
    },
    read: async (request, context) => {
      assert.equal(request.type, 'read-virtual-document');
      const startOffset = request.startOffset ?? 0;
      const endOffset = startOffset === 10 ? splitOffset : source.length;
      return {
        requestId: context.requestId,
        requestIndex: context.requestIndex,
        observedDraftRevision: context.observedDraftRevision,
        status: 'ok',
        payload: {
          contents: source.slice(startOffset, endOffset),
          digest: 'digest',
          draftRevision: context.observedDraftRevision,
          endOffset,
          graphId,
          lineCount: 1,
          path,
          startOffset,
          startLine: 1,
          totalLength: source.length,
          totalLineCount: 1,
          truncated: endOffset < source.length,
          ...(endOffset < source.length ? { nextOffset: endOffset } : {}),
        },
      };
    },
  });

  await controller.start();

  assert.equal(controller.getState().status, 'ready-for-preview');
  assert.equal(policyCalls, 4);
  assert.equal(kernel.replacedDocuments.length, 1);
});

test('a stale document replacement is rejected with diagnostics and repaired on a later turn', async () => {
  const kernel = new FakeKernel();
  const phases: GraphBuilderPolicyTurn['phase'][] = [];
  let policyCalls = 0;
  const { controller } = createController({
    kernel,
    executePolicy: async (turn) => {
      phases.push(turn.phase);
      policyCalls += 1;
      if (policyCalls === 1) {
        return policyResult(turn, createReplacementDecision(turn.draftRevision + 1));
      }
      if (policyCalls === 2) {
        assert.ok(turn.diagnostics.some((diagnostic) => diagnostic.ruleId === 'expected-draft-revision'));
        return policyResult(turn, createReplacementDecision(turn.draftRevision));
      }
      return policyResult(turn, { type: 'ready', summary: 'Replaced the graph document.' });
    },
  });

  await controller.start();

  const state = controller.getState();
  assert.equal(state.status, 'ready-for-preview');
  assert.deepEqual(phases, ['gathering-context', 'repairing', 'reviewing']);
  assert.equal(kernel.getDraftRevision(), 1);
  assert.equal(kernel.replacedDocuments.length, 2);
});

test('session and derived correlation identifiers stay within the portable protocol limit', async () => {
  const executePolicy = async (turn: GraphBuilderPolicyTurn): Promise<GraphBuilderPolicyExecutionResult> =>
    policyResult(turn, createPatchOrReadyDecision(turn));

  assert.throws(
    () => createController({ executePolicy, sessionId: '' }),
    /session IDs must contain between 1 and 160 characters without surrounding whitespace/,
  );
  assert.throws(
    () => createController({ executePolicy, sessionId: ' padded ' }),
    /session IDs must contain between 1 and 160 characters without surrounding whitespace/,
  );
  assert.throws(
    () =>
      createController({
        executePolicy,
        sessionId: 's'.repeat(GRAPH_BUILDER_LIMITS.maxIdentifierLength + 1),
      }),
    /session IDs must contain between 1 and 160 characters without surrounding whitespace/,
  );

  const turns: GraphBuilderPolicyTurn[] = [];
  const readIds: string[] = [];
  const kernel = new FakeKernel();
  let policyCalls = 0;
  const { controller } = createController({
    kernel,
    sessionId: 's'.repeat(GRAPH_BUILDER_LIMITS.maxIdentifierLength),
    executePolicy: async (turn) => {
      turns.push(structuredClone(turn));
      policyCalls += 1;
      if (policyCalls === 1) {
        throw Object.assign(new Error('invalid decision'), { code: 'invalid-decision' });
      }
      return policyResult(
        turn,
        policyCalls === 2
          ? {
              type: 'request-context',
              requests: [{ type: 'get-diagnostics' }],
            }
          : createPatchOrReadyDecision(turn),
      );
    },
    read: async (_request, context) => {
      readIds.push(context.requestId);
      return {
        requestId: context.requestId,
        requestIndex: context.requestIndex,
        observedDraftRevision: context.observedDraftRevision,
        status: 'ok',
        payload: null,
      };
    },
  });

  await controller.start();
  assert.equal(controller.getState().status, 'ready-for-preview');
  assert.equal(turns.length, 4);
  for (const turn of turns) {
    assert.ok(turn.sessionId.length <= GRAPH_BUILDER_LIMITS.maxIdentifierLength);
    assert.ok(turn.turnId.length <= GRAPH_BUILDER_LIMITS.maxIdentifierLength);
    assert.ok(turn.attemptId.length <= GRAPH_BUILDER_LIMITS.maxIdentifierLength);
    for (const diagnostic of turn.diagnostics) {
      assert.ok(diagnostic.diagnosticKey.length <= GRAPH_BUILDER_LIMITS.maxIdentifierLength);
    }
  }
  assert.equal(readIds.length, 1);
  assert.ok(readIds[0]!.length <= GRAPH_BUILDER_LIMITS.maxIdentifierLength);
  assert.equal(kernel.appliedPatchIds.length, 1);
  assert.ok(kernel.appliedPatchIds[0]!.length <= GRAPH_BUILDER_LIMITS.maxIdentifierLength);
});

test('a subscriber that rejects its initial snapshot cannot break the session', async () => {
  const { controller } = createController({
    executePolicy: async (turn) => policyResult(turn, createPatchOrReadyDecision(turn)),
  });
  const unsubscribe = controller.subscribe(() => {
    throw new Error('broken observer');
  });

  await controller.start();
  assert.equal(controller.getState().status, 'ready-for-preview');
  unsubscribe();
  await controller.cancel();
});

test('a commit-time eligibility loss is reported accurately and retains the private preview', async () => {
  const { controller } = createController({
    executePolicy: async (turn) => policyResult(turn, createPatchOrReadyDecision(turn)),
    commit: () => ({
      status: 'ineligible',
      commitId: 'commit',
      reason: 'Stop the current graph run before applying this draft.',
    }),
  });

  await controller.start();
  assert.equal(controller.getState().status, 'ready-for-preview');
  await controller.apply();
  const state = controller.getState();
  assert.equal(state.status, 'failed');
  if (state.status !== 'failed') {
    return;
  }
  assert.equal(state.result.status, 'failed');
  assert.equal(state.result.failure.code, 'commit-ineligible');
  assert.equal(state.result.failure.userMessage, 'Stop the current graph run before applying this draft.');
  assert.ok(state.retainedPreview);
});

test('terminal decisions use the canonical base-to-draft difference rather than revision history', async () => {
  const kernel = new RevertingFakeKernel();
  let policyCalls = 0;
  const { controller, getCommitCount } = createController({
    kernel,
    executePolicy: async (turn) => {
      policyCalls += 1;
      if (policyCalls <= 2) {
        return policyResult(turn, createPatchDecision(turn.draftRevision));
      }
      return policyResult(turn, {
        type: 'no-change',
        summary: 'The requested graph already matches the current draft.',
      });
    },
  });

  await controller.start();
  assert.equal(kernel.getDraftRevision(), 2);
  assert.equal(kernel.hasDraftChanges(), false);
  assert.equal(controller.getState().status, 'no-change');
  assert.equal(getCommitCount(), 0);
  assert.equal(policyCalls, 3);
});

test('preview exposes the cumulative base-to-draft delta after a final no-op patch', async () => {
  const kernel = new NoOpAfterChangeFakeKernel();
  let policyCalls = 0;
  const { controller } = createController({
    kernel,
    executePolicy: async (turn) => {
      policyCalls += 1;
      if (policyCalls > 2) {
        return policyResult(turn, {
          type: 'ready',
          summary: 'Prepared 1 node added.',
        });
      }
      return policyResult(turn, createPatchDecision(turn.draftRevision));
    },
  });

  await controller.start();
  const state = controller.getState();
  assert.equal(state.status, 'ready-for-preview');
  if (state.status !== 'ready-for-preview') {
    return;
  }
  assert.equal(policyCalls, 3);
  assert.deepEqual(state.preview.delta, projectDelta());
  assert.equal(state.preview.summary, 'Prepared 1 node added.');
  assert.equal('draft' in state.preview, false);
});

test('context reads run in parallel and are returned to the next policy turn in request order', async () => {
  const completions: number[] = [];
  let policyCalls = 0;
  const { controller } = createController({
    executePolicy: async (turn) => {
      policyCalls += 1;
      if (policyCalls === 1) {
        return policyResult(turn, {
          type: 'request-context',
          requests: [{ type: 'inspect-draft-diff' }, { type: 'get-diagnostics' }],
        });
      }
      if (policyCalls === 2) {
        assert.deepEqual(
          turn.contextResults.map((result) => result.requestIndex),
          [0, 1],
        );
        assert.equal(
          turn.transcript.filter((item) => item.type === 'read-result').length,
          0,
          'the immediate read results must not be serialized twice',
        );
      }
      if (policyCalls === 3) {
        assert.equal(
          turn.transcript.filter((item) => item.type === 'compacted' && item.originalType === 'read-result').length,
          2,
          'read results become digest history after an accepted edit advances the revision',
        );
        assert.equal(turn.transcript.filter((item) => item.type === 'read-result').length, 0);
      }
      return policyResult(turn, createPatchOrReadyDecision(turn));
    },
    read: async (_request, context) => {
      await new Promise((resolve) => setTimeout(resolve, context.requestIndex === 0 ? 15 : 1));
      completions.push(context.requestIndex);
      return {
        requestId: context.requestId,
        requestIndex: context.requestIndex,
        observedDraftRevision: context.observedDraftRevision,
        status: 'ok',
        payload: { index: context.requestIndex },
      };
    },
  });

  await controller.start();
  assert.deepEqual(completions, [1, 0]);
  assert.equal(controller.getState().status, 'ready-for-preview');
});

test('aggregate read results are bounded before the next policy turn instead of exhausting the session', async () => {
  const largePayload = Array.from({ length: 10 }, (_, index) => `${index}:${'x'.repeat(16_000)}`);
  let policyCalls = 0;
  const { controller } = createController({
    executePolicy: async (turn) => {
      policyCalls += 1;
      if (policyCalls === 1) {
        return policyResult(turn, {
          type: 'request-context',
          requests: [{ type: 'inspect-draft-diff' }, { type: 'get-diagnostics' }],
        });
      }

      if (policyCalls === 2) {
        assert.equal(turn.contextResults.length, 2);
        assert.deepEqual(
          turn.contextResults.map((result) => result.requestIndex),
          [0, 1],
        );
        assert.ok(turn.contextResults.some((result) => result.status === 'ok'));
        assert.ok(
          turn.contextResults.some(
            (result) => result.status === 'failed' && result.error.code === 'read-result-budget-exceeded',
          ),
        );
      }
      return policyResult(turn, createPatchOrReadyDecision(turn));
    },
    read: async (_request, context) => ({
      requestId: context.requestId,
      requestIndex: context.requestIndex,
      observedDraftRevision: context.observedDraftRevision,
      status: 'ok',
      payload: { chunks: largePayload },
    }),
  });

  await controller.start();
  assert.equal(controller.getState().status, 'ready-for-preview');
  assert.equal(policyCalls, 3);
});

test('clarification keeps the session resumable and rejects token reuse with different content', async () => {
  let calls = 0;
  const { controller } = createController({
    executePolicy: async (turn) => {
      calls += 1;
      return calls === 1
        ? policyResult(turn, { type: 'clarify', question: 'Which output format?' })
        : policyResult(turn, createPatchOrReadyDecision(turn));
    },
  });

  await controller.start();
  const awaiting = controller.getState();
  assert.equal(awaiting.status, 'awaiting-user');
  if (awaiting.status !== 'awaiting-user') {
    return;
  }
  await controller.resume(awaiting.resumeToken, 'JSON');
  assert.equal(controller.getState().status, 'ready-for-preview');
  await controller.resume(awaiting.resumeToken, 'JSON');
  assert.equal(controller.getState().status, 'ready-for-preview');
  await controller.resume(awaiting.resumeToken, 'YAML');
  assert.equal(controller.getState().status, 'failed');
});

test('clarification expiry never advertises a lifetime beyond the hard session deadline', async () => {
  const createdAt = Date.now();
  const { controller } = createController({
    executePolicy: async (turn) => policyResult(turn, { type: 'clarify', question: 'Which output format?' }),
    limits: { clarificationTtlMs: 10_000, maxWallTimeMs: 1_000 },
  });

  await controller.start();
  const awaiting = controller.getState();
  assert.equal(awaiting.status, 'awaiting-user');
  if (awaiting.status !== 'awaiting-user') {
    return;
  }
  assert.ok(awaiting.expiresAt <= createdAt + 1_050);
  await controller.cancel();
});

test('identity changes after a provider await terminate as conflicted without applying a patch', async () => {
  let current = true;
  const kernel = new FakeKernel();
  const { controller } = createController({
    kernel,
    executePolicy: async (turn) => {
      current = false;
      return policyResult(turn, createPatchOrReadyDecision(turn));
    },
    verifyIdentity: () => ({
      matches: current,
      currentFingerprint: current ? 'project-fingerprint' : 'changed',
    }),
  });

  await controller.start();
  assert.equal(controller.getState().status, 'conflicted');
  assert.equal(kernel.getDraftRevision(), 0);
});

test('provider error accessors cannot escape the controller error boundary', async () => {
  const providerError = new Error('provider failed');
  Object.defineProperties(providerError, {
    code: {
      get() {
        throw new Error('hostile code accessor');
      },
    },
    usage: {
      get() {
        throw new Error('hostile usage accessor');
      },
    },
  });
  const { controller } = createController({
    executePolicy: async () => {
      throw providerError;
    },
  });

  await controller.start();
  const state = controller.getState();
  assert.equal(state.status, 'failed');
  assert.equal(
    state.status === 'failed' && state.result.status === 'failed' ? state.result.failure.code : undefined,
    'policy-failed',
  );
});

test('successful provider result accessors fail through typed policy validation', async () => {
  const { controller } = createController({
    executePolicy: async (turn) => {
      const result = policyResult(turn, createPatchDecision());
      Object.defineProperty(result, 'usage', {
        get() {
          throw new Error('hostile usage accessor');
        },
      });
      return result;
    },
  });

  await controller.start();
  const state = controller.getState();
  assert.equal(state.status, 'failed');
  assert.equal(
    state.status === 'failed' && state.result.status === 'failed' ? state.result.failure.code : undefined,
    'invalid-policy-usage',
  );
});

test('cancel aborts an in-flight provider attempt and never exposes a preview', async () => {
  const deferred = createDeferred<GraphBuilderPolicyExecutionResult>();
  let capturedTurn: GraphBuilderPolicyTurn | undefined;
  const { controller } = createController({
    executePolicy: async (turn) => {
      capturedTurn = turn;
      return await deferred.promise;
    },
  });
  const started = controller.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await controller.cancel();
  assert.equal(controller.getState().status, 'canceled');
  assert.ok(capturedTurn);
  assert.equal(await settlesWithin(started), true);
  deferred.resolve(policyResult(capturedTurn, createPatchDecision()));
  await waitForTimer(0);
  assert.equal(controller.getState().status, 'canceled');
});

test('an adapter promise is observed when cancellation happens before the wait is attached', async () => {
  const holder: { controller?: GraphBuilderSessionController } = {};
  const { controller } = createController({
    executePolicy: async () => {
      void holder.controller!.cancel();
      throw new Error('provider rejected after synchronous cancellation');
    },
  });
  holder.controller = controller;

  await controller.start();
  assert.equal(controller.getState().status, 'canceled');
  await waitForTimer(0);
});

test('the wall-clock deadline wins over a provider that ignores cancellation and late output is ignored', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000 });
  const deferred = createDeferred<GraphBuilderPolicyExecutionResult>();
  let capturedTurn: GraphBuilderPolicyTurn | undefined;
  const metrics: GraphBuilderMetricsEvent[] = [];
  const { controller, kernel } = createController({
    executePolicy: async (turn) => {
      capturedTurn = turn;
      return await deferred.promise;
    },
    limits: { maxWallTimeMs: 10 },
    metricsSink: { record: (event) => metrics.push(event) },
  });

  const started = controller.start();
  await Promise.resolve();
  assert.ok(capturedTurn);
  t.mock.timers.tick(10);
  await started;
  assert.equal(controller.getState().status, 'expired');
  deferred.resolve(policyResult(capturedTurn, createPatchDecision()));
  await Promise.resolve();
  assert.equal(controller.getState().status, 'expired');
  assert.equal(kernel.getDraftRevision(), 0);
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]?.protocolVersion, 1);
  assert.equal(metrics[0]?.outcome, 'expired');
  assert.equal(metrics[0]?.inputTokens, undefined);
  assert.equal(metrics[0]?.usageCompleteness, 'unavailable');
});

test('active-work inactivity expires a stalled provider call before the wall-clock deadline', async () => {
  const deferred = createDeferred<GraphBuilderPolicyExecutionResult>();
  let capturedTurn: GraphBuilderPolicyTurn | undefined;
  const { controller, kernel } = createController({
    executePolicy: async (turn) => {
      capturedTurn = turn;
      return await deferred.promise;
    },
    limits: { maxInactivityMs: 10, maxWallTimeMs: 1_000 },
  });

  const started = controller.start();
  await waitForTimer(30);
  assert.equal(controller.getState().status, 'expired');
  assert.ok(capturedTurn);
  assert.equal(await settlesWithin(started), true);
  deferred.resolve(policyResult(capturedTurn, createPatchDecision()));
  await waitForTimer(0);
  assert.equal(controller.getState().status, 'expired');
  assert.equal(kernel.getDraftRevision(), 0);
});

test('provider activity heartbeats keep a long streaming attempt alive across inactivity windows', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000 });
  const deferred = createDeferred<GraphBuilderPolicyExecutionResult>();
  let policyCalls = 0;
  let firstTurn: GraphBuilderPolicyTurn | undefined;
  let reportProviderActivity: (() => void) | undefined;
  const { controller } = createController({
    executePolicy: async (turn, _abortSignal, reportActivity) => {
      policyCalls += 1;
      if (policyCalls === 1) {
        firstTurn = turn;
        reportProviderActivity = reportActivity;
        return await deferred.promise;
      }
      return policyResult(turn, createPatchOrReadyDecision(turn));
    },
    limits: { maxInactivityMs: 15, maxWallTimeMs: 1_000 },
  });

  const started = controller.start();
  await Promise.resolve();
  assert.ok(firstTurn);
  assert.ok(reportProviderActivity);

  for (let elapsed = 10; elapsed <= 30; elapsed += 10) {
    t.mock.timers.tick(10);
    reportProviderActivity();
  }
  deferred.resolve(policyResult(firstTurn, createPatchDecision()));
  await started;

  assert.equal(controller.getState().status, 'ready-for-preview');
  assert.equal(policyCalls, 2);
});

test('provider activity heartbeats never extend the hard deadline', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000 });
  const deferred = createDeferred<GraphBuilderPolicyExecutionResult>();
  let capturedTurn: GraphBuilderPolicyTurn | undefined;
  let reportProviderActivity: (() => void) | undefined;
  const { controller, kernel } = createController({
    executePolicy: async (turn, _abortSignal, reportActivity) => {
      capturedTurn = turn;
      reportProviderActivity = reportActivity;
      return await deferred.promise;
    },
    limits: { maxInactivityMs: 15, maxWallTimeMs: 40 },
  });

  const started = controller.start();
  await Promise.resolve();
  assert.ok(capturedTurn);
  assert.ok(reportProviderActivity);

  for (let elapsed = 10; elapsed < 40; elapsed += 10) {
    t.mock.timers.tick(10);
    reportProviderActivity();
  }
  t.mock.timers.tick(10);
  await started;

  assert.equal(controller.getState().status, 'expired');
  deferred.resolve(policyResult(capturedTurn, createPatchDecision()));
  await Promise.resolve();
  assert.equal(kernel.getDraftRevision(), 0);
});

test('active-work inactivity stops once a preview is waiting for user review', async () => {
  const { controller } = createController({
    executePolicy: async (turn) => policyResult(turn, createPatchOrReadyDecision(turn)),
    limits: { maxInactivityMs: 10, maxWallTimeMs: 1_000 },
  });

  await controller.start();
  assert.equal(controller.getState().status, 'ready-for-preview');
  await waitForTimer(30);
  assert.equal(controller.getState().status, 'ready-for-preview');
  await controller.cancel();
});

test('preview review remains applyable after the automated-work wall-clock deadline', async () => {
  const { controller, getCommitCount } = createController({
    executePolicy: async (turn) => policyResult(turn, createPatchOrReadyDecision(turn)),
    limits: { maxInactivityMs: 10, maxWallTimeMs: 50 },
  });

  await controller.start();
  assert.equal(controller.getState().status, 'ready-for-preview');
  await waitForTimer(75);
  assert.equal(controller.getState().status, 'ready-for-preview');

  await controller.apply();
  assert.equal(controller.getState().status, 'committed');
  assert.equal(getCommitCount(), 1);
});

test('an abort-ignoring context read cannot keep the controller queue pending after expiry', async () => {
  const never = createDeferred<GraphBuilderReadResult>();
  const { controller } = createController({
    executePolicy: async (turn) =>
      policyResult(turn, {
        type: 'request-context',
        requests: [{ type: 'get-diagnostics' }],
      }),
    limits: { maxInactivityMs: 10, maxWallTimeMs: 1_000 },
    read: async () => await never.promise,
  });

  const started = controller.start();
  await waitForTimer(30);
  assert.equal(controller.getState().status, 'expired');
  assert.equal(await settlesWithin(started), true);
});

test('clarification inactivity expires without a second controller action', async () => {
  const { controller } = createController({
    executePolicy: async (turn) => policyResult(turn, { type: 'clarify', question: 'Which output format?' }),
    limits: { clarificationTtlMs: 10, maxWallTimeMs: 1_000 },
  });

  await controller.start();
  assert.equal(controller.getState().status, 'awaiting-user');
  await waitForTimer(30);
  assert.equal(controller.getState().status, 'expired');
});

test('failed provider usage is counted and takes budget precedence over the provider error', async () => {
  const metrics: GraphBuilderMetricsEvent[] = [];
  const { controller } = createController({
    executePolicy: async () => {
      throw Object.assign(new Error('provider failed'), {
        usage: {
          completeness: 'complete',
          inputTokens: 11,
          outputTokens: 2,
          costUsd: 0.5,
        },
      });
    },
    limits: { maxInputTokens: 10 },
    metricsSink: { record: (event) => metrics.push(event) },
  });

  await controller.start();
  assert.equal(controller.getState().status, 'budget-exhausted');
  assert.deepEqual(metrics, [
    {
      protocolVersion: GRAPH_BUILDER_METRICS_VERSION,
      outcome: 'budget-exhausted',
      durationMs: metrics[0]!.durationMs,
      policyAttempts: 1,
      repairAttempts: 0,
      inputTokens: 11,
      outputTokens: 2,
      costUsd: 0.5,
      usageCompleteness: 'complete',
    },
  ]);
});

test('a zero usage budget prevents the first provider request', async () => {
  let policyCalls = 0;
  const { controller } = createController({
    executePolicy: async (turn) => {
      policyCalls += 1;
      return policyResult(turn, createPatchDecision());
    },
    limits: { maxCostUsd: 0 },
  });

  await controller.start();
  assert.equal(controller.getState().status, 'budget-exhausted');
  assert.equal(policyCalls, 0);
});

test('synchronous preflight that crosses the hard deadline cannot reserve a provider attempt', async () => {
  let policyCalls = 0;
  const { controller } = createController({
    buildProjection: ({ draftRevision }) => {
      const stopAt = Date.now() + 20;
      while (Date.now() < stopAt) {
        // Deliberately occupy the event loop so the deadline timer cannot run.
      }
      return {
        protocolVersion: GRAPH_BUILDER_PROTOCOL_VERSION,
        projectId,
        graphId,
        draftRevision,
        nodes: [],
        connections: [],
        diagnostics: [],
      };
    },
    executePolicy: async (turn) => {
      policyCalls += 1;
      return policyResult(turn, createPatchDecision());
    },
    limits: { maxWallTimeMs: 5 },
  });

  await controller.start();
  assert.equal(controller.getState().status, 'expired');
  assert.equal(policyCalls, 0);
});

test('synchronous delta construction that crosses the hard deadline cannot publish a preview', async () => {
  const baseKernel = new FakeKernel();
  let deltaCalls = 0;
  const kernel: ConstructorParameters<typeof GraphBuilderSessionController>[0]['kernel'] = {
    applyDocumentPatch: (patch) => baseKernel.applyDocumentPatch(patch),
    replaceDocument: (patch) => baseKernel.replaceDocument(patch),
    getDraft: () => baseKernel.getDraft(),
    getDraftDelta: () => {
      deltaCalls += 1;
      if (deltaCalls === 2) {
        const stopAt = Date.now() + 130;
        while (Date.now() < stopAt) {
          // Deliberately occupy the final preview-construction boundary.
        }
      }
      return baseKernel.getDraftDelta();
    },
    getProjectDraftDelta: () => baseKernel.getProjectDraftDelta(),
    getDraftRevision: () => baseKernel.getDraftRevision(),
    hasDraftChanges: () => baseKernel.hasDraftChanges(),
  };
  const { controller } = createController({
    executePolicy: async (turn) => policyResult(turn, createPatchOrReadyDecision(turn)),
    kernel,
    limits: { maxWallTimeMs: 100 },
  });

  await controller.start();
  assert.equal(controller.getState().status, 'expired');
});

test('an exactly exhausted known usage budget prevents another provider request', async () => {
  let policyCalls = 0;
  const { controller } = createController({
    executePolicy: async (turn) => {
      policyCalls += 1;
      return {
        ...policyResult(turn, {
          type: 'request-context',
          requests: [{ type: 'get-diagnostics' }],
        }),
        usage: {
          completeness: 'complete',
          inputTokens: 10,
          outputTokens: 1,
          costUsd: 0.5,
        },
      };
    },
    limits: { maxInputTokens: 10 },
  });

  await controller.start();
  assert.equal(controller.getState().status, 'budget-exhausted');
  assert.equal(policyCalls, 1);
});

test('invalid-decision usage is counted before a repair attempt is scheduled', async () => {
  const metrics: GraphBuilderMetricsEvent[] = [];
  let policyCalls = 0;
  const { controller } = createController({
    executePolicy: async () => {
      policyCalls += 1;
      throw Object.assign(new Error('invalid JSON'), {
        code: 'invalid-decision',
        usage: {
          completeness: 'complete',
          inputTokens: 11,
          outputTokens: 2,
          costUsd: 0.5,
        },
      });
    },
    limits: { maxInputTokens: 10 },
    metricsSink: { record: (event) => metrics.push(event) },
  });

  await controller.start();
  assert.equal(controller.getState().status, 'budget-exhausted');
  assert.equal(policyCalls, 1);
  assert.deepEqual(metrics, [
    {
      protocolVersion: GRAPH_BUILDER_METRICS_VERSION,
      outcome: 'budget-exhausted',
      durationMs: metrics[0]!.durationMs,
      policyAttempts: 1,
      repairAttempts: 0,
      inputTokens: 11,
      outputTokens: 2,
      costUsd: 0.5,
      usageCompleteness: 'complete',
    },
  ]);
});

test('malformed successful usage fails closed and is reported as unavailable', async () => {
  const metrics: GraphBuilderMetricsEvent[] = [];
  const { controller, kernel } = createController({
    executePolicy: async (turn) => ({
      ...policyResult(turn, createPatchDecision()),
      usage: {
        completeness: 'complete',
        inputTokens: -1,
      } as GraphBuilderPolicyExecutionResult['usage'],
    }),
    metricsSink: { record: (event) => metrics.push(event) },
  });

  await controller.start();
  const state = controller.getState();
  assert.equal(state.status, 'failed');
  assert.equal(
    'result' in state && state.result.status === 'failed' ? state.result.failure.code : undefined,
    'invalid-policy-usage',
  );
  assert.equal(kernel.getDraftRevision(), 0);
  assert.equal(metrics[0]?.usageCompleteness, 'unavailable');
  assert.equal(metrics[0]?.failureCode, 'invalid-policy-usage');
});

test('token accounting rejects fractional or unsafe counts', async () => {
  for (const inputTokens of [1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const { controller } = createController({
      executePolicy: async (turn) => ({
        ...policyResult(turn, createPatchDecision()),
        usage: {
          completeness: 'complete',
          inputTokens,
          outputTokens: 1,
          costUsd: 0,
        },
      }),
    });

    await controller.start();
    const state = controller.getState();
    assert.equal(state.status, 'failed');
    assert.equal(
      state.status === 'failed' && state.result.status === 'failed' ? state.result.failure.code : undefined,
      'invalid-policy-usage',
    );
  }
});

test('invalid model decisions consume bounded controller-owned repair attempts', async () => {
  const phases: GraphBuilderPolicyTurn['phase'][] = [];
  let policyCalls = 0;
  const { controller } = createController({
    executePolicy: async (turn) => {
      phases.push(turn.phase);
      policyCalls += 1;
      if (policyCalls === 1) {
        throw Object.assign(new Error('invalid JSON'), {
          code: 'invalid-decision',
          usage: { completeness: 'unavailable' },
        });
      }
      return policyResult(turn, createPatchOrReadyDecision(turn));
    },
  });

  await controller.start();
  assert.equal(controller.getState().status, 'ready-for-preview');
  assert.equal(policyCalls, 3);
  assert.deepEqual(phases, ['gathering-context', 'repairing', 'reviewing']);
});

test('an applied edit resets the consecutive repair budget while retaining total repair accounting', async () => {
  const metrics: GraphBuilderMetricsEvent[] = [];
  let policyCalls = 0;
  const { controller } = createController({
    executePolicy: async (turn) => {
      policyCalls += 1;
      if (policyCalls === 1 || policyCalls === 3) {
        throw Object.assign(new Error('invalid JSON'), {
          code: 'invalid-decision',
          usage: { completeness: 'unavailable' },
        });
      }
      return policyResult(turn, createPatchOrReadyDecision(turn));
    },
    limits: { maxRepairAttempts: 1 },
    metricsSink: { record: (event) => metrics.push(event) },
  });

  await controller.start();
  assert.equal(controller.getState().status, 'ready-for-preview');
  assert.equal(policyCalls, 4);

  await controller.apply();
  assert.equal(controller.getState().status, 'committed');
  assert.equal(metrics[0]?.repairAttempts, 2);
});

test('invalid model decisions exhaust the repair budget without mutating the draft', async () => {
  let policyCalls = 0;
  const { controller, kernel } = createController({
    executePolicy: async () => {
      policyCalls += 1;
      throw Object.assign(new Error('invalid JSON'), {
        code: 'invalid-decision',
        usage: { completeness: 'unavailable' },
      });
    },
    limits: { maxRepairAttempts: 1 },
  });

  await controller.start();
  assert.equal(controller.getState().status, 'budget-exhausted');
  assert.equal(policyCalls, 2);
  assert.equal(kernel.getDraftRevision(), 0);
});

test('invalid terminal transitions provide a deterministic repair diagnostic', async () => {
  let policyCalls = 0;
  const { controller } = createController({
    executePolicy: async (turn) => {
      policyCalls += 1;
      if (policyCalls === 1) {
        return policyResult(turn, {
          type: 'ready',
          summary: 'Ready.',
        });
      }
      assert.ok(turn.diagnostics.some((diagnostic) => diagnostic.ruleId === 'ready-without-draft-changes'));
      return policyResult(turn, {
        type: 'no-change',
        summary: 'The graph already satisfies the request.',
      });
    },
  });

  await controller.start();
  assert.equal(controller.getState().status, 'no-change');
  assert.equal(policyCalls, 2);
});

test('final validation results are runtime-validated before preview', async () => {
  const { controller } = createController({
    executePolicy: async (turn) => policyResult(turn, createPatchOrReadyDecision(turn)),
    validateDraft: () =>
      ({
        completeness: 'complete',
        diagnostics: undefined,
        blockingDiagnosticKeys: [],
      }) as unknown as GraphValidationResult,
  });

  await controller.start();
  const state = controller.getState();
  assert.equal(state.status, 'failed');
  assert.equal(
    state.status === 'failed' && state.result.status === 'failed' ? state.result.failure.code : undefined,
    'validation-failed',
  );
});

test('deterministic preview summaries use exact totals when delta details are truncated', async () => {
  const kernel = new FakeKernel({
    graphId,
    addedNodeCount: 100,
    removedNodeCount: 0,
    updatedNodeCount: 0,
    addedConnectionCount: 99,
    removedConnectionCount: 0,
    truncated: true,
    addedNodes: [{ nodeId: 'created' as NodeId, type: 'text', title: 'Text' }],
    removedNodes: [],
    updatedNodes: [],
    addedConnections: [],
    removedConnections: [],
  });
  const { controller } = createController({
    kernel,
    executePolicy: async (turn) => {
      if (turn.draftRevision > 0) {
        return policyResult(turn, {
          type: 'ready',
          summary: 'Prepared 100 nodes added, 99 connections added.',
        });
      }
      return policyResult(turn, createPatchDecision(turn.draftRevision));
    },
  });

  await controller.start();
  const state = controller.getState();
  assert.equal(state.status, 'ready-for-preview');
  assert.equal(
    state.status === 'ready-for-preview' ? state.preview.summary : undefined,
    'Prepared 100 nodes added, 99 connections added.',
  );
});

test('read results must match the exact originating request ID and index', async () => {
  let policyCalls = 0;
  const { controller } = createController({
    executePolicy: async (turn) => {
      policyCalls += 1;
      return policyResult(
        turn,
        policyCalls === 1
          ? {
              type: 'request-context',
              requests: [{ type: 'get-diagnostics' }],
            }
          : createPatchOrReadyDecision(turn),
      );
    },
    read: async (_request, context) => ({
      requestId: `${context.requestId}:wrong`,
      requestIndex: context.requestIndex,
      observedDraftRevision: context.observedDraftRevision,
      status: 'ok',
      payload: null,
    }),
  });

  await controller.start();
  const state = controller.getState();
  assert.equal(state.status, 'failed');
  assert.equal(
    'result' in state && state.result.status === 'failed' ? state.result.failure.code : undefined,
    'mismatched-read-result',
  );
  assert.equal(policyCalls, 1);
});

test('malformed read results fail closed before another policy attempt', async () => {
  let policyCalls = 0;
  const { controller } = createController({
    executePolicy: async (turn) => {
      policyCalls += 1;
      return policyResult(turn, {
        type: 'request-context',
        requests: [{ type: 'get-diagnostics' }],
      });
    },
    read: async (_request, context) =>
      ({
        requestId: context.requestId,
        requestIndex: context.requestIndex,
        observedDraftRevision: context.observedDraftRevision,
        status: 'ok',
        payload: Number.NaN,
      }) as GraphBuilderReadResult,
  });

  await controller.start();
  const state = controller.getState();
  assert.equal(state.status, 'failed');
  assert.equal(
    'result' in state && state.result.status === 'failed' ? state.result.failure.code : undefined,
    'invalid-read-result',
  );
  assert.equal(policyCalls, 1);
});

test('oversized policy turns exhaust the preflight budget without calling the provider', async () => {
  const metrics: GraphBuilderMetricsEvent[] = [];
  let policyCalls = 0;
  const { controller } = createController({
    executePolicy: async (turn) => {
      policyCalls += 1;
      return policyResult(turn, createPatchDecision());
    },
    limits: { maxPolicyTurnBytes: 700, maxTranscriptBytes: 200 },
    metricsSink: { record: (event) => metrics.push(event) },
    request: 'x'.repeat(650),
  });

  await controller.start();
  assert.equal(controller.getState().status, 'budget-exhausted');
  assert.equal(policyCalls, 0);
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.policyAttempts, 0);
});

test('session limits reject unsafe timers and payload limits the policy transport cannot carry', () => {
  assert.throws(
    () =>
      createController({
        executePolicy: async (turn) => policyResult(turn, createPatchDecision()),
        limits: { maxWallTimeMs: 2_147_483_648 },
      }),
    /supported timer range/,
  );
  assert.throws(
    () =>
      createController({
        executePolicy: async (turn) => policyResult(turn, createPatchDecision()),
        limits: { maxPolicyTurnBytes: 300_000 },
      }),
    /portable protocol payload limit/,
  );
});

test('transcript compaction keeps a digest identity for every earlier decision and read', async () => {
  const turns: GraphBuilderPolicyTurn[] = [];
  let policyCalls = 0;
  const { controller } = createController({
    executePolicy: async (turn) => {
      turns.push(structuredClone(turn));
      policyCalls += 1;
      return policyResult(
        turn,
        policyCalls <= 4
          ? {
              type: 'request-context',
              requests: [{ type: 'get-diagnostics' }],
            }
          : createPatchOrReadyDecision(turn),
      );
    },
    limits: {
      maxPolicyTurnBytes: 20_000,
      maxTranscriptBytes: 2_400,
    },
    read: async (_request, context) => ({
      requestId: context.requestId,
      requestIndex: context.requestIndex,
      observedDraftRevision: context.observedDraftRevision,
      status: 'ok',
      payload: { content: 'x'.repeat(1_200) },
    }),
  });

  await controller.start();
  assert.equal(controller.getState().status, 'ready-for-preview');
  const finalTurn = turns.at(-1)!;
  assert.equal(finalTurn.contextMode, 'compacted');
  assert.equal(finalTurn.transcript.length, 10);
  assert.ok(finalTurn.transcript.some((item) => item.type === 'compacted'));
  for (const earlierTurn of turns.slice(0, -1)) {
    assert.equal(finalTurn.transcript.filter((item) => item.turnId === earlierTurn.turnId).length, 2);
  }
});

test('oversized clarification answers are rejected before another provider attempt', async () => {
  let policyCalls = 0;
  const { controller } = createController({
    executePolicy: async (turn) => {
      policyCalls += 1;
      return policyResult(turn, { type: 'clarify', question: 'Describe the format.' });
    },
  });

  await controller.start();
  const awaiting = controller.getState();
  assert.equal(awaiting.status, 'awaiting-user');
  if (awaiting.status !== 'awaiting-user') {
    return;
  }
  await controller.resume(awaiting.resumeToken, 'x'.repeat(16_385));
  const state = controller.getState();
  assert.equal(state.status, 'failed');
  assert.equal(
    'result' in state && state.result.status === 'failed' ? state.result.failure.code : undefined,
    'invalid-resume',
  );
  assert.equal(
    'result' in state && state.result.status === 'failed' ? state.result.failure.userMessage : undefined,
    `Clarification answers are limited to ${GRAPH_BUILDER_LIMITS.maxStringLength.toString(10)} characters.`,
  );
  assert.equal(policyCalls, 1);
});

test('oversized graph-building requests use an invariant failure message before provider execution', async () => {
  let policyCalls = 0;
  const { controller } = createController({
    executePolicy: async (turn) => {
      policyCalls += 1;
      return policyResult(turn, createPatchDecision());
    },
    request: 'x'.repeat(GRAPH_BUILDER_LIMITS.maxStringLength + 1),
  });

  await controller.start();
  const state = controller.getState();
  assert.equal(state.status, 'failed');
  assert.equal(
    'result' in state && state.result.status === 'failed' ? state.result.failure.code : undefined,
    'invalid-request',
  );
  assert.equal(
    'result' in state && state.result.status === 'failed' ? state.result.failure.userMessage : undefined,
    `Graph-building requests are limited to ${GRAPH_BUILDER_LIMITS.maxStringLength.toString(10)} characters.`,
  );
  assert.equal(policyCalls, 0);
});

test('metrics duration remains nonnegative when the host wall clock moves backward', async () => {
  const metrics: GraphBuilderMetricsEvent[] = [];
  const { controller } = createController({
    executePolicy: async (turn) => policyResult(turn, createPatchOrReadyDecision(turn)),
    metricsSink: { record: (event) => metrics.push(event) },
    request: 'x'.repeat(GRAPH_BUILDER_LIMITS.maxStringLength + 1),
  });
  const originalNow = Date.now;
  Date.now = () => 0;
  try {
    await controller.start();
  } finally {
    Date.now = originalNow;
  }

  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.durationMs, 0);
});

test('remaining wall-time never exceeds its configured budget when the host clock moves backward', async () => {
  const originalNow = Date.now;
  let observedRemainingMs: number | undefined;
  Date.now = () => 1_000;
  const { controller } = createController({
    executePolicy: async (turn) => {
      observedRemainingMs = turn.remainingBudget.milliseconds;
      return policyResult(turn, createPatchOrReadyDecision(turn));
    },
    limits: { maxWallTimeMs: 1_000 },
  });
  Date.now = () => 0;
  try {
    await controller.start();
    await controller.cancel();
  } finally {
    Date.now = originalNow;
  }

  assert.equal(observedRemainingMs, 1_000);
});
