import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { loadProjectAndAttachedDataFromString, serializeProject, TextNodeImpl } from '@valerypopoff/rivet2-node';
import { LocalWorkflowCatalog } from '../local-metadata/workflow-catalog.js';
import { createCatalogWorker } from '../local-metadata/catalog-worker-client.js';
import { ParsedExecutionCache } from '../routes/workflows/parsed-execution-cache.js';
import { createBlankProjectFile } from '../routes/workflows/fs-helpers.js';

// A fixed, disposable component comparison, never a deployment benchmark.
// Deliberately accepts no storage paths, project files, credentials or URLs.
const args = process.argv.slice(2);
if (args.length > 1 || (args[0] && !/^\d+$/.test(args[0])))
  throw new Error('Usage: benchmark-serving-refactors [5..500 iterations]');
const iterations = args[0] ? Number(args[0]) : 40;
if (iterations < 5 || iterations > 500) throw new Error('Iterations must be between 5 and 500.');

async function measure(label: string, operation: () => unknown | Promise<unknown>) {
  for (let warmup = 0; warmup < 3; warmup++) await operation();
  const delay = monitorEventLoopDelay({ resolution: 1 });
  delay.enable();
  await yieldTurn();
  const durations: number[] = [];
  let rssPeakBytes = process.memoryUsage().rss;
  const cpu = process.cpuUsage();
  try {
    for (let sample = 0; sample < iterations; sample++) {
      const started = performance.now();
      await operation();
      durations.push(performance.now() - started);
      rssPeakBytes = Math.max(rssPeakBytes, process.memoryUsage().rss);
      await yieldTurn();
    }
  } finally {
    delay.disable();
  }
  const used = process.cpuUsage(cpu);
  durations.sort((a, b) => a - b);
  const percentile = (fraction: number) => durations[Math.ceil(durations.length * fraction) - 1]!;
  return {
    label,
    iterations,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: durations.at(-1),
    cpuMs: (used.user + used.system) / 1000,
    rssPeakBytes,
    eventLoopDelayMaxMs: delay.max / 1e6,
  };
}

const [project] = loadProjectAndAttachedDataFromString(createBlankProjectFile('Serving comparison'));
const graphId = 'fixed-fixture' as NonNullable<typeof project.metadata.mainGraphId>;
project.metadata.mainGraphId = graphId;
project.graphs[graphId] = {
  metadata: { id: graphId, name: 'Fixture' },
  nodes: Array.from({ length: 400 }, (_, index) => {
    const node = TextNodeImpl.create();
    node.id = `fixture-${index}` as typeof node.id;
    node.data.text = `Fixed node ${index}: ${'fixture payload '.repeat(40)}`;
    return node;
  }),
  connections: [],
};
const contents = serializeProject(project, { fixture: Array.from({ length: 100 }, (_, index) => index) }) as string;
const source = { revisionId: 'fixed-fixture-revision', contents, datasetsContents: null };
const cache = new ParsedExecutionCache();
const parseFresh = () => {
  const [project, attachedData] = loadProjectAndAttachedDataFromString(contents);
  return { project, attachedData, datasets: [] };
};
assert.deepEqual(cache.materialize(source), parseFresh(), 'cache and baseline must return the exact same definition');
const materialization = [
  await measure('fresh parse baseline', parseFresh),
  await measure('warm parsed definition, detached consumer', () => cache.materialize(source)),
  await measure('cold parse, admission accounting and detached consumer', () => {
    cache.clear();
    return cache.materialize(source);
  }),
  await measure('oversized fresh definition, no retained copy', () => {
    const oversized = new ParsedExecutionCache({ maxEntryBytes: 1 });
    const actual = oversized.materialize(source);
    assert.equal(oversized.getStats().entries, 0);
    return actual;
  }),
];

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-serving-comparison-'));
const options = { databasePath: path.join(root, 'catalog.sqlite'), artifactRoot: path.join(root, 'objects') };
const direct = new LocalWorkflowCatalog(options);
let worker: ReturnType<typeof createCatalogWorker> | undefined;
try {
  direct.initialize();
  for (let index = 0; index < 500; index++) direct.importFolder(`folder-${index.toString().padStart(3, '0')}`);
  const expected = direct.readStructure();
  const directResult = await measure('direct compact catalog baseline', () => direct.readStructure());
  worker = createCatalogWorker(options);
  const started = performance.now();
  await worker.initialize({ requireExisting: true });
  const workerStartupMs = performance.now() - started;
  assert.deepEqual(await worker.readStructure(), expected, 'worker and baseline must return the exact same catalog');
  const workerResult = await measure('worker compact catalog, including RPC', () => worker!.readStructure());
  console.log(
    JSON.stringify(
      {
        scope: 'synthetic component comparison; not production latency or whole-request throughput',
        memoryScope: 'sampled process RSS; phases share one process, includes worker threads and preceding phases',
        nodeVersion: process.version,
        platform: process.platform,
        projectBytes: Buffer.byteLength(contents),
        nodeCount: 400,
        folderCount: 500,
        workerStartupMs,
        materialization,
        catalog: [directResult, workerResult],
      },
      null,
      2,
    ),
  );
} finally {
  try {
    await worker?.close();
  } finally {
    direct.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}
