import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readJson } from './helpers/workflow-api-harness.js';
import { createFilesystemWorkflowSuiteHarness } from './helpers/workflow-filesystem-suite-harness.js';
import { saveFilesystemPublicationTransaction, setFilesystemPublicationTransactionCheckpointForTests } from '../routes/workflows/filesystem-publication-transactions.js';
import { normalizeWebAppAccessDrafts, normalizeWebAppPublicationDrafts } from '../routes/workflows/web-app-publication-drafts.js';

const {
  workflowsRoot,
  workflowMutations,
  workflowQuery,
  workflowFs,
  workflowPublication,
  workflowStorageBackend,
  rivetNode,
  withWorkflowApiServer,
  withWorkflowExecutionServer,
  resetAndEnsureWorkflowsRoot,
  cleanupWorkflowSuite,
} = await createFilesystemWorkflowSuiteHarness();
type StoredWorkflowProjectSettings = Awaited<ReturnType<typeof workflowPublication.readStoredWorkflowProjectSettings>>;

test.beforeEach(resetAndEnsureWorkflowsRoot);
test.after(cleanupWorkflowSuite);

test('web-app publication and access drafts share strict slug, identity, and email policy', () => {
  assert.deepEqual(normalizeWebAppPublicationDrafts([
    { uiGraphId: ' graph ', slug: ' Example ', allowedEmails: [' OWNER@EXAMPLE.COM ', 'owner@example.com'] },
  ]), [{ uiGraphId: 'graph', slug: 'Example', allowedEmails: ['owner@example.com'] }]);
  assert.deepEqual(normalizeWebAppPublicationDrafts([{ uiGraphId: 'graph', slug: 'Example' }]), [
    { uiGraphId: 'graph', slug: 'Example', allowedEmails: undefined },
  ]);
  assert.throws(() => normalizeWebAppPublicationDrafts([
    { uiGraphId: 'one', slug: 'Example' }, { uiGraphId: 'two', slug: 'example' },
  ]), /unique/);
  assert.throws(() => normalizeWebAppPublicationDrafts([{ uiGraphId: 'one', slug: 'AUTH' }]), /reserved/);
  assert.throws(() => normalizeWebAppPublicationDrafts([{ uiGraphId: 'one', slug: 'one', allowedEmails: ['invalid'] }]), /Invalid allowed email/);
  assert.deepEqual(normalizeWebAppAccessDrafts([{ uiGraphId: ' graph ', allowedEmails: 'OWNER@EXAMPLE.COM' }]), [
    { uiGraphId: 'graph', allowedEmails: ['owner@example.com'] },
  ]);
  assert.throws(() => normalizeWebAppAccessDrafts([
    { uiGraphId: 'one', allowedEmails: [] }, { uiGraphId: 'one', allowedEmails: [] },
  ]), /only be updated once/);
});

async function writeBlankProject(projectName: string): Promise<string> {
  const projectPath = path.join(workflowsRoot, `${projectName}.rivet-project`);
  await fs.writeFile(projectPath, workflowFs.createBlankProjectFile(projectName), 'utf8');
  return projectPath;
}

async function writeSettings(
  projectPath: string,
  settings: Partial<StoredWorkflowProjectSettings>,
): Promise<void> {
  await saveFilesystemPublicationTransaction({
    root: workflowsRoot,
    projectPath,
    changes: [workflowPublication.createStoredWorkflowProjectSettingsChange(projectPath, {
      endpointName: '',
      endpointAccess: 'public',
      publishedEndpointName: '',
      publishedSnapshotId: null,
      publishedStateHash: null,
      lastPublishedAt: null,
      publishedWebApps: [],
      ...settings,
    }, workflowPublication.createDefaultStoredWorkflowProjectSettings())],
  });
}

async function publicationPreconditions(relativePath: string) {
  const project = await workflowQuery.getWorkflowProject(workflowsRoot, path.join(workflowsRoot, relativePath));
  return {
    expectedProjectId: project.projectMetadataId!,
    expectedDraftRevisionId: project.revisionId!,
    expectedPublicationVersion: project.settings.publicationVersion!,
  };
}

