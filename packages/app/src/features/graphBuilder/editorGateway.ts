import {
  type FrozenNodeOutputsByGraph,
  type GraphId,
  type NodeConnection,
  type NodeGraph,
  type NodeId,
  type NodeRegistration,
  type Project,
  type ProjectId,
  newId,
} from '@valerypopoff/rivet2-core';
import { cloneDeep } from 'lodash-es';
import { atom } from 'jotai';
import type { createStore, Getter, Setter } from 'jotai/vanilla';
import {
  type Command,
  type CommandData,
  commandHistoryStackStatePerGraph,
  redoStackStatePerGraph,
} from '../../commands/Command.js';
import {
  canonicalGraphBuilderAuthoringStringify,
  graphBuilderStringTupleKey,
} from '../../domain/graphBuilder/index.js';
import {
  expandedOutputNodeIdsState,
  editingNodeState,
  fullscreenOutputNodeState,
  selectedNodesState,
} from '../../state/graphBuilder.js';
import { activeGraphBuilderSessionOwnerState, graphBuilderEditorRevisionState } from '../../state/graphBuilderAi.js';
import {
  frozenNodeOutputsState,
  graphRunningState,
  lastRunDataByNodeState,
  selectedProcessPageNodesState,
  type RunDataByNodeId,
} from '../../state/dataFlow.js';
import { graphState, historicalGraphState, isReadOnlyGraphState } from '../../state/graph.js';
import { pluginRefreshCounterState, pluginsState, projectNodeRegistryState } from '../../state/plugins.js';
import {
  projectDataState,
  projectState,
  projectUnsavedChangesState,
  referencedProjectsState,
} from '../../state/savedGraphs.js';
import {
  type RecoverableNodeConnectionsByGraph,
  type RecoverableNodeConnectionsByNode,
  recoverableNodeConnectionsStatePerGraph,
} from '../../state/recoverableNodeConnections.js';
import {
  aiAssistCustomModelState,
  aiAssistCustomProviderBaseURLState,
  selectedAssistModelState,
} from '../../state/ai.js';
import { resolveEditorPreferences, settingsState, type EditorPreferences } from '../../state/settings.js';
import { resolveAiAssistModelSettings, type ResolvedAiAssistModelSettings } from '../../utils/aiAssistModelSettings.js';
import { markProjectDirtyFlag } from '../../utils/projectUnsavedChanges.js';
import { createGraphBuilderEditorSnapshot } from './editorSnapshot.js';
import {
  createGraphBuilderBaseIdentity,
  graphBuilderBaseIdentityMatches,
  type GraphBuilderBaseIdentity,
} from './identity.js';

export type GraphBuilderEligibility = { eligible: true } | { eligible: false; reason: string };

export type GraphBuilderEditorContext = {
  assistModel: ResolvedAiAssistModelSettings;
  authoringPreferences: Pick<EditorPreferences, 'applyDefaultNodeColors'>;
  base: GraphBuilderBaseIdentity;
  eligibility: GraphBuilderEligibility;
  project: Omit<Project, 'data'>;
  referencedProjects: Record<ProjectId, Project>;
  registry: NodeRegistration<any, any>;
  snapshot: ReturnType<typeof createGraphBuilderEditorSnapshot>;
};

type JotaiStore = ReturnType<typeof createStore>;

export type PreparedGraphBuilderCommit = {
  base: GraphBuilderBaseIdentity;
  canonicalContent: string;
  commitId: string;
  draftRevision: number;
  nextGraph: NodeGraph;
  /**
   * Graph snapshots changed by this commit. A null value deletes a non-active
   * graph. Missing values are deliberately left untouched.
   *
   * This is optional so callers that provide only nextGraph retain the original
   * active-graph replacement behavior.
   */
  nextGraphs?: Partial<Record<GraphId, NodeGraph | null>>;
  ownerSessionId?: string;
  summary: string;
};

