import { deserializeProject, listProjectBundleCalls } from '@valerypopoff/rivet2-node';
import type { WorkflowProjectReferencesResponse } from '../../../../studio-server-shared/workflow-types.js';
import { createHttpError } from '../../utils/httpError.js';
import type {
  WorkflowProjectReferenceSnapshot,
  WorkflowProjectReferenceCatalogEntry,
} from './project-reference-snapshots.js';
import {
  listWorkflowProjectReferenceCatalogWithBackend,
  readWorkflowProjectReferenceSnapshotsWithBackend,
} from './storage-backend.js';

const sortCatalog = (projects: WorkflowProjectReferenceCatalogEntry[]) =>
  [...projects].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
const catalogIdentity = (projects: WorkflowProjectReferenceCatalogEntry[]) => JSON.stringify(sortCatalog(projects));
const parseProject = (contents: string) => deserializeProject(contents, null, { logErrors: false })[0];

/** Direct incoming connections from saved drafts and currently serving publications.
 * Never execute graphs or recursively fetch dependencies to infer these edges. */
export async function scanIncomingProjectReferences(options: {
  relativePath: string;
  expectedProjectId?: string;
  signal: AbortSignal;
  getCatalog(): Promise<WorkflowProjectReferenceCatalogEntry[]>;
  readSaved(relativePath: string): Promise<string>;
  readSnapshots(relativePath: string): Promise<WorkflowProjectReferenceSnapshot[]>;
  maxProjects?: number;
  deadline?: number;
}): Promise<WorkflowProjectReferencesResponse> {
  const { signal } = options;
  signal.throwIfAborted();
  const catalog = sortCatalog(await options.getCatalog());
  signal.throwIfAborted();
  const selected = catalog.find((project) => project.relativePath === options.relativePath);
  if (!selected) throw createHttpError(404, 'Project not found');
  const target = parseProject(await options.readSaved(selected.relativePath));
  const projectId = target.metadata.id;
  if (
    !projectId ||
    (selected.projectMetadataId && projectId !== selected.projectMetadataId) ||
    (options.expectedProjectId && projectId !== options.expectedProjectId)
  )
    throw createHttpError(409, 'The selected project changed. Reopen Project settings.');
  const candidates = catalog.filter((project) => project.relativePath !== selected.relativePath);
  const result: WorkflowProjectReferencesResponse = {
    projectId,
    references: [],
    checkedProjects: 0,
    totalProjects: candidates.length,
    complete: false,
    changedDuringScan: false,
    unreadableProjects: [],
  };
  for (const candidate of candidates) {
    signal.throwIfAborted();
    if (result.checkedProjects >= (options.maxProjects ?? 1000) || Date.now() >= (options.deadline ?? Infinity)) break;
    result.checkedProjects++;
    const sources: WorkflowProjectReferencesResponse['references'][number]['sources'] = [];
    let callerId: string | undefined;
    try {
      const snapshots = await options.readSnapshots(candidate.relativePath);
      if (!snapshots.some((snapshot) => snapshot.source.kind === 'saved-latest'))
        throw new Error('Saved snapshot is missing.');
      const parsed = new Map<string, ReturnType<typeof parseProject>>();
      for (const snapshot of snapshots) {
        signal.throwIfAborted();
        let project = parsed.get(snapshot.contents);
        if (!project) {
          project = parseProject(snapshot.contents);
          parsed.set(snapshot.contents, project);
        }
        if (
          !project.metadata.id ||
          project.metadata.id === projectId ||
          (candidate.projectMetadataId && project.metadata.id !== candidate.projectMetadataId) ||
          (callerId && project.metadata.id !== callerId)
        )
          throw new Error('Project identity does not match.');
        callerId = project.metadata.id;
        const versions = new Set<'latest' | 'published' | 'project-reference'>();
        for (const call of listProjectBundleCalls(project)) {
          if (call.projectId !== projectId) continue;
          if (call.version !== 'latest' && call.version !== 'published') throw new Error('Invalid target version.');
          versions.add(call.version);
        }
        if ((project.references ?? []).some((reference) => reference.id === projectId))
          versions.add('project-reference');
        if (versions.size) sources.push({ ...snapshot.source, targetVersions: [...versions].sort() });
      }
    } catch (error) {
      signal.throwIfAborted();
      // Return catalog labels only. Parser/storage errors may contain project data.
      result.unreadableProjects.push({ name: candidate.name, relativePath: candidate.relativePath });
    }
    // A later corrupt publication must not hide verified edges from earlier snapshots.
    if (sources.length)
      result.references.push({
        projectId: callerId!,
        name: candidate.name,
        relativePath: candidate.relativePath,
        sources,
      });
  }
  signal.throwIfAborted();
  result.changedDuringScan = catalogIdentity(catalog) !== catalogIdentity(await options.getCatalog());
  signal.throwIfAborted();
  result.complete =
    !result.changedDuringScan && !result.unreadableProjects.length && result.checkedProjects === result.totalProjects;
  return result;
}

let scanning = false;
export async function listIncomingProjectReferences(
  relativePath: string,
  expectedProjectId: string | undefined,
  signal: AbortSignal,
) {
  if (scanning) throw createHttpError(503, 'Project references are already being checked. Try again shortly.');
  scanning = true;
  try {
    return await scanIncomingProjectReferences({
      relativePath,
      expectedProjectId,
      signal,
      getCatalog: listWorkflowProjectReferenceCatalogWithBackend,
      readSaved: async (value) => {
        const saved = (await readWorkflowProjectReferenceSnapshotsWithBackend(value)).find(
          (snapshot) => snapshot.source.kind === 'saved-latest',
        );
        if (!saved) throw createHttpError(409, 'Saved project is unavailable.');
        return saved.contents;
      },
      readSnapshots: readWorkflowProjectReferenceSnapshotsWithBackend,
      deadline: Date.now() + 30_000,
    });
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof Error && 'status' in error) throw error;
    throw createHttpError(503, 'Project references could not be checked. Refresh and try again.');
  } finally {
    scanning = false;
  }
}
