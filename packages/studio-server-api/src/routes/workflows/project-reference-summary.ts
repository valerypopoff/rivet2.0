import {
  listProjectBundleCalls,
  listProjectGraphCallSites,
  type Project,
  type ProjectGraphCallSite,
} from '@valerypopoff/rivet2-core';

export const PROJECT_REFERENCE_SUMMARY_VERSION = 1;
export type ProjectReferenceTarget = { projectId: string; version: ProjectGraphCallSite['targetVersion'] };
export type ProjectReferenceSummary =
  | {
      version: typeof PROJECT_REFERENCE_SUMMARY_VERSION;
      state: 'invalid';
      reason: 'invalid-project' | 'summary-too-large';
      projectId?: string;
    }
  | {
      version: typeof PROJECT_REFERENCE_SUMMARY_VERSION;
      state: 'complete';
      projectId: string;
      /** Null marks failure of that traversal, without erasing the other result. */
      graphCalls: ProjectGraphCallSite[] | null;
      projectTargets: ProjectReferenceTarget[] | null;
    };

// JSONB rejects NUL and unpaired surrogates, even though JSON/YAML artifacts can
// carry them. A failed advisory extraction must never break revision attachment.
const postgresUnsupportedText = /[\u0000\uD800-\uDFFF]/u;
const isReferenceText = (value: unknown): value is string =>
  typeof value === 'string' && !postgresUnsupportedText.test(value);

/** Advisory metadata must never reject a previously permitted project save. */
export function summarizeProjectReferences(project: Project): ProjectReferenceSummary {
  let projectId: string | undefined;
  const invalid = (reason: 'invalid-project' | 'summary-too-large'): ProjectReferenceSummary => ({
    version: PROJECT_REFERENCE_SUMMARY_VERSION,
    state: 'invalid',
    reason,
    ...(projectId ? { projectId } : {}),
  });
  try {
    if (!isReferenceText(project.metadata.id) || !project.metadata.id) return invalid('invalid-project');
    projectId = project.metadata.id;
    let graphCalls: ProjectGraphCallSite[] | null;
    try {
      graphCalls = listProjectGraphCallSites(project);
      if (graphCalls.some((call) => Object.values(call).some((value) => !isReferenceText(value))))
        throw new Error('Invalid graph caller');
    } catch {
      graphCalls = null;
    }
    let projectTargets: ProjectReferenceTarget[] | null = [];
    const seen = new Set<string>();
    const add = (targetProjectId: string, version: ProjectReferenceTarget['version']) => {
      if (!isReferenceText(targetProjectId) || !targetProjectId) throw new Error('Invalid project target');
      const key = JSON.stringify([targetProjectId, version]);
      if (!seen.has(key)) {
        seen.add(key);
        projectTargets!.push({ projectId: targetProjectId, version });
      }
    };
    try {
      for (const call of listProjectBundleCalls(project)) {
        if (call.version !== 'latest' && call.version !== 'published') throw new Error('Invalid version');
        add(call.projectId, call.version);
      }
      for (const reference of project.references ?? []) add(reference.id, 'project-reference');
    } catch {
      projectTargets = null;
    }
    if (graphCalls === null && projectTargets === null) return invalid('invalid-project');
    const summary: ProjectReferenceSummary = {
      version: PROJECT_REFERENCE_SUMMARY_VERSION,
      state: 'complete',
      projectId,
      graphCalls,
      projectTargets,
    };
    // Bound database work independently of the supported (much larger) project artifact size.
    if (Buffer.byteLength(JSON.stringify(summary), 'utf8') > 4 * 1024 * 1024) return invalid('summary-too-large');
    return summary;
  } catch {
    return invalid('invalid-project');
  }
}
