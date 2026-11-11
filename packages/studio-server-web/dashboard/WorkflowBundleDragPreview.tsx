import { createPortal } from 'react-dom';
import MergeIcon from 'majesticons/line/git-merge-line.svg?react';
import { WorkflowBundleIcon } from './WorkflowBundleIcon';
import type { BundleDragPreview } from './workflowLibraryHelpers';

export function WorkflowBundleDragPreview({ preview }: { preview: BundleDragPreview | null }) {
  if (!preview) return null;
  const left = Math.max(8, Math.min(preview.x + 12, window.innerWidth - 48));
  const top = Math.max(8, Math.min(preview.y + 16, window.innerHeight - 40));
  return createPortal(
    <div
      className="workflow-bundle-drag-preview"
      data-testid="workflow-bundle-drag-preview"
      aria-hidden="true"
      style={{ left, top, maxWidth: Math.min(260, window.innerWidth - left - 8) }}
    >
      {preview.merge ? <MergeIcon data-testid="bundle-merge-drag-icon" /> : <WorkflowBundleIcon />}
      <span>{preview.name}</span>
    </div>,
    document.body,
  );
}
