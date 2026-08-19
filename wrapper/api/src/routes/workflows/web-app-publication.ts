import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { loadProjectFromFile } from '@valerypopoff/rivet2-node';

import type {
  WorkflowProjectWebAppAccessDraft,
  WorkflowProjectWebAppPublicationDraft,
  WorkflowProjectWebAppsResponse,
} from '../../../../shared/workflow-types.js';
import { badRequest, createHttpError } from '../../utils/httpError.js';
import {
  createWorkflowProjectContentHash,
  deletePublishedWorkflowSnapshot,
  ensureWorkflowWebAppSlugIsUnique,
  normalizeEmailList,
  normalizeStoredEndpointName,
  readStoredWorkflowProjectSettings,
  writePublishedWorkflowSnapshot,
  writeStoredWorkflowProjectSettings,
} from './publication.js';
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

type UiGraphSummary = {
  uiGraphId: string;
  name: string;
};

type WebAppStatus = WorkflowProjectWebAppsResponse['webApps'][number]['status'];

function getProjectUiGraphSummaries(project: Awaited<ReturnType<typeof loadProjectFromFile>>): UiGraphSummary[] {
  return Object.entries(project.uiGraphs ?? {}).map(([uiGraphId, uiGraph]) => ({
    uiGraphId,
    name: typeof uiGraph?.name === 'string' && uiGraph.name.trim()
      ? uiGraph.name.trim()
      : uiGraphId,
  }));
}

function validateAllowedEmailList(allowedEmails: string[]): void {
  for (const email of allowedEmails) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw badRequest(`Invalid allowed email: ${email}`);
    }
  }
}

function assertUsableWebAppSlug(slug: string): void {
  if (slug.toLowerCase() === 'auth') {
    throw badRequest('Web app URL slug "auth" is reserved');
  }
}

function normalizeWebAppPublicationDrafts(
  value: unknown,
  existingWebApps: readonly StoredWorkflowPublishedWebApp[] = [],
): WorkflowProjectWebAppPublicationDraft[] {
  const rawPublications = (value ?? []) as unknown;
  if (!Array.isArray(rawPublications)) {
    throw badRequest('Web app publications must be an array');
  }

  const existingByUiGraphId = new Map(existingWebApps.map((webApp) => [webApp.uiGraphId, webApp]));
  const normalized = rawPublications.map((item) => {
    const raw = (item ?? {}) as Record<string, unknown>;
    const uiGraphId = typeof raw.uiGraphId === 'string' ? raw.uiGraphId.trim() : '';
    const allowedEmails = Object.prototype.hasOwnProperty.call(raw, 'allowedEmails')
      ? normalizeEmailList(raw.allowedEmails)
      : existingByUiGraphId.get(uiGraphId)?.allowedEmails ?? [];
    validateAllowedEmailList(allowedEmails);
    return {
      uiGraphId,
      slug: normalizeStoredEndpointName(typeof raw.slug === 'string' ? raw.slug : ''),
      allowedEmails,
    };
  });

  if (normalized.length === 0) {
    throw badRequest('At least one web app must be selected');
  }

  const seenUiGraphIds = new Set<string>();
  const seenSlugs = new Set<string>();
  for (const publication of normalized) {
    if (!publication.uiGraphId) {
      throw badRequest('Web app selection is required');
    }

    if (!publication.slug) {
      throw badRequest('Web app URL slug is required');
    }
    assertUsableWebAppSlug(publication.slug);

    const slugLookup = publication.slug.toLowerCase();
    if (seenUiGraphIds.has(publication.uiGraphId)) {
      throw badRequest('Each web app can only be published once per request');
    }

    if (seenSlugs.has(slugLookup)) {
      throw badRequest('Each web app URL slug must be unique');
    }

    seenUiGraphIds.add(publication.uiGraphId);
    seenSlugs.add(slugLookup);
  }

  return normalized;
}

