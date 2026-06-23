import { atom } from 'jotai';
import type { ProjectId } from '@valerypopoff/rivet2-core';
import { openedProjectsSortedIdsState } from './savedGraphs.js';
import type { ProjectTabUiState } from './projectTabUi.js';
import { getWorkspaceVisibleTabCount } from '../utils/openingProjectTabs.js';

export type OpeningProjectTabId = string;

export type OpeningProjectTabInfo = {
  openingTabId: OpeningProjectTabId;
  title: string;
  path: string | null;
  tabUi?: ProjectTabUiState;
  replaceTargetProjectId?: ProjectId;
};

export const openingProjectTabsState = atom<Record<OpeningProjectTabId, OpeningProjectTabInfo | undefined>>({});

export const openingProjectTabsSortedIdsState = atom<OpeningProjectTabId[]>([]);

export const selectedOpeningProjectTabIdState = atom<OpeningProjectTabId | undefined>(undefined);

export const workspaceVisibleTabCountState = atom((get) => {
  return getWorkspaceVisibleTabCount({
    openedProjectIds: get(openedProjectsSortedIdsState),
    openingTabIds: get(openingProjectTabsSortedIdsState),
    openingTabs: get(openingProjectTabsState),
  });
});
