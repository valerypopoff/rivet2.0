import {
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
  type VirtualElement,
} from '@floating-ui/react';
import ArrowUpIcon from 'majesticons/line/arrow-up-line.svg?react';
import DeleteBinIcon from 'majesticons/line/delete-bin-line.svg?react';
import PlusIcon from 'majesticons/line/plus-line.svg?react';
import { useLayoutEffect, type FC } from 'react';
import type { WorkflowFolderItem } from './types';
import { BundleTransferIcon } from './BundleTransferIcon';
import { WorkflowBundleIcon } from './WorkflowBundleIcon';

type WorkflowFolderContextMenuProps = {
  isOpen: boolean;
  folder: WorkflowFolderItem | null;
  x: number;
  y: number;
  onClose: () => void;
  canDelete: boolean;
  bundleActions?: {
    canConvert: boolean;
    convert(): void;
    duplicate(): void;
    download(): void;
  };
  onRename: () => void;
  onCreateFolder: () => void;
  onCreateProject: () => void;
  onUploadProject: () => void;
  onUploadBundle?: () => void;
  onDelete: () => void;
};

function createVirtualContextTarget(x: number, y: number): VirtualElement {
  return {
    getBoundingClientRect() {
      return {
        x,
        y,
        top: y,
        right: x,
        bottom: y,
        left: x,
        width: 0,
        height: 0,
      };
    },
  };
}

export const WorkflowFolderContextMenu: FC<WorkflowFolderContextMenuProps> = ({
  isOpen,
  folder,
  x,
  y,
  onClose,
  canDelete,
  bundleActions,
  onRename,
  onCreateFolder,
  onCreateProject,
  onUploadProject,
  onUploadBundle,
  onDelete,
}) => {
  const { context, refs, floatingStyles, update } = useFloating({
    open: isOpen,
    onOpenChange(nextOpen) {
      if (!nextOpen) {
        onClose();
      }
    },
    placement: 'bottom-start',
    strategy: 'fixed',
    middleware: [offset(6), shift({ padding: 8 })],
  });

  const dismiss = useDismiss(context);
  const role = useRole(context, { role: 'menu' });
  const { getFloatingProps } = useInteractions([dismiss, role]);

  useLayoutEffect(() => {
    if (!isOpen) {
      return;
    }

    refs.setPositionReference(createVirtualContextTarget(x, y));
    void update();
  }, [isOpen, refs, update, x, y]);

  if (!isOpen || !folder) {
    return null;
  }

  return (
    <div
      ref={refs.setFloating}
      className="workflow-project-context-menu"
      style={floatingStyles}
      aria-label={`Actions for ${folder.name}`}
      {...getFloatingProps()}
    >
      <button type="button" className="workflow-project-context-menu-item" role="menuitem" onClick={onRename}>
        <span>Rename {folder.bundleId ? 'bundle' : 'folder'}</span>
      </button>
      <button type="button" className="workflow-project-context-menu-item" role="menuitem" onClick={onCreateFolder}>
        <PlusIcon className="workflow-project-context-menu-item-icon" aria-hidden="true" />
        <span>New folder</span>
      </button>
      {bundleActions ? (
        <>
          {bundleActions.canConvert ? (
            <button
              type="button"
              className="workflow-project-context-menu-item"
              role="menuitem"
              onClick={bundleActions.convert}
            >
              <WorkflowBundleIcon className="workflow-project-context-menu-item-icon" aria-hidden="true" />
              <span>{folder.bundleId ? 'Convert to ordinary folder' : 'Convert to bundle'}</span>
            </button>
          ) : null}
          {folder.bundleId ? (
            <button
              type="button"
              className="workflow-project-context-menu-item"
              role="menuitem"
              onClick={bundleActions.download}
            >
              <BundleTransferIcon direction="down" />
              <span>Download bundle</span>
            </button>
          ) : null}
          {folder.bundleId ? (
            <button
              type="button"
              className="workflow-project-context-menu-item"
              role="menuitem"
              onClick={bundleActions.duplicate}
            >
              Duplicate bundle
            </button>
          ) : null}
        </>
      ) : null}
      <div className="workflow-project-context-menu-separator" role="separator" aria-hidden="true" />
      <button type="button" className="workflow-project-context-menu-item" role="menuitem" onClick={onCreateProject}>
        <PlusIcon className="workflow-project-context-menu-item-icon" aria-hidden="true" />
        <span>New project</span>
      </button>
      <button type="button" className="workflow-project-context-menu-item" role="menuitem" onClick={onUploadProject}>
        <ArrowUpIcon className="workflow-project-context-menu-item-icon" aria-hidden="true" />
        <span>Upload project</span>
      </button>
      {onUploadBundle ? (
        <button type="button" className="workflow-project-context-menu-item" role="menuitem" onClick={onUploadBundle}>
          <BundleTransferIcon direction="up" />
          <span>Upload bundle</span>
        </button>
      ) : null}
      <div className="workflow-project-context-menu-separator" role="separator" aria-hidden="true" />
      <button
        type="button"
        className={`workflow-project-context-menu-item workflow-project-context-menu-item-danger${!canDelete ? ' workflow-project-context-menu-item-disabled' : ''}`}
        role="menuitem"
        aria-disabled={!canDelete}
        onClick={onDelete}
      >
        <DeleteBinIcon className="workflow-project-context-menu-item-icon" aria-hidden="true" />
        <span>Delete folder</span>
      </button>
    </div>
  );
};
