import Button, { LoadingButton } from '@atlaskit/button';
import ModalDialog, { ModalBody, ModalTransition } from '@atlaskit/modal-dialog';
import TextField from '@atlaskit/textfield';
import { type FC, useEffect, useMemo, type ReactNode, useState } from 'react';

import {
  formatLastPublishedAtLabel,
  getWorkflowProjectStatusLabel,
  isWorkflowProjectFullyUnpublished,
} from './projectSettingsForm';
import type {
  HostedRouteConfig,
  WorkflowProjectItem,
  WorkflowProjectStatus,
} from './types';
import { SegmentedControl, SegmentedControlButton } from './SegmentedControl';
import { LLMProfileHealthSettings } from './LLMProfileHealthSettings';
import { useProjectSettingsActions } from './useProjectSettingsActions';

const renderWorkflowEndpointHelp = (
  routeConfig: HostedRouteConfig,
  status: WorkflowProjectStatus,
  endpointName: string,
): ReactNode => {
  switch (status) {
    case 'unpublished':
      return null;
    case 'published':
      return (
        <>
          The workflow is accessible via the endpoint on 
          <br />
          <code className="project-settings-endpoint-code">
            {`${routeConfig.publishedWorkflowsBasePath}/${endpointName}`}
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
            {`${routeConfig.publishedWorkflowsBasePath}/${endpointName}`}
          </code>
          <br />
          <br />
          The unpublished changes are accessible on 
          <br />
          <code className="project-settings-endpoint-code">
            {`${routeConfig.latestWorkflowsBasePath}/${endpointName}`}
          </code>
        </>
      );
    default:
      return null;
  }
};

const toCurrentOriginUrl = (path: string): string => {
  if (typeof window === 'undefined') {
    return path;
  }

  return new URL(path, window.location.origin).toString();
};

const renderWebAppEndpointLink = (path: string): ReactNode => (
  <a
    className="project-settings-endpoint-link"
    href={toCurrentOriginUrl(path)}
    target="_blank"
    rel="noopener noreferrer"
    aria-label={`Open ${path} in a new tab`}
  >
    <code className="project-settings-endpoint-code">{path}</code>
  </a>
);

function getWebAppStatusLabel(status: WorkflowProjectStatus): string {
  if (status === 'unpublished') {
    return 'Not published';
  }

  return getWorkflowProjectStatusLabel(status);
}

function normalizeAllowedEmailDraft(value: string): string[] {
  const seen = new Set<string>();
  const emails: string[] = [];
  for (const rawEmail of value.split(/[\n,;]/)) {
    const email = rawEmail.trim().toLowerCase();
    if (!email || seen.has(email)) {
      continue;
    }

    seen.add(email);
    emails.push(email);
  }

  return emails;
}

type ProjectSettingsTab = 'workflow' | 'web-apps' | 'llm-health';

type ProjectSettingsModalProps = {
  activeProject: WorkflowProjectItem;
  allProjects: WorkflowProjectItem[];
  isOpen: boolean;
  onClose: () => void;
  onRefresh: () => void | Promise<void>;
  onDeleteProject: (path: string, projectId?: string | null) => void;
  onOpenPublishedHistory: (project: WorkflowProjectItem) => void;
  routeConfig: HostedRouteConfig;
};

