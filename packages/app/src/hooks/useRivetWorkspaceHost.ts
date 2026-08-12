import { useMemo } from 'react';
import { useWorkspaceHostCleanBaseline } from './workspaceHost/useWorkspaceHostCleanBaseline.js';
import { useWorkspaceHostCloseProject } from './workspaceHost/useWorkspaceHostCloseProject.js';
import { useWorkspaceHostCompare } from './workspaceHost/useWorkspaceHostCompare.js';
import { useWorkspaceHostOpenProject } from './workspaceHost/useWorkspaceHostOpenProject.js';
import { useWorkspaceHostOpeningTabs } from './workspaceHost/useWorkspaceHostOpeningTabs.js';
import { useWorkspaceHostProjectMetadata } from './workspaceHost/useWorkspaceHostProjectMetadata.js';
import { useWorkspaceHostTabUi } from './workspaceHost/useWorkspaceHostTabUi.js';
import { useWorkspaceHostSave } from './workspaceHost/useWorkspaceHostSave.js';
import type { RivetWorkspaceHost } from './workspaceHost/types.js';

export { normalizeProjectSnapshot } from './workspaceHost/projectSnapshot.js';
export type {
  MoveProjectPathsInput,
  RivetOpeningProjectTabHandle,
  RivetOpeningProjectTabInput,
  RivetOpeningProjectTabOptions,
  RivetProjectCleanBaselineSnapshotInput,
  RivetProjectCompareOptions,
  RivetProjectMetadataPatch,
  RivetProjectMetadataUpdateOptions,
  RivetProjectOpenOptions,
  RivetProjectReplaceOptions,
  RivetProjectSnapshotInput,
  RivetProjectTabUiState,
  RivetWorkspaceHost,
} from './workspaceHost/types.js';

export function useRivetWorkspaceHost(): RivetWorkspaceHost {
  const saveCurrentProject = useWorkspaceHostSave();
  const { openProjectSnapshot, openProjectPath, replaceCurrent } = useWorkspaceHostOpenProject();
  const closeProject = useWorkspaceHostCloseProject();
  const { startOpeningProjectTab, finishOpeningProjectTab, cancelOpeningProjectTab } =
    useWorkspaceHostOpeningTabs(openProjectSnapshot);
  const { moveProjectPaths, updateProjectMetadata } = useWorkspaceHostProjectMetadata();
  const { markCurrentProjectClean, markProjectClean } = useWorkspaceHostCleanBaseline();
  const { startProjectCompare, stopProjectCompare } = useWorkspaceHostCompare();
  const setProjectTabUiState = useWorkspaceHostTabUi();

  return useMemo(
    () => ({
      saveCurrentProject,
      openProjectSnapshot,
      openProjectPath,
      closeProject,
      moveProjectPaths,
      setProjectTabUiState,
      startOpeningProjectTab,
      finishOpeningProjectTab,
      cancelOpeningProjectTab,
      updateProjectMetadata,
      replaceCurrent,
      markCurrentProjectClean,
      markProjectClean,
      startProjectCompare,
      stopProjectCompare,
    }),
    [
      cancelOpeningProjectTab,
      closeProject,
      finishOpeningProjectTab,
      markCurrentProjectClean,
      markProjectClean,
      moveProjectPaths,
      openProjectPath,
      openProjectSnapshot,
      replaceCurrent,
      saveCurrentProject,
      setProjectTabUiState,
      startOpeningProjectTab,
      startProjectCompare,
      stopProjectCompare,
      updateProjectMetadata,
    ],
  );
}
