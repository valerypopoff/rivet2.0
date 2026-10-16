import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  UserInputNodeImpl,
  GraphOutputNodeImpl,
  type Project,
  type ProjectId,
  type GraphId,
  type PortId,
  type ProcessEventMessage,
} from '@valerypopoff/rivet2-core';

type IpcMessage = { type?: string; nonce?: string; state?: string };

for (const resumable of [false, true])
  test(
    `real editor executor retirement owns preparation and paused runs through terminal cleanup (resume=${resumable})`,
    { timeout: 30000 },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'rivet-executor-retirement-'));
      const reservation = createServer();
      reservation.listen(0, '127.0.0.1');
      await once(reservation, 'listening');
      const address = reservation.address();
      assert.ok(address && typeof address !== 'string');
      const port = address.port;
      await new Promise<void>((done) => reservation.close(() => done()));
      const incarnation = randomUUID(),
        operationId = randomUUID();
      const child = spawn(
        process.execPath,
        [
          '--import',
          import.meta.resolve('tsx'),
          '--input-type=module',
          '--eval',
          `
    let release;
    const preparation = new Promise((resolve) => { release = resolve; });
    process.on('message', (message) => { if (message?.type === 'test-release-preparation') release(); });
    const { startAppExecutor } = await import(${JSON.stringify(new URL('./executorHost.mts', import.meta.url).href)});
    await startAppExecutor({ createProcessorOptions: async () => {
      process.send({ type: 'test-preparing' });
      await preparation;
      return { executionEnvironment: {} };
    } });
  `,
        ],
        {
          cwd: new URL('../', import.meta.url),
          windowsHide: true,
          env: {
            ...process.env,
            HOME: root,
            USERPROFILE: root,
            APPDATA: root,
            LOCALAPPDATA: root,
            RIVET_ROLLING_RETIREMENT_PROTOCOL: '1',
            RIVET_HA_PROTOCOL: resumable ? '1' : '',
            RIVET_PROCESS_INCARNATION: incarnation,
            RIVET_RUNTIME_PROCESS_ROLE: 'executor',
            RIVET_VM_MIGRATION_CONTROL_ROOT: '',
            RIVET_EXECUTOR_HOST: '127.0.0.1',
            RIVET_EXECUTOR_PORT: String(port),
            RIVET_CODE_RUNNER_WORKER_POOL_SIZE: '1',
          },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        },
      );
      let logs = '';
      child.stdout!.on('data', (data) => {
        logs += String(data);
      });
      child.stderr!.on('data', (data) => {
        logs += String(data);
      });
      const exited = once(child, 'close');
      t.after(async () => {
        if (child.exitCode == null) child.kill('SIGKILL');
        await exited;
        await rm(root, { recursive: true, force: true });
      });
      await ipcMessage(child, (message) => message.type === 'rivet-executor-ready', t.signal);
      let socket = new WebSocket(`ws://127.0.0.1:${port}`, resumable ? ['rivet-session-v1'] : undefined);
      t.after(() => socket.close());
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve(), { once: true });
        socket.addEventListener('error', () => reject(new Error(logs)), { once: true });
      });
      const messages: ProcessEventMessage[] = [];
      socket.addEventListener('message', (event) => {
        messages.push(JSON.parse(String(event.data)));
      });
      const send = (type: string, data: unknown) => socket.send(JSON.stringify({ type, data }));
      const input = UserInputNodeImpl.create(),
        output = GraphOutputNodeImpl.create();
      output.data.id = 'result';
      output.data.dataType = 'string[]';
      const project: Project = {
        metadata: {
          id: 'retirement-project' as ProjectId,
          title: 'Retirement',
          description: '',
          mainGraphId: 'main' as GraphId,
        },
        graphs: {
          main: {
            metadata: { id: 'main' as GraphId, name: 'Main' },
            nodes: [input, output],
            connections: [
              {
                outputNodeId: input.id,
                outputId: 'output' as PortId,
                inputNodeId: output.id,
                inputId: 'value' as PortId,
              },
            ],
          },
        },
      };
      send('set-dynamic-data', { project, settings: {} });
      const preparing = ipcMessage(child, (message) => message.type === 'test-preparing', t.signal);
      send('run', { requestId: 'accepted', graphId: 'main' });
      await preparing;
      const begin = await command('rivet-retire');
      assert.equal(begin.state, 'draining', 'preparation must be owned before a processor is registered');
      assert.equal((await command('rivet-retirement-query')).state, 'draining');
      child.send({ type: 'test-release-preparation' });
      await waitMessage('userInput');
      send('pause', { requestId: 'accepted' });
      await waitMessage('pause');
      assert.equal((await command('rivet-retirement-query')).state, 'draining');
      if (resumable) {
        const envelopes = messages as unknown as {
          message: string;
          data: { capability?: string };
          rivetSequence?: number;
        }[];
        const capability = envelopes.find((event) => event.message === 'executor-session')?.data.capability;
        assert.ok(capability);
        const sequence = Math.max(...envelopes.map((event) => event.rivetSequence ?? 0));
        const closed = new Promise((resolve) => socket.addEventListener('close', resolve, { once: true }));
        socket.close();
        await closed;
        socket = new WebSocket(`ws://127.0.0.1:${port}`, [
          'rivet-session-v1',
          `rivet-cap.${capability}`,
          `rivet-seq.${sequence}`,
        ]);
        socket.addEventListener('message', (event) => messages.push(JSON.parse(String(event.data))));
        await new Promise<void>((resolve, reject) => {
          socket.addEventListener('open', () => resolve(), { once: true });
          socket.addEventListener('error', () => reject(new Error(logs)), { once: true });
        });
        // A duplicate accepted request is not a new graph execution.
        send('run', { requestId: 'accepted', graphId: 'main' });
      }
      send('run', { requestId: 'rejected', graphId: 'main' });
      const rejected = await waitMessage('error', 'rejected');
      assert.ok(rejected.message === 'error');
      assert.match(rejected.data.error, /retiring/);
      assert.equal((await command('rivet-retirement-query')).state, 'draining');
      send('user-input', {
        requestId: 'accepted',
        nodeId: input.id,
        answers: { type: 'string[]', value: ['preserved'] },
      });
      send('resume', { requestId: 'accepted' });
      const done = await waitMessage('done');
      assert.ok(done.message === 'done');
      assert.deepEqual(done.data.results.result, { type: 'string[]', value: ['preserved'] });
      let status = await command('rivet-retirement-query');
      while (status.state === 'draining') {
        await new Promise((resolve) => setTimeout(resolve, 10));
        status = await command('rivet-retirement-query');
      }
      assert.equal(status.state, 'drained');
      assert.equal(
        messages.some((message) => message.requestId === 'accepted' && message.message === 'abort'),
        false,
      );
      assert.equal(socket.readyState, WebSocket.OPEN, 'retirement must not revoke controls for accepted clients');
      assert.equal(
        messages.filter((message) => message.requestId === 'accepted' && message.message === 'start').length,
        1,
      );

      async function command(type: string): Promise<IpcMessage> {
        const nonce = randomUUID();
        const response = ipcMessage(
          child,
          (message) => message.type === 'rivet-retirement-status' && message.nonce === nonce,
          t.signal,
        );
        child.send({ type, protocol: 1, incarnation, operationId, nonce });
        return response;
      }
      async function waitMessage(message: string, requestId = 'accepted'): Promise<ProcessEventMessage> {
        while (!t.signal.aborted) {
          const found = messages.find((event) => event.message === message && event.requestId === requestId);
          if (found) return found;
          if (child.exitCode != null) throw new Error(logs);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error(`Missing ${message}: ${logs}`);
      }
    },
  );

function ipcMessage(
  child: ChildProcess,
  matches: (message: IpcMessage) => boolean,
  signal: AbortSignal,
): Promise<IpcMessage> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off('message', message);
      child.off('close', closed);
      signal.removeEventListener('abort', closed);
    };
    const message = (value: unknown) => {
      if (value && typeof value === 'object' && matches(value as IpcMessage)) {
        cleanup();
        resolve(value as IpcMessage);
      }
    };
    const closed = () => {
      cleanup();
      reject(new Error('Executor stopped before acknowledgement.'));
    };
    child.on('message', message);
    child.once('close', closed);
    signal.addEventListener('abort', closed, { once: true });
  });
}