export type GraphBuilderCommitOutcome =
  | {
      status: 'committed';
      commitId: string;
      draftRevision: number;
      summary: string;
    }
  | {
      status: 'conflicted';
      commitId: string;
      currentFingerprint: string;
      reason: string;
    }
  | {
      status: 'ineligible';
      commitId: string;
      reason: string;
    }
  | {
      status: 'protocol-error';
      commitId: string;
      reason: string;
    };

type GraphBuilderCommitLedgerEntry = {
  canonicalContent: string;
  outcome: GraphBuilderCommitOutcome;
};

const MAX_GRAPH_BUILDER_COMMIT_LEDGER_ENTRIES = 64;

export type GraphBuilderHistorySnapshot = {
  additionalGraphs?: Partial<Record<GraphId, GraphBuilderRelatedGraphHistorySnapshot>>;
  editingNodeId: NodeId | null;
  expandedOutputNodeIds: NodeId[];
  frozenNodeOutputs: FrozenNodeOutputsByGraph[GraphId] | undefined;
  fullscreenOutputNodeId: NodeId | null;
  graph: NodeGraph;
  lastRunDataByNode: RunDataByNodeId;
  persistedGraph: NodeGraph | undefined;
  recoverableConnections: RecoverableNodeConnectionsByNode | undefined;
  selectedNodeIds: NodeId[];
  selectedProcessPages: Record<NodeId, number | 'latest'>;
};

export type GraphBuilderRelatedGraphHistorySnapshot = {
  frozenNodeOutputs: FrozenNodeOutputsByGraph[GraphId] | undefined;
  persistedGraph: NodeGraph | undefined;
  recoverableConnections: RecoverableNodeConnectionsByNode | undefined;
};

type GraphBuilderHistoryCommandData = {
  activeGraphId: GraphId;
  after: GraphBuilderHistorySnapshot;
  before: GraphBuilderHistorySnapshot;
  publish: (snapshot: GraphBuilderHistorySnapshot) => void;
};

const graphBuilderCommitLedgerState = atom<Record<string, GraphBuilderCommitLedgerEntry>>({});

export const publishGraphBuilderHistorySnapshotState = atom(
  null,
  (get, set, input: { activeGraphId: GraphId; snapshot: GraphBuilderHistorySnapshot }) => {
    const currentProject = get(projectState);
    const nextGraphs = { ...currentProject.graphs };
    for (const [rawGraphId, graphSnapshot] of historyGraphSnapshots(input.activeGraphId, input.snapshot)) {
      const graphId = rawGraphId as GraphId;
      if (graphSnapshot.persistedGraph) {
        nextGraphs[graphId] = cloneDeep(graphSnapshot.persistedGraph);
      } else {
        delete nextGraphs[graphId];
      }
    }

    set(projectState, { ...currentProject, graphs: nextGraphs });
    set(graphState, cloneDeep(input.snapshot.graph));
    set(selectedNodesState, [...input.snapshot.selectedNodeIds]);
    set(editingNodeState, input.snapshot.editingNodeId);
    set(fullscreenOutputNodeState, input.snapshot.fullscreenOutputNodeId);
    set(expandedOutputNodeIdsState, [...input.snapshot.expandedOutputNodeIds]);
    set(lastRunDataByNodeState, cloneDeep(input.snapshot.lastRunDataByNode));
    set(selectedProcessPageNodesState, { ...input.snapshot.selectedProcessPages });
    setGraphScopedHistoryEntries(get, set, input.activeGraphId, input.snapshot);
    set(graphBuilderEditorRevisionState, get(graphBuilderEditorRevisionState) + 1);
    set(
      projectUnsavedChangesState,
      markProjectDirtyFlag(get(projectUnsavedChangesState), currentProject.metadata.id, true),
    );
  },
);

const graphBuilderHistoryCommand: Command<GraphBuilderHistoryCommandData, Record<string, never>> = {
  type: 'graphBuilderCommit',
  apply(data, appliedData) {
    if (appliedData) {
      data.publish(data.after);
    }
    return {};
  },
  undo(data) {
    data.publish(data.before);
  },
};

