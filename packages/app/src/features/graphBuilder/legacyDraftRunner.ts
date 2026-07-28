import {
  coerceType,
  type DataValue,
  type ExternalFunction,
  type ExternalFunctionProcessContext,
  type GraphId,
  type NodeGraph,
  type NodeId,
  type NodeRegistration,
  type Project,
} from '@valerypopoff/rivet2-core';
import { cloneDeep } from 'lodash-es';
import {
  calculateGraphBuilderDraftDelta,
  parsePortableJson,
  type GraphBuilderAuthoringProject,
  type GraphDraftDelta,
  type PortableJsonObject,
} from '../../domain/graphBuilder/index.js';
import { getPortCompatibilityStatus } from '../../domain/graphEditing/portCompatibility.js';
import {
  buildAiGraphBuilderExternalFunctions,
  parseAiGraphBuilderEditNodeArgs,
  resolveAiGraphBuilderNodeId,
  resolveAiGraphBuilderNodePorts,
} from '../../hooks/aiGraphBuilderHelpers.js';
import {
  assertLegacyGraphBuilderFinished,
  summarizeLegacyGraphBuilderArguments,
  summarizeLegacyGraphBuilderResult,
} from '../../hooks/legacyGraphBuilderLogging.js';
import type { GraphBuilderAuthoringCatalogSnapshot } from './authoringCatalog.js';
import { layoutGraphBuilderCreatedNodes } from './deterministicGraphLayout.js';
import { buildGraphBuilderProjection } from './readExecutor.js';
import type { GraphBuilderPreview } from './sessionController.js';

export type LegacyGraphBuilderDraftProgress =
  | {
      type: 'draft-changed';
      draftRevision: number;
      delta: GraphDraftDelta;
    }
  | {
      type: 'model-update';
      message: string;
    }
  | {
      type: 'model-command';
      name: string;
    };

export type LegacyGraphBuilderAgentExecution = {
  abortSignal: AbortSignal;
  externalFunctions: Record<string, ExternalFunction>;
  graphProjection: string;
  onUserEvent: Record<string, (data: DataValue | undefined) => void>;
  request: string;
};

/**
 * Provider/runtime adapter for the temporary legacy policy. Production binds
 * this to the bundled Graph Creator processor; deterministic evaluation may
 * bind the same draft runtime to a fake agent.
 */
export type LegacyGraphBuilderAgentExecutor = (execution: LegacyGraphBuilderAgentExecution) => Promise<void>;

export type LegacyGraphBuilderDraftResult =
  | {
      status: 'ready-for-preview';
      draft: GraphBuilderAuthoringProject;
      draftRevision: number;
      preview: GraphBuilderPreview;
    }
  | {
      status: 'no-change';
      draftRevision: number;
      summary: string;
    }
  | {
      status: 'canceled';
    };

export type RunLegacyGraphBuilderDraftOptions = {
  abortSignal: AbortSignal;
  activeGraphId: GraphId;
  baseProject: GraphBuilderAuthoringProject;
  catalog: GraphBuilderAuthoringCatalogSnapshot;
  executeAgent: LegacyGraphBuilderAgentExecutor;
  onFeedback?: (message: string) => void;
  onProgress?: (progress: LegacyGraphBuilderDraftProgress) => void;
  referencedProjects: Record<string, Project>;
  registry: NodeRegistration<any, any>;
  request: string;
};

/**
 * Runs the selectable legacy Graph Creator against a session-private project
 * draft. This function has no editor/Jotai/React dependency and cannot publish
 * graph state. The caller alone may commit the returned draft.
 */
