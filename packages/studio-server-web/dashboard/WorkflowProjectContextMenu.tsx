import {
  autoUpdate,
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
import RecordingIcon from 'majesticons/line/video-line.svg?react';
import { useLayoutEffect, useRef, type FC } from 'react';
import type { HostedRouteConfig, WorkflowProjectItem } from './types';
import { useHostedSurfaceDismiss } from './useHostedSurfaceDismiss';
import { WorkflowProjectSummary } from './WorkflowProjectSummary';

type WorkflowProjectContextMenuProps = {
  isOpen: boolean;
  project: WorkflowProjectItem | null;
  routeConfig: HostedRouteConfig;
  x: number;
  y: number;
  onClose: () => void;
  isCurrentlyOpen: boolean;
  hasUnsavedChanges: boolean;
  editorReady: boolean;
  onSave: () => void;
  onOpenSettings: () => void;
  onRename: () => void;
  onInspectRecordings: () => void;
  onInspectStatistics: () => void;
  onDownload: () => void;
  onDuplicate: () => void;
  canCompare: boolean;
  onCompare: () => void;
  canCompareToPublishedVersion: boolean;
  onCompareToPublishedVersion: () => void;
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
  routeConfig,
  x,
  y,
  onClose,
  isCurrentlyOpen,
  hasUnsavedChanges,
  editorReady,
  onSave,
  onOpenSettings,
  onRename,
  onInspectRecordings,
  onInspectStatistics,
  onDownload,
  onDuplicate,
  canCompare,
  onCompare,
  canCompareToPublishedVersion,
  onCompareToPublishedVersion,
  onDelete,
}) => {
  useHostedSurfaceDismiss(onClose, isOpen);
  const summaryRef = useRef<HTMLDivElement>(null);
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
      offset(({ elements }) => ({
        mainAxis: -(summaryRef.current?.getBoundingClientRect().height ?? 0) - elements.floating.clientTop,
        crossAxis: -elements.floating.clientLeft,
      })),
      shift({ padding: 8, crossAxis: true }),
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
    // The summary can resize even while the menu itself is capped by the viewport.
    const observer = new ResizeObserver(() => void update());
    if (summaryRef.current) observer.observe(summaryRef.current);
    return () => observer.disconnect();
  }, [isOpen, refs, update, x, y]);

  if (!isOpen || !project) {
    return null;
  }

  return (
    <div
      ref={refs.setFloating}
      className="workflow-project-context-menu workflow-project-context-menu-with-summary"
      style={floatingStyles}
      aria-label={`Actions for ${project.name}`}
      {...getFloatingProps()}
    >
      <div ref={summaryRef} className="workflow-project-context-menu-header" role="presentation">
        <WorkflowProjectSummary
          project={project}
          routeConfig={routeConfig}
          isCurrentlyOpen={isCurrentlyOpen}
          hasUnsavedChanges={hasUnsavedChanges}
          editorReady={editorReady}
          onSave={onSave}
          onOpenSettings={onOpenSettings}
          onCloseMenu={onClose}
        />
      </div>
      <div className="workflow-project-context-menu-actions" role="presentation">
        <button type="button" className="workflow-project-context-menu-item" role="menuitem" onClick={onRename}>
          <span>Rename project</span>
        </button>
        {canCompare ? (
          <button type="button" className="workflow-project-context-menu-item" role="menuitem" onClick={onCompare}>
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
        <button type="button" className="workflow-project-context-menu-item" role="menuitem" onClick={onDownload}>
          <ArrowDownIcon className="workflow-project-context-menu-item-icon" aria-hidden="true" />
          <span>Download project</span>
        </button>
        <button type="button" className="workflow-project-context-menu-item" role="menuitem" onClick={onDuplicate}>
          <span className="workflow-project-context-menu-item-icon" aria-hidden="true">
            <CopyIcon label="" size="small" />
          </span>
          <span>Duplicate</span>
        </button>
        <div className="workflow-project-context-menu-separator" role="separator" aria-hidden="true" />
        <button
          type="button"
          className="workflow-project-context-menu-item"
          role="menuitem"
          onClick={onInspectRecordings}
        >
          <RecordingIcon className="workflow-project-context-menu-item-icon" aria-hidden="true" />
          <span>Inspect recordings</span>
        </button>
        <button
          type="button"
          className="workflow-project-context-menu-item"
          role="menuitem"
          onClick={onInspectStatistics}
        >
          <svg className="workflow-project-context-menu-item-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="m4 17 5-6 5 3 6-10"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span>Run statistics</span>
        </button>
        <div className="workflow-project-context-menu-separator" role="separator" aria-hidden="true" />
        <button
          type="button"
          className="workflow-project-context-menu-item workflow-project-context-menu-item-danger"
          role="menuitem"
          onClick={onDelete}
        >
          <DeleteBinIcon className="workflow-project-context-menu-item-icon" aria-hidden="true" />
          <span>Delete project</span>
        </button>
      </div>
    </div>
  );
};
