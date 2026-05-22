import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { readJson } from './helpers/workflow-api-harness.js';
import { createFilesystemWorkflowSuiteHarness } from './helpers/workflow-filesystem-suite-harness.js';

const {
  workflowsRoot,
  workflowMutations,
  workflowQuery,
  workflowFs,
  workflowDownload,
  workflowPublication,
  rivetNode,
  withWorkflowApiServer,
  resetAndEnsureWorkflowsRoot,
  cleanupWorkflowSuite,
} = await createFilesystemWorkflowSuiteHarness();

test.beforeEach(resetAndEnsureWorkflowsRoot);
test.after(cleanupWorkflowSuite);

test('workflow project rename and move preserve wrapper sidecars', async () => {
  await workflowMutations.createWorkflowFolderItem('Folder', '');
  const created = await workflowMutations.createWorkflowProjectItem('', 'Example');
  const sidecars = workflowFs.getProjectSidecarPaths(created.absolutePath);

  await fs.writeFile(sidecars.dataset, '{"rows":[]}', 'utf8');
  await fs.writeFile(sidecars.settings, '{"endpointName":""}', 'utf8');

  const renamed = await workflowMutations.renameWorkflowProjectItem(created.relativePath, 'Renamed');
  const renamedSidecars = workflowFs.getProjectSidecarPaths(renamed.project.absolutePath);

  assert.equal(await workflowFs.pathExists(renamedSidecars.dataset), true);
  assert.equal(await workflowFs.pathExists(renamedSidecars.settings), true);
  assert.deepEqual(renamed.movedProjectPaths, [
    {
      fromAbsolutePath: created.absolutePath,
      toAbsolutePath: renamed.project.absolutePath,
    },
  ]);

  const moved = await workflowQuery.moveWorkflowProject(workflowsRoot, renamed.project.relativePath, 'Folder');
  const movedSidecars = workflowFs.getProjectSidecarPaths(moved.project.absolutePath);

  assert.equal(await workflowFs.pathExists(movedSidecars.dataset), true);
  assert.equal(await workflowFs.pathExists(movedSidecars.settings), true);
});

test('workflow project rename rejects hidden names and does not expose hidden workflow paths', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'Visible');

  await assert.rejects(
    workflowMutations.renameWorkflowProjectItem(created.relativePath, '.hidden'),
    /must not start with a dot/,
  );

  await assert.rejects(
    workflowMutations.createWorkflowFolderItem('.hidden', ''),
    /must not start with a dot/,
  );

  await assert.rejects(
    workflowMutations.deleteWorkflowFolderItem('.published'),
    /Invalid relativePath/,
  );
});

test('workflow project rename refuses conflicting sidecar targets without moving the project', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'Source');
  const sourceSidecars = workflowFs.getProjectSidecarPaths(created.absolutePath);
  const conflictingTargetPath = path.join(workflowsRoot, 'Target.rivet-project');
  const conflictingTargetSidecars = workflowFs.getProjectSidecarPaths(conflictingTargetPath);

  await fs.writeFile(sourceSidecars.dataset, '{"rows":[]}', 'utf8');
  await fs.writeFile(conflictingTargetSidecars.dataset, '{"stale":true}', 'utf8');

  await assert.rejects(
    workflowMutations.renameWorkflowProjectItem(created.relativePath, 'Target'),
    /Dataset file already exists/,
  );

  assert.equal(await workflowFs.pathExists(created.absolutePath), true);
  assert.equal(await workflowFs.pathExists(sourceSidecars.dataset), true);
  assert.equal(await workflowFs.pathExists(conflictingTargetPath), false);
});

test('workflow project move refuses conflicting sidecar targets without moving the project', async () => {
  await workflowMutations.createWorkflowFolderItem('Destination', '');
  const created = await workflowMutations.createWorkflowProjectItem('', 'Source');
  const sourceSidecars = workflowFs.getProjectSidecarPaths(created.absolutePath);
  const conflictingTargetPath = path.join(workflowsRoot, 'Destination', 'Source.rivet-project');
  const conflictingTargetSidecars = workflowFs.getProjectSidecarPaths(conflictingTargetPath);

  await fs.writeFile(sourceSidecars.settings, '{"endpointName":"demo"}', 'utf8');
  await fs.writeFile(conflictingTargetSidecars.settings, '{"stale":true}', 'utf8');

  await assert.rejects(
    workflowQuery.moveWorkflowProject(workflowsRoot, created.relativePath, 'Destination'),
    /Settings file already exists/,
  );

  assert.equal(await workflowFs.pathExists(created.absolutePath), true);
  assert.equal(await workflowFs.pathExists(sourceSidecars.settings), true);
  assert.equal(await workflowFs.pathExists(conflictingTargetPath), false);
});

