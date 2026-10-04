import { useAtomValue, useSetAtom, useStore } from 'jotai';
import { useStaticDataDatabase } from './useStaticDataDatabase';
import { projectDataState, projectDataUnsavedChangesState, projectState } from '../state/savedGraphs';
import { type DataId } from '@valerypopoff/rivet2-core';
import { entries } from '../utils/typeSafety';
import { handleError } from '../utils/errorHandling.js';
import { markProjectDirtyFlag } from '../utils/projectUnsavedChanges.js';
import { runStaticDataCacheOperation } from '../utils/staticDataCacheCoordinator.js';

export function useSetStaticData() {
  const currentProject = useAtomValue(projectState);
  const setProjectData = useSetAtom(projectDataState);
  const setProjectDataUnsavedChanges = useSetAtom(projectDataUnsavedChangesState);
  const database = useStaticDataDatabase();
  const store = useStore();

  return async (data: Record<DataId, string>) => {
    const projectId = currentProject.metadata.id;
    // An async node/file callback may still belong to the tab just left.
    if (store.get(projectState).metadata.id !== projectId) return;
    setProjectData((prev) => {
      return {
        ...prev,
        ...data,
      };
    });
    setProjectDataUnsavedChanges((previousFlags) => markProjectDirtyFlag(previousFlags, projectId, true));

    await runStaticDataCacheOperation(database, async () => {
      if (store.get(projectState).metadata.id !== projectId) return;
      for (const [id, dataValue] of entries(data)) {
        try {
          // Hydration may already have included this edit's live payload.
          if ((await database.get(id))?.data !== dataValue) await database.insert(id, dataValue);
        } catch (err) {
          handleError(err, 'Failed to persist static data entry', {
            metadata: { dataId: id },
            toastError: false,
          });
        }
      }
    });
  };
}
