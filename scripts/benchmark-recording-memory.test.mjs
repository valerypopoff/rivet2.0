import assert from 'node:assert/strict';
// test-style: fixture-read: reads only test-owned generated benchmark files.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Agent, createServer } from 'node:http';
import { once } from 'node:events';
import {
  assertBenchmarkRecording,
  assertBenchmarkRequests,
  assertBenchmarkResponse,
  drainBenchmark,
  fingerprint,
  parseOptions,
  requestBody,
  summarize,
  benchmarkWarmups,
  runBenchmarkPhase,
} from './benchmark-recording-memory.mjs';

const required = ['--original', 'before', '--candidate', 'after', '--output', 'results', '--image', 'local-image'];

test('benchmark transport reports fresh and reused socket resets without retrying requests', async () => {
  for (const reused of [false, true]) {
    let requests = 0;
    const server = createServer((request, response) => {
      requests++;
      if (reused && requests === 1) response.end('ready');
      else request.socket.destroy();
    });
    const agent = new Agent({ keepAlive: true });
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const url = `http://127.0.0.1:${server.address().port}`;
      if (reused) assert.equal((await requestBody(url, agent)).status, 200);
      await assert.rejects(
        requestBody(url, agent),
        (error) => error.code === 'ECONNRESET' && error.reusedSocket === reused,
      );
      assert.equal(requests, reused ? 2 : 1);
    } finally {
      agent.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }
});

test('benchmark arguments require a local build selection and bounded workloads', () => {
  assert.equal(parseOptions(required).profile, 'production');
  assert.equal(parseOptions([...required, '--workload', 'chain']).workload, 'chain');
  const sustained = parseOptions([...required, '--duration-seconds', '300', '--rate', '32']);
  assert.equal(sustained.samples, 9600);
  assert.equal(sustained.batches, 1);
  assert.equal(sustained['pending-writes'], 100);
  assert.equal(sustained['api-profile'], 'execution');
  assert.equal(sustained['settings-backend'], 'postgres');
  const warmups = benchmarkWarmups(sustained);
  assert.deepEqual(
    warmups.map(({ round }) => round),
    [-4, -3, -2, -1],
  );
  const identities = new Set(
    warmups.flatMap(({ round, count }) => Array.from({ length: count }, (_, i) => `${round}:${i}`)),
  );
  assertBenchmarkRequests(identities, warmups);
  for (const args of [
    required.slice(0, -2),
    [...required, '--samples', '0'],
    [...required, '--rate', 'Infinity'],
    [...required, '--backend', 'production'],
    [...required, '--image', 'second-image'],
    [...required, '--unknown', '1'],
    [...required, '--max-scheduling-delay-ms', '0'],
    [...required, '--batches', '16', '--samples', '4096'],
    [...required, '--batches', '32'],
    [...required, '--duration-seconds', '300', '--rate', '33'],
    [...required, '--duration-seconds', '1', '--rate', '0'],
    [...required, '--duration-seconds', '1', '--samples', '8'],
    [...required, '--warmup-batches', '0'],
    [...required, '--pending-writes', '0'],
    [...required, '--audit-timeout-ms', 'Infinity'],
    [...required, '--backend', 'filesystem', '--api-profile', 'execution'],
    [...required, '--backend', 'filesystem', '--settings-backend', 'postgres'],
  ])
    assert.throws(() => parseOptions(args));
});

