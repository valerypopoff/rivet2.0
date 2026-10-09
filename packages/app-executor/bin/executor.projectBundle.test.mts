import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import {
  TextNodeImpl,
  GraphOutputNodeImpl,
  SubGraphNodeImpl,
  GetDatasetRowNodeImpl,
  getGraphBoundary,
  serializeProject,
  type Project,
  type GraphId,
  type ProjectId,
  type PortId,
  type DatasetId,
  type CombinedDataset,
} from '@valerypopoff/rivet2-core';

void test(
  'standalone desktop executor runs bundle dependencies and members using the uploaded unsaved entry',
  { timeout: 60_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'rivet-executor-bundle-'));
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const port = address.port;
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    // Opt in after `yarn ... run build` to exercise the exact native sidecar
    // shipped with Tauri, rather than the machine's development Node runtime.
    const packagedExecutor = process.env.RIVET_TEST_PACKAGED_EXECUTOR;
    const child = spawn(
      packagedExecutor || process.execPath,
      packagedExecutor
        ? []
        : [
            '--import',
            import.meta.resolve('tsx'),
            '--input-type=module',
            '--eval',
            `
        const fs = (await import('node:fs')).promises;
        const originalOpen = fs.open.bind(fs);
        let gateNextEntry = true;
        fs.open = async (path, ...args) => {
          const handle = await originalOpen(path, ...args);
          if (gateNextEntry && String(path).endsWith('root.rivet-project')) {
            gateNextEntry = false;
            process.stdout.write('BUNDLE_READ_WAITING\\n');
            await new Promise((resolve) => process.stdin.once('data', resolve));
          }
          return handle;
        };
        const { startAppExecutor } = await import(${JSON.stringify(new URL('./executorHost.mts', import.meta.url).href)});
        await startAppExecutor({});
      `,
          ],
      {
        cwd: new URL('../', import.meta.url),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          HOME: directory,
          USERPROFILE: directory,
          APPDATA: directory,
          LOCALAPPDATA: directory,
          RIVET_EXECUTOR_HOST: '127.0.0.1',
          RIVET_EXECUTOR_PORT: String(port),
          RIVET_CODE_RUNNER_WORKER_POOL_SIZE: '1',
        },
      },
    );
    const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
    t.after(async () => {
      if (child.exitCode == null) child.kill('SIGKILL');
      await exited;
      await rm(directory, { recursive: true, force: true });
    });
    let logs = '';
    await new Promise<void>((resolve, reject) => {
      const onOutput = (chunk: Buffer) => {
        logs += chunk.toString();
        if (logs.includes(`Rivet app executor websocket listening on 127.0.0.1:${port}`)) resolve();
      };
      child.stdout.on('data', onOutput);
      child.stderr.on('data', onOutput);
      child.once('error', reject);
      child.once('close', () => reject(new Error(`Executor exited before readiness: ${logs}`)));
      t.signal.addEventListener('abort', () => reject(new Error(`Executor startup timed out: ${logs}`)), {
        once: true,
      });
    });
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    t.after(() => socket.close());
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('WebSocket connection failed')), { once: true });
      t.signal.addEventListener('abort', () => reject(new Error('WebSocket startup timed out')), { once: true });
    });
    const graph = 'main' as GraphId;
    const text = TextNodeImpl.create();
    text.data.text = 'bundled dependency';
    const output = GraphOutputNodeImpl.create();
    output.data.id = 'result';
    const dependency: Project = {
      metadata: { id: 'child' as ProjectId, title: 'Dependency', description: '', mainGraphId: graph },
      graphs: {
        [graph]: {
          metadata: { id: graph, name: 'Dependency' },
          nodes: [text, output],
          connections: [
            { outputNodeId: text.id, outputId: 'output' as PortId, inputNodeId: output.id, inputId: 'value' as PortId },
          ],
        },
      },
    };
    const subgraph = SubGraphNodeImpl.create();
    subgraph.data.graphId = graph;
    subgraph.data.targetProjectId = dependency.metadata.id;
    subgraph.data.targetVersion = 'latest';
    subgraph.data.targetBoundary = getGraphBoundary(dependency, graph)!;
    const root: Project = {
      metadata: { ...dependency.metadata, id: 'root' as ProjectId, title: 'Root' },
      graphs: {
        [graph]: {
          metadata: { id: graph, name: 'Root' },
          nodes: [subgraph, output],
          connections: [
            {
              outputNodeId: subgraph.id,
              outputId: 'result' as PortId,
              inputNodeId: output.id,
              inputId: 'value' as PortId,
            },
          ],
        },
      },
    };
    await mkdir(join(directory, 'projects'));
    for (const project of [root, dependency])
      await writeFile(
        join(directory, `projects/${project.metadata.id}.rivet-project`),
        serializeProject(project) as string,
      );
    const manifestPath = join(directory, 'rivet-bundle.json');
    await writeFile(
      manifestPath,
      JSON.stringify({
        format: 'rivet-project-bundle',
        schemaVersion: 1,
        requiredLoaderVersion: 2,
        exportingRuntimeVersion: 'fixture',
        rootArtifact: 'root',
        plugins: [],
        references: [],
        artifacts: [root, dependency].map((project) => ({
          id: project.metadata.id,
          projectId: project.metadata.id,
          title: project.metadata.title,
          version: 'latest',
          revision: 'original',
          project: { path: `projects/${project.metadata.id}.rivet-project` },
        })),
        targets: [{ projectId: 'child', version: 'latest', artifact: 'child' }],
      }),
    );
    const edited = structuredClone(root);
    const suffix = TextNodeImpl.create();
    suffix.data.text = '{{input}} + unsaved';
    edited.graphs[graph]!.nodes.push(suffix);
    edited.graphs[graph]!.connections = [
      { outputNodeId: subgraph.id, outputId: 'result' as PortId, inputNodeId: suffix.id, inputId: 'input' as PortId },
      { outputNodeId: suffix.id, outputId: 'output' as PortId, inputNodeId: output.id, inputId: 'value' as PortId },
    ];
    // The explicit read gate is available only in the source process. Packaged
    // smoke runs reuse all execution assertions below without injecting code.
    if (!packagedExecutor) {
      const readWaiting = new Promise<void>((resolve, reject) => {
        const onOutput = () => {
          if (logs.includes('BUNDLE_READ_WAITING')) {
            child.stdout.off('data', onOutput);
            resolve();
          }
        };
        child.stdout.on('data', onOutput);
        t.signal.addEventListener('abort', () => reject(new Error('Bundle read gate timed out')), { once: true });
      });
      const abortAcknowledged = new Promise<void>((resolve, reject) => {
        const receive = (event: MessageEvent) => {
          const message = JSON.parse(String(event.data));
          if (message.requestId !== 'bundle-aborted') return;
          if (message.message === 'abort') {
            socket.removeEventListener('message', receive);
            resolve();
          }
          if (message.message === 'nodeStart' || message.message === 'done')
            reject(new Error('Aborted preparation executed nodes'));
        };
        socket.addEventListener('message', receive);
        t.signal.addEventListener('abort', () => reject(new Error('Abort acknowledgement timed out')), { once: true });
      });
      socket.send(JSON.stringify({ type: 'set-dynamic-data', data: { project: edited, settings: {} } }));
      socket.send(
        JSON.stringify({
          type: 'run',
          data: {
            requestId: 'bundle-aborted',
            graphId: graph,
            projectBundle: { manifestPath, artifactId: 'root', entryDatasets: [] },
          },
        }),
      );
      await readWaiting;
      socket.send(JSON.stringify({ type: 'abort', data: { requestId: 'bundle-aborted' } }));
      await abortAcknowledged;
      child.stdin.write('release\n');
    }

    const datasetEntry = structuredClone(root);
    const datasetRow = GetDatasetRowNodeImpl.create();
    datasetRow.data.datasetId = 'shared' as DatasetId;
    datasetRow.data.rowId = 'row';
    datasetEntry.graphs[graph]!.nodes = [datasetRow, output];
    datasetEntry.graphs[graph]!.connections = [
      { outputNodeId: datasetRow.id, outputId: 'row' as PortId, inputNodeId: output.id, inputId: 'value' as PortId },
    ];
    const snapshot: CombinedDataset[] = [
      {
        meta: { id: 'shared' as DatasetId, projectId: root.metadata.id, name: 'Shared', description: '' },
        data: { id: 'shared' as DatasetId, rows: [{ id: 'row', data: ['captured-entry'] }] },
      },
    ];
    const runs: { project: Project; artifactId: string; entryDatasets: CombinedDataset[]; expected: unknown }[] = [
      { project: edited, artifactId: 'root', entryDatasets: [], expected: 'bundled dependency + unsaved' },
      { project: dependency, artifactId: 'child', entryDatasets: [], expected: 'bundled dependency' },
      { project: datasetEntry, artifactId: 'root', entryDatasets: snapshot, expected: snapshot[0]!.data.rows[0] },
    ];
    for (const [index, { project, artifactId, entryDatasets, expected }] of runs.entries()) {
      const requestId = `bundle-${artifactId}-${index}`;
      const graphOwners = new Set<string>();
      const completed = new Promise<unknown>((resolve, reject) => {
        const cleanup = () => {
          socket.removeEventListener('message', receive);
          socket.removeEventListener('close', closed);
          t.signal.removeEventListener('abort', aborted);
        };
        const receive = (event: MessageEvent) => {
          const value = JSON.parse(String(event.data));
          if (value.requestId !== requestId) return;
          if (value.message === 'graphStart') graphOwners.add(value.data.execution?.projectId);
          if (value.message === 'error') {
            cleanup();
            reject(new Error(JSON.stringify(value)));
          }
          if (value.message === 'done') {
            cleanup();
            resolve(value.data.results.result.value);
          }
        };
        const closed = () => {
          cleanup();
          reject(new Error('Socket closed during run'));
        };
        const aborted = () => {
          cleanup();
          reject(new Error('Bundle run timed out'));
        };
        socket.addEventListener('message', receive);
        socket.addEventListener('close', closed);
        t.signal.addEventListener('abort', aborted, { once: true });
      });
      socket.send(JSON.stringify({ type: 'set-dynamic-data', data: { project, settings: {} } }));
      socket.send(
        JSON.stringify({
          type: 'run',
          data: {
            requestId,
            graphId: graph,
            projectBundle: { manifestPath, artifactId, entryDatasets },
            useEditorCache: true,
          },
        }),
      );
      assert.deepEqual(await completed, expected);
      assert.ok(graphOwners.has(project.metadata.id), 'wire metadata identifies the actual entry owner');
      if (index === 0)
        assert.ok(graphOwners.has(dependency.metadata.id), 'dependency events retain their own project identity');
    }
  },
);
