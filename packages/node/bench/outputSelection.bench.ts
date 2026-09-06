import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createProcessor, type GraphProcessorRuntimeProfileBucket } from '../src/index.js';
import {
  makeDelayedUnusedOutputProject,
  makeSharedOutputProject,
  makeUnusedOutputProject,
} from '../test/outputSelectionFixtures.js';

// Timings describe this local fixture; executed-node counts are the deterministic acceptance gate.
const unusedBranchLength = 200;
const simulatedDelayMs = 40;
const warmups = 5;
const iterations = 25;
const attributionWarmups = 2;
const attributionIterations = 5;
const bookkeepingBuckets = [
  'preprocessGraph',
  'getInputNodesTo',
  'getInputValuesForNode',
  'getOutputNodesFrom',
  'queueOutputNodes',
] as const satisfies readonly GraphProcessorRuntimeProfileBucket[];
const rows = [];

for (const scenario of [
  { name: 'shared outputs, no eliminated work', create: makeSharedOutputProject },
  {
    name: '200 unused Text nodes',
    create: (enabled: boolean) => makeUnusedOutputProject(enabled, unusedBranchLength),
  },
  {
    name: 'simulated expensive unused branch',
    create: (enabled: boolean) => makeDelayedUnusedOutputProject(enabled, simulatedDelayMs),
  },
]) {
  const modes = [false, true].map((skipUnusedOutputs) => {
    const fixture = scenario.create(skipUnusedOutputs);
    const created = createProcessor(fixture.project, { graph: fixture.graphId });
    const mode = { created, fixture, skipUnusedOutputs, nodeStarts: 0, durations: [] as number[] };
    created.processor.on('nodeStart', () => mode.nodeStarts++);
    return mode;
  });
  try {
    for (let iteration = 0; iteration < warmups + iterations; iteration++) {
      const outputsByMode: unknown[] = [];
      // Interleave modes and reverse their order to reduce warmup and execution-order bias.
      for (const mode of iteration % 2 === 0 ? modes : [...modes].reverse()) {
        mode.nodeStarts = 0;
        const start = performance.now();
        const outputs = await mode.created.run();
        const elapsed = performance.now() - start;
        outputsByMode.push(outputs);
        assert.deepEqual(outputs.result, { type: 'string', value: 'shared wanted' });
        assert.equal(mode.nodeStarts, mode.fixture.expectedNodeStarts);
        if (iteration >= warmups) mode.durations.push(elapsed);
      }
      assert.deepEqual(outputsByMode[0], outputsByMode[1]);
    }
  } finally {
    modes.forEach((mode) => mode.created.dispose());
  }
  for (const mode of modes) {
    mode.durations.sort((a, b) => a - b);
    rows.push({
      scenario: scenario.name,
      skipUnusedOutputs: mode.skipUnusedOutputs,
      executedNodes: mode.fixture.expectedNodeStarts,
      medianMs: Number(mode.durations[Math.floor(mode.durations.length / 2)]!.toFixed(3)),
      p95Ms: Number(mode.durations[Math.ceil(mode.durations.length * 0.95) - 1]!.toFixed(3)),
      bookkeepingMedianMs: await measureBookkeeping(mode.fixture),
    });
  }
}

console.log(
  JSON.stringify(
    {
      unusedBranchLength,
      simulatedDelayMs,
      warmups,
      iterations,
      attributionWarmups,
      attributionIterations,
      timingNote:
        'Elapsed timings are unprofiled. Bookkeeping buckets come from a separate instrumented pass; they include profiler overhead, may overlap, and must not be summed as total scheduler overhead. Zero means a bucket was unused, not that total scheduling was free.',
      results: rows,
    },
    null,
    2,
  ),
);

async function measureBookkeeping(fixture: ReturnType<typeof makeUnusedOutputProject>) {
  const current = new Map<GraphProcessorRuntimeProfileBucket, number>();
  const samples = new Map(bookkeepingBuckets.map((bucket) => [bucket, [] as number[]]));
  const created = createProcessor(fixture.project, {
    graph: fixture.graphId,
    runtimeProfiler: {
      addDuration(bucket, durationMs) {
        current.set(bucket, (current.get(bucket) ?? 0) + durationMs);
      },
    },
  });
  let nodeStarts = 0;
  created.processor.on('nodeStart', () => nodeStarts++);
  try {
    for (let iteration = 0; iteration < attributionWarmups + attributionIterations; iteration++) {
      current.clear();
      nodeStarts = 0;
      const outputs = await created.run();
      assert.deepEqual(outputs.result, { type: 'string', value: 'shared wanted' });
      assert.equal(nodeStarts, fixture.expectedNodeStarts);
      if (iteration >= attributionWarmups) {
        for (const bucket of bookkeepingBuckets) samples.get(bucket)!.push(current.get(bucket) ?? 0);
      }
    }
  } finally {
    created.dispose();
  }
  return Object.fromEntries(
    [...samples].map(([bucket, values]) => {
      values.sort((a, b) => a - b);
      return [bucket, Number(values[Math.floor(values.length / 2)]!.toFixed(4))];
    }),
  );
}