test('one sustained phase drains only at its boundaries and reports transport failures without replay', async (t) => {
  let requests = 0;
  let fail = false;
  const commands = [];
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') {
      response.end('ready');
      return;
    }
    requests++;
    if (fail) {
      response.writeHead(500).end('failed');
      return;
    }
    const parts = [];
    for await (const part of request) parts.push(part);
    response.end(JSON.stringify({ ...JSON.parse(Buffer.concat(parts)), durationMs: 0 }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const runner = {
    side: 'candidate',
    url: `http://127.0.0.1:${server.address().port}`,
    expected: 0,
    batches: [],
    async command(name) {
      commands.push({ name, requests });
      if (name === 'execution-admission') return { activeRuns: 0, mode: 'enforce', maxActiveRuns: 4 };
      return {
        settingsBackend: 'postgres',
        eventLoopMaxMs: 0,
        memory: { captures: 0, estimatedBytes: 0, rejections: 0 },
      };
    },
  };
  const config = parseOptions([...required, '--duration-seconds', '1', '--rate', '4', '--warmup-samples', '4']);
  const row = await runBenchmarkPhase(runner, config, 4, 0, config.samples);
  assert.deepEqual(
    commands.filter(({ name }) => name === 'benchmark-drain').map(({ requests }) => requests),
    [0, 4],
  );
  assert.deepEqual(row.traffic, { offered: 4, sent: 4, completed: 4, missed: 0 });
  assert.equal(row.wireLatencies.length, 4);
  assert.deepEqual(runner.batches, [{ round: 0, count: 4 }]);
  commands.length = 0;
  fail = true;
  await assert.rejects(
    runBenchmarkPhase(runner, { ...config, rate: 0 }, 1, 1, 4),
    (error) => /HTTP 500/.test(error.message) && error.traffic.sent === 1 && error.traffic.failed === 1,
  );
  assert.equal(requests, 5, 'Failed requests are never replayed');
  assert.equal(commands.filter(({ name }) => name === 'benchmark-drain').length, 1);
});

test('benchmark drain waits for producers and rechecks work queued during the first flush', async () => {
  let active = 1,
    pending = 0,
    flushes = 0;
  setImmediate(() => {
    active = 0;
    pending = 1;
  });
  await drainBenchmark({
    active: () => active,
    pending: () => pending,
    async flush() {
      flushes++;
      pending = 0;
      if (flushes === 1)
        queueMicrotask(() => {
          pending = 1;
        });
    },
  });
  assert.equal(flushes, 2);
  await assert.rejects(
    drainBenchmark({ active: () => 1, pending: () => 0, flush: async () => {} }, 0),
    /did not drain/,
  );
  for (const hanging of ['flush', 'yieldTask'])
    await assert.rejects(
      drainBenchmark(
        {
          active: () => 0,
          pending: () => 0,
          flush: async () => {},
          [hanging]: () => new Promise(() => {}),
        },
        5,
      ),
      /did not drain/,
    );
});

test('benchmark oracle checks complete values, identities and lifecycle order', () => {
  const request = { request_id: '0:0', payload: 'small' };
  assertBenchmarkResponse({ ...request, durationMs: 3 }, request);
  assert.throws(
    () => assertBenchmarkResponse({ ...request, payload: 'wrong', durationMs: 3 }, request),
    /complete input/,
  );
  assert.throws(() => assertBenchmarkResponse({ ...request, durationMs: NaN }, request), /duration metadata/);
  const graph = {
    metadata: { id: 'graph' },
    nodes: [
      { id: 'input', type: 'graphInput', data: {} },
      { id: 'text', type: 'text', data: { text: 'fixture' } },
      { id: 'output', type: 'graphOutput', data: {} },
    ],
    connections: [],
  };
  const capture = {
    events: [
      { type: 'start', data: { inputs: { input: { value: request } } } },
      { type: 'graphStart', data: { graphId: 'graph' } },
      ...graph.nodes.flatMap((node) => [
        { type: 'nodeStart', data: { nodeId: node.id, processId: node.id } },
        {
          type: 'nodeFinish',
          data: {
            nodeId: node.id,
            processId: node.id,
            outputs: {
              [node.type === 'text' ? 'output' : node.type === 'graphInput' ? 'data' : 'valueOutput']:
                node.type === 'text' ? { type: 'string', value: 'fixture' } : { type: 'any', value: request },
            },
          },
        },
      ]),
      { type: 'graphFinish', data: { graphId: 'graph' } },
      { type: 'done', data: { results: { output: { value: request } } } },
    ],
  };
  const snapshot = { graphs: { graph: structuredClone(graph) } };
  assertBenchmarkRecording(capture, snapshot, graph, new Set());
  const incomplete = structuredClone(capture);
  incomplete.events = incomplete.events.filter((event) => event.type !== 'nodeFinish' || event.data.nodeId !== 'text');
  assert.throws(() => assertBenchmarkRecording(incomplete, snapshot, graph, new Set()), /Every node must finish/);
  const wrong = structuredClone(capture);
  wrong.events.find((event) => event.type === 'nodeFinish' && event.data.nodeId === 'text').data.outputs.output.value =
    'wrong';
  assert.throws(() => assertBenchmarkRecording(wrong, snapshot, graph, new Set()));
  const reversed = structuredClone(capture);
  [reversed.events[2], reversed.events[3]] = [reversed.events[3], reversed.events[2]];
  assert.throws(() => assertBenchmarkRecording(reversed, snapshot, graph, new Set()), /lifecycle order/);
  assert.throws(() => assertBenchmarkRecording(capture, { graphs: {} }, graph, new Set()), /complete executed graph/);
  assert.throws(
    () => assertBenchmarkRecording(capture, snapshot, graph, new Set(['0:0'])),
    /Duplicate recorded request/,
  );
  assertBenchmarkRequests(new Set(['0:0']), [{ round: 0, count: 1 }]);
  assert.throws(() => assertBenchmarkRequests(new Set(['other']), [{ round: 0, count: 1 }]), /recorded request/);
  assert.throws(
    () =>
      assertBenchmarkRequests(new Set(['0:0', 'other']), [
        { round: 0, count: 1 },
        { round: 0, count: 1 },
      ]),
    /Duplicate expected request/,
  );
});

test('benchmark entry point preserves an existing result directory before starting Docker', async (t) => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'recording-benchmark-output-'));
  const marker = path.join(output, 'manifest.json');
  t.after(async () => {
    await fs.unlink(marker);
    await fs.rmdir(output);
  });
  await fs.writeFile(marker, 'previous evidence');
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('./benchmark-recording-memory.mjs', import.meta.url)),
      '--original',
      'unused-before',
      '--candidate',
      'unused-after',
      '--image',
      'unused-image',
      '--output',
      output,
    ],
    { encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /EEXIST/);
  assert.equal(await fs.readFile(marker, 'utf8'), 'previous evidence');
});

