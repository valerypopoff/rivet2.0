import {
  loadProjectAndAttachedDataFromString,
  serializeProject,
  type AttachedData,
  type Project,
} from '@valerypopoff/rivet2-node';

import { createHttpError } from '../../utils/httpError.js';

export type NormalizedHostedProjectContents = {
  project: Project;
  attachedData: AttachedData | undefined;
  contents: string;
};

/** Parse the submitted project once before a storage backend chooses its canonical path. */
export function parseHostedProjectContents(
  contents: string,
  errorMessage: string,
): Omit<NormalizedHostedProjectContents, 'contents'> {
  try {
    const [project, attachedData] = loadProjectAndAttachedDataFromString(contents);
    if (typeof project.metadata?.title !== 'string') {
      throw new Error('Project metadata title is missing');
    }

    return { project, attachedData };
  } catch {
    throw createHttpError(400, errorMessage);
  }
}

export function normalizeHostedProjectTitle(
  contents: string,
  projectName: string,
  errorMessage: string,
): NormalizedHostedProjectContents {
  const { project, attachedData } = parseHostedProjectContents(contents, errorMessage);
  if (project.metadata.title === projectName) {
    return {
      project,
      attachedData,
      contents,
    };
  }

  project.metadata.title = projectName;
  const serialized = serializeProject(project, attachedData);
  if (typeof serialized !== 'string') {
    throw createHttpError(400, errorMessage);
  }

  return {
    project,
    attachedData,
    contents: serialized,
  };
}