test('workflow folder rename handles case-only renames', async () => {
  const createdFolder = await workflowMutations.createWorkflowFolderItem('Folder', '');

  const renamedFolder = await workflowMutations.renameWorkflowFolderItem(createdFolder.relativePath, 'folder');

  assert.equal(renamedFolder.folder.name, 'folder');
  assert.equal(renamedFolder.folder.relativePath, 'folder');
  assert.deepEqual(renamedFolder.movedProjectPaths, []);
  assert.equal(await workflowFs.pathExists(path.join(workflowsRoot, 'folder')), true);
});

test('workflow folder rename reports moved project paths for nested projects', async () => {
  const createdFolder = await workflowMutations.createWorkflowFolderItem('Folder', '');
  const nestedFolder = await workflowMutations.createWorkflowFolderItem('Nested', createdFolder.relativePath);
  const rootProject = await workflowMutations.createWorkflowProjectItem(createdFolder.relativePath, 'Root Project');
  const nestedProject = await workflowMutations.createWorkflowProjectItem(nestedFolder.relativePath, 'Nested Project');

  const renamedFolder = await workflowMutations.renameWorkflowFolderItem(createdFolder.relativePath, 'Renamed Folder');

  assert.equal(renamedFolder.folder.relativePath, 'Renamed Folder');
  assert.deepEqual(renamedFolder.movedProjectPaths, [
    {
      fromAbsolutePath: rootProject.absolutePath,
      toAbsolutePath: path.join(workflowsRoot, 'Renamed Folder', 'Root Project.rivet-project'),
    },
    {
      fromAbsolutePath: nestedProject.absolutePath,
      toAbsolutePath: path.join(workflowsRoot, 'Renamed Folder', 'Nested', 'Nested Project.rivet-project'),
    },
  ]);
});

test('workflow project stats count serialized graph nodes', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'Stats');
  const projectContents = await fs.readFile(created.absolutePath, 'utf8');
  const withNode = projectContents.replace(
    '      nodes: {}',
    [
      '      nodes:',
      '        \'[node-1]:text "Node 1"\':',
      '          visualData: 0/0/null/null//',
      '          data:',
      '            text: hello',
    ].join('\n'),
  );

  await fs.writeFile(created.absolutePath, withNode, 'utf8');

  const project = await workflowQuery.getWorkflowProject(workflowsRoot, created.absolutePath);

  assert.equal(project.stats?.graphCount, 1);
  assert.equal(project.stats?.totalNodeCount, 1);
});

