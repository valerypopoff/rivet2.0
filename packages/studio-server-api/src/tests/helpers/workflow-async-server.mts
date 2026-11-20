import fs from 'node:fs/promises';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import type { ChartNode, DataId, PortId } from '@valerypopoff/rivet2-node';

if (!process.send || !process.env.RIVET_ASYNC_TEST_ROOT) throw new Error('Requires the isolated async test harness');
const root = process.env.RIVET_ASYNC_TEST_ROOT;
if (process.env.RIVET_ASYNC_TEST_COST_PROVIDER_URL) {
  const providerUrl = new URL(process.env.RIVET_ASYNC_TEST_COST_PROVIDER_URL);
  if (providerUrl.protocol !== 'http:' || providerUrl.hostname !== '127.0.0.1')
    throw new Error('Requires local cost provider');
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    // Test-only URL redirection; preserve the actual HTTP client and adapter.
    if (String(input) === 'https://api.typesafe.ai/v1/systemone')
      return nativeFetch(`${providerUrl.href.replace(/\/$/, '')}/v1/systemone`, init);
    if (String(input) === 'https://openrouter.ai/api/v1/chat/completions')
      return nativeFetch(`${providerUrl.href.replace(/\/$/, '')}/v1/chat/completions`, init);
    return nativeFetch(input, init);
  };
}
const endpointName = process.env.RIVET_ASYNC_TEST_ENDPOINT_NAME || 'async-acceptance';
await fs.mkdir(path.join(root, 'app', 'settings'), { recursive: true });
await fs.mkdir(path.join(root, 'workflows'), { recursive: true });
if (process.env.RIVET_ASYNC_TEST_STORAGE) {
  await fs.writeFile(
    path.join(root, 'app', 'settings', 'deployment-storage.json'),
    process.env.RIVET_ASYNC_TEST_STORAGE,
  );
}
const storage = await import('../../routes/workflows/storage-backend.js');
const rivet = await import('@valerypopoff/rivet2-node');
const { ManagedRecordingEvidence } = await import('../../routes/workflows/managed/recording-evidence.js');
const canShareReplayProject = ManagedRecordingEvidence.prototype.canShareReplayProject;
await storage.initializeWorkflowStorage();
let releaseRecordingWork: (() => void) | undefined;
let finishSnapshotTiming: (() => Record<string, number>) | undefined;
const recordingWork = { registrations: 0, outcomes: 0 };
if (process.env.RIVET_ASYNC_TEST_HOLD_RECORDING_WORK === 'true') {
  const gate = new Promise<void>((resolve) => {
    releaseRecordingWork = resolve;
  });
  const begin = ManagedRecordingEvidence.prototype.begin,
    outcome = ManagedRecordingEvidence.prototype.outcome;
  ManagedRecordingEvidence.prototype.begin = async function (...args) {
    recordingWork.registrations++;
    await gate;
    return begin.apply(this, args);
  };
  ManagedRecordingEvidence.prototype.outcome = async function (...args) {
    recordingWork.outcomes++;
    await gate;
    return outcome.apply(this, args);
  };
}
const { writeWorkflowEndpointAuthSettings } = await import('../../workflow-endpoint-auth-settings.js');
await writeWorkflowEndpointAuthSettings({ requireBearerAuth: false });
const resume = process.env.RIVET_ASYNC_TEST_RESUME === '1';
const fixtureFile = path.join(root, 'async-fixture.json');
const created = resume
  ? JSON.parse(await fs.readFile(fixtureFile, 'utf8'))
  : await storage.createWorkflowProjectItemWithBackend(
      '',
      process.env.RIVET_ASYNC_TEST_PROJECT_NAME || 'Async acceptance',
    );
