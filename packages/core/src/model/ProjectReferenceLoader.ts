import type { Project, ProjectId, ProjectReference } from './Project.js';

export type ProjectReferenceLoader = {
  /** Loads a project based on the given reference. */
  loadProject: (currentProjectPath: string | undefined, reference: ProjectReference) => Promise<Project>;
};

/** The root information needed to load its complete referenced-project closure. */
export type ProjectReferenceRoot = {
  metadata: Pick<Project['metadata'], 'id'>;
  references?: ProjectReference[];
};

/**
 * Loads referenced projects depth-first in declared order.
 *
 * The active root is already in memory, so it is visited before traversing
 * references. This keeps legacy cycles compatible without asking a loader to
 * resolve the active project again. The returned record intentionally omits
 * that root; callers already own the authoritative root snapshot.
 */
export async function loadProjectReferenceTree(
  rootProject: ProjectReferenceRoot,
  rootProjectPath: string | undefined,
  loader: ProjectReferenceLoader,
): Promise<Record<ProjectId, Project>> {
  const collected = Object.create(null) as Record<ProjectId, Project>;
  const seenProjectIds = new Set<ProjectId>([rootProject.metadata.id]);

  const loadReference = async (reference: ProjectReference): Promise<void> => {
    if (seenProjectIds.has(reference.id)) return;
    seenProjectIds.add(reference.id);

    const project = await loader.loadProject(rootProjectPath, reference);
    if (project.metadata.id !== reference.id) {
      throw new Error(`Referenced project "${reference.id}" loaded a project with ID "${project.metadata.id}" instead.`);
    }

    // Project IDs are user-controlled strings. Define an own property so IDs
    // such as __proto__ cannot mutate the lookup object's prototype.
    Object.defineProperty(collected, project.metadata.id, {
      configurable: true,
      enumerable: true,
      value: project,
      writable: true,
    });

    for (const childReference of project.references ?? []) {
      await loadReference(childReference);
    }
  };

  for (const reference of rootProject.references ?? []) {
    await loadReference(reference);
  }

  return collected;
}
