import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { loadProjectFromFile } from '@valerypopoff/rivet2-node';

import type {
  WorkflowDraftPublicationPreconditions,
  WorkflowPublicationPreconditions,
  WorkflowProjectWebAppsResponse,
} from '../../../../studio-server-shared/workflow-types.js';
import { badRequest, createHttpError } from '../../utils/httpError.js';
import {
  createPublishedWorkflowSnapshotChanges,
  createStoredWorkflowProjectSettingsChange,
  createWorkflowProjectContentHash,
  ensureWorkflowWebAppSlugIsUnique,
  getPublishedWorkflowSnapshotArtifactPaths,
  readStoredWorkflowProjectSettings,
} from './publication.js';
import { normalizeWebAppAccessDrafts, normalizeWebAppPublicationDrafts } from './web-app-publication-drafts.js';
import { saveFilesystemPublicationTransaction } from './filesystem-publication-transactions.js';
import {
  assertFilesystemPublicationPreconditions,
  readFilesystemPublicationState,
} from './publication-preconditions.js';
import {
  ensureWorkflowsRoot,
  getPublishedWorkflowSnapshotPath,
  PROJECT_EXTENSION,
  requireProjectPath,
  resolveWorkflowRelativePath,
} from './fs-helpers.js';
import type { StoredWorkflowPublishedWebApp } from './types.js';
import { hasProjectMainGraph } from './main-graph.js';
import { getWorkflowProject } from './workflow-query.js';
import { listSavedLatestSubgraphProjectIds } from './subgraph-publication-dependencies.js';

type UiGraphSummary = {
  uiGraphId: string;
  name: string;
};

type WebAppStatus = WorkflowProjectWebAppsResponse['webApps'][number]['status'];

function getProjectUiGraphSummaries(project: Awaited<ReturnType<typeof loadProjectFromFile>>): UiGraphSummary[] {
  return Object.entries(project.uiGraphs ?? {}).map(([uiGraphId, uiGraph]) => ({
    uiGraphId,
    name: typeof uiGraph?.name === 'string' && uiGraph.name.trim() ? uiGraph.name.trim() : uiGraphId,
  }));
}

/**
 * Filesystem sidecars written before stable app bindings existed normalize to
 * `legacy:<uiGraphId>` in memory. Persist an opaque binding the first time
 * that particular app is changed, so subsequent policy comparisons no longer
 * depend on a legacy-derived identifier.
 */
function getPersistedWebAppBindingId(
  publication: StoredWorkflowPublishedWebApp | undefined,
  uiGraphId: string,
): string {
  if (!publication || publication.appId === `legacy:${uiGraphId}`) {
    return randomUUID();
  }
  return publication.appId;
}

function getUnusedPublishedWebAppSnapshotIds(options: {
  previousSnapshotIds: Iterable<string>;
  nextSnapshotIds: Iterable<string>;
  endpointSnapshotId: string | null;
}): string[] {
  const nextSnapshotIds = new Set(options.nextSnapshotIds);
  if (options.endpointSnapshotId) {
    nextSnapshotIds.add(options.endpointSnapshotId);
  }

  return [...new Set(options.previousSnapshotIds)].filter((snapshotId) => !nextSnapshotIds.has(snapshotId));
}

async function getPublishedWebAppStatus(options: {
  root: string;
  published: StoredWorkflowPublishedWebApp | undefined;
  getCurrentContentHash: () => Promise<string>;
  publishedContentHashBySnapshotId: Map<string, Promise<string>>;
}): Promise<WebAppStatus> {
  const { root, published, getCurrentContentHash, publishedContentHashBySnapshotId } = options;
  if (!published) {
    return 'unpublished';
  }

  let publishedContentHashPromise = publishedContentHashBySnapshotId.get(published.publishedSnapshotId);
  if (!publishedContentHashPromise) {
    const publishedProjectPath = getPublishedWorkflowSnapshotPath(root, published.publishedSnapshotId);
    publishedContentHashPromise = createWorkflowProjectContentHash(publishedProjectPath);
    publishedContentHashBySnapshotId.set(published.publishedSnapshotId, publishedContentHashPromise);
  }

  try {
    const [currentContentHash, publishedContentHash] = await Promise.all([
      getCurrentContentHash(),
      publishedContentHashPromise,
    ]);

    return currentContentHash === publishedContentHash ? 'published' : 'unpublished_changes';
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return 'unpublished_changes';
    }

    throw error;
  }
}

