import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

// Compare the protected fixtures against the pre-refactor committed processor
// without replacing workspace files or altering public package exports.
const root = fileURLToPath(new URL('../../', import.meta.url));
const outputDir = path.join(root, 'artifacts/bench/execution-ownership');
await mkdir(outputDir, { recursive: true });
const sourcePath = 'packages/core/src/model/GraphProcessor.ts';
const baseline = execFileSync('git', ['show', `HEAD:${sourcePath}`], { cwd: root, encoding: 'utf8' });
const entry = `
import { performance } from 'node:perf_hooks';
import { createRuntimeSpeedProcessor, createRuntimeSpeedProcessContext, makeTextChainProject, makeNestedSubgraphProject, makeRepeatedSubgraphFanInProject } from './packages/node/test/runtimeSpeedFixtures.ts';
import { captureEditorRun } from './packages/app/src/hooks/preparedEditorRun.ts';
import { withDerivedProjectPluginSpecs } from './packages/app/src/utils/pluginUsage.ts';
async function main() {
const rows = [];
for (const size of [100, 1000]) {
  const fixture = makeTextChainProject(size);
  const graph = fixture.project.graphs[fixture.graphId];
  const plugins = { appPluginStates: [], currentGraph: graph, registry: { getPluginFor: () => undefined } };
  const capture = () => BENCHMARK_VARIANT === 'baseline'
    ? { project: withDerivedProjectPluginSpecs({ ...fixture.project, graphs: { ...fixture.project.graphs, [fixture.graphId]: graph } }, plugins) }
    : captureEditorRun({ project: fixture.project, currentGraph: graph, projectData: undefined, plugins, options: {} });
  for (let i = 0; i < 10; i++) capture();
  global.gc?.();
  const before = process.memoryUsage().heapUsed;
  const samples = [];
  let captured;
  for (let i = 0; i < 60; i++) { const start = performance.now(); captured = capture(); samples.push(performance.now() - start); }
  global.gc?.();
  samples.sort((a,b) => a-b);
  rows.push({ name: 'prepare-' + size, scheduler: 'editor-capture', outputs: captured.project, events: [], medianMs: samples[30], p95Ms: samples[56], retainedHeapBytes: process.memoryUsage().heapUsed - before, samples });
}
for (const scheduler of ['compatible', 'fast-acyclic']) {
  for (const [name, fixture] of [['text-100', makeTextChainProject(100)], ['nested-8', makeNestedSubgraphProject(8)], ['fan-in-12', makeRepeatedSubgraphFanInProject(12)]]) {
    const processor = createRuntimeSpeedProcessor(fixture.project, fixture.graphId, { scheduler });
    const context = createRuntimeSpeedProcessContext();
    let events = [];
    const unsubscribe = processor.onAny((name, data) => events.push([name, data?.node?.id, data?.graph?.metadata?.id]));
    const execute = () => processor.processGraph(context, { input: { type: 'string', value: 'fixture' } });
    for (let i = 0; i < 10; i++) await execute();
    global.gc?.();
    const before = process.memoryUsage().heapUsed;
    const samples = [];
    let outputs;
    for (let i = 0; i < 60; i++) { events = []; const start = performance.now(); outputs = await execute(); await processor.waitForRunCompletion(); samples.push(performance.now() - start); }
    global.gc?.();
    const retainedHeapBytes = process.memoryUsage().heapUsed - before;
    unsubscribe();
    samples.sort((a,b) => a-b);
    rows.push({name, scheduler, outputs, events, medianMs: samples[30], p95Ms: samples[56], retainedHeapBytes, samples});
  }
}
console.log(JSON.stringify(rows));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
`;
const reports = {};
for (const variant of ['baseline', 'current']) {
  const outfile = path.join(outputDir, `${variant}.cjs`);
  await build({
    absWorkingDir: root,
    stdin: { contents: entry, resolveDir: root, sourcefile: 'execution-ownership.ts', loader: 'ts' },
    outfile,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'cjs',
    define: { 'import.meta.url': '__filename', BENCHMARK_VARIANT: JSON.stringify(variant) },
    plugins: [
      {
        name: 'processor-source',
        setup(builder) {
          builder.onResolve({ filter: /^@valerypopoff\/rivet2-core$/ }, () => ({
            path: path.join(root, 'packages/core/src/index.ts'),
          }));
          // External imports keep their originating workspace's PnP identity;
          // resolving from the artifact directory would use the root dependency set.
          builder.onResolve({ filter: /^[^./]/ }, (args) => {
            const aliases = {
              'lodash-es': 'lodash',
              'p-queue': 'p-queue-6',
              emittery: 'emittery-0-13',
              'p-retry': 'p-retry-4',
            };
            const issuer = aliases[args.path] ? path.join(root, 'packages/core') : args.resolveDir || root;
            const resolved = createRequire(path.join(issuer, 'benchmark-resolve.cjs')).resolve(
              aliases[args.path] ?? args.path,
            );
            return { path: resolved, external: true };
          });
          if (variant === 'baseline')
            builder.onLoad({ filter: /[\\/]core[\\/]src[\\/]model[\\/]GraphProcessor\.ts$/ }, () => ({
              contents: baseline,
              loader: 'ts',
            }));
        },
      },
    ],
  });
  reports[variant] = JSON.parse(
    execFileSync(process.execPath, ['--expose-gc', outfile], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    }),
  );
}
for (let i = 0; i < reports.current.length; i++) {
  assert.deepEqual(reports.current[i].outputs, reports.baseline[i].outputs, 'observable outputs changed');
  assert.deepEqual(reports.current[i].events, reports.baseline[i].events, 'event order changed');
}
const comparison = reports.current.map((row, i) => ({
  name: row.name,
  scheduler: row.scheduler,
  baselineMedianMs: reports.baseline[i].medianMs,
  currentMedianMs: row.medianMs,
  baselineP95Ms: reports.baseline[i].p95Ms,
  currentP95Ms: row.p95Ms,
  baselineRetainedHeapBytes: reports.baseline[i].retainedHeapBytes,
  currentRetainedHeapBytes: row.retainedHeapBytes,
}));
await writeFile(
  path.join(outputDir, 'report.json'),
  JSON.stringify(
    {
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      node: process.version,
      comparison,
      reports,
    },
    null,
    2,
  ),
);
console.table(comparison);
console.log(
  'Outputs and ordered event sequences match. Local microbenchmarks are not production latency measurements.',
);
