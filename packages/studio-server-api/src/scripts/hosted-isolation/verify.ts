import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { GraphId, PortId, Project } from '@valerypopoff/rivet2-node';
import type { PrototypeDefinition, PrototypeEvent, PrototypeRequest, PrototypeResult } from './protocol.js';
import { assemblePrototypeInput } from './request.js';

const SHARED = 'shared' as GraphId,
  ACTION = 'action' as GraphId;
const SYNC = 'sync-loop' as GraphId,
  ASYNC = 'async-loop' as GraphId,
  TAIL = 'tail' as GraphId,
  FAMILY = 'code-family' as GraphId;

async function fixtures(): Promise<PrototypeDefinition> {
  const [
    { SetStoredValueNodeImpl, CodeNewNodeImpl, ExpressionNodeImpl, JSMapNodeImpl, JSFilterNodeImpl },
    { isolationFixture, IDENTITY_CODE, addIsolationTail },
  ] = await Promise.all([import('@valerypopoff/rivet2-node'), import('./fixtures.js')]);
  const sharedCode = `
    const value = inputs.input.value;
    if (value && value.fromFirst) {
      return { result: { type: 'any', value: {
        answer: value.fn(), label: value.item.label(), binary: [...value.bytes],
        count: context.count.value, rivet: typeof Rivet.createProcessor,
        env: process.env.ISOLATION_FIXTURE_ENV,
      } } };
    }
    context.count.value++;
    class Item { label() { return 'class method preserved'; } }
    return { result: { type: 'any', value: {
      fromFirst: true, fn: () => 42, item: new Item(), bytes: new Uint8Array([1,2,3])
    } } };`;
  const projects: Project[] = [
    isolationFixture(sharedCode, 2, SHARED),
    isolationFixture(IDENTITY_CODE, 1, ACTION),
    ...[SYNC, ASYNC].map((graph) =>
      isolationFixture(
        `
      ${graph === ASYNC ? 'await Promise.resolve();' : ''}
      if (inputs.input.value && inputs.input.value.loop) {
        Atomics.store(new Int32Array(inputs.input.value.entered), 0, 1);
        while (true) {}
      }
      return { result: { type: 'any', value: inputs.input.value } };`,
        1,
        graph,
      ),
    ),
    isolationFixture('return { result: { type: "any", value: inputs.input.value.unencodable ? 1n : 42 } };', 1, TAIL),
    isolationFixture(IDENTITY_CODE, 1, FAMILY),
  ];
  addIsolationTail(
    projects.find((project) => project.graphs[TAIL])!,
    TAIL,
    `
    const marker = new Int32Array(context.marker.value);
    Atomics.store(marker, 0, 1);
    while (!Atomics.load(marker, 1)) await new Promise(resolve => setTimeout(resolve, 5));
    Atomics.store(marker, 2, 1);
    if (inputs.input.value.failTail) throw new Error('Fixture tail failed.');
    return { result: { type: 'any', value: true } };`,
  );
  const family = projects.at(-1)!.graphs[FAMILY]!;
  const code = CodeNewNodeImpl.create();
  code.data.code = 'return [{{value}}, {{value}} + 1];';
  const map = JSMapNodeImpl.create();
  map.data.callbackBody = 'return item * 2;';
  const filter = JSFilterNodeImpl.create();
  filter.data.callbackBody = 'return item >= 86;';
  const expression = ExpressionNodeImpl.create();
  expression.data.expression =
    'typeof Rivet.createProcessor === "function" && require("node:path").basename("/a/b") === "b" ? {{value}}[0] + 1 : -1';
  const familyOutput = family.nodes.find((node) => node.type === 'graphOutput')!;
  family.connections.find((connection) => connection.inputNodeId === familyOutput.id)!.inputNodeId = code.id;
  family.nodes.push(code, map, filter, expression);
  family.connections.push(
    { outputNodeId: code.id, outputId: 'output' as PortId, inputNodeId: map.id, inputId: 'array' as PortId },
    { outputNodeId: map.id, outputId: 'mapped' as PortId, inputNodeId: filter.id, inputId: 'array' as PortId },
    { outputNodeId: filter.id, outputId: 'filtered' as PortId, inputNodeId: expression.id, inputId: 'value' as PortId },
    {
      outputNodeId: expression.id,
      outputId: 'output' as PortId,
      inputNodeId: familyOutput.id,
      inputId: 'value' as PortId,
    },
  );
  const actionGraph = projects[1]!.graphs[ACTION]!;
  const output = actionGraph.nodes.find((node) => node.type === 'graphOutput')!;
  const store = SetStoredValueNodeImpl.create();
  store.data.key = 'fixture';
  store.data.dataType = 'any';
  actionGraph.connections.find((connection) => connection.inputNodeId === output.id)!.inputNodeId = store.id;
  actionGraph.nodes.push(store);
  actionGraph.connections.push({
    outputNodeId: store.id,
    outputId: 'saved-value' as PortId,
    inputNodeId: output.id,
    inputId: 'value' as PortId,
  });
  return {
    project: {
      metadata: projects[0]!.metadata,
      graphs: Object.assign({}, ...projects.map((project) => project.graphs)),
      uiGraphs: Object.assign({}, ...projects.map((project) => project.uiGraphs)),
    },
    projectPath: '/local-prototype/main.rivet-project',
    runtimeLibrariesRoot: '/local-prototype/no-libraries',
    executionEnvironment: { ISOLATION_FIXTURE_ENV: 'scoped' },
  };
}

