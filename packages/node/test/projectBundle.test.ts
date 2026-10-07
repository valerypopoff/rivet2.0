// test-style: fixture-read: reads only test-owned exported manifests and project artifacts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  loadProjectBundle,
  serializeProject,
  serializeDatasets,
  getGraphBoundary,
  type Project,
  type ProjectId,
  type GraphId,
  type SubGraphNode,
  type ProjectBundleManifest,
  type DatasetId,
  type SubgraphProjectRun,
  loadProjectFromString,
  ReferencedGraphAliasNodeImpl,
  GetDatasetRowNodeImpl,
  GraphOutputNodeImpl,
  type PortId,
} from '../src/index.js';
import { makeSubgraphChainProject } from './runtimeSpeedFixtures.js';

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-bundle-node-'));
  const graphId = 'runtime-speed-subgraph' as GraphId;
  const root = makeSubgraphChainProject(2).project;
  const child: Project = {
    metadata: { id: 'child' as ProjectId, title: 'Child', description: '', mainGraphId: graphId },
    graphs: { [graphId]: structuredClone(root.graphs[graphId]!) },
  };
  delete root.graphs[graphId];
  let callIndex = 0;
  for (const call of root.graphs[root.metadata.mainGraphId!]!.nodes.filter(
    (n) => n.type === 'subGraph',
  ) as SubGraphNode[]) {
    call.data.targetProjectId = child.metadata.id;
    call.data.targetVersion = callIndex++ === 0 ? 'latest' : 'published';
    call.data.targetBoundary = getGraphBoundary(child, graphId)!;
  }
  const published = structuredClone(child);
  const text = published.graphs[graphId]!.nodes.find((n) => n.type === 'text')!;
  (text.data as { text: string }).text = '{{input}}p';
  await fs.mkdir(path.join(directory, 'projects'));
  const manifest: ProjectBundleManifest = {
    format: 'rivet-project-bundle',
    schemaVersion: 1,
    requiredLoaderVersion: 1,
    exportingRuntimeVersion: 'fixture-runtime',
    rootArtifact: 'root',
    artifacts: [],
    targets: [],
    references: [],
    plugins: [],
  };
  const projects = [root, child, published];
  for (let index = 0; index < projects.length; index++) {
    const project = projects[index]!,
      id = ['root', 'latest', 'published'][index]!;
    const contents = serializeProject(project) as string;
    const file = `projects/${id}.rivet-project`;
    await fs.writeFile(path.join(directory, file), contents);
    manifest.artifacts.push({
      id,
      projectId: project.metadata.id,
      title: project.metadata.title,
      version: index === 2 ? 'published' : 'latest',
      revision: `revision-${index}`,
      project: {
        path: file,
        bytes: Buffer.byteLength(contents),
        sha256: createHash('sha256').update(contents).digest('hex'),
      },
    });
    if (index > 0) {
      const datasets = serializeDatasets([
        {
          meta: { id: 'shared' as DatasetId, projectId: child.metadata.id, name: id, description: '' },
          data: { id: 'shared' as DatasetId, rows: [{ id: 'row', data: [id] }] },
        },
      ]);
      const datasetPath = `projects/${id}.rivet-data`;
      await fs.writeFile(path.join(directory, datasetPath), datasets);
      manifest.artifacts[index]!.datasets = {
        path: datasetPath,
        bytes: Buffer.byteLength(datasets),
        sha256: createHash('sha256').update(datasets).digest('hex'),
      };
    }
  }
  manifest.targets.push(
    { projectId: child.metadata.id, version: 'latest', artifact: 'latest' },
    { projectId: child.metadata.id, version: 'published', artifact: 'published' },
  );
  const manifestPath = path.join(directory, 'rivet-bundle.json');
  const save = () => fs.writeFile(manifestPath, JSON.stringify(manifest));
  await save();
  return { directory, manifest, manifestPath, save };
}

