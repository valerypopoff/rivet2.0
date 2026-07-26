import {
  type ChartNode,
  dataTypes,
  type DataType,
  type GraphId,
  type NodeConnection,
  type NodeId,
  type NodeInputDefinition,
  type NodeOutputDefinition,
  type PortId,
  type Project,
} from '@valerypopoff/rivet2-core';
import deepEqual from 'fast-deep-equal';
import { cloneDeep } from 'lodash-es';
import stableStringify from 'safe-stable-stringify';
import { authorizeGraphBuilderOperations, parseGraphBuilderAuthorizationScope } from './graphBuilderAuthorization.js';
import {
  canonicalGraphBuilderAuthoringStringify,
  canonicalGraphBuilderStringify,
  compareGraphBuilderStrings,
  graphBuilderStringTupleKey,
  hashCanonicalGraphBuilderValue,
  toBoundedGraphBuilderIdentifier,
} from './canonicalGraphBuilderValue.js';
import { GRAPH_BUILDER_LIMITS } from './graphBuilderLimits.js';
import {
  type ApplyPatchResult,
  type ConnectOperation,
  type CreateNodeOperation,
  type DeleteNodeOperation,
  type DisconnectOperation,
  type FreshApplyPatchResult,
  type GraphBuilderAuthorizationScope,
  type GraphBuilderConnectionDescriptor,
  type GraphBuilderNodePrecondition,
  type GraphBuilderNodeReference,
  type GraphBuilderTouchedScope,
  type GraphDiagnostic,
  type GraphDraftDelta,
  type GraphPatch,
  type GraphPatchOperation,
  type GraphValidationResult,
  parseGraphPatch,
  parseGraphValidationResult,
  type UpdateNodeEnvelopeOperation,
  type UpdateNodeSettingsOperation,
} from './graphBuilderSchemas.js';
import { parsePortableJson, type PortableJsonValue } from './portableJson.js';

export type GraphBuilderAuthoringProject = Omit<Project, 'data'>;

export type GraphBuilderProjectDataContext = {
  manifest: {
    id: string;
    digest: string;
    metadata: PortableJsonValue;
  }[];
};

export type GraphBuilderResolvedNodePorts = {
  inputs: readonly (Pick<NodeInputDefinition, 'id' | 'dataType'> & {
    allowsMultipleConnections?: boolean;
  })[];
  outputs: readonly Pick<NodeOutputDefinition, 'id' | 'dataType'>[];
};

export type GraphBuilderNormalizationResult = {
  project: GraphBuilderAuthoringProject;
};

export interface GraphBuilderAuthoringSemantics {
  createNodeFromAuthoringChoice(input: {
    operation: CreateNodeOperation;
    allocatedNodeId: NodeId;
    project: GraphBuilderAuthoringProject;
  }): ChartNode;
  applyNodeSettings(input: {
    operation: UpdateNodeSettingsOperation;
    node: ChartNode;
    project: GraphBuilderAuthoringProject;
  }): ChartNode;
  resolvePorts(input: {
    graphId: GraphId;
    nodeId: NodeId;
    project: GraphBuilderAuthoringProject;
  }): GraphBuilderResolvedNodePorts;
  validateConnection(input: {
    graphId: GraphId;
    connection: NodeConnection;
    project: GraphBuilderAuthoringProject;
    touchedScope: GraphBuilderTouchedScope;
  }): GraphValidationResult;
  normalizeCandidate(input: {
    base: GraphBuilderAuthoringProject;
    project: GraphBuilderAuthoringProject;
    createdNodeIds: readonly NodeId[];
    touchedScope: GraphBuilderTouchedScope;
  }): GraphBuilderNormalizationResult;
  validateCandidate(input: {
    base: GraphBuilderAuthoringProject;
    candidate: GraphBuilderAuthoringProject;
    touchedScope: GraphBuilderTouchedScope;
  }): GraphValidationResult;
}

export type GraphBuilderTransactionKernelOptions = {
  project: GraphBuilderAuthoringProject;
  activeGraphId: GraphId;
  authorization: GraphBuilderAuthorizationScope;
  semantics: GraphBuilderAuthoringSemantics;
  idGenerator: () => NodeId;
  initialDraftRevision?: number;
};

type PatchLedgerEntry = {
  canonicalPatch: string;
  proposalHash: string;
  result: FreshApplyPatchResult;
};

type MutableTouchedScope = {
  graphIds: Set<string>;
  nodeIds: Set<string>;
  connectionKeys: Set<string>;
  operationIndices: Set<number>;
};

type ApplyContext = {
  candidate: GraphBuilderAuthoringProject;
  createdNodeIds: Map<string, NodeId>;
  settingUpdatedNodeIds: Set<NodeId>;
  createdNodeIdSet: Set<NodeId>;
  touched: MutableTouchedScope;
};

export class GraphBuilderProtocolError extends Error {
  readonly code:
    | 'invalid-patch'
    | 'patch-identity-content-mismatch'
    | 'invalid-authoring-project'
    | 'invalid-authoring-result';

  constructor(code: GraphBuilderProtocolError['code'], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GraphBuilderProtocolError';
    this.code = code;
  }
}

class OperationRejectedError extends Error {
  readonly diagnostics: GraphDiagnostic[];

  constructor(diagnostics: GraphDiagnostic[]) {
    super(diagnostics[0]?.message ?? 'Graph Builder operation was rejected.');
    this.name = 'OperationRejectedError';
    this.diagnostics = diagnostics;
  }
}

function stableSerialize(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }
  const serialized = stableStringify(value);
  if (serialized === undefined) {
    throw new GraphBuilderProtocolError('invalid-authoring-project', 'Authoring project is not serializable.');
  }
  return serialized;
}

function areStructurallyEqual(left: unknown, right: unknown): boolean {
  return deepEqual(left, right) && stableSerialize(left) === stableSerialize(right);
}

function connectionDescriptor(connection: NodeConnection): GraphBuilderConnectionDescriptor {
  return {
    outputNodeId: connection.outputNodeId,
    outputId: connection.outputId,
    inputNodeId: connection.inputNodeId,
    inputId: connection.inputId,
  };
}

function connectionKey(connection: GraphBuilderConnectionDescriptor): string {
  return graphBuilderStringTupleKey(
    connection.outputNodeId,
    connection.outputId,
    connection.inputNodeId,
    connection.inputId,
  );
}

const graphBuilderDataTypes = new Set<string>(dataTypes);

function isBoundedIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= GRAPH_BUILDER_LIMITS.maxIdentifierLength &&
    value.trim() === value
  );
}

