import {
  NODE_PREFAB_INSTANCE_TYPE,
  resolveNodePrefabInstance,
  type ChartNode,
  type GraphId,
  type NodeId,
  type Project,
} from '@valerypopoff/rivet2-core';
import { cloneDeep } from 'lodash-es';
import {
  GRAPH_BUILDER_PROTOCOL_VERSION,
  compareGraphBuilderStrings,
  parseGraphBuilderProjection,
  parseGraphBuilderReadResult,
  parsePortableJson,
  type GraphBuilderAuthoringProject,
  type GraphBuilderProjectDataContext,
  type GraphBuilderProjection,
  type GraphBuilderReadRequest,
  type GraphBuilderReadResult,
  type GraphDiagnostic,
  type GraphDraftDelta,
  type PortableJsonObject,
  type PortableJsonValue,
} from '../../domain/graphBuilder/index.js';
import type { GraphBuilderAuthoringCatalogEntry, GraphBuilderAuthoringCatalogSnapshot } from './authoringCatalog.js';
import type { AppGraphBuilderAuthoringSemantics } from './authoringSemantics.js';

const SUPPORTED_INSPECTION_FIELDS = new Set(['connections', 'envelope', 'identity', 'ports', 'settings']);
const SUPPORTED_RESOURCE_KINDS = new Set([
  'data',
  'graph',
  'knowledge-store',
  'mcp-server',
  'node-prefab',
  'referenced-project',
]);
const MAX_READ_PAYLOAD_BYTES = 128 * 1024;
const MAX_PROJECTED_TEXT = 2_000;

export type GraphBuilderReadExecutorOptions = {
  activeGraphId: GraphId;
  projectDataContext: GraphBuilderProjectDataContext;
  catalog: GraphBuilderAuthoringCatalogSnapshot;
  semantics: AppGraphBuilderAuthoringSemantics;
  getDraft: () => GraphBuilderAuthoringProject;
  getDraftRevision: () => number;
  getDiagnostics: () => readonly GraphDiagnostic[];
  getDraftDelta: () => GraphDraftDelta | undefined;
};

export type ExecuteGraphBuilderReadBatchOptions = {
  createRequestId: (requestIndex: number) => string;
  abortSignal?: AbortSignal;
};

export type ExecuteGraphBuilderReadContext = {
  requestId: string;
  requestIndex: number;
  observedDraftRevision: number;
  draft: GraphBuilderAuthoringProject;
  abortSignal: AbortSignal;
};

function truncate(value: string, maximum = MAX_PROJECTED_TEXT): string {
  if (value.length <= maximum) {
    return value;
  }
  let prefixLength = Math.max(0, maximum - 1);
  const finalCodeUnit = value.charCodeAt(prefixLength - 1);
  const nextCodeUnit = value.charCodeAt(prefixLength);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff && nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
    prefixLength -= 1;
  }
  return `${value.slice(0, prefixLength)}…`;
}

function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function scoreCatalogEntry(entry: GraphBuilderAuthoringCatalogEntry, queries: readonly string[]): number {
  const displayName = normalizeSearchText(entry.displayName);
  const nodeType = normalizeSearchText(entry.nodeType);
  const aliases = entry.aliases.map(normalizeSearchText);
  const description = normalizeSearchText(entry.description);
  let score = 0;

  for (const rawQuery of queries) {
    const query = normalizeSearchText(rawQuery);
    if (!query) {
      continue;
    }
    const tokens = query.split(/\s+/);
    if (displayName === query || nodeType === query || aliases.includes(query)) {
      score = Math.max(score, 100);
      continue;
    }
    if (displayName.startsWith(query) || nodeType.startsWith(query)) {
      score = Math.max(score, 80);
    }
    if (displayName.includes(query) || nodeType.includes(query) || aliases.some((alias) => alias.includes(query))) {
      score = Math.max(score, 60);
    }
    const matchedTokens = tokens.filter(
      (token) =>
        displayName.includes(token) ||
        nodeType.includes(token) ||
        description.includes(token) ||
        aliases.some((alias) => alias.includes(token)),
    ).length;
    score = Math.max(score, matchedTokens * 10);
  }
  return score;
}

function portablePayload(value: unknown): PortableJsonValue {
  return parsePortableJson(value, {
    maxBytes: MAX_READ_PAYLOAD_BYTES,
    maxStringLength: 16_384,
  });
}

