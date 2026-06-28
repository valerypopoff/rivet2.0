import Button, { LoadingButton } from '@atlaskit/button';
import ModalDialog, { ModalBody, ModalTransition } from '@atlaskit/modal-dialog';
import TextField from '@atlaskit/textfield';
import { type FC, useEffect, useMemo, type ReactNode, useState } from 'react';

import {
  RIVET_LATEST_WEB_APPS_BASE_PATH,
  RIVET_LATEST_WORKFLOWS_BASE_PATH,
  RIVET_PUBLISHED_WORKFLOWS_BASE_PATH,
  RIVET_WEB_APPS_BASE_PATH,
} from '../../shared/hosted-env';
import {
  formatLastPublishedAtLabel,
  getWorkflowProjectStatusLabel,
} from './projectSettingsForm';
import type {
  WorkflowProjectItem,
  WorkflowProjectStatus,
} from './types';
import { useProjectSettingsActions } from './useProjectSettingsActions';

const renderWorkflowEndpointHelp = (status: WorkflowProjectStatus, endpointName: string): ReactNode => {
  switch (status) {
    case 'unpublished':
      return null;
    case 'published':
      return (
        <>
          The workflow is accessible via the endpoint on 
          <br />
          <code className="project-settings-endpoint-code">
            {`${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH}/${endpointName}`}
          </code>
        </>
      );

    case 'unpublished_changes':
      return (
        <>
          Workflow has changes that are not live. 
          <br />
          <br />
          The published workflow version is still accessible on 
          <br />
          <code className="project-settings-endpoint-code">
            {`${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH}/${endpointName}`}
          </code>
          <br />
          <br />
          The unpublished changes are accessible on 
          <br />
          <code className="project-settings-endpoint-code">
            {`${RIVET_LATEST_WORKFLOWS_BASE_PATH}/${endpointName}`}
          </code>
        </>
      );
    default:
      return null;
  }
};

type ProjectSettingsTab = 'workflow' | 'web-apps';

type ProjectSettingsModalProps = {
  activeProject: WorkflowProjectItem;
  allProjects: WorkflowProjectItem[];
  isOpen: boolean;
  onClose: () => void;
  onRefresh: () => void | Promise<void>;
  onDeleteProject: (path: string, projectId?: string | null) => void;
  onOpenPublishedHistory: (project: WorkflowProjectItem) => void;
};

