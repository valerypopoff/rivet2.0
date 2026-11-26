import type { ComponentPropsWithoutRef, FC, ReactNode } from 'react';
import ChevronDownIcon from 'majesticons/line/chevron-down-line.svg?react';
import ChevronRightIcon from 'majesticons/line/chevron-right-line.svg?react';
import type { WorkflowFolderItem, WorkflowProjectItem } from './types';
import { WorkflowInlineRenameInput } from './WorkflowInlineRenameInput';
import type { DraggedWorkflowItem } from './workflowLibraryHelpers';
import { countProjectsInFolder, normalizeWorkflowPath } from './workflowLibraryHelpers';
import { WorkflowProjectRow } from './WorkflowProjectRow';
import { useWorkflowPublicationReferences } from './WorkflowPublicationReferences';
import { WorkflowBundleIcon } from './WorkflowBundleIcon';
import { namespaceIdentity } from './workflowNamespaceMutations';

export function WorkflowFolderRow({
  name,
  expanded,
  projectCount,
  isBundle,
  renaming,
  renameInput,
  className = 'folder-row',
  ...events
}: Omit<ComponentPropsWithoutRef<'div'>, 'children'> & {
  name: string;
  expanded: boolean;
  projectCount: number;
  isBundle?: boolean;
  renaming?: boolean;
  renameInput?: ReactNode;
}) {
  const editing = renameInput != null;
  const busy = editing || renaming;
  return (
    <div
      className={className}
      role={busy ? undefined : 'button'}
      tabIndex={busy ? undefined : 0}
      aria-busy={renaming || undefined}
      aria-expanded={busy ? undefined : expanded}
      aria-label={busy ? `Renaming ${name}` : `${expanded ? 'Collapse' : 'Expand'} ${name}${isBundle ? ' bundle' : ''}`}
      {...events}
    >
      <span className="folder-toggle" aria-hidden="true">
        {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
      </span>
      <div className="folder-content">
        <div className="folder-name-button" title={editing ? undefined : name}>
          <div className="folder-main">
            {editing ? (
              renameInput
            ) : (
              <div className="folder-label-wrap">
                {renaming ? <span className="folder-rename-spinner" aria-hidden="true" /> : null}
                <div className="label">
                  {isBundle ? (
                    <WorkflowBundleIcon aria-label="Bundle" role="img" className="folder-bundle-icon" />
                  ) : null}
                  {name}
                </div>
              </div>
            )}
            <div
              className="folder-project-count"
              aria-label={`${projectCount} project${projectCount === 1 ? '' : 's'} in ${name}`}
            >
              {projectCount}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

type WorkflowFolderTreeProps = {
  folders: WorkflowFolderItem[];
  rootProjects: WorkflowProjectItem[];
  activePath: string;
  draggedItem: DraggedWorkflowItem | null;
  dropTargetFolderPath: string | null;
  editingFolderId: string | null;
  renamingFolderId: string | null;
  editingProjectPath: string | null;
  renamingProjectPath: string | null;
  expandedFolders: Record<string, boolean>;
  editorReady: boolean;
  setProjectRowRef: (path: string, node: HTMLElement | null) => void;
  onProjectPreviewOpen: (project: WorkflowProjectItem) => void;
  onProjectPersistentOpen: (project: WorkflowProjectItem) => void;
  onProjectContextMenu: (project: WorkflowProjectItem, event: React.MouseEvent<HTMLElement>) => void;
  onFolderContextMenu: (folder: WorkflowFolderItem, event: React.MouseEvent<HTMLDivElement>) => void;
  onDragStart: (item: DraggedWorkflowItem) => (event: React.DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onFolderClick: (folder: WorkflowFolderItem) => (event: React.MouseEvent<HTMLElement>) => void;
  onFolderKeyDown: (folder: WorkflowFolderItem) => (event: React.KeyboardEvent<HTMLDivElement>) => void;
  onProjectKeyDown: (project: WorkflowProjectItem) => (event: React.KeyboardEvent<HTMLElement>) => void;
  onFolderRenameSubmit: (folder: WorkflowFolderItem, name: string) => void | Promise<void>;
  onFolderRenameCancel: (folder: WorkflowFolderItem) => void;
  onProjectRenameSubmit: (project: WorkflowProjectItem, name: string) => void | Promise<void>;
  onProjectRenameCancel: (project: WorkflowProjectItem) => void;
  onFolderDragOver: (folder: WorkflowFolderItem) => (event: React.DragEvent<HTMLElement>) => void;
  onFolderDrop: (folder: WorkflowFolderItem) => (event: React.DragEvent<HTMLElement>) => void;
  onFolderDragLeave: (folder: WorkflowFolderItem) => void;
  getParentRelativePath: (relativePath: string) => string;
};

export const WorkflowFolderTree: FC<WorkflowFolderTreeProps> = ({
  folders,
  rootProjects,
  activePath,
  draggedItem,
  dropTargetFolderPath,
  editingFolderId,
  renamingFolderId,
  editingProjectPath,
  renamingProjectPath,
  expandedFolders,
  editorReady,
  setProjectRowRef,
  onProjectPreviewOpen,
  onProjectPersistentOpen,
  onProjectContextMenu,
  onFolderContextMenu,
  onDragStart,
  onDragEnd,
  onFolderClick,
  onFolderKeyDown,
  onProjectKeyDown,
  onFolderRenameSubmit,
  onFolderRenameCancel,
  onProjectRenameSubmit,
  onProjectRenameCancel,
  onFolderDragOver,
  onFolderDrop,
  onFolderDragLeave,
  getParentRelativePath,
}) => {
  const references = useWorkflowPublicationReferences();
  const normalizedActivePath = normalizeWorkflowPath(activePath);
  const renderFolderRenameInput = (folder: WorkflowFolderItem) => (
    <FolderRenameInput folder={folder} onSubmit={onFolderRenameSubmit} onCancel={onFolderRenameCancel} />
  );

  const renderProjectRow = (project: WorkflowProjectItem) => (
    <WorkflowProjectRow
      key={project.id}
      project={project}
      activePath={activePath}
      draggedItem={draggedItem}
      editing={editingProjectPath === project.absolutePath}
      renaming={renamingProjectPath === project.absolutePath}
      editorReady={editorReady}
      setProjectRowRef={setProjectRowRef}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onPreviewOpen={onProjectPreviewOpen}
      onPersistentOpen={onProjectPersistentOpen}
      onContextMenu={onProjectContextMenu}
      onKeyDown={onProjectKeyDown}
      onRenameSubmit={onProjectRenameSubmit}
      onRenameCancel={onProjectRenameCancel}
      getParentRelativePath={getParentRelativePath}
    />
  );

  const renderFolder = (folder: WorkflowFolderItem): JSX.Element => {
    const expanded = expandedFolders[folder.id] ?? false;
    const isEditing = editingFolderId === folder.id;
    const isRenaming = renamingFolderId === folder.id;
    const rowIsBusy = isEditing || isRenaming;
    const projectCount = countProjectsInFolder(folder);
    const external = folder.bundleId ? references?.byBundle.get(folder.bundleId) : undefined;
    const visibleExternal = external && (external.count > 0 || !external.complete) && !rowIsBusy ? external : null;
    const rowClassName = [
      'folder-row',
      // Closed ancestors do not render their children, so only the outermost
      // closed folder containing the selection can receive this highlight.
      !expanded && normalizedActivePath.startsWith(`${normalizeWorkflowPath(folder.absolutePath)}/`)
        ? 'contains-selection'
        : null,
      isEditing ? 'editing' : null,
      isRenaming ? 'renaming' : null,
      dropTargetFolderPath === folder.relativePath ? 'drag-over' : null,
      draggedItem?.itemType === 'folder' && draggedItem.absolutePath === folder.absolutePath ? 'dragging' : null,
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <div className="folder" key={folder.id}>
        <div className={`folder-row-with-references${visibleExternal ? ' has-external-references' : ''}`}>
          <WorkflowFolderRow
            name={folder.name}
            expanded={expanded}
            isBundle={!!folder.bundleId}
            projectCount={projectCount}
            renaming={isRenaming}
            renameInput={isEditing ? renderFolderRenameInput(folder) : undefined}
            className={rowClassName}
            draggable={editorReady && !rowIsBusy}
            onClick={rowIsBusy ? undefined : onFolderClick(folder)}
            onKeyDown={rowIsBusy ? undefined : onFolderKeyDown(folder)}
            onContextMenu={rowIsBusy ? undefined : (event) => onFolderContextMenu(folder, event)}
            onDragStart={onDragStart({
              itemType: 'folder',
              expectedSource: namespaceIdentity(folder),
              absolutePath: folder.absolutePath,
              relativePath: folder.relativePath,
              parentRelativePath: getParentRelativePath(folder.relativePath),
            })}
            onDragEnd={onDragEnd}
            onDragOver={onFolderDragOver(folder)}
            onDragLeave={() => onFolderDragLeave(folder)}
            onDrop={onFolderDrop(folder)}
          />

          {visibleExternal ? (
            <button
              className="bundle-external-references"
              type="button"
              onClick={() => references?.open({ bundle: folder })}
            >
              {visibleExternal.count > 0
                ? `${visibleExternal.count}${visibleExternal.complete ? '' : '+'} external reference${visibleExternal.count === 1 ? '' : 's'}`
                : 'External references pending'}
            </button>
          ) : null}
        </div>

        {expanded ? (
          <div className="folder-children">
            {(folder.folders ?? []).map((childFolder) => renderFolder(childFolder))}
            {(folder.folders ?? []).length === 0 && folder.projects.length === 0 ? (
              <div className="state folder-empty-state">
                <span>No Rivet projects in this folder.</span>
              </div>
            ) : null}
            {folder.projects.map((project) => renderProjectRow(project))}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <>
      {rootProjects.length > 0 ? (
        <div className="projects">{rootProjects.map((project) => renderProjectRow(project))}</div>
      ) : null}
      {folders.map((folder) => renderFolder(folder))}
    </>
  );
};

type FolderRenameInputProps = {
  folder: WorkflowFolderItem;
  onSubmit: (folder: WorkflowFolderItem, name: string) => void | Promise<void>;
  onCancel: (folder: WorkflowFolderItem) => void;
};

const FolderRenameInput: FC<FolderRenameInputProps> = ({ folder, onSubmit, onCancel }) => (
  <WorkflowInlineRenameInput
    classNamePrefix="folder"
    initialValue={folder.name}
    identityKey={folder.id}
    ariaLabel={`Rename ${folder.name}`}
    onSubmit={(value) => onSubmit(folder, value)}
    onCancel={() => onCancel(folder)}
  />
);
