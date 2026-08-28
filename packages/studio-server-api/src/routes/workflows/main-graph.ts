import type { Project } from '@valerypopoff/rivet2-node';

import { WORKFLOW_ENDPOINT_MAIN_GRAPH_REQUIRED_MESSAGE } from '../../../../studio-server-shared/workflow-types.js';
import { badRequest } from '../../utils/httpError.js';

type ProjectWithGraphs = Pick<Project, 'graphs' | 'metadata'>;

export function hasProjectMainGraph(project: ProjectWithGraphs): boolean {
  const mainGraphId = project.metadata.mainGraphId;
  return typeof mainGraphId === 'string' &&
    mainGraphId.length > 0 &&
    Object.hasOwn(project.graphs ?? {}, mainGraphId);
}

export function requireProjectMainGraphForEndpoint(project: ProjectWithGraphs): void {
  if (!hasProjectMainGraph(project)) {
    throw badRequest(WORKFLOW_ENDPOINT_MAIN_GRAPH_REQUIRED_MESSAGE);
  }
}
