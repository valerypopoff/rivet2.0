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
  workflowPublication,
  workflowStorageBackend,
  withWorkflowApiServer,
  withWorkflowExecutionServer,
  resetAndEnsureWorkflowsRoot,
  cleanupWorkflowSuite,
} = await createFilesystemWorkflowSuiteHarness();
type StoredWorkflowProjectSettings = Awaited<ReturnType<typeof workflowPublication.readStoredWorkflowProjectSettings>>;

test.beforeEach(resetAndEnsureWorkflowsRoot);
test.after(cleanupWorkflowSuite);

async function writeBlankProject(projectName: string): Promise<string> {
  const projectPath = path.join(workflowsRoot, `${projectName}.rivet-project`);
  await fs.writeFile(projectPath, workflowFs.createBlankProjectFile(projectName), 'utf8');
  return projectPath;
}

async function writeSettings(
  projectPath: string,
  settings: Partial<StoredWorkflowProjectSettings>,
): Promise<void> {
  await workflowPublication.writeStoredWorkflowProjectSettings(projectPath, {
    endpointName: '',
    publishedEndpointName: '',
    publishedSnapshotId: null,
    publishedStateHash: null,
    lastPublishedAt: null,
    ...settings,
  });
}

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
          settings: { endpointName: 'http-endpoint' },
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
        body: JSON.stringify({ relativePath: createdProject.project.relativePath }),
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
      body: JSON.stringify({ relativePath: created.relativePath }),
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
  const passthroughProject = await fs.readFile(
    new URL('../../../../rivet/packages/node/test/test-graphs.rivet-project', import.meta.url),
    'utf8',
  );
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
      .replaceAll('ytCHmBvDFSkCnQ9L7DJLB', projectId)
      .replaceAll('kqaNrBo0WpJ1EOc2hj0zK', graphId)
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
    )
    .replace(
      '  references: []',
      [
        '  references:',
        `    - id: ${referencedProjectId}`,
        '      hintPaths:',
        '        - ./Referenced.rivet-project',
        '      title: Referenced',
      ].join('\n'),
    );

  await fs.writeFile(referenced.absolutePath, referencedContents, 'utf8');
  await fs.writeFile(main.absolutePath, mainContents, 'utf8');

  await workflowMutations.publishWorkflowProjectItem(referenced.relativePath, {
    endpointName: 'referenced-project-endpoint',
  });
  await workflowMutations.publishWorkflowProjectItem(main.relativePath, {
    endpointName: 'main-with-reference-endpoint',
  });

  await workflowMutations.createWorkflowFolderItem('Moved', '');
  await workflowQuery.moveWorkflowProject(workflowsRoot, referenced.relativePath, 'Moved');

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
