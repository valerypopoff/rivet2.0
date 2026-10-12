import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Request, Response } from 'express';
import type { RuntimeLibraryJobState } from '../../../studio-server-shared/runtime-library-types.js';
import { streamRuntimeLibraryJob } from '../routes/runtime-library-job-stream.js';
import type { RuntimeLibraryJobObserver } from '../runtime-libraries/job-observation.js';

const runningJob: RuntimeLibraryJobState = {
  id: 'job',
  type: 'install',
  status: 'running',
  packages: [],
  logs: [],
  logEntries: [],
  createdAt: '2026-09-13T00:00:00Z',
  lastProgressAt: '2026-09-13T00:00:00Z',
};

function transport() {
  const req = Object.assign(new EventEmitter(), { params: { jobId: 'job' } });
  const chunks: string[] = [];
  const events = new EventEmitter();
  const res = Object.assign(events, {
    destroyed: false,
    writableEnded: false,
    headersSent: false,
    statusCode: 200,
    setHeader() {
      assert.equal(this.writableEnded, false);
    },
    flushHeaders() {
      this.headersSent = true;
    },
    status(status: number) {
      assert.equal(this.headersSent, false);
      this.statusCode = status;
      return this;
    },
    json(value: unknown) {
      chunks.push(JSON.stringify(value));
      this.end();
    },
    write(value: string): boolean {
      assert.equal(this.writableEnded, false);
      chunks.push(value);
      return true;
    },
    end() {
      this.writableEnded = true;
      events.emit('finish');
    },
    destroy() {
      this.destroyed = true;
      events.emit('close');
    },
  });
  return { req, res, chunks, request: req as unknown as Request, response: res as unknown as Response };
}

