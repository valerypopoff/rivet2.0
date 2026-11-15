import fs from 'node:fs/promises';
import path from 'node:path';
import {
  deserializeDatasets,
  loadProjectAndAttachedDataFromFile,
  loadProjectAndAttachedDataFromString,
  type Project,
  type ProjectId,
} from '@valerypopoff/rivet2-node';
import type { WorkflowProjectItem } from '@valerypopoff/rivet-studio-server-shared/workflow-types.js';
import type {
  HostedProjectStorageLoadResult,
  HostedProjectStorageSaveResult,
  HostedProjectStorageSaveOptions,
} from './data-backend.js';
import { createHttpError } from '../../utils/httpError.js';
import { getWorkflowsRoot } from '../../security.js';
import { isVmMigrationMaintenanceActive } from '../../vm-migration-maintenance.js';
import {
  ensureWorkflowsRoot,
  getWorkflowDatasetPath,
  pathExists,
  PROJECT_EXTENSION,
  requireProjectPath,
} from './fs-helpers.js';
import { listWorkflowFolders, listWorkflowProjects } from './workflow-query.js';
import {
  saveFilesystemProjectTransaction,
  withFilesystemWorkflowProjectRead,
  withFilesystemWorkflowStorageRead,
} from './filesystem-project-transactions.js';
import { normalizeHostedProjectTitle, parseHostedProjectContents } from './hosted-project-contents.js';
import { getFilesystemProjectRevisionId, writeWorkflowProjectStatsCacheFromContents } from './project-stats.js';
import { workflowFailure } from './workflow-failure.js';
import { findFilesystemProjectPathsByMetadataId } from './filesystem-project-identity.js';

function mapHostedProjectFilesystemError(error: unknown, operation: 'read' | 'write', projectPath: string): Error {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code !== 'EACCES' && code !== 'EPERM') {
    return error instanceof Error ? error : new Error(String(error));
  }

  const targetDir = path.dirname(projectPath).replace(/\\/g, '/');
  return createHttpError(
    500,
    operation === 'write'
      ? `Workflow storage is not writable. Check server permissions for ${targetDir}.`
      : `Workflow storage is not readable. Check server permissions for ${targetDir}.`,
    { expose: true },
  );
}

function assertMatchingHostedProjectIdentity(
  project: Project,
  expectedProjectId: ProjectId,
  projectPath: string,
): void {
  if (!project.metadata.id || project.metadata.id !== expectedProjectId) {
    throw workflowFailure(
      'workflow_project_mismatch',
      `The save target ${projectPath} belongs to a different project.`,
    );
  }
}

function resolveFilesystemProjectPathInsideRoot(root: string, projectPath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(projectPath);
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw createHttpError(400, 'Project path must stay inside workflow storage.', { expose: true });
  }
  return requireProjectPath(resolvedPath);
}

async function resolveFilesystemInPlaceSaveTarget(
  root: string,
  requestedProjectPath: string,
  sourceProjectId: ProjectId,
): Promise<string> {
  const requestedPath = resolveFilesystemProjectPathInsideRoot(root, requestedProjectPath);
  if (await pathExists(requestedPath)) {
    try {
      const [requestedProject] = await loadProjectAndAttachedDataFromFile(requestedPath);
      if (requestedProject.metadata.id === sourceProjectId) {
        return requestedPath;
      }
    } catch {
      // Fall through to the authoritative id scan. A moved project may have
      // left a different or malformed file at its old location.
    }
  }

  const matches = await findFilesystemProjectPathsByMetadataId(root, sourceProjectId);
  if (matches.length === 1) {
    return matches[0]!;
  }
  if (matches.length === 0) {
    throw createHttpError(409, 'This project no longer exists at its saved location. Reopen it or use Save As.', {
      expose: true,
    });
  }
  throw createHttpError(
    409,
    'Could not determine a unique current location for this project. Reopen it before saving.',
    {
      expose: true,
    },
  );
}

export async function getLegacyWorkflowTree() {
  const root = isVmMigrationMaintenanceActive() ? getWorkflowsRoot() : await ensureWorkflowsRoot();
  return withFilesystemWorkflowStorageRead(async () => ({
    root,
    folders: await listWorkflowFolders(root),
    projects: await listWorkflowProjects(root),
  }));
}

export async function listLegacyHostedProjectPaths(): Promise<string[]> {
  const root = await ensureWorkflowsRoot();
  return withFilesystemWorkflowStorageRead(async () => {
    const projects = await listWorkflowProjects(root);
    const folders = await listWorkflowFolders(root);
    const nestedProjects = folders.flatMap(function flatten(folder): WorkflowProjectItem[] {
      return [...folder.projects, ...folder.folders.flatMap(flatten)];
    });
    return [...projects, ...nestedProjects].map((project) => project.absolutePath);
  });
}

