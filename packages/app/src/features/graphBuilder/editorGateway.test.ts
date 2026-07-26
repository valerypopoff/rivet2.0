import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBuiltInRegistry,
  type ChartNode,
  type GraphId,
  type NodeConnection,
  type NodeGraph,
  type NodeId,
  type PortId,
  type Project,
  type ProjectId,
} from '@valerypopoff/rivet2-core';
import { createStore } from 'jotai/vanilla';
import { commandHistoryStackStatePerGraph } from '../../commands/Command.js';
import { graphState } from '../../state/graph.js';
import { activeGraphBuilderSessionOwnerState } from '../../state/graphBuilderAi.js';
import { projectNodeRegistryState } from '../../state/plugins.js';
import { recoverableNodeConnectionsStatePerGraph } from '../../state/recoverableNodeConnections.js';
import { projectState } from '../../state/savedGraphs.js';
import {
  captureGraphBuilderEditorContext,
  type GraphBuilderHistorySnapshot,
  prepareGraphBuilderCommit,
  publishGraphBuilderHistorySnapshotState,
  tryCommitGraphBuilderDraftState,
} from './editorGateway.js';

const projectId = 'project' as ProjectId;
const graphId = 'graph' as GraphId;
const siblingGraphId = 'sibling' as GraphId;

function graph(id: GraphId, name: string): NodeGraph {
  return {
    metadata: { id, name, description: '' },
    nodes: [],
    connections: [],
  };
}

function node(id: string): ChartNode {
  return {
    id: id as NodeId,
    type: 'text',
    title: id,
    visualData: { x: 0, y: 0 },
    data: { text: id },
  };
}

function connection(outputNodeId: string, inputNodeId: string): NodeConnection {
  return {
    outputNodeId: outputNodeId as NodeId,
    outputId: 'output' as PortId,
    inputNodeId: inputNodeId as NodeId,
    inputId: 'input' as PortId,
  };
}

function project(activeGraph = graph(graphId, 'Before')): Omit<Project, 'data'> {
  return {
    metadata: { id: projectId, title: 'Project', description: '' },
    graphs: {
      [graphId]: activeGraph,
      [siblingGraphId]: graph(siblingGraphId, 'Sibling'),
    },
    plugins: [],
  };
}

function createReadyStore() {
  const store = createStore();
  store.set(projectState, project());
  store.set(graphState, graph(graphId, 'Before'));
  store.set(projectNodeRegistryState, createBuiltInRegistry());
  return store;
}

function prepareChangedCommit(store: ReturnType<typeof createStore>, commitId = 'commit') {
  const context = captureGraphBuilderEditorContext(store);
  const draft = structuredClone(context.snapshot.authoringProject);
  draft.graphs[graphId]!.metadata!.name = 'After';
  return prepareGraphBuilderCommit({
    base: context.base,
    commitId,
    draft,
    draftRevision: 1,
    summary: 'Renamed the graph.',
  });
}

test('commit publishes graph, project and one history entry as one observable transaction', () => {
  const store = createReadyStore();
  const prepared = prepareChangedCommit(store);
  let notificationCount = 0;
  const assertCompletePublication = () => {
    notificationCount += 1;
    assert.equal(store.get(graphState).metadata?.name, 'After');
    assert.equal(store.get(projectState).graphs[graphId]?.metadata?.name, 'After');
    assert.equal(store.get(commandHistoryStackStatePerGraph)[graphId]?.length, 1);
  };
  const unsubscribers = [
    store.sub(graphState, assertCompletePublication),
    store.sub(projectState, assertCompletePublication),
    store.sub(commandHistoryStackStatePerGraph, assertCompletePublication),
  ];

  const outcome = store.set(tryCommitGraphBuilderDraftState, {
    prepared,
    publishHistorySnapshot: (activeGraphId, snapshot) =>
      store.set(publishGraphBuilderHistorySnapshotState, { activeGraphId, snapshot }),
  });

  for (const unsubscribe of unsubscribers) {
    unsubscribe();
  }
  assert.equal(outcome.status, 'committed');
  assert.ok(notificationCount >= 1);
});