test('filesystem web-app access changes persist an opaque binding for a legacy sidecar entry', async () => {
  const projectPath = await writeBlankProject('LegacyWebAppBindingMigration');
  const relativePath = path.basename(projectPath);
  const uiGraphId = 'legacy-ui-graph';
  const settingsPath = workflowFs.getWorkflowProjectSettingsPath(projectPath);

  // This is the pre-binding sidecar shape. The access update must not keep
  // its in-memory `legacy:<uiGraphId>` fallback on disk forever.
  await fs.writeFile(settingsPath, `${JSON.stringify({
    endpointName: '',
    publishedEndpointName: '',
    publishedSnapshotId: null,
    publishedStateHash: null,
    lastPublishedAt: null,
    publishedWebApps: [{
      allowedEmails: [],
      publishedAt: '2026-01-01T00:00:00.000Z',
      publishedSnapshotId: 'legacy-snapshot',
      slug: 'legacy-web-app-binding',
      uiGraphId,
      uiGraphName: 'Legacy Web App',
    }],
  }, null, 2)}\n`, 'utf8');

  await workflowStorageBackend.updateWorkflowProjectWebAppAccessWithBackend(relativePath, [{
    uiGraphId,
    allowedEmails: ['owner@example.com'],
  }]);

  const persisted = JSON.parse(await fs.readFile(settingsPath, 'utf8')) as {
    publishedWebApps: Array<{ appId?: unknown }>;
  };
  const appId = persisted.publishedWebApps[0]?.appId;
  assert.ok(typeof appId === 'string');
  assert.match(appId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

  await workflowStorageBackend.unpublishWorkflowProjectWebAppWithBackend(relativePath, uiGraphId);
  assert.equal((await workflowPublication.readStoredWorkflowProjectSettings(projectPath, 'LegacyWebAppBindingMigration')).publishedWebApps.length, 0);
});

test('malformed publication settings fail visibly instead of making an endpoint appear unpublished', async () => {
  const projectPath = await writeBlankProject('CorruptPublicationSettings');
  await fs.writeFile(workflowFs.getWorkflowProjectSettingsPath(projectPath), '{broken', 'utf8');
  await assert.rejects(
    workflowPublication.readStoredWorkflowProjectSettings(projectPath, 'CorruptPublicationSettings'),
    /Corrupt workflow publication settings/,
  );
  await assert.rejects(workflowStorageBackend.initializeWorkflowStorage(), /Corrupt workflow publication settings/);
});

test('malformed published web-app entries fail visibly instead of disappearing', async () => {
  const projectPath = await writeBlankProject('CorruptWebAppSettings');
  await fs.writeFile(workflowFs.getWorkflowProjectSettingsPath(projectPath), JSON.stringify({
    publishedWebApps: [{ uiGraphId: 'web-app', publishedSnapshotId: 'legacy-snapshot', publishedAt: '2026-01-01T00:00:00.000Z' }],
  }));
  await assert.rejects(
    workflowPublication.readStoredWorkflowProjectSettings(projectPath, 'CorruptWebAppSettings'),
    /Corrupt workflow publication settings/,
  );
  await assert.rejects(workflowStorageBackend.initializeWorkflowStorage(), /Corrupt workflow publication settings/);

  await fs.writeFile(workflowFs.getWorkflowProjectSettingsPath(projectPath), JSON.stringify({
    publishedWebApps: [{
      uiGraphId: 'web-app', publishedSnapshotId: 'legacy-snapshot', slug: 'web-app',
      publishedAt: '2026-01-01T00:00:00.000Z', allowedEmails: 42,
    }],
  }));
  await assert.rejects(
    workflowPublication.readStoredWorkflowProjectSettings(projectPath, 'CorruptWebAppSettings'),
    /Corrupt workflow publication settings/,
  );
});

test('byte-preserved dataset snapshots keep the legacy publication state hash', async () => {
  const projectPath = await writeBlankProject('LegacyDatasetHash');
  const dataset = Buffer.from([0, 255, 254, 13, 10]);
  await fs.writeFile(workflowFs.getWorkflowDatasetPath(projectPath), dataset);
  const projectContents = await fs.readFile(projectPath, 'utf8');
  assert.equal(
    workflowPublication.createWorkflowPublicationStateHashFromContents(projectContents, dataset, 'dataset-hash'),
    await workflowPublication.createWorkflowPublicationStateHash(projectPath, 'dataset-hash'),
  );
});

test('published snapshot IDs cannot escape the frozen snapshot namespace', async () => {
  const projectPath = await writeBlankProject('InvalidSnapshotId');
  await fs.writeFile(workflowFs.getWorkflowProjectSettingsPath(projectPath), JSON.stringify({
    publishedSnapshotId: '../Other Project',
  }));
  await assert.rejects(
    workflowPublication.readStoredWorkflowProjectSettings(projectPath, 'InvalidSnapshotId'),
    /Corrupt workflow publication settings/,
  );
  assert.throws(() => workflowFs.getPublishedWorkflowSnapshotPath(workflowsRoot, '../Other Project'), /Invalid published snapshot ID/);
});

test('failed publication does not invalidate the tree, while a committed retry does once', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'PublicationInvalidation');
  await withWorkflowApiServer(async (baseUrl) => {
    const initial = await readJson<{ sync: { revision: number } }>(await fetch(`${baseUrl}/tree`));
    const publish = async () => fetch(`${baseUrl}/projects/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        relativePath: created.relativePath,
        preconditions: await publicationPreconditions(created.relativePath),
        settings: { endpointName: 'publication-invalidation', expectedRevisionId: created.revisionId },
      }),
    });
    try {
      setFilesystemPublicationTransactionCheckpointForTests((checkpoint) => {
        if (checkpoint === 'promoted') throw new Error('injected publication failure');
      });
      assert.equal((await publish()).status, 500);
      const afterFailure = await readJson<{ sync: { revision: number } }>(await fetch(`${baseUrl}/tree`));
      assert.equal(afterFailure.sync.revision, initial.sync.revision);
      assert.equal((await workflowPublication.readStoredWorkflowProjectSettings(created.absolutePath, created.name)).publishedSnapshotId, null);
    } finally {
      setFilesystemPublicationTransactionCheckpointForTests(null);
    }
    assert.equal((await publish()).status, 200);
    const afterCommit = await readJson<{ sync: { revision: number } }>(await fetch(`${baseUrl}/tree`));
    assert.equal(afterCommit.sync.revision, initial.sync.revision + 1);
  });
});

test('publish and unpublish keep workflow project behavior stable', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'Published');

  const published = await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'demo-endpoint',
  });

  assert.equal(published.settings.status, 'published');
  assert.equal(published.settings.endpointName, 'demo-endpoint');
  assert.match(published.settings.lastPublishedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(await workflowFs.pathExists(path.join(workflowsRoot, '.published')), true);

  const unpublished = await workflowMutations.unpublishWorkflowProjectItem(created.relativePath);
  assert.equal(unpublished.settings.status, 'unpublished');
  assert.equal(unpublished.settings.endpointName, 'demo-endpoint');
  assert.equal(unpublished.settings.lastPublishedAt, published.settings.lastPublishedAt);
  assert.equal(await workflowPublication.findPublishedWorkflowByEndpoint(workflowsRoot, 'demo-endpoint'), null);
  assert.equal(await workflowPublication.findLatestWorkflowByEndpoint(workflowsRoot, 'demo-endpoint'), null);
});

test('filesystem publication methods reject omitted reviewed state without mutating publication', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'RequiredBackendTokens');
  const rawMutations = await import('../routes/workflows/workflow-mutations.js');
  const rawBackend = await import('../routes/workflows/storage-backend.js');
  await assert.rejects(
    rawMutations.publishWorkflowProjectItem(created.relativePath, { endpointName: 'unchecked-endpoint' }, undefined as never),
    { status: 400 },
  );
  await assert.rejects(rawMutations.unpublishWorkflowProjectItem(created.relativePath, undefined as never), { status: 400 });
  await assert.rejects(rawBackend.executeWorkflowPublicationCommandWithBackend({
    kind: 'publish-endpoint', relativePath: created.relativePath, endpointName: 'unchecked-endpoint', preconditions: undefined,
  } as never), { status: 400 });
  await assert.rejects(rawBackend.executeWorkflowPublicationCommandWithBackend({ kind: 'unknown' } as never), { status: 400 });
  const settings = await workflowPublication.readStoredWorkflowProjectSettings(created.absolutePath, created.name);
  assert.equal(settings.publishedSnapshotId, null);
  assert.equal(settings.publicationVersion, '0');
});

test('publish rejects a saved project without a selected Main Graph', async () => {
  const projectPath = await writeBlankProject('NoMainGraph');
  const contents = await fs.readFile(projectPath, 'utf8');
  await fs.writeFile(projectPath, contents.replace(/^[ \t]*mainGraphId:.*\r?\n/m, ''), 'utf8');

  await assert.rejects(
    workflowMutations.publishWorkflowProjectItem('NoMainGraph.rivet-project', {
      endpointName: 'missing-main-graph',
    }),
    /Choose a Main Graph before publishing this endpoint/,
  );

  await withWorkflowApiServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/projects/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        relativePath: 'NoMainGraph.rivet-project',
        preconditions: await publicationPreconditions('NoMainGraph.rivet-project'),
        settings: { endpointName: 'missing-main-graph', expectedRevisionId: (await workflowQuery.getWorkflowProject(workflowsRoot, projectPath)).revisionId },
      }),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: 'Choose a Main Graph before publishing this endpoint.',
    });
  });

  assert.equal(await workflowPublication.findPublishedWorkflowByEndpoint(workflowsRoot, 'missing-main-graph'), null);
});

test('HTTP publishing rejects missing and stale revisions and accepts a deliberate refreshed retry', async () => {
  const projectPath = await writeBlankProject('ConcurrentPublish');
  const original = await workflowStorageBackend.publishWorkflowProjectItemWithBackend('ConcurrentPublish.rivet-project', {
    endpointName: 'original-endpoint',
  });
  const originalSettings = await workflowPublication.readStoredWorkflowProjectSettings(projectPath, 'ConcurrentPublish');
  await withWorkflowApiServer(async (baseUrl) => {
    const publish = (expectedRevisionId?: string | null) => fetch(`${baseUrl}/projects/publish`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        relativePath: 'ConcurrentPublish.rivet-project',
        preconditions: {
          expectedProjectId: original.projectMetadataId,
          expectedPublicationVersion: original.settings.publicationVersion,
          expectedDraftRevisionId: expectedRevisionId,
        },
        settings: { endpointName: 'new-endpoint' },
      }),
    });
    for (const invalidRevision of [undefined, null, '', '   ']) {
      assert.equal((await publish(invalidRevision)).status, 400);
    }
    const disagreeingLegacyRevision = await fetch(`${baseUrl}/projects/publish`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        relativePath: 'ConcurrentPublish.rivet-project',
        preconditions: {
          expectedProjectId: original.projectMetadataId,
          expectedPublicationVersion: original.settings.publicationVersion,
          expectedDraftRevisionId: original.revisionId,
        },
        settings: { endpointName: 'new-endpoint', expectedRevisionId: 'other-revision' },
      }),
    });
    assert.equal(disagreeingLegacyRevision.status, 400);
    const restoreWithoutReviewedDraft = await fetch(`${baseUrl}/projects/published-versions/restore`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        relativePath: 'ConcurrentPublish.rivet-project',
        versionId: 'not-a-version',
        preconditions: {
          expectedProjectId: original.projectMetadataId,
          expectedPublicationVersion: original.settings.publicationVersion,
        },
      }),
    });
    assert.equal(restoreWithoutReviewedDraft.status, 400);
    // Dataset-only edits are changes too; the project bytes are unchanged.
    await fs.writeFile(workflowFs.getWorkflowDatasetPath(projectPath), '[]', 'utf8');
    const conflict = await publish(original.revisionId);
    assert.equal(conflict.status, 409);
    assert.match((await conflict.json() as { error: string }).error, /Publishing failed because the project changed/);
    assert.deepEqual(await workflowPublication.readStoredWorkflowProjectSettings(projectPath, 'ConcurrentPublish'), originalSettings);
    const refreshed = await workflowQuery.getWorkflowProject(workflowsRoot, projectPath);
    // Another intervening edit must conflict again rather than bypassing protection.
    await fs.appendFile(projectPath, '\n');
    assert.equal((await publish(refreshed.revisionId)).status, 409);
    const latest = await workflowQuery.getWorkflowProject(workflowsRoot, projectPath);
    assert.equal((await publish(latest.revisionId)).status, 200);
  });
});

test('workflow publish and unpublish routes preserve publication state over HTTP', async () => {
  await withWorkflowApiServer(async (baseUrl) => {
    const createdProject = await readJson<{ project: { relativePath: string } }>(await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Published' }),
    }));

    const published = await readJson<{ project: { settings: { status: string; endpointName: string; lastPublishedAt: string | null } } }>(
      await fetch(`${baseUrl}/projects/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          relativePath: createdProject.project.relativePath,
          preconditions: await publicationPreconditions(createdProject.project.relativePath),
          settings: { endpointName: 'http-endpoint', expectedRevisionId: (await workflowQuery.getWorkflowProject(workflowsRoot, path.join(workflowsRoot, createdProject.project.relativePath))).revisionId },
        }),
      }),
    );

    assert.equal(published.project.settings.status, 'published');
    assert.equal(published.project.settings.endpointName, 'http-endpoint');
    assert.match(published.project.settings.lastPublishedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);

    const unpublished = await readJson<{ project: { settings: { status: string; endpointName: string; lastPublishedAt: string | null } } }>(
      await fetch(`${baseUrl}/projects/unpublish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relativePath: createdProject.project.relativePath, preconditions: await publicationPreconditions(createdProject.project.relativePath) }),
      }),
    );

    assert.equal(unpublished.project.settings.status, 'unpublished');
    assert.equal(unpublished.project.settings.endpointName, 'http-endpoint');
    assert.equal(unpublished.project.settings.lastPublishedAt, published.project.settings.lastPublishedAt);
  });
});

test('full unpublish closes both published and latest execution routes while keeping the saved draft endpoint', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'ClosedExecution');
  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'closed-execution-endpoint',
  });

  await withWorkflowExecutionServer(async ({ apiBaseUrl, publishedBaseUrl, latestBaseUrl }) => {
    const publishedBefore = await fetch(`${publishedBaseUrl}/closed-execution-endpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'published-before-unpublish' }),
    });
    const latestBefore = await fetch(`${latestBaseUrl}/closed-execution-endpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'latest-before-unpublish' }),
    });

    assert.equal(publishedBefore.ok, true);
    assert.equal(latestBefore.ok, true);

    const unpublished = await readJson<{
      project: {
        settings: {
          status: string;
          endpointName: string;
        };
      };
    }>(await fetch(`${apiBaseUrl}/projects/unpublish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relativePath: created.relativePath, preconditions: await publicationPreconditions(created.relativePath) }),
    }));

    assert.equal(unpublished.project.settings.status, 'unpublished');
    assert.equal(unpublished.project.settings.endpointName, 'closed-execution-endpoint');

    const publishedAfter = await fetch(`${publishedBaseUrl}/closed-execution-endpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'published-after-unpublish' }),
    });
    const latestAfter = await fetch(`${latestBaseUrl}/closed-execution-endpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'latest-after-unpublish' }),
    });

    assert.equal(publishedAfter.status, 404);
    assert.equal((await publishedAfter.json() as { error: string }).error, 'Published workflow not found');
    assert.equal(latestAfter.status, 404);
    assert.equal((await latestAfter.json() as { error: string }).error, 'Latest workflow not found');
  });
});

