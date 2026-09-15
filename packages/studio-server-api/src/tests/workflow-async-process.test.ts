import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { startAsyncWorkflowProcess, withAsyncDeadline } from './helpers/workflow-async-process.js';
import { listenTestServer } from './helpers/http-server-harness.js';

test('foreground execution failure preserves the HTTP error and failed recording', { timeout: 60_000 }, async () => {
  const api = await startAsyncWorkflowProcess({ failure: 'foreground' });
  try {
    const response = await fetch(`${api.baseUrl}/workflows/async-acceptance`, {
      method: 'POST',
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 500);
    assert.match(await response.text(), /failed to process due to errors in nodes/);
    await api.command('shutdown');
    assert.equal(await withAsyncDeadline(api.exited, 'server exit', 15_000), 0, api.logs);
    const metadata = await api.persistedMetadata();
    assert.equal(metadata.length, 1);
    assert.equal(metadata[0].status, 'failed');
  } finally {
    await api.close();
  }
});

for (const disconnect of [false, true]) {
  test(
    `response-writing failure ${disconnect ? 'with client disconnect' : 'before headers'} retains the async lifecycle`,
    { timeout: 60_000 },
    async () => {
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      let tailResponse: http.ServerResponse | undefined;
      const tail = await listenTestServer(
        http.createServer((_req, res) => {
          tailResponse = res;
          started();
        }),
      );
      const api = await startAsyncWorkflowProcess({ failure: 'serialization' }).catch(async (error) => {
        await tail.close();
        throw error;
      });
      const abort = new AbortController();
      let replied = false;
      const responsePromise = fetch(`${api.baseUrl}/workflows/async-acceptance`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(tail.baseUrl),
        signal: abort.signal,
      }).then(async (res) => {
        replied = true;
        return { status: res.status, text: await res.text() };
      });
      // Observe rejection immediately; a disconnected client's request is expected to reject.
      const observed = responsePromise.catch(() => null);
      try {
        await withAsyncDeadline(ready, 'async request');
        assert.equal(replied, false);
        if (disconnect) {
          abort.abort();
          assert.equal(await observed, null);
        }
        assert.equal((await api.command<{ active: number }>('snapshot')).active, 1);
        assert.equal((await api.command<{ runs: unknown[] }>('recordings')).runs.length, 0);
        tailResponse!.end('work survives response error');
        if (!disconnect) {
          const response = await responsePromise;
          assert.equal(response.status, 500);
          assert.match(response.text, /response fixture failure/);
        }
        await api.command('shutdown');
        assert.equal(await withAsyncDeadline(api.exited, 'server exit', 15_000), 0, api.logs);
        const metadata = await api.persistedMetadata();
        assert.equal(metadata.length, 1);
        assert.equal(metadata[0].status, 'succeeded', 'transport errors must not misclassify graph execution');
        assert.equal(api.logs.includes('ERR_HTTP_HEADERS_SENT'), false, api.logs);
      } finally {
        abort.abort();
        tailResponse?.end();
        await observed;
        await tail.close();
        await api.close();
      }
    },
  );
}

for (const finishWithinGrace of [true, false]) {
  test(
    `actual server shutdown ${finishWithinGrace ? 'drains' : 'aborts'} responded async work and persists its recording`,
    { timeout: 60_000 },
    async () => {
      let release!: () => void;
      let started!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const tail = await listenTestServer(
        http.createServer((_req, res) => {
          started();
          void gate.then(() => res.end('completed before shutdown'));
        }),
      );
      const api = await startAsyncWorkflowProcess({ graceSeconds: 1 }).catch(async (error) => {
        await tail.close();
        throw error;
      });
      try {
        const response = await fetch(`${api.baseUrl}/workflows/async-acceptance`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(tail.baseUrl),
          signal: AbortSignal.timeout(5_000),
        });
        assert.equal(response.status, 200, await response.clone().text());
        assert.equal(await response.json(), tail.baseUrl);
        await withAsyncDeadline(ready, 'async request');
        assert.equal((await api.command<{ active: number }>('snapshot')).active, 1);
        await api.command('shutdown');
        if (finishWithinGrace) release();
        assert.equal(await withAsyncDeadline(api.exited, 'server exit', 15_000), 0, api.logs);
        assert.equal(api.logs.includes('exceeded the shutdown grace period; aborting 1'), !finishWithinGrace, api.logs);
        const metadata = await api.persistedMetadata();
        assert.equal(metadata.length, 1, 'shutdown must flush one complete recording before exit');
        assert.equal(metadata[0].status, finishWithinGrace ? 'succeeded' : 'failed');
      } finally {
        release();
        await tail.close();
        await api.close();
      }
    },
  );
}

test(
  'concurrent accepted HTTP requests retain independent results, ownership and recordings',
  { timeout: 60_000 },
  async () => {
    const pending = new Map<string, http.ServerResponse>();
    const tail = await listenTestServer(
      http.createServer((req, res) => {
        pending.set(req.url!, res);
      }),
    );
    const api = await startAsyncWorkflowProcess().catch(async (error) => {
      await tail.close();
      throw error;
    });
    try {
      const values = ['/one', '/two'].map((suffix) => `${tail.baseUrl}${suffix}`);
      assert.deepEqual(
        await Promise.all(
          values.map(async (value) => {
            const res = await fetch(`${api.baseUrl}/workflows/async-acceptance`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(value),
              signal: AbortSignal.timeout(5_000),
            });
            assert.equal(res.status, 200);
            return await res.json();
          }),
        ),
        values,
      );
      const deadline = Date.now() + 5_000;
      while (pending.size !== 2 && Date.now() < deadline) await delay(10);
      assert.equal(pending.size, 2);
      assert.equal((await api.command<{ active: number }>('snapshot')).active, 2);
      assert.equal((await fetch(`${api.baseUrl}/healthz`)).status, 200);
      pending.get('/two')!.end('two');
      let recordings: { runs: Array<{ id: string }> };
      do {
        recordings = await api.command('recordings');
        if (Date.now() > deadline) assert.fail('second recording did not persist');
        if (!recordings.runs.length) await delay(10);
      } while (!recordings.runs.length);
      assert.equal(recordings.runs.length, 1);
      assert.equal((await api.command<{ active: number }>('snapshot')).active, 1);
      pending.get('/one')!.end('one');
      do {
        recordings = await api.command('recordings');
        if (Date.now() > deadline) assert.fail('first recording did not persist');
        if (recordings.runs.length < 2) await delay(10);
      } while (recordings.runs.length < 2);
      assert.equal(new Set(recordings.runs.map((run) => run.id)).size, 2);
      assert.equal((await api.command<{ active: number }>('snapshot')).active, 0);
      const replays = await api.command<Array<{ outputs: { output: { value: string } }; tails: unknown[] }>>('replay');
      assert.deepEqual(replays.map((run) => run.outputs.output.value).sort(), values.slice().sort());
      assert.ok(replays.every((run) => run.tails.length === 1));
    } finally {
      for (const res of pending.values()) res.end();
      await tail.close();
      await api.close();
    }
  },
);
