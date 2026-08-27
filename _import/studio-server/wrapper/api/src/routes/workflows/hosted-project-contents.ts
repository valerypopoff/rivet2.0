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

export function normalizeHostedProjectTitle(
  contents: string,
  projectName: string,
  errorMessage: string,
): NormalizedHostedProjectContents {
  try {
    const [project, attachedData] = loadProjectAndAttachedDataFromString(contents);
    if (typeof project.metadata?.title !== 'string') {
      throw new Error('Project metadata title is missing');
    }

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
      throw new Error('Project serialization did not return a string');
    }

    return {
      project,
      attachedData,
      contents: serialized,
    };
  } catch {
    throw createHttpError(400, errorMessage);
  }
}