test('bundle runs independent saved versions after relocation and isolates mutable child datasets', async () => {
  const f = await fixture();
  const moved = `${f.directory}-moved`;
  try {
    await fs.rename(f.directory, moved);
    const bundle = await loadProjectBundle(path.join(moved, 'rivet-bundle.json'));
    // Test the distributable entry points too, not just tsx's source import.
    const publicLoaders: (typeof loadProjectBundle)[] = [
      (await import('@valerypopoff/rivet2-node')).loadProjectBundle,
      createRequire(import.meta.url)('@valerypopoff/rivet2-node').loadProjectBundle,
    ];
    for (const publicLoader of publicLoaders) {
      const publicRunner = (await publicLoader(path.join(moved, 'rivet-bundle.json'))).createProcessor({
        inputs: { input: 'public' },
      });
      try {
        assert.equal((await publicRunner.run()).result?.value, 'publicxp');
      } finally {
        publicRunner.dispose();
      }
    }
    const seen: SubgraphProjectRun[] = [];
    const first = bundle.createProcessor({
      inputs: { input: 'hello' },
      onSubgraphProjectRun: (run) => {
        seen.push(run);
      },
    });
    try {
      assert.equal((await first.run()).result?.value, 'helloxp');
    } finally {
      first.dispose();
    }
    assert.equal(seen.length, 2);
    const latest = seen.find((r) => r.target.version === 'latest')!.resolved.datasetProvider!;
    const published = seen.find((r) => r.target.version === 'published')!.resolved.datasetProvider!;
    assert.equal((await latest.getDatasetData('shared' as DatasetId))!.rows[0]!.data[0], 'latest');
    assert.equal((await published.getDatasetData('shared' as DatasetId))!.rows[0]!.data[0], 'published');
    await latest.putDatasetMetadata({
      id: 'mutation' as DatasetId,
      projectId: 'child' as ProjectId,
      name: 'Changed',
      description: '',
    });
    assert.equal(await published.getDatasetMetadata('mutation' as DatasetId), undefined);
    const second = bundle.createProcessor({
      inputs: { input: 'again' },
      onSubgraphProjectRun: async (run) => {
        assert.equal(await run.resolved.datasetProvider!.getDatasetMetadata('mutation' as DatasetId), undefined);
      },
    });
    try {
      assert.equal((await second.run()).result?.value, 'againxp');
    } finally {
      second.dispose();
    }
    assert.throws(() => bundle.createProcessor({ subgraphProjectLoader: {} } as never), /Bundle owns/);
  } finally {
    await fs.rm(moved, { recursive: true, force: true });
    await fs.rm(f.directory, { recursive: true, force: true });
  }
});

