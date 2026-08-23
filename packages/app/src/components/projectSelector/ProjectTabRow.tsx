import { type FC, type ReactNode } from 'react';

import { DndContext, PointerSensor, type DragEndEvent, useSensor, useSensors } from '@dnd-kit/core';
import { type SyntheticListenerMap } from '@dnd-kit/core/dist/hooks/utilities';
import { horizontalListSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable';
import { type ProjectId } from '@valerypopoff/rivet2-core';
import { useAtomValue } from 'jotai';
import clsx from 'clsx';
import CloseIcon from 'majesticons/line/multiply-line.svg?react';

import { type OpeningProjectTabId, openingProjectTabsState } from '../../state/openingProjectTabs.js';
import {
  openedProjectsState,
  projectDataUnsavedChangesState,
  projectState,
  projectUnsavedChangesState,
} from '../../state/savedGraphs.js';
import { projectTabUiState } from '../../state/projectTabUi.js';
import { hasProjectUnsavedChanges } from '../../utils/projectUnsavedChanges.js';
import { type ProjectTabListItem } from '../../utils/openingProjectTabs.js';
import {
  projectTabDragActivationConstraint,
  resolveOpeningProjectTabPresentation,
  resolveProjectTabPresentation,
} from './projectSelectorModel.js';
import { ProjectTabSurface } from './ProjectTabSurface.js';

export const ProjectTabRow: FC<{
  projectTabsSelected: boolean;
  selectedOpeningProjectTabId?: OpeningProjectTabId;
  sortableProjectIds: readonly ProjectId[];
  tabItems: readonly ProjectTabListItem[];
  windowDragRegion?: ReactNode;
  onCloseOpeningProjectTab: (openingTabId: OpeningProjectTabId) => void;
  onCloseProject: (projectId: ProjectId) => void;
  onReorderProject: (activeProjectId: ProjectId, overProjectId: ProjectId) => void;
  onSelectOpeningProjectTab: (openingTabId: OpeningProjectTabId) => void;
  onSelectProject: (projectId: ProjectId) => void;
}> = ({
  onCloseOpeningProjectTab,
  onCloseProject,
  onReorderProject,
  onSelectOpeningProjectTab,
  onSelectProject,
  projectTabsSelected,
  selectedOpeningProjectTabId,
  sortableProjectIds,
  tabItems,
  windowDragRegion,
}) => {
  const dragSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: projectTabDragActivationConstraint,
    }),
  );

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (over && active.id !== over.id) {
      onReorderProject(active.id as ProjectId, over.id as ProjectId);
    }
  };

  return (
    <div
      className={clsx('projects-container', {
        empty: tabItems.length === 0,
        'with-window-drag-region': windowDragRegion != null,
      })}
    >
      <div className="projects">
        <DndContext sensors={dragSensors} onDragEnd={handleDragEnd}>
          <SortableContext items={[...sortableProjectIds]} strategy={horizontalListSortingStrategy}>
            {tabItems.map((tabItem) =>
              tabItem.type === 'opening' ? (
                <OpeningProjectTab
                  key={tabItem.openingTabId}
                  openingTabId={tabItem.openingTabId}
                  onCloseProject={() => onCloseOpeningProjectTab(tabItem.openingTabId)}
                  onSelectProject={() => onSelectOpeningProjectTab(tabItem.openingTabId)}
                  projectTabsSelected={projectTabsSelected}
                  selectedOpeningProjectTabId={selectedOpeningProjectTabId}
                />
              ) : (
                <SortableProject
                  key={tabItem.projectId}
                  projectId={tabItem.projectId}
                  onCloseProject={() => onCloseProject(tabItem.projectId)}
                  onSelectProject={() => onSelectProject(tabItem.projectId)}
                  projectTabsSelected={projectTabsSelected}
                  selectedOpeningProjectTabId={selectedOpeningProjectTabId}
                />
              ),
            )}
          </SortableContext>
        </DndContext>
      </div>
      {windowDragRegion}
    </div>
  );
};
const SortableProject: FC<{
  projectId: ProjectId;
  projectTabsSelected: boolean;
  selectedOpeningProjectTabId?: OpeningProjectTabId;
  onCloseProject?: () => void;
  onSelectProject?: () => void;
}> = ({ projectId, onCloseProject, onSelectProject, projectTabsSelected, selectedOpeningProjectTabId }) => {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: projectId,
  });

  const constrainedTransformX = transform?.x ?? 0;

  return (
    <div
      className="draggableProject"
      ref={setNodeRef}
      style={{
        transform: `translate3d(${constrainedTransformX}px, 0px, 0)`,
        transition,
      }}
      {...attributes}
    >
      <ProjectTab
        projectId={projectId}
        dragListeners={listeners}
        onCloseProject={onCloseProject}
        onSelectProject={onSelectProject}
        projectTabsSelected={projectTabsSelected}
        selectedOpeningProjectTabId={selectedOpeningProjectTabId}
      />
    </div>
  );
};
const ProjectTab: FC<{
  projectId: ProjectId;
  projectTabsSelected: boolean;
  selectedOpeningProjectTabId?: OpeningProjectTabId;
  dragListeners?: SyntheticListenerMap;
  onCloseProject?: () => void;
  onSelectProject?: () => void;
}> = ({
  projectId,
  dragListeners,
  onCloseProject,
  onSelectProject,
  projectTabsSelected,
  selectedOpeningProjectTabId,
}) => {
  const openedProjects = useAtomValue(openedProjectsState);
  const projectTabUi = useAtomValue(projectTabUiState);
  const projectUnsavedChanges = useAtomValue(projectUnsavedChangesState);
  const projectDataUnsavedChanges = useAtomValue(projectDataUnsavedChangesState);
  const currentProject = useAtomValue(projectState);

  const project = openedProjects[projectId];

  const hasUnsavedChanges = hasProjectUnsavedChanges(projectUnsavedChanges, projectDataUnsavedChanges, projectId);
  const presentation = resolveProjectTabPresentation({
    title: project?.title ?? '',
    fsPath: project?.fsPath,
    current: currentProject.metadata.id === projectId,
    projectTabsSelected,
    openingTabSelected: selectedOpeningProjectTabId != null,
    preview: projectTabUi[projectId]?.preview,
  });

  return (
    <ProjectTabSurface
      active={presentation.active}
      closeIcon={<CloseIcon />}
      displayName={presentation.displayName}
      dragListeners={dragListeners}
      hasUnsavedChanges={hasUnsavedChanges}
      preview={presentation.preview}
      unsaved={presentation.unsaved}
      onCloseProject={onCloseProject}
      onSelectProject={onSelectProject}
    />
  );
};

const OpeningProjectTab: FC<{
  openingTabId: OpeningProjectTabId;
  selectedOpeningProjectTabId?: OpeningProjectTabId;
  projectTabsSelected: boolean;
  onCloseProject?: () => void;
  onSelectProject?: () => void;
}> = ({ openingTabId, onCloseProject, onSelectProject, projectTabsSelected, selectedOpeningProjectTabId }) => {
  const openingProjectTabs = useAtomValue(openingProjectTabsState);
  const openingTab = openingProjectTabs[openingTabId];

  if (!openingTab) {
    return null;
  }

  const presentation = resolveOpeningProjectTabPresentation({
    title: openingTab.title,
    path: openingTab.path,
    projectTabsSelected,
    selected: selectedOpeningProjectTabId === openingTabId,
    preview: openingTab.tabUi?.preview,
  });

  return (
    <div className="draggableProject openingProject">
      <ProjectTabSurface
        active={presentation.active}
        className="opening"
        closeIcon={<CloseIcon />}
        displayName={presentation.displayName}
        preview={presentation.preview}
        onCloseProject={onCloseProject}
        onSelectProject={onSelectProject}
      />
    </div>
  );
};