function normalizeWebAppAccessDrafts(value: unknown): WorkflowProjectWebAppAccessDraft[] {
  const rawAccess = (value ?? []) as unknown;
  if (!Array.isArray(rawAccess)) {
    throw badRequest('Web app access updates must be an array');
  }

  const normalized = rawAccess.map((item) => {
    const raw = (item ?? {}) as Record<string, unknown>;
    const allowedEmails = normalizeEmailList(raw.allowedEmails);
    validateAllowedEmailList(allowedEmails);
    return {
      uiGraphId: typeof raw.uiGraphId === 'string' ? raw.uiGraphId.trim() : '',
      allowedEmails,
    };
  });

  if (normalized.length === 0) {
    throw badRequest('At least one web app access update is required');
  }

  const seenUiGraphIds = new Set<string>();
  for (const access of normalized) {
    if (!access.uiGraphId) {
      throw badRequest('Web app selection is required');
    }

    if (seenUiGraphIds.has(access.uiGraphId)) {
      throw badRequest('Each web app access policy can only be updated once per request');
    }

    seenUiGraphIds.add(access.uiGraphId);
  }

  return normalized;
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
  const projectPath = requireProjectPath(resolveWorkflowRelativePath(root, relativePath, {
    allowProjectFile: true,
  }));
  const projectName = path.basename(projectPath, PROJECT_EXTENSION);
  const [project, settings] = await Promise.all([
    loadProjectFromFile(projectPath),
    readStoredWorkflowProjectSettings(projectPath, projectName),
  ]);
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
    hasMainGraph: hasProjectMainGraph(project),
    webApps: [
      ...(await Promise.all(currentUiGraphs.map(async (uiGraph) => {
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
      }))),
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

export async function publishWorkflowProjectWebApps(relativePath: unknown, publications: unknown) {
  const root = await ensureWorkflowsRoot();
  const projectPath = requireProjectPath(resolveWorkflowRelativePath(root, relativePath, {
    allowProjectFile: true,
  }));
  const projectName = path.basename(projectPath, PROJECT_EXTENSION);
  const [project, existingSettings] = await Promise.all([
    loadProjectFromFile(projectPath),
    readStoredWorkflowProjectSettings(projectPath, projectName),
  ]);
  const availableUiGraphs = new Map(getProjectUiGraphSummaries(project).map((uiGraph) => [uiGraph.uiGraphId, uiGraph]));
  const normalizedPublications = normalizeWebAppPublicationDrafts(publications, existingSettings.publishedWebApps);
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
      return {
        uiGraphId: publication.uiGraphId,
        uiGraphName: uiGraph?.name ?? publication.uiGraphId,
        slug: publication.slug,
        publishedSnapshotId,
        publishedAt,
        allowedEmails: publication.allowedEmails ?? [],
      };
    }),
  ];

  try {
    await writePublishedWorkflowSnapshot(root, projectPath, publishedSnapshotId);
    await writeStoredWorkflowProjectSettings(projectPath, {
      ...existingSettings,
      publishedWebApps: nextPublishedWebApps,
    });
  } catch (error) {
    await deletePublishedWorkflowSnapshot(root, publishedSnapshotId).catch(() => {});
    throw error;
  }

  const unusedSnapshotIds = getUnusedPublishedWebAppSnapshotIds({
    previousSnapshotIds,
    nextSnapshotIds: nextPublishedWebApps.map((webApp) => webApp.publishedSnapshotId),
    endpointSnapshotId: existingSettings.publishedSnapshotId,
  });
  await Promise.all(unusedSnapshotIds.map((snapshotId) =>
    deletePublishedWorkflowSnapshot(root, snapshotId).catch(() => {})));

  return getWorkflowProject(root, projectPath);
}

export async function updateWorkflowProjectWebAppAccess(relativePath: unknown, accessUpdates: unknown) {
  const root = await ensureWorkflowsRoot();
  const projectPath = requireProjectPath(resolveWorkflowRelativePath(root, relativePath, {
    allowProjectFile: true,
  }));
  const projectName = path.basename(projectPath, PROJECT_EXTENSION);
  const existingSettings = await readStoredWorkflowProjectSettings(projectPath, projectName);
  const normalizedAccessUpdates = normalizeWebAppAccessDrafts(accessUpdates);
  const accessByUiGraphId = new Map(normalizedAccessUpdates.map((access) => [access.uiGraphId, access.allowedEmails]));
  const missingUiGraphIds = normalizedAccessUpdates
    .filter((access) => !existingSettings.publishedWebApps.some((webApp) => webApp.uiGraphId === access.uiGraphId))
    .map((access) => access.uiGraphId);
  if (missingUiGraphIds.length > 0) {
    throw createHttpError(404, 'Published web app not found');
  }

  await writeStoredWorkflowProjectSettings(projectPath, {
    ...existingSettings,
    publishedWebApps: existingSettings.publishedWebApps.map((webApp) => {
      if (!accessByUiGraphId.has(webApp.uiGraphId)) {
        return webApp;
      }

      return { ...webApp, allowedEmails: accessByUiGraphId.get(webApp.uiGraphId) ?? [] };
    }),
  });

  return getWorkflowProject(root, projectPath);
}

export async function unpublishWorkflowProjectWebApp(relativePath: unknown, uiGraphId: unknown) {
  if (typeof uiGraphId !== 'string' || !uiGraphId.trim()) {
    throw badRequest('Web app selection is required');
  }

  const root = await ensureWorkflowsRoot();
  const projectPath = requireProjectPath(resolveWorkflowRelativePath(root, relativePath, {
    allowProjectFile: true,
  }));
  const projectName = path.basename(projectPath, PROJECT_EXTENSION);
  const existingSettings = await readStoredWorkflowProjectSettings(projectPath, projectName);
  const normalizedUiGraphId = uiGraphId.trim();
  const removedWebApp = existingSettings.publishedWebApps.find((webApp) => webApp.uiGraphId === normalizedUiGraphId);
  if (!removedWebApp) {
    throw createHttpError(404, 'Published web app not found');
  }

  const nextPublishedWebApps = existingSettings.publishedWebApps.filter((webApp) => webApp.uiGraphId !== normalizedUiGraphId);
  await writeStoredWorkflowProjectSettings(projectPath, {
    ...existingSettings,
    publishedWebApps: nextPublishedWebApps,
  });

  const unusedSnapshotIds = getUnusedPublishedWebAppSnapshotIds({
    previousSnapshotIds: [removedWebApp.publishedSnapshotId],
    nextSnapshotIds: nextPublishedWebApps.map((webApp) => webApp.publishedSnapshotId),
    endpointSnapshotId: existingSettings.publishedSnapshotId,
  });
  await Promise.all(unusedSnapshotIds.map((snapshotId) =>
    deletePublishedWorkflowSnapshot(root, snapshotId).catch(() => {})));

  return getWorkflowProject(root, projectPath);
}
