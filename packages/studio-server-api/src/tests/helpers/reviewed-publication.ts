import type {
  WorkflowDraftPublicationPreconditions,
  WorkflowProjectWebAppAccessDraft,
  WorkflowProjectWebAppPublicationDraft,
  WorkflowPublicationPreconditions,
} from '../../../../studio-server-shared/workflow-types.js';

type Mutations = typeof import('../../routes/workflows/workflow-mutations.js');
type Backend = typeof import('../../routes/workflows/storage-backend.js');

async function filesystemBaseline(relativePath: unknown): Promise<WorkflowDraftPublicationPreconditions> {
  const [fsHelpers, workflowQuery] = await Promise.all([
    import('../../routes/workflows/fs-helpers.js'),
    import('../../routes/workflows/workflow-query.js'),
  ]);
  const root = await fsHelpers.ensureWorkflowsRoot();
  const projectPath = fsHelpers.requireProjectPath(fsHelpers.resolveWorkflowRelativePath(root, relativePath, { allowProjectFile: true }));
  const project = await workflowQuery.getWorkflowProject(root, projectPath);
  if (!project.projectMetadataId || !project.revisionId) throw new Error('Test project has no reviewable publication state');
  return {
    expectedProjectId: project.projectMetadataId,
    expectedPublicationVersion: project.settings.publicationVersion ?? '0',
    expectedDraftRevisionId: project.revisionId,
  };
}

async function backendBaseline(backend: Backend, relativePath: unknown): Promise<WorkflowDraftPublicationPreconditions> {
  const snapshot = await backend.listWorkflowProjectWebAppsWithBackend(relativePath);
  return {
    expectedProjectId: snapshot.projectId,
    expectedPublicationVersion: snapshot.publicationVersion,
    expectedDraftRevisionId: snapshot.draftRevisionId,
  };
}

/** Fixture convenience only: production methods always require reviewed tokens. */
export function createReviewedFilesystemMutationFixtures(mutations: Mutations) {
  return {
    ...mutations,
    publishWorkflowProjectItem: async (path: unknown, settings: unknown, preconditions?: WorkflowDraftPublicationPreconditions) =>
      mutations.publishWorkflowProjectItem(path, settings, preconditions ?? await filesystemBaseline(path)),
    unpublishWorkflowProjectItem: async (path: unknown, preconditions?: WorkflowPublicationPreconditions) =>
      mutations.unpublishWorkflowProjectItem(path, preconditions ?? await filesystemBaseline(path)),
    updateWorkflowEndpointAccess: async (path: unknown, access: 'public' | 'internal', preconditions?: WorkflowPublicationPreconditions) =>
      mutations.updateWorkflowEndpointAccess(path, access, preconditions ?? await filesystemBaseline(path)),
  };
}

/** Captures a coherent backend snapshot for tests that are not testing stale-state rejection. */
export function createReviewedBackendPublicationFixtures(backend: Backend) {
  const reviewed = async (path: unknown, preconditions?: WorkflowPublicationPreconditions) =>
    preconditions ?? await backendBaseline(backend, path);
  return {
    ...backend,
    publishWorkflowProjectItemWithBackend: async (path: unknown, settings: { endpointName: string }, preconditions?: WorkflowDraftPublicationPreconditions) =>
      backend.executeWorkflowPublicationCommandWithBackend({
        kind: 'publish-endpoint', relativePath: path, endpointName: settings.endpointName,
        preconditions: preconditions ?? await backendBaseline(backend, path),
      }),
    publishWorkflowProjectWebAppsWithBackend: async (path: unknown, publications: unknown, preconditions?: WorkflowDraftPublicationPreconditions) =>
      backend.executeWorkflowPublicationCommandWithBackend({
        kind: 'publish-web-apps', relativePath: path, publications: publications as WorkflowProjectWebAppPublicationDraft[],
        preconditions: preconditions ?? await backendBaseline(backend, path),
      }),
    restoreWorkflowPublishedVersionWithBackend: async (path: unknown, versionId: unknown, preconditions?: WorkflowDraftPublicationPreconditions) =>
      backend.executeWorkflowPublicationCommandWithBackend({
        kind: 'restore-version', relativePath: path, versionId,
        preconditions: preconditions ?? await backendBaseline(backend, path),
      }),
    unpublishWorkflowProjectItemWithBackend: async (path: unknown, preconditions?: WorkflowPublicationPreconditions) =>
      backend.executeWorkflowPublicationCommandWithBackend({ kind: 'unpublish-endpoint', relativePath: path, preconditions: await reviewed(path, preconditions) }),
    unpublishWorkflowProjectWebAppWithBackend: async (path: unknown, uiGraphId: unknown, preconditions?: WorkflowPublicationPreconditions) =>
      backend.executeWorkflowPublicationCommandWithBackend({ kind: 'unpublish-web-app', relativePath: path, uiGraphId, preconditions: await reviewed(path, preconditions) }),
    updateWorkflowEndpointAccessWithBackend: async (path: unknown, access: 'public' | 'internal', preconditions?: WorkflowPublicationPreconditions) =>
      backend.executeWorkflowPublicationCommandWithBackend({ kind: 'set-endpoint-access', relativePath: path, access, preconditions: await reviewed(path, preconditions) }),
    updateWorkflowProjectWebAppAccessWithBackend: async (path: unknown, updates: unknown, preconditions?: WorkflowPublicationPreconditions) =>
      backend.executeWorkflowPublicationCommandWithBackend({
        kind: 'set-web-app-access', relativePath: path, accessUpdates: updates as WorkflowProjectWebAppAccessDraft[],
        preconditions: await reviewed(path, preconditions),
      }),
  };
}
