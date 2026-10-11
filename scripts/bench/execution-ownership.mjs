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
const baselineBridge = execFileSync('git', ['show', 'HEAD:packages/core/src/model/SubprocessorBridge.ts'], {
  cwd: root,
  encoding: 'utf8',
});
const baselineEditorSources = new Map(
  [
    'projectExecutionSnapshotEvents.ts',
    'useExecutionDataFlow.ts',
    'graphExecutionEventHelpers.ts',
    'agentTraceEventStorage.ts',
  ].map((name) => [
    name,
    execFileSync('git', ['show', `HEAD:packages/app/src/hooks/${name}`], { cwd: root, encoding: 'utf8' }),
  ]),
);
const entry = `
import { performance } from 'node:perf_hooks';
import { createRuntimeSpeedProcessor, createRuntimeSpeedProcessContext, makeTextChainProject, makeNestedSubgraphProject, makeRepeatedSubgraphFanInProject } from './packages/node/test/runtimeSpeedFixtures.ts';
import { captureEditorRun } from './packages/app/src/hooks/preparedEditorRun.ts';
import { withDerivedProjectPluginSpecs } from './packages/app/src/utils/pluginUsage.ts';
import { applyProcessEventToProjectExecutionSnapshot } from './packages/app/src/hooks/projectExecutionSnapshotEvents.ts';
import { createEmptyProjectExecutionSnapshot } from './packages/app/src/state/dataFlow.ts';
import { captureProjectExecutionSnapshot, restoreProjectExecutionSnapshot } from './packages/app/src/hooks/projectExecutionSnapshotBindings.ts';
import { createStore } from 'jotai';
async function main() {
const rows = [];
// Protected display workload: same events, stable refs and resulting history.
// This measures state processing, not browser repaint or packaged desktop startup.
const realNow = Date.now;
Date.now = () => 1234;
for (const size of [20, 100]) {
  const runDisplay = () => {
    let snapshot = createEmptyProjectExecutionSnapshot();
    const refs = new Map();
    const refStore = { get: (id) => refs.get(id), set: (id, value) => refs.set(id, value), delete: (id) => refs.delete(id) };
    const execution = { graphId: 'display-graph', graphRunId: 'display-run', rootRunId: 'display-root' };
    const apply = (message, data) => snapshot = applyProcessEventToProjectExecutionSnapshot({ snapshot, message, data, projectId: 'display-project', refStore }).snapshot;
    for (let i = 0; i < size; i++) {
      const node = { id: 'node-' + i, type: 'text', data: {} };
      const processId = 'process-' + i;
      apply('nodeStart', { node, processId, execution, inputs: {} });
      for (let chunk = 0; chunk < 5; chunk++) apply('partialOutput', { node, processId, execution, index: 0, outputs: { output: { type: 'string', value: ('chunk-' + chunk).repeat(4000) } } });
      apply('llmChatOutputSnapshot', { nodeId: node.id, processId, execution, entryId: 'round', kind: 'model-round', outcome: 'final-answer', roundIndex: 0, splitIndex: 0, outputs: { response: { type: 'string', value: 'history'.repeat(4000) } } });
      apply('llmCallFinished', { nodeId: node.id, processId, execution, callId: 'call-' + i, provider: 'custom', model: 'fixture', attemptIndex: 0, outcome: 'success', durationMs: 1, pricing: { status: 'unknown' } });
      apply('llmProfileAttempt', { nodeId: node.id, processId, execution, eventId: 'profile-' + i, roundIndex: 0, profileIndex: 0, provider: 'custom', model: 'fixture', stage: 'request', outcome: 'success', attemptIndex: 0 });
      apply('toolCallFinished', { sourceNodeId: node.id, sourceProcessId: processId, execution, toolCallId: 'tool-' + i, toolName: 'fixture', handlerKind: 'external', outcome: 'success', durationMs: 1 });
      apply('nodeFinish', { node, processId, execution, durationMs: 5, outputs: { output: { type: 'string', value: 'final'.repeat(4000) } } });
    }
    const retainedRefs = refs.size;
    // A tab round-trip must reuse payload identities, not copy the history.
    const store = createStore();
    restoreProjectExecutionSnapshot(store, snapshot);
    const captured = captureProjectExecutionSnapshot(store);
    if (captured.lastRunDataByNode !== snapshot.lastRunDataByNode) throw new Error('Tab restoration copied execution history');
    for (let i = 0; i < size; i++) apply('nodeOutputsCleared', { node: { id: 'node-' + i }, processId: 'process-' + i, execution });
    if (refs.size !== 0) throw new Error('Display workload leaked data refs');
    return { data: captured.lastRunDataByNode, retainedRefs, remainingRefs: refs.size };
  };
  for (let i = 0; i < 10; i++) runDisplay();
  global.gc?.();
  const before = process.memoryUsage().heapUsed;
  const samples = [];
  let outputs;
  for (let i = 0; i < 60; i++) { const start = performance.now(); outputs = runDisplay(); samples.push(performance.now() - start); }
  global.gc?.();
  samples.sort((a,b) => a-b);
  rows.push({ name: 'display-' + size, scheduler: 'editor-stream-history', outputs, events: [], medianMs: samples[30], p95Ms: samples[56], retainedHeapBytes: process.memoryUsage().heapUsed - before, samples });
}
Date.now = realNow;
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
    let identities = new Map();
    const identity = (kind, value) => {
      if (value == null) return value;
      const key = kind + ':' + value;
      if (!identities.has(key)) identities.set(key, kind + ':' + identities.size);
      return identities.get(key);
    };
    const unsubscribe = processor.onAny((name, data) => {
      const execution = data?.execution;
      events.push([name, data?.node?.id, data?.graph?.metadata?.id, execution?.graphId, execution?.projectScope,
        identity('root', execution?.rootRunId), identity('graph', execution?.graphRunId), identity('graph', execution?.parentGraphRunId),
        execution?.executor?.nodeId, execution?.executor?.parentGraphId, execution?.executor?.index,
        identity('process', execution?.executor?.processId), identity('process', data?.processId)]);
    });
    const execute = () => processor.processGraph(context, { input: { type: 'string', value: 'fixture' } });
    for (let i = 0; i < 10; i++) await execute();
    global.gc?.();
    const before = process.memoryUsage().heapUsed;
    const samples = [];
    let outputs;
    for (let i = 0; i < 60; i++) { events = []; identities = new Map(); const start = performance.now(); outputs = await execute(); await processor.waitForRunCompletion(); samples.push(performance.now() - start); }
    global.gc?.();
    const retainedHeapBytes = process.memoryUsage().heapUsed - before;
    unsubscribe();
    samples.sort((a,b) => a-b);
    rows.push({name, scheduler, outputs, events, medianMs: samples[30], p95Ms: samples[56], retainedHeapBytes, samples});
  }
}
console.log(JSON.stringify({ rows, peakResidentBytes: process.resourceUsage().maxRSS * 1024 }));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
`;
const reports = {};
const peakResidentBytes = {};
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
            const issuer =
              args.path === 'jotai'
                ? path.join(root, 'packages/app')
                : aliases[args.path]
                  ? path.join(root, 'packages/core')
                  : args.resolveDir || root;
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
          if (variant === 'baseline')
            builder.onLoad({ filter: /[\\/]core[\\/]src[\\/]model[\\/]SubprocessorBridge\.ts$/ }, () => ({
              contents: baselineBridge,
              loader: 'ts',
            }));
          if (variant === 'baseline')
            builder.onLoad(
              {
                filter: /[\\/]app[\\/]src[\\/]hooks[\\/][^\\/]+\.ts$/,
              },
              (args) => {
                const contents = baselineEditorSources.get(path.basename(args.path));
                return contents === undefined ? undefined : { contents, loader: 'ts' };
              },
            );
        },
      },
    ],
  });
  const result = JSON.parse(
    execFileSync(process.execPath, ['--expose-gc', outfile], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    }),
  );
  reports[variant] = result.rows;
  peakResidentBytes[variant] = result.peakResidentBytes;
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
      peakResidentBytes,
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