test('publish enforces case-insensitive endpoint uniqueness', async () => {
  const firstProject = await workflowMutations.createWorkflowProjectItem('', 'First');
  const secondProject = await workflowMutations.createWorkflowProjectItem('', 'Second');

  await workflowMutations.publishWorkflowProjectItem(firstProject.relativePath, {
    endpointName: 'Demo-Endpoint',
  });

  await assert.rejects(
    workflowMutations.publishWorkflowProjectItem(secondProject.relativePath, {
      endpointName: 'demo-endpoint',
    }),
    /Endpoint name is already used/,
  );
});

test('filesystem save keeps published status on a no-op save and marks real changes as unpublished_changes', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'FilesystemSaveStatus');

  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'filesystem-save-status-endpoint',
  });

  const loaded = await workflowStorageBackend.loadHostedProject(created.absolutePath);
  await workflowStorageBackend.saveHostedProject({
    projectPath: created.absolutePath,
    contents: loaded.contents,
    datasetsContents: loaded.datasetsContents,
  });

  const afterNoOpSave = await workflowQuery.getWorkflowProject(workflowsRoot, created.absolutePath);
  assert.equal(afterNoOpSave.settings.status, 'published');

  await workflowStorageBackend.saveHostedProject({
    projectPath: created.absolutePath,
    contents: `${loaded.contents}\n# changed\n`,
    datasetsContents: loaded.datasetsContents,
  });

  const afterRealSave = await workflowQuery.getWorkflowProject(workflowsRoot, created.absolutePath);
  assert.equal(afterRealSave.settings.status, 'unpublished_changes');
});