test('commit is idempotent and rejects same-ID different-content reuse', () => {
  const store = createReadyStore();
  const prepared = prepareChangedCommit(store);
  const input = {
    prepared,
    publishHistorySnapshot: (activeGraphId: GraphId, snapshot: GraphBuilderHistorySnapshot) =>
      store.set(publishGraphBuilderHistorySnapshotState, { activeGraphId, snapshot }),
  };
  const first = store.set(tryCommitGraphBuilderDraftState, input);
  const replay = store.set(tryCommitGraphBuilderDraftState, input);
  const changed = store.set(tryCommitGraphBuilderDraftState, {
    ...input,
    prepared: { ...prepared, canonicalContent: `${prepared.canonicalContent} changed` },
  });

  assert.equal(first.status, 'committed');
  assert.deepEqual(replay, first);
  assert.equal(changed.status, 'protocol-error');
  assert.equal(store.get(commandHistoryStackStatePerGraph)[graphId]?.length, 1);
});

test('commit replay is isolated from caller mutation of earlier outcomes', () => {
  const store = createReadyStore();
  const prepared = prepareChangedCommit(store, 'isolated-replay');
  const input = {
    prepared,
    publishHistorySnapshot: (activeGraphId: GraphId, snapshot: GraphBuilderHistorySnapshot) =>
      store.set(publishGraphBuilderHistorySnapshotState, { activeGraphId, snapshot }),
  };

  const first = store.set(tryCommitGraphBuilderDraftState, input);
  assert.equal(first.status, 'committed');
  (first as { status: string; summary?: string }).status = 'protocol-error';
  (first as { summary?: string }).summary = 'Caller mutation';

  const replay = store.set(tryCommitGraphBuilderDraftState, input);
  assert.notEqual(replay, first);
  assert.deepEqual(replay, {
    status: 'committed',
    commitId: 'isolated-replay',
    draftRevision: 1,
    summary: 'Renamed the graph.',
  });

  (replay as { summary?: string }).summary = 'Second caller mutation';
  assert.deepEqual(store.set(tryCommitGraphBuilderDraftState, input), {
    status: 'committed',
    commitId: 'isolated-replay',
    draftRevision: 1,
    summary: 'Renamed the graph.',
  });
});

test('commit replay revalidates effective content before consulting the idempotency ledger', () => {
  const store = createReadyStore();
  const prepared = prepareChangedCommit(store);
  const input = {
    prepared,
    publishHistorySnapshot: (activeGraphId: GraphId, snapshot: GraphBuilderHistorySnapshot) =>
      store.set(publishGraphBuilderHistorySnapshotState, { activeGraphId, snapshot }),
  };
  const first = store.set(tryCommitGraphBuilderDraftState, input);
  prepared.nextGraph.metadata!.name = 'Mutated after commit';
  const replay = store.set(tryCommitGraphBuilderDraftState, input);

  assert.equal(first.status, 'committed');
  assert.equal(replay.status, 'protocol-error');
  assert.equal(store.get(graphState).metadata?.name, 'After');
  assert.equal(store.get(projectState).graphs[graphId]?.metadata?.name, 'After');
  assert.equal(store.get(commandHistoryStackStatePerGraph)[graphId]?.length, 1);
});

test('commit replay binds the complete base identity and user-visible summary', () => {
  const store = createReadyStore();
  const prepared = prepareChangedCommit(store);
  const input = {
    prepared,
    publishHistorySnapshot: (activeGraphId: GraphId, snapshot: GraphBuilderHistorySnapshot) =>
      store.set(publishGraphBuilderHistorySnapshotState, { activeGraphId, snapshot }),
  };
  const first = store.set(tryCommitGraphBuilderDraftState, input);

  prepared.base.policyConfigFingerprint = 'mutated-policy-config';
  prepared.summary = 'Mutated after commit.';
  const replay = store.set(tryCommitGraphBuilderDraftState, input);

  assert.equal(first.status, 'committed');
  assert.equal(replay.status, 'protocol-error');
  assert.equal(store.get(graphState).metadata?.name, 'After');
  assert.equal(store.get(commandHistoryStackStatePerGraph)[graphId]?.length, 1);
});

