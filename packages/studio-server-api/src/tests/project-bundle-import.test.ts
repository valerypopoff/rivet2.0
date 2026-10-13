import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deserializeDatasets,
  loadProjectAndAttachedDataFromString,
  serializeProject,
  serializeDatasets,
  ReferencedGraphAliasNodeImpl,
  type ProjectId,
  type DatasetId,
  type SubGraphNode,
  type NodePrefabId,
  type ChartNode,
} from '@valerypopoff/rivet2-node';
import { prepareProjectBundleImport } from '../routes/workflows/project-bundle-import.js';
import { collectProjectBundle } from '../routes/workflows/project-bundle.js';
import { projectBundleFixture } from './helpers/project-bundle-fixture.js';

function variantData(node: ChartNode, index: number): Record<string, unknown> {
  const data = node.variants![index]!.data;
  assert.ok(data && typeof data === 'object' && !Array.isArray(data));
  return data as Record<string, unknown>;
}

async function filesFixture() {
  const fixture = projectBundleFixture();
  fixture.root.project.references = [
    { id: fixture.child.project.metadata.id, hintPaths: ['old/location.rivet-project'] },
  ];
  const subgraph = fixture.root.project.graphs[fixture.root.project.metadata.mainGraphId!]!.nodes.find(
    (n) => n.type === 'subGraph',
  )! as SubGraphNode;
  const prefabId = 'fixture-prefab' as NodePrefabId;
  fixture.root.project.nodePrefabs = { [prefabId]: { id: prefabId, sourceNode: structuredClone(subgraph) } };
  const alias = ReferencedGraphAliasNodeImpl.create();
  alias.data.projectId = fixture.child.project.metadata.id;
  alias.data.graphId = fixture.child.project.metadata.mainGraphId!;
  fixture.root.project.graphs[fixture.root.project.metadata.mainGraphId!]!.nodes.push(alias);
  fixture.root.projectContents = serializeProject(fixture.root.project, { fixture: { preserved: true } }) as string;
  fixture.root.datasetsContents = serializeDatasets([
    {
      meta: { id: 'dataset' as DatasetId, projectId: fixture.root.project.metadata.id, name: 'Rows', description: '' },
      data: { id: 'dataset' as DatasetId, rows: [{ id: 'row', data: ['hello'] }] },
    },
  ]);
  const files: { path: string; contents: string }[] = [];
  const result = await collectProjectBundle({
    source: { ...fixture.source, versionPolicy: 'latest' },
    rootVersion: 'latest',
    signal: new AbortController().signal,
    writeFile: async (path, contents) => {
      files.push({ path, contents });
    },
    progress: () => {},
  });
  return { files, fixture, manifest: result.manifest };
}

test('import remaps a coherent group, including prefabs and references, retaining wires, attachments and datasets', async () => {
  const { files, fixture } = await filesFixture();
  const imported = prepareProjectBundleImport(files);
  const root = imported.projects.find((p) => p.id === imported.rootProjectId)!;
  const child = imported.projects.find((p) => p.id !== root.id)!;
  const [project, attached] = loadProjectAndAttachedDataFromString(root.contents);
  assert.notEqual(project.metadata.id, fixture.root.project.metadata.id);
  assert.notEqual(child.id, fixture.child.project.metadata.id);
  assert.deepEqual(attached, { fixture: { preserved: true } });
  assert.equal(deserializeDatasets(root.datasetsContents!)[0]!.meta.projectId, root.id);
  assert.deepEqual(
    deserializeDatasets(root.datasetsContents!)[0]!.data,
    deserializeDatasets(fixture.root.datasetsContents!)[0]!.data,
  );
  assert.equal(project.references![0]!.id, child.id);
  assert.equal(project.references![0]!.hintPaths, undefined);
  const graph = project.graphs[project.metadata.mainGraphId!]!;
  const call = graph.nodes.find((n) => n.type === 'subGraph')! as SubGraphNode;
  assert.equal(call.data.targetProjectId, child.id);
  assert.equal(call.data.targetVersion, 'latest');
  assert.equal(
    (
      graph.nodes.find((n) => n.type === 'referencedGraphAlias')! as ReturnType<
        typeof ReferencedGraphAliasNodeImpl.create
      >
    ).data.projectId,
    child.id,
  );
  assert.equal((Object.values(project.nodePrefabs!)[0]!.sourceNode as SubGraphNode).data.targetProjectId, child.id);
  assert.deepEqual(graph.connections, fixture.root.project.graphs[project.metadata.mainGraphId!]!.connections);
  assert.notEqual(prepareProjectBundleImport(files).rootProjectId, imported.rootProjectId);
});

