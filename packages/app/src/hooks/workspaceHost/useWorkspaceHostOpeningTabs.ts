import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import type { ProjectId } from '@valerypopoff/rivet2-core';
import { nanoid } from 'nanoid/non-secure';
import {
  openingProjectTabsSortedIdsState,
  openingProjectTabsState,
  selectedOpeningProjectTabIdState,
  type OpeningProjectTabId,
} from '../../state/openingProjectTabs.js';
import { projectsState, projectState } from '../../state/savedGraphs.js';
import { removeOpeningProjectTabId } from '../../utils/openingProjectTabs.js';
import { useStableCallback } from '../useStableCallback.js';
import type {
  RivetOpeningProjectTabHandle,
  RivetOpeningProjectTabInput,
  RivetOpeningProjectTabOptions,
  RivetProjectOpenOptions,
  RivetProjectSnapshotInput,
  WorkspaceHostOpenProjectSnapshot,
} from './types.js';

export function useWorkspaceHostOpeningTabs(openProjectSnapshot: WorkspaceHostOpenProjectSnapshot) {
  const [openingProjectTabs, setOpeningProjectTabs] = useAtom(openingProjectTabsState);
  const setOpeningProjectTabIds = useSetAtom(openingProjectTabsSortedIdsState);
  const setSelectedOpeningProjectTabId = useSetAtom(selectedOpeningProjectTabIdState);
  const currentProject = useAtomValue(projectState);
  const projects = useAtomValue(projectsState);

  const startOpeningProjectTab = useStableCallback(
    async (
      input: RivetOpeningProjectTabInput,
      options: RivetOpeningProjectTabOptions = {},
    ): Promise<RivetOpeningProjectTabHandle | false> => {
      if (!input.title.trim()) {
        return false;
      }

      const openingTabId = `opening-project-${nanoid()}` as OpeningProjectTabId;
      const replaceTargetProjectId =
        options.replaceCurrent && projects.openedProjects[currentProject.metadata.id as ProjectId]
          ? (currentProject.metadata.id as ProjectId)
          : undefined;
      const replacedOpeningTabIds = replaceTargetProjectId
        ? Object.values(openingProjectTabs).flatMap((tab) =>
            tab?.replaceTargetProjectId === replaceTargetProjectId ? [tab.openingTabId] : [],
          )
        : [];

      setOpeningProjectTabs((tabs) => {
        const nextTabs = { ...tabs };
        for (const replacedOpeningTabId of replacedOpeningTabIds) {
          delete nextTabs[replacedOpeningTabId];
        }

        nextTabs[openingTabId] = {
          openingTabId,
          path: input.path ?? null,
          replaceTargetProjectId,
          tabUi: options.tabUi,
          title: input.title,
        };

        return nextTabs;
      });
      setOpeningProjectTabIds((ids) => [...ids.filter((id) => !replacedOpeningTabIds.includes(id)), openingTabId]);
      setSelectedOpeningProjectTabId(openingTabId);

      return { openingTabId };
    },
  );

  const cancelOpeningProjectTab = useStableCallback(async (openingTabId: string) => {
    const typedOpeningTabId = openingTabId as OpeningProjectTabId;
    if (!openingProjectTabs[typedOpeningTabId]) {
      return false;
    }

    setOpeningProjectTabs((tabs) => {
      const nextTabs = { ...tabs };
      delete nextTabs[typedOpeningTabId];
      return nextTabs;
    });
    setOpeningProjectTabIds((ids) => removeOpeningProjectTabId(ids, typedOpeningTabId));
    setSelectedOpeningProjectTabId((selectedId) => (selectedId === typedOpeningTabId ? undefined : selectedId));

    return true;
  });

  const finishOpeningProjectTab = useStableCallback(
    async (openingTabId: string, snapshot: RivetProjectSnapshotInput, options: RivetProjectOpenOptions = {}) => {
      const typedOpeningTabId = openingTabId as OpeningProjectTabId;
      const openingTab = openingProjectTabs[typedOpeningTabId];
      if (!openingTab) {
        return false;
      }

      const opened = await openProjectSnapshot(snapshot, {
        replaceCurrent: openingTab.replaceTargetProjectId != null,
        replaceProjectId: openingTab.replaceTargetProjectId,
        selectedOpeningProjectTabIdToClear: typedOpeningTabId,
        tabUi: options.tabUi ?? openingTab.tabUi,
      });

      if (!opened) {
        return false;
      }

      await cancelOpeningProjectTab(openingTabId);
      return true;
    },
  );

  return {
    startOpeningProjectTab,
    finishOpeningProjectTab,
    cancelOpeningProjectTab,
  };
}