test('bundle rejects corrupt, incomplete, oversized and unsafe artifacts before execution', async () => {
  const f = await fixture();
  try {
    const original = structuredClone(f.manifest);
    for (const [mutate, message] of [
      [
        () => {
          f.manifest.schemaVersion = 2 as never;
        },
        /unsupported/,
      ],
      [
        () => {
          f.manifest.targets = [];
        },
        /missing Subgraph/,
      ],
      [
        () => {
          f.manifest.artifacts[0]!.project.path = '../escape';
        },
        /unsafe/,
      ],
      [
        () => {
          f.manifest.artifacts[0]!.project.path = 'C:/escape';
        },
        /unsafe/,
      ],
      [
        () => {
          f.manifest.targets.push(f.manifest.targets[0]!);
        },
        /duplicate target/,
      ],
      [
        () => {
          f.manifest.artifacts[0]!.project.sha256 = '0'.repeat(64);
        },
        /checksum/,
      ],
      [
        () => {
          f.manifest.artifacts[1]!.projectId = 'foreign';
        },
        /binding|identity/,
      ],
      [
        () => {
          f.manifest.plugins = [
            { type: 'package', id: 'same-plugin', package: 'fixture-plugin', tag: '1.0.0' },
            { type: 'package', id: 'same-plugin', package: 'fixture-plugin', tag: '2.0.0' },
          ];
        },
        /conflicting requirements/,
      ],
    ] as const) {
      Object.assign(f.manifest, structuredClone(original));
      mutate();
      await f.save();
      await assert.rejects(loadProjectBundle(f.manifestPath), message);
    }
    Object.assign(f.manifest, original);
    await f.save();
    await assert.rejects(loadProjectBundle(f.manifestPath, { maxTotalBytes: 1 }), /byte limit/);
    const childFile = f.manifest.artifacts[1]!.project;
    const originalChild = await fs.readFile(path.join(f.directory, childFile.path), 'utf8');
    const child = loadProjectFromString(originalChild);
    child.plugins = [{ type: 'package', id: 'fixture-external', package: 'not-installed', tag: '1.0.0' }];
    const pluginChild = serializeProject(child) as string;
    await fs.writeFile(path.join(f.directory, childFile.path), pluginChild);
    childFile.bytes = Buffer.byteLength(pluginChild);
    childFile.sha256 = createHash('sha256').update(pluginChild).digest('hex');
    await f.save();
    await assert.rejects(loadProjectBundle(f.manifestPath), /missing the required plugin declaration/);
    f.manifest.plugins = [{ type: 'package', id: 'fixture-external', package: 'not-installed', tag: '2.0.0' }];
    await f.save();
    await assert.rejects(loadProjectBundle(f.manifestPath), /missing the required plugin declaration/);
    f.manifest.plugins = [{ type: 'package', id: 'fixture-external', package: 'not-installed', tag: '1.0.0' }];
    await f.save();
    const pluginBundle = await loadProjectBundle(f.manifestPath);
    assert.throws(() => pluginBundle.createProcessor(), /requires plugin fixture-external/);
    await fs.writeFile(path.join(f.directory, childFile.path), originalChild);
    childFile.bytes = Buffer.byteLength(originalChild);
    childFile.sha256 = createHash('sha256').update(originalChild).digest('hex');
    f.manifest.plugins = [];
    await f.save();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-bundle-escape-'));
    try {
      await fs.rename(path.join(f.directory, 'projects'), path.join(outside, 'projects'));
      await fs.symlink(
        path.join(outside, 'projects'),
        path.join(f.directory, 'projects'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      await assert.rejects(loadProjectBundle(f.manifestPath), /escapes/);
    } finally {
      await fs.rm(path.join(f.directory, 'projects'), { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  } finally {
    await fs.rm(f.directory, { recursive: true, force: true });
  }
});

test('legacy aliases use child datasets, not root datasets, and reject missing alias graphs', async () => {
  const f = await fixture();
  try {
    const rootArtifact = f.manifest.artifacts[0]!;
    const childArtifact = f.manifest.artifacts[1]!;
    const root = loadProjectFromString(await fs.readFile(path.join(f.directory, rootArtifact.project.path), 'utf8'));
    const child = loadProjectFromString(await fs.readFile(path.join(f.directory, childArtifact.project.path), 'utf8'));
    const readRow = GetDatasetRowNodeImpl.create();
    readRow.data.datasetId = 'shared' as DatasetId;
    readRow.data.rowId = 'row';
    const childOutput = GraphOutputNodeImpl.create();
    childOutput.data.id = 'result';
    childOutput.data.dataType = 'object';
    const childGraph = child.graphs[child.metadata.mainGraphId!]!;
    childGraph.nodes = [readRow, childOutput];
    childGraph.connections = [
      { outputNodeId: readRow.id, outputId: 'row' as PortId, inputNodeId: childOutput.id, inputId: 'value' as PortId },
    ];
    const alias = ReferencedGraphAliasNodeImpl.create();
    alias.data.projectId = child.metadata.id;
    alias.data.graphId = child.metadata.mainGraphId!;
    root.references = [{ id: child.metadata.id }];
    const rootOutput = GraphOutputNodeImpl.create();
    rootOutput.data.id = 'result';
    rootOutput.data.dataType = 'object';
    const rootGraph = root.graphs[root.metadata.mainGraphId!]!;
    rootGraph.nodes = [alias, rootOutput];
    rootGraph.connections = [
      { outputNodeId: alias.id, outputId: 'result' as PortId, inputNodeId: rootOutput.id, inputId: 'value' as PortId },
    ];
    const replace = async (file: typeof rootArtifact.project, contents: string) => {
      await fs.writeFile(path.join(f.directory, file.path), contents);
      file.bytes = Buffer.byteLength(contents);
      file.sha256 = createHash('sha256').update(contents).digest('hex');
    };
    await replace(rootArtifact.project, serializeProject(root) as string);
    await replace(childArtifact.project, serializeProject(child) as string);
    // Root has the same dataset ID but different contents.
    rootArtifact.datasets = { ...childArtifact.datasets!, path: 'projects/root.rivet-data' };
    await replace(
      rootArtifact.datasets,
      serializeDatasets([
        {
          meta: { id: 'shared' as DatasetId, projectId: root.metadata.id, name: 'Root', description: '' },
          data: { id: 'shared' as DatasetId, rows: [{ id: 'row', data: ['root'] }] },
        },
      ]),
    );
    f.manifest.references = [{ projectId: child.metadata.id, artifact: childArtifact.id }];
    await f.save();
    const bundle = await loadProjectBundle(f.manifestPath);
    assert.equal(bundle.root.id, root.metadata.id);
    const runner = bundle.createProcessor();
    try {
      assert.deepEqual((await runner.run()).result?.value, { id: 'row', data: ['latest'] });
    } finally {
      runner.dispose();
    }
    await replace(childArtifact.datasets!, serializeDatasets([]));
    await f.save();
    const emptyRunner = (await loadProjectBundle(f.manifestPath)).createProcessor();
    try {
      assert.equal((await emptyRunner.run()).result?.type, 'control-flow-excluded');
    } finally {
      emptyRunner.dispose();
    }
    alias.data.graphId = 'missing' as GraphId;
    await replace(rootArtifact.project, serializeProject(root) as string);
    await f.save();
    await assert.rejects(loadProjectBundle(f.manifestPath), /missing referenced graph/);
  } finally {
    await fs.rm(f.directory, { recursive: true, force: true });
  }
});

test('artifact growth after stat is rejected without reading beyond the captured size', async (t) => {
  const f = await fixture();
  const target = path.join(f.directory, f.manifest.artifacts[0]!.project.path);
  const originalOpen = fs.open;
  let bytesRead = 0;
  const originalSize = f.manifest.artifacts[0]!.project.bytes;
  try {
    t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (args[0] === target) {
        const stat = handle.stat.bind(handle);
        t.mock.method(handle, 'stat', async () => {
          const before = await stat();
          await fs.appendFile(target, Buffer.alloc(512 * 1024, 32));
          return before;
        });
        const read = handle.read.bind(handle);
        t.mock.method(handle, 'read', async (buffer: Buffer, offset: number, length: number, position: null) => {
          const result = await read(buffer, offset, length, position);
          bytesRead += result.bytesRead;
          return result;
        });
      }
      return handle;
    });
    await assert.rejects(loadProjectBundle(f.manifestPath), /size mismatch/);
    assert.equal(bytesRead, originalSize + 1, 'only one overflow byte may be read');
  } finally {
    t.mock.restoreAll();
    await fs.rm(f.directory, { recursive: true, force: true });
  }
});