test('invalid paths, duplicate files, missing artifacts and malformed datasets fail before persistence', async () => {
  const { files, manifest } = await filesFixture();
  for (const path of ['../outside', '/absolute', 'C:/outside', 'a\\b', 'x/./y', 'x//y'])
    assert.throws(() => prepareProjectBundleImport([...files, { path, contents: '' }]), /unsafe/);
  assert.throws(
    () => prepareProjectBundleImport([...files, { ...files[0]!, path: files[0]!.path.toUpperCase() }]),
    /duplicate/,
  );
  assert.throws(
    () => prepareProjectBundleImport(files.filter((f) => f.path !== manifest.artifacts[0]!.project.path)),
    /missing/,
  );
  const dataset = manifest.artifacts.find((a) => a.datasets)!.datasets!.path;
  assert.throws(
    () => prepareProjectBundleImport(files.map((f) => (f.path === dataset ? { ...f, contents: '{bad' } : f))),
    /Invalid bundle/,
  );
  assert.throws(
    () => prepareProjectBundleImport([...files, { path: 'unexpected.txt', contents: 'not declared' }]),
    /undeclared/,
  );
});

test('inactive dependencies are preserved, and saved variants remap only imported identities', async () => {
  const { files, manifest, fixture } = await filesFixture();
  const rootFile = manifest.artifacts.find((a) => a.projectId === fixture.root.project.metadata.id)!.project.path;
  const changed = files.map((file) => {
    if (file.path !== rootFile) return file;
    const [project, attached] = loadProjectAndAttachedDataFromString(file.contents);
    const graph = project.graphs[project.metadata.mainGraphId!]!;
    const call = graph.nodes.find((n) => n.type === 'subGraph')! as SubGraphNode;
    call.variants = [
      { id: 'imported-target', data: { ...call.data, targetVersion: 'published' } },
      {
        id: 'uncaptured-target',
        data: { ...call.data, targetProjectId: 'outside' as ProjectId, targetVersion: 'published' },
      },
    ];
    const alias = graph.nodes.find((n) => n.type === 'referencedGraphAlias')! as ReturnType<
      typeof ReferencedGraphAliasNodeImpl.create
    >;
    alias.variants = [{ id: 'alias-variant', data: { ...alias.data } }];
    const disabled = structuredClone(call);
    disabled.id = 'disabled-call' as typeof call.id;
    disabled.disabled = true;
    disabled.data.targetProjectId = 'outside' as ProjectId;
    graph.nodes.push(disabled);
    const unused = Object.values(project.nodePrefabs!)[0]!.sourceNode as SubGraphNode;
    unused.data.targetProjectId = 'outside' as ProjectId;
    unused.variants = structuredClone(call.variants);
    return { ...file, contents: serializeProject(project, attached) as string };
  });
  const imported = prepareProjectBundleImport(changed);
  const childId = imported.projects.find((p) => p.id !== imported.rootProjectId)!.id;
  const [root] = loadProjectAndAttachedDataFromString(
    imported.projects.find((p) => p.id === imported.rootProjectId)!.contents,
  );
  const nodes = root.graphs[root.metadata.mainGraphId!]!.nodes;
  const call = nodes.find((n) => n.type === 'subGraph' && !n.disabled)! as SubGraphNode;
  assert.equal(variantData(call, 0).targetProjectId, childId);
  assert.equal(variantData(call, 0).targetVersion, 'latest');
  assert.equal(variantData(call, 1).targetProjectId, 'outside');
  assert.equal(variantData(call, 1).targetVersion, 'published');
  const alias = nodes.find((n) => n.type === 'referencedGraphAlias')! as ReturnType<
    typeof ReferencedGraphAliasNodeImpl.create
  >;
  assert.equal(variantData(alias, 0).projectId, childId);
  assert.equal((nodes.find((n) => n.disabled)! as SubGraphNode).data.targetProjectId, 'outside');
  const prefab = Object.values(root.nodePrefabs!)[0]!.sourceNode as SubGraphNode;
  assert.equal(prefab.data.targetProjectId, 'outside');
  assert.equal(variantData(prefab, 0).targetProjectId, childId);
  // The same absent target is still rejected if it becomes executable.
  const enabled = changed.map((file) => {
    if (file.path !== rootFile) return file;
    const [project, attached] = loadProjectAndAttachedDataFromString(file.contents);
    project.graphs[project.metadata.mainGraphId!]!.nodes.find((n) => n.disabled)!.disabled = false;
    return { ...file, contents: serializeProject(project, attached) as string };
  });
  assert.throws(() => prepareProjectBundleImport(enabled), /missing Subgraph/);
});

