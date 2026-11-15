import {
  autoUpdate,
  safePolygon,
  useHover,
  useClick,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
  type VirtualElement,
} from '@floating-ui/react';
import ArrowUpIcon from 'majesticons/line/arrow-up-line.svg?react';
import CopyIcon from '@atlaskit/icon/glyph/copy';
import DeleteBinIcon from 'majesticons/line/delete-bin-line.svg?react';
import FolderIcon from 'majesticons/line/folder-line.svg?react';
import MergeIcon from 'majesticons/line/git-merge-line.svg?react';
import PlusIcon from 'majesticons/line/plus-line.svg?react';
import SubmenuArrowIcon from '../../app/src/assets/icons/submenu-arrow.svg?react';
import { useLayoutEffect, useState, type ReactNode, type KeyboardEvent, type FC } from 'react';
import type { WorkflowFolderItem } from './types';
import { BundleTransferIcon } from './BundleTransferIcon';
import { WorkflowBundleIcon } from './WorkflowBundleIcon';
import { useHostedSurfaceDismiss } from './useHostedSurfaceDismiss';

type WorkflowFolderContextMenuProps = {
  isOpen: boolean;
  folder: WorkflowFolderItem | null;
  x: number;
  y: number;
  onClose: () => void;
  canDelete: boolean;
  bundleActions?: {
    canConvert: boolean;
    busy: boolean;
    convert(): void;
    duplicate(): void;
    merge?: () => void;
    compare?: () => void;
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

const BUNDLE_SUBMENU_OFFSET = 12;

function BundleActionsSubmenu({
  children,
  onWidthChange,
}: {
  children: ReactNode;
  onWidthChange(width: number): void;
}) {
  const [open, setOpen] = useState(false);
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'right-start',
    strategy: 'fixed',
    whileElementsMounted: autoUpdate,
    middleware: [offset(BUNDLE_SUBMENU_OFFSET), shift({ padding: 8 })],
  });
  useLayoutEffect(() => {
    const element = refs.floating.current;
    if (!open || !element) return;
    const measure = () => onWidthChange(element.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
      onWidthChange(0);
    };
  }, [open, refs.floating, onWidthChange]);
  const hover = useHover(context, { handleClose: safePolygon() });
  const click = useClick(context, { keyboardHandlers: false });
  const role = useRole(context, { role: 'menu' });
  const { getReferenceProps, getFloatingProps } = useInteractions([hover, click, role]);
  const focusFirst = () =>
    requestAnimationFrame(() =>
      refs.floating.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(),
    );
  return (
    <>
      <button
        type="button"
        role="menuitem"
        className="workflow-project-context-menu-item"
        ref={refs.setReference}
        aria-haspopup="menu"
        aria-expanded={open}
        {...getReferenceProps({
          onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
            if (['ArrowRight', 'ArrowDown', 'Enter', ' '].includes(event.key)) {
              event.preventDefault();
              setOpen(true);
              focusFirst();
            }
          },
        })}
      >
        <WorkflowBundleIcon className="workflow-project-context-menu-item-icon" aria-hidden="true" />
        <span>Bundle actions</span>
        <SubmenuArrowIcon className="workflow-bundle-submenu-arrow" aria-hidden="true" focusable="false" />
      </button>
      {open ? (
        <div
          ref={refs.setFloating}
          style={floatingStyles}
          className="workflow-project-context-menu workflow-bundle-submenu"
          aria-label="Bundle actions"
          {...getFloatingProps({
            onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
              if (event.key === 'Escape' || event.key === 'ArrowLeft') {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
                (refs.reference.current as HTMLButtonElement | null)?.focus();
              } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const items = Array.from(
                  event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
                );
                const index = items.indexOf(document.activeElement as HTMLButtonElement);
                items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
              }
            },
          })}
        >
          {children}
        </div>
      ) : null}
    </>
  );
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
  const [submenuWidth, setSubmenuWidth] = useState(0);
  useHostedSurfaceDismiss(onClose, isOpen);
  const { context, refs, floatingStyles, update } = useFloating({
    open: isOpen,
    onOpenChange(nextOpen) {
      if (!nextOpen) {
        onClose();
      }
    },
    placement: 'bottom-start',
    strategy: 'fixed',
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(6),
      shift({
        crossAxis: true,
        padding: {
          top: 8,
          bottom: 8,
          left: 8,
          right: 8 + (submenuWidth ? submenuWidth + BUNDLE_SUBMENU_OFFSET : 0),
        },
      }),
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
  }, [isOpen, refs, update, x, y, submenuWidth]);

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
      {bundleActions && folder.bundleId ? (
        <BundleActionsSubmenu onWidthChange={setSubmenuWidth}>
          <button
            type="button"
            className="workflow-project-context-menu-item"
            role="menuitem"
            onClick={bundleActions.download}
          >
            <BundleTransferIcon direction="down" />
            <span>Download bundle</span>
          </button>
          <button
            type="button"
            className="workflow-project-context-menu-item"
            role="menuitem"
            onClick={bundleActions.duplicate}
            disabled={bundleActions.busy}
          >
            <span className="workflow-project-context-menu-item-icon" aria-hidden="true">
              <CopyIcon label="" size="small" />
            </span>
            <span>Duplicate bundle</span>
          </button>
          {bundleActions.canConvert ? (
            <button
              type="button"
              className="workflow-project-context-menu-item"
              role="menuitem"
              onClick={bundleActions.convert}
              disabled={bundleActions.busy}
            >
              <FolderIcon className="workflow-project-context-menu-item-icon" aria-hidden="true" />
              <span>Convert to ordinary folder</span>
            </button>
          ) : null}
          {bundleActions.merge ? (
            <>
              <div className="workflow-project-context-menu-separator" role="separator" aria-hidden="true" />
              <button
                type="button"
                className="workflow-project-context-menu-item"
                role="menuitem"
                onClick={bundleActions.merge}
                disabled={bundleActions.busy}
              >
                <MergeIcon className="workflow-project-context-menu-item-icon" aria-hidden="true" />
                Merge into another bundle…
              </button>
            </>
          ) : null}
          {bundleActions.compare ? (
            <>
              <div className="workflow-project-context-menu-separator" role="separator" aria-hidden="true" />
              <button
                type="button"
                className="workflow-project-context-menu-item"
                role="menuitem"
                disabled={bundleActions.busy}
                onClick={bundleActions.compare}
              >
                Compare with another bundle…
              </button>
            </>
          ) : null}
        </BundleActionsSubmenu>
      ) : bundleActions?.canConvert ? (
        <button
          type="button"
          className="workflow-project-context-menu-item"
          role="menuitem"
          onClick={bundleActions.convert}
          disabled={bundleActions.busy}
        >
          <WorkflowBundleIcon className="workflow-project-context-menu-item-icon" aria-hidden="true" />
          <span>Convert to bundle</span>
        </button>
      ) : null}
      <div className="workflow-project-context-menu-separator" role="separator" aria-hidden="true" />
      <button type="button" className="workflow-project-context-menu-item" role="menuitem" onClick={onCreateFolder}>
        <PlusIcon className="workflow-project-context-menu-item-icon" aria-hidden="true" />
        <span>New folder</span>
      </button>
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
        <span>{folder.bundleId ? 'Delete bundle' : 'Delete folder'}</span>
      </button>
    </div>
  );
};
