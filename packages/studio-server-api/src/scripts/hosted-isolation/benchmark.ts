import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { PrototypePool } from './pool.js';
import type { PrototypeDefinition, PrototypeRequest } from './protocol.js';
import { assemblePrototypeInput } from './request.js';
import { evaluateLatencyBudget, percentile } from './latency-budget.js';
import type { RivetStoredValue, RivetStoredValueStore } from '@valerypopoff/rivet2-node';

type Case = 'no-code' | 'trivial' | 'sequential' | 'large-input' | 'recording' | 'host-storage';
const CASES: Case[] = ['no-code', 'trivial', 'sequential', 'large-input', 'recording', 'host-storage'];
const summarize = (values: number[]) => ({ medianMs: percentile(values, 0.5), p95Ms: percentile(values, 0.95) });

/** The optional definition is used only by the local lifecycle regression. */
export async function serve(
  name: Case,
  wire: 'clone' | 'transfer',
  fixture?: { definition: PrototypeDefinition; context?: PrototypeRequest['context'] },
) {
  const [{ isolationFixture, IDENTITY_CODE, addIsolationStoredValue }, { PrototypePool }, { runPrototypeRoot }] =
    await Promise.all([import('./fixtures.js'), import('./pool.js'), import('./runtime.js')]);
  if (!process.connected) throw new Error('Benchmark server requires its controlling IPC connection.');
  const inputCode =
    name === 'large-input' ? 'return { result: { type: "number", value: inputs.input.value.length } };' : IDENTITY_CODE;
  const definition: PrototypeDefinition = fixture?.definition ?? {
    project: isolationFixture(name === 'no-code' ? undefined : inputCode, name === 'sequential' ? 16 : 1),
    // Fixture services never read or write these paths. No temporary installation
    // is needed, and a killed benchmark cannot leave one behind.
    projectPath: '/local-prototype/main.rivet-project',
    runtimeLibrariesRoot: '/local-prototype/no-libraries',
    executionEnvironment: {},
  };
  let storedValue: RivetStoredValue | undefined;
  const storedValueStore: RivetStoredValueStore | undefined =
    name === 'host-storage'
      ? {
          get: () => storedValue,
          set: (_key, value) => {
            storedValue = value;
          },
        }
      : undefined;
  if (storedValueStore) addIsolationStoredValue(definition.project, definition.project.metadata.mainGraphId!);
  const rssBeforeThreads = process.memoryUsage.rss();
  const startup = performance.now();
  const pool = new PrototypePool(definition, { size: 1, lifecycle: 'reuse', maxQueuedBytes: 64 * 1024 * 1024 });
  let retired: PrototypePool | undefined;
  let failure: string | undefined;
  const active = new Set<Promise<void>>();
  let stop!: () => void;
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
  });
  const send = (message: Record<string, unknown>) => {
    if (!process.connected) {
      stop();
      return;
    }
    process.send?.(message, (error) => {
      if (error) stop();
    });
  };
  const server = http.createServer((req, res) => {
    if (req.url === '/livez') {
      res.end('ok');
      return;
    }
    const task = (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const transfer = wire === 'transfer' && req.url !== '/direct';
      const input = assemblePrototypeInput(chunks, transfer);
      chunks.length = 0;
      const request: PrototypeRequest = {
        ...input.request,
        ...(fixture?.context ? { context: fixture.context } : {}),
        recording: name === 'recording',
      };
      const onEvent = (event: import('./protocol.js').PrototypeEvent) => {
        if (event.kind === 'foreground') {
          res.setHeader('content-type', 'application/json');
          res.end(event.json);
        }
      };
      const result =
        req.url === '/direct'
          ? await runPrototypeRoot(definition, request, new AbortController().signal, onEvent, storedValueStore)
          : await (
              req.url === '/retire'
                ? (retired ??= new PrototypePool(definition, {
                    size: 1,
                    lifecycle: 'retire',
                    maxQueuedBytes: 64 * 1024 * 1024,
                  }))
                : pool
            ).run(request, { onEvent, retainedBytes: input.retainedBytes, timeoutMs: 60_000, storedValueStore });
      assert.equal(result.status, 'succeeded', result.failure?.message ?? 'Benchmark graph failed.');
      assert.equal(result.failure, undefined, result.failure?.message);
      assert.equal(result.captureError, undefined, result.captureError?.message);
      if (request.recording) assert.ok(result.recording, 'Benchmark recording was not captured.');
      if (!res.writableEnded) {
        res.statusCode = 500;
        res.end(JSON.stringify(result.failure));
      }
    })().catch((error: unknown) => {
      failure ??= error instanceof Error ? error.message : String(error);
      if (!res.writableEnded) {
        res.statusCode = 500;
        res.end(String(error));
      }
    });
    active.add(task);
    void task.finally(() => active.delete(task));
  });
  let baseline = process.cpuUsage();
  const onMessage = (message: { kind: 'sample' | 'stop'; id: number }) => {
    if (message.kind === 'stop') {
      stop();
      return;
    }
    if (message.kind !== 'sample') return;
    void (async () => {
      // HTTP completion is the timed foreground. Accept a block only after the
      // actual roots and captures settle, and keep late failures out of reports.
      await Promise.all([...active]);
      const cpu = process.cpuUsage(baseline);
      baseline = process.cpuUsage();
      send({
        kind: 'sample',
        id: message.id,
        failure,
        cpuMs: (cpu.user + cpu.system) / 1000,
        rss: process.memoryUsage.rss(),
        pool: pool.stats,
        retiredPool: retired?.stats,
      });
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
      stop();
    });
  };
  process.on('message', onMessage);
  process.once('disconnect', stop);
  try {
    await pool.prepare();
    if (!process.connected) return;
    const warmupMs = performance.now() - startup;
    const rssWithWarmThread = process.memoryUsage.rss();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    send({ kind: 'ready', url: `http://127.0.0.1:${address.port}`, warmupMs, rssBeforeThreads, rssWithWarmThread });
    await stopped;
  } finally {
    process.off('message', onMessage);
    process.off('disconnect', stop);
    const transportClosed = server.listening
      ? new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
      : Promise.resolve();
    server.closeAllConnections();
    const drained = await Promise.allSettled([transportClosed, ...active]);
    const reaped = await Promise.allSettled([pool.close(), retired?.close()]);
    if (process.connected) process.disconnect();
    for (const result of [...drained, ...reaped]) if (result.status === 'rejected') throw result.reason;
  }
}