function deriveRunMode(node: ChartNode): string {
  if (node.disabled) {
    return 'disabled';
  }
  if (node.isConditional && node.isSplitRun) {
    return node.isSplitSequential ? 'conditional-sequential-split' : 'conditional-parallel-split';
  }
  if (node.isConditional) {
    return 'conditional';
  }
  if (node.isSplitRun) {
    return node.isSplitSequential ? 'sequential-split' : 'parallel-split';
  }
  return 'once';
}

function connectionProjection(connection: {
  outputNodeId: NodeId;
  outputId: string;
  inputNodeId: NodeId;
  inputId: string;
}) {
  return {
    outputNodeId: connection.outputNodeId,
    outputId: connection.outputId,
    inputNodeId: connection.inputNodeId,
    inputId: connection.inputId,
  };
}

function portableDataType(dataType: string | readonly string[]): string | string[] {
  return typeof dataType === 'string' ? dataType : [...dataType];
}

function projectSafeSettings(
  node: ChartNode,
  project: GraphBuilderAuthoringProject,
  catalog: GraphBuilderAuthoringCatalogSnapshot,
  options: { includeOnDemand?: boolean } = {},
): PortableJsonObject | undefined {
  if (node.type !== NODE_PREFAB_INSTANCE_TYPE) {
    return catalog.projectNodeSafeSettings(node, project, options);
  }

  const prefabId = (node.data as { prefabId?: unknown } | undefined)?.prefabId;
  const resolved = resolveNodePrefabInstance(project as Project, node);
  if (resolved.type === NODE_PREFAB_INSTANCE_TYPE) {
    return typeof prefabId === 'string' ? { prefabId, sourceStatus: 'missing' } : { sourceStatus: 'missing' };
  }
  const sourceSettings = catalog.projectNodeSafeSettings(resolved, project, options);
  return {
    ...(typeof prefabId === 'string' ? { prefabId } : {}),
    sourceType: resolved.type,
    ...(sourceSettings ? { sourceSettings } : {}),
  };
}

export function buildGraphBuilderProjection(input: {
  project: GraphBuilderAuthoringProject;
  activeGraphId: GraphId;
  draftRevision: number;
  catalog: GraphBuilderAuthoringCatalogSnapshot;
  diagnostics: readonly GraphDiagnostic[];
  delta?: GraphDraftDelta;
}): GraphBuilderProjection {
  const graph = Object.hasOwn(input.project.graphs, input.activeGraphId)
    ? input.project.graphs[input.activeGraphId]
    : undefined;
  if (!graph) {
    throw new Error(`Cannot project missing active graph "${input.activeGraphId}".`);
  }

  return parseGraphBuilderProjection({
    protocolVersion: GRAPH_BUILDER_PROTOCOL_VERSION,
    projectId: input.project.metadata.id,
    graphId: input.activeGraphId,
    draftRevision: input.draftRevision,
    nodes: graph.nodes.map((node) => {
      const safeSettings = projectSafeSettings(node, input.project, input.catalog);
      return {
        nodeId: node.id,
        type: node.type,
        title: truncate(node.title),
        runMode: deriveRunMode(node),
        ...(safeSettings ? { safeSettings } : {}),
      };
    }),
    connections: graph.connections.map(connectionProjection),
    diagnostics: [...input.diagnostics].slice(0, 256),
    ...(input.delta ? { delta: input.delta } : {}),
  });
}

export class GraphBuilderReadExecutor {
  readonly #options: GraphBuilderReadExecutorOptions;

  constructor(options: GraphBuilderReadExecutorOptions) {
    this.#options = options;
  }

