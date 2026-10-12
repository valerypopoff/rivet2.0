import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GraphProcessor,
  GraphOutputNodeImpl,
  TextNodeImpl,
  SubGraphNodeImpl,
  InMemoryDatasetProvider,
  getGraphBoundary,
  serializeProject,
  serializeDatasets,
  globalRivetNodeRegistry,
  resolveProcessSettings,
  GptTokenizerTokenizer,
  type Project,
  type ProjectId,
  type GraphId,
  type PortId,
  type DatasetId,
  type SubGraphNode,
} from '@valerypopoff/rivet2-core';
import {
  prepareDesktopProjectBundle,
  readProjectBundleForExecution,
  type NativeProjectBundle,
} from './DesktopProjectBundle.js';

test('known bundle execution fails closed when its path, reader or manifest result is lost', async () => {
  const emptyReader = { readProjectBundle: async () => undefined };
  await assert.rejects(readProjectBundleForExecution({}, '/project', '/manifest'), /Reopen rivet-bundle.json/);
  await assert.rejects(readProjectBundleForExecution(emptyReader, undefined, '/manifest'), /Reopen rivet-bundle.json/);
  await assert.rejects(readProjectBundleForExecution(emptyReader, '/project', '/manifest'), /Reopen rivet-bundle.json/);
  assert.equal(await readProjectBundleForExecution({}, '/standalone'), undefined);
  assert.equal(await readProjectBundleForExecution(emptyReader, '/standalone'), undefined);
});

test('execution preserves reader ownership and passes the remembered manifest for the entry project', async () => {
  const bundle = prepareDesktopProjectBundle(fixture().native);
  const io = {
    bundle,
    async readProjectBundle(path: string, manifestPath?: string) {
      assert.equal(path, '/fixture/projects/root.rivet-project');
      assert.equal(manifestPath, '/fixture/rivet-bundle.json');
      return this.bundle;
    },
  };
  assert.equal(
    await readProjectBundleForExecution(io, '/fixture/projects/root.rivet-project', '/fixture/rivet-bundle.json'),
    bundle,
  );
});

function fixture() {
  const graph = 'main' as GraphId;
  const text = TextNodeImpl.create();
  text.data.text = 'disk dependency';
  const output = GraphOutputNodeImpl.create();
  output.data.id = 'result';
  const child: Project = {
    metadata: { id: 'child' as ProjectId, title: 'Child', description: '', mainGraphId: graph },
    graphs: {
      [graph]: {
        metadata: { id: graph, name: 'Child' },
        nodes: [text, output],
        connections: [
          { outputNodeId: text.id, outputId: 'output' as PortId, inputNodeId: output.id, inputId: 'value' as PortId },
        ],
      },
    },
  };
  const call = SubGraphNodeImpl.create();
  call.data.graphId = graph;
  call.data.targetProjectId = child.metadata.id;
  call.data.targetVersion = 'latest';
  call.data.targetBoundary = getGraphBoundary(child, graph)!;
  const root: Project = {
    metadata: { ...child.metadata, id: 'root' as ProjectId, title: 'Root' },
    graphs: {
      [graph]: {
        metadata: { id: graph, name: 'Root' },
        nodes: [call, structuredClone(output)],
        connections: [
          { outputNodeId: call.id, outputId: 'result' as PortId, inputNodeId: output.id, inputId: 'value' as PortId },
        ],
      },
    },
  };
  const native: NativeProjectBundle = {
    manifestPath: '/fixture/rivet-bundle.json',
    selectedProjectPath: null,
    manifestContents: JSON.stringify({
      format: 'rivet-project-bundle',
      schemaVersion: 1,
      requiredLoaderVersion: 2,
      exportingRuntimeVersion: 'test',
      rootArtifact: 'root',
      artifacts: [root, child].map((project) => ({
        id: project.metadata.id,
        projectId: project.metadata.id,
        title: project.metadata.title,
        version: 'latest',
        revision: 'original',
        project: { path: `projects/${project.metadata.id}.rivet-project` },
        datasets: { path: `projects/${project.metadata.id}.rivet-data` },
      })),
      targets: [{ projectId: 'child', version: 'latest', artifact: 'child' }],
      references: [],
      plugins: [],
    }),
    files: [root, child].flatMap((project) => [
      {
        path: `projects/${project.metadata.id}.rivet-project`,
        sourceProjectPath: `/fixture/projects/${project.metadata.id}.rivet-project`,
        contents: serializeProject(project) as string,
      },
      {
        path: `projects/${project.metadata.id}.rivet-data`,
        sourceProjectPath: `/fixture/projects/${project.metadata.id}.rivet-data`,
        contents: serializeDatasets([
          {
            meta: { id: 'shared' as DatasetId, projectId: project.metadata.id, name: 'Shared', description: '' },
            data: { id: 'shared' as DatasetId, rows: [{ id: 'row', data: [project.metadata.id] }] },
          },
        ]),
      },
    ]),
  };
  return { native, root, child, call, output };
}