export const tryCommitGraphBuilderDraftState = atom(
  null,
  (
    get,
    set,
    input: {
      prepared: PreparedGraphBuilderCommit;
      publishHistorySnapshot: (graphId: GraphId, snapshot: GraphBuilderHistorySnapshot) => void;
    },
  ): GraphBuilderCommitOutcome => {
    let currentPreparedContent: string;
    try {
      currentPreparedContent = canonicalPreparedCommitContent(input.prepared);
    } catch {
      return {
        status: 'protocol-error',
        commitId: input.prepared.commitId,
        reason: 'The prepared graph is no longer a valid portable graph.',
      };
    }
    if (input.prepared.canonicalContent !== currentPreparedContent) {
      return {
        status: 'protocol-error',
        commitId: input.prepared.commitId,
        reason: 'The prepared graph content changed after the commit was prepared.',
      };
    }

    const previousLedgerEntry = get(graphBuilderCommitLedgerState)[input.prepared.commitId];
    if (previousLedgerEntry) {
      return previousLedgerEntry.canonicalContent === input.prepared.canonicalContent
        ? cloneDeep(previousLedgerEntry.outcome)
        : {
            status: 'protocol-error',
            commitId: input.prepared.commitId,
            reason: 'The same commit ID was reused with different content.',
          };
    }

    const current = captureGraphBuilderEditorContextFromGetter(get, input.prepared.ownerSessionId);
    if (!current.eligibility.eligible) {
      return rememberOutcome(get, set, input.prepared, {
        status: 'ineligible',
        commitId: input.prepared.commitId,
        reason: current.eligibility.reason,
      });
    }

    if (!graphBuilderBaseIdentityMatches(input.prepared.base, current.base)) {
      return rememberOutcome(get, set, input.prepared, {
        status: 'conflicted',
        commitId: input.prepared.commitId,
        currentFingerprint: current.base.projectFingerprint,
        reason: 'The project, active graph, plugins, references, or AI configuration changed during generation.',
      });
    }

    const activeGraphId = input.prepared.base.activeGraphId;
    let nextGraphs: Partial<Record<GraphId, NodeGraph | null>>;
    try {
      nextGraphs = resolvePreparedGraphChanges(input.prepared);
    } catch {
      return rememberOutcome(get, set, input.prepared, {
        status: 'protocol-error',
        commitId: input.prepared.commitId,
        reason: 'The prepared graph changes are inconsistent.',
      });
    }
    if (input.prepared.nextGraph.metadata?.id !== activeGraphId) {
      return rememberOutcome(get, set, input.prepared, {
        status: 'protocol-error',
        commitId: input.prepared.commitId,
        reason: 'The prepared graph does not match the session active graph.',
      });
    }
    for (const [rawGraphId, nextGraph] of Object.entries(nextGraphs)) {
      const graphId = rawGraphId as GraphId;
      if (nextGraph === null && graphId === activeGraphId) {
        return rememberOutcome(get, set, input.prepared, {
          status: 'protocol-error',
          commitId: input.prepared.commitId,
          reason: 'The prepared commit cannot delete the active graph.',
        });
      }
      if (nextGraph !== null && nextGraph?.metadata?.id !== graphId) {
        return rememberOutcome(get, set, input.prepared, {
          status: 'protocol-error',
          commitId: input.prepared.commitId,
          reason: `Prepared graph "${graphId}" has a mismatched graph identity.`,
        });
      }
    }

    const changedGraphIds = Object.keys(nextGraphs) as GraphId[];
    const before = captureHistorySnapshot(get, activeGraphId, changedGraphIds);
    const activeGraphChanged = Object.hasOwn(nextGraphs, activeGraphId);
    const after = activeGraphChanged
      ? createPostCommitHistorySnapshot(before, nextGraphs[activeGraphId]!)
      : cloneDeep(before);
    after.additionalGraphs = createPostCommitRelatedGraphSnapshots(before.additionalGraphs, nextGraphs, activeGraphId);
    const currentProject = get(projectState);
    const committedProjectGraphs = { ...currentProject.graphs };
    for (const [rawGraphId, nextGraph] of Object.entries(nextGraphs)) {
      const graphId = rawGraphId as GraphId;
      if (nextGraph === null) {
        delete committedProjectGraphs[graphId];
      } else if (nextGraph) {
        committedProjectGraphs[graphId] = cloneDeep(nextGraph);
      }
    }
    const nextProject = {
      ...currentProject,
      graphs: committedProjectGraphs,
    };
    const historyData: GraphBuilderHistoryCommandData = {
      activeGraphId,
      before,
      after,
      publish: (snapshot) => input.publishHistorySnapshot(activeGraphId, snapshot),
    };
    const historyEntry: CommandData<GraphBuilderHistoryCommandData, Record<string, never>> = {
      appliedData: {},
      command: graphBuilderHistoryCommand,
      data: historyData,
      timestamp: Date.now(),
    };

    // All potentially fallible work is complete. Jotai batches these synchronous
    // writes so subscribers cannot observe graph/project without its history.
    set(projectState, nextProject);
    set(graphState, cloneDeep(after.graph));
    set(selectedNodesState, after.selectedNodeIds);
    set(editingNodeState, after.editingNodeId);
    set(fullscreenOutputNodeState, after.fullscreenOutputNodeId);
    set(expandedOutputNodeIdsState, after.expandedOutputNodeIds);
    set(lastRunDataByNodeState, after.lastRunDataByNode);
    set(selectedProcessPageNodesState, after.selectedProcessPages);
    setGraphScopedHistoryEntries(get, set, activeGraphId, after);
    set(commandHistoryStackStatePerGraph, {
      ...get(commandHistoryStackStatePerGraph),
      [activeGraphId]: [...(get(commandHistoryStackStatePerGraph)[activeGraphId] ?? []), historyEntry],
    });
    set(redoStackStatePerGraph, {
      ...get(redoStackStatePerGraph),
      [activeGraphId]: [],
    });
    set(graphBuilderEditorRevisionState, get(graphBuilderEditorRevisionState) + 1);
    set(
      projectUnsavedChangesState,
      markProjectDirtyFlag(get(projectUnsavedChangesState), currentProject.metadata.id, true),
    );

    return rememberOutcome(get, set, input.prepared, {
      status: 'committed',
      commitId: input.prepared.commitId,
      draftRevision: input.prepared.draftRevision,
      summary: input.prepared.summary,
    });
  },
);