test('filesystem project rename keeps a published project published without rewriting its contents', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'FilesystemRenameStatus');
  const contentsBeforeRename = await fs.readFile(created.absolutePath, 'utf8');

  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'filesystem-rename-status-endpoint',
  });

  const renamed = await workflowMutations.renameWorkflowProjectItem(created.relativePath, 'FilesystemRenameStatusRenamed');

  assert.equal(renamed.project.settings.status, 'published');
  assert.equal(await fs.readFile(renamed.project.absolutePath, 'utf8'), contentsBeforeRename);
  assert.equal(
    (await workflowPublication.findPublishedWorkflowByEndpoint(
      workflowsRoot,
      'filesystem-rename-status-endpoint',
    ))?.projectPath,
    renamed.project.absolutePath,
  );
});

test('published and latest workflow resolution split after unpublished changes', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'Resolution');
  const sidecars = workflowFs.getProjectSidecarPaths(created.absolutePath);

  await fs.writeFile(sidecars.dataset, '{"before":true}', 'utf8');
  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'resolution-endpoint',
  });

  await fs.writeFile(created.absolutePath, `${await fs.readFile(created.absolutePath, 'utf8')}\n# changed\n`, 'utf8');
  await fs.writeFile(sidecars.dataset, '{"after":true}', 'utf8');

  const publishedMatch = await workflowPublication.findPublishedWorkflowByEndpoint(workflowsRoot, 'resolution-endpoint');
  const latestMatch = await workflowPublication.findLatestWorkflowByEndpoint(workflowsRoot, 'resolution-endpoint');
  const currentSettings = await workflowPublication.getWorkflowProjectSettings(created.absolutePath, created.name);
  const storedSettings = await workflowPublication.readStoredWorkflowProjectSettings(created.absolutePath, created.name);

  assert.ok(publishedMatch);
  assert.ok(latestMatch);
  assert.ok(storedSettings.publishedSnapshotId);
  assert.equal(latestMatch.projectPath, created.absolutePath);
  assert.notEqual(publishedMatch.publishedProjectPath, created.absolutePath);
  assert.equal(currentSettings.status, 'unpublished_changes');
  assert.match(currentSettings.lastPublishedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);

  const publishedContents = await fs.readFile(publishedMatch.publishedProjectPath, 'utf8');
  const latestContents = await fs.readFile(latestMatch.projectPath, 'utf8');
  const publishedDatasetContents = await fs.readFile(
    workflowFs.getPublishedWorkflowSnapshotDatasetPath(
      workflowsRoot,
      storedSettings.publishedSnapshotId,
    ),
    'utf8',
  );

  assert.notEqual(publishedContents, latestContents);
  assert.equal(publishedDatasetContents, '{"before":true}');
});