test('desktop opens the manifest root or declared member and executes its contained dependency in Browser mode', async () => {
  const f = fixture();
  const bundle = prepareDesktopProjectBundle(f.native);
  assert.equal(bundle.artifactId, 'root');
  assert.equal(bundle.snapshot.sourceProjectPath, '/fixture/projects/root.rivet-project');
  const context = bundle.createRuntime(bundle.snapshot.project);
  const processor = new GraphProcessor(context.project, 'main' as GraphId, globalRivetNodeRegistry);
  assert.equal(
    (
      await processor.processGraph({
        ...context,
        settings: resolveProcessSettings({}),
        tokenizer: new GptTokenizerTokenizer(),
      })
    ).result?.value,
    'disk dependency',
  );
  const member = prepareDesktopProjectBundle({
    ...f.native,
    selectedProjectPath: '/fixture/projects/child.rivet-project',
  });
  assert.equal(member.artifactId, 'child');
  assert.equal(member.snapshot.project.metadata.id, 'child');
  assert.throws(
    () => prepareDesktopProjectBundle({ ...f.native, selectedProjectPath: '/fixture/projects/other.rivet-project' }),
    /not listed/,
  );
});

test('desktop uses unsaved entry content and active datasets; each run isolates dependency data', async () => {
  const f = fixture();
  const bundle = prepareDesktopProjectBundle(f.native);
  const visible = structuredClone(f.root);
  const text = TextNodeImpl.create();
  text.data.text = 'unsaved';
  visible.graphs['main' as GraphId]!.nodes = [text, f.output];
  visible.graphs['main' as GraphId]!.connections = [
    { outputNodeId: text.id, outputId: 'output' as PortId, inputNodeId: f.output.id, inputId: 'value' as PortId },
  ];
  const active = new InMemoryDatasetProvider([]);
  const first = bundle.createRuntime(visible, active);
  assert.equal(first.datasetProvider, active);
  const processor = new GraphProcessor(first.project, 'main' as GraphId, globalRivetNodeRegistry);
  assert.equal(
    (
      await processor.processGraph({
        ...first,
        settings: resolveProcessSettings({}),
        tokenizer: new GptTokenizerTokenizer(),
      })
    ).result?.value,
    'unsaved',
  );
  const child = await first.subgraphProjectLoader.loadTarget({ projectId: 'child' as ProjectId, version: 'latest' });
  await child.datasetProvider!.deleteDataset('shared' as DatasetId);
  const second = await bundle
    .createRuntime(f.root)
    .subgraphProjectLoader.loadTarget({ projectId: 'child' as ProjectId, version: 'latest' });
  assert.equal((await second.datasetProvider!.getDatasetData('shared' as DatasetId))!.rows[0]!.data[0], 'child');
  assert.throws(
    () => bundle.createRuntime({ ...visible, metadata: { ...visible.metadata, id: 'foreign' as ProjectId } }),
    /identity/,
  );
});

test('opening permits repair but running rejects missing graphs, mappings or artifact identity', () => {
  const f = fixture();
  f.call.data.graphId = 'missing' as GraphId;
  f.native.files[0]!.contents = serializeProject(f.root) as string;
  const bundle = prepareDesktopProjectBundle(f.native);
  assert.throws(() => bundle.createRuntime(bundle.snapshot.project), /graph|boundary/);
  f.native.files.shift();
  assert.throws(() => prepareDesktopProjectBundle(f.native), /missing project/);
  const foreign = fixture();
  foreign.native.files[0]!.contents = serializeProject(foreign.child) as string;
  assert.throws(() => prepareDesktopProjectBundle(foreign.native), /identity/);
});

