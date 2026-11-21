import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as delay, setImmediate as yieldToIo } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Agent, request as httpRequest } from 'node:http';

// Local-only black-box comparison. Runtime modules are never patched. Both
// versions use the same test fixture and image dependencies, with their own builds.
const packages = ['core', 'node', 'evaluations', 'studio-server-api', 'studio-server-bootstrap'];
const packageDirectory = (root, pkg) =>
  path.join(root, 'packages', pkg, ...(pkg === 'studio-server-bootstrap' ? [] : ['dist']));
const script = fileURLToPath(import.meta.url);
const docker = (...args) =>
  execFileSync('docker', args, { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  if (process.argv[2] === '--serve') await serve();
  else await compare();
}

export function parseOptions(args = process.argv.slice(2)) {
  const result = {};
  const keys = new Set([
    'original',
    'candidate',
    'output',
    'profile',
    'backend',
    'workload',
    'batches',
    'samples',
    'rate',
    'diagnostics',
    'image',
    'max-scheduling-delay-ms',
    'warmup-batches',
    'warmup-samples',
    'duration-seconds',
    'api-profile',
    'pending-writes',
    'audit-timeout-ms',
    'first-side',
    'settings-backend',
    'original-compression',
    'candidate-compression',
  ]);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.replace(/^--/, '');
    if (!keys.has(key) || !args[index + 1] || key in result) throw new Error('Invalid benchmark arguments');
    result[key] = args[index + 1];
  }
  for (const key of ['original', 'candidate', 'output', 'image']) assert.ok(result[key], `Missing --${key}`);
  result.profile ??= 'production';
  for (const side of ['original', 'candidate'])
    if (result[`${side}-compression`] !== undefined)
      assert.ok(['gzip', 'identity', 'br'].includes(result[`${side}-compression`]), 'Invalid recording codec');
  result.backend ??= 'managed';
  result.workload ??= 'small';
  result.diagnostics ??= 'none';
  assert.ok(['none', 'cpu', 'phases'].includes(result.diagnostics));
  assert.ok(['production', 'smallest'].includes(result.profile));
  assert.ok(['filesystem', 'managed'].includes(result.backend));
  assert.ok(['small', 'nodes', 'chain', 'large', 'mixed', 'stall', 'retained', 'aliases'].includes(result.workload));
  result['api-profile'] ??= result.backend === 'managed' ? 'execution' : 'combined';
  result['settings-backend'] ??= result.backend === 'managed' ? 'postgres' : 'file';
  assert.ok(['file', 'postgres'].includes(result['settings-backend']));
  assert.ok(result.backend === 'managed' || result['settings-backend'] === 'file');
  assert.ok(['execution', 'combined'].includes(result['api-profile']));
  assert.ok(result.backend === 'managed' || result['api-profile'] === 'combined');
  result['first-side'] ??= 'original';
  assert.ok(['original', 'candidate'].includes(result['first-side']));
  result['warmup-batches'] = Number(result['warmup-batches'] ?? 4);
  result['warmup-samples'] = Number(result['warmup-samples'] ?? 64);
  result['pending-writes'] = Number(result['pending-writes'] ?? 100);
  result['audit-timeout-ms'] = Number(result['audit-timeout-ms'] ?? 180_000);
  for (const [key, min, max] of [
    ['warmup-batches', 1, 8],
    ['warmup-samples', 4, 256],
    ['pending-writes', 1, 1000],
    ['audit-timeout-ms', 1000, 900_000],
  ])
    assert.ok(Number.isSafeInteger(result[key]) && result[key] >= min && result[key] <= max, `Invalid ${key}`);
  const sustained = result['duration-seconds'] !== undefined;
  if (sustained) {
    result['duration-seconds'] = Number(result['duration-seconds']);
    assert.ok(
      Number.isSafeInteger(result['duration-seconds']) &&
        result['duration-seconds'] >= 1 &&
        result['duration-seconds'] <= 600,
    );
    assert.ok(result.samples === undefined, 'Sustained runs derive samples from duration and rate');
  }
  result.batches = Number(result.batches ?? (sustained ? 1 : 8));
  result.samples = Number(result.samples ?? (['large', 'stall'].includes(result.workload) ? 32 : 256));
  result.rate = Number(result.rate ?? (result.profile === 'production' ? 128 : 24));
  assert.ok(Number.isSafeInteger(result.batches) && result.batches >= 1 && result.batches <= 16);
  assert.ok(Number.isSafeInteger(result.samples) && result.samples >= 4 && result.samples <= 4096);
  assert.ok(Number.isSafeInteger(result.rate) && result.rate >= 0 && result.rate <= 1000);
  if (sustained) {
    assert.ok(result.rate > 0 && result.batches === 1, 'Sustained runs require a positive rate and one phase');
    result.samples = result.rate * result['duration-seconds'];
  }
  assert.ok(
    result.samples * result.batches + result['warmup-batches'] * result['warmup-samples'] <= 10000,
    'Workload exceeds fixture recording retention',
  );
  if (result['max-scheduling-delay-ms'] !== undefined) {
    result['max-scheduling-delay-ms'] = Number(result['max-scheduling-delay-ms']);
    assert.ok(Number.isFinite(result['max-scheduling-delay-ms']) && result['max-scheduling-delay-ms'] > 0);
  }
  return result;
}