function parseResolvedDataType(value: PortableJsonValue | undefined): DataType | readonly DataType[] {
  const values = Array.isArray(value) ? value : [value];
  if (
    values.length === 0 ||
    values.some((entry) => typeof entry !== 'string' || !graphBuilderDataTypes.has(entry)) ||
    new Set(values).size !== values.length
  ) {
    throw new Error('Port data types must be non-empty, known, and unique.');
  }
  return (Array.isArray(value) ? [...values] : values[0]!) as DataType | readonly DataType[];
}

function parseResolvedPorts(value: unknown): GraphBuilderResolvedNodePorts {
  const parsed = parsePortableJson(value);
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('Invalid ports result.');
  }
  if (!Array.isArray(parsed.inputs) || !Array.isArray(parsed.outputs)) {
    throw new Error('Invalid ports result.');
  }

  const inputIds = new Set<string>();
  const outputIds = new Set<string>();
  const inputs = parsed.inputs.map((rawPort) => {
    if (rawPort === null || Array.isArray(rawPort) || typeof rawPort !== 'object') {
      throw new Error('Invalid input port result.');
    }
    if (!isBoundedIdentifier(rawPort.id) || inputIds.has(rawPort.id)) {
      throw new Error('Input port IDs must be non-empty, bounded, trimmed, and unique.');
    }
    inputIds.add(rawPort.id);
    const allowsMultipleConnections = rawPort.allowsMultipleConnections;
    if (allowsMultipleConnections !== undefined && typeof allowsMultipleConnections !== 'boolean') {
      throw new Error('Input port multiplicity must be a boolean.');
    }
    return {
      id: rawPort.id as PortId,
      dataType: parseResolvedDataType(rawPort.dataType),
      ...(allowsMultipleConnections === undefined ? {} : { allowsMultipleConnections }),
    };
  });
  const outputs = parsed.outputs.map((rawPort) => {
    if (rawPort === null || Array.isArray(rawPort) || typeof rawPort !== 'object') {
      throw new Error('Invalid output port result.');
    }
    if (!isBoundedIdentifier(rawPort.id) || outputIds.has(rawPort.id)) {
      throw new Error('Output port IDs must be non-empty, bounded, trimmed, and unique.');
    }
    outputIds.add(rawPort.id);
    return {
      id: rawPort.id as PortId,
      dataType: parseResolvedDataType(rawPort.dataType),
    };
  });

  return { inputs, outputs };
}

function endpointConnection(
  operation: ConnectOperation | DisconnectOperation,
  resolve: (ref: GraphBuilderNodeReference) => NodeId,
) {
  return {
    outputNodeId: resolve(operation.from.node),
    outputId: operation.from.port as PortId,
    inputNodeId: resolve(operation.to.node),
    inputId: operation.to.port as PortId,
  } satisfies NodeConnection;
}

function createDiagnostic(input: {
  key: string;
  ruleId: string;
  message: string;
  graphId?: GraphId;
  nodeId?: NodeId;
  clientId?: string;
  portId?: PortId;
  operationIndex?: number;
  expected?: unknown;
  actual?: unknown;
  repairHint?: string;
}): GraphDiagnostic {
  return {
    diagnosticKey: toBoundedGraphBuilderIdentifier(input.key),
    ruleId: input.ruleId,
    rulesVersion: 'graph-builder-domain-v1',
    severity: 'error',
    verification: 'verified',
    message: input.message,
    ...(input.graphId === undefined ? {} : { graphId: input.graphId }),
    ...(input.nodeId === undefined ? {} : { nodeId: input.nodeId }),
    ...(input.clientId === undefined ? {} : { clientId: input.clientId }),
    ...(input.portId === undefined ? {} : { portId: input.portId }),
    ...(input.operationIndex === undefined ? {} : { operationIndex: input.operationIndex }),
    ...(input.expected === undefined ? {} : { expected: parsePortableJson(input.expected) }),
    ...(input.actual === undefined ? {} : { actual: parsePortableJson(input.actual) }),
    ...(input.repairHint === undefined ? {} : { repairHint: input.repairHint }),
  };
}

function sortDiagnostics(diagnostics: readonly GraphDiagnostic[]): GraphDiagnostic[] {
  return [...diagnostics].sort((left, right) => {
    const leftKey = graphBuilderStringTupleKey(
      left.ruleId,
      left.graphId ?? '',
      left.nodeId ?? '',
      left.portId ?? '',
      left.settingPath ?? '',
      left.severity,
      left.diagnosticKey,
    );
    const rightKey = graphBuilderStringTupleKey(
      right.ruleId,
      right.graphId ?? '',
      right.nodeId ?? '',
      right.portId ?? '',
      right.settingPath ?? '',
      right.severity,
      right.diagnosticKey,
    );
    return compareGraphBuilderStrings(leftKey, rightKey);
  });
}

function toTouchedScope(touched: MutableTouchedScope): GraphBuilderTouchedScope {
  return {
    graphIds: [...touched.graphIds].sort(),
    nodeIds: [...touched.nodeIds].sort(),
    connectionKeys: [...touched.connectionKeys].sort(),
    operationIndices: [...touched.operationIndices].sort((left, right) => left - right),
  };
}

function findNode(project: GraphBuilderAuthoringProject, graphId: GraphId, nodeId: NodeId): ChartNode | undefined {
  return Object.hasOwn(project.graphs, graphId)
    ? project.graphs[graphId]?.nodes.find((node) => node.id === nodeId)
    : undefined;
}

function getActiveGraph(project: GraphBuilderAuthoringProject, graphId: GraphId) {
  const graph = Object.hasOwn(project.graphs, graphId) ? project.graphs[graphId] : undefined;
  if (!graph) {
    throw new GraphBuilderProtocolError(
      'invalid-authoring-project',
      `Active graph "${graphId}" does not exist in the authoring project.`,
    );
  }
  return graph;
}

function getChangedPaths(before: unknown, after: unknown, prefix = ''): string[] {
  if (areStructurallyEqual(before, after)) {
    return [];
  }

  if (
    before === null ||
    after === null ||
    typeof before !== 'object' ||
    typeof after !== 'object' ||
    Array.isArray(before) !== Array.isArray(after)
  ) {
    return [prefix || '*'];
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length !== after.length) {
      return [prefix || '*'];
    }
    return before.flatMap((value, index) => getChangedPaths(value, after[index], `${prefix}[${index}]`));
  }

  const beforeObject = before as Record<string, unknown>;
  const afterObject = after as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(beforeObject), ...Object.keys(afterObject)])].sort();
  return keys.flatMap((key) =>
    getChangedPaths(beforeObject[key], afterObject[key], prefix.length === 0 ? key : `${prefix}.${key}`),
  );
}

