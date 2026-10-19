import type { ProjectId } from '@valerypopoff/rivet2-core';
import type { OpenedProjectInfo } from '../state/savedGraphs.js';

export function getRemoteDebuggerBundleKey(info: OpenedProjectInfo | undefined): string | undefined {
  // Null is an authoritative hosted detachment, not an absent desktop hint.
  if (info?.hostedBundleKey !== undefined) return info.hostedBundleKey || undefined;
  if (info?.bundleMember === false) return undefined;
  return info?.bundleManifestPath ? `manifest:${info.bundleManifestPath}` : undefined;
}

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