export function benchmarkWarmups(config) {
  return Array.from({ length: config['warmup-batches'] }, (_, index) => ({
    round: index - config['warmup-batches'],
    count: config['warmup-samples'],
  }));
}

export async function drainBenchmark({ active, pending, flush, yieldTask = yieldToIo }, timeoutMs = 30_000) {
  const end = performance.now() + timeoutMs;
  const remaining = () => Math.max(0, end - performance.now());
  const message = 'Benchmark execution owners or recording work did not drain';
  while (remaining() > 0) {
    if (active() === 0) {
      await deadline(flush(), remaining(), message);
      await deadline(yieldTask(), remaining(), message);
      if (remaining() > 0 && active() === 0 && pending() === 0) return;
    } else await delay(1);
  }
  throw new Error(message);
}

export function assertBenchmarkRecording(capture, snapshot, graph, seenRequests) {
  const starts = capture.events.filter((event) => event.type === 'start');
  const done = capture.events.filter((event) => event.type === 'done');
  assert.equal(starts.length, 1, 'One root start per recording');
  assert.equal(done.length, 1, 'One root terminal per recording');
  assert.equal(
    capture.events.some((event) => ['error', 'nodeError', 'graphError', 'abort'].includes(event.type)),
    false,
  );
  const request = starts[0].data.inputs.input.value;
  assert.equal(typeof request.request_id, 'string');
  assert.ok(!seenRequests.has(request.request_id), `Duplicate recorded request ${request.request_id}`);
  seenRequests.add(request.request_id);
  assert.deepEqual(done[0].data.results.output.value, request);
  assert.deepEqual(snapshot.graphs[graph.metadata.id], graph, 'The complete executed graph must be replayable');
  const graphPositions = {};
  for (const type of ['graphStart', 'graphFinish']) {
    const events = capture.events.filter((event) => event.type === type);
    assert.equal(events.length, 1);
    assert.equal(events[0].data.graphId, graph.metadata.id);
    graphPositions[type] = capture.events.indexOf(events[0]);
  }
  assert.ok(capture.events.indexOf(starts[0]) < graphPositions.graphStart, 'Root start must precede graph start');
  assert.ok(graphPositions.graphStart < graphPositions.graphFinish, 'Graph start must precede graph finish');
  assert.ok(graphPositions.graphFinish < capture.events.indexOf(done[0]), 'Graph finish must precede root completion');
  const nodeStarts = new Map(),
    nodeFinishes = new Map();
  for (const [position, event] of capture.events.entries()) {
    const index = event.type === 'nodeStart' ? nodeStarts : event.type === 'nodeFinish' ? nodeFinishes : null;
    if (!index) continue;
    assert.ok(!index.has(event.data.nodeId), `Duplicate ${event.type}: ${event.data.nodeId}`);
    index.set(event.data.nodeId, { data: event.data, position });
  }
  assert.equal(nodeStarts.size, graph.nodes.length, 'Every node must start');
  assert.equal(nodeFinishes.size, graph.nodes.length, 'Every node must finish');
  for (const node of graph.nodes) {
    const started = nodeStarts.get(node.id),
      finished = nodeFinishes.get(node.id);
    assert.ok(started && finished, `Missing node recording: ${node.id}`);
    assert.ok(
      graphPositions.graphStart < started.position &&
        started.position < finished.position &&
        finished.position < graphPositions.graphFinish,
      `Invalid node lifecycle order: ${node.id}`,
    );
    const start = started.data,
      finish = finished.data;
    assert.equal(typeof start.processId, 'string');
    assert.ok(start.processId.length > 0);
    assert.equal(start.processId, finish.processId);
    if (node.type === 'text') assert.deepEqual(finish.outputs.output, { type: 'string', value: node.data.text });
    else {
      const port = { graphInput: 'data', graphOutput: 'valueOutput', passthrough: 'output1', code: 'response' }[
        node.type
      ];
      assert.ok(port, `Unexpected benchmark node type: ${node.type}`);
      assert.deepEqual(finish.outputs[port].value, request);
      if (node.type === 'passthrough') assert.deepEqual(start.inputs.input1.value, request);
    }
  }
  return request;
}

export function assertBenchmarkRequests(seen, batches) {
  const expected = new Set();
  for (const { round, count } of batches)
    for (let index = 0; index < count; index++) {
      const id = `${round}:${index}`;
      assert.ok(!expected.has(id), 'Duplicate expected request');
      expected.add(id);
    }
  assert.deepEqual(seen, expected, 'Missing or unexpected recorded request');
}