function describeNode(node: ChartNode) {
  return {
    nodeId: node.id,
    type: node.type,
    title:
      node.title.length <= GRAPH_BUILDER_LIMITS.maxDeltaNodeTitleLength
        ? node.title
        : `${node.title.slice(0, GRAPH_BUILDER_LIMITS.maxDeltaNodeTitleLength - 1)}…`,
  };
}

function calculateConnectionDelta(
  before: readonly NodeConnection[],
  after: readonly NodeConnection[],
): {
  added: GraphBuilderConnectionDescriptor[];
  removed: GraphBuilderConnectionDescriptor[];
} {
  const remainingBefore = before.map(connectionDescriptor);
  const added: GraphBuilderConnectionDescriptor[] = [];

  for (const connection of after.map(connectionDescriptor)) {
    const index = remainingBefore.findIndex((candidate) => connectionKey(candidate) === connectionKey(connection));
    if (index >= 0) {
      remainingBefore.splice(index, 1);
    } else {
      added.push(connection);
    }
  }

  return { added, removed: remainingBefore };
}

export function calculateGraphBuilderDraftDelta(
  before: GraphBuilderAuthoringProject,
  after: GraphBuilderAuthoringProject,
  graphId: GraphId,
): GraphDraftDelta {
  const beforeGraph = getActiveGraph(before, graphId);
  const afterGraph = getActiveGraph(after, graphId);
  const beforeNodes = new Map(beforeGraph.nodes.map((node) => [node.id, node]));
  const afterNodes = new Map(afterGraph.nodes.map((node) => [node.id, node]));

  const allAddedNodes = afterGraph.nodes.filter((node) => !beforeNodes.has(node.id)).map(describeNode);
  const allRemovedNodes = beforeGraph.nodes.filter((node) => !afterNodes.has(node.id)).map(describeNode);
  const allUpdatedNodes = afterGraph.nodes.flatMap((node) => {
    const previousNode = beforeNodes.get(node.id);
    if (!previousNode) {
      return [];
    }
    const changedFields = getChangedPaths(previousNode, node);
    return changedFields.length === 0
      ? []
      : [
          {
            ...describeNode(node),
            changedFields: changedFields
              .slice(0, 128)
              .map((path) =>
                path.length <= GRAPH_BUILDER_LIMITS.maxSettingPathLength
                  ? path
                  : `${path.slice(0, 470)}:${hashCanonicalGraphBuilderValue(path)}`,
              ),
          },
        ];
  });
  const connectionDelta = calculateConnectionDelta(beforeGraph.connections, afterGraph.connections);
  const limit = GRAPH_BUILDER_LIMITS.maxDeltaEntriesPerKind;

  return {
    graphId,
    addedNodeCount: allAddedNodes.length,
    removedNodeCount: allRemovedNodes.length,
    updatedNodeCount: allUpdatedNodes.length,
    addedConnectionCount: connectionDelta.added.length,
    removedConnectionCount: connectionDelta.removed.length,
    truncated:
      allAddedNodes.length > limit ||
      allRemovedNodes.length > limit ||
      allUpdatedNodes.length > limit ||
      connectionDelta.added.length > limit ||
      connectionDelta.removed.length > limit,
    addedNodes: allAddedNodes.slice(0, limit),
    removedNodes: allRemovedNodes.slice(0, limit),
    updatedNodes: allUpdatedNodes.slice(0, limit),
    addedConnections: connectionDelta.added.slice(0, limit),
    removedConnections: connectionDelta.removed.slice(0, limit),
  };
}

function isEmptyDelta(delta: GraphDraftDelta): boolean {
  return (
    (delta.addedNodeCount ?? delta.addedNodes.length) === 0 &&
    (delta.removedNodeCount ?? delta.removedNodes.length) === 0 &&
    (delta.updatedNodeCount ?? delta.updatedNodes.length) === 0 &&
    (delta.addedConnectionCount ?? delta.addedConnections.length) === 0 &&
    (delta.removedConnectionCount ?? delta.removedConnections.length) === 0
  );
}

function withoutActiveGraph(project: GraphBuilderAuthoringProject, activeGraphId: GraphId): unknown {
  const { graphs, ...rest } = project;
  return {
    ...rest,
    graphs: Object.fromEntries(Object.entries(graphs).filter(([graphId]) => graphId !== activeGraphId)),
  };
}

function withoutNodeData(node: ChartNode): unknown {
  const { data: _data, ...rest } = node;
  return rest;
}

