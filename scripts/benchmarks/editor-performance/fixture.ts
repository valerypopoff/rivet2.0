import { createRequire } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { repoRoot } from './support.mjs';

const require = createRequire(path.join(repoRoot, 'packages/studio-server-web/package.json'));
const {
  createBuiltInRegistry,
  serializeProject,
  getGraphBoundary,
  coreCreateProcessor,
  ExecutionRecorder,
} = require('@valerypopoff/rivet2-core');

export async function createFixture() {
  const registry = createBuiltInRegistry(),
    projects = new Map<string, any>();
  for (let p = 9; p >= 0; p--) {
    const id = `perf-${p}`,
      nodes: any[] = [],
      connections: any[] = [];
    let previous: string | undefined;
    for (let n = 0; n < 98; n++) {
      const text = registry.createDynamic('text');
      text.id = `${id}-text-${n}`;
      text.title = `Step ${n}`;
      text.data.text = n === 0 ? `Project ${p} completed` : '{{input}}';
      text.visualData = { x: 60 + (n % 10) * 340, y: 150 + Math.floor(n / 10) * 240, width: 260 };
      if (previous)
        connections.push({ outputNodeId: previous, outputId: 'output', inputNodeId: text.id, inputId: 'input' });
      nodes.push(text);
      previous = text.id;
    }
    if (p < 9) {
      const call = registry.createDynamic('subGraph');
      call.id = `${id}-call`;
      call.data = {
        graphId: 'main',
        targetProjectId: `perf-${p + 1}`,
        targetVersion: 'latest',
        targetBoundary: getGraphBoundary(projects.get(`perf-${p + 1}`), 'main'),
      };
      call.visualData = { x: 420, y: 20, width: 280 };
      nodes.push(call);
    }
    const out = registry.createDynamic('graphOutput');
    out.id = `${id}-output`;
    out.data = { id: 'result', dataType: 'string' };
    out.visualData = { x: 800, y: 20, width: 200 };
    nodes.push(out);
    connections.push({ outputNodeId: previous, outputId: 'output', inputNodeId: out.id, inputId: 'value' });
    projects.set(id, {
      metadata: { id, title: `Benchmark ${p}`, description: '', mainGraphId: 'main' },
      graphs: { main: { metadata: { id: 'main', name: 'Main Graph' }, nodes, connections } },
      plugins: [],
    });
  }
  const root = projects.get('perf-0'),
    completed = new Set<string>(),
    graphs = new Set<string>();
  const recorded = coreCreateProcessor(root, {
    subgraphProjectLoader: {
      loadTarget: async (target) => ({ project: projects.get(target.projectId), revisionKey: 'fixture' }),
    },
  });
  recorded.processor.on('nodeFinish', ({ node }) => completed.add(node.id));
  recorded.processor.on('graphFinish', ({ execution }) => graphs.add(execution?.graphRunId));
  const recorder = new ExecutionRecorder();
  recorder.record(recorded.processor);
  const start = performance.now();
  try {
    await recorded.run();
    await recorded.processor.waitForRunCompletion();
  } finally {
    recorded.dispose();
  }
  const engineMs = performance.now() - start;
  if (completed.size !== 999 || graphs.size !== 10)
    throw new Error(`Incomplete fixture: ${completed.size}/999 nodes, ${graphs.size}/10 graphs`);
  const recording = recorder.serialize();
  const snapshot = serializeProject({ ...root, metadata: { ...root.metadata, id: 'perf-recording-snapshot' } });
  const summary = {
    id: 'benchmark-run',
    workflowId: 'perf-0',
    createdAt: '2026-10-25T00:00:00Z',
    runKind: 'latest',
    status: 'succeeded',
    durationMs: engineMs,
    endpointNameAtExecution: 'Benchmark',
    hasReplayDataset: false,
    recordingCompressedBytes: gzipSync(recording).length,
    recordingUncompressedBytes: Buffer.byteLength(recording),
    projectCompressedBytes: gzipSync(snapshot).length,
    projectUncompressedBytes: Buffer.byteLength(snapshot),
    datasetCompressedBytes: 0,
    datasetUncompressedBytes: 0,
    executionIdentity: { surface: 'workflow_endpoint', correlationId: 'benchmark' },
  };
  return {
    projects,
    root,
    recording,
    snapshot,
    summary,
    serializeProject,
    metrics: {
      fixtureRuntimeHash: createHash('sha256')
        .update(readFileSync(require.resolve('@valerypopoff/rivet2-core')))
        .digest('hex'),
      projects: 10,
      nodes: 999,
      completedNodes: completed.size,
      completedGraphs: graphs.size,
      recordingEvents: recorder.events.length,
      recordingBytes: Buffer.byteLength(recording),
      engineMs,
    },
  };
}
