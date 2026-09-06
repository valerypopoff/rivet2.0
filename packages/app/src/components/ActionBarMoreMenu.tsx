import { css } from '@emotion/react';
import { type FC, type MouseEvent } from 'react';
import type { ProjectId } from '@valerypopoff/rivet2-core';
import { useLoadRecording } from '../hooks/useLoadRecording';
import { useExecutorSessionState } from '../hooks/useExecutorSession';
import { currentProjectLoadedRecordingState } from '../state/execution';
import { getExecutorOptions, selectedExecutorState } from '../state/settings';
import { useExecutorSessionHostConfig } from '../providers/ExecutorSessionContext.js';
import { isRivetAppHostCapabilityEnabled, useRivetAppHostUiConfig } from '../providers/HostUiConfigContext.js';
import { getExecutorProductState, isExternalDebuggerProductState } from '../state/selectors/executionSelectors.js';
import { projectState, projectsState } from '../state/savedGraphs.js';
import { debuggerPanelAnchorState, type DebuggerPanelAnchor, debuggerPanelOpenState } from '../state/ui';
import { updateOpenedProjectExecutorMode } from '../utils/openedProjects.js';
import { createLocalProjectExecutorMode } from '../utils/projectExecutorMode.js';
import { SegmentedEditor } from './editors/SegmentedEditor';
import { PopupMenu, PopupMenuItem } from './PopupMenu.js';
import BugIcon from 'majesticons/line/bug-2-line.svg?react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';

const moreMenuStyles = css`
  .executor {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0.4rem;
    padding: 0.625rem 1rem 0.75rem;
    min-height: 72px;
    color: var(--grey-lighter);
    font-size: var(--ui-font-size-base);

    .executor-title,
    .executor-status {
      color: var(--grey-lighter);
      font-size: var(--ui-font-size-base);
      line-height: 1.25;
      display: flex;
      align-items: center;
    }

    .executor-status {
      font-weight: 700;
      min-height: calc(32px * var(--ui-font-scale));
    }

    .segmented-editor-field {
      flex: 1 1 auto;
      min-width: 0;
    }

    .segmented-choice {
      width: calc(100% + 3px);
      margin-left: -0.2em;
    }

    .segmented-choice-option {
      flex: 1 1 0;
      font-size: var(--ui-font-size-base);
    }
  }
`;

export const ActionBarMoreMenu: FC<{
  getDebuggerPanelAnchor: () => DebuggerPanelAnchor | undefined;
  onClose: () => void;
  onAddRunInputsToEvaluation?: () => void;
}> = ({ getDebuggerPanelAnchor, onClose, onAddRunInputsToEvaluation }) => {
  const setDebuggerPanelOpen = useSetAtom(debuggerPanelOpenState);
  const setDebuggerPanelAnchor = useSetAtom(debuggerPanelAnchorState);
  const [selectedExecutor, setSelectedExecutor] = useAtom(selectedExecutorState);
  const currentProject = useAtomValue(projectState);
  const loadedRecording = useAtomValue(currentProjectLoadedRecordingState);
  const setProjects = useSetAtom(projectsState);
  const { loadRecording } = useLoadRecording();
  const hostUiConfig = useRivetAppHostUiConfig();
  const recordingsEnabled = isRivetAppHostCapabilityEnabled(hostUiConfig, 'recordings');
  const evaluationInputCopyEnabled = isRivetAppHostCapabilityEnabled(hostUiConfig, 'evaluationInputCopy');
  const hostConfig = useExecutorSessionHostConfig();
  const executorOptions = getExecutorOptions({ hasInternalExecutorUrl: !!hostConfig?.internalExecutorUrl });

  const openDebuggerPanel = (event: MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setDebuggerPanelAnchor(
      getDebuggerPanelAnchor() ?? {
        bottom: rect.bottom,
        right: rect.right,
      },
    );
    setDebuggerPanelOpen(true);
    onClose();
  };

  const doLoadRecording = () => {
    loadRecording();
    onClose();
  };

  const remoteDebugger = useExecutorSessionState();
  const executorProductState = getExecutorProductState({ selectedExecutor, session: remoteDebugger });
  const isActuallyRemoteDebugging = isExternalDebuggerProductState(executorProductState);

  const setExecutorMode = (value: string | boolean) => {
    if (value === 'browser' || value === 'nodejs') {
      setSelectedExecutor(value);
      const projectId = currentProject.metadata.id as ProjectId | undefined;

      if (projectId) {
        const projectExecutorMode = createLocalProjectExecutorMode(value);
        setProjects((previousProjects) =>
          updateOpenedProjectExecutorMode(previousProjects, projectId, projectExecutorMode),
        );
      }
    }
  };

  return (
    <PopupMenu extraCss={moreMenuStyles}>
      <div className="menu-item executor">
        <span className="executor-title">Executor</span>
        {loadedRecording ? (
          <span className="executor-status">Not used during recording playback</span>
        ) : isActuallyRemoteDebugging ? (
          <span className="executor-status">Remote</span>
        ) : (
          <SegmentedEditor
            value={selectedExecutor}
            onChange={setExecutorMode}
            isReadonly={false}
            isDisabled={false}
            label=""
            ariaLabel="Executor mode"
            name="executor-mode"
            options={executorOptions}
          />
        )}
      </div>
      <PopupMenuItem icon={BugIcon} onClick={openDebuggerPanel}>
        Remote Debugger
      </PopupMenuItem>
      {recordingsEnabled ? <PopupMenuItem onClick={doLoadRecording}>Load Recording</PopupMenuItem> : null}
      {evaluationInputCopyEnabled && onAddRunInputsToEvaluation ? (
        <PopupMenuItem onClick={onAddRunInputsToEvaluation}>Add run inputs to evaluation dataset</PopupMenuItem>
      ) : null}
    </PopupMenu>
  );
};
