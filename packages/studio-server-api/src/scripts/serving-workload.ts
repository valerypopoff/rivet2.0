import assert from 'node:assert/strict';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { deserializeProject, serializeProject, serializeDatasets } from '@valerypopoff/rivet2-core/serialization';
import type { WorkflowDataBackend } from '../routes/workflows/data-backend.js';
import type { WorkflowProjectItem } from '../../../studio-server-shared/workflow-types.js';

const conditions = (item: WorkflowProjectItem) => ({
  expectedProjectId: item.projectMetadataId!,
  expectedPublicationVersion: item.settings.publicationVersion!,
  expectedDraftRevisionId: item.revisionId!,
});

/** Same deterministic logical workload for both adapters; caller owns a fresh
 * disposable store. This measures service operations, not HTTP/network SLOs. */
export async function measureServingWorkload(
  backend: WorkflowDataBackend,
  checkHealth: () => Promise<void>,
  iterations = 100,
) {
  const projects: WorkflowProjectItem[] = [];
  for (let index = 0; index < 12; index++) {
    let item = await backend.createWorkflowProjectItem('', `Workload ${index}`);
    const loaded = await backend.loadHostedProject(item.absolutePath);
    const [project, attached] = deserializeProject(loaded.contents);
    const graph = project.graphs[project.metadata.mainGraphId!];
    assert.ok(graph);
    graph.nodes = Array.from({ length: 300 }, (_, node) => ({
      id: `node-${node}` as never,
      type: 'text',
      title: 'Text',
      visualData: { x: 0, y: 0, width: 200 },
      data: { text: 'deterministic workload '.repeat(24) },
    })) as typeof graph.nodes;
    const datasetsContents = serializeDatasets([
      {
        meta: { id: 'fixture' as never, projectId: project.metadata.id, name: 'Fixture', description: '' },
        data: {
          id: 'fixture' as never,
          rows: Array.from({ length: 50 }, (_, row) => ({ id: String(row), data: ['value', String(row)] })),
        },
      },
    ]);
    item = (
      await backend.saveHostedProject({
        projectPath: item.absolutePath,
        contents: serializeProject(project, attached) as string,
        datasetsContents,
        expectedRevisionId: loaded.revisionId,
      })
    ).project;
    for (let version = 0; version < 3; version++)
      item = await backend.publishWorkflowProjectItem(
        item.relativePath,
        { endpointName: `workload-${index}` },
        conditions(item),
      );
    for (let recording = 0; recording < 8; recording++) {
      const id = await backend.persistWorkflowExecutionRecording({
        sourceProject: project,
        sourceProjectPath: item.absolutePath,
        executedProject: project,
        executedAttachedData: attached,
        executedDatasets: [],
        endpointName: `workload-${index}`,
        recordingSerialized: JSON.stringify({ events: [{ type: 'fixture', value: 'recording '.repeat(1000) }] }),
        runKind: 'published',
        status: 'succeeded',
        durationMs: 1,
      });
      assert.ok(id, 'recording persistence must be enabled for this owned workload');
    }
    projects.push(item);
  }
  const durations = new Map<string, number[]>();
  const ownedIds = new Set(projects.map((item) => item.projectMetadataId));
  const timed = async (name: string, operation: () => Promise<unknown>) => {
    const start = performance.now();
    await operation();
    const values = durations.get(name) ?? [];
    values.push(performance.now() - start);
    durations.set(name, values);
  };
  const delay = monitorEventLoopDelay({ resolution: 1 });
  delay.enable();
  await yieldTurn();
  let rssPeakBytes = process.memoryUsage().rss;
  const sampler = setInterval(() => {
    rssPeakBytes = Math.max(rssPeakBytes, process.memoryUsage().rss);
  }, 10);
  const cpu = process.cpuUsage();
  const started = performance.now();
  try {
    await timed('cold-execution', async () => {
      const result = await backend.loadPublishedExecutionProject('workload-1');
      assert.equal(result?.project.metadata.title, 'Workload 1');
    });
    for (let round = 0; round < iterations; round++) {
      const item = projects[1 + (round % 11)]!;
      await Promise.all([
        timed('tree', async () => {
          assert.equal(
            (await backend.getTree()).projects.filter((item) => ownedIds.has(item.projectMetadataId)).length,
            12,
          );
        }),
        timed('recordings-picker', async () => {
          assert.equal(
            (await backend.listWorkflowRecordingWorkflows()).workflows.filter((item) => ownedIds.has(item.workflowId))
              .length,
            12,
          );
        }),
        timed('project-open', async () => {
          assert.ok((await backend.loadHostedProject(item.absolutePath)).contents);
        }),
        timed('execution-definition', async () => {
          const result = await backend.loadPublishedExecutionProject(`workload-${1 + (round % 11)}`);
          assert.equal(result?.project.metadata.title, item.name);
          if (result) result.project.graphs = {};
        }),
        timed('readiness', checkHealth),
        timed('save-and-publication', async () => {
          const writer = projects[0]!;
          const loaded = await backend.loadHostedProject(writer.absolutePath);
          const [project, attached] = deserializeProject(loaded.contents);
          project.metadata.description = `Round ${round}`;
          const saved = (
            await backend.saveHostedProject({
              projectPath: writer.absolutePath,
              contents: serializeProject(project, attached) as string,
              datasetsContents: loaded.datasetsContents,
              expectedRevisionId: loaded.revisionId,
            })
          ).project;
          projects[0] = await backend.publishWorkflowProjectItem(
            saved.relativePath,
            { endpointName: 'workload-0' },
            conditions(saved),
          );
        }),
      ]);
      await yieldTurn();
    }
    const final = await backend.loadPublishedExecutionProject('workload-1');
    assert.ok(
      final && Object.keys(final.project.graphs).length > 0,
      'another consumer must not observe execution mutations',
    );
  } finally {
    clearInterval(sampler);
    delay.disable();
  }
  const used = process.cpuUsage(cpu);
  return {
    scope: 'concurrent adapter service operations, not production HTTP latency',
    iterations,
    concurrency: 6,
    projectCount: 12,
    nodesPerProject: 300,
    initialPublishedVersions: 3,
    recordingCount: 96,
    elapsedMs: performance.now() - started,
    cpuMs: (used.user + used.system) / 1000,
    rssPeakBytes,
    eventLoopDelayMaxMs: delay.max / 1e6,
    operations: Object.fromEntries(
      [...durations].map(([name, values]) => {
        values.sort((a, b) => a - b);
        const p = (fraction: number) => values[Math.ceil(values.length * fraction) - 1];
        return [
          name,
          {
            samples: values.length,
            p50Ms: p(0.5),
            p95Ms: p(0.95),
            ...(values.length >= 100 ? { p99Ms: p(0.99) } : {}),
            maxMs: values.at(-1),
          },
        ];
      }),
    ),
  };
}
