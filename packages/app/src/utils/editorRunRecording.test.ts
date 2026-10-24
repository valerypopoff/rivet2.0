import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deserializeProject,
  deserializeDatasets,
  type CombinedDataset,
  type DatasetId,
} from '@valerypopoff/rivet2-core';
import type { LocalExecutionRecordingPersistenceProvider } from '../providers/ProvidersContext.js';
import { createBlankProjectWithDefaultGraph } from './blankProject.js';
import { EditorRunSession } from '../hooks/editorRunSession.js';
import { persistEditorRunRecording, prepareEditorRecordingPersistence } from './editorRunRecording.js';

type Artifact = Parameters<LocalExecutionRecordingPersistenceProvider['persist']>[0];

function fixture() {
  const writes: Artifact[] = [];
  const unavailable: string[] = [];
  let capabilityReads = 0;
  const provider: LocalExecutionRecordingPersistenceProvider = {
    getCapability: async () => {
      capabilityReads++;
      return true;
    },
    persist: async (artifact) => {
      writes.push(artifact);
    },
    markUnavailable: async (id) => {
      unavailable.push(id);
    },
  };
  const project = createBlankProjectWithDefaultGraph();
  const datasetId = 'captured-dataset' as DatasetId;
  const datasets: CombinedDataset[] = [
    {
      meta: { id: datasetId, projectId: project.metadata.id, name: 'Captured dataset', description: '' },
      data: { id: datasetId, rows: [{ id: 'row', data: ['captured value'] }] },
    },
  ];
  const input = {
    source: 'browser' as const,
    recorder: { serialize: () => 'recorded-events' },
    project,
    graphId: project.metadata.mainGraphId!,
    createdAt: '2026-10-24T09:00:00.000Z',
    startedAt: performance.now(),
    status: 'succeeded' as const,
    exportDatasets: async () => datasets,
  };
  return { provider, writes, unavailable, input, datasets, capabilityReads: () => capabilityReads };
}

test('recording destinations are opt-in, capability checked and scoped to one correlation', async () => {
  const { provider, capabilityReads } = fixture();
  for (const options of [
    { eligible: false, projectPath: 'project.rivet-project', provider },
    { eligible: true, provider },
    { eligible: true, projectPath: 'project.rivet-project' },
  ])
    assert.equal(await prepareEditorRecordingPersistence(options), undefined);
  assert.equal(capabilityReads(), 0);
  const options = { eligible: true, projectPath: 'project.rivet-project', provider };
  const first = await prepareEditorRecordingPersistence(options);
  const next = await prepareEditorRecordingPersistence(options);
  assert.equal(capabilityReads(), 2);
  assert.equal(first!.provider, provider);
  assert.equal(first!.projectPath, options.projectPath);
  assert.match(first!.correlationId, /^rvt-local-/);
  assert.notEqual(next!.correlationId, first!.correlationId);
  for (const getCapability of [
    async () => false,
    async () => {
      throw new Error('capability read failed');
    },
    () => {
      throw new Error('synchronous capability failure');
    },
  ])
    assert.equal(
      await prepareEditorRecordingPersistence({ ...options, provider: { ...provider, getCapability } }),
      undefined,
    );
});

test('Browser and Node persist the same artifact policy without changing captured outcome or timestamps', async () => {
  for (const source of ['browser', 'node'] as const) {
    for (const status of ['succeeded', 'failed', 'suspicious'] as const) {
      const { input, provider, writes, unavailable, datasets } = fixture();
      const persistence = await prepareEditorRecordingPersistence({
        eligible: true,
        projectPath: 'run.rivet-project',
        provider,
      });
      const published: string[] = [];
      await persistEditorRunRecording({
        ...input,
        source,
        status,
        persistence,
        errorMessage: 'captured diagnostic',
        onSerialized: (recording) => {
          published.push(recording);
          if (source === 'browser' && status === 'failed') throw new Error('Replay display observer failed');
        },
      });
      assert.deepEqual(published, ['recorded-events']);
      assert.equal(writes.length, 1);
      const artifact = writes[0]!;
      assert.equal(artifact.status, status);
      assert.equal(artifact.errorMessage, 'captured diagnostic');
      assert.equal(artifact.createdAt, input.createdAt);
      assert.equal(artifact.projectId, input.project.metadata.id);
      assert.equal(artifact.projectPath, 'run.rivet-project');
      assert.equal(artifact.recordingSerialized, 'recorded-events');
      assert.ok(Number.isFinite(artifact.durationMs) && artifact.durationMs >= 0);
      assert.deepEqual(artifact.executionIdentity, {
        correlationId: persistence!.correlationId,
        graphId: input.graphId,
      });
      assert.equal(deserializeProject(artifact.projectContents)[0].metadata.id, input.project.metadata.id);
      assert.deepEqual(deserializeDatasets(artifact.datasetsContents!), datasets);
      assert.deepEqual(unavailable, []);
    }
  }
});

test('without a hosted destination Browser retains replay without serializing project or exporting datasets', async () => {
  const { input } = fixture();
  const published: string[] = [];
  let projectReads = 0,
    datasetExports = 0;
  const graphs = input.project.graphs;
  Object.defineProperty(input.project, 'graphs', {
    enumerable: true,
    get: () => {
      projectReads++;
      return graphs;
    },
  });
  await persistEditorRunRecording({
    ...input,
    exportDatasets: async () => {
      datasetExports++;
      return [];
    },
    onSerialized: (recording) => published.push(recording),
  });
  assert.deepEqual(published, ['recorded-events']);
  assert.equal(projectReads, 0);
  assert.equal(datasetExports, 0);
});

test('serialization, dataset and uncertain-write failures report unavailability without retry or failing execution', async () => {
  for (const failure of ['serialization', 'datasets', 'upload'] as const) {
    const { input, provider, writes, unavailable } = fixture();
    const persistence = await prepareEditorRecordingPersistence({
      eligible: true,
      projectPath: 'run.rivet-project',
      provider,
    });
    provider.markUnavailable = async (id) => {
      unavailable.push(id);
      throw new Error('unavailable report also failed');
    };
    provider.persist = async (artifact) => {
      writes.push(artifact);
      throw new Error('uncertain write');
    };
    await persistEditorRunRecording({
      ...input,
      persistence,
      recorder: {
        serialize: () => {
          if (failure === 'serialization') throw new Error('serialize');
          return 'events';
        },
      },
      exportDatasets: async () => {
        if (failure === 'datasets') throw new Error('dataset');
        return [];
      },
    });
    assert.equal(writes.length, failure === 'upload' ? 1 : 0);
    assert.deepEqual(unavailable, [persistence!.correlationId]);
  }
});

test('the existing run owner retains single-flight finalization and includes execution-tail updates', async () => {
  const { input, provider, writes } = fixture();
  const persistence = await prepareEditorRecordingPersistence({
    eligible: true,
    projectPath: 'run.rivet-project',
    provider,
  });
  const session = new EditorRunSession();
  let outcome: 'succeeded' | 'failed' = 'succeeded';
  session.onDispose(() => persistEditorRunRecording({ ...input, persistence, status: outcome }));
  assert.equal(writes.length, 0, 'Foreground outputs do not dispose the accepted execution');
  outcome = 'failed';
  const first = session.dispose();
  assert.equal(session.dispose(), first);
  await first;
  assert.equal(writes.length, 1);
  assert.equal(writes[0]!.status, 'failed');
});
