import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ChartNode, PortId } from '@valerypopoff/rivet2-node';

if (!process.send || !process.env.RIVET_ASYNC_TEST_ROOT) throw new Error('Requires the isolated async test harness');
const root = process.env.RIVET_ASYNC_TEST_ROOT;
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
await storage.initializeWorkflowStorage();
const { writeWorkflowEndpointAuthSettings } = await import('../../workflow-endpoint-auth-settings.js');
await writeWorkflowEndpointAuthSettings({ requireBearerAuth: false });
const created = await storage.createWorkflowProjectItemWithBackend(
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
graph.nodes = [input, output, trigger, tail, result];
graph.connections = [
  connect(input, 'data', output, 'value'),
  connect(input, 'data', trigger, 'input1'),
  connect(trigger, 'output1', tail, 'url'),
  connect(tail, 'res_body', result, 'value'),
];
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
process.on('message', async (message: { id: number; command: string }) => {
  try {
    if (message.command === 'shutdown') {
      // Windows does not deliver POSIX signals through child.kill(). Exercise
      // the real entrypoint's installed SIGTERM handler on every platform.
      process.emit('SIGTERM');
      process.send?.({ id: message.id, result: true });
      return;
    }
    if (message.command === 'snapshot') {
      const { getActiveHttpExecutionCount } = await import('../../active-http-executions.js');
      const { getHttpBodyAdmissionSnapshot } = await import('../../middleware/body-admission.js');
      process.send?.({
        id: message.id,
        result: { active: getActiveHttpExecutionCount(), body: getHttpBodyAdmissionSnapshot() },
      });
    } else if (message.command === 'recordings') {
      process.send?.({
        id: message.id,
        result: await storage.listWorkflowRecordingRunsPageWithBackend(project.metadata.id, 1, 20, 'all'),
      });
    } else if (message.command === 'replay') {
      const page = await storage.listWorkflowRecordingRunsPageWithBackend(project.metadata.id, 1, 20, 'all');
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