export async function listWorkflowProjectWebApps(relativePath: unknown): Promise<WorkflowProjectWebAppsResponse> {
  const root = await ensureWorkflowsRoot();
  const projectPath = requireProjectPath(
    resolveWorkflowRelativePath(root, relativePath, {
      allowProjectFile: true,
    }),
  );
  const projectName = path.basename(projectPath, PROJECT_EXTENSION);
  const [project, settings] = await Promise.all([
    loadProjectFromFile(projectPath),
    readStoredWorkflowProjectSettings(projectPath, projectName),
  ]);
  const publicationState = await readFilesystemPublicationState(projectPath, settings);
  const projectItem = await getWorkflowProject(root, projectPath);
  if (
    projectItem.projectMetadataId !== publicationState.projectId ||
    projectItem.revisionId !== publicationState.draftRevisionId ||
    projectItem.settings.publicationVersion !== publicationState.publicationVersion
  ) {
    throw new Error('Project settings and publication state could not be read consistently');
  }
  const currentUiGraphs = getProjectUiGraphSummaries(project);
  const currentUiGraphIds = new Set(currentUiGraphs.map((uiGraph) => uiGraph.uiGraphId));
  const publishedByUiGraphId = new Map(settings.publishedWebApps.map((webApp) => [webApp.uiGraphId, webApp]));
  let currentContentHashPromise: Promise<string> | null = null;
  const getCurrentContentHash = () => {
    currentContentHashPromise ??= createWorkflowProjectContentHash(projectPath);
    return currentContentHashPromise;
  };
  const publishedContentHashBySnapshotId = new Map<string, Promise<string>>();

  return {
    project: projectItem,
    projectId: publicationState.projectId,
    draftRevisionId: publicationState.draftRevisionId,
    publicationVersion: publicationState.publicationVersion,
    hasMainGraph: hasProjectMainGraph(project),
    savedLatestSubgraphProjectIds: listSavedLatestSubgraphProjectIds(project),
    webApps: [
      ...(await Promise.all(
        currentUiGraphs.map(async (uiGraph) => {
          const published = publishedByUiGraphId.get(uiGraph.uiGraphId);
          return {
            uiGraphId: uiGraph.uiGraphId,
            name: uiGraph.name,
            publishedSlug: published?.slug ?? null,
            publishedAt: published?.publishedAt ?? null,
            allowedEmails: published?.allowedEmails ?? [],
            status: await getPublishedWebAppStatus({
              root,
              published,
              getCurrentContentHash,
              publishedContentHashBySnapshotId,
            }),
            isMissingFromProject: false,
          };
        }),
      )),
      ...settings.publishedWebApps
        .filter((webApp) => !currentUiGraphIds.has(webApp.uiGraphId))
        .map((webApp) => ({
          uiGraphId: webApp.uiGraphId,
          name: webApp.uiGraphName,
          publishedSlug: webApp.slug,
          publishedAt: webApp.publishedAt,
          allowedEmails: webApp.allowedEmails,
          status: 'unpublished_changes' as const,
          isMissingFromProject: true,
        })),
    ],
  };
}

export async function publishWorkflowProjectWebApps(
  relativePath: unknown,
  publications: unknown,
  preconditions: WorkflowDraftPublicationPreconditions,
) {
  const root = await ensureWorkflowsRoot();
  const projectPath = requireProjectPath(
    resolveWorkflowRelativePath(root, relativePath, {
      allowProjectFile: true,
    }),
  );
  const projectName = path.basename(projectPath, PROJECT_EXTENSION);
  const [project, existingSettings] = await Promise.all([
    loadProjectFromFile(projectPath),
    readStoredWorkflowProjectSettings(projectPath, projectName),
  ]);
  await assertFilesystemPublicationPreconditions(projectPath, existingSettings, preconditions, 'publish-web-apps');
  const availableUiGraphs = new Map(getProjectUiGraphSummaries(project).map((uiGraph) => [uiGraph.uiGraphId, uiGraph]));
  const normalizedPublications = normalizeWebAppPublicationDrafts(publications);
  const replacedUiGraphIds = new Set(normalizedPublications.map((publication) => publication.uiGraphId));

  for (const publication of normalizedPublications) {
    if (!availableUiGraphs.has(publication.uiGraphId)) {
      throw createHttpError(404, 'Web app not found');
    }

    await ensureWorkflowWebAppSlugIsUnique(root, projectPath, publication.slug, replacedUiGraphIds);
  }

  const publishedSnapshotId = randomUUID();
  const publishedAt = new Date().toISOString();
  const previousSnapshotIds = existingSettings.publishedWebApps
    .filter((webApp) => replacedUiGraphIds.has(webApp.uiGraphId))
    .map((webApp) => webApp.publishedSnapshotId);
  const nextPublishedWebApps = [
    ...existingSettings.publishedWebApps.filter((webApp) => !replacedUiGraphIds.has(webApp.uiGraphId)),
    ...normalizedPublications.map((publication) => {
      const uiGraph = availableUiGraphs.get(publication.uiGraphId);
      const previousPublication = existingSettings.publishedWebApps.find(
        (webApp) => webApp.uiGraphId === publication.uiGraphId,
      );
      return {
        // Republishing the same UI graph updates its executable snapshot, not
        // the app binding held by already connected clients. Unpublish then
        // publish creates a new binding because there is no prior entry.
        appId: getPersistedWebAppBindingId(previousPublication, publication.uiGraphId),
        uiGraphId: publication.uiGraphId,
        uiGraphName: uiGraph?.name ?? publication.uiGraphId,
        slug: publication.slug,
        publishedSnapshotId,
        publishedAt,
        allowedEmails: publication.allowedEmails ?? previousPublication?.allowedEmails ?? [],
      };
    }),
  ];

  const unusedSnapshotIds = getUnusedPublishedWebAppSnapshotIds({
    previousSnapshotIds,
    nextSnapshotIds: nextPublishedWebApps.map((webApp) => webApp.publishedSnapshotId),
    endpointSnapshotId: existingSettings.publishedSnapshotId,
  });
  const snapshot = await createPublishedWorkflowSnapshotChanges(root, projectPath, publishedSnapshotId);
  await saveFilesystemPublicationTransaction({
    root,
    projectPath,
    changes: [
      ...snapshot.changes,
      createStoredWorkflowProjectSettingsChange(
        projectPath,
        {
          ...existingSettings,
          publishedWebApps: nextPublishedWebApps,
        },
        existingSettings,
      ),
    ],
    cleanupPaths: unusedSnapshotIds.flatMap((snapshotId) =>
      getPublishedWorkflowSnapshotArtifactPaths(root, snapshotId),
    ),
  });

  return getWorkflowProject(root, projectPath);
}