test('commit rejects a prepared graph mutated after canonicalization', () => {
  const store = createReadyStore();
  const prepared = prepareChangedCommit(store);
  prepared.nextGraph.metadata!.name = 'Mutated after prepare';

  const outcome = store.set(tryCommitGraphBuilderDraftState, {
    prepared,
    publishHistorySnapshot: (activeGraphId, snapshot) =>
      store.set(publishGraphBuilderHistorySnapshotState, { activeGraphId, snapshot }),
  });

  assert.equal(outcome.status, 'protocol-error');
  assert.equal(store.get(graphState).metadata?.name, 'Before');
  assert.equal(store.get(projectState).graphs[graphId]?.metadata?.name, 'Before');
  assert.equal(store.get(commandHistoryStackStatePerGraph)[graphId], undefined);
});

test('commit identity binds the owner session used when it was prepared', () => {
  const store = createReadyStore();
  store.set(activeGraphBuilderSessionOwnerState, {
    projectId,
    sessionId: 'owner',
  });
  const context = captureGraphBuilderEditorContext(store, 'owner');
  const draft = structuredClone(context.snapshot.authoringProject);
  draft.graphs[graphId]!.metadata!.name = 'After';
  const prepared = prepareGraphBuilderCommit({
    base: context.base,
    commitId: 'owned-commit',
    draft,
    draftRevision: 1,
    ownerSessionId: 'owner',
    summary: 'Renamed the graph.',
  });
  prepared.ownerSessionId = 'different-owner';

  const outcome = store.set(tryCommitGraphBuilderDraftState, {
    prepared,
    publishHistorySnapshot: (activeGraphId, snapshot) =>
      store.set(publishGraphBuilderHistorySnapshotState, { activeGraphId, snapshot }),
  });

  assert.equal(outcome.status, 'protocol-error');
  assert.equal(store.get(graphState).metadata?.name, 'Before');
  assert.equal(store.get(commandHistoryStackStatePerGraph)[graphId], undefined);
});

test('commit returns a protocol error when prepared content becomes non-portable', () => {
  const store = createReadyStore();
  const prepared = prepareChangedCommit(store);
  (prepared.nextGraph.metadata as unknown as Record<string, unknown>).cycle = prepared.nextGraph;

  const outcome = store.set(tryCommitGraphBuilderDraftState, {
    prepared,
    publishHistorySnapshot: (activeGraphId, snapshot) =>
      store.set(publishGraphBuilderHistorySnapshotState, { activeGraphId, snapshot }),
  });

  assert.equal(outcome.status, 'protocol-error');
  assert.equal(store.get(graphState).metadata?.name, 'Before');
  assert.equal(store.get(projectState).graphs[graphId]?.metadata?.name, 'Before');
  assert.equal(store.get(commandHistoryStackStatePerGraph)[graphId], undefined);
});

test('a stale authoritative graph conflicts without writes', () => {
  const store = createReadyStore();
  const prepared = prepareChangedCommit(store);
  store.set(graphState, graph(graphId, 'User edit'));

  const outcome = store.set(tryCommitGraphBuilderDraftState, {
    prepared,
    publishHistorySnapshot: (activeGraphId, snapshot) =>
      store.set(publishGraphBuilderHistorySnapshotState, { activeGraphId, snapshot }),
  });

  assert.equal(outcome.status, 'conflicted');
  assert.equal(store.get(graphState).metadata?.name, 'User edit');
  assert.equal(store.get(projectState).graphs[graphId]?.metadata?.name, 'Before');
  assert.equal(store.get(commandHistoryStackStatePerGraph)[graphId], undefined);
});