const project = rivet.loadProjectFromString((await storage.loadHostedProject(created.absolutePath)).contents);
const graph = project.graphs[project.metadata.mainGraphId!]!;
const input = rivet.graphInputNode.impl.create();
input.data = { id: 'input', dataType: 'any' };
const output = rivet.graphOutputNode.impl.create();
output.data = { id: 'output', dataType: 'any' };
const trigger = rivet.startBackgroundBranchNode.impl.create();
const tail = rivet.httpCallNode.impl.create();
tail.id = 'async-tail' as typeof tail.id;
tail.data.useUrlInput = true;
const result = rivet.textNode.impl.create();
result.id = 'async-result' as typeof result.id;
result.data.text = '{{value}}';
const connect = (from: ChartNode, outputId: string, to: ChartNode, inputId: string) => ({
  outputNodeId: from.id,
  outputId: outputId as PortId,
  inputNodeId: to.id,
  inputId: inputId as PortId,
});
if (!resume) {
  const payloadBytes = Number(process.env.RIVET_ASYNC_TEST_PROJECT_BYTES ?? 0);
  if (payloadBytes) project.data = { ['replay-fixture' as DataId]: 'x'.repeat(payloadBytes) };
  graph.nodes = [input, output, trigger, tail, result];
  graph.connections = [
    connect(input, 'data', output, 'value'),
    connect(input, 'data', trigger, 'input1'),
    connect(trigger, 'output1', tail, 'url'),
    connect(tail, 'res_body', result, 'value'),
  ];
  if (process.env.RIVET_ASYNC_TEST_PROJECT_BYTES !== undefined) {
    graph.nodes = [input, output];
    graph.connections = [connect(input, 'data', output, 'value')];
  }
  if (process.env.RIVET_ASYNC_TEST_HTTP_ECHO_URL) {
    tail.data.useUrlInput = false;
    tail.data.url = process.env.RIVET_ASYNC_TEST_HTTP_ECHO_URL;
    tail.data.method = 'POST';
    tail.data.useBodyInput = true;
    tail.data.headers = JSON.stringify({ 'content-type': 'application/json' });
    graph.nodes = [input, tail, output];
    graph.connections = [connect(input, 'data', tail, 'req_body'), connect(tail, 'res_body', output, 'value')];
  }
  if (process.env.RIVET_ASYNC_TEST_FAILURE === 'foreground') {
    const failure = rivet.codeNode.impl.create();
    failure.data.code = "throw new Error('foreground fixture failure');";
    graph.nodes = [failure];
    graph.connections = [];
  }
  const contents = rivet.serializeProject(project);
  if (typeof contents !== 'string') throw new Error('Expected serialized project');
  await storage.saveHostedProject({ projectPath: created.absolutePath, contents, datasetsContents: null });
  const reviewed = await storage.listWorkflowProjectWebAppsWithBackend(created.relativePath);
  await storage.executeWorkflowPublicationCommandWithBackend({
    kind: 'publish-endpoint',
    relativePath: created.relativePath,
    endpointName,
    preconditions: {
      expectedProjectId: reviewed.projectId,
      expectedPublicationVersion: reviewed.publicationVersion,
      expectedDraftRevisionId: reviewed.draftRevisionId,
    },
  });
  await fs.writeFile(fixtureFile, JSON.stringify(created));
}
if (process.env.RIVET_ASYNC_TEST_FAILURE === 'serialization') {
  const { default: express } = await import('express');
  const json = express.response.json;
  express.response.json = function (body) {
    if (this.statusCode === 200 && this.req.originalUrl.startsWith('/workflows/'))
      throw new Error('response fixture failure');
    return json.call(this, body);
  };
}
await import('../../server.js');
const baseUrl = `http://127.0.0.1:${process.env.PORT}`;
for (let attempt = 0; ; attempt++) {
  try {
    if ((await fetch(`${baseUrl}/readyz`, { signal: AbortSignal.timeout(1_000) })).ok) break;
  } catch {}
  if (attempt === 300) throw new Error('Test API did not become ready');
  await delay(100);
}
let hostedSubgraphFixture:
  | Awaited<ReturnType<typeof import('./hosted-subgraph-fixture.js').seedHostedSubgraphFixture>>
  | undefined;