async function waitFor(condition: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, description);
    await delay(10);
  }
}

async function verifyBenchmarkLifecycle(): Promise<void> {
  const child = fork(fileURLToPath(import.meta.url), ['benchmark-fixture'], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  // Parent disconnect can suppress close in Node 22/24 (nodejs/node#65646).
  // This test inherits stderr; it needs physical exit, not a child pipe drain.
  const exited = once(child, 'exit');
  void exited.catch(() => undefined);
  const timer = setTimeout(() => child.kill('SIGKILL'), 45_000);
  const nextMessage = async () => {
    const [message] = await Promise.race([
      once(child, 'message'),
      exited.then(() => {
        throw new Error('Benchmark fixture exited before its reply.');
      }),
    ]);
    return message as { kind: string; url: string; failure?: string; pool: { active: number } };
  };
  let termination: unknown[] = [];
  try {
    const ready = await nextMessage();
    assert.equal(ready.kind, 'ready');
    const response = await fetch(`${ready.url}/reuse`, {
      method: 'POST',
      body: '42',
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '42');
    const held = nextMessage();
    child.send({ kind: 'sample', id: 1 });
    assert.equal((await held).kind, 'sample-requested', 'Sampling must start while the real tail is held.');
    const sample = nextMessage();
    child.send({ kind: 'release-tail' });
    const result = await sample;
    assert.equal(result.kind, 'sample');
    assert.ok(
      typeof result.failure === 'string' && result.failure.length > 0,
      'An early HTTP success cannot hide a failed tail.',
    );
    assert.equal(result.pool.active, 0, 'Sampling must wait for physical root settlement.');
  } finally {
    clearTimeout(timer);
    const cleanup = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      if (child.connected) child.disconnect();
      termination = await exited;
    } finally {
      clearTimeout(cleanup);
    }
  }
  assert.equal(termination[1], null, 'A disconnected benchmark must clean up without a forced kill.');
  assert.equal(termination[0], 0);
}

async function verify() {
  const startedAt = performance.now();
  const [{ PrototypePool, PrototypeCapacityError }, { runPrototypeRoot }, { getManagedPostgresPoolMetrics }] =
    await Promise.all([import('./pool.js'), import('./runtime.js'), import('../../managed-postgres-pool.js')]);
  const checks: string[] = [];
  const timings: { check: string; durationMs: number }[] = [];
  let previous = startedAt;
  const passed = (description: string) => {
    const now = performance.now();
    const durationMs = now - previous;
    previous = now;
    timings.push({ check: description, durationMs });
    checks.push(description);
    console.log(`Passed: ${description} (${Math.round(durationMs)} ms)`);
  };
  const definition = await fixtures();
  // One shared immutable project/pool avoids paying cold module imports for every assertion.
  const options = { size: 2, lifecycle: 'reuse' as const, maxQueued: 1, maxQueuedBytes: 2 * 1024 * 1024 };
  const pool = new PrototypePool(definition, options);
  // The caller cannot silently change admission or replacement behavior later.
  options.size = 8;
  options.maxQueuedBytes = 1;
  try {
    await pool.prepare();
    for (const timeoutMs of [0, -1, NaN, Infinity, 1.5, 2_147_483_648])
      await assert.rejects(pool.run({}, { timeoutMs }), /root deadline/);
    for (const retainedBytes of [-1, NaN, Infinity, 0.5])
      await assert.rejects(pool.run({}, { retainedBytes }), /retained-byte/);
    await assert.rejects(pool.run({ inputs: { input: { type: 'any', value: () => 42 } } }));
    assert.equal(pool.stats.queued, 0);
    assert.equal(pool.stats.workers, 2);
    assert.equal(pool.stats.created, 2, 'Invalid admission must not consume or replace a worker.');
    passed('warm pool, rejected deadlines/payloads and fixed caller-independent capacity');
    const request = (): PrototypeRequest => ({
      graph: SHARED,
      inputs: { input: { type: 'any', value: 1 } },
      context: { count: { type: 'number', value: 0 } },
    });
    let directJson: string | undefined, isolatedJson: string | undefined;
    const direct = await runPrototypeRoot(definition, request(), new AbortController().signal, (event) => {
      if (event.kind === 'foreground') directJson = event.json;
    });
    const isolated = await pool.run(request(), {
      onEvent: (event) => {
        if (event.kind === 'foreground') isolatedJson = event.json;
      },
    });
    assert.equal(direct.status, 'succeeded');
    assert.equal(isolated.status, 'succeeded');
    assert.equal(isolatedJson, directJson);
    assert.deepEqual(JSON.parse(isolatedJson!), {
      answer: 42,
      label: 'class method preserved',
      binary: [1, 2, 3],
      count: 1,
      rivet: 'function',
      env: 'scoped',
    });
    let fresh: string | undefined;
    await pool.run(
      { ...request(), executionEnvironment: { ISOLATION_FIXTURE_ENV: 'new snapshot' } },
      {
        onEvent: (event) => {
          if (event.kind === 'foreground') fresh = event.json;
        },
      },
    );
    assert.equal(JSON.parse(fresh!).env, 'new snapshot');
    const delivery = await pool.run(request(), {
      onEvent: () => {
        throw new Error('receiver disconnected');
      },
    });
    assert.equal(delivery.status, 'succeeded');
    assert.equal(delivery.failure?.message, 'receiver disconnected');
    passed('whole-root function/class/mutation/binary parity, fresh environment and failed delivery');

    for (const mode of ['direct', 'worker'] as const) {
      const request: PrototypeRequest = {
        graph: FAMILY,
        inputs: { input: { type: 'any', value: 42 } },
        recording: true,
      };
      let answer: string | undefined;
      const observe = (event: PrototypeEvent) => {
        if (event.kind === 'foreground') answer = event.json;
      };
      const result =
        mode === 'direct'
          ? await runPrototypeRoot(definition, request, new AbortController().signal, observe)
          : await pool.run(request, { onEvent: observe });
      assert.equal(result.status, 'succeeded', result.failure?.message);
      assert.equal(answer, '87');
      assert.ok(result.recording);
      assert.equal(result.captureError, undefined);
    }
    passed('legacy/new Code, Expression and JS map/filter share the real runner, builtin require and capture');

    const bytes = Buffer.from('42');
    const input = assemblePrototypeInput([bytes], true);
    const owned = input.request.inputJson!;
    let transferJson: string | undefined;
    const transferred = await pool.run(
      { graph: SYNC, inputJson: owned },
      {
        retainedBytes: bytes.length,
        onEvent: (event) => {
          if (event.kind === 'foreground') transferJson = event.json;
        },
      },
    );
    assert.equal(transferred.status, 'succeeded');
    assert.equal(transferJson, '42');
    assert.equal(owned.byteLength, 0);
    assert.equal(bytes.toString(), '42');
    passed('exclusive raw-input transfer preserves original caller data');

    const tailUi = Object.values(definition.project.uiGraphs!).find((ui) =>
      ui.components.some((component) => component.type === 'button' && component.action.graphId === TAIL),
    )!;
    for (const mode of ['direct', 'worker'] as const) {
      for (const fault of ['encoding', 'delivery', 'tail'] as const) {
        const marker = new Int32Array(new SharedArrayBuffer(12));
        const request: PrototypeRequest = {
          recording: true,
          context: { marker: { type: 'any', value: marker.buffer } },
          action: {
            uiGraph: tailUi,
            componentId: 'run',
            state: { input: { unencodable: fault === 'encoding', failTail: fault === 'tail' } },
          },
        };
        const observe = (event: PrototypeEvent) => {
          if (fault === 'delivery' && event.kind === 'foreground') throw new Error('Fixture delivery failed.');
        };
        const pending = (
          mode === 'direct'
            ? runPrototypeRoot(definition, request, new AbortController().signal, observe)
            : pool.run(request, { retainedBytes: 1024, onEvent: observe })
        ).then((result) => {
          assert.equal(Atomics.load(marker, 2), 1, `${mode}/${fault} resolved before physical tail completion.`);
          return result;
        });
        void pending.catch(() => undefined);
        try {
          await waitFor(() => Atomics.load(marker, 0) === 1, 'The actual background branch entered.');
        } finally {
          Atomics.store(marker, 1, 1);
        }
        const result = await pending;
        assert.equal(Atomics.load(marker, 2), 1);
        assert.equal(result.status, fault === 'tail' ? 'failed' : 'succeeded');
        assert.ok(result.failure?.message);
        if (fault === 'encoding') assert.equal(result.failure.name, 'TypeError');
        if (fault === 'delivery') assert.equal(result.failure.message, 'Fixture delivery failed.');
        if (fault !== 'encoding') assert.ok(result.recording);
      }
    }
    passed('direct/isolated actions retain active tails through encoding, delivery and background errors');

    const events: PrototypeEvent[] = [];
    const actionResult = await pool.run(
      {
        recording: true,
        action: {
          uiGraph: Object.values(definition.project.uiGraphs!).find((ui) =>
            ui.components.some((component) => component.type === 'button' && component.action.graphId === ACTION),
          )!,
          componentId: 'run',
          state: { input: 42 },
          storage: { existing: true },
        },
      },
      {
        onEvent: (event) => {
          events.push(event);
        },
      },
    );
    assert.equal(actionResult.status, 'succeeded', actionResult.failure?.message);
    assert.ok(actionResult.recording);
    assert.equal(actionResult.captureError, undefined);
    assert.equal(events[0]?.kind, 'prepared');
    const foregrounds = events.filter((event) => event.kind === 'foreground');
    assert.equal(foregrounds.length, 1);
    const action = JSON.parse(foregrounds[0]!.json!) as {
      statePatch: Record<string, unknown>;
      storagePatch: Record<string, unknown>;
    };
    assert.equal(action.statePatch.result, 42);
    assert.equal(action.storagePatch.fixture, 42);
    passed('real prepared action, browser storage/state and recording');

    // Keep actual roots occupied until this test releases them. CPU speed or
    // a slow assertion cannot accidentally empty the queue fixture.
    const markers = Array.from({ length: 3 }, () => new Int32Array(new SharedArrayBuffer(12)));
    const heldRequest = (marker: Int32Array): PrototypeRequest => ({
      graph: TAIL,
      inputs: { input: { type: 'any', value: {} } },
      context: { marker: { type: 'any', value: marker.buffer } },
    });
    const active = markers.slice(0, 2).map((marker) => pool.run(heldRequest(marker), { retainedBytes: 1024 }));
    void Promise.allSettled(active);
    let invoked = 0;
    try {
      await waitFor(
        () => markers.slice(0, 2).every((marker) => Atomics.load(marker, 0) === 1),
        'Both queue-fixture roots entered their held background branches.',
      );
      const abort = new AbortController();
      const queued = pool.run(heldRequest(markers[2]!), {
        signal: abort.signal,
        retainedBytes: 1024,
        onEvent: (event) => {
          if (event.kind === 'started') invoked++;
        },
      });
      const rejected = assert.rejects(queued, { name: 'AbortError' });
      await assert.rejects(pool.run({ graph: ASYNC }, { timeoutMs: 1000 }), PrototypeCapacityError);
      abort.abort();
      await rejected;
      assert.equal(pool.stats.queued, 0);
      assert.equal(pool.stats.queuedBytes, 0);
    } finally {
      for (const marker of markers) Atomics.store(marker, 1, 1);
      for (const result of await Promise.all(active)) assert.equal(result.status, 'succeeded');
    }
    assert.equal(invoked, 0, 'Cancelled queued work must never be invoked.');
    assert.equal(Atomics.load(markers[2]!, 0), 0);
    assert.equal(pool.stats.active, 0);
    await assert.rejects(pool.run({}, { retainedBytes: 2 * 1024 * 1024 + 1, timeoutMs: 1000 }), PrototypeCapacityError);
    passed('bounded queue/bytes and cancellation before invocation with explicitly held roots');

    definition.executionEnvironment.ISOLATION_FIXTURE_ENV = 'caller mutation';
    for (const graph of [SYNC, ASYNC]) {
      const abort = new AbortController();
      const entered = new Int32Array(new SharedArrayBuffer(4));
      const hung = pool.run(
        { graph, inputs: { input: { type: 'any', value: { loop: true, entered: entered.buffer } } } },
        {
          signal: abort.signal,
          retainedBytes: 128,
        },
      );
      const rejected = assert.rejects(hung, { name: 'AbortError' });
      void rejected.catch(() => undefined);
      await waitFor(() => Atomics.load(entered, 0) === 1, 'The actual infinite loop was entered.');
      let answer: string | undefined;
      const other = await pool.run(
        { graph: ASYNC, inputs: { input: { type: 'any', value: 42 } }, recording: true },
        {
          onEvent: (event) => {
            if (event.kind === 'foreground') answer = event.json;
          },
        },
      );
      assert.equal(other.status, 'succeeded');
      assert.equal(answer, '42');
      assert.ok(other.recording);
      abort.abort();
      await rejected;
      assert.ok(pool.stats.workers <= 2);
      if (graph === ASYNC) {
        // The first cancellation already verifies replenishment. On the last
        // one, shutdown proves physical reclamation without another cold import.
        await pool.close();
        assert.equal(pool.stats.workers, 0);
        passed(`${graph}: actual loop entry, independent root progress and confirmed shutdown`);
        continue;
      }
      await pool.prepare(); // Confirm physical exit and warm replacement before the next fault.
      assert.equal(pool.stats.retiring, 0);
      assert.equal(pool.stats.workers, 2);
      await Promise.all(
        Array.from({ length: 2 }, async () => {
          let environment: string | undefined;
          await pool.run(request(), {
            onEvent: (event) => {
              if (event.kind === 'foreground') environment = JSON.parse(event.json!).env as string;
            },
          });
          assert.equal(environment, 'scoped', 'Replacements retain the original fixture snapshot.');
        }),
      );
      passed(`${graph}: actual loop entry, independent root progress, forced cancel and physical reclamation`);
    }

    assert.deepEqual(getManagedPostgresPoolMetrics(), { idle: 0, pools: 0, total: 0, waiting: 0 });
  } finally {
    await pool.close();
  }
  assert.equal(pool.stats.workers, 0);
  await verifyBenchmarkLifecycle();
  passed('benchmark detects post-response graph failure, waits for settlement and reaps after coordinator loss');
  console.log(
    JSON.stringify(
      {
        checks,
        timings,
        durationMs: performance.now() - startedAt,
        scope: 'Gate A only: no serving routes, live adapters or production socket protocol changed.',
      },
      null,
      2,
    ),
  );
}

async function main() {
  if (process.argv[2] === 'benchmark-fixture') {
    const [{ serve }, { isolationFixture, IDENTITY_CODE, addIsolationTail }] = await Promise.all([
      import('./benchmark.js'),
      import('./fixtures.js'),
    ]);
    const project = isolationFixture(IDENTITY_CODE);
    const marker = new Int32Array(new SharedArrayBuffer(8));
    addIsolationTail(
      project,
      project.metadata.mainGraphId!,
      `
      const marker = new Int32Array(context.marker.value);
      Atomics.store(marker, 0, 1);
      while (!Atomics.load(marker, 1)) await new Promise(resolve => setTimeout(resolve, 5));
      throw new Error('Benchmark fixture tail failed.');`,
    );
    const release = () => {
      Atomics.store(marker, 1, 1);
    };
    const control = (message: { kind: string }) => {
      if (message.kind === 'release-tail') release();
      if (message.kind === 'sample') {
        void waitFor(() => Atomics.load(marker, 0) === 1, 'Benchmark tail entered before sampling.').then(
          () => {
            if (process.connected) process.send?.({ kind: 'sample-requested' });
          },
          (error) => {
            console.error(error);
            process.exitCode = 1;
            release();
          },
        );
      }
    };
    process.on('message', control);
    process.once('disconnect', release);
    try {
      await serve('recording', 'transfer', {
        definition: {
          project,
          projectPath: '/local-prototype/main.rivet-project',
          runtimeLibrariesRoot: '/local-prototype/no-libraries',
          executionEnvironment: {},
        },
        context: { marker: { type: 'any', value: marker.buffer } },
      });
    } finally {
      process.off('message', control);
      process.off('disconnect', release);
    }
    return;
  }
  if (process.argv[2] === 'benchmark-check') {
    await verifyBenchmarkLifecycle();
    console.log('Passed: benchmark lifecycle regression.');
    return;
  }
  if (process.argv[2] === 'child') {
    await verify();
    return;
  }
  const child = fork(fileURLToPath(import.meta.url), ['child'], { stdio: 'inherit' });
  // Initial warmup + one replacement + the separate benchmark fixture each
  // need startup allowance. This independent bound can kill every loop thread.
  const timer = setTimeout(() => child.kill(), 150_000);
  try {
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, 'Prototype verification failed or exceeded its independent deadline.');
  } finally {
    clearTimeout(timer);
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