test('manifest workspace preserves each Evaluation sidecar and member opening selects only its own', () => {
  const f = fixture();
  for (const project of [f.root, f.child]) {
    const data = f.native.files.find((file) => file.path === `projects/${project.metadata.id}.rivet-data`)!;
    data.contents = JSON.stringify({
      ...JSON.parse(data.contents),
      evaluationDatasets: [
        {
          id: `${project.metadata.id}-evaluation`,
          projectId: project.metadata.id,
          name: 'Legacy',
          fields: [],
          cases: [],
        },
        { id: 'foreign', projectId: 'outside-bundle', name: 'Foreign', fields: [], cases: [] },
      ],
    });
  }
  const root = prepareDesktopProjectBundle(f.native);
  assert.deepEqual(
    root.evaluationDatasets.map((dataset) => dataset.id),
    ['root-evaluation'],
  );
  assert.equal(root.snapshot.datasets[0]!.data.rows[0]!.data[0], 'root');
  assert.equal(root.workspaceProjects!.length, 2);
  assert.deepEqual(
    root.workspaceProjects!.map((member) => member.evaluationDatasets.map((dataset) => dataset.id)),
    [['root-evaluation'], ['child-evaluation']],
  );
  const child = prepareDesktopProjectBundle({
    ...f.native,
    selectedProjectPath: '/fixture/projects/child.rivet-project',
  });
  assert.deepEqual(
    child.evaluationDatasets.map((dataset) => dataset.id),
    ['child-evaluation'],
  );
  assert.equal(child.snapshot.datasets[0]!.data.rows[0]!.data[0], 'child');
  assert.equal(child.workspaceProjects, undefined);
});

test('global version bindings run one selected snapshot without changing authored calls', async () => {
  const f = fixture();
  f.call.data.targetVersion = 'published';
  f.native.files[0]!.contents = serializeProject(f.root) as string;
  const manifest = JSON.parse(f.native.manifestContents);
  manifest.requiredLoaderVersion = 3;
  manifest.versionPolicy = 'latest';
  manifest.targets.push({ projectId: 'child', version: 'published', artifact: 'child' });
  f.native.manifestContents = JSON.stringify(manifest);
  const bundle = prepareDesktopProjectBundle(f.native);
  assert.equal(
    (bundle.snapshot.project.graphs['main' as GraphId]!.nodes.find((node) => node.type === 'subGraph')! as SubGraphNode)
      .data.targetVersion,
    'published',
  );
  const runtime = bundle.createRuntime(bundle.snapshot.project);
  assert.equal(
    (await runtime.subgraphProjectLoader.loadTarget({ projectId: 'child' as ProjectId, version: 'published' })).project
      .metadata.id,
    'child',
  );
  manifest.artifacts[1].version = 'published';
  assert.throws(
    () => prepareDesktopProjectBundle({ ...f.native, manifestContents: JSON.stringify(manifest) }),
    /latest version policy/,
  );
});

test('older mixed-version bundles require an individual member or re-export for workspace opening', () => {
  const f = fixture();
  const manifest = JSON.parse(f.native.manifestContents);
  manifest.artifacts.push({
    ...manifest.artifacts[1],
    id: 'published-child',
    version: 'published',
    project: { path: 'projects/published-child.rivet-project' },
    datasets: undefined,
  });
  f.native.files.push({
    ...f.native.files[2]!,
    path: 'projects/published-child.rivet-project',
    sourceProjectPath: '/fixture/projects/published-child.rivet-project',
  });
  f.native.manifestContents = JSON.stringify(manifest);
  assert.throws(() => prepareDesktopProjectBundle(f.native), /multiple versions/);
  assert.equal(
    prepareDesktopProjectBundle({ ...f.native, selectedProjectPath: '/fixture/projects/child.rivet-project' })
      .artifactId,
    'child',
  );
});
