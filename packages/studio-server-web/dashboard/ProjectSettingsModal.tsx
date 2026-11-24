import Button, { LoadingButton } from '@atlaskit/button';
import ModalDialog, { ModalBody, ModalTransition } from '@atlaskit/modal-dialog';
import TextField from '@atlaskit/textfield';
import { type FC, Fragment, useEffect, useMemo, type ReactNode, useState } from 'react';

import {
  parseWebAppAllowedEmailDraft,
  formatLastPublishedAtLabel,
  getWorkflowProjectStatusLabel,
  isWorkflowProjectFullyUnpublished,
} from './projectSettingsForm';
import type {
  HostedRouteConfig,
  WorkflowProjectItem,
  WorkflowProjectStatus,
  WorkflowPublishedVersionRestoreResponse,
  WorkflowTreeResponse,
} from './types';
import { SegmentedControl, SegmentedControlButton } from './SegmentedControl';
import { LLMProfileHealthSettings } from './LLMProfileHealthSettings';
import { PublicationReferencePill, useWorkflowPublicationReferences } from './WorkflowPublicationReferences';
import { getWorkflowProjectEndpointStatus, getWorkflowReferenceProjectId } from './workflowProjectPublicationStatus';
import { useProjectSettingsActions } from './useProjectSettingsActions';
import { WorkflowPublishedVersionHistoryPanel } from './WorkflowPublishedVersionHistoryModal';
import { ProjectIncomingReferences } from './ProjectIncomingReferences';