function validateNormalizationEffectClosure(input: {
  beforeNormalization: GraphBuilderAuthoringProject;
  afterNormalization: GraphBuilderAuthoringProject;
  activeGraphId: GraphId;
  dataMutableNodeIds: ReadonlySet<NodeId>;
  positionMutableNodeIds: ReadonlySet<NodeId>;
}): GraphDiagnostic[] {
  const diagnostics: GraphDiagnostic[] = [];
  if (
    !areStructurallyEqual(
      withoutActiveGraph(input.beforeNormalization, input.activeGraphId),
      withoutActiveGraph(input.afterNormalization, input.activeGraphId),
    )
  ) {
    diagnostics.push(
      createDiagnostic({
        key: 'normalization:cross-graph-effect',
        ruleId: 'normalization-effect-closure',
        graphId: input.activeGraphId,
        message: 'Candidate normalization attempted to change project state outside the active graph.',
      }),
    );
    return diagnostics;
  }

  const beforeGraph = getActiveGraph(input.beforeNormalization, input.activeGraphId);
  const afterGraph = getActiveGraph(input.afterNormalization, input.activeGraphId);
  if (!areStructurallyEqual(beforeGraph.metadata, afterGraph.metadata)) {
    diagnostics.push(
      createDiagnostic({
        key: 'normalization:graph-metadata-effect',
        ruleId: 'normalization-effect-closure',
        graphId: input.activeGraphId,
        message: 'Candidate normalization attempted to change graph metadata.',
      }),
    );
  }
  if (!areStructurallyEqual(beforeGraph.connections, afterGraph.connections)) {
    diagnostics.push(
      createDiagnostic({
        key: 'normalization:connection-effect',
        ruleId: 'normalization-effect-closure',
        graphId: input.activeGraphId,
        message: 'Candidate normalization attempted an undeclared connection change.',
      }),
    );
  }

  const beforeIds = beforeGraph.nodes.map((node) => node.id);
  const afterIds = afterGraph.nodes.map((node) => node.id);
  if (!areStructurallyEqual(beforeIds, afterIds)) {
    diagnostics.push(
      createDiagnostic({
        key: 'normalization:node-identity-effect',
        ruleId: 'normalization-effect-closure',
        graphId: input.activeGraphId,
        message: 'Candidate normalization attempted to add, remove, reorder, or replace a node.',
      }),
    );
    return diagnostics;
  }

  beforeGraph.nodes.forEach((beforeNode, index) => {
    const afterNode = afterGraph.nodes[index]!;
    if (areStructurallyEqual(beforeNode, afterNode)) {
      return;
    }

    const { data: beforeData, visualData: beforeVisualData, ...beforeEnvelope } = beforeNode;
    const { data: afterData, visualData: afterVisualData, ...afterEnvelope } = afterNode;
    const { x: beforeX, y: beforeY, ...beforeVisualEnvelope } = beforeVisualData;
    const { x: afterX, y: afterY, ...afterVisualEnvelope } = afterVisualData;

    if (
      !areStructurallyEqual(beforeEnvelope, afterEnvelope) ||
      !areStructurallyEqual(beforeVisualEnvelope, afterVisualEnvelope)
    ) {
      diagnostics.push(
        createDiagnostic({
          key: `normalization:unauthorized-node-envelope:${beforeNode.id}`,
          ruleId: 'normalization-effect-closure',
          graphId: input.activeGraphId,
          nodeId: beforeNode.id,
          message: 'Candidate normalization changed a host-owned node field outside node data and position.',
        }),
      );
    }
    if (!input.dataMutableNodeIds.has(beforeNode.id) && !areStructurallyEqual(beforeData, afterData)) {
      diagnostics.push(
        createDiagnostic({
          key: `normalization:unauthorized-node-data:${beforeNode.id}`,
          ruleId: 'normalization-effect-closure',
          graphId: input.activeGraphId,
          nodeId: beforeNode.id,
          message: 'Candidate normalization changed node data outside the operation effect closure.',
        }),
      );
    }
    if (
      !input.positionMutableNodeIds.has(beforeNode.id) &&
      (!Object.is(beforeX, afterX) || !Object.is(beforeY, afterY))
    ) {
      diagnostics.push(
        createDiagnostic({
          key: `normalization:unauthorized-node-position:${beforeNode.id}`,
          ruleId: 'normalization-effect-closure',
          graphId: input.activeGraphId,
          nodeId: beforeNode.id,
          message: 'Candidate normalization repositioned a node that was not created by this patch.',
        }),
      );
    }
    if (
      !Number.isFinite(afterX) ||
      !Number.isFinite(afterY) ||
      Math.abs(afterX) > Number.MAX_SAFE_INTEGER ||
      Math.abs(afterY) > Number.MAX_SAFE_INTEGER
    ) {
      diagnostics.push(
        createDiagnostic({
          key: `normalization:invalid-node-position:${beforeNode.id}`,
          ruleId: 'normalization-effect-closure',
          graphId: input.activeGraphId,
          nodeId: beforeNode.id,
          message: 'Candidate normalization produced an invalid node position.',
        }),
      );
    }
  });

  return diagnostics;
}

function assertNodeResultPortable(node: ChartNode): void {
  canonicalGraphBuilderAuthoringStringify(node);
  if (
    !node ||
    typeof node !== 'object' ||
    typeof node.type !== 'string' ||
    node.type.length === 0 ||
    node.type.length > GRAPH_BUILDER_LIMITS.maxIdentifierLength ||
    node.type.trim() !== node.type ||
    typeof node.title !== 'string' ||
    node.title.length > GRAPH_BUILDER_LIMITS.maxStringLength
  ) {
    throw new GraphBuilderProtocolError('invalid-authoring-result', 'Authoring adapter returned an invalid node.');
  }
  if (
    !node.visualData ||
    !Number.isFinite(node.visualData.x) ||
    !Number.isFinite(node.visualData.y) ||
    Math.abs(node.visualData.x) > Number.MAX_SAFE_INTEGER ||
    Math.abs(node.visualData.y) > Number.MAX_SAFE_INTEGER
  ) {
    throw new GraphBuilderProtocolError(
      'invalid-authoring-result',
      'Authoring adapter returned invalid node visual data.',
    );
  }
  parsePortableJson(node.data);
}

function ensureUniqueNodeIds(project: GraphBuilderAuthoringProject, graphId: GraphId): GraphDiagnostic[] {
  const seen = new Set<NodeId>();
  const duplicateIds = new Set<NodeId>();
  for (const node of getActiveGraph(project, graphId).nodes) {
    if (seen.has(node.id)) {
      duplicateIds.add(node.id);
    }
    seen.add(node.id);
  }
  return [...duplicateIds].map((nodeId) =>
    createDiagnostic({
      key: `node-id:duplicate:${nodeId}`,
      ruleId: 'node-id-uniqueness',
      graphId,
      nodeId,
      message: `Node ID "${nodeId}" is not unique in the active graph.`,
    }),
  );
}

function validatePrecondition(
  node: ChartNode,
  precondition: GraphBuilderNodePrecondition | undefined,
  graphId: GraphId,
  operationIndex: number,
): void {
  if (!precondition) {
    return;
  }

  const checks: [keyof GraphBuilderNodePrecondition, unknown][] = [
    ['type', node.type],
    ['title', node.title],
    ['disabled', node.disabled ?? false],
    ['isConditional', node.isConditional ?? false],
    ['isSplitRun', node.isSplitRun ?? false],
    ['splitRunMax', node.splitRunMax ?? null],
  ];

  for (const [field, actual] of checks) {
    const expected = precondition[field];
    if (expected !== undefined && !Object.is(expected, actual)) {
      throw new OperationRejectedError([
        createDiagnostic({
          key: `precondition:${operationIndex}:${node.id}:${field}`,
          ruleId: 'operation-precondition',
          graphId,
          nodeId: node.id,
          operationIndex,
          expected,
          actual,
          message: `Node precondition for "${field}" did not match the current draft.`,
        }),
      ]);
    }
  }
}

export class GraphBuilderTransactionKernel {
  readonly #activeGraphId: GraphId;
  readonly #authorization: GraphBuilderAuthorizationScope;
  readonly #semantics: GraphBuilderAuthoringSemantics;
  readonly #idGenerator: () => NodeId;
  readonly #ledger = new Map<string, PatchLedgerEntry>();
  readonly #base: GraphBuilderAuthoringProject;
  readonly #baseCanonicalIdentity: string;
  #draft: GraphBuilderAuthoringProject;
  #draftRevision: number;