test('managed job stream does not send an initial lookup completed after revocation', async () => {
  const fixture = transport();
  let release!: (value: RuntimeLibraryJobState) => void;
  const pending = streamRuntimeLibraryJob(fixture.request, fixture.response, {
    getJob: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  fixture.res.end();
  release(runningJob);
  await pending;
  assert.deepEqual(fixture.chunks, []);
  assert.equal(fixture.res.headersSent, false);
  assert.equal(fixture.req.listenerCount('close'), 0);
  assert.equal(fixture.res.listenerCount('close'), 0);
});

test('revocation during the subscribed lookup stops observation exactly once and sends no headers', async () => {
  const fixture = transport();
  let reads = 0;
  let stopped = 0;
  let release!: (job: RuntimeLibraryJobState) => void;
  const pending = streamRuntimeLibraryJob(fixture.request, fixture.response, {
    getJob: async () =>
      ++reads === 1
        ? runningJob
        : new Promise((resolve) => {
            release = resolve;
          }),
    subscribeJob() {
      return () => {
        stopped++;
      };
    },
  });
  await setImmediate();
  fixture.res.end();
  release(runningJob);
  await pending;
  assert.equal(stopped, 1);
  assert.equal(fixture.res.headersSent, false);
  assert.deepEqual(fixture.chunks, []);
});

test('managed job stream bounds polling and discards results after response closure', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const fixture = transport();
  let reads = 0;
  let release!: (value: RuntimeLibraryJobState) => void;
  await streamRuntimeLibraryJob(fixture.request, fixture.response, {
    getJob: async () => {
      if (++reads === 1) return runningJob;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  t.mock.timers.tick(5_000);
  assert.equal(reads, 2, 'only one storage poll may be outstanding');
  const initialChunks = [...fixture.chunks];
  fixture.res.end();
  release({
    ...runningJob,
    status: 'succeeded',
    logEntries: [{ message: 'private log', source: 'stdout', createdAt: runningJob.createdAt }],
  });
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
  await streamRuntimeLibraryJob(fixture.request, fixture.response, {
    getJob: async () => (++reads === 1 ? runningJob : null),
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
    await streamRuntimeLibraryJob(fixture.request, fixture.response, {
      getJob: async () => (++reads > 1 || initiallyFinished ? { ...runningJob, status: 'succeeded' } : runningJob),
    });
    t.mock.timers.tick(1_000);
    await setImmediate();
    assert.equal(fixture.res.writableEnded, true);
    assert.equal(fixture.chunks.filter((chunk) => chunk.includes('"type":"done"')).length, 1);
    assert.equal(fixture.res.listenerCount('close'), 0);
    t.mock.timers.reset();
  }
});

test('native subscriptions close the lookup gap and unsubscribe without cancelling the job', async () => {
  const fixture = transport();
  let reads = 0,
    unsubscribed = 0;
  await streamRuntimeLibraryJob(fixture.request, fixture.response, {
    getJob: async () => (++reads === 1 ? runningJob : { ...runningJob, status: 'succeeded' }),
    subscribeJob(_id, observer) {
      observer.state(runningJob);
      return () => {
        unsubscribed++;
      };
    },
  });
  assert.equal(fixture.res.writableEnded, true);
  assert.equal(unsubscribed, 1);
  assert.equal(fixture.chunks.filter((chunk) => chunk.includes('"type":"done"')).length, 1);
});

test('stalled consumers disconnect after a bounded wait but do not cancel durable jobs', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fixture = transport();
  fixture.res.write = () => false;
  let unsubscribed = 0;
  await streamRuntimeLibraryJob(fixture.request, fixture.response, {
    getJob: async () => runningJob,
    subscribeJob() {
      return () => {
        unsubscribed++;
      };
    },
  });
  assert.equal(fixture.res.writableEnded, false, 'ordinary backpressure must wait for drain');
  assert.equal(unsubscribed, 0);
  t.mock.timers.tick(30_000);
  assert.equal(fixture.res.destroyed, true);
  assert.equal(unsubscribed, 1);
  assert.equal(fixture.res.listenerCount('drain'), 0);
});

test('status and terminal backpressure resume exactly once and clear stall timers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const fixture = transport();
  const acceptedWrite = fixture.res.write;
  fixture.res.write = function (value) {
    acceptedWrite.call(this, value);
    return false;
  };
  let unsubscribed = 0;
  await streamRuntimeLibraryJob(fixture.request, fixture.response, {
    getJob: async () => ({ ...runningJob, status: 'succeeded' }),
    subscribeJob() {
      return () => {
        unsubscribed++;
      };
    },
  });
  t.mock.timers.tick(29_999);
  assert.equal(fixture.chunks.length, 1, 'no writes before drain');
  fixture.res.emit('drain');
  assert.equal(fixture.chunks.length, 2);
  assert.equal(fixture.res.writableEnded, false, 'terminal event is accepted but still awaiting drain');
  fixture.res.emit('drain');
  assert.deepEqual(
    fixture.chunks.map((chunk) => JSON.parse(chunk.slice(6)).type),
    ['status', 'done'],
  );
  assert.equal(fixture.res.writableEnded, true);
  t.mock.timers.tick(30_000);
  assert.equal(fixture.res.destroyed, false, 'completed streams leave no stall timer');
  assert.equal(unsubscribed, 1);
  assert.equal(fixture.res.listenerCount('drain'), 0);
});

test('drain resumes at the next log while newer terminal state is coalesced without duplicate events', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const fixture = transport();
  const acceptedWrite = fixture.res.write;
  let writes = 0;
  fixture.res.write = function (value) {
    acceptedWrite.call(this, value);
    return ++writes !== 1;
  };
  let observer!: RuntimeLibraryJobObserver;
  let unsubscribed = 0;
  const entries = ['first', 'second'].map((message) => ({
    message,
    source: 'stdout' as const,
    createdAt: runningJob.createdAt,
  }));
  await streamRuntimeLibraryJob(fixture.request, fixture.response, {
    getJob: async () => ({ ...runningJob, logEntries: entries }),
    subscribeJob(_id, subscription) {
      observer = subscription;
      return () => {
        unsubscribed++;
      };
    },
  });
  assert.equal(fixture.chunks.length, 1);
  observer.state({ ...runningJob, status: 'succeeded', logEntries: [...entries, { ...entries[0]!, message: 'last' }] });
  t.mock.timers.tick(30_000);
  assert.equal(fixture.chunks.length, 1, 'no writes while the response buffer is full');
  fixture.res.emit('drain');
  const events = fixture.chunks.map((chunk) => JSON.parse(chunk.slice(6)));
  assert.deepEqual(
    events.filter((event) => event.type === 'log').map((event) => event.message),
    ['first', 'second', 'last'],
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ['log', 'log', 'log', 'status', 'done'],
  );
  assert.equal(fixture.res.writableEnded, true);
  assert.equal(unsubscribed, 1);
  assert.equal(fixture.res.listenerCount('drain'), 0);
});

test('disconnect while blocked removes drain listeners and never sends late observations', async () => {
  const fixture = transport();
  fixture.res.write = () => false;
  let observer!: RuntimeLibraryJobObserver;
  let unsubscribed = 0;
  await streamRuntimeLibraryJob(fixture.request, fixture.response, {
    getJob: async () => runningJob,
    subscribeJob(_id, subscription) {
      observer = subscription;
      return () => {
        unsubscribed++;
      };
    },
  });
  fixture.res.end();
  fixture.res.emit('drain');
  observer.state({ ...runningJob, status: 'succeeded' });
  assert.deepEqual(fixture.chunks, []);
  assert.equal(unsubscribed, 1);
  assert.equal(fixture.res.listenerCount('drain'), 0);
});

test(
  'a real HTTP response delivers a large retained log tail and terminal event despite backpressure',
  { timeout: 10_000 },
  async (t) => {
    const entries = Array.from({ length: 2_000 }, (_, index) => ({
      message: `${index} ${'x'.repeat(150)}`,
      source: 'stdout' as const,
      createdAt: runningJob.createdAt,
    }));
    let unsubscribed = 0;
    let backpressure = 0;
    const server = createServer((req, res) => {
      const write = res.write.bind(res);
      res.write = ((...args: Parameters<typeof res.write>) => {
        const accepted = write(...args);
        if (!accepted) backpressure++;
        return accepted;
      }) as typeof res.write;
      const request = Object.assign(req, { params: { jobId: 'job' } });
      void streamRuntimeLibraryJob(request as unknown as Request, res as unknown as Response, {
        getJob: async () => ({ ...runningJob, status: 'succeeded', logEntries: entries }),
        subscribeJob() {
          return () => {
            unsubscribed++;
          };
        },
      }).catch((error) => res.destroy(error));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    assert.equal(response.status, 200);
    const events = (await response.text())
      .trim()
      .split('\n\n')
      .map((chunk) => JSON.parse(chunk.slice(6)));
    assert.deepEqual(
      events.filter((event) => event.type === 'log').map((event) => event.message),
      entries.map((entry) => entry.message),
    );
    assert.equal(events.filter((event) => event.type === 'done').length, 1);
    assert.equal(events.at(-1).status, 'succeeded');
    assert.equal(unsubscribed, 1);
    assert.ok(backpressure > 0, 'this test must exercise actual response backpressure');
  },
);

test('native log appends read only the new tail, not every retained line', async () => {
  const fixture = transport();
  let indexedReads = 0;
  const entries = Array.from({ length: 1_000 }, (_, index) => ({
    message: String(index),
    source: 'stdout' as const,
    createdAt: runningJob.createdAt,
  }));
  const job = {
    ...runningJob,
    logEntries: new Proxy(entries, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) indexedReads++;
        return Reflect.get(target, key, receiver);
      },
    }),
  };
  let observer: RuntimeLibraryJobObserver | undefined;
  await streamRuntimeLibraryJob(fixture.request, fixture.response, {
    getJob: async () => job,
    subscribeJob(_id, subscription) {
      observer = subscription;
      return () => {};
    },
  });
  assert.equal(indexedReads, 1_000);
  entries.push({ message: 'new tail', source: 'stdout', createdAt: runningJob.createdAt });
  indexedReads = 0;
  assert.ok(observer);
  observer.state(job);
  assert.equal(indexedReads, 1);
  assert.equal(fixture.chunks.filter((chunk) => chunk.includes('new tail')).length, 1);
  fixture.res.end();
});
