import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { backendPreStop } from './prestop-backend.mjs';
import { requestBackendRetirement } from './retire-backend.mjs';

const status = () => ({
  protocol: 1,
  withdrawalProtocol: 1,
  incarnation: randomUUID(),
  operationId: randomUUID(),
  state: 'drained',
  routingWithdrawn: true,
});

test(
  'packaged preStop command reads the Unix retirement socket without initiating a mutation',
  { skip: process.platform === 'win32' ? 'Unix socket lifecycle contract runs on Linux' : false },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-prestop-'));
    const socket = path.join(directory, 'retirement.sock'),
      current = status(),
      methods = [];
    const server = createServer((request, response) => {
      methods.push(request.method);
      assert.equal(request.url, '/retirement');
      response.end(JSON.stringify(current));
    });
    t.after(async () => {
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      await fs.rm(directory, { recursive: true, force: true });
    });
    await new Promise((resolve) => server.listen(socket, resolve));
    const result = await promisify(execFile)(
      process.execPath,
      [fileURLToPath(new URL('./prestop-backend.mjs', import.meta.url)), '120'],
      { env: { ...process.env, RIVET_ROLLING_RETIREMENT_SOCKET: socket }, timeout: 5000 },
    );
    assert.match(result.stdout, /coordinated-drain-complete/);
    assert.deepEqual(methods, ['GET', 'GET']);
  },
);
test(
  'retirement inspection has a total deadline even when a local server keeps streaming',
  { skip: process.platform === 'win32', timeout: 2000 },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-retirement-deadline-'));
    const socket = path.join(directory, 'retirement.sock');
    const server = createServer((_request, response) => {
      response.write('{');
      const timer = setInterval(() => response.write(' '), 10);
      response.once('close', () => clearInterval(timer));
    });
    t.after(async () => {
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      await fs.rm(directory, { recursive: true, force: true });
    });
    await new Promise((resolve) => server.listen(socket, resolve));
    await assert.rejects(requestBackendRetirement(socket, 'GET', undefined, { timeoutMs: 80 }), /timed out/);
  },
);

test('only the same fully drained, explicitly withdrawn incarnation avoids the repeated preStop delay', async () => {
  const current = status();
  let reads = 0;
  assert.equal(
    await backendPreStop({
      delaySeconds: 120,
      readStatus: async () => {
        reads++;
        return current;
      },
      wait: async () => assert.fail('A completed drain must not sleep again'),
    }),
    'coordinated-drain-complete',
  );
  assert.equal(reads, 2);
});
test('uncoordinated, partial, changed, legacy or unavailable retirement retains the complete fallback delay', async () => {
  for (const mode of [
    'serving',
    'checking',
    'withdrawing',
    'draining',
    'failed',
    'legacy',
    'direct-begin',
    'changed',
    'invalid',
    'unavailable',
  ]) {
    let reads = 0;
    const waits = [],
      current = status();
    const readStatus = async () => {
      reads++;
      if (mode === 'unavailable') throw Error('Socket unavailable');
      if (mode === 'legacy') return { ...current, routingWithdrawn: undefined };
      if (mode === 'direct-begin') return { ...current, routingWithdrawn: false };
      if (mode === 'invalid') return { ...current, operationId: 'foreign' };
      if (mode === 'changed' && reads === 2) return status();
      return { ...current, ...(mode === 'changed' ? {} : { state: mode }) };
    };
    assert.equal(
      await backendPreStop({ delaySeconds: 120, readStatus, wait: async (ms) => waits.push(ms) }),
      'normal-delay',
      mode,
    );
    assert.deepEqual(waits, [120000], mode);
  }
});
