import { useAtomValue, useSetAtom } from 'jotai';
import { useStaticDataDatabase } from './useStaticDataDatabase';
import { projectDataState, projectDataUnsavedChangesState, projectState } from '../state/savedGraphs';
import { type DataId } from '@valerypopoff/rivet2-core';
import { entries } from '../utils/typeSafety';
import { handleError } from '../utils/errorHandling.js';
import { markProjectDirtyFlag } from '../utils/projectUnsavedChanges.js';

export function useSetStaticData() {
  const currentProject = useAtomValue(projectState);
  const setProjectData = useSetAtom(projectDataState);
  const setProjectDataUnsavedChanges = useSetAtom(projectDataUnsavedChangesState);
  const database = useStaticDataDatabase();

  return async (data: Record<DataId, string>) => {
    setProjectData((prev) => {
      return {
        ...prev,
        ...data,
      };
    });
    setProjectDataUnsavedChanges((previousFlags) =>
      markProjectDirtyFlag(previousFlags, currentProject.metadata.id, true),
    );

    for (const [id, dataValue] of entries(data)) {
      try {
        await database.insert(id, dataValue);
      } catch (err) {
        handleError(err, 'Failed to persist static data entry', {
          metadata: {
            dataId: id,
          },
          toastError: false,
        });
      }
    }
  };
}