export function captureGraphBuilderEditorContext(
  store: JotaiStore,
  ownerSessionId?: string,
): GraphBuilderEditorContext {
  return captureGraphBuilderEditorContextFromGetter((target) => store.get(target), ownerSessionId);
}

export function prepareGraphBuilderCommit(options: {
  base: GraphBuilderBaseIdentity;
  commitId?: string;
  draft: Omit<Project, 'data'>;
  draftRevision: number;
  ownerSessionId?: string;
  summary: string;
}): PreparedGraphBuilderCommit {
  const nextGraph = options.draft.graphs[options.base.activeGraphId];
  if (!nextGraph) {
    throw new Error('The Graph Builder draft no longer contains the active graph.');
  }

  const nextGraphs = collectChangedGraphSnapshots(options.base, options.draft);
  const canonicalContent = canonicalPreparedCommitContent({
    base: options.base,
    draftRevision: options.draftRevision,
    nextGraph,
    nextGraphs,
    ownerSessionId: options.ownerSessionId,
    summary: options.summary,
  });

  const retainedNextGraphs = cloneDeep(nextGraphs);
  const retainedNextGraph = retainedNextGraphs[options.base.activeGraphId] ?? cloneDeep(nextGraph);
  if (!retainedNextGraph) {
    throw new Error('The Graph Builder draft cannot delete the active graph.');
  }

  return {
    base: options.base,
    canonicalContent,
    commitId: options.commitId ?? newId(),
    draftRevision: options.draftRevision,
    nextGraph: retainedNextGraph,
    nextGraphs: retainedNextGraphs,
    ...(options.ownerSessionId ? { ownerSessionId: options.ownerSessionId } : {}),
    summary: options.summary,
  };
}