test('benchmark fingerprints distinguish serving code from the common test fixture', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'recording-fingerprint-'));
  t.after(() => fs.rm(root, { recursive: true }));
  for (const pkg of ['core', 'node', 'evaluations', 'studio-server-api', 'studio-server-bootstrap']) {
    const dir = path.join(root, 'packages', pkg, ...(pkg === 'studio-server-bootstrap' ? [] : ['dist']));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'server.js'), 'serving code');
  }
  const fixture = path.join(root, 'packages/studio-server-api/dist/tests/fixture.js');
  await fs.mkdir(path.dirname(fixture));
  await fs.writeFile(fixture, 'first fixture');
  const original = await fingerprint(root);
  await fs.writeFile(fixture, 'updated common fixture');
  const fixtureChange = await fingerprint(root);
  assert.notEqual(original.full, fixtureChange.full);
  assert.equal(original.serving, fixtureChange.serving);
  await fs.writeFile(path.join(root, 'packages/core/dist/server.js'), 'changed serving code');
  assert.notEqual(original.serving, (await fingerprint(root)).serving);
});

test('benchmark summary pools raw latencies and preserves the paired difference direction', () => {
  const row = (side, round, latencies, p95, totalMs) => ({
    side,
    round,
    latencies,
    p95,
    totalMs,
    resources: { eventLoopMaxMs: 1 },
  });
  const rows = [
    row('original', 0, [0], 0, 10),
    row('original', 1, Array(19).fill(100), 100, 30),
    row('candidate', 0, [1], 1, 5),
    row('candidate', 1, Array(19).fill(101), 101, 25),
  ];
  const result = summarize(rows);
  assert.equal(result.original.p95, 100); // Averaging the batch percentiles would incorrectly report 50.
  assert.equal(result.candidate.p95, 101);
  assert.deepEqual(result.pairedDifference.p95, { lower95: 1, upper95: 1 });
  assert.deepEqual(result.pooledP95Difference, { difference: 1, lower95: 1, upper95: 1 });
  assert.deepEqual(result.pairedDifference.totalMs, { lower95: -5, upper95: -5 });
  assert.throws(() => summarize([]), /No measured/);
  assert.throws(() => summarize(rows.slice(0, 3)), /Missing paired/);
  assert.throws(() => summarize([...rows, rows[0]]), /Duplicate/);
  assert.throws(
    () => summarize(rows.map((value, index) => (index === 0 ? { ...value, latencies: [0, 1] } : value))),
    /sample counts/,
  );
  assert.throws(() => summarize(rows.map((value) => ({ ...value, count: 500 }))), /Incomplete measured batch/);
  assert.throws(() => summarize(rows.map((value) => ({ ...value, totalMs: NaN }))), /Invalid totalMs/);
  const single = summarize([rows[0], rows[2]]);
  assert.equal(single.pairCount, 1);
  assert.equal(single.pooledP95Difference.difference, 1);
  assert.equal(single.pooledP95Difference.lower95, undefined);
  assert.equal(single.pairedDifference, undefined);
  assert.deepEqual(summarize(rows.map((value) => ({ ...value, p95: -100 }))), result);
  const mixed = rows.map((value) => ({ ...value, smallLatencies: value.side === 'original' ? [4] : [2] }));
  assert.equal(summarize(mixed, 'smallLatencies').pooledP95Difference.difference, -2);
});
