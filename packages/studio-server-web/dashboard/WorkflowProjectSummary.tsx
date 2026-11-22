import Button, { LoadingButton } from '@atlaskit/button';
import { useEffect, useState, type FC } from 'react';

import { fetchWorkflowProjectWebApps } from './workflowApi';
import { PublicationReferencePill, useWorkflowPublicationReferences } from './WorkflowPublicationReferences';
import {
  getWorkflowProjectEndpointStatus,
  getWorkflowProjectPublicationStatus,
} from './workflowProjectPublicationStatus';
import type { WorkflowProjectItem, WorkflowProjectStatus, WorkflowProjectWebAppSummary } from './types';

const STATUS_LABELS: Record<WorkflowProjectStatus, string> = {
  unpublished: 'Unpublished',
  published: 'Published',
  unpublished_changes: 'Unpublished changes',
};

type WorkflowProjectSummaryProps = {
  project: WorkflowProjectItem;
  isCurrentlyOpen: boolean;
  hasUnsavedChanges: boolean;
  editorReady: boolean;
  onSave: () => void;
  onOpenSettings: () => void;
  onOpenReferenceDetails: () => void;
};

type LoadedWebApps = {
  relativePath: string;
  webApps: WorkflowProjectWebAppSummary[] | null;
};

type WebAppStatusSummary = {
  label: 'Web app' | 'Web apps';
  status: WorkflowProjectStatus | 'various' | 'none' | 'loading' | 'unavailable';
};

function getWebAppStatusSummary(
  webAppCount: number,
  webApps: WorkflowProjectWebAppSummary[] | null,
  loadFailed: boolean,
): WebAppStatusSummary {
  if (webAppCount === 0 && !webApps) {
    return {
      label: 'Web app',
      status: 'none',
    };
  }

  if (!webApps) {
    return {
      label: webAppCount === 1 ? 'Web app' : 'Web apps',
      status: loadFailed ? 'unavailable' : 'loading',
    };
  }

  // A removed draft graph can still have a live, immutable publication.
  const visibleWebApps = webApps.filter((webApp) => webApp.publishedSlug != null);
  if (visibleWebApps.length === 0) {
    return {
      label: 'Web app',
      status: 'none',
    };
  }

  if (visibleWebApps.length === 1) {
    return {
      label: 'Web app',
      status: visibleWebApps[0]!.status,
    };
  }

  const firstStatus = visibleWebApps[0]!.status;
  const allSameStatus = visibleWebApps.every((webApp) => webApp.status === firstStatus);

  return {
    label: 'Web apps',
    status: allSameStatus ? firstStatus : 'various',
  };
}

export const WorkflowProjectSummary: FC<WorkflowProjectSummaryProps> = ({
  project: activeProject,
  isCurrentlyOpen,
  hasUnsavedChanges,
  editorReady,
  onSave,
  onOpenSettings,
  onOpenReferenceDetails,
}) => {
  const references = useWorkflowPublicationReferences();
  const activeProjectRelativePath = activeProject?.relativePath ?? null;
  const activeProjectUpdatedAt = activeProject?.updatedAt ?? null;
  const savedEndpointStatus = activeProject?.settings.status ?? null;
  const publicationVersion = activeProject?.settings.publicationVersion ?? null;
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

    setLoadedWebApps((current) => (current?.relativePath === relativePath ? current : null));

    fetchWorkflowProjectWebApps(relativePath)
      .then((response) => {
        if (!cancelled) {
          setLoadedWebApps({ relativePath, webApps: response.webApps });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoadedWebApps({ relativePath, webApps: null });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeProjectRelativePath,
    activeProjectUpdatedAt,
    savedEndpointStatus,
    publicationVersion,
    publishedWebAppsSignature,
    publishedWebAppCount,
    webAppCount,
  ]);

  const activeProjectStatus = getWorkflowProjectEndpointStatus(activeProject, references);
  const statusLabel = STATUS_LABELS[activeProjectStatus];
  const endpointName =
    (activeProjectStatus === 'unpublished' ? '' : activeProject.settings.publishedEndpointName?.trim()) ||
    activeProject.settings.endpointName.trim();
  const loadedCurrentWebApps =
    loadedWebApps?.relativePath === activeProject.relativePath ? loadedWebApps.webApps : null;
  const webAppStatusSummary = getWebAppStatusSummary(
    publishedWebAppCount,
    loadedCurrentWebApps,
    loadedWebApps?.relativePath === activeProject.relativePath && loadedWebApps.webApps === null,
  );
  const aggregatePublicationStatus = getWorkflowProjectPublicationStatus(activeProject, references);
  const baseName = activeProject.name;
  const showSaveButton = isCurrentlyOpen && hasUnsavedChanges;
  const showEndpoint = activeProjectStatus !== 'unpublished';

  return (
    <div className={`active-project-section ${aggregatePublicationStatus}`} role="group" aria-label="Project details">
      <div className="active-project-section-content">
        <div className="active-project-details">
          <div className="active-project-name-row" title={baseName}>
            <span className="active-project-name">{baseName}</span>
          </div>
          {showEndpoint || webAppStatusSummary.status !== 'none' ? (
            <div className="active-project-status-list">
              {showEndpoint ? (
                <>
                  <div className="active-project-status-line">
                    <span className="active-project-status-label">Endpoint:</span>
                    <span className={`project-status-badge ${activeProjectStatus}`}>{statusLabel}</span>
                    <PublicationReferencePill project={activeProject} onOpen={onOpenReferenceDetails} />
                  </div>
                  {endpointName ? <div className="active-project-endpoint-name">{endpointName}</div> : null}
                </>
              ) : null}
              {webAppStatusSummary.status !== 'none' ? (
                <div className="active-project-status-line">
                  <span className="active-project-status-label">{webAppStatusSummary.label}:</span>
                  {webAppStatusSummary.status === 'various' ? (
                    <span className="active-project-status-text active-project-various-statuses">various statuses</span>
                  ) : webAppStatusSummary.status === 'loading' ? (
                    <span className="active-project-status-text">...</span>
                  ) : webAppStatusSummary.status === 'unavailable' ? (
                    <span className="active-project-status-text">Unavailable</span>
                  ) : (
                    <span className={`project-status-badge ${webAppStatusSummary.status}`}>
                      {STATUS_LABELS[webAppStatusSummary.status]}
                    </span>
                  )}
                </div>
              ) : null}
            </div>
          ) : null}
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
                onClick={() => onSave()}
                title="Save current project"
                aria-label="Save current project"
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
