import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import type { Request, Response } from 'express';
import type { RuntimeLibraryJobState } from '../../../studio-server-shared/runtime-library-types.js';
import { streamManagedRuntimeLibraryJob } from '../runtime-libraries/managed/job-stream.js';

const runningJob: RuntimeLibraryJobState = {
  id: 'job', type: 'install', status: 'running', packages: [], logs: [], logEntries: [],
  createdAt: '2026-09-13T00:00:00Z', lastProgressAt: '2026-09-13T00:00:00Z',
};

function transport() {
  const req = Object.assign(new EventEmitter(), { params: { jobId: 'job' } });
  const chunks: string[] = [];
  const events = new EventEmitter();
  const res = Object.assign(events, {
    destroyed: false, writableEnded: false, headersSent: false, statusCode: 200,
    setHeader() { assert.equal(this.writableEnded, false); },
    flushHeaders() { this.headersSent = true; },
    status(status: number) { assert.equal(this.headersSent, false); this.statusCode = status; return this; },
    json(value: unknown) { chunks.push(JSON.stringify(value)); this.end(); },
    write(value: string) { assert.equal(this.writableEnded, false); chunks.push(value); return true; },
    end() { this.writableEnded = true; events.emit('finish'); },
  });
  return { req, res, chunks, request: req as unknown as Request, response: res as unknown as Response };
}

test('managed job stream does not send an initial lookup completed after revocation', async () => {
  const fixture = transport();
  let release!: (value: RuntimeLibraryJobState) => void;
  const pending = streamManagedRuntimeLibraryJob(fixture.request, fixture.response, {
    getJob: () => new Promise((resolve) => { release = resolve; }),
  });
  fixture.res.end();
  release(runningJob);
  await pending;
  assert.deepEqual(fixture.chunks, []);
  assert.equal(fixture.res.headersSent, false);
  assert.equal(fixture.req.listenerCount('close'), 0);
  assert.equal(fixture.res.listenerCount('close'), 0);
});

test('managed job stream bounds polling and discards results after response closure', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const fixture = transport();
  let reads = 0;
  let release!: (value: RuntimeLibraryJobState) => void;
  await streamManagedRuntimeLibraryJob(fixture.request, fixture.response, {
    getJob: async () => {
      if (++reads === 1) return runningJob;
      return new Promise((resolve) => { release = resolve; });
    },
  });
  t.mock.timers.tick(5_000);
  assert.equal(reads, 2, 'only one storage poll may be outstanding');
  const initialChunks = [...fixture.chunks];
  fixture.res.end();
  release({ ...runningJob, status: 'succeeded', logEntries: [{ message: 'private log', source: 'stdout', createdAt: runningJob.createdAt }] });
  await setImmediate();
  t.mock.timers.tick(30_000);
  assert.deepEqual(fixture.chunks, initialChunks);
  assert.equal(reads, 2);
  assert.equal(fixture.req.listenerCount('close'), 0);
  assert.equal(fixture.res.listenerCount('finish'), 0);
});

test('a managed job removed while streaming closes without writing a second HTTP response', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const fixture = transport();
  let reads = 0;
  await streamManagedRuntimeLibraryJob(fixture.request, fixture.response, {
    getJob: async () => ++reads === 1 ? runningJob : null,
  });
  t.mock.timers.tick(1_000);
  await setImmediate();
  assert.equal(fixture.res.writableEnded, true);
  assert.equal(fixture.res.statusCode, 200);
  assert.equal(fixture.chunks.length, 1);
  t.mock.timers.tick(30_000);
  assert.equal(reads, 2);
});

test('managed job stream shares initial and polled terminal delivery', async (t) => {
  for (const initiallyFinished of [false, true]) {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const fixture = transport();
    let reads = 0;
    await streamManagedRuntimeLibraryJob(fixture.request, fixture.response, {
      getJob: async () => (++reads > 1 || initiallyFinished) ? { ...runningJob, status: 'succeeded' } : runningJob,
    });
    t.mock.timers.tick(1_000);
    await setImmediate();
    assert.equal(fixture.res.writableEnded, true);
    assert.equal(fixture.chunks.filter((chunk) => chunk.includes('"type":"done"')).length, 1);
    assert.equal(fixture.res.listenerCount('close'), 0);
    t.mock.timers.reset();
  }
});
