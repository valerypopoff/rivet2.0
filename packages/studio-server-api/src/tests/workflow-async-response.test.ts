import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createApiApp } from '../app.js';
import type { ChartNode, NodeConnection } from '@valerypopoff/rivet2-node';
import { listenTestServer } from './helpers/http-server-harness.js';
import { createFilesystemWorkflowSuiteHarness } from './helpers/workflow-filesystem-suite-harness.js';
import { waitForWorkflowRecordingRunCount } from './helpers/workflow-api-harness.js';
import { getActiveHttpExecutionCount, abortActiveHttpExecutions } from '../active-http-executions.js';
import { getHttpBodyAdmissionSnapshot } from '../middleware/body-admission.js';
import { getPublishedExecutionAdmission } from '../published-execution-admission.js';
import { getExpectedProxyAuthToken } from '../auth.js';
import {
  initializeLatestWorkflowRemoteDebugger,
  resetLatestWorkflowRemoteDebuggerForTests,
} from '../latestWorkflowRemoteDebugger.js';
import { connectWebSocket, closeWebSocket } from './helpers/websocket-harness.js';

const testEnvKeys = [
  'RIVET_ENABLE_LATEST_REMOTE_DEBUGGER',
  'RIVET_KEY',
  'RIVET_PUBLISHED_EXECUTION_ADMISSION_MODE',
  'RIVET_PUBLISHED_EXECUTION_MAX_ACTIVE_RUNS',
  'RIVET_RECORDINGS_ENABLED',
  'RIVET_REQUIRE_UI_GATE_KEY',
] as const;
const initialEnv = new Map(testEnvKeys.map((key) => [key, process.env[key]]));
process.env.RIVET_PUBLISHED_EXECUTION_ADMISSION_MODE = 'enforce';
process.env.RIVET_PUBLISHED_EXECUTION_MAX_ACTIVE_RUNS = '1';
process.env.RIVET_KEY = 'async-response-test-key';
process.env.RIVET_REQUIRE_UI_GATE_KEY = 'false';
delete process.env.RIVET_ENABLE_LATEST_REMOTE_DEBUGGER;
const suite = await createFilesystemWorkflowSuiteHarness();
test.beforeEach(suite.resetAndEnsureWorkflowsRoot);
test.after(async () => {
  await suite.cleanupWorkflowSuite();
  for (const key of testEnvKeys) {
    const value = initialEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function waitForIdle(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (getActiveHttpExecutionCount() > 0 && Date.now() < deadline) await delay(10);
  assert.equal(getActiveHttpExecutionCount(), 0, 'execution must release its registration');
}

for (const route of ['published', 'internal', 'latest'] as const) {
  for (const outcome of ['success', 'failure', 'abort', 'recording-disabled'] as const) {
    test(`${route} sends outputs before async ${outcome} and retains full-run ownership`, async (t) => {
      const successful = outcome === 'success' || outcome === 'recording-disabled';
      const previousRecordingSetting = process.env.RIVET_RECORDINGS_ENABLED;
      process.env.RIVET_RECORDINGS_ENABLED = outcome === 'recording-disabled' ? 'false' : 'true';
      t.after(() => {
        if (previousRecordingSetting === undefined) delete process.env.RIVET_RECORDINGS_ENABLED;
        else process.env.RIVET_RECORDINGS_ENABLED = previousRecordingSetting;
      });
      let release!: (status: number) => void;
      const gate = new Promise<number>((resolve) => {
        release = resolve;
      });
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const tailServer = await listenTestServer(
        http.createServer((_req, res) => {
          markStarted();
          void gate.then((status) => {
            res.writeHead(status).end('async finished');
          });
        }),
      );
      t.after(async () => {
        release(200);
        await waitForIdle();
        await tailServer.close();
      });

      const created = await suite.workflowMutations.createWorkflowProjectItem('', 'AsyncResponse');
      const project = await suite.rivetNode.loadProjectFromFile(created.absolutePath);
      const graph = project.graphs[project.metadata.mainGraphId!]!;
      const source = suite.rivetNode.textNode.impl.create();
      source.data.text = tailServer.baseUrl;
      const output = suite.rivetNode.graphOutputNode.impl.create();
      output.data = { id: 'output', dataType: 'string' };
      const trigger = suite.rivetNode.startBackgroundBranchNode.impl.create();
      const nestedTrigger = suite.rivetNode.startBackgroundBranchNode.impl.create();
      const tail = suite.rivetNode.httpCallNode.impl.create();
      tail.data.useUrlInput = true;
      const connect = (from: ChartNode, fromPort: string, to: ChartNode, toPort: string): NodeConnection => ({
        outputNodeId: from.id,
        outputId: fromPort as NodeConnection['outputId'],
        inputNodeId: to.id,
        inputId: toPort as NodeConnection['inputId'],
      });
      graph.nodes = [source, output, trigger, nestedTrigger, tail];
      graph.connections = [
        connect(source, 'output', output, 'value'),
        connect(source, 'output', trigger, 'input1'),
        connect(trigger, 'output1', nestedTrigger, 'input1'),
        connect(nestedTrigger, 'output1', tail, 'url'),
      ];
      const serializedProject = suite.rivetNode.serializeProject(project);
      assert.ok(typeof serializedProject === 'string');
      await fs.writeFile(created.absolutePath, serializedProject, 'utf8');
      await suite.workflowMutations.publishWorkflowProjectItem(created.relativePath, {
        endpointName: 'async-response',
      });
      await suite.workflowStorageBackend.initializeWorkflowStorage();
      const app = createApiApp('combined');
      const { getPublishedWorkflowsBasePath, getLatestWorkflowsBasePath } = await import('../public-route-settings.js');
      const routePath =
        route === 'internal'
          ? '/internal/workflows'
          : route === 'latest'
            ? getLatestWorkflowsBasePath()
            : getPublishedWorkflowsBasePath();
      const httpServer = http.createServer(app);
      initializeLatestWorkflowRemoteDebugger(httpServer);
      const api = await listenTestServer(httpServer);
      t.after(async () => {
        await resetLatestWorkflowRemoteDebuggerForTests();
        await api.close();
      });
      const socket = await connectWebSocket(`${api.baseUrl.replace('http:', 'ws:')}/ws/latest-debugger`, {
        headers: { 'x-rivet-proxy-auth': getExpectedProxyAuthToken() },
      });
      const messages: Array<{ message: string; data: { node?: { id: string }; nodeId?: string } }> = [];
      socket.on('message', (data) => messages.push(JSON.parse(data.toString())));
      t.after(() => closeWebSocket(socket));
      const logs = t.mock.method(console, 'error', () => undefined);
      const bodyBefore = getHttpBodyAdmissionSnapshot();
      const capacityBefore = getPublishedExecutionAdmission().getSnapshot().activeRuns;
      const responsePromise = fetch(`${api.baseUrl}${routePath}/async-response`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(5_000),
      }).then(async (res) => ({
        status: res.status,
        correlationId: res.headers.get('x-rivet-correlation-id'),
        body: await res.json(),
      }));
      const response = await responsePromise;
      assert.equal(response.status, 200, JSON.stringify(response.body));
      const startupDeadline = new AbortController();
      try {
        await Promise.race([
          started,
          delay(5_000, undefined, { signal: startupDeadline.signal, ref: false }).then(() => {
            throw new Error('async branch did not start');
          }),
        ]);
      } finally {
        startupDeadline.abort();
      }
      assert.equal(response.body.output.value, tailServer.baseUrl);
      assert.equal((await fetch(`${api.baseUrl}/healthz`, { signal: AbortSignal.timeout(2_000) })).status, 200);
      assert.equal(getActiveHttpExecutionCount(), 1);
      assert.equal(
        getPublishedExecutionAdmission().getSnapshot().activeRuns,
        capacityBefore + (route === 'latest' ? 0 : 1),
      );
      assert.equal(getHttpBodyAdmissionSnapshot().activeParsers, bodyBefore.activeParsers);
      assert.equal(getHttpBodyAdmissionSnapshot().retainedBodies, bodyBefore.retainedBodies + 1);
      assert.ok(getHttpBodyAdmissionSnapshot().reservedBytes > bodyBefore.reservedBytes);
      if (route !== 'latest') {
        const saturated = await fetch(`${api.baseUrl}${routePath}/async-response`, { method: 'POST' });
        assert.equal(saturated.status, 429, 'responded async work still occupies execution capacity');
        await saturated.text();
      }
      const before = await suite.workflowRecordings.listWorkflowRecordingRunsPage(
        suite.workflowsRoot,
        project.metadata.id,
        1,
        20,
        'all',
      );
      assert.equal(before.runs.length, 0, 'never persist a truncated async recording');
      assert.ok(!messages.some((message) => message.message === 'done'), 'debugger must stay live after HTTP response');

      if (outcome === 'abort') abortActiveHttpExecutions();
      else release(outcome === 'failure' ? 500 : 200);
      await waitForIdle();
      assert.equal(getPublishedExecutionAdmission().getSnapshot().activeRuns, capacityBefore);
      assert.deepEqual(getHttpBodyAdmissionSnapshot(), bodyBefore);
      if (route === 'latest') {
        const terminalMessage = outcome === 'abort' ? 'abort' : successful ? 'done' : 'error';
        const deadline = Date.now() + 5_000;
        while (!messages.some((message) => message.message === terminalMessage) && Date.now() < deadline)
          await delay(10);
        assert.ok(messages.some((message) => message.message === 'graphOutputsReady'));
        assert.ok(
          messages.some((message) => message.message === terminalMessage),
          JSON.stringify(messages.map((message) => message.message)),
        );
        const readyIndex = messages.findIndex((message) => message.message === 'graphOutputsReady');
        const tailIndex = messages.findIndex(
          (message) =>
            ['nodeFinish', 'nodeError'].includes(message.message) &&
            (message.data.node?.id ?? message.data.nodeId) === tail.id,
        );
        assert.ok(tailIndex > readyIndex, 'debugger receives async node completion after response readiness');
        if (outcome !== 'abort')
          assert.ok(messages.findIndex((message) => message.message === terminalMessage) > tailIndex);
      } else {
        assert.equal(messages.length, 0, 'published executions must not leak into the latest debugger');
      }
      assert.equal(logs.mock.calls.length, successful ? 0 : 1);
      if (!successful) {
        const context = logs.mock.calls[0]!.arguments[1] as Record<string, unknown>;
        assert.equal(context.correlationId, response.correlationId);
        assert.equal(context.endpointName, 'async-response');
        assert.equal(context.runKind, route === 'latest' ? 'latest' : 'published');
        assert.deepEqual(Object.keys(context).sort(), ['correlationId', 'endpointName', 'error', 'runKind']);
        assert.match(String(context.error), /.+/);
      }
      if (outcome === 'recording-disabled') {
        const page = await suite.workflowRecordings.listWorkflowRecordingRunsPage(
          suite.workflowsRoot,
          project.metadata.id,
          1,
          20,
          'all',
        );
        assert.equal(page.runs.length, 0);
        return;
      }
      const page = await waitForWorkflowRecordingRunCount(
        suite.workflowRecordings.listWorkflowRecordingRunsPage,
        suite.workflowsRoot,
        project.metadata.id,
        1,
      );
      assert.equal(page.runs.length, 1);
      assert.equal(page.runs[0]!.status, outcome === 'success' ? 'succeeded' : 'failed');
      assert.ok(Number.isFinite(page.runs[0]!.durationMs) && page.runs[0]!.durationMs >= 0);
      const recording = suite.rivetNode.ExecutionRecorder.deserializeFromString(
        await suite.workflowRecordings.readWorkflowRecordingArtifact(
          suite.workflowsRoot,
          page.runs[0]!.id,
          'recording',
        ),
      );
      assert.ok(
        recording.events.some(
          (event) =>
            event.type === (outcome === 'success' ? 'nodeFinish' : 'nodeError') && event.data.nodeId === tail.id,
        ),
      );
      if (outcome === 'success') {
        const tailIndex = recording.events.findIndex(
          (event) => event.type === 'nodeFinish' && event.data.nodeId === tail.id,
        );
        assert.ok(
          recording.events.findIndex((event) => event.type === 'done') > tailIndex,
          'the complete recording ends after the async node',
        );
      }
      const replayProject = suite.rivetNode.loadProjectFromString(
        await suite.workflowRecordings.readWorkflowRecordingArtifact(
          suite.workflowsRoot,
          page.runs[0]!.id,
          'replay-project',
        ),
      );
      const replay = suite.rivetNode.createProcessor(replayProject, {});
      const replayedTail: unknown[] = [];
      replay.processor.on(outcome === 'success' ? 'nodeFinish' : 'nodeError', (event) => {
        if (event.node.id === tail.id) replayedTail.push(event);
      });
      try {
        const outputs = await replay.processor.replayRecording(recording);
        if (outcome === 'success') {
          assert.equal(outputs.output?.value, tailServer.baseUrl);
        }
        assert.equal(replayedTail.length, 1, 'replay includes the actual async terminal result');
      } finally {
        replay.dispose();
      }
    });
  }
}