test('published workflow lookup skips stale endpoint matches and continues to a valid published project', async () => {
  const staleCandidate = await workflowMutations.createWorkflowProjectItem('', 'EndpointStaleCandidate');
  await workflowMutations.createWorkflowFolderItem('Nested', '');
  const healthyCandidate = await workflowMutations.createWorkflowProjectItem('Nested', 'EndpointHealthyCandidate');
  const sharedEndpoint = 'shared-published-endpoint';

  await workflowMutations.publishWorkflowProjectItem(healthyCandidate.relativePath, {
    endpointName: sharedEndpoint,
  });

  const staleSettingsPath = workflowFs.getProjectSidecarPaths(staleCandidate.absolutePath).settings;
  await fs.writeFile(staleSettingsPath, `${JSON.stringify({
    endpointName: sharedEndpoint,
    publishedEndpointName: sharedEndpoint,
    publishedSnapshotId: null,
    publishedStateHash: 'stale-publication-state',
    lastPublishedAt: '2025-01-01T00:00:00.000Z',
  }, null, 2)}\n`, 'utf8');

  const publishedMatch = await workflowPublication.findPublishedWorkflowByEndpoint(workflowsRoot, sharedEndpoint);

  assert.ok(publishedMatch);
  assert.equal(publishedMatch.projectPath, healthyCandidate.absolutePath);
  assert.match(publishedMatch.publishedProjectPath, /\.published[\\/].+\.rivet-project$/);
});