  constructor(options: GraphBuilderTransactionKernelOptions) {
    if (!isBoundedIdentifier(options.activeGraphId)) {
      throw new GraphBuilderProtocolError('invalid-authoring-project', 'Active graph ID is invalid.');
    }
    if (
      options.initialDraftRevision !== undefined &&
      (!Number.isSafeInteger(options.initialDraftRevision) || options.initialDraftRevision < 0)
    ) {
      throw new GraphBuilderProtocolError(
        'invalid-authoring-project',
        'Initial draft revision must be a non-negative safe integer.',
      );
    }
    if (!options.project || typeof options.project !== 'object' || Array.isArray(options.project)) {
      throw new GraphBuilderProtocolError('invalid-authoring-project', 'Graph Builder authoring project is invalid.');
    }
    let baseCanonicalIdentity: string;
    try {
      baseCanonicalIdentity = canonicalGraphBuilderAuthoringStringify(options.project);
    } catch (cause) {
      throw new GraphBuilderProtocolError(
        'invalid-authoring-project',
        'Graph Builder authoring project is not data-only and serializable.',
        { cause },
      );
    }
    if (Object.hasOwn(options.project, 'data')) {
      throw new GraphBuilderProtocolError(
        'invalid-authoring-project',
        'Graph Builder authoring projects must not contain project dataset payloads.',
      );
    }
    this.#base = cloneDeep(options.project);
    getActiveGraph(this.#base, options.activeGraphId);
    this.#draft = cloneDeep(this.#base);
    this.#baseCanonicalIdentity = baseCanonicalIdentity;
    this.#activeGraphId = options.activeGraphId;
    this.#authorization = parseGraphBuilderAuthorizationScope(options.authorization);
    this.#semantics = options.semantics;
    this.#idGenerator = options.idGenerator;
    this.#draftRevision = options.initialDraftRevision ?? 0;
  }

  getDraft(): GraphBuilderAuthoringProject {
    return cloneDeep(this.#draft);
  }

  getDraftRevision(): number {
    return this.#draftRevision;
  }

  hasDraftChanges(): boolean {
    return canonicalGraphBuilderAuthoringStringify(this.#draft) !== this.#baseCanonicalIdentity;
  }

  getDraftDelta(): GraphDraftDelta {
    return calculateGraphBuilderDraftDelta(this.#base, this.#draft, this.#activeGraphId);
  }

  applyPatch(rawPatch: GraphPatch): ApplyPatchResult {
    let patch: GraphPatch;
    try {
      patch = parseGraphPatch(rawPatch);
    } catch (cause) {
      throw new GraphBuilderProtocolError('invalid-patch', 'GraphPatch failed strict runtime validation.', {
        cause,
      });
    }

    const canonicalPatch = canonicalGraphBuilderStringify(patch);
    const proposal = { protocolVersion: patch.protocolVersion, operations: patch.operations };
    const proposalHash = hashCanonicalGraphBuilderValue(proposal);
    const previousEntry = this.#ledger.get(patch.patchId);
    if (previousEntry) {
      if (previousEntry.canonicalPatch !== canonicalPatch) {
        throw new GraphBuilderProtocolError(
          'patch-identity-content-mismatch',
          `Patch ID "${patch.patchId}" was reused with different canonical content.`,
        );
      }
      return {
        disposition: 'replayed',
        patchId: patch.patchId,
        proposalHash: previousEntry.proposalHash,
        original: cloneDeep(previousEntry.result),
      };
    }

    const result = this.#applyFreshPatch(patch, proposalHash);
    this.#ledger.set(patch.patchId, {
      canonicalPatch,
      proposalHash,
      result: cloneDeep(result),
    });
    return result;
  }

  #applyFreshPatch(patch: GraphPatch, proposalHash: string): FreshApplyPatchResult {
    if (patch.expectedDraftRevision !== this.#draftRevision) {
      return this.#rejectedResult(patch, proposalHash, [
        createDiagnostic({
          key: `draft-revision:${patch.patchId}`,
          ruleId: 'expected-draft-revision',
          graphId: this.#activeGraphId,
          expected: patch.expectedDraftRevision,
          actual: this.#draftRevision,
          message: 'Patch was proposed against a stale draft revision.',
        }),
      ]);
    }

