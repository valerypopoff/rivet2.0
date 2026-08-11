import Button, { LoadingButton } from '@atlaskit/button';
import type { Project, ProjectId, RivetLLMProfileHealthSnapshot } from '@valerypopoff/rivet2-core';
import { type FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { hostedLLMProfileHealthAdmin } from './hostedRivetProviders';
import {
  getLLMProfileHealthDisplayName,
  getLLMProfileHealthIdentityLabel,
  getLLMProfileHealthStatusDetail,
  getOperationalLLMProfileHealthEntries,
} from './llmProfileHealthPresentation';
import type { WorkflowProjectItem } from './types';
import { fetchHostedProjectFile } from './workflowApi';
import { deserializeProjectAsync } from '../overrides/utils/deserializeProject';

const HEALTH_REFRESH_INTERVAL_MS = 5_000;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const LLMProfileHealthSettings: FC<{ activeProject: WorkflowProjectItem }> = ({ activeProject }) => {
  const catalogProjectId = activeProject.projectMetadataId as ProjectId | undefined;
  const [projectContext, setProjectContext] = useState<{
    relativePath: string;
    updatedAt: string;
    project?: Project;
    projectId?: ProjectId;
  }>();
  const activeProjectContext = projectContext?.relativePath === activeProject.relativePath &&
    projectContext.updatedAt === activeProject.updatedAt &&
    (catalogProjectId == null || projectContext.projectId === catalogProjectId)
    ? projectContext
    : undefined;
  const projectId = catalogProjectId ?? activeProjectContext?.projectId;
  const [entries, setEntries] = useState<readonly RivetLLMProfileHealthSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [resettingKey, setResettingKey] = useState<string>();
  const [confirmResetAll, setConfirmResetAll] = useState(false);
  const refreshSequence = useRef(0);
  const activeProjectId = useRef<ProjectId>();
  activeProjectId.current = projectId;

  const operationalEntries = useMemo(
    () => projectId == null ? [] : getOperationalLLMProfileHealthEntries(projectId, entries),
    [entries, projectId],
  );
  const hasHealthHistory = projectId != null && entries.some((entry) => entry.identity.projectId === projectId);

  const refresh = useCallback(async (showLoading = false) => {
    if (projectId == null) return;
    const sequence = ++refreshSequence.current;
    if (showLoading) setLoading(true);

    try {
      const nextEntries = await hostedLLMProfileHealthAdmin.list({ projectId });
      if (refreshSequence.current !== sequence) return;
      setEntries(nextEntries);
      setError(undefined);
    } catch (refreshError) {
      if (refreshSequence.current !== sequence) return;
      setEntries([]);
      setError(getErrorMessage(refreshError));
    } finally {
      if (refreshSequence.current === sequence) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (projectId == null) {
      refreshSequence.current += 1;
      setEntries([]);
      setError(undefined);
      setResettingKey(undefined);
      setConfirmResetAll(false);
      setLoading(true);
      return;
    }
    setEntries([]);
    setError(undefined);
    setResettingKey(undefined);
    setConfirmResetAll(false);
    void refresh(true);
    const interval = window.setInterval(() => void refresh(), HEALTH_REFRESH_INTERVAL_MS);
    return () => {
      window.clearInterval(interval);
      refreshSequence.current += 1;
    };
  }, [projectId, refresh]);

  useEffect(() => {
    setProjectContext(undefined);
  }, [activeProject.relativePath, activeProject.updatedAt, catalogProjectId]);

  useEffect(() => {
    let active = true;
    if (
      activeProjectContext?.project != null ||
      (catalogProjectId != null && operationalEntries.length === 0)
    ) {
      return () => {
        active = false;
      };
    }

    void fetchHostedProjectFile(activeProject.relativePath)
      .then(({ contents }) => deserializeProjectAsync(contents, activeProject.absolutePath))
      .then((project) => {
        const metadataId = project.metadata.id;
        if (!metadataId) throw new Error('The project does not have a metadata id.');
        if (active) {
          setProjectContext({
            relativePath: activeProject.relativePath,
            updatedAt: activeProject.updatedAt,
            project,
            projectId: metadataId,
          });
        }
      })
      .catch((projectError) => {
        if (active) {
          setProjectContext({
            relativePath: activeProject.relativePath,
            updatedAt: activeProject.updatedAt,
          });
          if (catalogProjectId == null) {
            setError(`Could not determine the Rivet project id: ${getErrorMessage(projectError)}`);
            setLoading(false);
          }
        }
      });
    return () => {
      active = false;
    };
  }, [
    activeProject.absolutePath,
    activeProject.relativePath,
    activeProject.updatedAt,
    activeProjectContext?.project,
    catalogProjectId,
    operationalEntries.length,
  ]);

  const reset = async (key?: string) => {
    if (projectId == null) return;
    const resetProjectId = projectId;
    const resetKey = key ?? '*';
    setResettingKey(resetKey);
    setError(undefined);
    try {
      await hostedLLMProfileHealthAdmin.reset(key == null ? { projectId } : { projectId, key });
      if (activeProjectId.current !== resetProjectId) return;
      await refresh();
    } catch (resetError) {
      if (activeProjectId.current !== resetProjectId) return;
      setError(getErrorMessage(resetError));
    } finally {
      if (activeProjectId.current === resetProjectId) setResettingKey(undefined);
    }
  };

  return (
    <div className="project-settings-tab-panel project-settings-llm-health" role="tabpanel">
      <div className="project-settings-llm-health-toolbar">
        <div className="project-settings-help project-settings-llm-health-help">
          Rivet Studio Server remembers provider failures and suspensions across workflow runs. Clearing history
          completely forgets this information; it does not change LLM profile suspension settings saved in the project.
          After a suspension expires, the profile remains visible here while it awaits or runs its recovery attempt.
        </div>
        <div className="project-settings-llm-health-actions">
          <Button
            appearance="subtle"
            className="project-settings-secondary-button button-size-l"
            onClick={() => void refresh(true)}
            isDisabled={loading || resettingKey != null}
          >
            Refresh
          </Button>
          <Button
            appearance="subtle"
            className="project-settings-secondary-button button-size-l"
            onClick={() => setConfirmResetAll(true)}
            isDisabled={!hasHealthHistory || resettingKey != null}
          >
            Clear all history
          </Button>
        </div>
      </div>

      <div className="project-settings-llm-health-status">
        {error ? (
          <div className="project-settings-error project-settings-llm-health-error">
            Could not load LLM profile suspension state: {error}
          </div>
        ) : null}

        {loading ? (
          <div className="project-settings-help">Loading LLM profile suspension state...</div>
        ) : operationalEntries.length === 0 ? (
          <div className="project-settings-help">
            No LLM profiles are currently suspended or awaiting recovery.
          </div>
        ) : (
          <div className="project-settings-llm-health-list">
            {operationalEntries.map((entry) => (
              <div className="project-settings-llm-health-row" key={entry.identity.key}>
                <div className="project-settings-llm-health-description">
                  <div className="project-settings-llm-health-name">
                    {getLLMProfileHealthDisplayName(activeProjectContext?.project, entry)}
                  </div>
                  <div className="project-settings-llm-health-metadata">
                    {getLLMProfileHealthIdentityLabel(entry)} - {getLLMProfileHealthStatusDetail(entry)}
                  </div>
                </div>
                <LoadingButton
                  appearance="subtle"
                  className="project-settings-secondary-button button-size-l"
                  onClick={() => void reset(entry.identity.key)}
                  isLoading={resettingKey === entry.identity.key}
                  isDisabled={resettingKey != null}
                >
                  Clear history
                </LoadingButton>
              </div>
            ))}
          </div>
        )}
      </div>

      {confirmResetAll ? (
        <div
          className="project-settings-llm-health-confirmation"
          role="alertdialog"
          aria-label="Clear all LLM profile suspension history"
        >
          <div>
            Clear all recorded failures, suspensions, and recovery attempts for this project? The next request starts
            with no recorded history. LLM Profile node settings are not changed, and requests already in progress are
            not cancelled; their late completion cannot recreate deleted history.
          </div>
          <div className="project-settings-llm-health-confirmation-actions">
            <Button onClick={() => setConfirmResetAll(false)} isDisabled={resettingKey != null}>Cancel</Button>
            <LoadingButton
              appearance="danger"
              onClick={() => {
                setConfirmResetAll(false);
                void reset();
              }}
              isLoading={resettingKey === '*'}
              isDisabled={resettingKey != null}
            >
              Clear all history
            </LoadingButton>
          </div>
        </div>
      ) : null}
    </div>
  );
};