export async function updateWorkflowProjectWebAppAccess(
  relativePath: unknown,
  accessUpdates: unknown,
  preconditions: WorkflowPublicationPreconditions,
) {
  const root = await ensureWorkflowsRoot();
  const projectPath = requireProjectPath(
    resolveWorkflowRelativePath(root, relativePath, {
      allowProjectFile: true,
    }),
  );
  const projectName = path.basename(projectPath, PROJECT_EXTENSION);
  const existingSettings = await readStoredWorkflowProjectSettings(projectPath, projectName);
  await assertFilesystemPublicationPreconditions(projectPath, existingSettings, preconditions, 'set-web-app-access');
  const normalizedAccessUpdates = normalizeWebAppAccessDrafts(accessUpdates);
  const accessByUiGraphId = new Map(normalizedAccessUpdates.map((access) => [access.uiGraphId, access.allowedEmails]));
  const missingUiGraphIds = normalizedAccessUpdates
    .filter((access) => !existingSettings.publishedWebApps.some((webApp) => webApp.uiGraphId === access.uiGraphId))
    .map((access) => access.uiGraphId);
  if (missingUiGraphIds.length > 0) {
    throw createHttpError(404, 'Published web app not found');
  }

  await saveFilesystemPublicationTransaction({
    root,
    projectPath,
    changes: [
      createStoredWorkflowProjectSettingsChange(
        projectPath,
        {
          ...existingSettings,
          publishedWebApps: existingSettings.publishedWebApps.map((webApp) => {
            if (!accessByUiGraphId.has(webApp.uiGraphId)) return webApp;
            return {
              ...webApp,
              appId: getPersistedWebAppBindingId(webApp, webApp.uiGraphId),
              // This endpoint updates only the explicitly selected web apps. Keep
              // every other published app's access list intact instead of silently
              // turning it into an empty allowlist.
              allowedEmails: accessByUiGraphId.get(webApp.uiGraphId) ?? webApp.allowedEmails,
            };
          }),
        },
        existingSettings,
      ),
    ],
  });

  return getWorkflowProject(root, projectPath);
}

export async function unpublishWorkflowProjectWebApp(
  relativePath: unknown,
  uiGraphId: unknown,
  preconditions: WorkflowPublicationPreconditions,
) {
  if (typeof uiGraphId !== 'string' || !uiGraphId.trim()) {
    throw badRequest('Web app selection is required');
  }

  const root = await ensureWorkflowsRoot();
  const projectPath = requireProjectPath(
    resolveWorkflowRelativePath(root, relativePath, {
      allowProjectFile: true,
    }),
  );
  const projectName = path.basename(projectPath, PROJECT_EXTENSION);
  const existingSettings = await readStoredWorkflowProjectSettings(projectPath, projectName);
  await assertFilesystemPublicationPreconditions(projectPath, existingSettings, preconditions, 'unpublish-web-app');
  const normalizedUiGraphId = uiGraphId.trim();
  const removedWebApp = existingSettings.publishedWebApps.find((webApp) => webApp.uiGraphId === normalizedUiGraphId);
  if (!removedWebApp) {
    throw createHttpError(404, 'Published web app not found');
  }

  const nextPublishedWebApps = existingSettings.publishedWebApps.filter(
    (webApp) => webApp.uiGraphId !== normalizedUiGraphId,
  );
  const unusedSnapshotIds = getUnusedPublishedWebAppSnapshotIds({
    previousSnapshotIds: [removedWebApp.publishedSnapshotId],
    nextSnapshotIds: nextPublishedWebApps.map((webApp) => webApp.publishedSnapshotId),
    endpointSnapshotId: existingSettings.publishedSnapshotId,
  });
  await saveFilesystemPublicationTransaction({
    root,
    projectPath,
    changes: [
      createStoredWorkflowProjectSettingsChange(
        projectPath,
        {
          ...existingSettings,
          publishedWebApps: nextPublishedWebApps,
        },
        existingSettings,
      ),
    ],
    cleanupPaths: unusedSnapshotIds.flatMap((snapshotId) =>
      getPublishedWorkflowSnapshotArtifactPaths(root, snapshotId),
    ),
  });

  return getWorkflowProject(root, projectPath);
}
