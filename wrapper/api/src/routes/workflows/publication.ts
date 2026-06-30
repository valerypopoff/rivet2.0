import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { getAggregateWorkflowProjectStatus } from '../../../../shared/workflow-types.js';
import { validatePath } from '../../security.js';
import { badRequest, conflict } from '../../utils/httpError.js';
import {
  getPublishedWorkflowSnapshotDatasetPath,
  getPublishedWorkflowSnapshotMetadataPath,
  getPublishedWorkflowSnapshotPath,
  getWorkflowDatasetPath,
  getWorkflowProjectSettingsPath,
  listProjectPathsRecursive,
  pathExists,
  PROJECT_EXTENSION,
} from './fs-helpers.js';
import type {
  LatestWorkflowMatch,
  PublishedWorkflowMatch,
  PublishedWorkflowWebAppMatch,
  StoredWorkflowPublishedWebApp,
  StoredWorkflowProjectSettings,
  WorkflowProjectSettings,
  WorkflowProjectSettingsDraft,
  WorkflowProjectStatus,
} from './types.js';
import { normalizeStoredEndpointName, normalizeWorkflowEndpointLookupName } from './endpoint-names.js';

export { normalizeStoredEndpointName, normalizeWorkflowEndpointLookupName } from './endpoint-names.js';

let rivetNodeImport: Promise<typeof import('@valerypopoff/rivet2-node')> | null = null;

function getRivetNode() {
  rivetNodeImport ??= import('@valerypopoff/rivet2-node');
  return rivetNodeImport;
}

async function appendWorkflowDatasetContentHash(hash: ReturnType<typeof createHash>, projectPath: string): Promise<void> {
  const datasetPath = getWorkflowDatasetPath(projectPath);

  if (await pathExists(datasetPath)) {
    const datasetContents = await fs.readFile(datasetPath, 'utf8');
    hash.update('\n--dataset--\n').update(datasetContents);
  } else {
    hash.update('\n--dataset-missing--\n');
  }
}

export async function getWorkflowProjectSettings(
  projectPath: string,
  projectName: string,
  options: { root?: string } = {},
): Promise<WorkflowProjectSettings> {
  const storedSettings = await readStoredWorkflowProjectSettings(projectPath, projectName);
  const currentStateHash = await createWorkflowPublicationStateHash(projectPath, storedSettings.endpointName);
  const status = getDerivedWorkflowProjectStatus(storedSettings, currentStateHash);
  const webAppStatuses = options.root
    ? await getPublishedWebAppPublicationStatuses(options.root, projectPath, storedSettings.publishedWebApps)
    : [];

  return {
    status,
    publicationStatus: getAggregateWorkflowProjectStatus(status, webAppStatuses),
    endpointName: storedSettings.endpointName,
    lastPublishedAt: await resolveWorkflowLastPublishedAt(projectPath, storedSettings, status),
    publishedWebApps: storedSettings.publishedWebApps.map((webApp) => ({
      uiGraphId: webApp.uiGraphId,
      uiGraphName: webApp.uiGraphName,
      slug: webApp.slug,
      publishedAt: webApp.publishedAt,
      allowedEmails: webApp.allowedEmails,
    })),
  };
}

async function getPublishedWebAppPublicationStatuses(
  root: string,
  projectPath: string,
  publishedWebApps: readonly StoredWorkflowPublishedWebApp[],
): Promise<WorkflowProjectStatus[]> {
  if (publishedWebApps.length === 0) {
    return [];
  }

  let currentContentHashPromise: Promise<string> | null = null;
  const getCurrentContentHash = () => {
    currentContentHashPromise ??= createWorkflowProjectContentHash(projectPath);
    return currentContentHashPromise;
  };

  const publishedContentHashBySnapshotId = new Map<string, Promise<string>>();

  return Promise.all(publishedWebApps.map(async (webApp) => {
    let publishedContentHashPromise = publishedContentHashBySnapshotId.get(webApp.publishedSnapshotId);
    if (!publishedContentHashPromise) {
      publishedContentHashPromise = createWorkflowProjectContentHash(
        getPublishedWorkflowSnapshotPath(root, webApp.publishedSnapshotId),
      );
      publishedContentHashBySnapshotId.set(webApp.publishedSnapshotId, publishedContentHashPromise);
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
  }));
}

export async function readStoredWorkflowProjectSettings(projectPath: string, _projectName: string): Promise<StoredWorkflowProjectSettings> {
  const settingsPath = getWorkflowProjectSettingsPath(projectPath);

  try {
    const settingsText = await fs.readFile(settingsPath, 'utf8');
    const parsedSettings = JSON.parse(settingsText) as unknown;
    return normalizeStoredWorkflowProjectSettings(parsedSettings);
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === 'ENOENT' || error instanceof SyntaxError) {
      return createDefaultStoredWorkflowProjectSettings();
    }

    throw error;
  }
}

