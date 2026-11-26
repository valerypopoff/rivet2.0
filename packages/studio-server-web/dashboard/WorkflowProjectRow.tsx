import type { FC } from 'react';
import type { WorkflowProjectItem } from './types';
import { WorkflowInlineRenameInput } from './WorkflowInlineRenameInput';
import { useWorkflowPublicationReferences } from './WorkflowPublicationReferences';
import {
  getWorkflowProjectContribution,
  getWorkflowProjectPublicationStatus,
} from './workflowProjectPublicationStatus';
import type { DraggedWorkflowItem } from './workflowLibraryHelpers';
import { namespaceIdentity } from './workflowNamespaceMutations';

type WorkflowProjectRowProps = {
  project: WorkflowProjectItem;
  activePath: string;
  draggedItem: DraggedWorkflowItem | null;
  editing: boolean;
  renaming: boolean;
  editorReady: boolean;
  setProjectRowRef: (path: string, node: HTMLElement | null) => void;
  onDragStart: (item: DraggedWorkflowItem) => (event: React.DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onPreviewOpen: (project: WorkflowProjectItem) => void;
  onPersistentOpen: (project: WorkflowProjectItem) => void;
  onContextMenu: (project: WorkflowProjectItem, event: React.MouseEvent<HTMLElement>) => void;
  onKeyDown: (project: WorkflowProjectItem) => (event: React.KeyboardEvent<HTMLElement>) => void;
  onRenameSubmit: (project: WorkflowProjectItem, name: string) => void | Promise<void>;
  onRenameCancel: (project: WorkflowProjectItem) => void;
  getParentRelativePath: (relativePath: string) => string;
};

export const WorkflowProjectRow: FC<WorkflowProjectRowProps> = ({
  project,
  activePath,
  draggedItem,
  editing,
  renaming,
  editorReady,
  setProjectRowRef,
  onDragStart,
  onDragEnd,
  onPreviewOpen,
  onPersistentOpen,
  onContextMenu,
  onKeyDown,
  onRenameSubmit,
  onRenameCancel,
  getParentRelativePath,
}) => {
  const references = useWorkflowPublicationReferences();
  const publicationStatus = getWorkflowProjectPublicationStatus(project, references);
  const contribution = getWorkflowProjectContribution(project, references);
  const rowClassName = [
    'project-row',
    `project-row-status-${publicationStatus}`,
    activePath === project.absolutePath ? 'active' : null,
    editing ? 'editing' : null,
    renaming ? 'renaming' : null,
    draggedItem?.itemType === 'project' && draggedItem.absolutePath === project.absolutePath ? 'dragging' : null,
  ]
    .filter(Boolean)
    .join(' ');

  const handleClick = () => {
    onPreviewOpen(project);
  };

  const handleDoubleClick = () => {
    onPersistentOpen(project);
  };

  const projectRowContent = (
    <div className="project-main">
      {publicationStatus !== 'unpublished' ? (
        <span className={`project-status-dot ${publicationStatus}`} aria-hidden="true" />
      ) : null}
      {contribution ? (
        <span
          className={`reference-project-marker ${contribution.status}`}
          role="img"
          aria-label={contribution.label}
          title={contribution.label}
        />
      ) : null}
      {editing ? (
        <ProjectRenameInput project={project} onSubmit={onRenameSubmit} onCancel={onRenameCancel} />
      ) : (
        <WorkflowProjectLabel name={project.name} renaming={renaming} />
      )}
    </div>
  );

  if (editing || renaming) {
    return (
      <div
        ref={(node) => {
          setProjectRowRef(project.absolutePath, node);
        }}
        className={rowClassName}
        aria-busy={renaming ? true : undefined}
        aria-label={`Renaming ${project.name}`}
        title={project.fileName}
      >
        {projectRowContent}
      </div>
    );
  }

  return (
    <button
      ref={(node) => {
        setProjectRowRef(project.absolutePath, node);
      }}
      className={rowClassName}
      draggable={editorReady}
      disabled={!editorReady}
      onDragStart={onDragStart({
        itemType: 'project',
        expectedSource: namespaceIdentity(project),
        absolutePath: project.absolutePath,
        relativePath: project.relativePath,
        parentRelativePath: getParentRelativePath(project.relativePath),
      })}
      onDragEnd={onDragEnd}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={(event) => onContextMenu(project, event)}
      onKeyDown={onKeyDown(project)}
      title={project.fileName}
    >
      {projectRowContent}
    </button>
  );
};

export function WorkflowProjectLabel({ name, renaming }: { name: string; renaming?: boolean }) {
  return (
    <div className="project-label-wrap">
      {renaming ? <span className="project-rename-spinner" aria-hidden="true" /> : null}
      <div className="label">{name}</div>
    </div>
  );
}

type ProjectRenameInputProps = {
  project: WorkflowProjectItem;
  onSubmit: (project: WorkflowProjectItem, name: string) => void | Promise<void>;
  onCancel: (project: WorkflowProjectItem) => void;
};

const ProjectRenameInput: FC<ProjectRenameInputProps> = ({ project, onSubmit, onCancel }) => (
  <WorkflowInlineRenameInput
    classNamePrefix="project"
    initialValue={project.name}
    identityKey={project.id}
    ariaLabel={`Rename ${project.name}`}
    onSubmit={(value) => onSubmit(project, value)}
    onCancel={() => onCancel(project)}
  />
);