const renderWorkflowEndpointHelp = (
  routeConfig: HostedRouteConfig,
  status: WorkflowProjectStatus,
  publishedEndpointName: string,
  draftEndpointName: string,
  endpointAccess: 'public' | 'internal',
): ReactNode => {
  const publishedRoute =
    endpointAccess === 'internal'
      ? `${routeConfig.internalPublishedWorkflowsBaseUrl ?? 'http://api/internal/workflows'}/${publishedEndpointName}`
      : `${routeConfig.publishedWorkflowsBasePath}/${publishedEndpointName}`;
  const latestRoute =
    endpointAccess === 'internal'
      ? `${routeConfig.internalLatestWorkflowsBaseUrl ?? 'http://api/internal/workflows-latest'}/${draftEndpointName}`
      : `${routeConfig.latestWorkflowsBasePath}/${draftEndpointName}`;
  switch (status) {
    case 'unpublished':
      return null;
    case 'published':
      return (
        <>
          {endpointAccess === 'internal'
            ? 'The published workflow is available only inside the server network at'
            : 'The workflow is accessible via the endpoint on'}
          <br />
          <code className="project-settings-endpoint-code">{publishedRoute}</code>
        </>
      );

    case 'unpublished_changes':
      return (
        <>
          Workflow has changes that are not live.
          <br />
          <br />
          {endpointAccess === 'internal'
            ? 'The published workflow version is available only inside the server network at'
            : 'The published workflow version is still accessible on'}
          <br />
          <code className="project-settings-endpoint-code">{publishedRoute}</code>
          <br />
          <br />
          The unpublished changes are accessible on
          <br />
          <code className="project-settings-endpoint-code">{latestRoute}</code>
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

type ProjectSettingsTab = 'workflow' | 'web-apps' | 'llm-health' | 'classifier-health' | 'history' | 'danger';

type ProjectSettingsModalProps = {
  activeProject: WorkflowProjectItem;
  allProjects: WorkflowProjectItem[];
  getDirtyProjectIds(): readonly string[];
  isOpen: boolean;
  initialTab?: ProjectSettingsTab;
  onClose: () => void;
  onRefresh: () => Promise<WorkflowTreeResponse | null>;
  onStructuralMutation?: (message: string) => void;
  onDeleteProject: (path: string, projectId?: string | null) => void;
  onPreviewPublishedVersion: (relativePath: string, versionId: string) => void;
  onPublishedVersionRestored: (response: WorkflowPublishedVersionRestoreResponse) => void | Promise<void>;
  onOpenRecording: (recordingId: string) => void;
  routeConfig: HostedRouteConfig;
};

export const ProjectSettingsModal: FC<ProjectSettingsModalProps> = ({
  activeProject,
  allProjects,
  getDirtyProjectIds,
  isOpen,
  initialTab = 'workflow',
  onClose,
  onRefresh,
  onStructuralMutation,
  onDeleteProject,
  onPreviewPublishedVersion,
  onPublishedVersionRestored,
  onOpenRecording,
  routeConfig,
}) => {
  const [activeTab, setActiveTab] = useState<ProjectSettingsTab>(initialTab);
  const [historyBusy, setHistoryBusy] = useState(false);
  useEffect(() => {
    if (isOpen) {
      setActiveTab(initialTab);
    }
  }, [activeProject.relativePath, initialTab, isOpen]);
  const {
    settingsDraft,
    snapshotProject,
    savingSettings,
    savingEndpointAccess,
    webApps,
    webAppSlugDrafts,
    webAppAllowedEmailDrafts,
    webAppSlugValidationErrors,
    webAppAccessValidationErrors,
    loadingWebApps,
    reviewedPublication,
    publicationConflict,
    refreshUnconfirmedPublication,
    reviewLatestPublication,
    savingWebApps,
    deletingProject,
    handleSettingsDraftChange,
    handleWebAppSlugDraftChange,
    handleWebAppAllowedEmailsDraftChange,
    handlePublishProject,
    handleUnpublishProject,
    handleEndpointAccessChange,
    handlePublishWebApps,
    handleUnpublishWebApp,
    handleSaveWebAppAccess,
    handleDeleteActiveProject,
    endpointValidationError,
  } = useProjectSettingsActions({
    activeProject,
    allProjects,
    getDirtyProjectIds,
    isOpen,
    onClose,
    onDeleteProject,
    onRefresh,
    onStructuralMutation,
  });

  const displayProject = snapshotProject ?? activeProject;
  const references = useWorkflowPublicationReferences();
  const displayedProjectStatus = getWorkflowProjectEndpointStatus(displayProject, references);
  const baseFileName = useMemo(() => activeProject.fileName.replace(/\.[^.]+$/, ''), [activeProject.fileName]);
  const publishedEndpointName =
    displayProject.settings.publishedEndpointName || displayProject.settings.endpointName || 'endpoint-name';
  const isUnpublishedProject = displayedProjectStatus === 'unpublished';
  const endpointAccess = displayProject.settings.endpointAccess ?? 'public';
  const canCaptureRelease = references?.canCaptureRelease.has(getWorkflowReferenceProjectId(displayProject));
  const hasWorkflowChangesToPublish = displayedProjectStatus === 'unpublished_changes' || canCaptureRelease;
  const hasWorkflowEndpointDraftChange =
    settingsDraft.endpointName.trim() !== displayProject.settings.endpointName.trim();
  const hasWebApps = webApps.length > 0;
  const hasPublishedWebApps = webApps.some((webApp) => webApp.publishedSlug != null);
  const canDeleteProject =
    isWorkflowProjectFullyUnpublished(activeProject) &&
    isWorkflowProjectFullyUnpublished(displayProject) &&
    !loadingWebApps &&
    !hasPublishedWebApps;
  const lastPublishedAtLabel = useMemo(
    () => formatLastPublishedAtLabel(displayedProjectStatus, displayProject.settings.lastPublishedAt),
    [displayProject.settings.lastPublishedAt, displayedProjectStatus],
  );
  const canCloseModal = !savingSettings && !savingEndpointAccess && !savingWebApps && !deletingProject && !historyBusy;
  const disablePublishAction =
    savingSettings ||
    savingEndpointAccess ||
    loadingWebApps ||
    !reviewedPublication ||
    deletingProject ||
    endpointValidationError != null ||
    (!isUnpublishedProject && !hasWorkflowChangesToPublish && !hasWorkflowEndpointDraftChange);
  const disableUnpublishAction = savingSettings || savingEndpointAccess || deletingProject || !reviewedPublication;
  const disableDeleteProjectAction = !canCloseModal || !reviewedPublication || !canDeleteProject;
  const disableWebAppActions =
    savingSettings || savingWebApps || deletingProject || loadingWebApps || !reviewedPublication;
  const workflowPublishButtonLabel = isUnpublishedProject ? 'Publish' : 'Update';
  const showWebAppOauthSettings = routeConfig.webAppsAuthMode === 'oauth';
  const renderTabs = () => (
    <div
      className="project-settings-tabs project-settings-vertical-tabs"
      role="tablist"
      aria-orientation="vertical"
      aria-label="Project settings sections"
    >
      {(
        [
          ['workflow', 'Endpoint'],
          ['web-apps', 'Web apps'],
          ['llm-health', 'LLM profile suspension'],
          ['classifier-health', 'Decision AI profile suspension'],
          ['history', 'Published revision history'],
          ['danger', 'Danger zone'],
        ] as const
      ).map(([id, label]) => (
        <Fragment key={id}>
          {id === 'llm-health' || id === 'history' || id === 'danger' ? (
            <div className="project-settings-tab-separator" role="separator" aria-hidden="true" />
          ) : null}
          <button
            type="button"
            className={`project-settings-tab${activeTab === id ? ' active' : ''}`}
            role="tab"
            aria-selected={activeTab === id}
            disabled={!canCloseModal}
            onClick={() => setActiveTab(id)}
          >
            {label}
          </button>
        </Fragment>
      ))}
    </div>
  );
  const renderWorkflowSettings = () => (
    <div className="project-settings-tab-panel" role="tabpanel">
      <div className="project-settings-status-block">
        <div className="active-project-status-row">
          <span className={`project-status-badge ${displayedProjectStatus}`}>
            {getWorkflowProjectStatusLabel(displayedProjectStatus)}
          </span>
          <PublicationReferencePill project={displayProject} />
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
          <span className="project-settings-url-prefix">{`${routeConfig.publishedWorkflowsBasePath}/`}</span>
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
          <div className="project-settings-endpoint-access">
            <span
              className="project-settings-access-label"
              title="Controls where the endpoint can be reached. Bearer-key requirements are configured separately in Rivet Server settings."
            >
              Endpoint access
            </span>
            <SegmentedControl label="Endpoint access">
              <SegmentedControlButton
                selected={endpointAccess === 'public'}
                disabled={savingEndpointAccess || savingSettings || deletingProject || !reviewedPublication}
                onClick={() => void handleEndpointAccessChange('public')}
              >
                External
              </SegmentedControlButton>
              <SegmentedControlButton
                selected={endpointAccess === 'internal'}
                disabled={savingEndpointAccess || savingSettings || deletingProject || !reviewedPublication}
                onClick={() => void handleEndpointAccessChange('internal')}
              >
                Internal network only
              </SegmentedControlButton>
            </SegmentedControl>
            <span className="project-settings-help">Changes take effect immediately</span>
          </div>
        ) : null}
        {!isUnpublishedProject ? (
          <div className="project-settings-help project-settings-status-help">
            {renderWorkflowEndpointHelp(
              routeConfig,
              displayedProjectStatus,
              publishedEndpointName,
              displayProject.settings.endpointName,
              endpointAccess,
            )}
          </div>
        ) : null}
      </div>
    </div>
  );

  const renderDangerSection = () => (
    <div
      className="project-settings-tab-panel project-settings-danger-section"
      role="tabpanel"
      aria-label="Danger zone"
    >
      <h3>Delete project</h3>
      <p className="project-settings-help">
        Deleting this project is permanent and cannot be undone. Its saved datasets, published revision history, and run
        recordings are also deleted. Other projects and scheduled runs that use it may stop working. Download a backup
        before deleting it.
      </p>
      <ProjectIncomingReferences
        key={`${displayProject.relativePath}:${displayProject.projectMetadataId ?? ''}`}
        relativePath={displayProject.relativePath}
        projectId={displayProject.projectMetadataId}
      />
      <Button
        appearance="subtle"
        className="project-settings-delete-button button-size-l"
        onClick={() => void handleDeleteActiveProject()}
        isDisabled={disableDeleteProjectAction}
      >
        {deletingProject ? 'Deleting...' : 'Delete project'}
      </Button>
      {!canDeleteProject ? (
        <p className="project-settings-help">Unpublish the endpoint and all web apps before deleting this project.</p>
      ) : null}
    </div>
  );

  const renderWebAppsSettings = () => (
    <div className="project-settings-tab-panel project-settings-web-app-section" role="tabpanel">
      {loadingWebApps ? <div className="project-settings-help">Loading project web apps...</div> : null}

      {!loadingWebApps && !hasWebApps ? <div className="project-settings-help">No web apps in the project.</div> : null}

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
            const parsedAllowedEmails = parseWebAppAllowedEmailDraft(allowedEmailDraft);
            const hasWebAppAccessDraftChange =
              isPublished && parsedAllowedEmails.join('\n') !== allowedEmails.join('\n');
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
                    <span className="project-settings-url-prefix">{`${routeConfig.publishedAppsBasePath}/`}</span>
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
                          isDisabled={
                            disableWebAppActions || accessValidationError != null || !hasWebAppAccessDraftChange
                          }
                          isLoading={savingWebApps}
                        >
                          Save access
                        </LoadingButton>
                      ) : null}
                    </div>
                    {accessValidationError ? (
                      <div className="project-settings-error">{accessValidationError}</div>
                    ) : null}
                    <div className="project-settings-help">Leave empty to deny all signed-in OAuth users.</div>
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

              <div className="project-settings-modal-content project-settings-sections-layout">
                <aside>{renderTabs()}</aside>
                <div className="project-settings-section-content">
                  {!loadingWebApps &&
                  !reviewedPublication &&
                  !(activeTab === 'history' && publicationConflict === 'unconfirmed') ? (
                    <div className="project-settings-publication-conflict" role="alert">
                      <span>
                        {publicationConflict === 'unconfirmed'
                          ? 'The publication outcome could not be confirmed. Review the current state before sending another update.'
                          : publicationConflict === 'changed'
                            ? 'The project or its publication changed during your attempt. Review the latest state before trying again; your edits remain here.'
                            : 'Publication state could not be loaded. Review the latest state before changing publication.'}
                      </span>
                      <Button appearance="subtle" onClick={() => void reviewLatestPublication()}>
                        Review latest
                      </Button>
                    </div>
                  ) : null}
                  {activeTab === 'workflow' ? renderWorkflowSettings() : null}
                  {activeTab === 'web-apps' ? renderWebAppsSettings() : null}
                  {activeTab === 'classifier-health' ? (
                    <LLMProfileHealthSettings
                      key="classifier"
                      family="classifier"
                      activeProject={activeProject}
                      onOpenRecording={(recordingId) => {
                        onClose();
                        onOpenRecording(recordingId);
                      }}
                    />
                  ) : null}
                  {activeTab === 'llm-health' ? (
                    <LLMProfileHealthSettings
                      activeProject={activeProject}
                      onOpenRecording={(recordingId) => {
                        onClose();
                        onOpenRecording(recordingId);
                      }}
                    />
                  ) : null}
                  {activeTab === 'history' ? (
                    <div className="project-settings-tab-panel" role="tabpanel" aria-label="Published revision history">
                      <WorkflowPublishedVersionHistoryPanel
                        project={displayProject}
                        isOpen={isOpen}
                        onBusyChange={setHistoryBusy}
                        onPreviewVersion={(relativePath, versionId) => {
                          onClose();
                          onPreviewPublishedVersion(relativePath, versionId);
                        }}
                        onRestoreUnconfirmed={refreshUnconfirmedPublication}
                        onRestored={async (response) => {
                          try {
                            await onPublishedVersionRestored(response);
                          } finally {
                            await reviewLatestPublication();
                          }
                        }}
                      />
                    </div>
                  ) : null}
                  {activeTab === 'danger' ? renderDangerSection() : null}
                </div>
              </div>
            </div>
          </ModalBody>
        </ModalDialog>
      ) : null}
    </ModalTransition>
  );
};