  async execute(
    request: GraphBuilderReadRequest,
    context: ExecuteGraphBuilderReadContext,
  ): Promise<GraphBuilderReadResult> {
    this.#throwIfAborted(context.abortSignal);
    if (this.#options.getDraftRevision() !== context.observedDraftRevision) {
      return parseGraphBuilderReadResult({
        requestId: context.requestId,
        requestIndex: context.requestIndex,
        observedDraftRevision: context.observedDraftRevision,
        status: 'failed',
        error: {
          code: 'stale-read-context',
          message: 'The Graph Builder draft changed before this context read started.',
        },
      });
    }

    // Every parallel read gets an isolated copy of the controller-captured
    // draft. Pure adapters should not mutate it, but isolation prevents a
    // defective trusted adapter from contaminating sibling reads.
    const draft = cloneDeep(context.draft);
    try {
      const payload = this.#executePayload(request, draft);
      this.#throwIfAborted(context.abortSignal);
      if (this.#options.getDraftRevision() !== context.observedDraftRevision) {
        return parseGraphBuilderReadResult({
          requestId: context.requestId,
          requestIndex: context.requestIndex,
          observedDraftRevision: context.observedDraftRevision,
          status: 'failed',
          error: {
            code: 'stale-read-context',
            message: 'The Graph Builder draft changed while this context read was running.',
          },
        });
      }
      return parseGraphBuilderReadResult({
        requestId: context.requestId,
        requestIndex: context.requestIndex,
        observedDraftRevision: context.observedDraftRevision,
        status: 'ok',
        payload: portablePayload(payload),
      });
    } catch (error) {
      this.#throwIfAborted(context.abortSignal);
      const unsupported = error instanceof UnsupportedGraphBuilderReadError;
      return parseGraphBuilderReadResult({
        requestId: context.requestId,
        requestIndex: context.requestIndex,
        observedDraftRevision: context.observedDraftRevision,
        status: unsupported ? 'unsupported' : 'failed',
        error: {
          code: unsupported ? error.code : 'read-failed',
          message: truncate(unsupported ? error.message : 'Graph Builder read failed.'),
        },
      });
    }
  }

  async executeBatch(
    requests: readonly GraphBuilderReadRequest[],
    options: ExecuteGraphBuilderReadBatchOptions,
  ): Promise<GraphBuilderReadResult[]> {
    const observedDraftRevision = this.#options.getDraftRevision();
    const draft = this.#options.getDraft();
    const abortSignal = options.abortSignal ?? new AbortController().signal;

    const pending = requests.map((request, requestIndex) =>
      this.execute(request, {
        requestId: options.createRequestId(requestIndex),
        requestIndex,
        observedDraftRevision,
        draft,
        abortSignal,
      }),
    );

    // Promise.all retains request order even if a future asynchronous read
    // adapter completes out of order.
    return Promise.all(pending);
  }

