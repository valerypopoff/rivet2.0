import fs from 'node:fs/promises';
import path from 'node:path';

import type { WorkflowProjectDownloadVersion } from '../../../../shared/workflow-types.js';
import { createHttpError, conflict } from '../../utils/httpError.js';
import {
  ensureWorkflowsRoot,
  pathExists,
  PROJECT_EXTENSION,
  requireProjectPath,
  resolveWorkflowRelativePath,
} from './fs-helpers.js';
import { getWorkflowProjectSettings, readStoredWorkflowProjectSettings, resolvePublishedWorkflowProjectPath } from './publication.js';
import { getWorkflowDownloadFileName } from './workflow-project-naming.js';

type WorkflowProjectDownloadResult = {
  contents: string;
  fileName: string;
};

function rethrowWorkflowProjectNotFound(error: unknown): never | void {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
    throw createHttpError(404, 'Project not found');
  }
}

function getAsciiContentDispositionFileName(fileName: string): string {
  return fileName.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '_');
}

export function createWorkflowDownloadContentDisposition(fileName: string): string {
  const asciiFileName = getAsciiContentDispositionFileName(fileName);
  return `attachment; filename="${asciiFileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export async function readWorkflowProjectDownload(
  relativePath: unknown,
  version: WorkflowProjectDownloadVersion,
): Promise<WorkflowProjectDownloadResult> {
  const root = await ensureWorkflowsRoot();
  const projectPath = requireProjectPath(resolveWorkflowRelativePath(root, relativePath, {
    allowProjectFile: true,
  }));

  if (!await pathExists(projectPath)) {
    throw createHttpError(404, 'Project not found');
  }

  const projectName = path.basename(projectPath, PROJECT_EXTENSION);
  let settings: Awaited<ReturnType<typeof getWorkflowProjectSettings>>;

  try {
    settings = await getWorkflowProjectSettings(projectPath, projectName);
  } catch (error) {
    rethrowWorkflowProjectNotFound(error);
    throw error;
  }

  let sourcePath = projectPath;
  if (version === 'published') {
    let publishedProjectPath: string | null;

    try {
      const storedSettings = await readStoredWorkflowProjectSettings(projectPath, projectName);
      publishedProjectPath = await resolvePublishedWorkflowProjectPath(root, projectPath, storedSettings);
    } catch (error) {
      rethrowWorkflowProjectNotFound(error);
      throw error;
    }

    if (!publishedProjectPath) {
      throw conflict('Published version is not available for this project');
    }
    sourcePath = publishedProjectPath;
  }

  try {
    return {
      contents: await fs.readFile(sourcePath, 'utf8'),
      fileName: getWorkflowDownloadFileName(projectName, version, settings.status),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw createHttpError(404, 'Project not found');
    }

    throw error;
  }
}
