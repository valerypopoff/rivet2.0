import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBuiltInRegistry,
  type ExternalFunctionProcessContext,
  type GraphId,
  type NodeGraph,
  type Project,
  type ProjectId,
} from '@valerypopoff/rivet2-core';
import { createStore } from 'jotai/vanilla';
import { commandHistoryStackStatePerGraph } from '../../commands/Command.js';
import { graphState } from '../../state/graph.js';
import { activeGraphBuilderSessionOwnerState } from '../../state/graphBuilderAi.js';
import { projectNodeRegistryState } from '../../state/plugins.js';
import { projectState } from '../../state/savedGraphs.js';
import { createGraphBuilderAuthoringCatalog } from './authoringCatalog.js';
import {
  captureGraphBuilderEditorContext,
  prepareGraphBuilderCommit,
  publishGraphBuilderHistorySnapshotState,
  tryCommitGraphBuilderDraftState,
} from './editorGateway.js';
import { runLegacyGraphBuilderDraft } from './legacyDraftRunner.js';

const projectId = 'legacy-gateway-project' as ProjectId;
const graphId = 'legacy-gateway-graph' as GraphId;
const sessionId = 'legacy-gateway-session';

test('legacy preview is zero-write and Apply creates one atomic history entry', async () => {
  const store = createReadyStore();
  const context = captureOwnedContext(store);
  const result = await createPrivateLegacyDraft(context);

  assert.equal(result.status, 'ready-for-preview');
  assert.equal(store.get(graphState).nodes.length, 0);
  assert.equal(store.get(projectState).graphs[graphId]?.nodes.length, 0);
  assert.equal(store.get(commandHistoryStackStatePerGraph)[graphId], undefined);

  const outcome = store.set(tryCommitGraphBuilderDraftState, {
    prepared: prepareGraphBuilderCommit({
      base: context.base,
      commitId: `${sessionId}:commit`,
      draft: result.draft,
      draftRevision: result.draftRevision,
      ownerSessionId: sessionId,
      summary: result.preview.summary,
    }),
    publishHistorySnapshot: (activeGraphId, snapshot) =>
      store.set(publishGraphBuilderHistorySnapshotState, { activeGraphId, snapshot }),
  });

  assert.equal(outcome.status, 'committed');
  assert.equal(store.get(graphState).nodes.length, 1);
  assert.equal(store.get(projectState).graphs[graphId]?.nodes.length, 1);
  assert.equal(store.get(commandHistoryStackStatePerGraph)[graphId]?.length, 1);
});

test('legacy Apply conflicts after an intervening editor change and never overwrites it', async () => {
  const store = createReadyStore();
  const context = captureOwnedContext(store);
  const result = await createPrivateLegacyDraft(context);
  assert.equal(result.status, 'ready-for-preview');

  store.set(graphState, graph('User edit'));
  const outcome = store.set(tryCommitGraphBuilderDraftState, {
    prepared: prepareGraphBuilderCommit({
      base: context.base,
      commitId: `${sessionId}:conflict`,
      draft: result.draft,
      draftRevision: result.draftRevision,
      ownerSessionId: sessionId,
      summary: result.preview.summary,
    }),
    publishHistorySnapshot: (activeGraphId, snapshot) =>
      store.set(publishGraphBuilderHistorySnapshotState, { activeGraphId, snapshot }),
  });

  assert.equal(outcome.status, 'conflicted');
  assert.equal(store.get(graphState).metadata?.name, 'User edit');
  assert.equal(store.get(graphState).nodes.length, 0);
  assert.equal(store.get(projectState).graphs[graphId]?.nodes.length, 0);
  assert.equal(store.get(commandHistoryStackStatePerGraph)[graphId], undefined);
});

function graph(name: string): NodeGraph {
  return {
    metadata: { id: graphId, name, description: '' },
    nodes: [],
    connections: [],
  };
}

function createReadyStore() {
  const store = createStore();
  const activeGraph = graph('Before');
  const project: Omit<Project, 'data'> = {
    metadata: { id: projectId, title: 'Project', description: '' },
    graphs: { [graphId]: activeGraph },
    plugins: [],
  };
  store.set(projectState, project);
  store.set(graphState, activeGraph);
  store.set(projectNodeRegistryState, createBuiltInRegistry());
  store.set(activeGraphBuilderSessionOwnerState, { projectId, sessionId });
  return store;
}

function captureOwnedContext(store: ReturnType<typeof createStore>) {
  const context = captureGraphBuilderEditorContext(store, sessionId);
  assert.equal(context.eligibility.eligible, true);
  return context;
}

async function createPrivateLegacyDraft(context: ReturnType<typeof captureGraphBuilderEditorContext>) {
  const catalog = createGraphBuilderAuthoringCatalog({
    registry: context.registry,
    project: context.snapshot.authoringProject,
    referencedProjects: context.referencedProjects,
  });
  return runLegacyGraphBuilderDraft({
    abortSignal: new AbortController().signal,
    activeGraphId: graphId,
    baseProject: context.snapshot.authoringProject,
    catalog,
    executeAgent: async ({ externalFunctions, onUserEvent }) => {
      await externalFunctions.createNode!({} as ExternalFunctionProcessContext, 'Text');
      onUserEvent.finalMessage?.({ type: 'string', value: 'Prepared one text node.' });
    },
    referencedProjects: context.referencedProjects,
    registry: context.registry,
    request: 'Add one text node.',
  });
}