export function assertBenchmarkResponse(actual, expected) {
  const { durationMs, ...output } = actual;
  assert.ok(Number.isFinite(durationMs) && durationMs >= 0, 'Invalid endpoint duration metadata');
  assert.deepEqual(output, expected, 'The HTTP response must preserve the complete input');
}

export async function fingerprint(root) {
  const hash = createHash('sha256');
  const servingHash = createHash('sha256');
  for (const pkg of packages) {
    const dir = packageDirectory(root, pkg);
    const files = (await fs.readdir(dir, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(entry.parentPath, entry.name))
      .sort();
    assert.ok(files.length, `Build ${pkg} first`);
    for (const file of files) {
      const name = path.relative(root, file).replaceAll('\\', '/');
      const bytes = await fs.readFile(file);
      hash.update(name).update(bytes);
      if (!path.relative(dir, file).replaceAll('\\', '/').split('/').includes('tests'))
        servingHash.update(name).update(bytes);
    }
  }
  return { full: hash.digest('hex'), serving: servingHash.digest('hex') };
}

async function compare() {
  const config = parseOptions();
  const sources = { original: path.resolve(config.original), candidate: path.resolve(config.candidate) };
  const output = path.resolve(config.output);
  await fs.mkdir(path.dirname(output), { recursive: true });
  // Never overwrite evidence from an earlier run, including a failed attempt.
  await fs.mkdir(output);
  const prefix = `rivet-rec-${randomUUID().slice(0, 12)}`;
  const owned = [];
  const runners = [];
  const rows = [];
  const cpus = config.profile === 'production' ? '2' : '0.5';
  const memory = config.profile === 'production' ? '4g' : '1g';
  const concurrency = config.profile === 'production' ? 32 : 4;
  const fingerprints = Object.fromEntries(
    await Promise.all(Object.entries(sources).map(async ([key, root]) => [key, await fingerprint(root)])),
  );
  const hashes = Object.fromEntries(Object.entries(fingerprints).map(([side, value]) => [side, value.full]));
  const servingHashes = Object.fromEntries(Object.entries(fingerprints).map(([side, value]) => [side, value.serving]));
  const fixturePath = path.resolve(
    path.dirname(script),
    '../packages/studio-server-api/dist/studio-server-api/src/tests/helpers/workflow-async-server.mjs',
  );
  const harnessHash = createHash('sha256')
    .update(await fs.readFile(script))
    .update(await fs.readFile(fixturePath))
    .digest('hex');
  const metadata = {
    config,
    hashes,
    servingHashes,
    harnessHash,
    node: process.version,
    driverPlatform: process.platform,
    driverArch: process.arch,
    image: docker('image', 'inspect', '--format', '{{.Id}}', config.image),
    cpus,
    memory,
    concurrency,
  };
  await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(metadata, null, 2));
  try {
    docker('network', 'create', prefix);
    owned.push({ kind: 'network', name: prefix });
    const sides = config['first-side'] === 'original' ? ['original', 'candidate'] : ['candidate', 'original'];
    for (const side of sides) {
      if (config.backend === 'managed') {
        for (const [role, args] of [
          [
            'postgres',
            ['-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_DB=recording_benchmark', 'postgres:16.8-alpine'],
          ],
          [
            'minio',
            [
              '-e',
              'MINIO_ROOT_USER=fixture',
              '-e',
              'MINIO_ROOT_PASSWORD=fixture-secret',
              'alpine/minio:RELEASE.2025-10-15T17-29-55Z',
              'server',
              '/tmp/minio',
            ],
          ],
        ]) {
          const name = `${prefix}-${side}-${role}`;
          docker('run', '--rm', '-d', '--pull', 'never', '--network', prefix, '--name', name, ...args);
          owned.push({ kind: 'container', name });
        }
      }
      runners.push(await start(side));
    }
    for (const { round, count } of benchmarkWarmups(config))
      for (const runner of runners) await runBenchmarkPhase(runner, config, concurrency, round, count);
    for (let round = 0; round < config.batches; round++) {
      for (const runner of round % 2 ? [...runners].reverse() : runners) {
        const row = await runBenchmarkPhase(runner, config, concurrency, round, config.samples);
        rows.push(row);
        await fs.appendFile(path.join(output, 'samples.jsonl'), JSON.stringify(row) + '\n');
        console.log(JSON.stringify({ side: row.side, round, p95: row.p95, totalMs: row.totalMs, ...row.resources }));
        assert.notEqual(row.schedulerWithinBound, false, 'Load driver exceeded the declared scheduling-delay bound');
      }
    }
    const audits = {};
    for (const runner of runners) {
      const audit = await runner.command('benchmark-audit', config['audit-timeout-ms'], { batches: runner.batches });
      assert.equal(audit.audited, runner.expected, 'Every accepted request must have a usable recording');
      audits[runner.side] = audit;
    }
    const result = {
      ...metadata,
      audits,
      summary: summarize(rows),
      ...(rows.every((row) => row.smallLatencies.length) ? { smallSummary: summarize(rows, 'smallLatencies') } : {}),
      ...(config.rate ? { scheduledSummary: summarize(rows, 'scheduledLatencies') } : {}),
      rows,
    };
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ summary: result.summary, audits }));
  } catch (error) {
    await fs.writeFile(
      path.join(output, 'failure.json'),
      JSON.stringify(
        {
          message: error.message,
          code: error.code,
          side: error.side,
          round: error.round,
          reusedSocket: error.reusedSocket,
          completedBatches: rows.length,
          traffic: error.traffic,
          runners: runners.map((runner) => runner.diagnostics()),
        },
        null,
        2,
      ),
    );
    throw error;
  } finally {
    for (const runner of runners) await runner.stop();
    for (const item of owned.reverse()) {
      assert.ok(item.name.startsWith(prefix));
      try {
        docker(
          item.kind === 'network' ? 'network' : 'container',
          'rm',
          ...(item.kind === 'container' ? ['-f'] : []),
          item.name,
        );
      } catch (error) {
        if (item.kind === 'container' && String(error.stderr).includes('No such container')) continue;
        console.error(`Owned fixture cleanup failed: ${item.name}: ${error.message}`);
        process.exitCode = 1;
      }
    }
  }

  async function start(side) {
    const name = `${prefix}-${side}-api`;
    owned.push({ kind: 'container', name });
    const args = [
      'run',
      '--rm',
      '-i',
      '--pull',
      'never',
      '--name',
      name,
      '--network',
      prefix,
      '--cpus',
      cpus,
      '--memory',
      memory,
      '--memory-swap',
      memory,
      '-p',
      '127.0.0.1::8080',
      '--entrypoint',
      'node',
      '--workdir',
      '/app',
      '-e',
      `BENCH_SIDE=${side}`,
      '-e',
      `BENCH_PREFIX=${prefix}`,
      '-e',
      `BENCH_BACKEND=${config.backend}`,
      '-e',
      `BENCH_WORKLOAD=${config.workload}`,
      '-e',
      `BENCH_CONCURRENCY=${concurrency}`,
      '-e',
      `BENCH_PHASE_DIAGNOSTICS=${config.diagnostics === 'phases' && side === 'candidate' ? 'true' : 'false'}`,
      '-e',
      `BENCH_API_PROFILE=${config['api-profile']}`,
      '-e',
      `BENCH_PENDING_WRITES=${config['pending-writes']}`,
      '-e',
      `BENCH_SETTINGS_BACKEND=${config['settings-backend']}`,
    ];
    if (config.diagnostics === 'cpu')
      args.push('-e', 'BENCH_CPU_PROFILE=1', '--mount', `type=bind,source=${output},target=/profile`);
    for (const pkg of packages)
      args.push(
        '--mount',
        `type=bind,source=${packageDirectory(sources[side], pkg)},target=/app/packages/${pkg}${pkg === 'studio-server-bootstrap' ? '' : '/dist'},readonly`,
      );
    if (config[`${side}-compression`]) args.push('-e', `BENCH_RECORDING_COMPRESSION=${config[`${side}-compression`]}`);
    // Only the identical test fixture is shared; each side's application code
    // and Core/Node implementation come entirely from its fingerprinted build.
    args.push(
      '--mount',
      `type=bind,source=${fixturePath},target=/app/benchmark-fixture.mjs,readonly`,
      '--mount',
      `type=bind,source=${script},target=/app/benchmark-recording-memory.mjs,readonly`,
      metadata.image,
      '/app/benchmark-recording-memory.mjs',
      '--serve',
    );
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const pending = new Map();
    let sequence = 0;
    let logs = '';
    let failure;
    let ready;
    const startup = new Promise((resolve, reject) => {
      ready = { resolve, reject };
    });
    const fail = (error) => {
      failure = error;
      ready.reject(error);
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
    };
    const exited = new Promise((resolve, reject) => {
      child.once('error', (error) => {
        fail(error);
        reject(error);
      });
      child.once('close', (code) => {
        const error = new Error(`Benchmark API ${side} exited ${code}: ${logs}`);
        fail(error);
        resolve(code);
      });
    });
    void exited.catch(() => {});
    child.stdin.on('error', fail);
    child.stderr.on('data', (bytes) => {
      logs = (logs + bytes).slice(-32_000);
    });
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (!line.startsWith('BENCH ')) {
        logs = (logs + line + '\n').slice(-32_000);
        return;
      }
      let message;
      try {
        message = JSON.parse(line.slice(6));
      } catch (error) {
        fail(error);
        return;
      }
      if (message.ready) return ready.resolve(message.ready);
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error));
        else waiter.resolve(message.result);
      }
    });
    const readyState = await deadline(startup, 90_000, `${side} startup`);
    assert.equal(readyState.storageMode, config.backend);
    metadata.testedNode = readyState.nodeVersion;
    const ports = JSON.parse(docker('inspect', '--format', '{{json .NetworkSettings.Ports}}', name));
    const port = ports['8080/tcp']?.[0]?.HostPort;
    assert.ok(port, `Missing local benchmark port: ${JSON.stringify(ports)}`);
    return {
      side,
      expected: 0,
      batches: [],
      url: `http://127.0.0.1:${port}/workflows/recording-benchmark`,
      diagnostics: () => ({ side, logs, failure: failure?.message }),
      command(command, timeout = 30_000, payload = {}) {
        if (failure) return Promise.reject(failure);
        const id = sequence++;
        const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
        child.stdin.write(JSON.stringify({ id, command, ...payload }) + '\n');
        return deadline(result, timeout, command).finally(() => pending.delete(id));
      },
      async stop() {
        if (child.exitCode !== null) return;
        await this.command('shutdown', 10_000).catch(() => {});
        child.stdin.end();
        await deadline(exited, 15_000, `${side} shutdown`).catch(() => {});
      },
    };
  }
}