export async function loadLegacyHostedProject(projectPath: string): Promise<HostedProjectStorageLoadResult> {
  try {
    const root = await ensureWorkflowsRoot();
    return await withFilesystemWorkflowProjectRead(root, projectPath, async () => {
      const contents = await fs.readFile(projectPath, 'utf8');
      loadProjectAndAttachedDataFromString(contents);
      const datasetPath = getWorkflowDatasetPath(projectPath);
      const datasetsContents = (await pathExists(datasetPath)) ? await fs.readFile(datasetPath, 'utf8') : null;

      return {
        contents,
        datasetsContents,
        revisionId: getFilesystemProjectRevisionId(contents, datasetsContents),
      };
    });
  } catch (error) {
    throw mapHostedProjectFilesystemError(error, 'read', projectPath);
  }
}

export async function saveLegacyHostedProject(
  options: HostedProjectStorageSaveOptions,
  invalidateFilesystemExecutionMaterializations: (projectPaths: Iterable<string>) => void,
): Promise<HostedProjectStorageSaveResult> {
  try {
    const parsed = parseHostedProjectContents(options.contents, 'Could not save project');
    const sourceProjectId = parsed.project.metadata.id;
    if (!sourceProjectId) {
      throw createHttpError(400, 'Could not save project', { expose: true });
    }
    if (options.projectId && options.projectId !== sourceProjectId) {
      throw createHttpError(400, 'Project identity does not match the submitted project contents.', {
        expose: true,
      });
    }
    if (options.datasetsContents != null) {
      try {
        deserializeDatasets(options.datasetsContents);
      } catch {
        throw createHttpError(400, 'Could not save datasets', { expose: true });
      }
    }

    const root = await ensureWorkflowsRoot();
    let targetAlreadyExists = false;
    let savedProjectPath = options.projectPath;
    let savedContents = options.contents;
    await saveFilesystemProjectTransaction({
      root,
      projectPath: options.projectPath,
      projectContents: options.contents,
      datasetsContents: options.datasetsContents,
      resolveProjectTarget: async () => {
        const projectPath =
          options.saveIntent === 'in-place'
            ? await resolveFilesystemInPlaceSaveTarget(root, options.projectPath, sourceProjectId)
            : resolveFilesystemProjectPathInsideRoot(root, options.projectPath);
        savedProjectPath = projectPath;
        const projectName = path.basename(projectPath, PROJECT_EXTENSION);
        savedContents = normalizeHostedProjectTitle(options.contents, projectName, 'Could not save project').contents;
        return { projectPath, projectContents: savedContents };
      },
      beforeTransaction: async () => {
        targetAlreadyExists = await pathExists(savedProjectPath);
        if (!targetAlreadyExists) return;

        let targetProject: Project;
        try {
          [targetProject] = await loadProjectAndAttachedDataFromFile(savedProjectPath);
        } catch {
          throw createHttpError(409, 'Could not verify the existing save target. Reopen it before saving.', {
            expose: true,
          });
        }
        assertMatchingHostedProjectIdentity(targetProject, sourceProjectId, savedProjectPath);

        if (options.saveIntent !== 'in-place' || !options.expectedRevisionId) {
          return;
        }

        const currentContents = await fs.readFile(savedProjectPath, 'utf8');
        const datasetPath = getWorkflowDatasetPath(savedProjectPath);
        const currentDatasetsContents = (await pathExists(datasetPath)) ? await fs.readFile(datasetPath, 'utf8') : null;
        if (getFilesystemProjectRevisionId(currentContents, currentDatasetsContents) !== options.expectedRevisionId) {
          throw createHttpError(409, 'Project has changed since it was opened. Reload it before saving again.', {
            expose: true,
          });
        }
      },
      afterCommit: async () => {
        try {
          await writeWorkflowProjectStatsCacheFromContents(savedProjectPath, savedContents, options.datasetsContents);
        } finally {
          // The statistics cache is derived and may be rebuilt later. The
          // execution materialization is not: always discard it so a
          // committed project can never keep serving its old graph merely
          // because updating derived statistics failed.
          invalidateFilesystemExecutionMaterializations([savedProjectPath]);
        }
      },
    });

    return {
      path: savedProjectPath,
      revisionId: getFilesystemProjectRevisionId(savedContents, options.datasetsContents),
      project: null,
      created: !targetAlreadyExists,
    };
  } catch (error) {
    throw mapHostedProjectFilesystemError(error, 'write', options.projectPath);
  }
}
