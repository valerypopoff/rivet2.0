import { css } from '@emotion/react';
import clsx from 'clsx';
import { type FC, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { useLoadRecording } from '../hooks/useLoadRecording';
import { useSaveRecording } from '../hooks/useSaveRecording';
import { graphRunningState, graphPausedState } from '../state/dataFlow';
import {
  getLoadedRecordingForProject,
  lastRecordingState,
  loadedRecordingState,
  recordingPlaybackStartingState,
} from '../state/execution';
import { selectedExecutorState } from '../state/settings';
import MultiplyIcon from 'majesticons/line/multiply-line.svg?react';
import PauseIcon from 'majesticons/line/pause-circle-line.svg?react';
import PlayIcon from 'majesticons/line/play-circle-line.svg?react';
import MoreMenuVerticalIcon from 'majesticons/line/more-menu-vertical-line.svg?react';
import Popup from '@atlaskit/popup';
import { useRemoteDebugger } from '../hooks/useRemoteDebugger';
import { ActionBarMoreMenu } from './ActionBarMoreMenu';
import { CopyAsTestCaseModal } from './CopyAsTestCaseModal';
import { PopupMenuContainer } from './PopupMenu.js';
import { useToggle } from 'ahooks';
import { useDependsOnPlugins } from '../hooks/useDependsOnPlugins';
import { GentraceInteractors } from './gentrace/GentraceInteractors';
import { projectMetadataState } from '../state/savedGraphs';
import { graphMetadataState } from '../state/graph';
import { type GraphId } from '@valerypopoff/rivet2-core';
import { wrapAsync } from '../utils/errorHandling';
import { getActionBarExecutionState } from '../state/selectors/executionSelectors.js';
import type { DebuggerPanelAnchor } from '../state/ui.js';
import { NodeRunningIndicator } from './visualNode/NodeRunningIndicator.js';
import { getActionBarRunButtonPresentation } from './actionBarRunButtons.js';
import { isRivetAppHostCapabilityEnabled, useRivetAppHostUiConfig } from '../providers/HostUiConfigContext.js';

const styles = css`
  --action-bar-height: calc(32px * var(--ui-font-scale));

  position: fixed;
  top: calc(20px + var(--project-selector-height) + var(--data-bus-full-row-height, 0px));
  right: 20px;
  background: transparent;
  border: 0;
  height: var(--action-bar-height);
  z-index: 220;
  display: flex;
  align-items: center;
  font-size: var(--ui-font-size-base);
  box-shadow: none;
  justify-content: flex-end;
  gap: 8px;

  .run-button button,
  .pause-button button,
  .unload-recording-button button,
  .run-test-button button,
  .save-recording-button button,
  .run-gentrace-button button,
  .more-menu,
  .remote-debugger-button button {
    border: none;
    padding: 0.5rem 1rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0;
    height: var(--action-bar-height);
    border-radius: var(--ui-button-radius);
    corner-shape: squircle;
    box-sizing: border-box;
  }

  .run-button button {
    background-color: var(--success);
    color: var(--grey-lightest);

    &:hover {
      background-color: var(--success-dark);
    }

    &:disabled {
      background-color: var(--grey-darkish);
      color: var(--grey-light);
      cursor: wait;
      opacity: 0.8;
    }
  }

  .run-button.secondary button:not(:disabled) {
    background-color: color-mix(in srgb, var(--success) 50%, var(--grey-darkish));

    &:hover {
      background-color: color-mix(in srgb, var(--success-dark) 45%, var(--grey-darkish));
    }
  }

  .run-gentrace-button button,
  .pause-button button,
  .save-recording-button button {
    background-color: rgba(255, 255, 255, 0.1);

    &:hover {
      background-color: rgba(255, 255, 255, 0.2);
    }
  }

  .unload-recording-button button {
    background-color: var(--warning);
    color: var(--grey-dark);
  }

  .run-button.running button {
    background-color: var(--error);
  }

  .pause-button.paused button {
    background-color: var(--warning);
    color: var(--grey-dark);

    &:hover {
      background-color: var(--warning-dark);
    }
  }

  .run-test-button button {
    background-color: var(--grey-darkish);
    color: var(--grey-lightest);

    &:hover {
      background-color: var(--grey);
    }
  }

  .more-menu {
    background-color: var(--grey-darker);
    border: 1px solid var(--grey-dark);
    box-shadow: 2px 1px 8px var(--shadow);
    color: var(--foreground);
    font-size: var(--ui-font-size-icon-xl);
    height: var(--action-bar-height);
    line-height: 0;
    padding: 0;
    width: var(--action-bar-height);

    &:hover {
      background-color: var(--grey-darkish);
    }

    svg {
      color: currentColor;
    }
  }

  .remote-debugger-button.active button {
    background-color: var(--error);
  }

  .remote-debugger-button.reconnecting button {
    background-color: var(--warning);
    color: var(--grey-dark);
  }
`;

export type ActionBarProps = {
  onRunGraph?: (options: { graphId?: GraphId }) => void;
  onRunTests?: () => void;
  onAbortGraph?: () => void;
  onPauseGraph?: () => void;
  onResumeGraph?: () => void;
};

export const ActionBar: FC<ActionBarProps> = ({ onRunGraph, onAbortGraph, onPauseGraph, onResumeGraph }) => {
  const actionBarRef = useRef<HTMLDivElement>(null);
  const graphMetadata = useAtomValue(graphMetadataState);
  const projectMetadata = useAtomValue(projectMetadataState);
  const hostUiConfig = useRivetAppHostUiConfig();
  const recordingsEnabled = isRivetAppHostCapabilityEnabled(hostUiConfig, 'recordings');
  const trivetInputCopyEnabled = isRivetAppHostCapabilityEnabled(hostUiConfig, 'trivetInputCopy');
  const lastRecording = useAtomValue(lastRecordingState);
  const saveRecording = useSaveRecording();

  const graphRunning = useAtomValue(graphRunningState);
  const graphPaused = useAtomValue(graphPausedState);

  const loadedRecording = getLoadedRecordingForProject(useAtomValue(loadedRecordingState), projectMetadata.id);
  const recordingPlaybackStarting = useAtomValue(recordingPlaybackStartingState);
  const { unloadRecording } = useLoadRecording();
  const [menuIsOpen, toggleMenuIsOpen] = useToggle();
  const selectedExecutor = useAtomValue(selectedExecutorState);
  const activeRecording = recordingsEnabled ? loadedRecording : undefined;
  const recordingPlaybackIsStarting = !!activeRecording && recordingPlaybackStarting && !graphRunning;

  const { sessionState: remoteDebugger, disconnect } = useRemoteDebugger();
  const actionBarExecutionState = getActionBarExecutionState({
    graphPaused,
    graphRunning,
    hasLoadedRecording: !!activeRecording,
    recordingPlaybackStarting: recordingPlaybackIsStarting,
    selectedExecutor,
    session: remoteDebugger,
  });
  const runButtonsBlocked = !actionBarExecutionState.canRun && !graphRunning;
  const showPrimaryGraphControlButton = actionBarExecutionState.showRunButton || graphRunning;
  const [copyAsTestCaseModalOpen, toggleCopyAsTestCaseModalOpen] = useToggle();

  const plugins = useDependsOnPlugins();

  const gentracePlugin = plugins.find((plugin) => plugin.id === 'gentrace');
  const isGentracePluginEnabled = !!gentracePlugin;

  const hasMainGraph = projectMetadata.mainGraphId != null;
  const isMainGraph = hasMainGraph && graphMetadata?.id === projectMetadata.mainGraphId;
  const runButtonPresentation = getActionBarRunButtonPresentation({
    currentGraphName: graphMetadata?.name,
    graphRunning,
    hasLoadedRecording: !!activeRecording,
    hasMainGraph,
    isMainGraph,
    showRunButton: actionBarExecutionState.showRunButton,
  });

  const getDebuggerPanelAnchor = (): DebuggerPanelAnchor | undefined => {
    const rect = actionBarRef.current?.getBoundingClientRect();

    return rect
      ? {
          bottom: rect.bottom,
          right: rect.right,
        }
      : undefined;
  };

  const runGraph = (graphId?: GraphId) => {
    if (runButtonsBlocked) {
      return;
    }

    if (graphRunning) {
      onAbortGraph?.();
    } else {
      onRunGraph?.({ graphId });
    }
  };

  const renderRunButtonContents = (label: string) => {
    if (actionBarExecutionState.runButtonLoading) {
      return (
        <>
          {label}
          <NodeRunningIndicator
            isRunning
            delayMs={0}
            label={recordingPlaybackIsStarting ? 'Recording playback starting' : 'Node executor starting'}
          />
        </>
      );
    }

    return label;
  };

  return (
    <div css={styles} ref={actionBarRef} data-node-editor-action-bar>
      {actionBarExecutionState.remoteDebuggerBanner && (
        <div
          className={clsx('remote-debugger-button active', {
            reconnecting: actionBarExecutionState.remoteDebuggerBanner.isPending,
          })}
        >
          <button onClick={() => disconnect()}>{actionBarExecutionState.remoteDebuggerBanner.label}</button>
        </div>
      )}

      {activeRecording && !graphRunning && (
        <div className={clsx('unload-recording-button')}>
          <button onClick={() => unloadRecording()}>Unload Recording</button>
        </div>
      )}
      {graphRunning && (
        <div className={clsx('pause-button', { paused: graphPaused })}>
          <button onClick={graphPaused ? onResumeGraph : onPauseGraph}>
            {graphPaused ? (
              <>
                Resume <PlayIcon />
              </>
            ) : (
              <>
                Pause <PauseIcon />
              </>
            )}
          </button>
        </div>
      )}

      {isGentracePluginEnabled && <GentraceInteractors />}

      {recordingsEnabled && lastRecording && (
        <div className={clsx('save-recording-button')}>
          <button onClick={saveRecording}>Save Recording</button>
        </div>
      )}
      {showPrimaryGraphControlButton && (
        <div
          className={clsx('run-button', {
            running: graphRunning,
            recording: !!activeRecording,
            secondary: runButtonPresentation.currentGraphRunSecondary,
          })}
        >
          <button
            disabled={runButtonsBlocked}
            aria-disabled={runButtonsBlocked || undefined}
            aria-busy={actionBarExecutionState.runButtonLoading || undefined}
            onClick={() => runGraph(graphMetadata?.id)}
          >
            {graphRunning ? (
              <>
                Abort <MultiplyIcon />
              </>
            ) : activeRecording ? (
              renderRunButtonContents('Play Recording')
            ) : (
              renderRunButtonContents(runButtonPresentation.currentGraphRunLabel)
            )}
          </button>
        </div>
      )}
      {runButtonPresentation.showProjectGraphRunButton && (
        <div className={clsx('run-button', { running: graphRunning })}>
          <button
            disabled={runButtonsBlocked}
            aria-disabled={runButtonsBlocked || undefined}
            aria-busy={actionBarExecutionState.runButtonLoading || undefined}
            onClick={() => runGraph(projectMetadata.mainGraphId)}
          >
            {graphRunning ? (
              <>
                Abort <MultiplyIcon />
              </>
            ) : (
              renderRunButtonContents(runButtonPresentation.projectGraphRunLabel)
            )}
          </button>
        </div>
      )}
      <Popup
        isOpen={menuIsOpen}
        onClose={toggleMenuIsOpen.setLeft}
        popupComponent={PopupMenuContainer}
        content={() => (
          <ActionBarMoreMenu
            getDebuggerPanelAnchor={getDebuggerPanelAnchor}
            onClose={toggleMenuIsOpen.setLeft}
            onCopyAsTestCase={trivetInputCopyEnabled ? toggleCopyAsTestCaseModalOpen.setRight : undefined}
          />
        )}
        placement="bottom-end"
        trigger={(triggerProps) => (
          <button
            className="more-menu"
            {...triggerProps}
            onMouseDown={(e) => {
              if (e.button === 0) {
                toggleMenuIsOpen.toggle();
                e.preventDefault();
              }
            }}
          >
            <MoreMenuVerticalIcon />
          </button>
        )}
      />
      {trivetInputCopyEnabled ? (
        <CopyAsTestCaseModal open={copyAsTestCaseModalOpen} onClose={toggleCopyAsTestCaseModalOpen.setLeft} />
      ) : null}
    </div>
  );
};