export async function runLegacyGraphBuilderDraft(
  options: RunLegacyGraphBuilderDraftOptions,
): Promise<LegacyGraphBuilderDraftResult> {
  const baseProject = cloneDeep(options.baseProject);
  const initialGraph = baseProject.graphs[options.activeGraphId];
  if (!initialGraph) {
    throw new Error('The legacy Graph Builder base does not contain the active graph.');
  }

  let workingGraph = cloneDeep(initialGraph);
  let workingRevision = 0;
  let previousProgressProject = cloneDeep(baseProject);
  let mutationCount = 0;
  let finalMessage = '';
  let receivedFinalEvent = false;

  const getWorkingProject = (): GraphBuilderAuthoringProject => ({
    ...baseProject,
    graphs: {
      ...baseProject.graphs,
      [options.activeGraphId]: workingGraph,
    },
  });
  const log = (message: string): void => {
    options.onFeedback?.(message);
  };
  const advanceWorkingRevision = (): void => {
    workingRevision += 1;
  };
  const recordDraftChange = (): void => {
    mutationCount += 1;
    const currentProject = getWorkingProject();
    const delta = calculateGraphBuilderDraftDelta(previousProgressProject, currentProject, options.activeGraphId);
    previousProgressProject = cloneDeep(currentProject);
    options.onProgress?.({
      type: 'draft-changed',
      draftRevision: workingRevision,
      delta,
    });
  };
  const projectGraph = () =>
    buildGraphBuilderProjection({
      project: getWorkingProject(),
      activeGraphId: options.activeGraphId,
      draftRevision: workingRevision,
      catalog: options.catalog,
      diagnostics: [],
    });

  const mutationFunctions = new Set([
    'connectNodes',
    'createNode',
    'deleteNode',
    'disconnectNodes',
    'editNode',
    'toggleSplitting',
  ]);
  const externalFunctions: Record<string, ExternalFunction> = {
    ...buildAiGraphBuilderExternalFunctions({
      project: getWorkingProject,
      referencedProjects: options.referencedProjects,
      registry: options.registry,
      catalog: options.catalog,
      onLog: log,
      showChanges: recordDraftChange,
      workingGraph: () => workingGraph,
      setWorkingGraph: (nextGraph) => {
        workingGraph = nextGraph;
        advanceWorkingRevision();
      },
    }),
    editNode: async (_ctx: unknown, rawNodeId: unknown, rawKey: unknown, rawValue: unknown) => {
      const { nodeId, key, value } = parseAiGraphBuilderEditNodeArgs(rawNodeId, rawKey, rawValue);
      const node = workingGraph.nodes.find((candidate) => candidate.id === nodeId);
      if (!node) {
        throw new Error(`Node with ID ${nodeId} not found`);
      }

      const adapter = options.catalog.getNodeTypeAdapter(node.type);
      const descriptor = adapter?.settings?.find(
        (candidate) => candidate.key.toLowerCase() === key.trim().toLowerCase(),
      );
      if (!descriptor) {
        throw new Error(
          `Setting "${key}" is unavailable for node type "${node.type}" in the legacy Graph Builder. Available settings: ${
            adapter?.settings?.map((candidate) => candidate.key).join(', ') || '(none)'
          }.`,
        );
      }
      const updatedNode = options.catalog.applyNodeSettings({
        node,
        project: getWorkingProject(),
        settings: parsePortableJson({ [descriptor.key]: value }) as PortableJsonObject,
      });
      log(`Resolved editNode target ${node.id} (${node.type}) to safe setting ${descriptor.key}.`);
      workingGraph = {
        ...workingGraph,
        nodes: workingGraph.nodes.map((candidate) => (candidate.id === nodeId ? updatedNode : candidate)),
      };
      advanceWorkingRevision();
      recordDraftChange();
      logGraphState(log, workingGraph, `Edited node ${node.id} (${node.type}) data.${descriptor.key}.`);

      return {
        type: 'object' as const,
        value: {
          draftRevision: workingRevision,
          nodeId: node.id,
          type: node.type,
          safeSettings:
            options.catalog.projectNodeSafeSettings(updatedNode, getWorkingProject(), { includeOnDemand: true }) ?? {},
        },
      };
    },
    getNodeData: async (_ctx: unknown, rawNodeId: unknown) => {
      const nodeId = resolveAiGraphBuilderNodeId(rawNodeId);
      const node = workingGraph.nodes.find((candidate) => candidate.id === nodeId);
      if (!node) {
        throw new Error(`Node with ID ${nodeId} not found`);
      }
      const safeSettings = options.catalog.projectNodeSafeSettings(node, getWorkingProject(), {
        includeOnDemand: true,
      });
      log(`Reading safe data for node ${node.id} (${node.type}); ${Object.keys(safeSettings ?? {}).length} settings.`);

      return {
        type: 'object' as const,
        value: {
          draftRevision: workingRevision,
          nodeId: node.id,
          type: node.type,
          safeSettings: safeSettings ?? {},
          splittingEnabled: node.isSplitRun,
          splitRunMax: node.splitRunMax ?? null,
        },
      };
    },
    deleteNode: async (_ctx: unknown, rawNodeId: unknown) => {
      const nodeId = resolveAiGraphBuilderNodeId(rawNodeId);
      const node = workingGraph.nodes.find((candidate) => candidate.id === nodeId);
      if (!node) {
        throw new Error(`Node with ID ${nodeId} not found`);
      }

      workingGraph = {
        ...workingGraph,
        nodes: workingGraph.nodes.filter((candidate) => candidate.id !== nodeId),
        connections: workingGraph.connections.filter(
          (connection) => connection.inputNodeId !== nodeId && connection.outputNodeId !== nodeId,
        ),
      };
      advanceWorkingRevision();
      recordDraftChange();
      logGraphState(log, workingGraph, `Deleted node ${node.id} (${node.type}).`);
      return {
        type: 'object' as const,
        value: { deleted: true, draftRevision: workingRevision, nodeId },
      };
    },
    getSerializedGraph: async () => ({
      type: 'string' as const,
      value: JSON.stringify(projectGraph(), null, 2),
    }),
    lintGraph: async () => ({
      type: 'string[]' as const,
      value: lintLegacyGraph({
        graph: workingGraph,
        project: getWorkingProject(),
        referencedProjects: options.referencedProjects,
        registry: options.registry,
      }),
    }),
    toggleSplitting: async (_ctx: unknown, rawNodeId: unknown, enabled: unknown, maxSplitAmount: unknown) => {
      const rawOptions =
        typeof rawNodeId === 'object' && rawNodeId != null && !Array.isArray(rawNodeId)
          ? (rawNodeId as Record<string, unknown>)
          : undefined;
      const nodeId = resolveAiGraphBuilderNodeId(rawOptions ?? rawNodeId);
      const resolvedEnabled = rawOptions?.enabled ?? enabled;
      const resolvedMaxSplitAmount = rawOptions?.maxSplitAmount ?? maxSplitAmount;
      const enabledBoolean =
        typeof resolvedEnabled === 'boolean' ? resolvedEnabled : String(resolvedEnabled).toLowerCase() === 'true';
      const maxSplitAmountNumber =
        typeof resolvedMaxSplitAmount === 'number' ? resolvedMaxSplitAmount : Number(resolvedMaxSplitAmount);
      const node = workingGraph.nodes.find((candidate) => candidate.id === nodeId);
      if (!node) {
        throw new Error(`Node with ID ${nodeId} not found`);
      }
      if (!Number.isFinite(maxSplitAmountNumber) || maxSplitAmountNumber <= 0) {
        throw new Error('Max split amount must be greater than 0. Recommended is 100.');
      }

      workingGraph = {
        ...workingGraph,
        nodes: workingGraph.nodes.map((candidate) =>
          candidate.id === nodeId
            ? { ...candidate, isSplitRun: enabledBoolean, splitRunMax: maxSplitAmountNumber }
            : candidate,
        ),
      };
      advanceWorkingRevision();
      recordDraftChange();
      logGraphState(log, workingGraph, `Set splitting for node ${node.id} (${node.type}) to ${enabledBoolean}.`);
      return {
        type: 'object' as const,
        value: { draftRevision: workingRevision, enabled: enabledBoolean, nodeId },
      };
    },
  };

  const loggedFunctions = wrapLoggedExternalFunctions(externalFunctions, log, () => workingRevision, mutationFunctions);
  const onUserEvent: Record<string, (data: DataValue | undefined) => void> = {
    runningCommands: (data) => {
      const functionName = String(coerceType(data, 'object').name ?? '');
      if (functionName !== 'updateUser') {
        log(`MODEL requested command ${functionName}.`);
        options.onProgress?.({ type: 'model-command', name: functionName });
      }
    },
    finalMessage: (data) => {
      receivedFinalEvent = true;
      finalMessage = coerceType(data, 'string').trim();
      log(`FINAL ${finalMessage}`);
    },
    updateUser: (data) => {
      const message = coerceType(data, 'string');
      log(`UPDATE ${message}`);
      options.onProgress?.({ type: 'model-update', message });
    },
  };

  if (options.abortSignal.aborted) {
    return { status: 'canceled' };
  }
  const executionDisposition = await waitForLegacyAgentOrAbort(
    options.executeAgent({
      abortSignal: options.abortSignal,
      externalFunctions: loggedFunctions,
      graphProjection: JSON.stringify(projectGraph(), null, 2),
      onUserEvent,
      request: options.request,
    }),
    options.abortSignal,
  );

  if (executionDisposition === 'aborted' || options.abortSignal.aborted) {
    return { status: 'canceled' };
  }
  assertLegacyGraphBuilderFinished(receivedFinalEvent);

  const initialNodeIds = new Set(initialGraph.nodes.map((node) => node.id));
  const createdNodeIds = workingGraph.nodes.filter((node) => !initialNodeIds.has(node.id)).map((node) => node.id);
  if (mutationCount > 0 && createdNodeIds.length > 0) {
    const laidOutProject = layoutGraphBuilderCreatedNodes({
      base: baseProject,
      project: getWorkingProject(),
      graphId: options.activeGraphId,
      createdNodeIds,
    });
    workingGraph = laidOutProject.graphs[options.activeGraphId]!;
    advanceWorkingRevision();
  }

  const draft = cloneDeep(getWorkingProject());
  const delta = calculateGraphBuilderDraftDelta(baseProject, draft, options.activeGraphId);
  if (isEmptyDelta(delta)) {
    return {
      status: 'no-change',
      draftRevision: workingRevision,
      summary: finalMessage || 'No graph change was needed.',
    };
  }

  const summary = finalMessage || summarizeDelta(delta);
  return {
    status: 'ready-for-preview',
    draftRevision: workingRevision,
    draft,
    preview: {
      delta: { graphDeltas: [delta] },
      diagnostics: [],
      draftRevision: workingRevision,
      summary,
    },
  };
}

