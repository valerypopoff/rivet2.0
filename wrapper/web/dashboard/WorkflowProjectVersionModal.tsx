import Button, { LoadingButton } from '@atlaskit/button';
import ModalDialog, { ModalBody, ModalTransition } from '@atlaskit/modal-dialog';
import { type FC } from 'react';
import type { WorkflowProjectDownloadVersion, WorkflowProjectItem } from './types';

type WorkflowProjectVersionModalProps = {
  isOpen: boolean;
  project: WorkflowProjectItem | null;
  actionLabel: 'Download' | 'Duplicate' | 'Compare';
  activeVersion: WorkflowProjectDownloadVersion | null;
  onClose: () => void;
  onSelectPublished: () => void;
  onSelectUnpublishedChanges: () => void;
};

export const WorkflowProjectVersionModal: FC<WorkflowProjectVersionModalProps> = ({
  isOpen,
  project,
  actionLabel,
  activeVersion,
  onClose,
  onSelectPublished,
  onSelectUnpublishedChanges,
}) => {
  if (!isOpen || !project) {
    return null;
  }

  const canClose = activeVersion == null;
  const actionDescription = actionLabel === 'Compare'
    ? 'The reference side comes from saved server state; unsaved editor changes in that reference project are not included.'
    : 'Unsaved editor changes are not included.';

  return (
    <ModalTransition>
      <ModalDialog
        testId="workflow-project-version-modal"
        width="medium"
        label={`${actionLabel} ${project.name}`}
        onClose={onClose}
        shouldCloseOnOverlayClick={canClose}
        shouldCloseOnEscapePress={canClose}
      >
        <ModalBody>
          <div className="project-settings-modal-shell">
            <div className="project-settings-modal-header-row">
              <div className="project-settings-modal-heading">
                <div className="project-settings-modal-title" title={project.name}>
                  {actionLabel}
                </div>
              </div>
              <button
                type="button"
                className="project-settings-close-button"
                onClick={onClose}
                disabled={!canClose}
                aria-label={`Close project ${actionLabel.toLowerCase()} chooser`}
              >
                {'\u00d7'}
              </button>
            </div>

            <div className="project-settings-modal-content workflow-project-version-modal-content">
              <div className="project-settings-help workflow-project-version-help">
                {project.name}: choose which saved version to {actionLabel.toLowerCase()}. {actionDescription}
              </div>

              <div className="workflow-project-version-actions">
                <LoadingButton
                  appearance="primary"
                  className="project-settings-primary-button button-size-l workflow-project-version-published-button"
                  onClick={onSelectPublished}
                  isDisabled={activeVersion != null}
                  isLoading={activeVersion === 'published'}
                >
                  {actionLabel} "Published"
                </LoadingButton>
                <LoadingButton
                  appearance="subtle"
                  className="project-settings-secondary-button button-size-l workflow-project-version-secondary-button workflow-project-version-live-button"
                  onClick={onSelectUnpublishedChanges}
                  isDisabled={activeVersion != null}
                  isLoading={activeVersion === 'live'}
                >
                  {actionLabel} "Unpublished changes"
                </LoadingButton>
              </div>

              <div className="workflow-project-version-footer">
                <Button
                  appearance="subtle"
                  className="project-settings-secondary-button button-size-l"
                  onClick={onClose}
                  isDisabled={!canClose}
                >
                  Cancel
                </Button>
              </div>
            </div>
          </div>
        </ModalBody>
      </ModalDialog>
    </ModalTransition>
  );
};