export const ProjectSettingsModal: FC<ProjectSettingsModalProps> = ({
  activeProject,
  allProjects,
  isOpen,
  onClose,
  onRefresh,
  onDeleteProject,
  onOpenPublishedHistory,
}) => {
  const [activeTab, setActiveTab] = useState<ProjectSettingsTab>('workflow');
  useEffect(() => {
    if (isOpen) {
      setActiveTab('workflow');
    }
  }, [activeProject.relativePath, isOpen]);
  const {
    settingsDraft,
    savingSettings,
    webApps,
    webAppSlugDrafts,
    webAppSlugValidationErrors,
    loadingWebApps,
    savingWebApps,
    deletingProject,
    handleSettingsDraftChange,
    handleWebAppSlugDraftChange,
    handlePublishProject,
    handleUnpublishProject,
    handlePublishWebApps,
    handleUnpublishWebApp,
    handleDeleteActiveProject,
    endpointValidationError,
  } = useProjectSettingsActions({
    activeProject,
    allProjects,
    isOpen,
    onClose,
    onDeleteProject,
    onRefresh,
  });

  const displayedProjectStatus: WorkflowProjectStatus = activeProject.settings.status;
  const baseFileName = useMemo(() => activeProject.fileName.replace(/\.[^.]+$/, ''), [activeProject.fileName]);
  const publishedEndpointName = activeProject.settings.endpointName || 'endpoint-name';
  const isUnpublishedProject = displayedProjectStatus === 'unpublished';
  const hasWorkflowChangesToPublish = displayedProjectStatus === 'unpublished_changes';
  const hasWorkflowEndpointDraftChange = settingsDraft.endpointName.trim() !== activeProject.settings.endpointName.trim();
  const hasWebApps = webApps.length > 0;
  const hasPublishedWebApps = webApps.some((webApp) => webApp.publishedSlug != null);
  const lastPublishedAtLabel = useMemo(
    () => formatLastPublishedAtLabel(displayedProjectStatus, activeProject.settings.lastPublishedAt),
    [activeProject.settings.lastPublishedAt, displayedProjectStatus],
  );
  const canCloseModal = !savingSettings && !savingWebApps && !deletingProject;
  const disablePublishAction =
    savingSettings ||
    deletingProject ||
    endpointValidationError != null ||
    (!isUnpublishedProject && !hasWorkflowChangesToPublish && !hasWorkflowEndpointDraftChange);
  const disableUnpublishAction = savingSettings || deletingProject;
  const disableDeleteProjectAction = savingSettings || savingWebApps || deletingProject || !isUnpublishedProject;
  const disableWebAppActions = savingSettings || savingWebApps || deletingProject || loadingWebApps;
  const workflowPublishButtonLabel = isUnpublishedProject ? 'Publish' : 'Update';
  const renderTabs = () => (
    <div className="project-settings-tabs" role="tablist" aria-label="Project settings sections">
      <button
        type="button"
        className={`project-settings-tab${activeTab === 'workflow' ? ' active' : ''}`}
        role="tab"
        aria-selected={activeTab === 'workflow'}
        onClick={() => setActiveTab('workflow')}
      >
        Workflow
      </button>
      <button
        type="button"
        className={`project-settings-tab${activeTab === 'web-apps' ? ' active' : ''}`}
        role="tab"
        aria-selected={activeTab === 'web-apps'}
        onClick={() => setActiveTab('web-apps')}
      >
        Web apps
      </button>
    </div>
  );
  const renderPublishedHistoryButton = () => (
    <Button
      appearance="subtle"
      className="project-settings-secondary-button button-size-l published-version-history-button"
      onClick={() => onOpenPublishedHistory(activeProject)}
      isDisabled={savingSettings || deletingProject}
    >
      Published version history
    </Button>
  );
  const renderWorkflowSettings = () => (
    <div className="project-settings-tab-panel" role="tabpanel">
      <div className="project-settings-status-block">
        <div className="active-project-status-row">
          <span className={`project-status-badge ${displayedProjectStatus}`}>
            {getWorkflowProjectStatusLabel(displayedProjectStatus)}
          </span>
          {isUnpublishedProject ? (
            <span className="project-settings-status-note">Workflow is not published as endpoint.</span>
          ) : null}
          {lastPublishedAtLabel ? (
            <span className="project-settings-last-published-at">{lastPublishedAtLabel}</span>
          ) : null}
        </div>
      </div>

      <div className="project-settings-field">
        <div className="project-settings-input-row project-settings-prefixed-input-row">
          <span className="project-settings-url-prefix">
            {`${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH}/`}
          </span>
          <TextField
            id="workflow-project-endpoint-name"
            className="project-settings-input text-field-size-l"
            value={settingsDraft.endpointName}
            onChange={handleSettingsDraftChange('endpointName')}
            isDisabled={savingSettings || deletingProject}
            isInvalid={endpointValidationError != null}
            aria-label="Workflow endpoint path"
            spellCheck={false}
          />
          <LoadingButton
            appearance="primary"
            className="project-settings-primary-button button-size-l"
            onClick={() => void handlePublishProject()}
            isDisabled={disablePublishAction}
            isLoading={savingSettings}
          >
            {workflowPublishButtonLabel}
          </LoadingButton>
          {!isUnpublishedProject ? (
            <Button
              appearance="subtle"
              className="project-settings-secondary-button button-size-l"
              onClick={() => void handleUnpublishProject()}
              isDisabled={disableUnpublishAction}
            >
              Unpublish
            </Button>
          ) : null}
        </div>
        {!isUnpublishedProject ? (
          <div className="project-settings-help project-settings-status-help">
            {renderWorkflowEndpointHelp(displayedProjectStatus, publishedEndpointName)}
          </div>
        ) : null}
        {endpointValidationError ? <div className="project-settings-error">{endpointValidationError}</div> : null}
      </div>

    </div>
  );

  const renderDangerSection = () => (
    <div className={`project-settings-danger-section${activeTab === 'workflow' ? ' has-history-action' : ''}`}>
      {activeTab === 'workflow' ? renderPublishedHistoryButton() : null}
      <Button
        appearance="subtle"
        className="project-settings-delete-button button-size-l"
        onClick={() => void handleDeleteActiveProject()}
        isDisabled={disableDeleteProjectAction}
      >
        {deletingProject ? 'Deleting...' : 'Delete project'}
      </Button>
    </div>
  );

  const renderWebAppsSettings = () => (
    <div className="project-settings-tab-panel project-settings-web-app-section" role="tabpanel">
      {loadingWebApps ? (
        <div className="project-settings-help">Loading project web apps...</div>
      ) : null}

      {!loadingWebApps && !hasWebApps ? (
        <div className="project-settings-help">No web apps in the project.</div>
      ) : null}

      {!loadingWebApps && hasWebApps && !hasPublishedWebApps ? (
        <div className="project-settings-help">No web apps are published.</div>
      ) : null}

      {!loadingWebApps && hasWebApps ? (
        <div className="project-settings-web-app-list">
          {webApps.map((webApp) => {
            const slugDraft = webAppSlugDrafts[webApp.uiGraphId] ?? '';
            const validationError = webAppSlugValidationErrors[webApp.uiGraphId] ?? null;
            const isPublished = webApp.publishedSlug != null;
            const displaySlug = isPublished ? webApp.publishedSlug! : slugDraft.trim() || 'slug';
            return (
              <div className="project-settings-web-app-row" key={webApp.uiGraphId}>
                <div className="project-settings-web-app-title-row">
                  <div className="project-settings-web-app-name" title={webApp.name}>
                    {webApp.name}
                  </div>
                  <span className={`project-settings-web-app-state${isPublished ? ' published' : ''}`}>
                    {isPublished ? 'Published' : 'Not published'}
                  </span>
                </div>
                <div className="project-settings-field">
                  <div className="project-settings-input-row project-settings-prefixed-input-row">
                    <span className="project-settings-url-prefix">
                      {`${RIVET_WEB_APPS_BASE_PATH}/`}
                    </span>
                    <TextField
                      id={`workflow-project-web-app-slug-${webApp.uiGraphId}`}
                      className="project-settings-input text-field-size-l"
                      value={slugDraft}
                      onChange={handleWebAppSlugDraftChange(webApp.uiGraphId)}
                      isDisabled={disableWebAppActions || webApp.isMissingFromProject}
                      isInvalid={validationError != null}
                      aria-label={`${webApp.name} web app endpoint path`}
                      spellCheck={false}
                    />
                    {!webApp.isMissingFromProject ? (
                      <LoadingButton
                        appearance="primary"
                        className="project-settings-primary-button button-size-l"
                        onClick={() => void handlePublishWebApps(webApp.uiGraphId)}
                        isDisabled={disableWebAppActions || validationError != null}
                        isLoading={savingWebApps}
                      >
                        {isPublished ? 'Update' : 'Publish'}
                      </LoadingButton>
                    ) : null}
                    {isPublished ? (
                      <Button
                        appearance="subtle"
                        className="project-settings-secondary-button button-size-l"
                        onClick={() => void handleUnpublishWebApp(webApp)}
                        isDisabled={disableWebAppActions}
                      >
                        Unpublish
                      </Button>
                    ) : null}
                  </div>
                </div>
                {isPublished ? (
                  <div className="project-settings-help project-settings-web-app-access-help">
                    The web app is accessible via the endpoint on
                    <br />
                    <code className="project-settings-endpoint-code">
                      {`${RIVET_WEB_APPS_BASE_PATH}/${displaySlug}`}
                    </code>
                    <br />
                    <br />
                    The latest saved project changes are accessible on
                    <br />
                    <code className="project-settings-endpoint-code">
                      {`${RIVET_LATEST_WEB_APPS_BASE_PATH}/${displaySlug}`}
                    </code>
                  </div>
                ) : null}
                {webApp.isMissingFromProject ? (
                  <div className="project-settings-help">
                    This web app is still published from an older snapshot, but it is no longer in the current project.
                  </div>
                ) : null}
                {validationError ? <div className="project-settings-error">{validationError}</div> : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );

  return (
    <ModalTransition>
      {isOpen ? (
        <ModalDialog
          testId="workflow-project-settings-modal"
          width="medium"
          label={baseFileName}
          onClose={onClose}
          shouldCloseOnOverlayClick={canCloseModal}
          shouldCloseOnEscapePress={canCloseModal}
        >
          <ModalBody>
            <div className="project-settings-modal-shell">
              <div className="project-settings-modal-header-row">
                <div className="project-settings-modal-heading">
                  <div className="project-settings-title-display" title={baseFileName}>
                    <div className="project-settings-title-field">
                      <span className="project-settings-modal-title">{baseFileName}</span>
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  className="project-settings-close-button"
                  onClick={onClose}
                  disabled={!canCloseModal}
                  aria-label="Close project settings"
                >
                  &times;
                </button>
              </div>

              <div className="project-settings-modal-content">
                {renderTabs()}
                {activeTab === 'workflow' ? renderWorkflowSettings() : renderWebAppsSettings()}
                {renderDangerSection()}
              </div>
            </div>
          </ModalBody>
        </ModalDialog>
      ) : null}
    </ModalTransition>
  );
};
