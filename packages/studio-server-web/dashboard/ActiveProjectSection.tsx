import Button, { LoadingButton } from '@atlaskit/button';
import { useEffect, useState, type FC } from 'react';

import { getAggregateWorkflowProjectStatus } from '../../studio-server-shared/workflow-types';
import { fetchWorkflowProjectWebApps } from './workflowApi';
import type { WorkflowProjectItem, WorkflowProjectStatus, WorkflowProjectWebAppSummary } from './types';

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

type LoadedWebApps = {
  relativePath: string;
  webApps: WorkflowProjectWebAppSummary[];
};

type WebAppStatusSummary = {
  label: 'Web app' | 'Web apps';
  status: WorkflowProjectStatus | 'various' | 'none' | 'loading';
};

function getWebAppStatusSummary(
  webAppCount: number,
  webApps: WorkflowProjectWebAppSummary[] | null,
): WebAppStatusSummary {
  if (webAppCount === 0) {
    return {
      label: 'Web app',
      status: 'none',
    };
  }

  if (!webApps) {
    return {
      label: webAppCount === 1 ? 'Web app' : 'Web apps',
      status: 'loading',
    };
  }

  const currentWebApps = webApps.filter((webApp) => !webApp.isMissingFromProject);
  if (currentWebApps.length === 0) {
    return {
      label: 'Web app',
      status: 'none',
    };
  }

  if (currentWebApps.length === 1) {
    return {
      label: 'Web app',
      status: currentWebApps[0]!.status,
    };
  }

  const firstStatus = currentWebApps[0]!.status;
  const allSameStatus = currentWebApps.every((webApp) => webApp.status === firstStatus);

  return {
    label: 'Web apps',
    status: allSameStatus ? firstStatus : 'various',
  };
}

export const ActiveProjectSection: FC<ActiveProjectSectionProps> = ({
  activeProject,
  isCurrentlyOpen,
  hasUnsavedChanges,
  editorReady,
  onSave,
  onOpenSettings,
}) => {
  const activeProjectRelativePath = activeProject?.relativePath ?? null;
  const activeProjectUpdatedAt = activeProject?.updatedAt ?? null;
  const activeProjectStatus = activeProject?.settings.status ?? null;
  const webAppCount = activeProject?.stats?.webAppCount ?? 0;
  const publishedWebAppCount = activeProject?.settings.publishedWebApps?.length ?? 0;
  const publishedWebAppsSignature = (activeProject?.settings.publishedWebApps ?? [])
    .map((webApp) => `${webApp.uiGraphId}:${webApp.slug}:${webApp.publishedAt}`)
    .join('|');
  const [loadedWebApps, setLoadedWebApps] = useState<LoadedWebApps | null>(null);

  useEffect(() => {
    if (!activeProjectRelativePath || (webAppCount === 0 && publishedWebAppCount === 0)) {
      setLoadedWebApps(null);
      return;
    }

    let cancelled = false;
    const relativePath = activeProjectRelativePath;

    setLoadedWebApps((current) => current?.relativePath === relativePath ? current : null);

    fetchWorkflowProjectWebApps(relativePath)
      .then((response) => {
        if (!cancelled) {
          setLoadedWebApps({ relativePath, webApps: response.webApps });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoadedWebApps({ relativePath, webApps: [] });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeProjectRelativePath,
    activeProjectUpdatedAt,
    activeProjectStatus,
    publishedWebAppsSignature,
    publishedWebAppCount,
    webAppCount,
  ]);

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
  const loadedCurrentWebApps = loadedWebApps?.relativePath === activeProject.relativePath ? loadedWebApps.webApps : null;
  const webAppStatusSummary = getWebAppStatusSummary(webAppCount, loadedCurrentWebApps);
  const aggregatePublicationStatus = activeProject.settings.publicationStatus ?? getAggregateWorkflowProjectStatus(
    activeProject.settings.status,
    loadedCurrentWebApps?.map((webApp) => webApp.status),
  );
  const baseName = activeProject.fileName.replace(/\.[^.]+$/, '');
  const graphCount = activeProject.stats?.graphCount ?? 0;
  const totalNodeCount = activeProject.stats?.totalNodeCount ?? 0;
  const projectStatsParts = [
    `${graphCount} ${graphCount === 1 ? 'graph' : 'graphs'}`,
    `${totalNodeCount} ${totalNodeCount === 1 ? 'node' : 'nodes'}`,
  ];
  if (webAppCount > 0) {
    projectStatsParts.push(`${webAppCount} web ${webAppCount === 1 ? 'app' : 'apps'}`);
  }
  const projectStatsLabel = projectStatsParts.join(', ');
  const showSaveButton = isCurrentlyOpen && hasUnsavedChanges;

  return (
    <div className={`active-project-section ${aggregatePublicationStatus}`}>
      <div className="active-project-section-content">
        <div className="active-project-details">
          <div className="active-project-name-row" title={baseName}>
            <span className="active-project-name">{baseName}</span>
          </div>
          <div className="active-project-status-list">
            <div className="active-project-status-line">
              <span className="active-project-status-label">Endpoint:</span>
              <span className={`project-status-badge ${activeProject.settings.status}`}>
                {statusLabel}
              </span>
            </div>
            <div className="active-project-status-line">
              <span className="active-project-status-label">{webAppStatusSummary.label}:</span>
              {webAppStatusSummary.status === 'various' ? (
                <span className="active-project-status-text active-project-various-statuses">various statuses</span>
              ) : webAppStatusSummary.status === 'none' ? (
                <span className="active-project-status-text">none</span>
              ) : webAppStatusSummary.status === 'loading' ? (
                <span className="active-project-status-text">...</span>
              ) : (
                <span className={`project-status-badge ${webAppStatusSummary.status}`}>
                  {STATUS_LABELS[webAppStatusSummary.status]}
                </span>
              )}
            </div>
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