test('ambiguous dataset identities and malformed embeddings are rejected without changing valid rows', async () => {
  const { files, manifest } = await filesFixture();
  const datasetFile = manifest.artifacts.find((a) => a.datasets)!.datasets!.path;
  const original = deserializeDatasets(files.find((f) => f.path === datasetFile)!.contents);
  for (const kind of ['dataset', 'row', 'embedding'] as const) {
    const datasets = structuredClone(original);
    if (kind === 'dataset') datasets.push(structuredClone(datasets[0]!));
    if (kind === 'row') datasets[0]!.data.rows.push(structuredClone(datasets[0]!.data.rows[0]!));
    if (kind === 'embedding') datasets[0]!.data.rows[0]!.embedding = [Number.NaN];
    assert.throws(
      () =>
        prepareProjectBundleImport(
          files.map((f) => (f.path === datasetFile ? { ...f, contents: serializeDatasets(datasets) } : f)),
        ),
      /duplicate|embedding/,
    );
  }
  original[0]!.data.rows[0]!.embedding = [0.5, -0.25];
  const imported = prepareProjectBundleImport(
    files.map((f) => (f.path === datasetFile ? { ...f, contents: serializeDatasets(original) } : f)),
  );
  assert.deepEqual(
    deserializeDatasets(imported.projects.find((p) => p.id === imported.rootProjectId)!.datasetsContents!)[0]!.data
      .rows[0]!.embedding,
    [0.5, -0.25],
  );
});

test('unknown inactive variant payloads are preserved without inventing or remapping target IDs', async () => {
  const { files, manifest, fixture } = await filesFixture();
  const rootFile = manifest.artifacts.find((a) => a.projectId === fixture.root.project.metadata.id)!.project.path;
  const values = [null, 'unfinished', [], { targetProjectId: 42, targetVersion: 'published' }, { projectId: 42 }];
  const updated = files.map((file) => {
    if (file.path !== rootFile) return file;
    const [project, attached] = loadProjectAndAttachedDataFromString(file.contents);
    for (const node of project.graphs[project.metadata.mainGraphId!]!.nodes) {
      if (node.type === 'subGraph' || node.type === 'referencedGraphAlias')
        node.variants = values.map((data, index) => ({ id: `unfinished-${index}`, data: structuredClone(data) }));
    }
    return { ...file, contents: serializeProject(project, attached) as string };
  });
  const imported = prepareProjectBundleImport(updated);
  const rootFileContents = imported.projects.find((p) => p.id === imported.rootProjectId)!.contents;
  const [root] = loadProjectAndAttachedDataFromString(rootFileContents);
  for (const node of root.graphs[root.metadata.mainGraphId!]!.nodes)
    if (node.type === 'subGraph' || node.type === 'referencedGraphAlias')
      assert.deepEqual(
        node.variants!.map((variant) => variant.data),
        values,
      );
});

test('import rejects identity mismatches and does not silently pick a version from old mixed bundles', async () => {
  const { files, manifest } = await filesFixture();
  const changed = structuredClone(manifest);
  changed.requiredLoaderVersion = 1;
  delete changed.versionPolicy;
  changed.artifacts[1]!.projectId = changed.artifacts[0]!.projectId;
  changed.artifacts[1]!.version = 'published';
  changed.targets = changed.artifacts.map((a) => ({ projectId: a.projectId, version: a.version, artifact: a.id }));
  changed.references = [];
  assert.throws(
    () =>
      prepareProjectBundleImport(
        files.map((f) => (f.path === 'rivet-bundle.json' ? { ...f, contents: JSON.stringify(changed) } : f)),
      ),
    /multiple versions/,
  );
  const rootFile = manifest.artifacts[0]!.project.path;
  const invalid = files.map((f) => {
    if (f.path !== rootFile) return f;
    const [p, attached] = loadProjectAndAttachedDataFromString(f.contents);
    p.metadata.id = 'wrong' as ProjectId;
    return { ...f, contents: serializeProject(p, attached) as string };
  });
  assert.throws(() => prepareProjectBundleImport(invalid), /identity mismatch/);
});
