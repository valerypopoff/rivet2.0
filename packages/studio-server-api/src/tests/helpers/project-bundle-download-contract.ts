// test-style: fixture-read: reads only archives created through an owned test API.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  GetDatasetRowNodeImpl,
  SubGraphNodeImpl,
  getGraphBoundary,
  loadProjectBundle,
  deserializeDatasets,
  serializeDatasets,
  serializeProject,
  type DatasetId,
  type GraphId,
  type PortId,
  type Project,
  type ProjectId,
} from '@valerypopoff/rivet2-node';
import type { WorkflowProjectItem } from '../../../../studio-server-shared/workflow-types.js';
import type { ProjectBundleJobStatus } from '../../../../studio-server-shared/project-bundle-types.js';
import { projectBundleFixture, extractProjectBundleFixture } from './project-bundle-fixture.js';

/** The same real HTTP/download/local-runtime contract for each owned storage setup. */
export async function verifyProjectBundleDownload(options: {
  workflowsBaseUrl: string;
  projectsBaseUrl: string;
  headers: Record<string, string>;
  verifyImport?: boolean;
}) {
  const admission = () => ({
    operationId: randomUUID(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    expectedDestinationId: null,
  });
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-bundle-backend-download-'));
  const request = async <T>(url: string, body?: unknown): Promise<T> => {
    const response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...options.headers, 'Content-Type': 'application/json', 'X-Rivet-Namespace-Intent': '1' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    assert.ok(response.ok, `HTTP ${response.status}: ${text}`);
    return JSON.parse(text) as T;
  };
  const save = async (item: WorkflowProjectItem, project: Project, datasetsContents: string) => {
    const current = await request<{ revisionId: string }>(`${options.projectsBaseUrl}/load`, {
      path: item.absolutePath,
    });
    await request(`${options.projectsBaseUrl}/save`, {
      path: item.absolutePath,
      contents: serializeProject(project),
      datasetsContents,
      projectId: project.metadata.id,
      expectedRevisionId: current.revisionId,
      saveIntent: 'in-place',
    });
  };
  const publish = async (item: WorkflowProjectItem, endpointName: string) => {
    const review = await request<{ projectId: string; publicationVersion: string; draftRevisionId: string }>(
      `${options.workflowsBaseUrl}/projects/web-apps?relativePath=${encodeURIComponent(item.relativePath)}`,
    );
    await request(`${options.workflowsBaseUrl}/projects/publish`, {
      relativePath: item.relativePath,
      settings: { endpointName },
      preconditions: {
        expectedProjectId: review.projectId,
        expectedPublicationVersion: review.publicationVersion,
        expectedDraftRevisionId: review.draftRevisionId,
      },
    });
  };
  const datasets = (projectId: ProjectId, value: string) =>
    serializeDatasets([
      {
        meta: { id: 'shared' as DatasetId, projectId, name: 'Shared', description: '' },
        data: { id: 'shared' as DatasetId, rows: [{ id: 'row', data: [value] }] },
      },
    ]);
  try {
    const fixture = projectBundleFixture();
    const childGraph = fixture.child.project.graphs[fixture.child.project.metadata.mainGraphId!]!;
    const row = GetDatasetRowNodeImpl.create();
    row.data.datasetId = 'shared' as DatasetId;
    row.data.rowId = 'row';
    childGraph.nodes = [row, childGraph.nodes.find((node) => node.type === 'graphOutput')!];
    childGraph.connections[0]!.outputNodeId = row.id;
    childGraph.connections[0]!.outputId = 'row' as PortId;
    const child = (
      await request<{ project: WorkflowProjectItem }>(`${options.workflowsBaseUrl}/projects/upload`, {
        folderRelativePath: '',
        fileName: 'Bundle child.rivet-project',
        mutation: admission(),
        contents: serializeProject(fixture.child.project),
      })
    ).project;
    fixture.child.project.metadata.id = child.projectMetadataId! as ProjectId;
    const childPublishedData = datasets(fixture.child.project.metadata.id, 'child-published');
    await save(child, fixture.child.project, childPublishedData);
    await publish(child, 'bundle-child');
    const childLatestData = datasets(fixture.child.project.metadata.id, 'child-latest');
    await save(child, fixture.child.project, childLatestData);

    const main = fixture.root.project.graphs[fixture.root.project.metadata.mainGraphId!]!;
    const call = main.nodes.find((node) => node.type === 'subGraph')! as ReturnType<typeof SubGraphNodeImpl.create>;
    call.data.targetProjectId = fixture.child.project.metadata.id;
    call.data.targetVersion = 'published';
    call.data.targetBoundary = getGraphBoundary(fixture.child.project, fixture.child.project.metadata.mainGraphId!)!;
    const other = structuredClone(main);
    other.metadata!.id = 'latest-helper' as GraphId;
    other.metadata!.name = 'Latest helper';
    (other.nodes.find((node) => node.type === 'subGraph')! as typeof call).data.targetVersion = 'latest';
    fixture.root.project.graphs[other.metadata!.id] = other;
    fixture.root.project.references = [
      { id: fixture.child.project.metadata.id, hintPaths: ['../stale.rivet-project'] },
    ];
    const root = (
      await request<{ project: WorkflowProjectItem }>(`${options.workflowsBaseUrl}/projects/upload`, {
        folderRelativePath: '',
        fileName: 'Bundle root.rivet-project',
        mutation: admission(),
        contents: serializeProject(fixture.root.project),
      })
    ).project;
    fixture.root.project.metadata.id = root.projectMetadataId! as ProjectId;
    fixture.root.project.metadata.description = 'root-published';
    const rootPublishedData = datasets(fixture.root.project.metadata.id, 'root-published');
    await save(root, fixture.root.project, rootPublishedData);
    await publish(root, 'bundle-root');
    fixture.root.project.metadata.description = 'root-latest';
    const rootLatestData = datasets(fixture.root.project.metadata.id, 'root-latest');
    await save(root, fixture.root.project, rootLatestData);

    for (const [version, versionPolicy] of [
      ['published', undefined],
      ['live', undefined],
      ['published', 'published'],
      ['live', 'latest'],
    ] as const) {
      const url = `${options.workflowsBaseUrl}/project-bundles`;
      const started = await request<ProjectBundleJobStatus>(url, {
        relativePath: root.relativePath,
        version,
        versionPolicy,
      });
      try {
        const deadline = Date.now() + 20_000;
        let status = await request<ProjectBundleJobStatus>(`${url}/${started.id}`);
        while (['collecting', 'packaging'].includes(status.phase) && Date.now() < deadline) {
          await delay(10);
          status = await request<ProjectBundleJobStatus>(`${url}/${started.id}`);
        }
        assert.equal(status.phase, 'ready', JSON.stringify(status));
        assert.equal(status.projects, versionPolicy ? 2 : 3, 'explicit policy selects one artifact per project');
        const full = await fetch(`${url}/${started.id}/download`, {
          headers: options.headers,
          signal: AbortSignal.timeout(10_000),
        });
        assert.equal(full.status, 200);
        const bytes = Buffer.from(await full.arrayBuffer());
        assert.equal(bytes.length, status.archiveBytes);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), status.archiveHash);
        const range = await fetch(`${url}/${started.id}/download`, {
          headers: { ...options.headers, Range: 'bytes=17-79', 'If-Range': full.headers.get('etag')! },
          signal: AbortSignal.timeout(10_000),
        });
        assert.equal(range.status, 206);
        assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(17, 80));
        assert.equal(
          (await fetch(`${url}/${started.id}/download`, { signal: AbortSignal.timeout(10_000) })).status,
          403,
        );
        const extracted = path.join(temporary, `${version}-${versionPolicy ?? 'legacy'}`);
        await extractProjectBundleFixture(bytes, extracted);
        const bundle = await loadProjectBundle(path.join(extracted, 'rivet-bundle.json'));
        assert.equal(bundle.manifest.versionPolicy, versionPolicy);
        assert.equal(bundle.manifest.requiredLoaderVersion, versionPolicy ? 3 : 2);
        assert.equal(bundle.root.description, version === 'published' ? 'root-published' : 'root-latest');
        for (const artifact of bundle.manifest.artifacts) {
          const expected =
            artifact.projectId === root.projectMetadataId
              ? version === 'published'
                ? rootPublishedData
                : rootLatestData
              : artifact.version === 'published'
                ? childPublishedData
                : childLatestData;
          assert.equal(await fs.readFile(path.join(extracted, artifact.datasets!.path), 'utf8'), expected);
        }
        const reference = bundle.manifest.references.find((entry) => entry.projectId === child.projectMetadataId)!;
        assert.equal(
          bundle.manifest.artifacts.find((artifact) => artifact.id === reference.artifact)!.version,
          versionPolicy ?? 'published',
          'legacy references bind to the captured published child',
        );
        for (const [graph, expected] of [
          [undefined, versionPolicy === 'latest' ? 'child-latest' : 'child-published'],
          ['latest-helper', versionPolicy === 'published' ? 'child-published' : 'child-latest'],
        ] as const) {
          const runner = bundle.createProcessor({ graph });
          try {
            assert.deepEqual((await runner.run()).result?.value, { id: 'row', data: [expected] });
          } finally {
            runner.dispose();
          }
        }
        if (options.verifyImport && versionPolicy === 'latest') {
          const files = [
            {
              path: 'rivet-bundle.json',
              contents: await fs.readFile(path.join(extracted, 'rivet-bundle.json'), 'utf8'),
            },
          ];
          for (const artifact of bundle.manifest.artifacts)
            for (const descriptor of [artifact.project, artifact.datasets])
              if (descriptor)
                files.push({
                  path: descriptor.path,
                  contents: await fs.readFile(path.join(extracted, descriptor.path), 'utf8'),
                });
          const importedResponse = await fetch(`${options.workflowsBaseUrl}/project-bundles/import`, {
            method: 'POST',
            headers: { ...options.headers, 'Content-Type': 'application/json', 'X-Rivet-Bundle-Intent': '1' },
            body: JSON.stringify({ folderRelativePath: '', files, mutation: admission() }),
            signal: AbortSignal.timeout(30_000),
          });
          assert.equal(importedResponse.status, 201, await importedResponse.clone().text());
          const imported = (await importedResponse.json()) as {
            folder: { relativePath: string };
            projects: WorkflowProjectItem[];
            rootProjectId: string;
          };
          assert.equal(imported.projects.length, bundle.manifest.artifacts.length);
          const importedRoot = imported.projects.find((p) => p.projectMetadataId === imported.rootProjectId)!;
          assert.ok(importedRoot);
          const childMember = imported.projects.find((p) => p.projectMetadataId !== imported.rootProjectId)!;
          const destination = await request<{ folder: { relativePath: string; namespaceId: string } }>(
            `${options.workflowsBaseUrl}/folders`,
            {
              name: `Moved bundle ${imported.rootProjectId.slice(0, 8)}`,
              parentRelativePath: '',
              mutation: admission(),
            },
          );
          const moved =
            childMember.namespaceProtocol === 1
              ? await request<{ project: WorkflowProjectItem }>(`${options.workflowsBaseUrl}/namespace/mutate`, {
                  ...admission(),
                  expectedDestinationId: destination.folder.namespaceId,
                  command: {
                    kind: 'move',
                    itemType: 'project',
                    relativePath: childMember.relativePath,
                    destinationRelativePath: destination.folder.relativePath,
                  },
                  expectedSource: { id: childMember.projectMetadataId, revisionId: childMember.revisionId },
                })
              : await request<{ project: WorkflowProjectItem }>(`${options.workflowsBaseUrl}/move`, {
                  itemType: 'project',
                  sourceRelativePath: childMember.relativePath,
                  destinationFolderRelativePath: destination.folder.relativePath,
                });
          assert.equal(moved.project.projectMetadataId, childMember.projectMetadataId);
          assert.equal(importedRoot.settings.status, 'unpublished');
          const endpoint = `imported-bundle-${imported.rootProjectId.slice(0, 8)}`;
          await publish(importedRoot, endpoint);
          const executed = await request<{ result: { value: unknown } }>(
            `${options.workflowsBaseUrl.replace('/api/workflows', '/internal/workflows-latest')}/${endpoint}`,
            {},
          );
          assert.deepEqual(executed.result.value, { id: 'row', data: ['child-latest'] });
          const saved = await request<{ contents: string; datasetsContents: string }>(
            `${options.projectsBaseUrl}/load`,
            { path: importedRoot.absolutePath },
          );
          assert.equal(deserializeDatasets(saved.datasetsContents)[0]!.meta.projectId, imported.rootProjectId);
          assert.deepEqual(
            deserializeDatasets(saved.datasetsContents)[0]!.data,
            deserializeDatasets(rootLatestData)[0]!.data,
          );
          // Execution persists asynchronously. Remove only this import's evidence,
          // leaving subsequent recording contracts with their original empty baseline.
          const recordingIds = new Set<string>();
          const recordingDeadline = Date.now() + 10_000;
          while (recordingIds.size < 2 && Date.now() < recordingDeadline) {
            for (const project of imported.projects) {
              const page = await request<{ runs: { id: string }[] }>(
                `${options.workflowsBaseUrl}/recordings/workflows/${project.projectMetadataId}/runs?includeSubgraphRuns=true&pageSize=100`,
              );
              for (const run of page.runs) recordingIds.add(run.id);
            }
            if (recordingIds.size < 2) await delay(10);
          }
          assert.equal(recordingIds.size, 2, 'root and called-project evidence persisted');
          for (const id of recordingIds) {
            const deleted = await fetch(`${options.workflowsBaseUrl}/recordings/${id}`, {
              method: 'DELETE',
              headers: options.headers,
            });
            assert.equal(deleted.status, 200, await deleted.text());
          }
        }
      } finally {
        const cancelled = await fetch(`${url}/${started.id}`, {
          method: 'DELETE',
          headers: { ...options.headers, 'X-Rivet-Bundle-Intent': '1' },
          signal: AbortSignal.timeout(10_000),
        });
        assert.equal(cancelled.status, 204);
      }
    }
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
