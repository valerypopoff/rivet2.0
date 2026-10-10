import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadProjectAndAttachedDataFromString, serializeProject } from '@valerypopoff/rivet2-node';
import type { WorkflowProjectItem } from '../../../../studio-server-shared/workflow-types.js';
import type {
  WorkflowProjectRepository,
  WorkflowPublicationRepository,
  WorkflowExecutionSources,
} from '../../routes/workflows/data-backend.js';

const conditions = (item: WorkflowProjectItem) => ({
  expectedProjectId: item.projectMetadataId!,
  expectedDraftRevisionId: item.revisionId!,
  expectedPublicationVersion: item.settings.publicationVersion!,
});

/** Run unchanged against real SQLite and PostgreSQL adapters. No SQL mocks or
 * adapter-specific assertions: this contract belongs to publication policy. */
export async function verifyWorkflowPublicationContract(
  backend: WorkflowProjectRepository & WorkflowPublicationRepository & WorkflowExecutionSources,
): Promise<void> {
  const suffix = randomUUID();
  const endpointName = `publication-${suffix}`;
  const slug = `app-${suffix}`;
  const create = async (name: string) => {
    const item = await backend.createWorkflowProjectItem('', `${name}-${suffix}`);
    const loaded = await backend.loadHostedProject(item.absolutePath);
    const [project, attached] = loadProjectAndAttachedDataFromString(loaded.contents);
    const graphId = 'main' as NonNullable<typeof project.metadata.mainGraphId>;
    project.metadata.mainGraphId = graphId;
    project.graphs = { [graphId]: { metadata: { id: graphId, name: 'Main' }, nodes: [], connections: [] } };
    project.uiGraphs = { ui: { id: 'ui', name: 'Contract app', components: [] } } as typeof project.uiGraphs;
    return (
      await backend.saveHostedProject({
        projectPath: item.absolutePath,
        contents: serializeProject(project, attached) as string,
        datasetsContents: null,
        expectedRevisionId: loaded.revisionId,
      })
    ).project;
  };
  let item = await create('Publication');
  const other = await create('Route competitor');
  const assertNoEndpointAccess = () =>
    assert.rejects(backend.updateWorkflowEndpointAccess(item.relativePath, 'internal', conditions(item)), {
      status: 409,
      message: 'Publish the workflow before changing endpoint access',
    });
  await assertNoEndpointAccess();
  item = await backend.publishWorkflowProjectWebApps(
    item.relativePath,
    [{ uiGraphId: 'ui', slug, allowedEmails: ['operator@example.com'] }],
    conditions(item),
  );
  await assertNoEndpointAccess(); // Web-app publication is not endpoint publication.
  const publish = (expected: ReturnType<typeof conditions>) =>
    backend.publishWorkflowProjectItem(item.relativePath, { endpointName }, expected);
  await assert.rejects(publish({ ...conditions(item), expectedProjectId: other.projectMetadataId! }), {
    status: 409,
    code: 'publication_project_changed',
  });
  await assert.rejects(publish({ ...conditions(item), expectedDraftRevisionId: 'stale-revision' }), {
    status: 409,
    code: 'publication_draft_changed',
  });
  await assert.rejects(publish({ ...conditions(item), expectedPublicationVersion: '0' }), {
    status: 409,
    code: 'publication_state_changed',
  });
  assert.equal((await backend.listWorkflowPublishedVersions(item.relativePath)).versions.length, 0);
  item = await publish(conditions(item));
  assert.equal(item.settings.status, 'published');
  assert.ok(await backend.loadPublishedExecutionProject(endpointName));
  await assert.rejects(backend.publishWorkflowProjectItem(other.relativePath, { endpointName }, conditions(other)), {
    status: 409,
  });
  assert.equal((await backend.listWorkflowPublishedVersions(other.relativePath)).versions.length, 0);

  // Access/unpublish commands deliberately accept a changed draft, but not a
  // changed project identity or publication state. They must not rewrite it.
  const reviewed = conditions(item);
  const loaded = await backend.loadHostedProject(item.absolutePath);
  const [edited, attached] = loadProjectAndAttachedDataFromString(loaded.contents);
  edited.metadata.description = 'New unpublished draft';
  item = (
    await backend.saveHostedProject({
      projectPath: item.absolutePath,
      contents: serializeProject(edited, attached) as string,
      datasetsContents: null,
      expectedRevisionId: loaded.revisionId,
    })
  ).project;
  const draftRevision = item.revisionId;
  assert.notEqual(draftRevision, reviewed.expectedDraftRevisionId);
  item = await backend.updateWorkflowEndpointAccess(item.relativePath, 'internal', reviewed);
  assert.equal(item.settings.endpointAccess, 'internal');
  assert.equal(item.revisionId, draftRevision);
  await assert.rejects(backend.unpublishWorkflowProjectItem(item.relativePath, reviewed), {
    status: 409,
    code: 'publication_state_changed',
  });
  const apps = item.settings.publishedWebApps;
  item = await backend.unpublishWorkflowProjectItem(item.relativePath, {
    ...conditions(item),
    expectedDraftRevisionId: reviewed.expectedDraftRevisionId,
  });
  assert.equal(item.settings.status, 'unpublished');
  assert.equal(item.settings.publishedEndpointName, '');
  assert.equal(item.settings.endpointName, endpointName);
  assert.equal(item.revisionId, draftRevision);
  assert.deepEqual(item.settings.publishedWebApps, apps);
  assert.equal(await backend.loadPublishedExecutionProject(endpointName), null);
  assert.ok(await backend.loadPublishedWebAppExecutionProject(slug));
  await assertNoEndpointAccess(); // Retained endpoint history is not a live route.
  const history = (await backend.listWorkflowPublishedVersions(item.relativePath)).versions;
  assert.equal(history.length, 1);
  assert.equal(history[0]!.isCurrent, false);
  const treeItem = (await backend.getTree()).projects.find(
    (project) => project.projectMetadataId === item.projectMetadataId,
  );
  assert.equal(treeItem?.settings.status, 'unpublished');
  assert.equal(treeItem?.settings.publicationVersion, item.settings.publicationVersion);
  item = await backend.unpublishWorkflowProjectWebApp(item.relativePath, 'ui', conditions(item));
  assert.equal(await backend.loadPublishedWebAppExecutionProject(slug), null);
  assert.equal(await backend.deleteWorkflowProjectItem(item.relativePath), item.projectMetadataId);
  assert.equal(await backend.deleteWorkflowProjectItem(other.relativePath), other.projectMetadataId);
}
