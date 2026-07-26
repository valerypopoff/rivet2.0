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
import type { createStore, Getter, PrimitiveAtom, Setter } from 'jotai/vanilla';
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
    if (input.snapshot.persistedGraph) {
      nextGraphs[input.activeGraphId] = cloneDeep(input.snapshot.persistedGraph);
    } else {
      delete nextGraphs[input.activeGraphId];
    }

    set(projectState, { ...currentProject, graphs: nextGraphs });
    set(graphState, cloneDeep(input.snapshot.graph));
    set(selectedNodesState, [...input.snapshot.selectedNodeIds]);
    set(editingNodeState, input.snapshot.editingNodeId);
    set(fullscreenOutputNodeState, input.snapshot.fullscreenOutputNodeId);
    set(expandedOutputNodeIdsState, [...input.snapshot.expandedOutputNodeIds]);
    set(lastRunDataByNodeState, cloneDeep(input.snapshot.lastRunDataByNode));
    set(selectedProcessPageNodesState, { ...input.snapshot.selectedProcessPages });
    setGraphScopedEntry(
      get(recoverableNodeConnectionsStatePerGraph),
      input.activeGraphId,
      input.snapshot.recoverableConnections,
      set,
      recoverableNodeConnectionsStatePerGraph,
    );
    setGraphScopedEntry(
      get(frozenNodeOutputsState),
      input.activeGraphId,
      input.snapshot.frozenNodeOutputs,
      set,
      frozenNodeOutputsState,
    );
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
    if (input.prepared.nextGraph.metadata?.id !== activeGraphId) {
      return rememberOutcome(get, set, input.prepared, {
        status: 'protocol-error',
        commitId: input.prepared.commitId,
        reason: 'The prepared graph does not match the session active graph.',
      });
    }
    const before = captureHistorySnapshot(get, activeGraphId);
    const after = createPostCommitHistorySnapshot(before, input.prepared.nextGraph);
    const currentProject = get(projectState);
    const nextProject = {
      ...currentProject,
      graphs: {
        ...currentProject.graphs,
        [activeGraphId]: cloneDeep(input.prepared.nextGraph),
      },
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
    set(graphState, cloneDeep(input.prepared.nextGraph));
    set(selectedNodesState, after.selectedNodeIds);
    set(editingNodeState, after.editingNodeId);
    set(fullscreenOutputNodeState, after.fullscreenOutputNodeId);
    set(expandedOutputNodeIdsState, after.expandedOutputNodeIds);
    set(lastRunDataByNodeState, after.lastRunDataByNode);
    set(selectedProcessPageNodesState, after.selectedProcessPages);
    setGraphScopedEntry(
      get(recoverableNodeConnectionsStatePerGraph),
      activeGraphId,
      after.recoverableConnections,
      set,
      recoverableNodeConnectionsStatePerGraph,
    );
    setGraphScopedEntry(
      get(frozenNodeOutputsState),
      activeGraphId,
      after.frozenNodeOutputs,
      set,
      frozenNodeOutputsState,
    );
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

  const canonicalContent = canonicalPreparedCommitContent({
    base: options.base,
    draftRevision: options.draftRevision,
    nextGraph,
    ownerSessionId: options.ownerSessionId,
    summary: options.summary,
  });

  return {
    base: options.base,
    canonicalContent,
    commitId: options.commitId ?? newId(),
    draftRevision: options.draftRevision,
    nextGraph: cloneDeep(nextGraph),
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

function captureHistorySnapshot(get: Getter, activeGraphId: GraphId): GraphBuilderHistorySnapshot {
  const currentProject = get(projectState);
  return {
    editingNodeId: get(editingNodeState),
    expandedOutputNodeIds: [...get(expandedOutputNodeIdsState)],
    frozenNodeOutputs: cloneDeep(get(frozenNodeOutputsState)[activeGraphId]),
    fullscreenOutputNodeId: get(fullscreenOutputNodeState),
    graph: cloneDeep(get(graphState)),
    lastRunDataByNode: cloneDeep(get(lastRunDataByNodeState)),
    persistedGraph: cloneDeep(currentProject.graphs[activeGraphId]),
    recoverableConnections: cloneDeep(get(recoverableNodeConnectionsStatePerGraph)[activeGraphId]),
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

function setGraphScopedEntry<T, TRecord extends Record<GraphId, T | undefined>>(
  current: TRecord,
  graphId: GraphId,
  value: T | undefined,
  set: Setter,
  target: PrimitiveAtom<TRecord>,
): void {
  const next: Record<GraphId, T | undefined> = { ...current };
  if (value === undefined) {
    delete next[graphId];
  } else {
    next[graphId] = cloneDeep(value);
  }
  set(target, next as TRecord);
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
  prepared: Pick<PreparedGraphBuilderCommit, 'base' | 'draftRevision' | 'nextGraph' | 'ownerSessionId' | 'summary'>,
): string {
  return canonicalGraphBuilderAuthoringStringify({
    base: prepared.base,
    draftRevision: prepared.draftRevision,
    nextGraph: prepared.nextGraph,
    ownerSessionId: prepared.ownerSessionId ?? null,
    summary: prepared.summary,
  });
}