export async function runBenchmarkPhase(runner, config, concurrency, round, count) {
  // Each paired batch gets the same fully warm HTTP pool. Reusing the global
  // fetch pool gave alternating sides different idle/connection-expiry states.
  const agent = new Agent({ keepAlive: true, maxSockets: concurrency, maxFreeSockets: concurrency });
  const driverDelay = monitorEventLoopDelay({ resolution: 10 });
  const requests = [];
  let completedCount = 0;
  let failedCount = 0;
  let missed = 0;
  try {
    const healthUrl = new URL('/healthz', runner.url);
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        const response = await requestBody(healthUrl, agent);
        assert.equal(response.status, 200);
      }),
    );
    await runner.command('benchmark-drain');
    await runner.command('begin-snapshot-timing');
    driverDelay.enable();
    const driverCpu = process.cpuUsage();
    const driverLoop = performance.eventLoopUtilization();
    const begun = performance.now();
    const latencies = [];
    const smallLatencies = [];
    const scheduleDelays = [];
    const scheduledLatencies = [];
    const wireLatencies = [];
    const timings = [];
    let active = 0;
    for (let index = 0; index < count; index++) {
      const due = config.rate ? begun + (index * 1000) / config.rate : null;
      if (config.rate) {
        while (performance.now() < due) await delay(Math.max(1, due - performance.now()));
        if (active >= concurrency) {
          missed++;
          continue;
        }
      } else if (active >= concurrency)
        await Promise.race(requests.filter((item) => !item.settled).map((item) => item.promise));
      const big =
        config.workload === 'large' ||
        (config.workload === 'mixed' && index % 8 === 0) ||
        (['stall', 'retained'].includes(config.workload) && index === 0);
      const bytes = ['stall', 'retained'].includes(config.workload) && big ? 5 * 1024 * 1024 : big ? 1024 * 1024 : 32;
      const responseBytes = ['retained', 'aliases'].includes(config.workload) ? 32 : bytes;
      const expectedResponse = {
        request_id: `${round}:${index}`,
        payload: 'x'.repeat(responseBytes),
        recordingBytes: big ? bytes : 0,
      };
      const body = JSON.stringify(expectedResponse);
      const task = { settled: false };
      active++;
      task.promise = (async () => {
        const started = performance.now();
        if (due !== null) scheduleDelays.push(Math.max(0, started - due));
        const response = await requestBody(runner.url, agent, body);
        const received = response.receivedAt;
        if (response.status !== 200) throw new Error(`HTTP ${response.status}: ${response.body.subarray(0, 512)}`);
        const result = JSON.parse(response.body.toString('utf8'));
        assert.equal(result.request_id, `${round}:${index}`);
        assert.equal(result.payload.length, responseBytes);
        const completed = performance.now();
        assertBenchmarkResponse(result, expectedResponse);
        const elapsed = completed - started;
        latencies.push(elapsed);
        completedCount++;
        wireLatencies.push(received - started);
        if (!big) smallLatencies.push(elapsed);
        if (due !== null) scheduledLatencies.push(completed - due);
        timings.push({
          id: `${round}:${index}`,
          plannedMs: due === null ? null : due - begun,
          startedMs: started - begun,
          completedMs: completed - begun,
          receivedMs: received - begun,
          large: big,
        });
      })()
        .catch((error) => {
          failedCount++;
          throw error;
        })
        .finally(() => {
          active--;
          task.settled = true;
        });
      // Keep rejected requests observed while the driver schedules the rest.
      void task.promise.catch(() => {});
      requests.push(task);
    }
    await Promise.all(requests.map((item) => item.promise));
    const responseMs = performance.now() - begun;
    if (round >= 0 && config['duration-seconds']) {
      const until = begun + config['duration-seconds'] * 1000;
      while (performance.now() < until) await delay(Math.max(1, until - performance.now()));
    }
    const phaseMs = performance.now() - begun;
    driverDelay.disable();
    const driverUsage = process.cpuUsage(driverCpu);
    const driverResources = {
      cpuMs: (driverUsage.user + driverUsage.system) / 1000,
      eventLoop: performance.eventLoopUtilization(driverLoop),
      eventLoopMaxMs: driverDelay.max / 1e6,
    };
    const servingResources = await runner.command('snapshot-timing-window');
    const drained = await runner.command('benchmark-drain', 180_000);
    const totalMs = performance.now() - begun;
    const resources = await runner.command('finish-snapshot-timing');
    if (config['settings-backend'])
      assert.equal(resources.settingsBackend, config['settings-backend'], 'API must use the declared settings backend');
    const admission = await runner.command('execution-admission');
    assert.equal(admission.activeRuns, 0, 'Execution permits must settle');
    assert.equal(admission.mode, 'enforce', 'Execution admission must remain enabled');
    assert.equal(admission.maxActiveRuns, concurrency, 'Execution limit must match the declared profile');
    if (drained.memory) {
      assert.equal(drained.memory.captures, 0);
      assert.equal(drained.memory.estimatedBytes, 0);
      assert.equal(drained.memory.rejections, 0, 'Healthy fixture recordings must not be dropped');
    }
    runner.expected += requests.length;
    runner.batches.push({ round, count });
    assert.equal(missed, 0, 'Offered workload exceeded the outstanding-request cap');
    return {
      side: runner.side,
      round,
      count,
      rate: config.rate,
      responseMs,
      phaseMs,
      totalMs,
      drainMs: totalMs - phaseMs,
      resources,
      servingResources,
      driverResources,
      recordingMemory: drained.memory ?? null,
      executionAdmission: admission,
      traffic: { offered: count, sent: requests.length, completed: latencies.length, missed },
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
      smallP95: percentile(smallLatencies, 0.95),
      schedulingP99Ms: percentile(scheduleDelays, 0.99),
      schedulerWithinBound:
        config.rate && config['max-scheduling-delay-ms'] !== undefined
          ? Math.max(...scheduleDelays) <= config['max-scheduling-delay-ms']
          : null,
      latencies,
      wireLatencies,
      smallLatencies,
      scheduledLatencies,
      timings,
    };
  } catch (error) {
    Object.assign(error, {
      side: runner.side,
      round,
      traffic: {
        offered: count,
        sent: requests.length,
        completed: completedCount,
        failed: failedCount,
        missed,
      },
    });
    throw error;
  } finally {
    driverDelay.disable();
    agent.destroy();
    await Promise.allSettled(requests.map((item) => item.promise));
  }
}

