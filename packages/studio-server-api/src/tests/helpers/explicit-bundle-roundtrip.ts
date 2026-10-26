// test-style: fixture-read: edits only files extracted from this test's generated archive in its own temporary directory.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  loadProjectBundle,
  loadProjectAndAttachedDataFromString,
  serializeProject,
  serializeDatasets,
  deserializeDatasets,
  createProcessor,
  type DatasetId,
  type ProjectId,
} from '@valerypopoff/rivet2-node';
import type { ManagedWorkflowBackend } from '../../routes/workflows/managed/backend.js';
import type { WorkflowFolderItem, WorkflowProjectItem } from '../../../../studio-server-shared/workflow-types.js';
import type {
  ProjectBundleImportResult,
  ProjectBundleJobStatus,
} from '../../../../studio-server-shared/project-bundle-types.js';
import { extractProjectBundleFixture } from './project-bundle-fixture.js';
import { prepareProjectBundleImport } from '../../routes/workflows/project-bundle-import.js';

/** Exercises the exact downloaded files and the public import API against the owning disposable PG/S3 stack. */
export async function verifyExplicitBundleRoundtrip(
  backend: ManagedWorkflowBackend,
  http: { baseUrl: string; headers: Record<string, string> },
  source: WorkflowFolderItem,
  root: WorkflowProjectItem,
  child: WorkflowProjectItem,
  unused: WorkflowProjectItem,
) {
  const admission = (expectedDestinationId: string | null) => ({
    operationId: randomUUID(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    expectedDestinationId,
  });
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-explicit-roundtrip-'));
  const external = await backend.createWorkflowProjectItem('', `External ${randomUUID()}`);
  const empty = await backend.createWorkflowFolderItem('Empty', source.relativePath);
  const originalRoot = await backend.loadHostedProject(root.absolutePath);
  const [definition, attached] = loadProjectAndAttachedDataFromString(originalRoot.contents);
  definition.references = [{ id: external.projectMetadataId! as ProjectId, hintPaths: [] }];
  await backend.saveHostedProject({
    projectPath: root.absolutePath,
    projectId: root.projectMetadataId,
    contents: serializeProject(definition, attached) as string,
    datasetsContents: originalRoot.datasetsContents,
    expectedRevisionId: originalRoot.revisionId,
    saveIntent: 'in-place',
  });
  const base = `${http.baseUrl}/api/workflows/project-bundles`;
  const headers = { ...http.headers, 'Content-Type': 'application/json', 'X-Rivet-Bundle-Intent': '1' };
  const request = async <T>(url: string, body?: unknown): Promise<T> => {
    const response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    assert.ok(response.ok, `HTTP ${response.status}: ${text}`);
    return JSON.parse(text) as T;
  };
  let job: ProjectBundleJobStatus | undefined;
  let imported: ProjectBundleImportResult | undefined;
  try {
    const emptyBundle = await backend.bundles.create(`Empty ${randomUUID()}`, '');
    try {
      await assert.rejects(backend.bundles.exportSnapshot(emptyBundle.bundleId!, 'latest'), /Add a project/);
    } finally {
      await backend.deleteWorkflowFolderItem(emptyBundle.relativePath);
    }
    job = await request<ProjectBundleJobStatus>(`${base}/container`, {
      bundleId: source.bundleId,
      version: 'latest',
      requestId: randomUUID(),
    });
    const deadline = Date.now() + 20_000;
    while (['collecting', 'packaging'].includes(job.phase) && Date.now() < deadline) {
      await delay(10);
      job = await request<ProjectBundleJobStatus>(`${base}/${job.id}`);
    }
    assert.equal(job.phase, 'ready', JSON.stringify(job));
    assert.equal(job.projects, 4, 'includes disconnected members and external snapshots');
    const response = await fetch(`${base}/${job.id}/download`, { headers, signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200);
    await extractProjectBundleFixture(Buffer.from(await response.arrayBuffer()), temporary);
    const bundle = await loadProjectBundle(path.join(temporary, 'rivet-bundle.json'));
    assert.equal(bundle.manifest.requiredLoaderVersion, 4);
    assert.deepEqual(new Set(bundle.manifest.workspace!.folders), new Set(['Empty', 'Nested']));
    assert.deepEqual(
      new Set(bundle.manifest.workspace!.members.map((m) => m.projectId)),
      new Set([root.projectMetadataId, child.projectMetadataId, unused.projectMetadataId]),
    );
    assert.equal(bundle.manifest.workspace!.name, source.name);
    const runner = bundle.createProcessor();
    try {
      assert.equal((await runner.run()).result?.value, 'latest-only');
    } finally {
      runner.dispose();
    }

    // Desktop saves the same editable project and declared .rivet-data sidecar; no manifest rewrite is needed.
    const childArtifact = bundle.manifest.artifacts.find((a) => a.projectId === child.projectMetadataId)!;
    const childFile = path.join(temporary, childArtifact.project.path);
    const [edited, data] = loadProjectAndAttachedDataFromString(await fs.readFile(childFile, 'utf8'));
    (Object.values(edited.graphs)[0]!.nodes.find((n) => n.type === 'text')!.data as { text: string }).text =
      'desktop-edited';
    await fs.writeFile(childFile, serializeProject(edited, data) as string);
    const unusedArtifact = bundle.manifest.artifacts.find((a) => a.projectId === unused.projectMetadataId)!;
    assert.ok(unusedArtifact.datasets, 'an empty sidecar supports adding the first dataset in Desktop');
    await fs.writeFile(
      path.join(temporary, unusedArtifact.datasets.path),
      serializeDatasets([
        {
          meta: {
            id: 'new-data' as DatasetId,
            projectId: unusedArtifact.projectId as ProjectId,
            name: 'New data',
            description: '',
          },
          data: { id: 'new-data' as DatasetId, rows: [{ id: 'row', data: ['desktop-added'] }] },
        },
      ]),
    );
    const paths = [
      'rivet-bundle.json',
      'README.txt',
      ...bundle.manifest.artifacts.flatMap((a) => [a.project.path, ...(a.datasets ? [a.datasets.path] : [])]),
    ];
    const files = await Promise.all(
      paths.map(async (file) => ({ path: file, contents: await fs.readFile(path.join(temporary, file), 'utf8') })),
    );
    // Legacy archives are still portable, but must not bypass the no-nesting rule.
    const { workspace: _workspace, ...legacyManifest } = bundle.manifest;
    legacyManifest.requiredLoaderVersion = 3;
    const legacyFiles = files.map((file) =>
      file.path === 'rivet-bundle.json' ? { ...file, contents: JSON.stringify(legacyManifest) } : file,
    );
    assert.equal(prepareProjectBundleImport(legacyFiles).folders, undefined);
    const beforeRejectedImports = await backend.getTree();
    const folders = [...beforeRejectedImports.folders];
    for (let index = 0; index < folders.length; index++) folders.push(...folders[index]!.folders);
    for (const upload of [files, legacyFiles]) {
      for (const destination of [source.relativePath, `${source.relativePath}/Nested`]) {
        const nested = await fetch(`${base}/import`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            folderRelativePath: destination,
            files: upload,
            mutation: admission(folders.find((folder) => folder.relativePath === destination)!.namespaceId!),
          }),
          signal: AbortSignal.timeout(10_000),
        });
        assert.equal(nested.status, 409, await nested.text());
      }
    }
    assert.deepEqual(await backend.getTree(), beforeRejectedImports, 'rejected uploads leave the catalog unchanged');
    imported = await request<ProjectBundleImportResult>(`${base}/import`, {
      folderRelativePath: '',
      files,
      mutation: admission(null),
    });
    assert.ok(imported.folder.bundleId);
    assert.notEqual(imported.folder.bundleId, source.bundleId);
    assert.ok(imported.dependenciesFolder);
    assert.ok(!imported.dependenciesFolder.bundleId, 'external snapshots remain outside bundle membership');
    assert.equal(imported.dependenciesFolder.projects.length, 1);
    assert.equal(imported.dependenciesFolder.projects[0]!.bundleId, null);
    assert.deepEqual(new Set(imported.folder.folders.map((f) => f.name)), new Set(['Empty', 'Nested']));
    assert.equal(imported.projects.length, 4);
    for (const project of imported.projects) {
      assert.ok(!bundle.manifest.artifacts.some((a) => a.projectId === project.projectMetadataId));
      assert.equal(project.settings.status, 'unpublished');
    }
    const importedUnused = imported.folder.projects.find((p) => p.name === unused.name)!;
    const newData = deserializeDatasets(
      (await backend.loadHostedProject(importedUnused.absolutePath)).datasetsContents!,
    );
    assert.equal(newData[0]!.meta.projectId, importedUnused.projectMetadataId);
    assert.deepEqual(newData[0]!.data.rows[0]!.data, ['desktop-added']);
    const importedRoot = imported.projects.find((p) => p.projectMetadataId === imported!.rootProjectId)!;
    const [newRoot] = loadProjectAndAttachedDataFromString(
      (await backend.loadHostedProject(importedRoot.absolutePath)).contents,
    );
    assert.equal(newRoot.references![0]!.id, imported.dependenciesFolder.projects[0]!.projectMetadataId);
    const processor = createProcessor(newRoot, {
      projectPath: importedRoot.absolutePath,
      projectReferenceLoader: backend.createProjectReferenceLoader(),
      subgraphProjectLoader: { loadTarget: (target) => backend.loadSubgraphTarget(target) },
    });
    try {
      assert.equal((await processor.run()).result?.value, 'desktop-edited');
    } finally {
      processor.dispose();
    }
    const [unchanged] = loadProjectAndAttachedDataFromString(
      (await backend.loadHostedProject(child.absolutePath)).contents,
    );
    assert.equal(
      (Object.values(unchanged.graphs)[0]!.nodes.find((n) => n.type === 'text')!.data as { text: string }).text,
      'latest-only',
    );
  } finally {
    if (job) await fetch(`${base}/${job.id}`, { method: 'DELETE', headers, signal: AbortSignal.timeout(10_000) });
    if (imported) {
      for (const project of imported.projects) await backend.deleteWorkflowProjectItem(project.relativePath);
      for (const folder of imported.folder.folders) await backend.deleteWorkflowFolderItem(folder.relativePath);
      await backend.deleteWorkflowFolderItem(imported.folder.relativePath);
      if (imported.dependenciesFolder) await backend.deleteWorkflowFolderItem(imported.dependenciesFolder.relativePath);
    }
    await backend.deleteWorkflowProjectItem(external.relativePath);
    await backend.deleteWorkflowFolderItem(empty.relativePath);
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