    const authorizationFailures = authorizeGraphBuilderOperations({
      activeGraphId: this.#activeGraphId,
      operations: patch.operations,
      scope: this.#authorization,
    });
    if (authorizationFailures.length > 0) {
      return this.#rejectedResult(
        patch,
        proposalHash,
        authorizationFailures.map((failure, index) =>
          createDiagnostic({
            key: `authorization:${failure.code}:${failure.operationIndex ?? index}`,
            ruleId: failure.code,
            graphId: this.#activeGraphId,
            operationIndex: failure.operationIndex,
            message: failure.message,
          }),
        ),
      );
    }

    const context: ApplyContext = {
      candidate: cloneDeep(this.#draft),
      createdNodeIds: new Map(),
      settingUpdatedNodeIds: new Set(),
      createdNodeIdSet: new Set(),
      touched: {
        graphIds: new Set([this.#activeGraphId]),
        nodeIds: new Set(),
        connectionKeys: new Set(),
        operationIndices: new Set(),
      },
    };

    try {
      patch.operations.forEach((operation, operationIndex) => {
        context.touched.operationIndices.add(operationIndex);
        this.#applyOperation(context, operation, operationIndex);
      });
    } catch (error) {
      if (error instanceof OperationRejectedError) {
        return this.#rejectedResult(patch, proposalHash, error.diagnostics);
      }
      return this.#rejectedResult(patch, proposalHash, [
        createDiagnostic({
          key: `operation:adapter-failure:${context.touched.operationIndices.size - 1}`,
          ruleId: 'authoring-adapter-failure',
          graphId: this.#activeGraphId,
          operationIndex: context.touched.operationIndices.size - 1,
          message: 'The captured authoring adapter failed while applying an operation.',
        }),
      ]);
    }

    const duplicateNodeDiagnostics = ensureUniqueNodeIds(context.candidate, this.#activeGraphId);
    if (duplicateNodeDiagnostics.length > 0) {
      return this.#rejectedResult(patch, proposalHash, duplicateNodeDiagnostics);
    }

    const touchedScope = toTouchedScope(context.touched);
    const beforeNormalization = cloneDeep(context.candidate);
    let normalizedProject: GraphBuilderAuthoringProject;
    try {
      const normalization = this.#semantics.normalizeCandidate({
        base: cloneDeep(this.#draft),
        project: cloneDeep(context.candidate),
        createdNodeIds: [...context.createdNodeIdSet],
        touchedScope,
      });
      canonicalGraphBuilderAuthoringStringify(normalization);
      if (
        !normalization ||
        typeof normalization !== 'object' ||
        Array.isArray(normalization) ||
        !Object.hasOwn(normalization, 'project') ||
        !normalization.project ||
        typeof normalization.project !== 'object' ||
        Array.isArray(normalization.project) ||
        Object.hasOwn(normalization.project, 'data')
      ) {
        throw new Error('Normalization did not return an authoring project.');
      }
      normalizedProject = cloneDeep(normalization.project);
    } catch {
      return this.#rejectedResult(patch, proposalHash, [
        createDiagnostic({
          key: `normalization:failed:${patch.patchId}`,
          ruleId: 'candidate-normalization',
          graphId: this.#activeGraphId,
          message: 'Candidate normalization failed closed.',
        }),
      ]);
    }

    const effectDiagnostics = validateNormalizationEffectClosure({
      beforeNormalization,
      afterNormalization: normalizedProject,
      activeGraphId: this.#activeGraphId,
      dataMutableNodeIds: context.settingUpdatedNodeIds,
      positionMutableNodeIds: context.createdNodeIdSet,
    });
    if (effectDiagnostics.length > 0) {
      return this.#rejectedResult(
        patch,
        proposalHash,
        effectDiagnostics,
        calculateGraphBuilderDraftDelta(this.#draft, normalizedProject, this.#activeGraphId),
      );
    }

    const normalizedIdDiagnostics = ensureUniqueNodeIds(normalizedProject, this.#activeGraphId);
    if (normalizedIdDiagnostics.length > 0) {
      return this.#rejectedResult(patch, proposalHash, normalizedIdDiagnostics);
    }

    let validation: GraphValidationResult;
    try {
      validation = parseGraphValidationResult(
        this.#semantics.validateCandidate({
          base: cloneDeep(this.#draft),
          candidate: cloneDeep(normalizedProject),
          touchedScope,
        }),
      );
    } catch {
      return this.#rejectedResult(patch, proposalHash, [
        createDiagnostic({
          key: `validation:failed:${patch.patchId}`,
          ruleId: 'candidate-validation',
          graphId: this.#activeGraphId,
          message: 'Mandatory candidate validation failed closed.',
        }),
      ]);
    }

    const diagnostics = sortDiagnostics(validation.diagnostics);
    if (validation.completeness !== 'complete') {
      diagnostics.push(
        createDiagnostic({
          key: `validation:incomplete:${patch.patchId}`,
          ruleId: 'candidate-validation-completeness',
          graphId: this.#activeGraphId,
          message: 'Mandatory validation did not complete for the touched scope.',
        }),
      );
    }
    if (validation.completeness !== 'complete' || validation.blockingDiagnosticKeys.length > 0) {
      return this.#rejectedResult(
        patch,
        proposalHash,
        sortDiagnostics(diagnostics),
        calculateGraphBuilderDraftDelta(this.#draft, normalizedProject, this.#activeGraphId),
      );
    }

    const delta = calculateGraphBuilderDraftDelta(this.#draft, normalizedProject, this.#activeGraphId);
    if (isEmptyDelta(delta) && areStructurallyEqual(this.#draft, normalizedProject)) {
      return {
        disposition: 'no-op',
        patchId: patch.patchId,
        proposalHash,
        draftRevision: this.#draftRevision,
        delta,
        diagnostics,
      };
    }

    const previousDraftRevision = this.#draftRevision;
    this.#draft = normalizedProject;
    this.#draftRevision += 1;
    return {
      disposition: 'applied',
      patchId: patch.patchId,
      proposalHash,
      previousDraftRevision,
      draftRevision: this.#draftRevision,
      createdNodeIds: Object.assign(Object.create(null), Object.fromEntries(context.createdNodeIds)),
      delta,
      diagnostics,
    };
  }

  #applyOperation(context: ApplyContext, operation: GraphPatchOperation, operationIndex: number): void {
    const graph = getActiveGraph(context.candidate, this.#activeGraphId);
    const resolveNodeReference = (reference: GraphBuilderNodeReference): NodeId => {
      if (reference.kind === 'existing') {
        return reference.nodeId as NodeId;
      }
      const nodeId = context.createdNodeIds.get(reference.clientId);
      if (!nodeId) {
        throw new OperationRejectedError([
          createDiagnostic({
            key: `node-reference:${operationIndex}:${reference.clientId}`,
            ruleId: 'patch-local-node-reference',
            graphId: this.#activeGraphId,
            clientId: reference.clientId,
            operationIndex,
            message: `Created node reference "${reference.clientId}" is not available at this point in the patch.`,
          }),
        ]);
      }
      return nodeId;
    };

    switch (operation.op) {
      case 'createNode': {
        const allocatedNodeId = this.#idGenerator();
        if (
          typeof allocatedNodeId !== 'string' ||
          allocatedNodeId.length === 0 ||
          allocatedNodeId.length > GRAPH_BUILDER_LIMITS.maxIdentifierLength
        ) {
          throw new OperationRejectedError([
            createDiagnostic({
              key: `create-node:invalid-host-id:${operationIndex}`,
              ruleId: 'host-node-id-allocation',
              graphId: this.#activeGraphId,
              clientId: operation.clientId,
              operationIndex,
              message: 'The host node ID allocator returned an invalid ID.',
            }),
          ]);
        }
        if (findNode(context.candidate, this.#activeGraphId, allocatedNodeId)) {
          throw new OperationRejectedError([
            createDiagnostic({
              key: `create-node:id-collision:${operationIndex}`,
              ruleId: 'host-node-id-allocation',
              graphId: this.#activeGraphId,
              nodeId: allocatedNodeId,
              clientId: operation.clientId,
              operationIndex,
              message: 'The host node ID allocator returned an ID that already exists.',
            }),
          ]);
        }

        const rawAuthoredNode = this.#semantics.createNodeFromAuthoringChoice({
          operation,
          allocatedNodeId,
          project: cloneDeep(context.candidate),
        });
        assertNodeResultPortable(rawAuthoredNode);
        const authoredNode = cloneDeep(rawAuthoredNode);
        authoredNode.id = allocatedNodeId;
        authoredNode.visualData = { ...authoredNode.visualData, x: 0, y: 0 };
        graph.nodes.push(authoredNode);
        context.createdNodeIds.set(operation.clientId, allocatedNodeId);
        context.createdNodeIdSet.add(allocatedNodeId);
        context.touched.nodeIds.add(allocatedNodeId);
        break;
      }
      case 'updateNodeSettings': {
        const nodeId = resolveNodeReference(operation.node);
        const nodeIndex = graph.nodes.findIndex((node) => node.id === nodeId);
        const node = graph.nodes[nodeIndex];
        if (!node) {
          throw this.#missingNodeError(operation.node, operationIndex);
        }
        validatePrecondition(node, operation.precondition, this.#activeGraphId, operationIndex);
        const rawUpdatedNode = this.#semantics.applyNodeSettings({
          operation,
          node: cloneDeep(node),
          project: cloneDeep(context.candidate),
        });
        assertNodeResultPortable(rawUpdatedNode);
        const updatedNode = cloneDeep(rawUpdatedNode);
        if (updatedNode.id !== node.id || updatedNode.type !== node.type) {
          throw new OperationRejectedError([
            createDiagnostic({
              key: `settings:identity-change:${operationIndex}:${node.id}`,
              ruleId: 'node-settings-effect-closure',
              graphId: this.#activeGraphId,
              nodeId: node.id,
              operationIndex,
              message: 'A settings adapter may not change node identity or type.',
            }),
          ]);
        }
        if (!areStructurallyEqual(withoutNodeData(node), withoutNodeData(updatedNode))) {
          throw new OperationRejectedError([
            createDiagnostic({
              key: `settings:envelope-change:${operationIndex}:${node.id}`,
              ruleId: 'node-settings-effect-closure',
              graphId: this.#activeGraphId,
              nodeId: node.id,
              operationIndex,
              message: 'A settings adapter may change only declared node data fields.',
            }),
          ]);
        }
        graph.nodes[nodeIndex] = updatedNode;
        context.settingUpdatedNodeIds.add(nodeId);
        context.touched.nodeIds.add(nodeId);
        this.#validateIncidentConnections(context, nodeId, operationIndex);
        break;
      }
      case 'updateNodeEnvelope': {
        const nodeId = resolveNodeReference(operation.node);
        const node = findNode(context.candidate, this.#activeGraphId, nodeId);
        if (!node) {
          throw this.#missingNodeError(operation.node, operationIndex);
        }
        validatePrecondition(node, operation.precondition, this.#activeGraphId, operationIndex);
        for (const [field, value] of Object.entries(operation.envelope)) {
          if (field === 'splitRunMax') {
            if (value === null) {
              delete node.splitRunMax;
            } else {
              node.splitRunMax = value as number;
            }
          } else {
            Object.assign(node, { [field]: value });
          }
        }
        context.touched.nodeIds.add(nodeId);
        this.#validateIncidentConnections(context, nodeId, operationIndex);
        break;
      }
      case 'deleteNode': {
        const nodeId = resolveNodeReference(operation.node);
        const node = findNode(context.candidate, this.#activeGraphId, nodeId);
        if (!node) {
          throw this.#missingNodeError(operation.node, operationIndex);
        }
        validatePrecondition(node, operation.precondition, this.#activeGraphId, operationIndex);
        graph.nodes = graph.nodes.filter((candidate) => candidate.id !== nodeId);
        const removedConnections = graph.connections.filter(
          (connection) => connection.inputNodeId === nodeId || connection.outputNodeId === nodeId,
        );
        graph.connections = graph.connections.filter(
          (connection) => connection.inputNodeId !== nodeId && connection.outputNodeId !== nodeId,
        );
        removedConnections.forEach((connection) => context.touched.connectionKeys.add(connectionKey(connection)));
        context.touched.nodeIds.add(nodeId);
        break;
      }
      case 'connect': {
        const connection = endpointConnection(operation, resolveNodeReference);
        this.#validateNewConnection(context, connection, operationIndex);
        graph.connections.push(connection);
        context.touched.connectionKeys.add(connectionKey(connection));
        context.touched.nodeIds.add(connection.outputNodeId);
        context.touched.nodeIds.add(connection.inputNodeId);
        break;
      }
      case 'disconnect': {
        const connection = endpointConnection(operation, resolveNodeReference);
        const matches = graph.connections
          .map((candidate, index) => ({ candidate, index }))
          .filter(({ candidate }) => connectionKey(candidate) === connectionKey(connection));
        if (matches.length !== 1) {
          throw new OperationRejectedError([
            createDiagnostic({
              key: `disconnect:match-count:${operationIndex}`,
              ruleId: 'exact-disconnect',
              graphId: this.#activeGraphId,
              operationIndex,
              expected: 1,
              actual: matches.length,
              message:
                matches.length === 0
                  ? 'The exact connection to disconnect does not exist.'
                  : 'The exact connection is ambiguous because duplicate endpoint tuples exist.',
            }),
          ]);
        }
        graph.connections.splice(matches[0]!.index, 1);
        context.touched.connectionKeys.add(connectionKey(connection));
        context.touched.nodeIds.add(connection.outputNodeId);
        context.touched.nodeIds.add(connection.inputNodeId);
        break;
      }
    }
  }

  #validateNewConnection(context: ApplyContext, connection: NodeConnection, operationIndex: number): void {
    const graph = getActiveGraph(context.candidate, this.#activeGraphId);
    const outputNode = findNode(context.candidate, this.#activeGraphId, connection.outputNodeId);
    const inputNode = findNode(context.candidate, this.#activeGraphId, connection.inputNodeId);
    if (!outputNode || !inputNode) {
      throw new OperationRejectedError([
        createDiagnostic({
          key: `connect:missing-node:${operationIndex}`,
          ruleId: 'connection-node-existence',
          graphId: this.#activeGraphId,
          operationIndex,
          message: 'Both endpoints of a connection must reference existing nodes.',
        }),
      ]);
    }

    const outputPorts = this.#resolvePorts(context.candidate, outputNode.id, operationIndex);
    const inputPorts = this.#resolvePorts(context.candidate, inputNode.id, operationIndex);
    const outputPort = outputPorts.outputs.find((port) => port.id === connection.outputId);
    const inputPort = inputPorts.inputs.find((port) => port.id === connection.inputId);
    if (!outputPort || !inputPort) {
      throw new OperationRejectedError([
        createDiagnostic({
          key: `connect:missing-port:${operationIndex}`,
          ruleId: 'connection-port-existence',
          graphId: this.#activeGraphId,
          nodeId: outputPort ? inputNode.id : outputNode.id,
          portId: outputPort ? connection.inputId : connection.outputId,
          operationIndex,
          message: 'A connection endpoint port does not exist in the current dynamic port definitions.',
        }),
      ]);
    }

    if (graph.connections.some((candidate) => connectionKey(candidate) === connectionKey(connection))) {
      throw new OperationRejectedError([
        createDiagnostic({
          key: `connect:duplicate:${operationIndex}`,
          ruleId: 'connection-uniqueness',
          graphId: this.#activeGraphId,
          operationIndex,
          message: 'The exact connection already exists.',
        }),
      ]);
    }
    if (
      !inputPort.allowsMultipleConnections &&
      graph.connections.some(
        (candidate) => candidate.inputNodeId === connection.inputNodeId && candidate.inputId === connection.inputId,
      )
    ) {
      throw new OperationRejectedError([
        createDiagnostic({
          key: `connect:occupied-input:${operationIndex}`,
          ruleId: 'single-input-occupancy',
          graphId: this.#activeGraphId,
          nodeId: connection.inputNodeId,
          portId: connection.inputId,
          operationIndex,
          message: 'The destination input already has a connection.',
        }),
      ]);
    }

    const touchedForConnection: MutableTouchedScope = {
      graphIds: new Set(context.touched.graphIds),
      nodeIds: new Set([...context.touched.nodeIds, connection.outputNodeId, connection.inputNodeId]),
      connectionKeys: new Set([...context.touched.connectionKeys, connectionKey(connection)]),
      operationIndices: new Set(context.touched.operationIndices),
    };
    const touched = toTouchedScope(touchedForConnection);
    const candidateWithConnection = cloneDeep(context.candidate);
    getActiveGraph(candidateWithConnection, this.#activeGraphId).connections.push(connection);
    const validation = this.#validateConnectionSemantics(candidateWithConnection, connection, touched, operationIndex);
    if (validation.completeness !== 'complete' || validation.blockingDiagnosticKeys.length > 0) {
      const diagnostics = [...validation.diagnostics];
      if (validation.completeness !== 'complete') {
        diagnostics.push(
          createDiagnostic({
            key: `connect:incomplete-validation:${operationIndex}`,
            ruleId: 'connection-validation-completeness',
            graphId: this.#activeGraphId,
            operationIndex,
            message: 'Connection validation did not complete for the proposed endpoint tuple.',
          }),
        );
      }
      throw new OperationRejectedError(sortDiagnostics(diagnostics));
    }
  }

  #validateIncidentConnections(context: ApplyContext, nodeId: NodeId, operationIndex: number): void {
    const graph = getActiveGraph(context.candidate, this.#activeGraphId);
    const ports = this.#resolvePorts(context.candidate, nodeId, operationIndex);
    const inputIds = new Set(ports.inputs.map((port) => port.id));
    const outputIds = new Set(ports.outputs.map((port) => port.id));
    const incidentConnections = graph.connections.filter(
      (connection) => connection.inputNodeId === nodeId || connection.outputNodeId === nodeId,
    );

    for (const connection of incidentConnections) {
      if (
        (connection.inputNodeId === nodeId && !inputIds.has(connection.inputId)) ||
        (connection.outputNodeId === nodeId && !outputIds.has(connection.outputId))
      ) {
        throw new OperationRejectedError([
          createDiagnostic({
            key: `settings:invalidated-port:${operationIndex}:${connectionKey(connection)}`,
            ruleId: 'settings-preserve-connections',
            graphId: this.#activeGraphId,
            nodeId,
            operationIndex,
            message:
              'The settings change invalidates an existing connection. Disconnect it explicitly earlier in the patch.',
          }),
        ]);
      }

      const validation = this.#validateConnectionSemantics(
        context.candidate,
        connection,
        toTouchedScope(context.touched),
        operationIndex,
      );
      if (validation.completeness !== 'complete' || validation.blockingDiagnosticKeys.length > 0) {
        const diagnostics = [...validation.diagnostics];
        if (validation.completeness !== 'complete') {
          diagnostics.push(
            createDiagnostic({
              key: `settings:incomplete-connection-validation:${operationIndex}:${connectionKey(connection)}`,
              ruleId: 'connection-validation-completeness',
              graphId: this.#activeGraphId,
              nodeId,
              operationIndex,
              message: 'Connection validation did not complete after the settings change.',
            }),
          );
        }
        throw new OperationRejectedError(sortDiagnostics(diagnostics));
      }
    }
  }

  #resolvePorts(
    project: GraphBuilderAuthoringProject,
    nodeId: NodeId,
    operationIndex: number,
  ): GraphBuilderResolvedNodePorts {
    try {
      return parseResolvedPorts(
        this.#semantics.resolvePorts({
          graphId: this.#activeGraphId,
          nodeId,
          project: cloneDeep(project),
        }),
      );
    } catch {
      throw new OperationRejectedError([
        createDiagnostic({
          key: `ports:resolution-failed:${operationIndex}:${nodeId}`,
          ruleId: 'dynamic-port-resolution',
          graphId: this.#activeGraphId,
          nodeId,
          operationIndex,
          message: 'Dynamic port resolution failed closed for the touched node.',
        }),
      ]);
    }
  }

  #validateConnectionSemantics(
    project: GraphBuilderAuthoringProject,
    connection: NodeConnection,
    touchedScope: GraphBuilderTouchedScope,
    operationIndex: number,
  ): GraphValidationResult {
    try {
      return parseGraphValidationResult(
        this.#semantics.validateConnection({
          graphId: this.#activeGraphId,
          connection: cloneDeep(connection),
          project: cloneDeep(project),
          touchedScope,
        }),
      );
    } catch {
      throw new OperationRejectedError([
        createDiagnostic({
          key: `connection:validation-failed:${operationIndex}:${connectionKey(connection)}`,
          ruleId: 'connection-validation',
          graphId: this.#activeGraphId,
          operationIndex,
          message: 'Authoritative connection validation failed closed.',
        }),
      ]);
    }
  }

  #missingNodeError(reference: GraphBuilderNodeReference, operationIndex: number): OperationRejectedError {
    return new OperationRejectedError([
      createDiagnostic({
        key: `node:missing:${operationIndex}`,
        ruleId: 'node-existence',
        graphId: this.#activeGraphId,
        nodeId: reference.kind === 'existing' ? (reference.nodeId as NodeId) : undefined,
        clientId: reference.kind === 'created' ? reference.clientId : undefined,
        operationIndex,
        message: 'The referenced node does not exist in the current draft.',
      }),
    ]);
  }

  #rejectedResult(
    patch: GraphPatch,
    proposalHash: string,
    diagnostics: GraphDiagnostic[],
    attemptedDelta?: GraphDraftDelta,
  ): FreshApplyPatchResult {
    return {
      disposition: 'rejected',
      patchId: patch.patchId,
      proposalHash,
      draftRevision: this.#draftRevision,
      diagnostics: sortDiagnostics(diagnostics),
      ...(attemptedDelta === undefined ? {} : { attemptedDelta }),
    };
  }
}