test('workflow tree route disables caching', async () => {
  await workflowMutations.createWorkflowProjectItem('', 'CacheHeaders');

  await withWorkflowApiServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/tree`);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store, no-cache, must-revalidate');
    assert.equal(response.headers.get('pragma'), 'no-cache');
  });
});

test('workflow project duplication creates an unpublished copy in the same folder', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'Example');

  const duplicate = await workflowMutations.duplicateWorkflowProjectItem(created.relativePath);

  assert.equal(duplicate.relativePath, 'Example [unpublished] Copy.rivet-project');
  assert.equal(duplicate.name, 'Example [unpublished] Copy');
  assert.equal(duplicate.settings.status, 'unpublished');
  assert.equal(duplicate.settings.endpointName, '');
  assert.equal(await workflowFs.pathExists(duplicate.absolutePath), true);
});

test('workflow project duplication assigns a fresh project id and matching title', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'Independent');

  const duplicate = await workflowMutations.duplicateWorkflowProjectItem(created.relativePath);
  const originalProject = await rivetNode.loadProjectFromFile(created.absolutePath);
  const duplicateProject = await rivetNode.loadProjectFromFile(duplicate.absolutePath);

  assert.notEqual(duplicateProject.metadata.id, originalProject.metadata.id);
  assert.equal(duplicateProject.metadata.title, 'Independent [unpublished] Copy');
});

test('workflow project duplication does not copy dataset or settings sidecars', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'Sidecars');
  const originalSidecars = workflowFs.getProjectSidecarPaths(created.absolutePath);

  await fs.writeFile(originalSidecars.dataset, '{"rows":[]}', 'utf8');
  await fs.writeFile(originalSidecars.settings, '{"endpointName":"published-demo"}', 'utf8');

  const duplicate = await workflowMutations.duplicateWorkflowProjectItem(created.relativePath);
  const duplicateSidecars = workflowFs.getProjectSidecarPaths(duplicate.absolutePath);

  assert.equal(await workflowFs.pathExists(originalSidecars.dataset), true);
  assert.equal(await workflowFs.pathExists(originalSidecars.settings), true);
  assert.equal(await workflowFs.pathExists(duplicateSidecars.dataset), false);
  assert.equal(await workflowFs.pathExists(duplicateSidecars.settings), false);
});

test('workflow project duplication resolves naming collisions with numbered copy suffixes', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'Collision');

  const firstDuplicate = await workflowMutations.duplicateWorkflowProjectItem(created.relativePath);
  const secondDuplicate = await workflowMutations.duplicateWorkflowProjectItem(created.relativePath);
  const thirdDuplicate = await workflowMutations.duplicateWorkflowProjectItem(created.relativePath);

  assert.equal(firstDuplicate.relativePath, 'Collision [unpublished] Copy.rivet-project');
  assert.equal(secondDuplicate.relativePath, 'Collision [unpublished] Copy 1.rivet-project');
  assert.equal(thirdDuplicate.relativePath, 'Collision [unpublished] Copy 2.rivet-project');
});

test('workflow project duplication stays literal when duplicating a duplicate', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'Literal');
  const duplicate = await workflowMutations.duplicateWorkflowProjectItem(created.relativePath);

  const duplicateOfDuplicate = await workflowMutations.duplicateWorkflowProjectItem(duplicate.relativePath);

  assert.equal(duplicate.relativePath, 'Literal [unpublished] Copy.rivet-project');
  assert.equal(duplicateOfDuplicate.relativePath, 'Literal [unpublished] Copy [unpublished] Copy.rivet-project');
});

test('workflow project duplication preserves literal user-authored names that already end with a copy-style suffix', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'LiteralSuffix');
  const renamed = await workflowMutations.renameWorkflowProjectItem(created.relativePath, 'LiteralSuffix [unpublished] Copy');

  const duplicate = await workflowMutations.duplicateWorkflowProjectItem(renamed.project.relativePath);

  assert.equal(
    duplicate.relativePath,
    'LiteralSuffix [unpublished] Copy [unpublished] Copy.rivet-project',
  );
});

test('workflow project duplication keeps published source state detached from the copy', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'PublishedSource');

  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'published-source-endpoint',
  });

  const duplicate = await workflowMutations.duplicateWorkflowProjectItem(created.relativePath);
  const duplicateSidecars = workflowFs.getProjectSidecarPaths(duplicate.absolutePath);

  assert.equal(duplicate.relativePath, 'PublishedSource [published] Copy.rivet-project');
  assert.equal(duplicate.settings.status, 'unpublished');
  assert.equal(duplicate.settings.endpointName, '');
  assert.equal(await workflowFs.pathExists(duplicateSidecars.settings), false);
  assert.equal(await workflowFs.pathExists(duplicateSidecars.dataset), false);
});

test('workflow project duplication can use the published snapshot when unpublished changes exist', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'PublishedVariant');

  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'published-variant-endpoint',
  });

  const liveContents = await fs.readFile(created.absolutePath, 'utf8');
  await fs.writeFile(
    created.absolutePath,
    liveContents.replace('        description: ""', '        description: "Live only"'),
    'utf8',
  );

  const publishedDuplicate = await workflowMutations.duplicateWorkflowProjectItem(created.relativePath, 'published');
  const liveDuplicate = await workflowMutations.duplicateWorkflowProjectItem(created.relativePath, 'live');
  const publishedDuplicateProject = await rivetNode.loadProjectFromFile(publishedDuplicate.absolutePath);
  const liveDuplicateProject = await rivetNode.loadProjectFromFile(liveDuplicate.absolutePath);
  const publishedGraph = Object.values(publishedDuplicateProject.graphs)[0];
  const liveGraph = Object.values(liveDuplicateProject.graphs)[0];

  assert.equal(publishedDuplicate.relativePath, 'PublishedVariant [published] Copy.rivet-project');
  assert.equal(liveDuplicate.relativePath, 'PublishedVariant [unpublished changes] Copy.rivet-project');
  assert.equal(publishedGraph?.metadata?.description ?? '', '');
  assert.equal(liveGraph?.metadata?.description ?? '', 'Live only');
});

test('workflow project upload imports a project into the selected folder with a fresh id', async () => {
  await workflowMutations.createWorkflowFolderItem('Uploads', '');
  const created = await workflowMutations.createWorkflowProjectItem('', 'Imported');
  const uploadedContents = await fs.readFile(created.absolutePath, 'utf8');
  const originalProject = rivetNode.loadProjectFromString(uploadedContents);

  const uploaded = await workflowMutations.uploadWorkflowProjectItem(
    'Uploads',
    'Imported.rivet-project',
    uploadedContents,
  );
  const uploadedProject = await rivetNode.loadProjectFromFile(uploaded.absolutePath);

  assert.equal(uploaded.relativePath, 'Uploads/Imported.rivet-project');
  assert.equal(uploaded.name, 'Imported');
  assert.equal(uploaded.settings.status, 'unpublished');
  assert.equal(uploaded.settings.endpointName, '');
  assert.notEqual(uploadedProject.metadata.id, originalProject.metadata.id);
  assert.equal(uploadedProject.metadata.title, 'Imported');
});

test('workflow project upload resolves naming collisions with numbered suffixes', async () => {
  await workflowMutations.createWorkflowFolderItem('Uploads', '');
  const created = await workflowMutations.createWorkflowProjectItem('', 'CollisionUpload');
  const uploadedContents = await fs.readFile(created.absolutePath, 'utf8');

  const firstUpload = await workflowMutations.uploadWorkflowProjectItem(
    'Uploads',
    'CollisionUpload.rivet-project',
    uploadedContents,
  );
  const secondUpload = await workflowMutations.uploadWorkflowProjectItem(
    'Uploads',
    'CollisionUpload.rivet-project',
    uploadedContents,
  );
  const secondUploadedProject = await rivetNode.loadProjectFromFile(secondUpload.absolutePath);

  assert.equal(firstUpload.relativePath, 'Uploads/CollisionUpload.rivet-project');
  assert.equal(secondUpload.relativePath, 'Uploads/CollisionUpload 1.rivet-project');
  assert.equal(secondUploadedProject.metadata.title, 'CollisionUpload 1');
});

test('workflow project upload keeps published source state detached from the imported copy', async () => {
  await workflowMutations.createWorkflowFolderItem('Uploads', '');
  const created = await workflowMutations.createWorkflowProjectItem('', 'UploadedPublishedSource');
  const originalSidecars = workflowFs.getProjectSidecarPaths(created.absolutePath);

  await fs.writeFile(originalSidecars.dataset, '{"rows":[]}', 'utf8');
  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'uploaded-published-source-endpoint',
  });

  const uploaded = await workflowMutations.uploadWorkflowProjectItem(
    'Uploads',
    'UploadedPublishedSource.rivet-project',
    await fs.readFile(created.absolutePath, 'utf8'),
  );
  const uploadedSidecars = workflowFs.getProjectSidecarPaths(uploaded.absolutePath);

  assert.equal(uploaded.settings.status, 'unpublished');
  assert.equal(uploaded.settings.endpointName, '');
  assert.equal(await workflowFs.pathExists(uploadedSidecars.dataset), false);
  assert.equal(await workflowFs.pathExists(uploadedSidecars.settings), false);
});

test('workflow project upload rejects invalid project files', async () => {
  await workflowMutations.createWorkflowFolderItem('Uploads', '');

  await assert.rejects(
    workflowMutations.uploadWorkflowProjectItem('Uploads', 'Broken.rivet-project', 'not: valid: yaml: ['),
    /Could not upload project: invalid project file/,
  );
});

test('workflow project download reads the live unpublished file with an unpublished tag', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'DownloadUnpublished');
  const liveContents = await fs.readFile(created.absolutePath, 'utf8');

  const download = await workflowDownload.readWorkflowProjectDownload(created.relativePath, 'live');

  assert.equal(download.contents, liveContents);
  assert.equal(download.fileName, 'DownloadUnpublished [unpublished].rivet-project');
});

test('workflow project download reads the published snapshot with a published tag', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'DownloadPublished');
  const originalLiveContents = await fs.readFile(created.absolutePath, 'utf8');

  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'download-published-endpoint',
  });

  const download = await workflowDownload.readWorkflowProjectDownload(created.relativePath, 'published');

  assert.equal(download.contents, originalLiveContents);
  assert.equal(download.fileName, 'DownloadPublished [published].rivet-project');
});

test('workflow project download distinguishes live unpublished changes from the published version', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'DownloadChanged');
  const originalLiveContents = await fs.readFile(created.absolutePath, 'utf8');

  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'download-changed-endpoint',
  });

  const changedLiveContents = originalLiveContents.replace('title: "DownloadChanged"', 'title: "DownloadChanged Live"');
  await fs.writeFile(created.absolutePath, changedLiveContents, 'utf8');

  const liveDownload = await workflowDownload.readWorkflowProjectDownload(created.relativePath, 'live');
  const publishedDownload = await workflowDownload.readWorkflowProjectDownload(created.relativePath, 'published');

  assert.equal(liveDownload.contents, changedLiveContents);
  assert.equal(liveDownload.fileName, 'DownloadChanged [unpublished changes].rivet-project');
  assert.equal(publishedDownload.contents, originalLiveContents);
  assert.equal(publishedDownload.fileName, 'DownloadChanged [published].rivet-project');
});

test('workflow project download rejects published downloads for unpublished projects', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'NoPublishedDownload');

  await assert.rejects(
    workflowDownload.readWorkflowProjectDownload(created.relativePath, 'published'),
    /Published version is not available for this project/,
  );
});

test('workflow project download returns not found for missing projects', async () => {
  await assert.rejects(
    workflowDownload.readWorkflowProjectDownload('Missing.rivet-project', 'live'),
    /Project not found/,
  );
});

test('workflow routes support folder/project create, move, rename, and delete flows over HTTP', async () => {
  await withWorkflowApiServer(async (baseUrl) => {
    const createdFolder = await readJson<{ folder: { relativePath: string } }>(await fetch(`${baseUrl}/folders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Folder' }),
    }));

    const createdProject = await readJson<{ project: { relativePath: string; absolutePath: string } }>(await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderRelativePath: createdFolder.folder.relativePath, name: 'Example' }),
    }));

    const movedProject = await readJson<{ project: { relativePath: string }; movedProjectPaths: Array<{ fromAbsolutePath: string; toAbsolutePath: string }> }>(
      await fetch(`${baseUrl}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          itemType: 'project',
          sourceRelativePath: createdProject.project.relativePath,
          destinationFolderRelativePath: '',
        }),
      }),
    );

    assert.equal(movedProject.project.relativePath, 'Example.rivet-project');
    assert.equal(movedProject.movedProjectPaths.length, 1);

    const renamedProject = await readJson<{ project: { relativePath: string } }>(await fetch(`${baseUrl}/projects`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        relativePath: movedProject.project.relativePath,
        newName: 'Renamed',
      }),
    }));

    assert.equal(renamedProject.project.relativePath, 'Renamed.rivet-project');

    const tree = await readJson<{ folders: Array<{ relativePath: string }>; projects: Array<{ relativePath: string }> }>(
      await fetch(`${baseUrl}/tree`),
    );

    assert.deepEqual(tree.folders.map((folder) => folder.relativePath), ['Folder']);
    assert.deepEqual(tree.projects.map((project) => project.relativePath), ['Renamed.rivet-project']);

    const deleteProjectResponse = await readJson<{ deleted: true; projectId: string | null }>(await fetch(`${baseUrl}/projects`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relativePath: 'Renamed.rivet-project' }),
    }));
    assert.equal(deleteProjectResponse.deleted, true);
    assert.equal(typeof deleteProjectResponse.projectId, 'string');

    const deleteFolderResponse = await readJson<{ deleted: true }>(await fetch(`${baseUrl}/folders`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relativePath: createdFolder.folder.relativePath }),
    }));
    assert.equal(deleteFolderResponse.deleted, true);
  });
});

test('workflow folder rename route reports moved project paths over HTTP', async () => {
  await withWorkflowApiServer(async (baseUrl) => {
    const createdFolder = await readJson<{ folder: { relativePath: string } }>(await fetch(`${baseUrl}/folders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Folder' }),
    }));

    const createdProject = await readJson<{ project: { absolutePath: string } }>(await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderRelativePath: createdFolder.folder.relativePath, name: 'Example' }),
    }));

    const renamedFolder = await readJson<{
      folder: { relativePath: string };
      movedProjectPaths: Array<{ fromAbsolutePath: string; toAbsolutePath: string }>;
    }>(await fetch(`${baseUrl}/folders`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        relativePath: createdFolder.folder.relativePath,
        newName: 'Renamed Folder',
      }),
    }));

    assert.equal(renamedFolder.folder.relativePath, 'Renamed Folder');
    assert.deepEqual(renamedFolder.movedProjectPaths, [
      {
        fromAbsolutePath: createdProject.project.absolutePath,
        toAbsolutePath: path.join(workflowsRoot, 'Renamed Folder', 'Example.rivet-project'),
      },
    ]);
  });
});

