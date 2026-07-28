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
import type {
  GraphBuilderAuthoringCatalogEntry,
  GraphBuilderAuthoringCatalogSnapshot,
  GraphBuilderSafeSettingOmission,
  GraphBuilderSafeSettingsProjection,
} from './authoringCatalog.js';
import { shouldProtectVirtualGraphSecretField, VirtualGraphWorkspaceError } from './virtualGraphWorkspace.js';
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
  readVirtualDocument?(input: {
    path: string;
    startLine?: number;
    lineCount?: number;
    startOffset?: number;
  }): PortableJsonValue;
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

function containsSecretLikeObjectKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsSecretLikeObjectKey);
  }
  if (value === null || typeof value !== 'object') {
    return false;
  }
  return Object.entries(value).some(([key, child]) => {
    return shouldProtectVirtualGraphSecretField(key, child) || containsSecretLikeObjectKey(child);
  });
}

function omitUndefinedObjectProperties(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry, index) => {
      if (entry === undefined) {
        throw new Error(`Node template arrays cannot contain undefined at index ${index.toString(10)}.`);
      }
      return omitUndefinedObjectProperties(entry);
    });
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) =>
      child === undefined ? [] : [[key, omitUndefinedObjectProperties(child)]],
    ),
  );
}

function projectSafeSettings(
  node: ChartNode,
  project: GraphBuilderAuthoringProject,
  catalog: GraphBuilderAuthoringCatalogSnapshot,
  options: { includeOnDemand?: boolean } = {},
): PortableJsonObject | undefined {
  const projection = projectSafeSettingsDetailed(node, project, catalog, options);
  if (!projection) {
    return undefined;
  }
  return Object.keys(projection.safeSettings).length > 0 ? projection.safeSettings : undefined;
}

