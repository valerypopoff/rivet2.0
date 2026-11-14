import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  deserializeDatasets,
  loadProjectAndAttachedDataFromFile,
  loadProjectAndAttachedDataFromString,
  NodeDatasetProvider,
  type ProjectReferenceLoader,
  type SubgraphProjectTarget,
  type ResolvedSubgraphProject,
} from '@valerypopoff/rivet2-node';
import type { WorkflowProjectPathMove } from '@valerypopoff/rivet-studio-server-shared/workflow-types.js';
import type { WorkflowExecutionDefinition, WorkflowWebAppAccessPolicy as WebAppAccessPolicy } from './data-backend.js';
import { createHttpError } from '../../utils/httpError.js';
import { getWorkflowsRoot } from '../../security.js';
import {
  ensureWorkflowsRoot,
  getPublishedWorkflowSnapshotPath,
  getWorkflowDatasetPath,
  pathExists,
  PROJECT_EXTENSION,
} from './fs-helpers.js';
import {
  createPublishedWorkflowProjectReferenceLoader,
  findPublishedWorkflowWebAppBySlug,
  normalizeWorkflowEndpointLookupName,
  readStoredWorkflowProjectSettings,
  resolvePublishedWorkflowProjectPath,
} from './publication.js';
import { getFilesystemExecutionCache } from './filesystem-execution-cache.js';
import { withFilesystemWorkflowStorageRead } from './filesystem-project-transactions.js';
import { notifyWebAppSocketPolicyInvalidation } from './web-app-policy-invalidation.js';
import { workflowFailure } from './workflow-failure.js';
import { findFilesystemProjectPathsByMetadataId } from './filesystem-project-identity.js';

async function loadFilesystemWithMissingRootRetry<T>(load: (root: string) => Promise<T>): Promise<T> {
  const root = getWorkflowsRoot();

  try {
    return await load(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }

    if (await pathExists(root)) {
      throw error;
    }

    const ensuredRoot = await ensureWorkflowsRoot();
    getFilesystemExecutionCache().reset(ensuredRoot);
    return load(ensuredRoot);
  }
}

