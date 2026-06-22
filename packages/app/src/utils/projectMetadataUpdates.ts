import type { Project } from '@valerypopoff/rivet2-core';

export type ProjectMetadataPatch = Pick<Partial<Project['metadata']>, 'title' | 'description'>;

export function normalizeProjectMetadataPatch(patch: ProjectMetadataPatch | null | undefined): ProjectMetadataPatch {
  const normalized: ProjectMetadataPatch = {};

  if (!patch || typeof patch !== 'object') {
    return normalized;
  }

  if (typeof patch.title === 'string') {
    normalized.title = patch.title;
  }

  if (typeof patch.description === 'string') {
    normalized.description = patch.description;
  }

  return normalized;
}

export function hasProjectMetadataPatchChanges(
  metadata: Project['metadata'],
  patch: ProjectMetadataPatch | null | undefined,
): boolean {
  return Object.entries(normalizeProjectMetadataPatch(patch)).some(
    ([key, value]) => metadata[key as keyof ProjectMetadataPatch] !== value,
  );
}

export function applyProjectMetadataPatch<T extends Project | Omit<Project, 'data'>>(
  project: T,
  patch: ProjectMetadataPatch | null | undefined,
): T {
  const normalized = normalizeProjectMetadataPatch(patch);

  if (!hasProjectMetadataPatchChanges(project.metadata, normalized)) {
    return project;
  }

  return {
    ...project,
    metadata: {
      ...project.metadata,
      ...normalized,
    },
  };
}
