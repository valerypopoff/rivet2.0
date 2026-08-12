import type { ProjectId } from '@valerypopoff/rivet2-core';

const inFlightProjectSavesByWorkspace = new WeakMap<object, Map<ProjectId, Promise<boolean>>>();

/**
 * Keeps every save entry point on one persistence operation per project.
 * The returned promise is deliberately shared so callers observe the same
 * completion result instead of merely running equivalent work.
 */
export function runDeduplicatedProjectSave(
  workspace: object,
  projectId: ProjectId,
  save: () => Promise<boolean>,
): Promise<boolean> {
  let inFlightProjectSaves = inFlightProjectSavesByWorkspace.get(workspace);
  if (!inFlightProjectSaves) {
    inFlightProjectSaves = new Map();
    inFlightProjectSavesByWorkspace.set(workspace, inFlightProjectSaves);
  }

  const existingSave = inFlightProjectSaves.get(projectId);
  if (existingSave) {
    return existingSave;
  }

  const savePromise = save();
  inFlightProjectSaves.set(projectId, savePromise);

  const clearSave = () => {
    if (inFlightProjectSaves.get(projectId) === savePromise) {
      inFlightProjectSaves.delete(projectId);
    }
  };
  void savePromise.then(clearSave, clearSave);

  return savePromise;
}