export const ProjectSettingsModal: FC<ProjectSettingsModalProps> = ({
  activeProject,
  allProjects,
  isOpen,
  onClose,
  onRefresh,
  onDeleteProject,
  onOpenPublishedHistory,
  routeConfig,
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
    webAppAllowedEmailDrafts,
    webAppSlugValidationErrors,
    webAppAccessValidationErrors,
    loadingWebApps,
    savingWebApps,
    deletingProject,
    handleSettingsDraftChange,
    handleWebAppSlugDraftChange,
    handleWebAppAllowedEmailsDraftChange,
    handlePublishProject,
    handleUnpublishProject,
    handlePublishWebApps,
    handleUnpublishWebApp,
    handleSaveWebAppAccess,
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
  const canDeleteProject = isWorkflowProjectFullyUnpublished(activeProject) && !loadingWebApps && !hasPublishedWebApps;
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
  const disableDeleteProjectAction = savingSettings || savingWebApps || deletingProject || !canDeleteProject;
  const disableWebAppActions = savingSettings || savingWebApps || deletingProject || loadingWebApps;
  const workflowPublishButtonLabel = isUnpublishedProject ? 'Publish' : 'Update';
  const showWebAppOauthSettings = routeConfig.webAppsAuthMode === 'oauth';
  const renderTabs = () => (
    <SegmentedControl
      className="project-settings-section-switcher"
      label="Project settings sections"
      role="tablist"
    >
      <SegmentedControlButton
        selected={activeTab === 'workflow'}
        role="tab"
        aria-selected={activeTab === 'workflow'}
        onClick={() => setActiveTab('workflow')}
      >
        Endpoint
      </SegmentedControlButton>
      <SegmentedControlButton
        selected={activeTab === 'web-apps'}
        role="tab"
        aria-selected={activeTab === 'web-apps'}
        onClick={() => setActiveTab('web-apps')}
      >
        Web apps
      </SegmentedControlButton>
      <SegmentedControlButton
        selected={activeTab === 'llm-health'}
        role="tab"
        aria-selected={activeTab === 'llm-health'}
        onClick={() => setActiveTab('llm-health')}
      >
        LLM profile suspension
      </SegmentedControlButton>
    </SegmentedControl>
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
            {`${routeConfig.publishedWorkflowsBasePath}/`}
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
        {endpointValidationError ? <div className="project-settings-error">{endpointValidationError}</div> : null}
        {!isUnpublishedProject ? (
          <div className="project-settings-help project-settings-status-help">
            {renderWorkflowEndpointHelp(routeConfig, displayedProjectStatus, publishedEndpointName)}
          </div>
        ) : null}
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
            const allowedEmailDraft = webAppAllowedEmailDrafts[webApp.uiGraphId] ?? '';
            const allowedEmails = webApp.allowedEmails ?? [];
            const validationError = webAppSlugValidationErrors[webApp.uiGraphId] ?? null;
            const accessValidationError = webAppAccessValidationErrors[webApp.uiGraphId] ?? null;
            const isPublished = webApp.publishedSlug != null;
            const hasWebAppSlugDraftChange = isPublished && slugDraft.trim() !== webApp.publishedSlug;
            const parsedAllowedEmails = normalizeAllowedEmailDraft(allowedEmailDraft);
            const hasWebAppAccessDraftChange = isPublished &&
              parsedAllowedEmails.join('\n') !== allowedEmails.join('\n');
            const hasWebAppChangesToPublish = webApp.status === 'unpublished_changes' && !webApp.isMissingFromProject;
            const showLatestWebAppLink = hasWebAppChangesToPublish;
            const displaySlug = isPublished ? webApp.publishedSlug! : slugDraft.trim() || 'slug';
            return (
              <div className="project-settings-web-app-row" key={webApp.uiGraphId}>
                <div className="project-settings-web-app-title-row">
                  <span className={`project-settings-web-app-state ${webApp.status}`}>
                    {getWebAppStatusLabel(webApp.status)}
                  </span>
                  <div className="project-settings-web-app-name" title={webApp.name}>
                    {webApp.name}
                  </div>
                </div>
                <div className="project-settings-field">
                  <div className="project-settings-input-row project-settings-prefixed-input-row">
                    <span className="project-settings-url-prefix">
                      {`${routeConfig.publishedAppsBasePath}/`}
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
                        isDisabled={
                          disableWebAppActions ||
                          validationError != null ||
                          (isPublished && !hasWebAppSlugDraftChange && !hasWebAppChangesToPublish)
                        }
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
                  {validationError ? <div className="project-settings-error">{validationError}</div> : null}
                </div>
                {showWebAppOauthSettings ? (
                  <div className="project-settings-field project-settings-web-app-access-field">
                    <label
                      className="project-settings-field-label"
                      htmlFor={`workflow-project-web-app-access-${webApp.uiGraphId}`}
                    >
                      Allowed emails
                    </label>
                    <div className="project-settings-web-app-access-row">
                      <textarea
                        id={`workflow-project-web-app-access-${webApp.uiGraphId}`}
                        className="project-settings-textarea"
                        value={allowedEmailDraft}
                        onChange={handleWebAppAllowedEmailsDraftChange(webApp.uiGraphId)}
                        disabled={disableWebAppActions || webApp.isMissingFromProject}
                        aria-invalid={accessValidationError != null}
                        placeholder="user@example.com"
                        rows={3}
                        spellCheck={false}
                      />
                      {isPublished && !webApp.isMissingFromProject ? (
                        <LoadingButton
                          appearance="primary"
                          className="project-settings-primary-button button-size-l"
                          onClick={() => void handleSaveWebAppAccess(webApp)}
                          isDisabled={disableWebAppActions || accessValidationError != null || !hasWebAppAccessDraftChange}
                          isLoading={savingWebApps}
                        >
                          Save access
                        </LoadingButton>
                      ) : null}
                    </div>
                    {accessValidationError ? <div className="project-settings-error">{accessValidationError}</div> : null}
                    <div className="project-settings-help">
                      Leave empty to deny all signed-in OAuth users.
                    </div>
                  </div>
                ) : null}
                {isPublished ? (
                  <div className="project-settings-help project-settings-web-app-access-help">
                    The web app is accessible via the endpoint on
                    <br />
                    {renderWebAppEndpointLink(`${routeConfig.publishedAppsBasePath}/${displaySlug}`)}
                    {showLatestWebAppLink ? (
                      <>
                        <br />
                        <br />
                        The latest saved project changes are accessible on
                        <br />
                        {renderWebAppEndpointLink(`${routeConfig.latestAppsBasePath}/${displaySlug}`)}
                      </>
                    ) : null}
                  </div>
                ) : null}
                {webApp.isMissingFromProject ? (
                  <div className="project-settings-help">
                    This web app is still published from an older snapshot, but it is no longer in the current project.
                  </div>
                ) : null}
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
                  {renderTabs()}
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
                {activeTab === 'workflow' ? renderWorkflowSettings() : null}
                {activeTab === 'web-apps' ? renderWebAppsSettings() : null}
                {activeTab === 'llm-health' ? <LLMProfileHealthSettings activeProject={activeProject} /> : null}
                {renderDangerSection()}
              </div>
            </div>
          </ModalBody>
        </ModalDialog>
      ) : null}
    </ModalTransition>
  );
};