export async function writeStoredWorkflowProjectSettings(projectPath: string, settings: StoredWorkflowProjectSettings): Promise<void> {
  await fs.writeFile(getWorkflowProjectSettingsPath(projectPath), `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

export function createDefaultStoredWorkflowProjectSettings(): StoredWorkflowProjectSettings {
  return {
    endpointName: '',
    publishedEndpointName: '',
    publishedSnapshotId: null,
    publishedStateHash: null,
    lastPublishedAt: null,
    publishedWebApps: [],
  };
}

export function normalizeWorkflowProjectSettingsDraft(value: unknown): WorkflowProjectSettingsDraft {
  const defaults = createDefaultStoredWorkflowProjectSettings();
  const raw = (value ?? {}) as Record<string, unknown>;
  const endpointName = typeof raw.endpointName === 'string' ? raw.endpointName : defaults.endpointName;

  return {
    endpointName: normalizeStoredEndpointName(endpointName),
  };
}

export function normalizeStoredWorkflowProjectSettings(value: unknown): StoredWorkflowProjectSettings {
  const defaults = createDefaultStoredWorkflowProjectSettings();
  const raw = (value ?? {}) as Record<string, unknown>;
  const endpointName = normalizeStoredEndpointName(coerceString(raw.endpointName, defaults.endpointName));
  const publishedSnapshotId = coerceNullableString(raw.publishedSnapshotId, defaults.publishedSnapshotId);
  const publishedStateHash = coerceNullableString(raw.publishedStateHash, defaults.publishedStateHash);
  const lastPublishedAt = coerceNullableString(raw.lastPublishedAt, defaults.lastPublishedAt);
  const legacyStatus = typeof raw.status === 'string' ? raw.status : undefined;

  if (
    legacyStatus != null &&
    legacyStatus !== 'unpublished' &&
    legacyStatus !== 'published' &&
    legacyStatus !== 'unpublished_changes'
  ) {
    throw badRequest('Invalid project status');
  }

  return {
    endpointName,
    publishedEndpointName: normalizeStoredEndpointName(
      coerceString(raw.publishedEndpointName, defaults.publishedEndpointName) || (publishedStateHash ? endpointName : ''),
    ),
    publishedSnapshotId,
    publishedStateHash,
    lastPublishedAt,
    publishedWebApps: normalizeStoredWorkflowPublishedWebApps(raw.publishedWebApps),
    legacyStatus,
  };
}

function normalizeStoredWorkflowPublishedWebApps(value: unknown): StoredWorkflowPublishedWebApp[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seenUiGraphIds = new Set<string>();
  const normalized: StoredWorkflowPublishedWebApp[] = [];

  for (const item of value) {
    const raw = (item ?? {}) as Record<string, unknown>;
    const uiGraphId = coerceString(raw.uiGraphId, '').trim();
    const publishedSnapshotId = coerceString(raw.publishedSnapshotId, '').trim();
    const slug = normalizeStoredEndpointName(coerceString(raw.slug, ''));
    const publishedAt = coerceString(raw.publishedAt, '').trim();

    if (!uiGraphId || !publishedSnapshotId || !slug || !publishedAt || seenUiGraphIds.has(uiGraphId)) {
      continue;
    }

    seenUiGraphIds.add(uiGraphId);
    normalized.push({
      uiGraphId,
      uiGraphName: coerceString(raw.uiGraphName, '').trim() || uiGraphId,
      slug,
      publishedSnapshotId,
      publishedAt,
      allowedEmails: normalizeEmailList(raw.allowedEmails),
    });
  }

  return normalized;
}

export function normalizeEmailList(value: unknown): string[] {
  const rawItems = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\n,;]/)
      : [];
  const seen = new Set<string>();
  const emails: string[] = [];

  for (const item of rawItems) {
    if (typeof item !== 'string') {
      continue;
    }

    const email = item.trim().toLowerCase();
    if (!email || seen.has(email)) {
      continue;
    }

    seen.add(email);
    emails.push(email);
  }

  return emails;
}

export function getDerivedWorkflowProjectStatus(
  settings: StoredWorkflowProjectSettings,
  currentStateHash: string,
): WorkflowProjectStatus {
  if (settings.publishedStateHash) {
    return settings.publishedStateHash === currentStateHash ? 'published' : 'unpublished_changes';
  }

  if (settings.legacyStatus === 'published' || settings.legacyStatus === 'unpublished_changes') {
    return settings.legacyStatus;
  }

  return 'unpublished';
}

async function resolveWorkflowLastPublishedAt(
  projectPath: string,
  settings: StoredWorkflowProjectSettings,
  status: WorkflowProjectStatus,
): Promise<string | null> {
  if (settings.lastPublishedAt) {
    return settings.lastPublishedAt;
  }

  if (status === 'unpublished') {
    return null;
  }

  try {
    const settingsStats = await fs.stat(getWorkflowProjectSettingsPath(projectPath));
    return settingsStats.mtime.toISOString();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

export function hasPublishedWorkflowLineage(settings: StoredWorkflowProjectSettings): boolean {
  if (settings.publishedStateHash || settings.publishedSnapshotId) {
    return true;
  }

  return settings.legacyStatus === 'published' || settings.legacyStatus === 'unpublished_changes';
}

export function isWorkflowEndpointPublished(settings: StoredWorkflowProjectSettings, endpointName: string): boolean {
  if (normalizeWorkflowEndpointLookupName(settings.publishedEndpointName) !== normalizeWorkflowEndpointLookupName(endpointName)) {
    return false;
  }

  if (settings.publishedStateHash) {
    return true;
  }

  return settings.legacyStatus === 'published' || settings.legacyStatus === 'unpublished_changes';
}

export function getReservedWorkflowEndpointLookupNames(settings: StoredWorkflowProjectSettings): Set<string> {
  const lookupNames = new Set<string>();

  if (settings.endpointName && hasPublishedWorkflowLineage(settings)) {
    lookupNames.add(normalizeWorkflowEndpointLookupName(settings.endpointName));
  }

  if (settings.publishedEndpointName && isWorkflowEndpointPublished(settings, settings.publishedEndpointName)) {
    lookupNames.add(normalizeWorkflowEndpointLookupName(settings.publishedEndpointName));
  }

  return lookupNames;
}

export function getReservedWorkflowWebAppSlugLookupNames(settings: StoredWorkflowProjectSettings): Set<string> {
  return new Set(settings.publishedWebApps.map((webApp) => normalizeWorkflowEndpointLookupName(webApp.slug)));
}

export async function ensureWorkflowEndpointNameIsUnique(root: string, currentProjectPath: string, endpointName: string): Promise<void> {
  if (!endpointName) {
    throw badRequest('Endpoint name is required');
  }

  const requestedLookupName = normalizeWorkflowEndpointLookupName(endpointName);

  const projectPaths = await listProjectPathsRecursive(root);

  for (const projectPath of projectPaths) {
    if (projectPath === currentProjectPath) {
      continue;
    }

    const projectName = path.basename(projectPath, PROJECT_EXTENSION);
    const settings = await readStoredWorkflowProjectSettings(projectPath, projectName);

    if (getReservedWorkflowEndpointLookupNames(settings).has(requestedLookupName)) {
      throw conflict(`Endpoint name is already used by ${path.basename(projectPath)}`);
    }
  }
}

export async function ensureWorkflowWebAppSlugIsUnique(
  root: string,
  currentProjectPath: string,
  slug: string,
  currentUiGraphIds?: string | Iterable<string>,
): Promise<void> {
  if (!slug) {
    throw badRequest('Web app slug is required');
  }

  const requestedLookupName = normalizeWorkflowEndpointLookupName(slug);
  const replacementUiGraphIds = new Set(typeof currentUiGraphIds === 'string'
    ? [currentUiGraphIds]
    : currentUiGraphIds ?? []);
  const projectPaths = await listProjectPathsRecursive(root);

  for (const projectPath of projectPaths) {
    const projectName = path.basename(projectPath, PROJECT_EXTENSION);
    const settings = await readStoredWorkflowProjectSettings(projectPath, projectName);

    for (const webApp of settings.publishedWebApps) {
      if (projectPath === currentProjectPath && replacementUiGraphIds.has(webApp.uiGraphId)) {
        continue;
      }

      if (normalizeWorkflowEndpointLookupName(webApp.slug) === requestedLookupName) {
        throw conflict(`Web app URL slug is already used by ${path.basename(projectPath)}`);
      }
    }
  }
}

export async function createWorkflowPublicationStateHash(projectPath: string, endpointName: string): Promise<string> {
  const projectContents = await fs.readFile(projectPath, 'utf8');
  const hash = createHash('sha256').update(endpointName).update('\n').update(projectContents);

  await appendWorkflowDatasetContentHash(hash, projectPath);

  return hash.digest('hex');
}

export async function createWorkflowProjectContentHash(projectPath: string): Promise<string> {
  const projectContents = await fs.readFile(projectPath, 'utf8');
  const hash = createHash('sha256').update(projectContents);

  await appendWorkflowDatasetContentHash(hash, projectPath);

  return hash.digest('hex');
}

export async function writePublishedWorkflowSnapshot(root: string, projectPath: string, snapshotId: string): Promise<void> {
  const publishedProjectPath = getPublishedWorkflowSnapshotPath(root, snapshotId);
  const sourceDatasetPath = getWorkflowDatasetPath(projectPath);
  const publishedDatasetPath = getPublishedWorkflowSnapshotDatasetPath(root, snapshotId);
  await fs.mkdir(path.dirname(publishedProjectPath), { recursive: true });
  await fs.copyFile(projectPath, publishedProjectPath);

  if (await pathExists(sourceDatasetPath)) {
    await fs.copyFile(sourceDatasetPath, publishedDatasetPath);
  } else if (await pathExists(publishedDatasetPath)) {
    await fs.rm(publishedDatasetPath, { force: false });
  }
}

export async function deletePublishedWorkflowSnapshot(root: string, snapshotId: string | null): Promise<void> {
  if (!snapshotId) {
    return;
  }

  const publishedProjectPath = getPublishedWorkflowSnapshotPath(root, snapshotId);
  const publishedDatasetPath = getPublishedWorkflowSnapshotDatasetPath(root, snapshotId);
  const publishedMetadataPath = getPublishedWorkflowSnapshotMetadataPath(root, snapshotId);
  if (await pathExists(publishedProjectPath)) {
    await fs.rm(publishedProjectPath, { force: false });
  }

  if (await pathExists(publishedDatasetPath)) {
    await fs.rm(publishedDatasetPath, { force: false });
  }

  if (await pathExists(publishedMetadataPath)) {
    await fs.rm(publishedMetadataPath, { force: false });
  }
}

export async function resolvePublishedWorkflowProjectPath(
  root: string,
  projectPath: string,
  settings: StoredWorkflowProjectSettings,
): Promise<string | null> {
  if (settings.publishedSnapshotId) {
    const publishedProjectPath = getPublishedWorkflowSnapshotPath(root, settings.publishedSnapshotId);
    if (await pathExists(publishedProjectPath)) {
      return publishedProjectPath;
    }
  }

  if (!settings.publishedEndpointName) {
    return null;
  }

  if (!settings.publishedStateHash) {
    if (settings.legacyStatus === 'published' || settings.legacyStatus === 'unpublished_changes') {
      return projectPath;
    }

    return null;
  }

  const currentStateHash = await createWorkflowPublicationStateHash(projectPath, settings.publishedEndpointName);
  return currentStateHash === settings.publishedStateHash ? projectPath : null;
}

export async function findPublishedWorkflowByEndpoint(root: string, endpointName: string): Promise<PublishedWorkflowMatch | null> {
  const matches = await listPublishedWorkflowMatchesByEndpoint(root, endpointName);
  for (const match of matches) {
    const publishedProjectPath = await resolvePublishedWorkflowProjectPath(root, match.projectPath, match.settings);
    if (!publishedProjectPath) {
      continue;
    }

    return {
      endpointName,
      projectPath: match.projectPath,
      publishedProjectPath,
    };
  }

  return null;
}

export async function findPublishedWorkflowWebAppBySlug(root: string, slug: string): Promise<PublishedWorkflowWebAppMatch | null> {
  const requestedLookupName = normalizeWorkflowEndpointLookupName(slug);
  const projectPaths = await listProjectPathsRecursive(root);

  for (const projectPath of projectPaths) {
    const projectName = path.basename(projectPath, PROJECT_EXTENSION);
    const settings = await readStoredWorkflowProjectSettings(projectPath, projectName);
    const webApp = settings.publishedWebApps.find((candidate) =>
      normalizeWorkflowEndpointLookupName(candidate.slug) === requestedLookupName);

    if (!webApp) {
      continue;
    }

    const publishedProjectPath = getPublishedWorkflowSnapshotPath(root, webApp.publishedSnapshotId);
    if (!await pathExists(publishedProjectPath)) {
      continue;
    }

    return {
      slug: webApp.slug,
      uiGraphId: webApp.uiGraphId,
      allowedEmails: webApp.allowedEmails,
      projectPath,
      publishedProjectPath,
    };
  }

  return null;
}

export async function findLatestWorkflowByEndpoint(root: string, endpointName: string): Promise<LatestWorkflowMatch | null> {
  const [match] = await listLatestWorkflowMatchesByEndpoint(root, endpointName);
  if (!match) {
    return null;
  }

  return {
    endpointName,
    projectPath: match.projectPath,
  };
}

async function listPublishedWorkflowMatchesByEndpoint(
  root: string,
  endpointName: string,
): Promise<Array<{ projectPath: string; settings: StoredWorkflowProjectSettings }>> {
  const projectPaths = await listProjectPathsRecursive(root);
  const matches: Array<{ projectPath: string; settings: StoredWorkflowProjectSettings }> = [];

  for (const projectPath of projectPaths) {
    const projectName = path.basename(projectPath, PROJECT_EXTENSION);
    const settings = await readStoredWorkflowProjectSettings(projectPath, projectName);

    if (!isWorkflowEndpointPublished(settings, endpointName)) {
      continue;
    }

    matches.push({ projectPath, settings });
  }

  return matches;
}

async function listLatestWorkflowMatchesByEndpoint(
  root: string,
  endpointName: string,
): Promise<Array<{ projectPath: string; settings: StoredWorkflowProjectSettings }>> {
  const requestedLookupName = normalizeWorkflowEndpointLookupName(endpointName);
  const projectPaths = await listProjectPathsRecursive(root);
  const matches: Array<{ projectPath: string; settings: StoredWorkflowProjectSettings }> = [];

  for (const projectPath of projectPaths) {
    const projectName = path.basename(projectPath, PROJECT_EXTENSION);
    const settings = await readStoredWorkflowProjectSettings(projectPath, projectName);

    if (!settings.endpointName) {
      continue;
    }

    if (!hasPublishedWorkflowLineage(settings)) {
      continue;
    }

    if (normalizeWorkflowEndpointLookupName(settings.endpointName) !== requestedLookupName) {
      continue;
    }

    matches.push({ projectPath, settings });
  }

  return matches;
}

function coerceString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function coerceNullableString(value: unknown, fallback: string | null): string | null {
  if (typeof value === 'string') {
    return value;
  }

  return value === null ? null : fallback;
}

export async function loadPublishedOrLiveProjectFromFilesystem(root: string, resolvedProjectPath: string) {
  const projectName = path.basename(resolvedProjectPath, PROJECT_EXTENSION);
  const settings = await readStoredWorkflowProjectSettings(resolvedProjectPath, projectName);
  const publishedProjectPath = await resolvePublishedWorkflowProjectPath(root, resolvedProjectPath, settings);
  const { loadProjectFromFile } = await getRivetNode();
  return loadProjectFromFile(publishedProjectPath ?? resolvedProjectPath);
}

export function createPublishedWorkflowProjectReferenceLoader(root: string, rootProjectPath: string) {
  const projectPathByIdPromises = new Map<string, Promise<string | null>>();

  const findProjectPathByProjectId = async (projectId: string): Promise<string | null> => {
    let pendingResolution = projectPathByIdPromises.get(projectId);
    if (!pendingResolution) {
      pendingResolution = (async () => {
        const projectPaths = await listProjectPathsRecursive(root);
        const { loadProjectFromFile } = await getRivetNode();

        for (const candidateProjectPath of projectPaths) {
          try {
            const candidateProject = await loadProjectFromFile(candidateProjectPath);
            if (candidateProject.metadata.id === projectId) {
              return candidateProjectPath;
            }
          } catch {
          }
        }

        return null;
      })();
      projectPathByIdPromises.set(projectId, pendingResolution);
    }

    return pendingResolution;
  };

  return {
    async loadProject(currentProjectPath: string | undefined, reference: { id: string; hintPaths?: string[]; title?: string }) {
      const baseProjectPath = currentProjectPath ?? rootProjectPath;

      for (const hintPath of reference.hintPaths ?? []) {
        try {
          const resolvedProjectPath = validatePath(path.resolve(path.dirname(baseProjectPath), hintPath));
          if (!resolvedProjectPath.endsWith(PROJECT_EXTENSION)) {
            continue;
          }

          return await loadPublishedOrLiveProjectFromFilesystem(root, resolvedProjectPath);
        } catch {
        }
      }

      const resolvedProjectPathById = await findProjectPathByProjectId(reference.id);
      if (resolvedProjectPathById) {
        return loadPublishedOrLiveProjectFromFilesystem(root, resolvedProjectPathById);
      }

      throw new Error(
        `Could not load project "${reference.title ?? reference.id} (${reference.id})": all hint paths failed. Tried: ${reference.hintPaths}`,
      );
    },
  };
}