function waitForLegacyAgentOrAbort(pending: Promise<void>, abortSignal: AbortSignal): Promise<'completed' | 'aborted'> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      abortSignal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => resolve('aborted'));

    if (abortSignal.aborted) {
      onAbort();
    } else {
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    // Always observe both outcomes. If abort wins, a provider that ignores its
    // signal may still reject later and must not create an unhandled rejection.
    pending.then(
      () => finish(() => resolve('completed')),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function wrapLoggedExternalFunctions(
  functions: Record<string, ExternalFunction>,
  log: (message: string) => void,
  getDraftRevision: () => number,
  mutationFunctions: ReadonlySet<string>,
): Record<string, ExternalFunction> {
  return Object.fromEntries(
    Object.entries(functions).map(([name, fn]) => [
      name,
      async (context: ExternalFunctionProcessContext, ...args: unknown[]) => {
        log(`CALL ${name} ${summarizeLegacyGraphBuilderArguments(args)}`);
        try {
          const result = await fn(context, ...args);
          const versionedResult =
            mutationFunctions.has(name) && result.type !== 'object'
              ? ({
                  type: 'object',
                  value: {
                    draftRevision: getDraftRevision(),
                    result: result.value,
                  },
                } satisfies DataValue)
              : result;
          log(`OK ${name} -> ${summarizeLegacyGraphBuilderResult(versionedResult)}`);
          return versionedResult;
        } catch (error) {
          log(`ERROR ${name}: failed`);
          throw error;
        }
      },
    ]),
  );
}

function lintLegacyGraph(options: {
  graph: NodeGraph;
  project: Project;
  referencedProjects: Record<string, Project>;
  registry: NodeRegistration<any, any>;
}): string[] {
  const warnings: string[] = [];
  for (const connection of options.graph.connections) {
    const sourceNode = options.graph.nodes.find((node) => node.id === connection.outputNodeId);
    const destNode = options.graph.nodes.find((node) => node.id === connection.inputNodeId);
    if (!sourceNode || !destNode) {
      warnings.push(`Node not found for connection: ${JSON.stringify(connection)}`);
      continue;
    }
    try {
      const sourcePort = resolveAiGraphBuilderNodePorts({
        graph: options.graph,
        node: sourceNode,
        project: options.project,
        referencedProjects: options.referencedProjects,
        registry: options.registry,
      }).outputs.find((port) => port.id === connection.outputId);
      const destPort = resolveAiGraphBuilderNodePorts({
        graph: options.graph,
        node: destNode,
        project: options.project,
        referencedProjects: options.referencedProjects,
        registry: options.registry,
      }).inputs.find((port) => port.id === connection.inputId);
      if (!sourcePort || !destPort) {
        warnings.push(`Port not found for connection: ${JSON.stringify(connection)}`);
        continue;
      }
      const compatibility = getPortCompatibilityStatus({
        draggingDataType: sourcePort.dataType,
        portDataType: destPort.dataType,
        canCoerce: destPort.coerced ?? true,
        isInput: true,
      });
      if (compatibility === 'incompatible' || compatibility === 'none') {
        warnings.push(`Data type mismatch for connection: ${JSON.stringify(connection)}.`);
      } else if (compatibility === 'coerced') {
        warnings.push(`Minor: Connection ${JSON.stringify(connection)} relies on data coercion.`);
      }
    } catch {
      warnings.push(`Error resolving ports for connection: ${JSON.stringify(connection)}`);
    }
  }

  const visited = new Set<NodeId>();
  const islands: NodeId[][] = [];
  const visit = (nodeId: NodeId, island: NodeId[]) => {
    visited.add(nodeId);
    island.push(nodeId);
    for (const connection of options.graph.connections) {
      if (connection.outputNodeId === nodeId && !visited.has(connection.inputNodeId)) {
        visit(connection.inputNodeId, island);
      } else if (connection.inputNodeId === nodeId && !visited.has(connection.outputNodeId)) {
        visit(connection.outputNodeId, island);
      }
    }
  };
  for (const node of options.graph.nodes) {
    if (!visited.has(node.id)) {
      const island: NodeId[] = [];
      visit(node.id, island);
      islands.push(island);
    }
  }
  if (islands.length > 1) {
    warnings.push(`Graph is not connected as one unit. Found ${islands.length} islands.`);
  }
  for (const node of options.graph.nodes) {
    if (
      !options.graph.connections.some(
        (connection) => connection.inputNodeId === node.id || connection.outputNodeId === node.id,
      )
    ) {
      warnings.push(`Node ${node.id} has no connections.`);
    }
  }
  return warnings;
}

function isEmptyDelta(delta: GraphDraftDelta): boolean {
  return (
    (delta.addedNodeCount ?? delta.addedNodes.length) === 0 &&
    (delta.updatedNodeCount ?? delta.updatedNodes.length) === 0 &&
    (delta.removedNodeCount ?? delta.removedNodes.length) === 0 &&
    (delta.addedConnectionCount ?? delta.addedConnections.length) === 0 &&
    (delta.removedConnectionCount ?? delta.removedConnections.length) === 0
  );
}

function summarizeDelta(delta: GraphDraftDelta): string {
  const parts = [
    `${delta.addedNodeCount ?? delta.addedNodes.length} added`,
    `${delta.updatedNodeCount ?? delta.updatedNodes.length} updated`,
    `${delta.removedNodeCount ?? delta.removedNodes.length} removed`,
  ];
  return `Prepared a private graph draft (${parts.join(', ')}).`;
}

function logGraphState(log: (message: string) => void, graph: NodeGraph, message: string): void {
  log(`${message} Graph has ${graph.nodes.length} nodes and ${graph.connections.length} connections.`);
}