export function getGraphBuilderEligibilityFromGetter(get: Getter, ownerSessionId?: string): GraphBuilderEligibility {
  if (get(isReadOnlyGraphState)) {
    return { eligible: false, reason: 'The current graph is read-only.' };
  }
  if (get(historicalGraphState)) {
    return { eligible: false, reason: 'Exit graph history comparison before using Graph Builder.' };
  }
  if (get(graphRunningState)) {
    return { eligible: false, reason: 'Stop the current graph run before using Graph Builder.' };
  }
  if (get(pluginsState).some((plugin) => !plugin.loaded && !plugin.error)) {
    return { eligible: false, reason: 'Wait for project plugins to finish loading.' };
  }

  const projectId = get(projectState).metadata.id;
  const graphId = get(graphState).metadata?.id;
  if (!projectId || !graphId) {
    return { eligible: false, reason: 'Graph Builder requires a stable project and graph identity.' };
  }

  const activeOwner = get(activeGraphBuilderSessionOwnerState);
  if (ownerSessionId) {
    if (!activeOwner || activeOwner.sessionId !== ownerSessionId || activeOwner.projectId !== projectId) {
      return {
        eligible: false,
        reason: 'This Graph Builder session no longer owns the current project.',
      };
    }
  } else if (activeOwner) {
    return {
      eligible: false,
      reason:
        activeOwner.projectId === projectId
          ? 'A Graph Builder session is already active for this project.'
          : 'Another Graph Builder session is active in this window.',
    };
  }

  return { eligible: true };
}

function captureGraphBuilderEditorContextFromGetter(get: Getter, ownerSessionId?: string): GraphBuilderEditorContext {
  const project = get(projectState);
  const graph = get(graphState);
  const referencedProjects = get(referencedProjectsState);
  const registry = get(projectNodeRegistryState);
  const snapshot = createGraphBuilderEditorSnapshot({
    graph,
    project,
    projectData: get(projectDataState),
  });
  const assistModel = resolveAiAssistModelSettings({
    selectedModel: get(selectedAssistModelState),
    customModel: get(aiAssistCustomModelState),
    customProviderBaseURL: get(aiAssistCustomProviderBaseURLState),
  });
  const authoringPreferences = resolveEditorPreferences(get(settingsState));

  return {
    assistModel,
    authoringPreferences,
    base: createGraphBuilderBaseIdentity({
      assistModel,
      authoringPreferences,
      editorRevision: get(graphBuilderEditorRevisionState),
      plugins: get(pluginsState),
      pluginRefreshCounter: get(pluginRefreshCounterState),
      projectPlugins: project.plugins,
      referencedProjects,
      registry,
      snapshot,
    }),
    eligibility: getGraphBuilderEligibilityFromGetter(get, ownerSessionId),
    project,
    referencedProjects,
    registry,
    snapshot,
  };
}