test('workflow duplicate route creates a duplicate and exposes it through the tree', async () => {
  await withWorkflowApiServer(async (baseUrl) => {
    const createdProject = await readJson<{ project: { relativePath: string } }>(await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'HttpDuplicate' }),
    }));

    const duplicated = await readJson<{ project: { relativePath: string; settings: { status: string; endpointName: string } } }>(
      await fetch(`${baseUrl}/projects/duplicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relativePath: createdProject.project.relativePath }),
      }),
    );

    assert.equal(duplicated.project.relativePath, 'HttpDuplicate [unpublished] Copy.rivet-project');
    assert.equal(duplicated.project.settings.status, 'unpublished');
    assert.equal(duplicated.project.settings.endpointName, '');

    const tree = await readJson<{ projects: Array<{ relativePath: string }> }>(await fetch(`${baseUrl}/tree`));
    assert.deepEqual(
      tree.projects.map((project) => project.relativePath),
      ['HttpDuplicate [unpublished] Copy.rivet-project', 'HttpDuplicate.rivet-project'],
    );
  });
});

test('workflow duplicate route can duplicate the published snapshot for projects with unpublished changes', async () => {
  await withWorkflowApiServer(async (baseUrl) => {
    const createdProject = await readJson<{ project: { relativePath: string; absolutePath: string } }>(await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'HttpDuplicatePublished' }),
    }));

    await readJson<{ project: { settings: { status: string } } }>(await fetch(`${baseUrl}/projects/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        relativePath: createdProject.project.relativePath,
        settings: { endpointName: 'http-duplicate-published-endpoint' },
      }),
    }));

    const liveContents = await fs.readFile(createdProject.project.absolutePath, 'utf8');
    await fs.writeFile(
      createdProject.project.absolutePath,
      liveContents.replace('        description: ""', '        description: "Changed after publish"'),
      'utf8',
    );

    const duplicated = await readJson<{ project: { absolutePath: string; relativePath: string } }>(
      await fetch(`${baseUrl}/projects/duplicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relativePath: createdProject.project.relativePath, version: 'published' }),
      }),
    );
    const duplicatedProject = await rivetNode.loadProjectFromFile(duplicated.project.absolutePath);
    const duplicatedGraph = Object.values(duplicatedProject.graphs)[0];

    assert.equal(duplicated.project.relativePath, 'HttpDuplicatePublished [published] Copy.rivet-project');
    assert.equal(duplicatedGraph?.metadata?.description ?? '', '');
  });
});

test('workflow duplicate route returns a controlled 400 for invalid project files', async () => {
  await withWorkflowApiServer(async (baseUrl) => {
    const createdProject = await readJson<{ project: { relativePath: string; absolutePath: string } }>(await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'BrokenDuplicate' }),
    }));

    await fs.writeFile(createdProject.project.absolutePath, 'not: valid: yaml: [', 'utf8');

    const response = await fetch(`${baseUrl}/projects/duplicate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relativePath: createdProject.project.relativePath }),
    });

    const body = await response.json() as { error?: string };

    assert.equal(response.status, 400);
    assert.equal(body.error, 'Could not duplicate project: invalid project file');
  });
});

