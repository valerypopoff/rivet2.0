import { arrayMove } from '@dnd-kit/sortable';
import { type ProjectId } from '@valerypopoff/rivet2-core';
import clsx from 'clsx';
import { useAtom, useAtomValue } from 'jotai';
import { type CSSProperties, type FC, useMemo } from 'react';

import { useLoadProject } from '../hooks/useLoadProject';
import { useRivetWorkspaceHost } from '../hooks/useRivetWorkspaceHost.js';
import { useSyncCurrentStateIntoOpenedProjects } from '../hooks/useSyncCurrentStateIntoOpenedProjects';
import {
  openingProjectTabsSortedIdsState,
  openingProjectTabsState,
  selectedOpeningProjectTabIdState,
  type OpeningProjectTabId,
} from '../state/openingProjectTabs.js';
import { sidebarOpenState } from '../state/graphBuilder.js';
import { openedProjectsSortedIdsState, openedProjectsState, projectState } from '../state/savedGraphs';
import { leftSidebarLiveWidthState, overlayOpenState } from '../state/ui.js';
import { buildProjectTabListItems } from '../utils/openingProjectTabs.js';
import { isMacOSPlatform, isWindowsPlatform } from '../utils/platform/os.js';
import { isInTauri } from '../utils/tauri.js';
import { OverlayTabs } from './OverlayTabs.js';
import { GraphHistoryControls, GraphTreeSidebarToggle } from './projectSelector/GraphTopBarControls.js';
import { ProjectFileMenu } from './projectSelector/ProjectFileMenu.js';
import { resolveProjectSelectorPlatformPolicy } from './projectSelector/projectSelectorModel.js';
import { projectSelectorStyles } from './projectSelector/projectSelectorStyles.js';
import { ProjectTabRow } from './projectSelector/ProjectTabRow.js';
import { useProjectCloseConfirmation } from './projectSelector/useProjectCloseConfirmation.js';
import { WindowsWindowControls, WindowsWindowDragRegion } from './projectSelector/WindowsWindowControls.js';

export const ProjectSelector: FC<{
  mode?: 'project' | 'workspace';
}> = ({ mode = 'project' }) => {
  const projectMode = mode === 'project';
  const openedProjects = useAtomValue(openedProjectsState);
  const [openedProjectsSortedIds, setOpenedProjectsSortedIds] = useAtom(openedProjectsSortedIdsState);
  const openingProjectTabs = useAtomValue(openingProjectTabsState);
  const openingProjectTabIds = useAtomValue(openingProjectTabsSortedIdsState);
  const [selectedOpeningProjectTabId, setSelectedOpeningProjectTabId] = useAtom(selectedOpeningProjectTabIdState);
  const [openOverlay, setOpenOverlay] = useAtom(overlayOpenState);
  const sidebarOpen = useAtomValue(sidebarOpenState);
  const leftSidebarWidth = useAtomValue(leftSidebarLiveWidthState);
  const currentProject = useAtomValue(projectState);
  const { cancelOpeningProjectTab } = useRivetWorkspaceHost();
  const { closeConfirmModal, requestCloseProject } = useProjectCloseConfirmation();

  const openedProjectIds = useMemo(
    () => openedProjectsSortedIds.filter((projectId) => openedProjects[projectId] != null),
    [openedProjectsSortedIds, openedProjects],
  );
  const visibleTabItems = useMemo(() => {
    if (!projectMode) {
      return [];
    }

    return buildProjectTabListItems({
      openedProjectIds,
      openingTabIds: openingProjectTabIds,
      openingTabs: openingProjectTabs,
    });
  }, [openedProjectIds, openingProjectTabIds, openingProjectTabs, projectMode]);
  const sortableProjectIds = useMemo(
    () => visibleTabItems.flatMap((tabItem) => (tabItem.type === 'project' ? [tabItem.projectId] : [])),
    [visibleTabItems],
  );

  const loadProject = useLoadProject();
  const projectTabsSelected = projectMode && openOverlay === undefined;
  const reserveSidebarColumn = projectTabsSelected && sidebarOpen;
  const { showFileMenu, showWindowsWindowControls } = resolveProjectSelectorPlatformPolicy({
    inTauri: isInTauri(),
    macOS: isMacOSPlatform(),
    windows: isWindowsPlatform(),
  });

  useSyncCurrentStateIntoOpenedProjects({ enabled: projectMode && selectedOpeningProjectTabId == null });

  const handleReorderProject = (activeProjectId: ProjectId, overProjectId: ProjectId) => {
    setOpenedProjectsSortedIds((prev) => {
      const oldIndex = prev.indexOf(activeProjectId);
      const newIndex = prev.indexOf(overProjectId);

      if (oldIndex < 0 || newIndex < 0) {
        return prev;
      }

      return arrayMove(prev, oldIndex, newIndex);
    });
  };

  const handleSelectProject = (projectId: ProjectId) => {
    setSelectedOpeningProjectTabId(undefined);

    if (projectId === currentProject.metadata.id) {
      setOpenOverlay(undefined);
      return;
    }

    const projectInfo = openedProjects[projectId];
    if (projectInfo) {
      void loadProject(projectInfo).then((loaded) => {
        if (loaded) {
          setOpenOverlay(undefined);
        }
      });
    }
  };

  const handleSelectOpeningProjectTab = (openingTabId: OpeningProjectTabId) => {
    setSelectedOpeningProjectTabId(openingTabId);
    setOpenOverlay(undefined);
  };

  return (
    <div
      className={clsx({ 'graph-tree-open': reserveSidebarColumn })}
      css={projectSelectorStyles}
      style={{ '--left-sidebar-width': `${leftSidebarWidth}px` } as CSSProperties}
    >
      {projectTabsSelected && <GraphTreeSidebarToggle />}
      {projectTabsSelected && <GraphHistoryControls />}
      {reserveSidebarColumn && <div className="sidebar-panel-spacer" aria-hidden="true" />}
      {showFileMenu && <ProjectFileMenu />}
      <ProjectTabRow
        projectTabsSelected={projectTabsSelected}
        selectedOpeningProjectTabId={selectedOpeningProjectTabId}
        sortableProjectIds={sortableProjectIds}
        tabItems={visibleTabItems}
        windowDragRegion={showWindowsWindowControls ? <WindowsWindowDragRegion /> : undefined}
        onCloseOpeningProjectTab={(openingTabId) => void cancelOpeningProjectTab(openingTabId)}
        onCloseProject={requestCloseProject}
        onReorderProject={handleReorderProject}
        onSelectOpeningProjectTab={handleSelectOpeningProjectTab}
        onSelectProject={handleSelectProject}
      />
      <OverlayTabs showWelcomeScreen={!projectMode} />
      {showWindowsWindowControls && <WindowsWindowControls />}
      {closeConfirmModal}
    </div>
  );
};