function captureHistorySnapshot(
  get: Getter,
  activeGraphId: GraphId,
  changedGraphIds: readonly GraphId[] = [activeGraphId],
): GraphBuilderHistorySnapshot {
  const currentProject = get(projectState);
  const recoverableConnectionsByGraph = get(recoverableNodeConnectionsStatePerGraph);
  const frozenNodeOutputsByGraph = get(frozenNodeOutputsState);
  const additionalGraphs = Object.fromEntries(
    changedGraphIds
      .filter((graphId) => graphId !== activeGraphId)
      .map((graphId) => [
        graphId,
        {
          frozenNodeOutputs: cloneDeep(frozenNodeOutputsByGraph[graphId]),
          persistedGraph: cloneDeep(currentProject.graphs[graphId]),
          recoverableConnections: cloneDeep(recoverableConnectionsByGraph[graphId]),
        } satisfies GraphBuilderRelatedGraphHistorySnapshot,
      ]),
  ) as Partial<Record<GraphId, GraphBuilderRelatedGraphHistorySnapshot>>;

  return {
    ...(Object.keys(additionalGraphs).length > 0 ? { additionalGraphs } : {}),
    editingNodeId: get(editingNodeState),
    expandedOutputNodeIds: [...get(expandedOutputNodeIdsState)],
    frozenNodeOutputs: cloneDeep(frozenNodeOutputsByGraph[activeGraphId]),
    fullscreenOutputNodeId: get(fullscreenOutputNodeState),
    graph: cloneDeep(get(graphState)),
    lastRunDataByNode: cloneDeep(get(lastRunDataByNodeState)),
    persistedGraph: cloneDeep(currentProject.graphs[activeGraphId]),
    recoverableConnections: cloneDeep(recoverableConnectionsByGraph[activeGraphId]),
    selectedNodeIds: [...get(selectedNodesState)],
    selectedProcessPages: { ...get(selectedProcessPageNodesState) },
  };
}

function createPostCommitHistorySnapshot(
  before: GraphBuilderHistorySnapshot,
  graph: NodeGraph,
): GraphBuilderHistorySnapshot {
  const survivingNodeIds = new Set(graph.nodes.map((node) => node.id));
  return {
    editingNodeId: before.editingNodeId && survivingNodeIds.has(before.editingNodeId) ? before.editingNodeId : null,
    expandedOutputNodeIds: before.expandedOutputNodeIds.filter((nodeId) => survivingNodeIds.has(nodeId)),
    frozenNodeOutputs: filterNodeRecord(before.frozenNodeOutputs, survivingNodeIds),
    fullscreenOutputNodeId:
      before.fullscreenOutputNodeId && survivingNodeIds.has(before.fullscreenOutputNodeId)
        ? before.fullscreenOutputNodeId
        : null,
    graph: cloneDeep(graph),
    lastRunDataByNode: filterNodeRecord(before.lastRunDataByNode, survivingNodeIds) ?? {},
    persistedGraph: cloneDeep(graph),
    recoverableConnections: filterRecoverableConnections(
      before.recoverableConnections,
      survivingNodeIds,
      graph.connections,
    ),
    selectedNodeIds: before.selectedNodeIds.filter((nodeId) => survivingNodeIds.has(nodeId)),
    selectedProcessPages: filterNodeRecord(before.selectedProcessPages, survivingNodeIds) ?? {},
  };
}

function createPostCommitRelatedGraphSnapshots(
  before: GraphBuilderHistorySnapshot['additionalGraphs'],
  nextGraphs: Partial<Record<GraphId, NodeGraph | null>>,
  activeGraphId: GraphId,
): GraphBuilderHistorySnapshot['additionalGraphs'] {
  const relatedGraphs: Partial<Record<GraphId, GraphBuilderRelatedGraphHistorySnapshot>> = {};
  for (const [rawGraphId, graph] of Object.entries(nextGraphs)) {
    const graphId = rawGraphId as GraphId;
    if (graphId === activeGraphId || graph === undefined) {
      continue;
    }
    const previous = before?.[graphId] ?? {
      frozenNodeOutputs: undefined,
      persistedGraph: undefined,
      recoverableConnections: undefined,
    };
    if (graph === null) {
      relatedGraphs[graphId] = {
        frozenNodeOutputs: undefined,
        persistedGraph: undefined,
        recoverableConnections: undefined,
      };
      continue;
    }

    const survivingNodeIds = new Set(graph.nodes.map((node) => node.id));
    relatedGraphs[graphId] = {
      frozenNodeOutputs: filterNodeRecord(previous.frozenNodeOutputs, survivingNodeIds),
      persistedGraph: cloneDeep(graph),
      recoverableConnections: filterRecoverableConnections(
        previous.recoverableConnections,
        survivingNodeIds,
        graph.connections,
      ),
    };
  }

  return Object.keys(relatedGraphs).length > 0 ? relatedGraphs : undefined;
}