async function measureCase(
  name: Case,
  runs: number,
  blocks: number,
  retirement: boolean,
  inputBytes: number,
  wire: 'clone' | 'transfer',
  intervalMs: number,
) {
  const child = fork(fileURLToPath(import.meta.url), ['serve', name, wire], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr?.on('data', (bytes: Buffer) => {
    stderr = (stderr + bytes.toString()).slice(-4000);
  });
  let sequence = 0;
  const exchanges = new Map<number, (value: Record<string, unknown>) => void>();
  let exit!: (code: number | null, signal: NodeJS.Signals | null) => void;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    exit = (code, signal) => resolve({ code, signal });
  });
  // close also fires after a spawn error, when there may never be an exit event.
  child.once('close', exit);
  const startup = new Promise<{ url: string; warmupMs: number; rssBeforeThreads: number; rssWithWarmThread: number }>(
    (resolve, reject) => {
      child.on('message', (message: Record<string, unknown>) => {
        if (message.kind === 'ready') resolve(message as Awaited<typeof startup>);
        else if (message.kind === 'sample') {
          exchanges.get(Number(message.id))?.(message);
          exchanges.delete(Number(message.id));
        }
      });
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`Benchmark server exited ${code}: ${stderr}`)));
    },
  );
  const sample = () =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = ++sequence;
      const fail = () => {
        clearTimeout(timer);
        child.off('close', fail);
        exchanges.delete(id);
        reject(new Error(`Benchmark sample lost its server: ${stderr}`));
      };
      const timer = setTimeout(fail, 10_000);
      child.once('close', fail);
      exchanges.set(id, (value) => {
        clearTimeout(timer);
        child.off('close', fail);
        if (value.failure) reject(new Error(`Benchmark root did not complete successfully: ${String(value.failure)}`));
        else resolve(value);
      });
      child.send({ kind: 'sample', id });
    });
  let ready!: Awaited<typeof startup>;
  const startupTimer = setTimeout(() => child.kill(), 45_000);
  try {
    ready = await startup;
    clearTimeout(startupTimer);
    const body = JSON.stringify(name === 'large-input' ? 'x'.repeat(inputBytes) : 42);
    let expected: string | undefined;
    const block = async (mode: 'direct' | 'reuse' | 'retire', count: number) => {
      await sample();
      const values: number[] = [];
      let nextRequest = performance.now();
      for (let index = 0; index < count; index++) {
        const remaining = nextRequest - performance.now();
        if (remaining > 0) await delay(remaining);
        const start = performance.now();
        const response = await fetch(`${ready.url}/${mode}`, {
          method: 'POST',
          body,
          headers: { 'content-type': 'application/json' },
          signal: AbortSignal.timeout(65_000),
        });
        const json = await response.text();
        assert.equal(response.status, 200, json);
        expected ??= json;
        assert.equal(json, expected, 'Direct and worker responses must match.');
        values.push(performance.now() - start);
        // No catch-up burst after a slow response. Both paths receive the same
        // offered rate with at most one outstanding HTTP request.
        nextRequest = start + intervalMs;
      }
      return { ...summarize(values), samplesMs: values, resources: await sample() };
    };
    await block('direct', 10);
    await block('reuse', 10);
    const baseline = [];
    for (let index = 0; index < blocks; index++) baseline.push(await block('direct', runs));
    const paired = [];
    for (let index = 0; index < blocks; index++) {
      let direct, reuse;
      if (index % 2) {
        reuse = await block('reuse', runs);
        direct = await block('direct', runs);
      } else {
        direct = await block('direct', runs);
        reuse = await block('reuse', runs);
      }
      paired.push({ direct, reuse });
    }
    const deltas = paired.map((entry) => 100 * (entry.reuse.medianMs / entry.direct.medianMs - 1));
    const consistent = deltas.every((delta) => delta > 0);
    const retired = retirement ? await block('retire', 2) : undefined;
    const latencyBudget = evaluateLatencyBudget(
      paired.flatMap((entry) => entry.direct.samplesMs),
      paired.flatMap((entry) => entry.reuse.samplesMs),
      name === 'large-input' ? 5 : 1,
    );
    return {
      case: name,
      wire,
      requestBytes: Buffer.byteLength(body),
      intervalMs,
      loadProfile: intervalMs > 0 ? 'paced-serial' : 'saturation-diagnostic',
      latencyBudget,
      ready,
      baseline,
      paired,
      retired,
      pairedMedianDeltasPercent: deltas,
      baselineMedianRangeMs: [
        Math.min(...baseline.map((entry) => entry.medianMs)),
        Math.max(...baseline.map((entry) => entry.medianMs)),
      ],
      medianTrend: consistent ? 'isolated-higher-in-every-paired-block' : 'mixed',
      medianDirectMs: percentile(
        paired.map((entry) => entry.direct.medianMs),
        0.5,
      ),
      medianIsolatedMs: percentile(
        paired.map((entry) => entry.reuse.medianMs),
        0.5,
      ),
    };
  } finally {
    clearTimeout(startupTimer);
    if (child.connected) child.send({ kind: 'stop', id: 0 });
    const timer = setTimeout(() => child.kill(), 10_000);
    try {
      const result = await exited;
      assert.equal(result.code, 0, `Benchmark server failed cleanup (${result.signal ?? result.code}): ${stderr}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

async function main() {
  if (process.argv[2] === 'serve') {
    await serve(process.argv[3] as Case, process.argv[4] as 'clone' | 'transfer');
    return;
  }
  const flags = new Map(
    process.argv
      .slice(2)
      .filter((value) => value.startsWith('--'))
      .map((value): [string, string | undefined] => {
        const [key, option] = value.slice(2).split('=');
        return [key!, option];
      }),
  );
  const runs = Number(flags.get('runs') ?? 100),
    blocks = Number(flags.get('blocks') ?? 3);
  if (!Number.isInteger(runs) || runs < 10 || runs > 500 || !Number.isInteger(blocks) || blocks < 2 || blocks > 5)
    throw new Error('Use --runs=10..500 --blocks=2..5.');
  const inputBytes = Number(flags.get('input-bytes') ?? 1024 * 1024);
  if (!Number.isInteger(inputBytes) || inputBytes < 1 || inputBytes > 32 * 1024 * 1024)
    throw new Error('Use --input-bytes=1..33554432.');
  const wire = flags.get('wire') ?? 'clone';
  if (wire !== 'clone' && wire !== 'transfer') throw new Error('Use --wire=clone|transfer.');
  const selected = flags.get('case') ? [flags.get('case') as Case] : CASES;
  if (selected.some((name) => !CASES.includes(name))) throw new Error('Unknown benchmark case.');
  const output = path.resolve(
    flags.get('output') ??
      path.join(process.env.PROJECT_CWD ?? process.cwd(), 'artifacts/benchmarks/hosted-isolation-gate-a.json'),
  );
  const compiledHash = createHash('sha256');
  for (const filename of [
    'benchmark.js',
    'fixtures.js',
    'latency-budget.js',
    'pool.js',
    'protocol.js',
    'request.js',
    'runtime.js',
    'stored-values.js',
    'worker.js',
  ])
    compiledHash.update(filename).update(await fs.readFile(new URL(filename, import.meta.url)));
  const report: {
    runtime: string;
    platform: string;
    scope: string;
    compiledSha256: string;
    runs: number;
    blocks: number;
    requestedCases: Case[];
    complete: boolean;
    cases: Awaited<ReturnType<typeof measureCase>>[];
  } = {
    runtime: process.version,
    platform: `${process.platform}/${process.arch}`,
    compiledSha256: compiledHash.digest('hex'),
    runs,
    blocks,
    requestedCases: selected,
    complete: false,
    scope:
      'Local generated fixtures; separate HTTP client/server processes, fixed snapshot services. Not production adapter/capacity or packaged-image acceptance.',
    cases: [],
  };
  await fs.mkdir(path.dirname(output), { recursive: true });
  for (const name of selected) {
    const intervalMs = Number(flags.get('interval-ms') ?? (name === 'large-input' ? 100 : 10));
    if (!Number.isFinite(intervalMs) || intervalMs < 0 || intervalMs > 1000)
      throw new Error('Use --interval-ms=0..1000. Zero is a saturation diagnostic.');
    const entry = await measureCase(name, runs, blocks, flags.has('retire'), inputBytes, wire, intervalMs);
    report.cases.push(entry);
    report.complete = report.cases.length === selected.length;
    const pending = `${output}.${process.pid}.tmp`;
    try {
      await fs.writeFile(pending, JSON.stringify(report, null, 2) + '\n');
      await fs.rename(pending, output);
    } finally {
      await fs.rm(pending, { force: true });
    }
    console.log(
      JSON.stringify({
        case: name,
        directMedianMs: entry.medianDirectMs,
        isolatedMedianMs: entry.medianIsolatedMs,
        medianTrend: entry.medianTrend,
        latencyBudget: entry.latencyBudget,
      }),
    );
  }
  console.log(`Saved ${output}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
