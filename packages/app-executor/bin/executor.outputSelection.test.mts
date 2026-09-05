import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  decodeDebuggerTransportSentinels,
  type ChartNode,
  type GraphId,
  type NodeConnection,
  type NodeId,
  type PortId,
  type ProcessEventMessage,
  type Project,
  type ProjectId,
} from '@valerypopoff/rivet2-core';

void test(
  'hosted executor preserves per-node output selection across WebSocket uploads and cached runs',
  {
    timeout: 30_000,
  },
  async (t) => {
    const isolatedHome = await mkdtemp(join(tmpdir(), 'rivet-executor-selection-'));
    let socket: WebSocket | undefined;
    const port = await reserveLocalPort();
    const executor = spawn(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        '--input-type=module',
        '--eval',
        `
      const { startAppExecutor } = await import(${JSON.stringify(new URL('./executorHost.mts', import.meta.url).href)});
      await startAppExecutor({ createProcessorOptions: () => ({ executionEnvironment: {} }) });
    `,
      ],
      {
        cwd: new URL('../', import.meta.url),
        env: {
          ...process.env,
          HOME: isolatedHome,
          USERPROFILE: isolatedHome,
          APPDATA: isolatedHome,
          LOCALAPPDATA: isolatedHome,
          RIVET_EXECUTOR_HOST: '127.0.0.1',
          RIVET_EXECUTOR_PORT: String(port),
          RIVET_CODE_RUNNER_WORKER_POOL_SIZE: '1',
        },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const exited = new Promise<void>((resolve) => executor.once('close', () => resolve()));
    t.after(async () => {
      socket?.close();
      if (executor.exitCode == null) executor.kill('SIGKILL');
      await exited;
      await rm(isolatedHome, { recursive: true, force: true });
    });

    let output = '';
    const ready = new Promise<void>((resolve, reject) => {
      const onOutput = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes(`Rivet app executor websocket listening on 127.0.0.1:${port}`)) {
          cleanup();
          resolve();
        }
      };
      const onExit = () => {
        cleanup();
        reject(new Error(`Executor exited before readiness:\n${output}`));
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onAbort = () => {
        cleanup();
        reject(new Error(`Executor startup timed out:\n${output}`));
      };
      const cleanup = () => {
        executor.stdout.off('data', onOutput);
        executor.stderr.off('data', onOutput);
        executor.off('close', onExit);
        executor.off('error', onError);
        t.signal.removeEventListener('abort', onAbort);
      };
      executor.stdout.on('data', onOutput);
      executor.stderr.on('data', onOutput);
      executor.once('close', onExit);
      executor.once('error', onError);
      t.signal.addEventListener('abort', onAbort, { once: true });
    });
    await ready;
    // Keep draining the child's pipes after readiness, including unexpected diagnostics.
    executor.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    executor.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    socket = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      socket!.addEventListener('open', () => resolve(), { once: true });
      socket!.addEventListener('error', () => reject(new Error(`Executor connection failed:\n${output}`)), {
        once: true,
      });
      t.signal.addEventListener('abort', () => reject(new Error('Executor connection timed out.')), { once: true });
    });

    // Reuse both the WebSocket and the project id, as the editor does when toggling a node setting.
    for (const [index, skipUnusedOutputs] of [false, true, false].entries()) {
      const fixture = makeUnusedOutputProject(skipUnusedOutputs);
      const requestId = `selection-${index}`;
      const completed = collectRun(socket, requestId, t.signal);
      socket.send(JSON.stringify({ type: 'set-dynamic-data', data: { project: fixture.project, settings: {} } }));
      socket.send(JSON.stringify({ type: 'run', data: { requestId, graphId: fixture.graphId, useEditorCache: true } }));
      const events = await completed;
      const done = events.find((event) => event.message === 'done');
      assert.ok(done?.message === 'done', 'Missing completion result.');
      assert.deepEqual(done.data.results.result, { type: 'string', value: 'shared wanted' });
      const starts = events.filter((event) => event.message === 'nodeStart');
      assert.equal(starts.length, fixture.expectedNodeStarts);
      assert.equal(starts.filter((event) => event.data.node.id === 'shared-source').length, 1);
      const subgraph = events.find((event) => event.message === 'nodeFinish' && event.data.node.id === 'subgraph');
      assert.ok(subgraph?.message === 'nodeFinish', 'Missing Subgraph result.');
      assert.deepEqual(
        subgraph.data.outputs['unused' as PortId],
        skipUnusedOutputs
          ? { type: 'control-flow-excluded', value: undefined }
          : { type: 'string', value: 'shared unused unused' },
      );
      assert.equal(
        events.some(
          (event) =>
            (event.message === 'nodeStart' || event.message === 'nodeFinish' || event.message === 'nodeExcluded') &&
            event.data.node.id.startsWith('unused-'),
        ),
        !skipUnusedOutputs,
      );
    }

    function makeUnusedOutputProject(skipUnusedOutputs: boolean) {
      const node = (type: string, id: string, data: Record<string, unknown>): ChartNode => ({
        type,
        id: id as NodeId,
        title: id,
        data,
        visualData: { x: 0, y: 0 },
      });
      const connection = (
        outputNodeId: string,
        outputId: string,
        inputNodeId: string,
        inputId: string,
      ): NodeConnection => ({
        outputNodeId: outputNodeId as NodeId,
        outputId: outputId as PortId,
        inputNodeId: inputNodeId as NodeId,
        inputId: inputId as PortId,
      });
      return {
        graphId: 'main',
        expectedNodeStarts: skipUnusedOutputs ? 5 : 8,
        project: {
          metadata: {
            id: 'executor-selection' as ProjectId,
            title: 'Executor selection',
            description: '',
            mainGraphId: 'main' as GraphId,
          },
          plugins: [],
          graphs: {
            main: {
              metadata: { id: 'main' as GraphId, name: 'Main' },
              nodes: [
                node('subGraph', 'subgraph', { graphId: 'child', skipUnusedOutputs }),
                node('graphOutput', 'result-output', { id: 'result', dataType: 'string' }),
              ],
              connections: [connection('subgraph', 'wanted', 'result-output', 'value')],
            },
            child: {
              metadata: { id: 'child' as GraphId, name: 'Child' },
              nodes: [
                node('text', 'shared-source', { text: 'shared' }),
                node('text', 'wanted-text', { text: '{{input}} wanted' }),
                node('graphOutput', 'wanted-output', { id: 'wanted', dataType: 'string' }),
                node('text', 'unused-text-0', { text: '{{input}} unused' }),
                node('text', 'unused-text-1', { text: '{{input}} unused' }),
                node('graphOutput', 'unused-output', { id: 'unused', dataType: 'string' }),
              ],
              connections: [
                connection('shared-source', 'output', 'wanted-text', 'input'),
                connection('wanted-text', 'output', 'wanted-output', 'value'),
                connection('shared-source', 'output', 'unused-text-0', 'input'),
                connection('unused-text-0', 'output', 'unused-text-1', 'input'),
                connection('unused-text-1', 'output', 'unused-output', 'value'),
              ],
            },
          },
        } as Project,
      };
    }
  },
);

async function reserveLocalPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

function collectRun(socket: WebSocket, requestId: string, signal: AbortSignal): Promise<ProcessEventMessage[]> {
  return new Promise((resolve, reject) => {
    const events: ProcessEventMessage[] = [];
    const cleanup = () => {
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('close', onClose);
      signal.removeEventListener('abort', onAbort);
    };
    const fail = (message: string) => {
      cleanup();
      reject(new Error(message));
    };
    const onMessage = (event: MessageEvent) => {
      const message = decodeDebuggerTransportSentinels(JSON.parse(String(event.data))) as ProcessEventMessage;
      if (message.requestId !== requestId) return;
      events.push(message);
      if (message.message === 'error' || message.message === 'nodeError' || message.message === 'graphError') {
        fail(`Executor run failed: ${JSON.stringify(message)}`);
      } else if (message.message === 'done') {
        cleanup();
        resolve(events);
      }
    };
    const onClose = () => fail('Executor socket closed before the run completed.');
    const onAbort = () => fail('Executor run timed out.');
    socket.addEventListener('message', onMessage);
    socket.addEventListener('close', onClose);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
