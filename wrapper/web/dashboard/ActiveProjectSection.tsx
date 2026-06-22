import Button, { LoadingButton } from '@atlaskit/button';
import { type FC } from 'react';

import type { WorkflowProjectItem, WorkflowProjectStatus } from './types';

const STATUS_LABELS: Record<WorkflowProjectStatus, string> = {
  unpublished: 'Unpublished',
  published: 'Published',
  unpublished_changes: 'Unpublished changes',
};

type ActiveProjectSectionProps = {
  activeProject: WorkflowProjectItem | null;
  isCurrentlyOpen: boolean;
  hasUnsavedChanges: boolean;
  editorReady: boolean;
  onSave: () => void;
  onOpenSettings: () => void;
};

export const ActiveProjectSection: FC<ActiveProjectSectionProps> = ({
  activeProject,
  isCurrentlyOpen,
  hasUnsavedChanges,
  editorReady,
  onSave,
  onOpenSettings,
}) => {
  if (!activeProject) {
    return (
      <div className="active-project-section active-project-section-empty">
        <div className="active-project-placeholder">
          Select a project <br /> to see its properties
        </div>
      </div>
    );
  }

  const statusLabel = STATUS_LABELS[activeProject.settings.status];
  const baseName = activeProject.fileName.replace(/\.[^.]+$/, '');
  const graphCount = activeProject.stats?.graphCount ?? 0;
  const totalNodeCount = activeProject.stats?.totalNodeCount ?? 0;
  const projectStatsLabel = `${graphCount} ${graphCount === 1 ? 'graph' : 'graphs'}, ${totalNodeCount} ${totalNodeCount === 1 ? 'node' : 'nodes'} total`;
  const showSaveButton = isCurrentlyOpen && hasUnsavedChanges;

  return (
    <div className={`active-project-section ${activeProject.settings.status}`}>
      <div className="active-project-section-content">
        <div className="active-project-details">
          <div className="active-project-name-row" title={`${statusLabel} ${baseName}`}>
            <span className={`project-status-badge ${activeProject.settings.status}`}>
              {statusLabel}
            </span>
            <span className="active-project-name">{baseName}</span>
          </div>
          <div className="active-project-stats">{projectStatsLabel}</div>
          <div className="active-project-actions-row">
            <Button
              appearance="subtle"
              className="active-project-more-button project-settings-secondary-button button-size-m"
              onClick={onOpenSettings}
            >
              Settings
            </Button>
            {showSaveButton ? (
              <LoadingButton
                appearance="primary"
                className="active-project-save-button button-size-m"
                isDisabled={!editorReady}
                onClick={onSave}
                title={editorReady ? 'Save current project' : 'Loading editor...'}
                aria-label={editorReady ? 'Save current project' : 'Loading editor'}
              >
                Save
              </LoadingButton>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
};