export function requestBody(url, agent, body) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        agent,
        method: body === undefined ? 'GET' : 'POST',
        signal: AbortSignal.timeout(30_000),
        headers:
          body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (response) => {
        const parts = [];
        response.on('data', (part) => parts.push(part));
        response.once('error', reject);
        response.once('aborted', () => reject(new Error('Benchmark response aborted')));
        response.once('end', () =>
          resolve({ receivedAt: performance.now(), status: response.statusCode, body: Buffer.concat(parts) }),
        );
      },
    );
    request.once('error', (error) => reject(Object.assign(error, { reusedSocket: request.reusedSocket })));
    request.end(body);
  });
}

function percentile(values, fraction) {
  if (!values.length) return null;
  return [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)];
}

export function summarize(rows, latencyField = 'latencies') {
  assert.ok(rows.length > 0, 'No measured batches');
  rows = rows.map((row) => {
    const latencies = row[latencyField];
    assert.ok(
      Array.isArray(latencies) &&
        latencies.length > 0 &&
        latencies.every((value) => Number.isFinite(value) && value >= 0),
      'Invalid request latencies',
    );
    if (latencyField === 'latencies' && row.count !== undefined)
      assert.equal(latencies.length, row.count, 'Incomplete measured batch');
    for (const key of ['totalMs', 'responseMs', 'drainMs'])
      if (key === 'totalMs' || row[key] !== undefined)
        assert.ok(Number.isFinite(row[key]) && row[key] >= 0, `Invalid ${key}`);
    return { ...row, latencies, p95: percentile(latencies, 0.95) };
  });
  const pairKeys = new Set();
  for (const row of rows) {
    assert.ok(['original', 'candidate'].includes(row.side));
    const key = `${row.side}:${row.round}`;
    assert.ok(!pairKeys.has(key), 'Duplicate measured batch');
    pairKeys.add(key);
    const paired = rows.find((other) => other.side !== row.side && other.round === row.round);
    assert.ok(paired, 'Missing paired batch');
    assert.equal(row.latencies.length, paired.latencies.length, 'Paired sample counts differ');
  }
  const result = {};
  for (const side of ['original', 'candidate']) {
    const own = rows.filter((row) => row.side === side);
    result[side] = {
      p95: percentile(
        own.flatMap((row) => row.latencies),
        0.95,
      ),
      meanTotalMs: own.reduce((sum, row) => sum + row.totalMs, 0) / own.length,
      maxStallMs: Math.max(...own.map((row) => row.resources.eventLoopMaxMs)),
    };
  }
  // Resample whole matched batches; requests within a batch are correlated.
  const original = rows.filter((row) => row.side === 'original');
  const candidate = original.map((row) =>
    rows.find((other) => other.side === 'candidate' && other.round === row.round),
  );
  result.pairCount = original.length;
  result.pooledP95Difference = { difference: result.candidate.p95 - result.original.p95 };
  // One pair provides no between-batch variation to resample. Report point estimates only.
  if (original.length < 2) return result;
  const fields = [
    'p95',
    'totalMs',
    ...['responseMs', 'drainMs'].filter((key) => rows.every((row) => Number.isFinite(row[key]))),
  ];
  const differences = original.map((row, index) =>
    Object.fromEntries(fields.map((key) => [key, candidate[index][key] - row[key]])),
  );
  const pools = [original, candidate].map((batches) => ({
    sizes: batches.map((row) => row.latencies.length),
    values: batches
      .flatMap((row, batch) => row.latencies.map((value) => ({ value, batch })))
      .sort((a, b) => a.value - b.value),
  }));
  const weightedP95 = (pool, weights) => {
    const rank = Math.ceil(pool.sizes.reduce((sum, size, batch) => sum + size * weights[batch], 0) * 0.95);
    let seen = 0;
    for (const entry of pool.values) {
      seen += weights[entry.batch];
      if (seen >= rank) return entry.value;
    }
    throw new Error('Empty resampled pool');
  };
  let seed = 0x12345678;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 2 ** 32;
  };
  const samples = Object.fromEntries([...fields, 'pooled'].map((key) => [key, []]));
  for (let repeat = 0; repeat < 10_000; repeat++) {
    const weights = Array(differences.length).fill(0);
    for (let index = 0; index < differences.length; index++) weights[Math.floor(random() * weights.length)]++;
    for (const key of fields)
      samples[key].push(
        differences.reduce((sum, row, batch) => sum + row[key] * weights[batch], 0) / differences.length,
      );
    samples.pooled.push(weightedP95(pools[1], weights) - weightedP95(pools[0], weights));
  }
  const interval = (values) => ({ lower95: percentile(values, 0.025), upper95: percentile(values, 0.975) });
  result.pairedDifference = Object.fromEntries(fields.map((key) => [key, interval(samples[key])]));
  Object.assign(result.pooledP95Difference, interval(samples.pooled));
  return result;
}

