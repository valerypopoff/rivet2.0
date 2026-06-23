import type { ProjectId } from '@valerypopoff/rivet2-core';
import type { OpeningProjectTabId, OpeningProjectTabInfo } from '../state/openingProjectTabs.js';

export type ProjectTabListItem =
  | {
      type: 'project';
      projectId: ProjectId;
    }
  | {
      type: 'opening';
      openingTabId: OpeningProjectTabId;
    };

export function buildProjectTabListItems({
  openedProjectIds,
  openingTabIds,
  openingTabs,
}: {
  openedProjectIds: readonly ProjectId[];
  openingTabIds: readonly OpeningProjectTabId[];
  openingTabs: Record<OpeningProjectTabId, OpeningProjectTabInfo | undefined>;
}): ProjectTabListItem[] {
  const openedProjectIdSet = new Set(openedProjectIds);
  const replacementOpeningTabs = new Map<ProjectId, OpeningProjectTabInfo>();
  const appendedOpeningTabs: OpeningProjectTabInfo[] = [];

  for (const openingTabId of openingTabIds) {
    const openingTab = openingTabs[openingTabId];
    if (!openingTab) {
      continue;
    }

    if (openingTab.replaceTargetProjectId && openedProjectIdSet.has(openingTab.replaceTargetProjectId)) {
      replacementOpeningTabs.set(openingTab.replaceTargetProjectId, openingTab);
    } else {
      appendedOpeningTabs.push(openingTab);
    }
  }

  return [
    ...openedProjectIds.map<ProjectTabListItem>((projectId) => {
      const replacementOpeningTab = replacementOpeningTabs.get(projectId);
      return replacementOpeningTab
        ? {
            type: 'opening',
            openingTabId: replacementOpeningTab.openingTabId,
          }
        : {
            type: 'project',
            projectId,
          };
    }),
    ...appendedOpeningTabs.map<ProjectTabListItem>((openingTab) => ({
      type: 'opening',
      openingTabId: openingTab.openingTabId,
    })),
  ];
}

export function getWorkspaceVisibleTabCount({
  openedProjectIds,
  openingTabIds,
  openingTabs,
}: {
  openedProjectIds: readonly ProjectId[];
  openingTabIds: readonly OpeningProjectTabId[];
  openingTabs: Record<OpeningProjectTabId, OpeningProjectTabInfo | undefined>;
}): number {
  return buildProjectTabListItems({ openedProjectIds, openingTabIds, openingTabs }).length;
}

export function removeOpeningProjectTabId(
  openingTabIds: readonly OpeningProjectTabId[],
  openingTabId: OpeningProjectTabId,
): OpeningProjectTabId[] {
  return openingTabIds.filter((id) => id !== openingTabId);
}
