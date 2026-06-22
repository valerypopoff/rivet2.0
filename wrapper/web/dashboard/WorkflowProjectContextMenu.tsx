import {
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
  type VirtualElement,
} from '@floating-ui/react';
import CopyIcon from '@atlaskit/icon/glyph/copy';
import ArrowDownIcon from 'majesticons/line/arrow-down-line.svg?react';
import DeleteBinIcon from 'majesticons/line/delete-bin-line.svg?react';
import { useLayoutEffect, type FC } from 'react';
import type { WorkflowProjectItem } from './types';

type WorkflowProjectContextMenuProps = {
  isOpen: boolean;
  project: WorkflowProjectItem | null;
  x: number;
  y: number;
  onClose: () => void;
  onRename: () => void;
  onDownload: () => void;
  onDuplicate: () => void;
  canCompare: boolean;
  onCompare: () => void;
  canCompareToPublishedVersion: boolean;
  onCompareToPublishedVersion: () => void;
  canDelete: boolean;
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

export const WorkflowProjectContextMenu: FC<WorkflowProjectContextMenuProps> = ({
  isOpen,
  project,
  x,
  y,
  onClose,
  onRename,
  onDownload,
  onDuplicate,
  canCompare,
  onCompare,
  canCompareToPublishedVersion,
  onCompareToPublishedVersion,
  canDelete,
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
    middleware: [
      offset(6),
      shift({ padding: 8 }),
    ],
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

  if (!isOpen || !project) {
    return null;
  }

  return (
    <div
      ref={refs.setFloating}
      className="workflow-project-context-menu"
      style={floatingStyles}
      aria-label={`Actions for ${project.name}`}
      {...getFloatingProps()}
    >
      <button
        type="button"
        className="workflow-project-context-menu-item"
        role="menuitem"
        onClick={onRename}
      >
        <span>Rename project</span>
      </button>
      {canCompare ? (
        <button
          type="button"
          className="workflow-project-context-menu-item"
          role="menuitem"
          onClick={onCompare}
        >
          <span>Compare opened project with this one</span>
        </button>
      ) : null}
      {canCompareToPublishedVersion ? (
        <button
          type="button"
          className="workflow-project-context-menu-item"
          role="menuitem"
          onClick={onCompareToPublishedVersion}
        >
          <span>Compare to the published version</span>
        </button>
      ) : null}
      <div className="workflow-project-context-menu-separator" role="separator" aria-hidden="true" />
      <button
        type="button"
        className="workflow-project-context-menu-item"
        role="menuitem"
        onClick={onDownload}
      >
        <ArrowDownIcon className="workflow-project-context-menu-item-icon" aria-hidden="true" />
        <span>Download</span>
      </button>
      <button
        type="button"
        className="workflow-project-context-menu-item"
        role="menuitem"
        onClick={onDuplicate}
      >
        <span className="workflow-project-context-menu-item-icon" aria-hidden="true">
          <CopyIcon label="" size="small" />
        </span>
        <span>Duplicate</span>
      </button>
      <div className="workflow-project-context-menu-separator" role="separator" aria-hidden="true" />
      <button
        type="button"
        className={`workflow-project-context-menu-item workflow-project-context-menu-item-danger${!canDelete ? ' workflow-project-context-menu-item-disabled' : ''}`}
        role="menuitem"
        aria-disabled={!canDelete}
        onClick={onDelete}
      >
        <DeleteBinIcon className="workflow-project-context-menu-item-icon" aria-hidden="true" />
        <span>Delete project</span>
      </button>
    </div>
  );
};