test('workflow duplicate route rejects published duplication when no published version exists', async () => {
  await withWorkflowApiServer(async (baseUrl) => {
    const createdProject = await readJson<{ project: { relativePath: string } }>(await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'NoPublishedDuplicate' }),
    }));

    const response = await fetch(`${baseUrl}/projects/duplicate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relativePath: createdProject.project.relativePath, version: 'published' }),
    });
    const body = await response.json() as { error?: string };

    assert.equal(response.status, 409);
    assert.equal(body.error, 'Published version is not available for this project');
  });
});

test('workflow upload route imports projects into folders and numbers collisions', async () => {
  await withWorkflowApiServer(async (baseUrl) => {
    const createdFolder = await readJson<{ folder: { relativePath: string } }>(await fetch(`${baseUrl}/folders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Uploads' }),
    }));
    const sourceProject = await workflowMutations.createWorkflowProjectItem('', 'HttpUpload');
    const sourceContents = await fs.readFile(sourceProject.absolutePath, 'utf8');

    const firstUpload = await readJson<{ project: { relativePath: string; settings: { status: string; endpointName: string } } }>(
      await fetch(`${baseUrl}/projects/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          folderRelativePath: createdFolder.folder.relativePath,
          fileName: 'HttpUpload.rivet-project',
          contents: sourceContents,
        }),
      }),
    );
    const secondUpload = await readJson<{ project: { relativePath: string } }>(
      await fetch(`${baseUrl}/projects/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          folderRelativePath: createdFolder.folder.relativePath,
          fileName: 'HttpUpload.rivet-project',
          contents: sourceContents,
        }),
      }),
    );

    assert.equal(firstUpload.project.relativePath, 'Uploads/HttpUpload.rivet-project');
    assert.equal(firstUpload.project.settings.status, 'unpublished');
    assert.equal(firstUpload.project.settings.endpointName, '');
    assert.equal(secondUpload.project.relativePath, 'Uploads/HttpUpload 1.rivet-project');

    const tree = await readJson<{ folders: Array<{ relativePath: string; projects: Array<{ relativePath: string }> }> }>(
      await fetch(`${baseUrl}/tree`),
    );
    const uploadsFolder = tree.folders.find((folder) => folder.relativePath === 'Uploads');

    assert.deepEqual(
      uploadsFolder?.projects.map((project) => project.relativePath),
      ['Uploads/HttpUpload 1.rivet-project', 'Uploads/HttpUpload.rivet-project'],
    );
  });
});

