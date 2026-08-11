import Button from '@atlaskit/button';
import Modal, { ModalBody, ModalFooter, ModalTransition } from '@atlaskit/modal-dialog';
import { css } from '@emotion/react';
import type { Project, RivetLLMProfileHealthSnapshot } from '@valerypopoff/rivet2-core';
import { useCallback, useEffect, useRef, useState, type FC } from 'react';
import { toast } from 'react-toastify';
import { useLLMProfileHealthAdmin, type LLMProfileHealthAdminProvider } from '../providers/ProvidersContext.js';
import { projectState } from '../state/savedGraphs.js';
import { selectedExecutorState } from '../state/settings.js';
import { useAtomValue } from 'jotai';
import { AppModalHeader } from './AppModalHeader.js';
import {
  getLLMProfileHealthDetail,
  getLLMProfileHealthDisplayName,
  getLLMProfileHealthIdentityLabel,
  normalizeLLMProfileHealthEntries,
} from './llmProfileHealthPresentation.js';

const styles = css`
  .llm-profile-health-heading,
  .llm-profile-health-row,
  .llm-profile-health-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .llm-profile-health-heading,
  .llm-profile-health-row {
    justify-content: space-between;
  }

  .llm-profile-health-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 8px 0 0;
  }

  .llm-profile-health-row {
    border: 1px solid var(--grey-dark);
    border-radius: 4px;
    padding: 8px;
  }

  .llm-profile-health-meta,
  .llm-profile-health-help,
  .llm-profile-health-empty {
    color: var(--foreground-muted);
    font-size: var(--ui-font-size-sm);
  }

  .llm-profile-health-empty {
    margin-top: 8px;
  }

  .llm-profile-health-state {
    text-transform: capitalize;
  }
`;

export const ProjectLLMProfileHealthConfiguration: FC = () => {
  const admin = useLLMProfileHealthAdmin();
  const project = useAtomValue(projectState);
  const selectedExecutor = useAtomValue(selectedExecutorState);

  if (!admin) return null;

  return (
    <ProjectLLMProfileHealthConfigurationContent
      admin={admin}
      project={project}
      disabledReason={
        selectedExecutor === 'nodejs' && admin.executionScope === 'browser-only'
          ? 'This standalone editor can manage Browser-run health only. Node executor health lives in the separate executor process and recovers automatically; use Browser execution here or configure a shared host store and administration API.'
          : undefined
      }
    />
  );
};

const ProjectLLMProfileHealthConfigurationContent: FC<{
  admin: LLMProfileHealthAdminProvider;
  project: Project;
  disabledReason?: string;
}> = ({ admin, project, disabledReason }) => {
  const [entries, setEntries] = useState<readonly RivetLLMProfileHealthSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [resettingKey, setResettingKey] = useState<string>();
  const [confirmResetAll, setConfirmResetAll] = useState(false);
  const requestGeneration = useRef(0);
  const activeProjectId = useRef(project.metadata.id);
  activeProjectId.current = project.metadata.id;

  const refresh = useCallback(
    async (clearExisting = false) => {
      const generation = ++requestGeneration.current;
      if (clearExisting) setEntries([]);
      setLoading(true);
      try {
        const nextEntries = await admin.list({ projectId: project.metadata.id });
        if (generation === requestGeneration.current) {
          setEntries(normalizeLLMProfileHealthEntries(project.metadata.id, nextEntries));
        }
      } catch (error) {
        if (generation === requestGeneration.current) {
          toast.error(`Failed to load LLM profile health: ${error instanceof Error ? error.message : String(error)}`);
        }
      } finally {
        if (generation === requestGeneration.current) setLoading(false);
      }
    },
    [admin, project.metadata.id],
  );

  useEffect(() => {
    if (disabledReason) {
      requestGeneration.current += 1;
      setEntries([]);
      setLoading(false);
      return;
    }
    void refresh(true);

    return () => {
      requestGeneration.current += 1;
    };
  }, [disabledReason, refresh]);

  const reset = async (key?: string) => {
    const requestedProjectId = project.metadata.id;
    setResettingKey(key ?? '*');
    try {
      await admin.reset({ projectId: requestedProjectId, ...(key == null ? {} : { key }) });
      if (activeProjectId.current !== requestedProjectId) return;
      await refresh();
    } catch (error) {
      toast.error(`Failed to reset LLM profile health: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setResettingKey(undefined);
    }
  };

  return (
    <div css={styles}>
      <div className="llm-profile-health-heading">
        <strong>LLM profile health</strong>
        <div className="llm-profile-health-actions">
          <Button
            appearance="subtle"
            isDisabled={disabledReason != null || loading || resettingKey != null}
            onClick={() => void refresh()}
          >
            Refresh
          </Button>
          <Button
            appearance="subtle"
            isDisabled={disabledReason != null || loading || resettingKey != null || entries.length === 0}
            onClick={() => setConfirmResetAll(true)}
          >
            Reset all
          </Button>
        </div>
      </div>
      <div className="llm-profile-health-help">
        Circuit-breaker state available to this editor. Resetting health permits suspended profiles to be tried again;
        it does not change their saved configuration or cancel requests already in progress.
      </div>
      {disabledReason ? (
        <div className="llm-profile-health-empty">{disabledReason}</div>
      ) : loading ? (
        <div className="llm-profile-health-empty">Loading profile health...</div>
      ) : entries.length === 0 ? (
        <div className="llm-profile-health-empty">No profile health has been recorded for this project.</div>
      ) : (
        <div className="llm-profile-health-list">
          {entries.map((entry) => (
            <div className="llm-profile-health-row" key={entry.identity.key}>
              <div>
                <div>{getLLMProfileHealthDisplayName(project, entry)}</div>
                <div className="llm-profile-health-meta">
                  {getLLMProfileHealthIdentityLabel(entry)} -{' '}
                  <span className="llm-profile-health-state">{entry.state}</span> - {getLLMProfileHealthDetail(entry)}
                </div>
              </div>
              <Button
                appearance="subtle"
                isDisabled={resettingKey != null}
                onClick={() => void reset(entry.identity.key)}
              >
                Reset
              </Button>
            </div>
          ))}
        </div>
      )}
      <ModalTransition>
        {confirmResetAll && (
          <Modal autoFocus={false} onClose={() => setConfirmResetAll(false)} width="small">
            <AppModalHeader title="Reset LLM profile health?" onClose={() => setConfirmResetAll(false)} />
            <ModalBody>
              Suspended profiles in this project will be eligible for another request immediately. Saved profile
              settings are not changed.
            </ModalBody>
            <ModalFooter>
              <Button onClick={() => setConfirmResetAll(false)}>Cancel</Button>
              <Button
                appearance="danger"
                onClick={() => {
                  setConfirmResetAll(false);
                  void reset();
                }}
              >
                Reset all
              </Button>
            </ModalFooter>
          </Modal>
        )}
      </ModalTransition>
    </div>
  );
};