test('captured sessions must retain exact ownership of the current project', () => {
  const store = createReadyStore();
  assert.equal(captureGraphBuilderEditorContext(store).eligibility.eligible, true);

  store.set(activeGraphBuilderSessionOwnerState, {
    projectId,
    sessionId: 'owner',
  });
  assert.equal(captureGraphBuilderEditorContext(store).eligibility.eligible, false);
  assert.equal(captureGraphBuilderEditorContext(store, 'owner').eligibility.eligible, true);
  assert.equal(captureGraphBuilderEditorContext(store, 'different-owner').eligibility.eligible, false);

  store.set(activeGraphBuilderSessionOwnerState, undefined);
  assert.equal(captureGraphBuilderEditorContext(store, 'owner').eligibility.eligible, false);
});

test('history inverse and forward snapshots preserve an unrelated sibling graph', () => {
  const store = createReadyStore();
  const prepared = prepareChangedCommit(store);
  store.set(tryCommitGraphBuilderDraftState, {
    prepared,
    publishHistorySnapshot: (activeGraphId, snapshot) =>
      store.set(publishGraphBuilderHistorySnapshotState, { activeGraphId, snapshot }),
  });
  const entry = store.get(commandHistoryStackStatePerGraph)[graphId]![0]!;

  store.set(projectState, {
    ...store.get(projectState),
    graphs: {
      ...store.get(projectState).graphs,
      [siblingGraphId]: graph(siblingGraphId, 'Sibling user edit'),
    },
  });
  entry.command.undo(entry.data, entry.appliedData, {} as never);
  assert.equal(store.get(graphState).metadata?.name, 'Before');
  assert.equal(store.get(projectState).graphs[siblingGraphId]?.metadata?.name, 'Sibling user edit');

  entry.command.apply(entry.data, entry.appliedData, {} as never);
  assert.equal(store.get(graphState).metadata?.name, 'After');
  assert.equal(store.get(projectState).graphs[siblingGraphId]?.metadata?.name, 'Sibling user edit');
});

test('commit preserves disconnected recovery wires only while their endpoints survive and they remain disconnected', () => {
  const store = createReadyStore();
  const beforeGraph = graph(graphId, 'Before');
  beforeGraph.nodes = [node('source'), node('target'), node('removed')];
  store.set(projectState, project(beforeGraph));
  store.set(graphState, structuredClone(beforeGraph));

  const recoverable = connection('source', 'target');
  const removedEndpoint = connection('source', 'removed');
  const restoredLive = connection('target', 'source');
  store.set(recoverableNodeConnectionsStatePerGraph, {
    [graphId]: {
      ['source' as NodeId]: [recoverable, removedEndpoint, restoredLive],
    },
  });

  const context = captureGraphBuilderEditorContext(store);
  const draft = structuredClone(context.snapshot.authoringProject);
  draft.graphs[graphId]!.metadata!.name = 'After';
  draft.graphs[graphId]!.nodes = draft.graphs[graphId]!.nodes.filter((candidate) => candidate.id !== 'removed');
  draft.graphs[graphId]!.connections = [restoredLive];
  const prepared = prepareGraphBuilderCommit({
    base: context.base,
    commitId: 'recoverable-connections',
    draft,
    draftRevision: 1,
    summary: 'Edited the graph without touching an unrelated disconnected wire.',
  });

  const outcome = store.set(tryCommitGraphBuilderDraftState, {
    prepared,
    publishHistorySnapshot: (activeGraphId, snapshot) =>
      store.set(publishGraphBuilderHistorySnapshotState, { activeGraphId, snapshot }),
  });

  assert.equal(outcome.status, 'committed');
  assert.deepEqual(store.get(recoverableNodeConnectionsStatePerGraph)[graphId], {
    ['source' as NodeId]: [recoverable],
  });

  const entry = store.get(commandHistoryStackStatePerGraph)[graphId]![0]!;
  entry.command.undo(entry.data, entry.appliedData, {} as never);
  assert.deepEqual(store.get(recoverableNodeConnectionsStatePerGraph)[graphId], {
    ['source' as NodeId]: [recoverable, removedEndpoint, restoredLive],
  });

  entry.command.apply(entry.data, entry.appliedData, {} as never);
  assert.deepEqual(store.get(recoverableNodeConnectionsStatePerGraph)[graphId], {
    ['source' as NodeId]: [recoverable],
  });
});