async function createFilesystemPublishedWebAppRevisionKey(
  sourceProjectPath: string,
  publishedProjectPath: string,
  slug: string,
  uiGraphId: string,
): Promise<string> {
  const hash = createHash('sha256');
  for (const filePath of [publishedProjectPath, getWorkflowDatasetPath(publishedProjectPath)]) {
    const signature = await fs.stat(filePath).then(
      (stats) => `${stats.isFile() ? 'file' : 'other'}:${stats.size}:${stats.mtimeMs}`,
      (error) => ((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : Promise.reject(error)),
    );
    hash.update(signature);
    hash.update('\0');
  }
  hash.update(sourceProjectPath);
  hash.update('\0');
  hash.update(publishedProjectPath);
  hash.update('\0');
  hash.update(slug);
  hash.update('\0');
  hash.update(uiGraphId);
  return `filesystem-web-app:${hash.digest('hex').slice(0, 32)}`;
}

async function loadFilesystemWebAppExecutionProject(
  root: string,
  slug: string,
  version: 'published' | 'latest',
): Promise<WorkflowExecutionDefinition | null> {
  const match = await findPublishedWorkflowWebAppBySlug(root, slug);
  if (!match) {
    return null;
  }

  const executionProjectPath = version === 'published' ? match.publishedProjectPath : match.projectPath;
  const [project, attachedData] = await loadProjectAndAttachedDataFromFile(executionProjectPath);
  const datasetPath = getWorkflowDatasetPath(executionProjectPath);
  const datasetsContents = (await pathExists(datasetPath)) ? await fs.readFile(datasetPath, 'utf8') : null;
  const datasetProvider = new NodeDatasetProvider(datasetsContents ? deserializeDatasets(datasetsContents) : []);

  return {
    project,
    attachedData,
    datasetProvider,
    projectVirtualPath: match.projectPath,
    revisionKey: await createFilesystemPublishedWebAppRevisionKey(
      match.projectPath,
      executionProjectPath,
      match.slug,
      match.uiGraphId,
    ),
    webAppUiGraphId: match.uiGraphId,
    webAppAllowedEmails: match.allowedEmails,
    webAppBindingId: `filesystem:${match.appId}`,
    webAppPolicyInvalidationKey: `filesystem:${path.resolve(match.projectPath)}`,
  };
}

async function resolveFilesystemWebAppAccessPolicy(
  root: string,
  slug: string,
  expectedProjectVirtualPath: string | undefined,
): Promise<WebAppAccessPolicy | null> {
  if (!expectedProjectVirtualPath) return null;

  // Socket execution captured this absolute path from Rivet's own project
  // resolver. Re-read only that project's small settings file: a periodic
  // authorization check must not validate or deserialize every project in the
  // workspace just to confirm one app's current publication policy.
  const projectPath = path.resolve(expectedProjectVirtualPath);
  const relativePath = path.relative(root, projectPath);
  if (
    !projectPath.endsWith(PROJECT_EXTENSION) ||
    relativePath === '' ||
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    return null;
  }

  const projectName = path.basename(projectPath, PROJECT_EXTENSION);
  const settings = await readStoredWorkflowProjectSettings(projectPath, projectName);
  const lookupName = normalizeWorkflowEndpointLookupName(slug);
  const webApp = settings.publishedWebApps.find(
    (candidate) => normalizeWorkflowEndpointLookupName(candidate.slug) === lookupName,
  );
  if (!webApp || !(await pathExists(getPublishedWorkflowSnapshotPath(root, webApp.publishedSnapshotId)))) {
    return null;
  }

  return {
    projectVirtualPath: projectPath,
    uiGraphId: webApp.uiGraphId,
    allowedEmails: webApp.allowedEmails,
    bindingId: `filesystem:${webApp.appId}`,
  };
}

export function invalidateFilesystemExecutionMaterializations(projectPaths: Iterable<string>): void {
  getFilesystemExecutionCache().invalidateProjectMaterializations(projectPaths);
}

export function markFilesystemExecutionStructureDirty(projectPathsToInvalidate: Iterable<string> = []): void {
  const projectPaths = [...projectPathsToInvalidate];
  const cache = getFilesystemExecutionCache();
  cache.markIndexDirty();
  cache.invalidateProjectMaterializations(projectPaths);
  for (const projectPath of projectPaths) {
    notifyWebAppSocketPolicyInvalidation(`filesystem:${path.resolve(projectPath)}`);
  }
}

export function invalidateFilesystemExecutionMove(movedProjectPaths: WorkflowProjectPathMove[]): void {
  if (movedProjectPaths.length === 0) {
    return;
  }

  markFilesystemExecutionStructureDirty(
    movedProjectPaths.flatMap(({ fromAbsolutePath, toAbsolutePath }) => [fromAbsolutePath, toAbsolutePath]),
  );
}

export function resolveLegacyPublishedExecutionProject(
  endpointName: string,
): Promise<WorkflowExecutionDefinition | null> {
  return withFilesystemWorkflowStorageRead(() =>
    loadFilesystemWithMissingRootRetry((root) =>
      getFilesystemExecutionCache().loadPublishedExecutionProject(root, endpointName),
    ),
  );
}

export function resolveLegacyLatestExecutionProject(endpointName: string): Promise<WorkflowExecutionDefinition | null> {
  return withFilesystemWorkflowStorageRead(() =>
    loadFilesystemWithMissingRootRetry((root) =>
      getFilesystemExecutionCache().loadLatestExecutionProject(root, endpointName),
    ),
  );
}

export function resolveLegacyPublishedWebAppExecutionProject(
  slug: string,
): Promise<WorkflowExecutionDefinition | null> {
  return withFilesystemWorkflowStorageRead(() =>
    loadFilesystemWithMissingRootRetry((root) => loadFilesystemWebAppExecutionProject(root, slug, 'published')),
  );
}

export function resolveLegacyLatestWebAppExecutionProject(slug: string): Promise<WorkflowExecutionDefinition | null> {
  return withFilesystemWorkflowStorageRead(() =>
    loadFilesystemWithMissingRootRetry((root) => loadFilesystemWebAppExecutionProject(root, slug, 'latest')),
  );
}

export function resolveLegacyWebAppAccessPolicy(
  slug: string,
  expectedProjectVirtualPath?: string,
): Promise<WebAppAccessPolicy | null> {
  return withFilesystemWorkflowStorageRead(() =>
    loadFilesystemWithMissingRootRetry((root) =>
      resolveFilesystemWebAppAccessPolicy(root, slug, expectedProjectVirtualPath),
    ),
  );
}

export async function createLegacyExecutionProjectReferenceLoader(
  projectPath: string,
): Promise<ProjectReferenceLoader> {
  const loader = createPublishedWorkflowProjectReferenceLoader(getWorkflowsRoot(), projectPath);
  return {
    loadProject: (...args: Parameters<typeof loader.loadProject>) =>
      withFilesystemWorkflowStorageRead(() => loader.loadProject(...args)),
  };
}

export function loadLegacySubgraphTarget(target: SubgraphProjectTarget): Promise<ResolvedSubgraphProject> {
  return withFilesystemWorkflowStorageRead(async () => {
    const root = getWorkflowsRoot();
    const matches = await findFilesystemProjectPathsByMetadataId(root, target.projectId);
    if (matches.length > 1) {
      throw createHttpError(409, `Subgraph project ${target.projectId} has multiple saved locations.`);
    }
    const selectedPath = matches[0];
    if (!selectedPath) throw createHttpError(404, `Subgraph project ${target.projectId} was not found.`);
    let artifactPath = selectedPath;
    if (target.version === 'published') {
      const settings = await readStoredWorkflowProjectSettings(
        selectedPath,
        path.basename(selectedPath, PROJECT_EXTENSION),
      );
      const publishedPath = await resolvePublishedWorkflowProjectPath(root, selectedPath, settings);
      if (!publishedPath)
        throw workflowFailure(
          'workflow_publication_missing',
          `Subgraph project ${target.projectId} has no published version.`,
        );
      artifactPath = publishedPath;
    }
    const projectContents = await fs.readFile(artifactPath, 'utf8');
    const [project] = loadProjectAndAttachedDataFromString(projectContents);
    if (project.metadata.id !== target.projectId) {
      throw createHttpError(500, `Subgraph project ${target.projectId} has a mismatched saved identity.`);
    }
    const datasetPath = getWorkflowDatasetPath(artifactPath);
    const datasetsContents = (await pathExists(datasetPath)) ? await fs.readFile(datasetPath, 'utf8') : null;
    return {
      project,
      datasetProvider: new NodeDatasetProvider(datasetsContents ? deserializeDatasets(datasetsContents) : []),
      revisionKey: `${target.version}:${createHash('sha256')
        .update(projectContents)
        .update('\0')
        .update(datasetsContents ?? '')
        .digest('hex')}`,
      projectContents,
      datasetsContents: datasetsContents ?? undefined,
      sourceProjectPath: selectedPath,
    };
  });
}