test('legacy published settings without lastPublishedAt still expose a fallback timestamp', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'LegacyPublished');
  const published = await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'legacy-published-endpoint',
  });
  const sidecars = workflowFs.getProjectSidecarPaths(created.absolutePath);
  const storedSettings = JSON.parse(await fs.readFile(sidecars.settings, 'utf8')) as Record<string, unknown>;

  delete storedSettings.lastPublishedAt;
  await fs.writeFile(sidecars.settings, `${JSON.stringify(storedSettings, null, 2)}\n`, 'utf8');

  const fallbackSettings = await workflowPublication.getWorkflowProjectSettings(created.absolutePath, created.name);

  assert.equal(fallbackSettings.status, published.settings.status);
  assert.equal(fallbackSettings.endpointName, published.settings.endpointName);
  assert.match(fallbackSettings.lastPublishedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
});

test('published workflow keeps referenced projects resolvable after the referenced project is moved', async () => {
  const referenced = await workflowMutations.createWorkflowProjectItem('', 'Referenced');
  const main = await workflowMutations.createWorkflowProjectItem('', 'Main');
  const passthroughProjectPath = fileURLToPath(
    new URL('../../../node/test/test-graphs.rivet-project', import.meta.url),
  );
  const passthroughProject = await fs.readFile(passthroughProjectPath, 'utf8');
  const passthroughFixture = await rivetNode.loadProjectFromFile(passthroughProjectPath);
  const passthroughGraphId = Object.keys(passthroughFixture.graphs)[0];
  if (!passthroughGraphId) {
    throw new Error('Expected the passthrough fixture to contain a graph');
  }

  const referencedProjectId = 'refProject123';
  const referencedGraphId = 'refGraph123';
  const mainProjectId = 'mainProject123';
  const mainGraphId = 'mainGraph123';

  const createAnyPassthroughProject = (projectId: string, graphId: string, title: string) =>
    passthroughProject
      .replace('    title: Untitled Project', [
        `    title: ${title}`,
        `    mainGraphId: ${graphId}`,
      ].join('\n'))
      .replaceAll(passthroughFixture.metadata.id, projectId)
      .replaceAll(passthroughGraphId, graphId)
      .replaceAll('dataType: string', 'dataType: any');

  const referencedContents = createAnyPassthroughProject(referencedProjectId, referencedGraphId, 'Referenced');
  const mainContents = createAnyPassthroughProject(mainProjectId, mainGraphId, 'Main')
    .replace(
      [
        `        '[hHAeA3eIMmdfGFOYeool0]:passthrough "Passthrough"':`,
        '          outgoingConnections:',
        '            - output1->"Graph Output" Dp5_0MQuZk7_UTdBQGX-P/value',
        '          visualData: 928/554/205/9//',
      ].join('\n'),
      [
        `        '[hHAeA3eIMmdfGFOYeool0]:referencedGraphAlias "Referenced Passthrough"':`,
        '          data:',
        `            projectId: ${referencedProjectId}`,
        `            graphId: ${referencedGraphId}`,
        '            useErrorOutput: false',
        '          outgoingConnections:',
        '            - output->"Graph Output" Dp5_0MQuZk7_UTdBQGX-P/value',
        '          visualData: 928/554/205/9//',
      ].join('\n'),
    )
    .replace(
      '            - data->"Passthrough" hHAeA3eIMmdfGFOYeool0/input1',
      '            - data->"Referenced Passthrough" hHAeA3eIMmdfGFOYeool0/input',
    );

  await fs.writeFile(referenced.absolutePath, referencedContents, 'utf8');
  await fs.writeFile(main.absolutePath, mainContents, 'utf8');

  const mainProject = await rivetNode.loadProjectFromFile(main.absolutePath);
  mainProject.references = [{
    id: referencedProjectId as never,
    hintPaths: ['./Referenced.rivet-project'],
    title: 'Referenced',
  }];
  const serializedMainProject = rivetNode.serializeProject(mainProject);
  if (typeof serializedMainProject !== 'string') {
    throw new TypeError('Expected serialized project to be a string');
  }
  await fs.writeFile(main.absolutePath, serializedMainProject, 'utf8');

  await workflowMutations.publishWorkflowProjectItem(referenced.relativePath, {
    endpointName: 'referenced-project-endpoint',
  });
  await workflowMutations.publishWorkflowProjectItem(main.relativePath, {
    endpointName: 'main-with-reference-endpoint',
  });

  await workflowMutations.createWorkflowFolderItem('Moved', '');
  await workflowStorageBackend.moveWorkflowItemWithBackend('project', referenced.relativePath, 'Moved');
  const staleHintProject = await workflowMutations.createWorkflowProjectItem('', 'Referenced');
  const staleHintContents = await rivetNode.loadProjectFromFile(staleHintProject.absolutePath);
  assert.notEqual(staleHintContents.metadata.id, referencedProjectId);

  await withWorkflowExecutionServer(async ({ publishedBaseUrl }) => {
    const response = await fetch(`${publishedBaseUrl}/main-with-reference-endpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ foo: 'bar' }),
      signal: AbortSignal.timeout(5000),
    });

    assert.equal(response.ok, true);
    const body = await response.json() as { durationMs?: number };
    assert.equal(typeof body.durationMs, 'number');
  });
});

test('fully unpublished draft endpoint names do not reserve filesystem endpoints', async () => {
  const previousProjectPath = await writeBlankProject('PreviousEndpointOwner');
  const nextProjectPath = await writeBlankProject('NextEndpointOwner');

  await writeSettings(previousProjectPath, {
    endpointName: 'reusable-endpoint',
    lastPublishedAt: '2026-05-05T00:00:00.000Z',
  });

  await assert.doesNotReject(
    workflowPublication.ensureWorkflowEndpointNameIsUnique(
      workflowsRoot,
      nextProjectPath,
      'Reusable-Endpoint',
    ),
  );

  await writeSettings(nextProjectPath, {
    endpointName: 'Reusable-Endpoint',
    publishedEndpointName: 'Reusable-Endpoint',
    publishedSnapshotId: 'next-snapshot',
    publishedStateHash: await workflowPublication.createWorkflowPublicationStateHash(
      nextProjectPath,
      'Reusable-Endpoint',
    ),
    lastPublishedAt: '2026-05-05T00:01:00.000Z',
  });

  await assert.rejects(
    workflowPublication.ensureWorkflowEndpointNameIsUnique(
      workflowsRoot,
      previousProjectPath,
      'reusable-endpoint',
    ),
    /Endpoint name is already used by NextEndpointOwner\.rivet-project/,
  );
});

test('active draft and published endpoint identities both reserve filesystem endpoints', async () => {
  const activeProjectPath = await writeBlankProject('ActiveEndpointOwner');
  const otherProjectPath = await writeBlankProject('OtherEndpointOwner');

  await writeSettings(activeProjectPath, {
    endpointName: 'current-draft-endpoint',
    publishedEndpointName: 'published-endpoint',
    publishedSnapshotId: 'active-snapshot',
    publishedStateHash: await workflowPublication.createWorkflowPublicationStateHash(
      activeProjectPath,
      'published-endpoint',
    ),
    lastPublishedAt: '2026-05-05T00:02:00.000Z',
  });

  await assert.rejects(
    workflowPublication.ensureWorkflowEndpointNameIsUnique(
      workflowsRoot,
      otherProjectPath,
      'Current-Draft-Endpoint',
    ),
    /Endpoint name is already used by ActiveEndpointOwner\.rivet-project/,
  );

  await assert.rejects(
    workflowPublication.ensureWorkflowEndpointNameIsUnique(
      workflowsRoot,
      otherProjectPath,
      'Published-Endpoint',
    ),
    /Endpoint name is already used by ActiveEndpointOwner\.rivet-project/,
  );
});