function filterRecoverableConnections(
  entries: RecoverableNodeConnectionsByNode | undefined,
  survivingNodeIds: ReadonlySet<NodeId>,
  connections: readonly NodeConnection[],
): RecoverableNodeConnectionsByNode | undefined {
  if (!entries) {
    return undefined;
  }
  const liveConnectionIds = new Set(connections.map(connectionIdentity));
  const filtered = Object.fromEntries(
    Object.entries(entries).flatMap(([rawNodeId, nodeConnections]) => {
      const nodeId = rawNodeId as NodeId;
      if (!survivingNodeIds.has(nodeId)) {
        return [];
      }
      const survivingConnections = nodeConnections.filter(
        (connection) =>
          survivingNodeIds.has(connection.inputNodeId) &&
          survivingNodeIds.has(connection.outputNodeId) &&
          !liveConnectionIds.has(connectionIdentity(connection)),
      );
      return survivingConnections.length > 0 ? [[nodeId, survivingConnections]] : [];
    }),
  ) as RecoverableNodeConnectionsByNode;
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

function connectionIdentity(connection: NodeConnection): string {
  return graphBuilderStringTupleKey(
    connection.outputNodeId,
    connection.outputId,
    connection.inputNodeId,
    connection.inputId,
  );
}

function filterNodeRecord<T>(
  record: Record<NodeId, T> | undefined,
  survivingNodeIds: ReadonlySet<NodeId>,
): Record<NodeId, T> | undefined {
  if (!record) {
    return undefined;
  }
  const filtered = Object.fromEntries(
    Object.entries(record).filter(([rawNodeId]) => survivingNodeIds.has(rawNodeId as NodeId)),
  ) as Record<NodeId, T>;
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

function historyGraphSnapshots(
  activeGraphId: GraphId,
  snapshot: GraphBuilderHistorySnapshot,
): Array<[GraphId, GraphBuilderRelatedGraphHistorySnapshot]> {
  return [
    [
      activeGraphId,
      {
        frozenNodeOutputs: snapshot.frozenNodeOutputs,
        persistedGraph: snapshot.persistedGraph,
        recoverableConnections: snapshot.recoverableConnections,
      },
    ],
    ...(Object.entries(snapshot.additionalGraphs ?? {}) as Array<[GraphId, GraphBuilderRelatedGraphHistorySnapshot]>),
  ];
}

function setGraphScopedHistoryEntries(
  get: Getter,
  set: Setter,
  activeGraphId: GraphId,
  snapshot: GraphBuilderHistorySnapshot,
): void {
  const recoverableConnections = { ...get(recoverableNodeConnectionsStatePerGraph) };
  const frozenNodeOutputs = { ...get(frozenNodeOutputsState) };

  for (const [graphId, graphSnapshot] of historyGraphSnapshots(activeGraphId, snapshot)) {
    setGraphScopedRecordEntry(recoverableConnections, graphId, graphSnapshot.recoverableConnections);
    setGraphScopedRecordEntry(frozenNodeOutputs, graphId, graphSnapshot.frozenNodeOutputs);
  }

  set(recoverableNodeConnectionsStatePerGraph, recoverableConnections);
  set(frozenNodeOutputsState, frozenNodeOutputs);
}

function setGraphScopedRecordEntry<T>(
  record: Record<GraphId, T | undefined>,
  graphId: GraphId,
  value: T | undefined,
): void {
  if (value === undefined) {
    delete record[graphId];
  } else {
    record[graphId] = cloneDeep(value);
  }
}

function rememberOutcome(
  get: Getter,
  set: Setter,
  prepared: PreparedGraphBuilderCommit,
  outcome: GraphBuilderCommitOutcome,
): GraphBuilderCommitOutcome {
  const retainedOutcome = cloneDeep(outcome);
  const retainedEntries = Object.entries(get(graphBuilderCommitLedgerState)).slice(
    -(MAX_GRAPH_BUILDER_COMMIT_LEDGER_ENTRIES - 1),
  );
  set(graphBuilderCommitLedgerState, {
    ...Object.fromEntries(retainedEntries),
    [prepared.commitId]: {
      canonicalContent: prepared.canonicalContent,
      outcome: retainedOutcome,
    },
  });
  return cloneDeep(retainedOutcome);
}

function canonicalPreparedCommitContent(
  prepared: Pick<
    PreparedGraphBuilderCommit,
    'base' | 'draftRevision' | 'nextGraph' | 'nextGraphs' | 'ownerSessionId' | 'summary'
  >,
): string {
  return canonicalGraphBuilderAuthoringStringify({
    base: prepared.base,
    draftRevision: prepared.draftRevision,
    nextGraph: prepared.nextGraph,
    nextGraphs: prepared.nextGraphs ?? null,
    ownerSessionId: prepared.ownerSessionId ?? null,
    summary: prepared.summary,
  });
}

function collectChangedGraphSnapshots(
  base: GraphBuilderBaseIdentity,
  draft: Omit<Project, 'data'>,
): Partial<Record<GraphId, NodeGraph | null>> {
  const baseProject = readBaseAuthoringProject(base);
  const graphIds = new Set<GraphId>([
    ...(Object.keys(baseProject.graphs) as GraphId[]),
    ...(Object.keys(draft.graphs) as GraphId[]),
  ]);
  const changes: Partial<Record<GraphId, NodeGraph | null>> = {};

  for (const graphId of graphIds) {
    const before = baseProject.graphs[graphId];
    const after = draft.graphs[graphId];
    if (after === undefined) {
      changes[graphId] = null;
    } else if (
      before === undefined ||
      canonicalGraphBuilderAuthoringStringify(before) !== canonicalGraphBuilderAuthoringStringify(after)
    ) {
      changes[graphId] = cloneDeep(after);
    }
  }

  // Preserve the long-standing single-graph commit behavior: committing any
  // draft also publishes the authoritative live active graph into project
  // state, including a previously transient canvas.
  changes[base.activeGraphId] = cloneDeep(draft.graphs[base.activeGraphId]!);

  return changes;
}

function readBaseAuthoringProject(base: GraphBuilderBaseIdentity): Omit<Project, 'data'> {
  const identity = JSON.parse(base.projectCanonicalIdentity) as {
    project?: Omit<Project, 'data'>;
  };
  if (!identity.project || typeof identity.project !== 'object' || !identity.project.graphs) {
    throw new Error('The Graph Builder base identity does not contain an authoring project.');
  }
  return identity.project;
}

function resolvePreparedGraphChanges(prepared: PreparedGraphBuilderCommit): Partial<Record<GraphId, NodeGraph | null>> {
  if (prepared.nextGraphs === undefined) {
    return { [prepared.base.activeGraphId]: prepared.nextGraph };
  }

  for (const [rawGraphId, graph] of Object.entries(prepared.nextGraphs)) {
    if (graph === undefined) {
      throw new Error(`Prepared graph "${rawGraphId}" is undefined.`);
    }
  }

  const preparedActiveGraph = prepared.nextGraphs[prepared.base.activeGraphId];
  if (
    preparedActiveGraph !== undefined &&
    preparedActiveGraph !== null &&
    canonicalGraphBuilderAuthoringStringify(preparedActiveGraph) !==
      canonicalGraphBuilderAuthoringStringify(prepared.nextGraph)
  ) {
    throw new Error('The prepared active graph snapshots do not match.');
  }

  return prepared.nextGraphs;
}