test('workflow upload route validates request shape and missing folders cleanly', async () => {
  await withWorkflowApiServer(async (baseUrl) => {
    const invalidResponse = await fetch(`${baseUrl}/projects/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderRelativePath: '', fileName: 'Broken.txt', contents: 'hello' }),
    });
    const invalidBody = await invalidResponse.json() as { error?: string };

    assert.equal(invalidResponse.status, 400);
    assert.equal(invalidBody.error, 'Expected .rivet-project file');

    const missingFolderResponse = await fetch(`${baseUrl}/projects/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        folderRelativePath: 'MissingFolder',
        fileName: 'Uploaded.rivet-project',
        contents: await fs.readFile((await workflowMutations.createWorkflowProjectItem('', 'UploadedSource')).absolutePath, 'utf8'),
      }),
    });
    const missingFolderBody = await missingFolderResponse.json() as { error?: string };

    assert.equal(missingFolderResponse.status, 404);
    assert.equal(missingFolderBody.error, 'Folder not found');
  });
});

test('workflow download route streams unpublished projects with attachment headers', async () => {
  await withWorkflowApiServer(async (baseUrl) => {
    const createdProject = await readJson<{ project: { relativePath: string; absolutePath: string } }>(await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'HttpDownloadUnpublished' }),
    }));
    const expectedContents = await fs.readFile(createdProject.project.absolutePath, 'utf8');

    const response = await fetch(`${baseUrl}/projects/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relativePath: createdProject.project.relativePath, version: 'live' }),
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /application\/x-yaml/);
    assert.match(
      response.headers.get('content-disposition') ?? '',
      /filename="HttpDownloadUnpublished \[unpublished\]\.rivet-project"/,
    );
    assert.equal(await response.text(), expectedContents);
  });
});

test('workflow download route streams published and unpublished-changes variants separately', async () => {
  await withWorkflowApiServer(async (baseUrl) => {
    const createdProject = await readJson<{ project: { relativePath: string; absolutePath: string } }>(await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'HttpDownloadChanged' }),
    }));
    const originalContents = await fs.readFile(createdProject.project.absolutePath, 'utf8');

    await readJson<{ project: { settings: { status: string } } }>(await fetch(`${baseUrl}/projects/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        relativePath: createdProject.project.relativePath,
        settings: { endpointName: 'http-download-changed-endpoint' },
      }),
    }));

    const changedContents = originalContents.replace('title: "HttpDownloadChanged"', 'title: "HttpDownloadChanged Live"');
    await fs.writeFile(createdProject.project.absolutePath, changedContents, 'utf8');

    const publishedResponse = await fetch(`${baseUrl}/projects/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relativePath: createdProject.project.relativePath, version: 'published' }),
    });
    const liveResponse = await fetch(`${baseUrl}/projects/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relativePath: createdProject.project.relativePath, version: 'live' }),
    });

    assert.equal(publishedResponse.status, 200);
    assert.equal(liveResponse.status, 200);
    assert.match(
      publishedResponse.headers.get('content-disposition') ?? '',
      /filename="HttpDownloadChanged \[published\]\.rivet-project"/,
    );
    assert.match(
      liveResponse.headers.get('content-disposition') ?? '',
      /filename="HttpDownloadChanged \[unpublished changes\]\.rivet-project"/,
    );
    assert.equal(await publishedResponse.text(), originalContents);
    assert.equal(await liveResponse.text(), changedContents);
  });
});