function projectSafeSettingsDetailed(
  node: ChartNode,
  project: GraphBuilderAuthoringProject,
  catalog: GraphBuilderAuthoringCatalogSnapshot,
  options: { includeOnDemand?: boolean } = {},
): GraphBuilderSafeSettingsProjection | undefined {
  if (node.type !== NODE_PREFAB_INSTANCE_TYPE) {
    return catalog.projectNodeSafeSettingsDetailed(node, project, options);
  }

  const prefabId = (node.data as { prefabId?: unknown } | undefined)?.prefabId;
  const resolved = resolveNodePrefabInstance(project as Project, node);
  if (resolved.type === NODE_PREFAB_INSTANCE_TYPE) {
    return {
      safeSettings: typeof prefabId === 'string' ? { prefabId, sourceStatus: 'missing' } : { sourceStatus: 'missing' },
      omittedSettings: [],
    };
  }

  const sourceProjection = catalog.projectNodeSafeSettingsDetailed(resolved, project, options);
  const sourceSettings = sourceProjection?.safeSettings;
  const omittedSettings: GraphBuilderSafeSettingOmission[] =
    sourceProjection?.omittedSettings.map((omission) => ({
      key: `sourceSettings.${omission.key}`,
      reason: omission.reason,
    })) ?? [];
  return {
    safeSettings: {
      ...(typeof prefabId === 'string' ? { prefabId } : {}),
      sourceType: resolved.type,
      ...(sourceSettings && Object.keys(sourceSettings).length > 0 ? { sourceSettings } : {}),
    },
    omittedSettings,
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
      const authoringChoiceId = input.catalog.getNodeAuthoringChoiceId(node);
      return {
        nodeId: node.id,
        type: node.type,
        ...(authoringChoiceId ? { authoringChoiceId } : {}),
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
      const workspaceError = error instanceof VirtualGraphWorkspaceError;
      return parseGraphBuilderReadResult({
        requestId: context.requestId,
        requestIndex: context.requestIndex,
        observedDraftRevision: context.observedDraftRevision,
        status: unsupported ? 'unsupported' : 'failed',
        error: {
          code: unsupported || workspaceError ? error.code : 'read-failed',
          message: truncate(unsupported || workspaceError ? error.message : 'Graph Builder read failed.'),
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
      case 'get-node-templates':
        return this.#getNodeTemplates(draft, request.authoringChoiceIds, request.authoringSettings);
      case 'read-virtual-document':
        if (!this.#options.readVirtualDocument) {
          throw new UnsupportedGraphBuilderReadError(
            'virtual-document-read-unavailable',
            'This Graph Builder runtime has no virtual-document workspace.',
          );
        }
        return this.#options.readVirtualDocument({
          path: request.path,
          ...(request.startLine === undefined ? {} : { startLine: request.startLine }),
          ...(request.lineCount === undefined ? {} : { lineCount: request.lineCount }),
          ...(request.startOffset === undefined ? {} : { startOffset: request.startOffset }),
        });
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
    if (
      authoringSettings !== undefined &&
      (authoringChoiceIds.length !== 1 || Object.keys(authoringSettings).length === 0)
    ) {
      throw new Error('Configured node specifications require exactly one authoring choice and non-empty settings.');
    }

    return {
      specs: authoringChoiceIds.map((requestedChoiceId, index): PortableJsonValue => {
        const authoringChoiceId = this.#options.catalog.resolveAuthoringChoiceId(requestedChoiceId);
        if (!authoringChoiceId) {
          return {
            authoringChoiceId: requestedChoiceId,
            status: 'unsupported',
            reason: 'Unknown authoring choice.',
          };
        }
        const entry = this.#options.catalog.getEntry(authoringChoiceId);
        if (!entry) {
          throw new Error(`Resolved authoring choice "${authoringChoiceId}" is absent from the catalog.`);
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
          return authoringSettings === undefined
            ? base
            : {
                ...base,
                configurationStatus: 'rejected',
                configurationReason:
                  'The requested configuration was rejected because this authoring choice has no captured settings or port adapter.',
              };
        }

        const nodeId = this.#createTemporaryNodeId(activeGraph.nodes, index);
        let node: ChartNode;
        try {
          node = this.#options.catalog.createNode({
            authoringChoiceId,
            allocatedNodeId: nodeId,
            project: draft,
            ...(authoringSettings ? { settings: authoringSettings } : {}),
          });
        } catch {
          return {
            ...base,
            ...(authoringSettings !== undefined
              ? {
                  configurationStatus: 'rejected',
                  configurationReason: 'The requested configuration was rejected by the captured authoring adapter.',
                }
              : {
                  portResolutionStatus: 'rejected',
                  portResolutionReason:
                    'The default node could not be constructed through the captured authoring adapter.',
                }),
          };
        }

        const candidate = cloneDeep(draft);
        candidate.graphs[this.#options.activeGraphId]!.nodes.push(node);
        try {
          const ports = this.#options.semantics.resolvePorts({
            graphId: this.#options.activeGraphId,
            nodeId,
            project: candidate,
          });
          return {
            ...base,
            ...(authoringSettings !== undefined ? { configurationStatus: 'resolved' } : {}),
            ports: {
              inputs: ports.inputs.map((port) => ({ id: port.id, dataType: portableDataType(port.dataType) })),
              outputs: ports.outputs.map((port) => ({ id: port.id, dataType: portableDataType(port.dataType) })),
            },
          };
        } catch {
          return {
            ...base,
            ...(authoringSettings !== undefined ? { configurationStatus: 'resolved' } : {}),
            portResolutionStatus: 'rejected',
            portResolutionReason: 'Ports are unavailable through the captured pure authoring adapter.',
          };
        }
      }),
    };
  }

  #getNodeTemplates(
    draft: GraphBuilderAuthoringProject,
    authoringChoiceIds: readonly string[],
    authoringSettings: PortableJsonObject | undefined,
  ): PortableJsonValue {
    if (
      authoringSettings !== undefined &&
      (authoringChoiceIds.length !== 1 || Object.keys(authoringSettings).length === 0)
    ) {
      throw new Error('Configured node templates require exactly one authoring choice and non-empty settings.');
    }

    const specs = this.#getNodeSpecs(draft, authoringChoiceIds, authoringSettings);
    const specsByChoiceId = new Map(
      Array.isArray((specs as PortableJsonObject).specs)
        ? ((specs as PortableJsonObject).specs as PortableJsonValue[]).flatMap((spec) => {
            if (
              spec === null ||
              typeof spec !== 'object' ||
              Array.isArray(spec) ||
              typeof spec.authoringChoiceId !== 'string'
            ) {
              return [];
            }
            return [[spec.authoringChoiceId, spec] as const];
          })
        : [],
    );

    return {
      templates: authoringChoiceIds.map((requestedChoiceId, index): PortableJsonValue => {
        const authoringChoiceId = this.#options.catalog.resolveAuthoringChoiceId(requestedChoiceId);
        if (!authoringChoiceId) {
          return {
            authoringChoiceId: requestedChoiceId,
            status: 'unsupported',
            reason: 'Unknown authoring choice.',
          };
        }

        let node: ChartNode;
        try {
          node = this.#options.catalog.createNode({
            authoringChoiceId,
            allocatedNodeId: `NEW_NODE_${index + 1}` as NodeId,
            project: draft,
            ...(authoringSettings ? { settings: authoringSettings } : {}),
          });
        } catch {
          return {
            authoringChoiceId,
            status: 'unsupported',
            reason: 'The captured authoring adapter could not construct this node template.',
          };
        }

        if (containsSecretLikeObjectKey(node.data)) {
          return {
            authoringChoiceId,
            status: 'unsupported',
            reason: 'This node template contains host-sensitive defaults and cannot be exposed to Graph Builder.',
          };
        }

        return {
          authoringChoiceId,
          status: 'ok',
          instructions:
            'Copy the complete node object into the YAML nodes list, replace NEW_NODE_* with a unique graph-local ID, and change only task-required fields.',
          // Rivet node objects may contain optional own properties whose value
          // is undefined. YAML omits those fields, so templates must do the
          // same before enforcing the strict portable-JSON transport contract.
          node: parsePortableJson(omitUndefinedObjectProperties(node)),
          ...(specsByChoiceId.get(authoringChoiceId) ? { spec: specsByChoiceId.get(authoringChoiceId)! } : {}),
        };
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
      projection.nodeId = node.id;
      if (requestedFields.has('identity')) {
        const authoringChoiceId = this.#options.catalog.getNodeAuthoringChoiceId(node);
        projection.identity = {
          nodeId: node.id,
          type: node.type,
          ...(authoringChoiceId ? { authoringChoiceId } : {}),
        };
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
        const settingsProjection = projectSafeSettingsDetailed(node, draft, this.#options.catalog, {
          includeOnDemand: true,
        });
        if (!settingsProjection) {
          projection.settingsProjectionStatus = 'unsupported';
          projection.safeSettings = {};
        } else {
          projection.settingsProjectionStatus = settingsProjection.omittedSettings.length > 0 ? 'partial' : 'available';
          projection.safeSettings = settingsProjection.safeSettings;
          if (settingsProjection.omittedSettings.length > 0) {
            projection.omittedSettings = [...settingsProjection.omittedSettings];
          }
        }
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