  #executePayload(request: GraphBuilderReadRequest, draft: GraphBuilderAuthoringProject): PortableJsonValue {
    switch (request.type) {
      case 'search-node-types':
        return this.#searchNodeTypes(request.queries, request.limit);
      case 'get-node-specs':
        return this.#getNodeSpecs(draft, request.authoringChoiceIds, request.authoringSettings);
      case 'inspect-draft':
        return this.#inspectDraft(draft, request.nodeIds, request.fields);
      case 'inspect-draft-diff':
        return (
          this.#options.getDraftDelta() ?? {
            graphId: this.#options.activeGraphId,
            addedNodes: [],
            removedNodes: [],
            updatedNodes: [],
            addedConnections: [],
            removedConnections: [],
          }
        );
      case 'get-diagnostics':
        return [...this.#options.getDiagnostics()].slice(0, 256);
      case 'list-project-resources':
        return this.#listProjectResources(draft, request.kinds, request.query, request.limit);
      default:
        throw new UnsupportedGraphBuilderReadError('unsupported-read', 'The requested read type is unsupported.');
    }
  }

  #throwIfAborted(abortSignal: AbortSignal): void {
    if (abortSignal.aborted) {
      throw abortSignal.reason instanceof Error ? abortSignal.reason : new Error('Graph Builder read was canceled.');
    }
  }

  #searchNodeTypes(queries: readonly string[], limit: number): PortableJsonValue {
    const matches = this.#options.catalog
      .listEntries()
      .map((entry) => ({ entry, score: scoreCatalogEntry(entry, queries) }))
      .filter(({ score }) => score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          compareGraphBuilderStrings(left.entry.displayName, right.entry.displayName) ||
          compareGraphBuilderStrings(left.entry.authoringChoiceId, right.entry.authoringChoiceId),
      )
      .slice(0, limit)
      .map(({ entry, score }) => ({
        authoringChoiceId: entry.authoringChoiceId,
        family: entry.family,
        nodeType: entry.nodeType,
        displayName: truncate(entry.displayName, 500),
        description: truncate(entry.description, 1_000),
        capabilities: entry.capabilities,
        score,
      }));
    return { matches };
  }

  #getNodeSpecs(
    draft: GraphBuilderAuthoringProject,
    authoringChoiceIds: readonly string[],
    authoringSettings: PortableJsonObject | undefined,
  ): PortableJsonValue {
    const activeGraph = draft.graphs[this.#options.activeGraphId];
    if (!activeGraph) {
      throw new Error(`Active graph "${this.#options.activeGraphId}" does not exist.`);
    }

    return {
      specs: authoringChoiceIds.map((authoringChoiceId, index): PortableJsonValue => {
        const entry = this.#options.catalog.getEntry(authoringChoiceId);
        if (!entry) {
          return {
            authoringChoiceId,
            status: 'unsupported',
            reason: 'Unknown authoring choice.',
          };
        }

        const base = {
          authoringChoiceId,
          status: 'ok',
          family: entry.family,
          nodeType: entry.nodeType,
          displayName: truncate(entry.displayName, 500),
          description: truncate(entry.description, 1_000),
          aliases: entry.aliases.map((alias) => truncate(alias, 500)),
          capabilities: { ...entry.capabilities },
          settings: entry.settings.map((descriptor) => ({
            key: descriptor.key,
            valueKind: descriptor.valueKind,
            description: truncate(descriptor.description, 1_000),
            ...(descriptor.allowedValues ? { allowedValues: [...descriptor.allowedValues] } : {}),
            ...(descriptor.projection ? { projection: descriptor.projection } : {}),
          })),
          ...(entry.safeDefaults ? { safeDefaults: entry.safeDefaults } : {}),
        };

        if (!entry.capabilities.resolvePorts) {
          return base;
        }

        const nodeId = this.#createTemporaryNodeId(activeGraph.nodes, index);
        try {
          const node = this.#options.catalog.createNode({
            authoringChoiceId,
            allocatedNodeId: nodeId,
            project: draft,
            ...(authoringSettings ? { settings: authoringSettings } : {}),
          });
          const candidate = cloneDeep(draft);
          candidate.graphs[this.#options.activeGraphId]!.nodes.push(node);
          const ports = this.#options.semantics.resolvePorts({
            graphId: this.#options.activeGraphId,
            nodeId,
            project: candidate,
          });
          return {
            ...base,
            configured: authoringSettings !== undefined,
            ports: {
              inputs: ports.inputs.map((port) => ({ id: port.id, dataType: portableDataType(port.dataType) })),
              outputs: ports.outputs.map((port) => ({ id: port.id, dataType: portableDataType(port.dataType) })),
            },
          };
        } catch {
          return {
            ...base,
            configurationStatus: 'unsupported',
            configurationReason: 'The requested configuration is not supported by the captured authoring adapter.',
          };
        }
      }),
    };
  }

  #inspectDraft(
    draft: GraphBuilderAuthoringProject,
    nodeIds: readonly string[],
    fields: readonly string[],
  ): PortableJsonValue {
    const unsupportedFields = fields.filter((field) => !SUPPORTED_INSPECTION_FIELDS.has(field));
    if (unsupportedFields.length > 0) {
      throw new UnsupportedGraphBuilderReadError(
        'unsupported-inspection-field',
        `Unsupported draft inspection field(s): ${unsupportedFields.join(', ')}.`,
      );
    }
    const graph = draft.graphs[this.#options.activeGraphId];
    if (!graph) {
      throw new Error(`Active graph "${this.#options.activeGraphId}" does not exist.`);
    }
    const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
    const requestedFields = new Set(fields);
    const missingNodeIds: string[] = [];
    const nodes: PortableJsonValue[] = [];

    for (const rawNodeId of nodeIds) {
      const node = nodesById.get(rawNodeId as NodeId);
      if (!node) {
        missingNodeIds.push(rawNodeId);
        continue;
      }
      const projection = Object.create(null) as PortableJsonObject;
      if (requestedFields.has('identity')) {
        projection.identity = { nodeId: node.id, type: node.type };
      }
      if (requestedFields.has('envelope')) {
        projection.envelope = {
          title: truncate(node.title),
          runMode: deriveRunMode(node),
          disabled: node.disabled ?? false,
          isConditional: node.isConditional ?? false,
          isSplitRun: node.isSplitRun ?? false,
          splitRunMax: node.splitRunMax ?? null,
        };
      }
      if (requestedFields.has('settings')) {
        projection.safeSettings =
          projectSafeSettings(node, draft, this.#options.catalog, { includeOnDemand: true }) ?? {};
      }
      if (requestedFields.has('connections')) {
        projection.connections = graph.connections
          .filter((connection) => connection.inputNodeId === node.id || connection.outputNodeId === node.id)
          .map(connectionProjection);
      }
      if (requestedFields.has('ports')) {
        try {
          const ports = this.#options.semantics.resolvePorts({
            graphId: this.#options.activeGraphId,
            nodeId: node.id,
            project: draft,
          });
          projection.ports = {
            inputs: ports.inputs.map((port) => ({ id: port.id, dataType: portableDataType(port.dataType) })),
            outputs: ports.outputs.map((port) => ({ id: port.id, dataType: portableDataType(port.dataType) })),
          };
        } catch {
          projection.ports = {
            status: 'unsupported',
            reason: 'Ports are unavailable through the captured pure authoring adapter.',
          };
        }
      }
      nodes.push(projection);
    }

    return { nodes, missingNodeIds };
  }

  #listProjectResources(
    draft: GraphBuilderAuthoringProject,
    kinds: readonly string[],
    query: string | undefined,
    limit: number,
  ): PortableJsonValue {
    const unsupportedKinds = kinds.filter((kind) => !SUPPORTED_RESOURCE_KINDS.has(kind));
    if (unsupportedKinds.length > 0) {
      throw new UnsupportedGraphBuilderReadError(
        'unsupported-resource-kind',
        `Unsupported project resource kind(s): ${unsupportedKinds.join(', ')}.`,
      );
    }

    const resources: PortableJsonObject[] = [];
    const requested = new Set(kinds);
    if (requested.has('data')) {
      for (const item of this.#options.projectDataContext.manifest) {
        const metadata =
          item.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata)
            ? item.metadata
            : undefined;
        const displayName =
          metadata && typeof metadata.title === 'string'
            ? metadata.title
            : metadata && typeof metadata.name === 'string'
              ? metadata.name
              : item.id;
        resources.push({
          kind: 'data',
          id: item.id,
          displayName: truncate(displayName, 500),
          digest: item.digest,
        });
      }
    }
    if (requested.has('knowledge-store')) {
      for (const [id, store] of Object.entries(draft.metadata.knowledgeStores ?? {})) {
        resources.push({
          kind: 'knowledge-store',
          id,
          displayName: truncate(store.displayName, 500),
          provider: truncate(store.provider, 500),
        });
      }
    }
    if (requested.has('mcp-server')) {
      for (const [id, server] of Object.entries(draft.metadata.mcpServer?.mcpServers ?? {})) {
        resources.push({
          kind: 'mcp-server',
          id,
          displayName: truncate(id, 500),
          disabled: server.disabled ?? false,
        });
      }
    }
    if (requested.has('graph')) {
      for (const [id, graph] of Object.entries(draft.graphs)) {
        resources.push({
          kind: 'graph',
          id,
          displayName: truncate(graph.metadata?.name ?? id, 500),
        });
      }
    }
    if (requested.has('node-prefab')) {
      for (const [id, prefab] of Object.entries(draft.nodePrefabs ?? {})) {
        resources.push({
          kind: 'node-prefab',
          id,
          displayName: truncate(prefab.sourceNode.title || 'Untitled library node', 500),
          sourceType: prefab.sourceNode.type,
        });
      }
    }
    if (requested.has('referenced-project')) {
      for (const reference of draft.references ?? []) {
        resources.push({
          kind: 'referenced-project',
          id: reference.id,
          displayName: truncate(reference.title ?? reference.id, 500),
        });
      }
    }

    const normalizedQuery = normalizeSearchText(query ?? '');
    return {
      resources: resources
        .filter((resource) => {
          if (!normalizedQuery) {
            return true;
          }
          return normalizeSearchText(`${resource.id ?? ''} ${resource.displayName ?? ''}`).includes(normalizedQuery);
        })
        .sort(
          (left, right) =>
            compareGraphBuilderStrings(String(left.kind), String(right.kind)) ||
            compareGraphBuilderStrings(String(left.displayName), String(right.displayName)) ||
            compareGraphBuilderStrings(String(left.id), String(right.id)),
        )
        .slice(0, limit),
    };
  }

  #createTemporaryNodeId(nodes: readonly ChartNode[], index: number): NodeId {
    const occupied = new Set(nodes.map((node) => node.id));
    let suffix = index;
    while (occupied.has(`__graph_builder_spec_${suffix}` as NodeId)) {
      suffix += 1;
    }
    return `__graph_builder_spec_${suffix}` as NodeId;
  }
}

class UnsupportedGraphBuilderReadError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'UnsupportedGraphBuilderReadError';
    this.code = code;
  }
}

export function createGraphBuilderReadExecutor(options: GraphBuilderReadExecutorOptions): GraphBuilderReadExecutor {
  return new GraphBuilderReadExecutor(options);
}