test('workflow download route validates request shape and reports missing or unpublished sources cleanly', async () => {
  await withWorkflowApiServer(async (baseUrl) => {
    const invalidResponse = await fetch(`${baseUrl}/projects/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relativePath: 'Anything.rivet-project', version: 'invalid' }),
    });
    const invalidBody = await invalidResponse.json() as { error?: string };

    assert.equal(invalidResponse.status, 400);
    assert.ok(invalidBody.error);

    const missingResponse = await fetch(`${baseUrl}/projects/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relativePath: 'Missing.rivet-project', version: 'live' }),
    });
    const missingBody = await missingResponse.json() as { error?: string };

    assert.equal(missingResponse.status, 404);
    assert.equal(missingBody.error, 'Project not found');

    const createdProject = await readJson<{ project: { relativePath: string } }>(await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'HttpDownloadUnavailable' }),
    }));

    const unavailableResponse = await fetch(`${baseUrl}/projects/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relativePath: createdProject.project.relativePath, version: 'published' }),
    });
    const unavailableBody = await unavailableResponse.json() as { error?: string };

    assert.equal(unavailableResponse.status, 409);
    assert.equal(unavailableBody.error, 'Published version is not available for this project');
  });
});

test('delete workflow project removes project and sidecars', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'DeleteMe');
  const sidecars = workflowFs.getProjectSidecarPaths(created.absolutePath);
  await fs.writeFile(sidecars.dataset, '{}', 'utf8');
  await fs.writeFile(sidecars.settings, '{}', 'utf8');

  const deletedProjectId = await workflowMutations.deleteWorkflowProjectItem(created.relativePath);

  assert.equal(typeof deletedProjectId, 'string');
  assert.equal(await workflowFs.pathExists(created.absolutePath), false);
  assert.equal(await workflowFs.pathExists(sidecars.dataset), false);
  assert.equal(await workflowFs.pathExists(sidecars.settings), false);
});

test('delete workflow project removes published snapshots', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'DeletePublished');
  const published = await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'delete-published',
  });
  const storedSettings = await workflowPublication.readStoredWorkflowProjectSettings(published.absolutePath, published.name);
  const publishedSnapshotPath = workflowFs.getPublishedWorkflowSnapshotPath(workflowsRoot, storedSettings.publishedSnapshotId!);

  assert.equal(await workflowFs.pathExists(publishedSnapshotPath), true);

  await workflowMutations.deleteWorkflowProjectItem(created.relativePath);

  assert.equal(await workflowFs.pathExists(publishedSnapshotPath), false);
});