process.on('message', async (message: { id: number; command: string }) => {
  try {
    if (message.command === 'monitoring-on' || message.command === 'monitoring-off') {
      const monitoring = await import('../../resource-monitoring/runtime.js');
      if (message.command === 'monitoring-on') await monitoring.startResourceMonitoring('combined');
      else monitoring.stopResourceMonitoring();
      process.send?.({ id: message.id, result: true });
      return;
    }
    if (message.command === 'process-usage') {
      process.send?.({ id: message.id, result: { cpu: process.cpuUsage(), rss: process.memoryUsage.rss() } });
      return;
    }
    if (message.command === 'execution-admission') {
      const { getPublishedExecutionAdmission } = await import('../../published-execution-admission.js');
      process.send?.({ id: message.id, result: getPublishedExecutionAdmission().getSnapshot() });
      return;
    }
    if (message.command === 'release-recording-work') {
      releaseRecordingWork?.();
      process.send?.({ id: message.id, result: true });
      return;
    }
    if (message.command === 'recording-work-state') {
      process.send?.({ id: message.id, result: recordingWork });
      return;
    }
    if (message.command === 'durability-off' || message.command === 'durability-on') {
      process.env.RIVET_RECORDING_DURABILITY_ENABLED = message.command === 'durability-on' ? 'true' : 'false';
      process.send?.({ id: message.id, result: true });
      return;
    }
    if (message.command === 'snapshot-sharing-off' || message.command === 'snapshot-sharing-on') {
      ManagedRecordingEvidence.prototype.canShareReplayProject = message.command.endsWith('-on')
        ? canShareReplayProject
        : () => false;
      process.send?.({ id: message.id, result: true });
      return;
    }
    if (message.command === 'begin-snapshot-timing') {
      if (finishSnapshotTiming) throw new Error('A snapshot timing sample is already active.');
      const { getManagedPostgresPoolMetrics } = await import('../../managed-postgres-pool.js');
      const { getWorkflowExecutionRecordingPersistenceMetrics } = await import('../../routes/workflows/recordings.js');
      const histogram = monitorEventLoopDelay({ resolution: 10 });
      let peakPendingWrites = 0;
      let peakPoolWaiting = 0;
      const samples = setInterval(() => {
        peakPendingWrites = Math.max(
          peakPendingWrites,
          getWorkflowExecutionRecordingPersistenceMetrics().pendingWrites,
        );
        peakPoolWaiting = Math.max(peakPoolWaiting, getManagedPostgresPoolMetrics().waiting);
      }, 25);
      samples.unref();
      histogram.enable();
      const baseline = process.cpuUsage();
      finishSnapshotTiming = () => {
        clearInterval(samples);
        histogram.disable();
        const cpu = process.cpuUsage(baseline);
        return {
          cpuMs: (cpu.user + cpu.system) / 1000,
          eventLoopP95Ms: histogram.percentile(95) / 1e6,
          peakPendingWrites,
          peakPoolWaiting,
        };
      };
      process.send?.({ id: message.id, result: true });
      return;
    }
    if (message.command === 'finish-snapshot-timing') {
      if (!finishSnapshotTiming) throw new Error('No snapshot timing sample is active.');
      const result = finishSnapshotTiming();
      finishSnapshotTiming = undefined;
      process.send?.({ id: message.id, result });
      return;
    }
    if (message.command === 'measure-scheduled-permit') {
      const { getScheduledRunService } = await import('../../scheduled-runs/runtime.js');
      const { ScheduledRunService } = await import('../../scheduled-runs/service.js');
      const { runScheduledGraph } = await import('../../scheduled-runs/runner.js');
      const { getPublishedExecutionAdmission } = await import('../../published-execution-admission.js');
      const live = getScheduledRunService();
      await live.drainAcceptedWork();
      const schedule = await live.store.save({
        name: 'Recording permit fixture',
        description: '',
        projectId: project.metadata.id,
        version: 'published',
        enabled: false,
        timeZone: 'UTC',
        schedule: { kind: 'daily', time: '12:00' },
        input: { fixture: 'timing' },
        record: true,
        timeoutMinutes: 1,
        missed: 'skip',
      });
      let permitMs = 0;
      let runError: unknown;
      const service = new ScheduledRunService(
        live.store,
        async (job, owner, signal) => {
          try {
            return await runScheduledGraph(job, live.store, owner, signal);
          } catch (error) {
            runError = error;
            throw error;
          }
        },
        () => true,
        1,
        {
          scope: 'published',
          acquirePermit() {
            const result = getPublishedExecutionAdmission().acquire('scheduled-run');
            if (result.kind !== 'accepted') return undefined;
            const started = performance.now();
            return {
              release() {
                permitMs = performance.now() - started;
                result.permit.release();
              },
            };
          },
        },
      );
      try {
        const occurrence = await live.store.runNow(schedule.id, schedule.revision);
        await service.tick();
        const deadline = Date.now() + 7000;
        while (service.activeCount) {
          if (Date.now() >= deadline) throw new Error('Scheduled permit did not settle');
          await delay(2);
        }
        const finished = (await live.store.list()).history.find((row) => row.id === occurrence.id);
        if (!permitMs || finished?.status !== 'succeeded' || finished.recordingStatus !== 'saved')
          throw new Error(
            `Scheduled permit fixture did not persist a successful run (${permitMs} ms, ${JSON.stringify(finished)})`,
            { cause: runError },
          );
        process.send?.({ id: message.id, result: permitMs });
      } finally {
        await live.store.delete(schedule.id, schedule.revision);
      }
      return;
    }
    if (message.command === 'recording-off' || message.command === 'recording-on') {
      process.env.RIVET_RECORDINGS_ENABLED = message.command === 'recording-on' ? 'true' : 'false';
      process.send?.({ id: message.id, result: true });
      return;
    }
    if (message.command === 'shutdown') {
      // Windows does not deliver POSIX signals through child.kill(). Exercise
      // the real entrypoint's installed SIGTERM handler on every platform.
      process.emit('SIGTERM');
      process.send?.({ id: message.id, result: true });
      return;
    }
    if (message.command === 'seed-cost' || message.command === 'seed-cost-priced') {
      const { seedRunCostFixture } = await import('./run-cost-fixture.js');
      process.send?.({ id: message.id, result: await seedRunCostFixture(message.command === 'seed-cost-priced') });
    } else if (message.command === 'seed-hosted-subgraph') {
      const { seedHostedSubgraphFixture } = await import('./hosted-subgraph-fixture.js');
      hostedSubgraphFixture = await seedHostedSubgraphFixture();
      process.send?.({ id: message.id, result: hostedSubgraphFixture });
    } else if (message.command === 'move-hosted-subgraph') {
      if (!hostedSubgraphFixture) throw new Error('Seed the hosted fixture first');
      await storage.moveWorkflowItemWithBackend(
        'project',
        hostedSubgraphFixture.target.relativePath,
        hostedSubgraphFixture.foreignPath,
      );
      process.send?.({ id: message.id, result: true });
    } else if (message.command === 'scheduled-recordings') {
      const { flushWorkflowExecutionRecordingPersistence } = await import('../../routes/workflows/recordings.js');
      await flushWorkflowExecutionRecordingPersistence();
      process.send?.({
        id: message.id,
        result: await storage.listWorkflowRecordingRunsPageWithBackend({ workflowId: '', page: 1, pageSize: 20 }),
      });
    } else if (message.command === 'snapshot') {
      const { getActiveHttpExecutionCount } = await import('../../active-http-executions.js');
      const { getHttpBodyAdmissionSnapshot } = await import('../../middleware/body-admission.js');
      process.send?.({
        id: message.id,
        result: { active: getActiveHttpExecutionCount(), body: getHttpBodyAdmissionSnapshot() },
      });
    } else if (message.command === 'recordings') {
      process.send?.({
        id: message.id,
        result: await storage.listWorkflowRecordingRunsPageWithBackend({
          workflowId: project.metadata.id,
          page: 1,
          pageSize: 20,
        }),
      });
    } else if (message.command === 'replay') {
      const page = await storage.listWorkflowRecordingRunsPageWithBackend({
        workflowId: project.metadata.id,
        page: 1,
        pageSize: 20,
      });
      const results = [];
      for (const run of page.runs) {
        const recording = rivet.ExecutionRecorder.deserializeFromString(
          await storage.readWorkflowRecordingArtifactWithBackend(run.id, 'recording'),
        );
        const replayProject = rivet.loadProjectFromString(
          await storage.readWorkflowRecordingArtifactWithBackend(run.id, 'replay-project'),
        );
        const replay = rivet.createProcessor(replayProject, {});
        const tails: unknown[] = [];
        replay.processor.on('nodeFinish', (event) => {
          if (event.node.id === tail.id) tails.push(event.outputs);
        });
        replay.processor.on('nodeError', (event) => {
          if (event.node.id === tail.id) tails.push({ error: String(event.error) });
        });
        try {
          const outputs = await replay.processor.replayRecording(recording);
          results.push({ id: run.id, outputs, tails });
        } finally {
          replay.dispose();
        }
      }
      process.send?.({ id: message.id, result: results });
    }
  } catch (error) {
    process.send?.({ id: message.id, error: String(error) });
  }
});
process.send({ ready: { baseUrl, projectId: project.metadata.id, projectPath: created.absolutePath } });
process.channel?.unref();
