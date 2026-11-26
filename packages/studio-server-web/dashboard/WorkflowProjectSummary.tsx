import { LoadingButton } from '@atlaskit/button';
import SettingsCogIcon from 'majesticons/solid/settings-cog.svg?react';
import { useEffect, useId, useState, type FC } from 'react';
import { toast } from 'react-toastify';

import { copyTextToClipboard } from './copyTextToClipboard';
import { buildPublishedRoute, getPublishedEndpoint, getPublishedRouteLabel } from './publishedItems';
import { fetchWorkflowProjectWebApps } from './workflowApi';
import { useWorkflowPublicationReferences, WorkflowPublicationStatusText } from './WorkflowPublicationReferences';
import { getWorkflowProjectSummaryStatus } from './workflowProjectPublicationStatus';
import type { HostedRouteConfig, WorkflowProjectItem, WorkflowProjectWebAppSummary } from './types';

type WorkflowProjectSummaryProps = {
  project: WorkflowProjectItem;
  routeConfig: HostedRouteConfig;
  isCurrentlyOpen: boolean;
  hasUnsavedChanges: boolean;
  editorReady: boolean;
  onSave: () => void;
  onOpenSettings: () => void;
  onCloseMenu: () => void;
};

type LoadedWebApps = {
  requestKey: string;
  webApps: WorkflowProjectWebAppSummary[] | null;
};

export const WorkflowProjectSummary: FC<WorkflowProjectSummaryProps> = ({
  project,
  routeConfig,
  isCurrentlyOpen,
  hasUnsavedChanges,
  editorReady,
  onSave,
  onOpenSettings,
  onCloseMenu,
}) => {
  const references = useWorkflowPublicationReferences();
  const statusId = useId();
  const { id: projectId, projectMetadataId, revisionId, relativePath } = project;
  const webAppCount = project.stats?.webAppCount ?? 0;
  const hasPublishedWebApps = project.settings.publishedWebApps.length > 0;
  // Do not keep links from a replaced project or an earlier publication while its fresh read settles.
  const requestKey = JSON.stringify([
    projectId,
    projectMetadataId,
    revisionId,
    relativePath,
    project.updatedAt,
    project.settings.status,
    project.settings.publicationVersion,
    project.settings.publishedWebApps,
    webAppCount,
  ]);
  const [loadedWebApps, setLoadedWebApps] = useState<LoadedWebApps | null>(null);

  useEffect(() => {
    if (!relativePath || (webAppCount === 0 && !hasPublishedWebApps)) return;

    let cancelled = false;
    fetchWorkflowProjectWebApps(relativePath)
      .then((response) => {
        if (cancelled) return;
        const matchesProject =
          response.project?.relativePath === relativePath &&
          response.project.id === projectId &&
          (projectMetadataId == null ||
            (response.project.projectMetadataId === projectMetadataId && response.projectId === projectMetadataId));
        setLoadedWebApps({ requestKey, webApps: matchesProject ? response.webApps : null });
      })
      .catch(() => {
        if (!cancelled) setLoadedWebApps({ requestKey, webApps: null });
      });

    return () => {
      cancelled = true;
    };
  }, [relativePath, projectId, projectMetadataId, requestKey, webAppCount, hasPublishedWebApps]);

  const currentWebApps = loadedWebApps?.requestKey === requestKey ? loadedWebApps : null;
  // A removed draft graph can still have a live, immutable publication.
  const publishedWebApps =
    currentWebApps?.webApps?.flatMap((webApp) =>
      webApp.publishedSlug
        ? [{ ...webApp, route: buildPublishedRoute(routeConfig.publishedAppsBasePath, webApp.publishedSlug) }]
        : [],
    ) ?? [];
  const showWebAppPlaceholder = hasPublishedWebApps && !currentWebApps?.webApps;
  const endpoint = getPublishedEndpoint(project, routeConfig, references ?? undefined);
  const status = getWorkflowProjectSummaryStatus(project, references);

  const copyEndpoint = async () => {
    if (!endpoint) return;
    try {
      await copyTextToClipboard(new URL(endpoint.route, window.location.origin).href);
      toast.success('Endpoint URL copied to clipboard');
    } catch {
      toast.error('Could not copy endpoint URL.');
    }
  };

  return (
    <div
      className={`active-project-section ${status.tone}${status.contributionOnly ? ' contribution-only' : ''}`}
      role="group"
      aria-label="Project details"
    >
      <div className="project-summary-settings-strip">
        <button
          type="button"
          className="project-summary-settings-target active-project-more-button"
          aria-label="Settings"
          aria-describedby={statusId}
          title="Project settings"
          onClick={onOpenSettings}
        >
          <SettingsCogIcon className="project-summary-settings-icon" aria-hidden="true" />
        </button>
        <span id={statusId} className="project-summary-status-text">
          <WorkflowPublicationStatusText project={project} status={status} onOpenReferences={onCloseMenu} />
        </span>
      </div>
      <div className="active-project-details">
        {status.secondaryContribution ? (
          <div className="project-summary-contribution-note">
            <span className={`reference-project-marker ${status.secondaryContribution.status}`} aria-hidden="true" />
            {status.secondaryContribution.label}
          </div>
        ) : null}
        <div className="active-project-name-row" title={project.name}>
          <span className="active-project-name">{project.name}</span>
        </div>
        {endpoint || publishedWebApps.length > 0 || showWebAppPlaceholder ? (
          <div className="active-project-status-list">
            {endpoint ? (
              <button
                type="button"
                className="active-project-status-line active-project-link active-project-endpoint-name"
                aria-label={`Copy endpoint URL for ${endpoint.label}`}
                title="Copy full endpoint URL"
                onClick={() => void copyEndpoint()}
              >
                <span className="project-summary-route-badge" aria-hidden="true">
                  API
                </span>
                <span className="project-summary-route-text">
                  {getPublishedRouteLabel(endpoint.route, window.location.origin)}
                </span>
              </button>
            ) : null}
            {publishedWebApps.map((webApp) => (
              <a
                key={webApp.uiGraphId}
                className="active-project-status-line active-project-link"
                href={webApp.route}
                aria-label={webApp.name}
                title={`Open ${webApp.name}`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={onCloseMenu}
              >
                <span className="project-summary-route-badge" aria-hidden="true">
                  APP
                </span>
                <span className="project-summary-route-text">
                  {getPublishedRouteLabel(webApp.route, window.location.origin)}
                </span>
              </a>
            ))}
            {showWebAppPlaceholder ? (
              <div className="active-project-status-line">
                <span className="project-summary-route-badge" aria-hidden="true">
                  APP
                </span>
                <span className="active-project-status-text">{currentWebApps ? 'Unavailable' : '...'}</span>
              </div>
            ) : null}
          </div>
        ) : null}
        {status.notice ? <div className="project-summary-notice">{status.notice}</div> : null}
        {isCurrentlyOpen && hasUnsavedChanges ? (
          <div className="active-project-actions-row">
            <LoadingButton
              appearance="primary"
              className="active-project-save-button button-size-m"
              isDisabled={!editorReady}
              onClick={onSave}
              title="Save current project"
              aria-label="Save current project"
            >
              Save
            </LoadingButton>
          </div>
        ) : null}
      </div>
    </div>
  );
};