async function serve() {
  const { createRequire } = await import('node:module');
  const require = createRequire('/app/packages/studio-server-api/package.json');
  const backend = process.env.BENCH_BACKEND;
  const root = '/tmp/recording-benchmark';
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('RIVET_')));
  if (process.env.BENCH_RECORDING_COMPRESSION) env.RIVET_RECORDINGS_COMPRESS = process.env.BENCH_RECORDING_COMPRESSION;
  Object.assign(env, {
    PORT: '8080',
    RIVET_ASYNC_TEST_ROOT: root,
    DOTENV_CONFIG_PATH: `${root}/absent.env`,
    RIVET_APP_DATA_ROOT: `${root}/app`,
    RIVET_WORKFLOWS_ROOT: `${root}/workflows`,
    RIVET_WORKSPACE_ROOT: root,
    RIVET_WORKFLOW_RECORDINGS_ROOT: `${root}/recordings`,
    RIVET_RUNTIME_LIBRARIES_ROOT: `${root}/libraries`,
    RIVET_KEY: 'fixture-key',
    RIVET_SERVER_UI_AUTH_MODE: 'none',
    RIVET_REQUIRE_UI_GATE_KEY: 'false',
    RIVET_API_PROFILE: process.env.BENCH_API_PROFILE,
    RIVET_ASYNC_TEST_MAX_PENDING_WRITES: process.env.BENCH_PENDING_WRITES,
    RIVET_ASYNC_TEST_PHASE_DIAGNOSTICS: process.env.BENCH_PHASE_DIAGNOSTICS,
    RIVET_RECORDINGS_ENABLED: 'true',
    RIVET_RECORDING_DURABILITY_ENABLED: 'true',
    RIVET_MANAGED_MAINTENANCE_ENABLED: 'false',
    RIVET_ASYNC_TEST_ENDPOINT_NAME: 'recording-benchmark',
    RIVET_ASYNC_TEST_PROJECT_BYTES: '0',
    RIVET_ASYNC_TEST_BENCHMARK: 'true',
    RIVET_ASYNC_TEST_BENCHMARK_HELPER: '/app/benchmark-recording-memory.mjs',
    RIVET_PUBLISHED_EXECUTION_ADMISSION_MODE: 'enforce',
    RIVET_PUBLISHED_EXECUTION_MAX_ACTIVE_RUNS: process.env.BENCH_CONCURRENCY,
    RIVET_SHUTDOWN_GRACE_SECONDS: '10',
    ...(process.env.BENCH_WORKLOAD === 'nodes' ? { RIVET_ASYNC_TEST_BENCHMARK_NODES: '100' } : {}),
    ...(process.env.BENCH_WORKLOAD === 'chain' ? { RIVET_ASYNC_TEST_BENCHMARK_CHAIN: '100' } : {}),
    ...(['retained', 'aliases'].includes(process.env.BENCH_WORKLOAD)
      ? { RIVET_ASYNC_TEST_RECORDING_PAYLOAD: process.env.BENCH_WORKLOAD }
      : {}),
  });
  if (backend === 'managed') {
    const host = `${process.env.BENCH_PREFIX}-${process.env.BENCH_SIDE}`;
    const connectionString = `postgres://postgres@${host}-postgres:5432/recording_benchmark`;
    const endpoint = `http://${host}-minio:9000`;
    const { Pool } = require('pg');
    const { S3Client, CreateBucketCommand } = require('@aws-sdk/client-s3');
    const pool = new Pool({ connectionString, connectionTimeoutMillis: 1000 });
    const client = new S3Client({
      endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture-secret' },
    });
    try {
      let readinessError;
      await deadline(
        (async () => {
          for (;;) {
            try {
              await pool.query('SELECT 1');
              const result = await fetch(`${endpoint}/minio/health/ready`);
              if (result.ok) break;
            } catch (error) {
              readinessError = error;
            }
            await delay(100);
          }
        })(),
        30_000,
        'fixture storage readiness',
      ).catch((error) => {
        throw new Error(error.message, { cause: readinessError });
      });
      const { migrateManagedWorkflowSchema } = await import(
        '/app/packages/studio-server-api/dist/studio-server-api/src/routes/workflows/managed/schema-migrations.js'
      );
      await migrateManagedWorkflowSchema(pool);
      await client.send(new CreateBucketCommand({ Bucket: 'recordings' }));
      env.RIVET_ASYNC_TEST_STORAGE = JSON.stringify({
        version: 1,
        storageMode: 'managed',
        databaseMode: 'managed',
        databaseSslMode: 'disable',
        databaseConnectionString: connectionString,
        objectStorageBucket: 'recordings',
        objectStorageEndpoint: endpoint,
        objectStorageRegion: 'us-east-1',
        objectStoragePrefix: 'fixture/',
        objectStorageForcePathStyle: true,
        storageAccessKeyId: 'fixture',
        storageAccessKey: 'fixture-secret',
        storageUrl: `${endpoint}/recordings`,
      });
      if (process.env.BENCH_SETTINGS_BACKEND === 'postgres') {
        env.RIVET_APP_SETTINGS_BACKEND = 'postgres';
        env.RIVET_APP_SETTINGS_DATABASE_URL = connectionString;
        env.RIVET_DEPLOYMENT_DATABASE_SSL_MODE = 'disable';
      }
    } finally {
      await pool.end();
      client.destroy();
    }
  }
  // Fixture relative imports resolve against the tested build, not this driver.
  const { fork } = await import('node:child_process');
  // Copy the common fixture into an owned writable path and rewrite only its
  // relative import base. The actual runtime files remain read-only mounts.
  let source = await fs.readFile('/app/benchmark-fixture.mjs', 'utf8');
  const base = '/app/packages/studio-server-api/dist/studio-server-api/src/tests/helpers/';
  source = source.replace(
    /(from\s+|import\(\s*|new URL\(\s*)(['"])(\.[^'"]+)\2/g,
    (_match, before, quote, relative) => `${before}${quote}file://${path.resolve(base, relative)}${quote}`,
  );
  await fs.writeFile('/app/benchmark-fixture-rewritten.mjs', source);
  const execArgv = process.env.BENCH_CPU_PROFILE
    ? ['--cpu-prof', '--cpu-prof-dir=/profile', `--cpu-prof-name=${process.env.BENCH_SIDE}.cpuprofile`]
    : [];
  const child = fork('/app/benchmark-fixture-rewritten.mjs', [], { env, execArgv, silent: true });
  child.stdout.pipe(process.stderr);
  child.stderr.pipe(process.stderr);
  child.on('message', (message) => console.log('BENCH ' + JSON.stringify(message)));
  child.once('exit', (code) => {
    process.exitCode = code ?? 1;
    process.stdin.destroy();
  });
  createInterface({ input: process.stdin }).on('line', (line) => child.connected && child.send(JSON.parse(line)));
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
}

async function deadline(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
