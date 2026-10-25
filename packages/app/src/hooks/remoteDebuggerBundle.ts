import type { ProjectId } from '@valerypopoff/rivet2-core';
import type { OpenedProjectInfo } from '../state/savedGraphs.js';
import { getExecutionBundleKey as getRemoteDebuggerBundleKey } from '../domain/execution/bundleMembership.js';
export { getRemoteDebuggerBundleKey };

/** Explicit containers only. References and graph contents never confer membership. */
export function getRemoteDebuggerBundleProjects(
  projectId: ProjectId,
  opened: Record<ProjectId, OpenedProjectInfo>,
): ProjectId[] {
  const key = getRemoteDebuggerBundleKey(opened[projectId]);
  return key
    ? Object.entries(opened)
        .filter(([, info]) => getRemoteDebuggerBundleKey(info) === key)
        .map(([id]) => id as ProjectId)
    : [projectId];
}
