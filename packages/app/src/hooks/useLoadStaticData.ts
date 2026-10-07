import { useAtomValue, useStore } from 'jotai';
import { projectDataState, projectDataUnsavedChangesState, projectState } from '../state/savedGraphs';
import { useEffect } from 'react';
import { useStaticDataDatabase } from './useStaticDataDatabase';
import { type DataId } from '@valerypopoff/rivet2-core';
import { runStaticDataCacheOperation } from '../utils/staticDataCacheCoordinator.js';
import { handleError } from '../utils/errorHandling.js';
import { getProjectActivationRevision } from '../utils/projectActivationCoordinator.js';
import { markProjectDirtyFlag } from '../utils/projectUnsavedChanges.js';

export function useLoadStaticData() {
  const data = useAtomValue(projectDataState);
  const store = useStore();

  const database = useStaticDataDatabase();

  useEffect(() => {
    if (data) {
      return;
    }

    const projectId = store.get(projectState).metadata.id;
    const activationRevision = getProjectActivationRevision(store);

    (async () => {
      const allData = await runStaticDataCacheOperation(database, () => database.getAll());
      if (
        store.get(projectState).metadata.id !== projectId ||
        getProjectActivationRevision(store) !== activationRevision
      )
        return;

      const dataObj = Object.fromEntries(allData.map(({ id, data }) => [id, data])) as Record<DataId, string>;

      // This is only a compatibility import for workspaces without a persisted
      // payload. New edits made during the read win; a later project load wins
      // entirely and cannot receive this older cache's contents.
      store.set(projectDataState, (current) => ({ ...dataObj, ...current }));
      // A legacy cache is recovery data, not proof that these bytes reached the
      // project file. Keep them visibly unsaved until actual persistence.
      if (allData.length > 0) {
        store.set(projectDataUnsavedChangesState, (flags) => markProjectDirtyFlag(flags, projectId, true));
      }
    })().catch((error) => {
      handleError(error, 'Failed to restore static data cache', { toastError: false });
    });
  }, [data, database, store]);
}
