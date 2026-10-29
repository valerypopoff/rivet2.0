import { useAtomValue } from 'jotai';
import { useEffect } from 'react';
import { currentProjectLoadedRecordingState } from '../state/execution';
import { selectedExecutorState } from '../state/settings';
import { canRunGraphFromEditor, shouldUseRemoteExecutor } from '../state/selectors/executionSelectors.js';
import { useLocalExecutor } from './useLocalExecutor';
import { useRemoteExecutor } from './useRemoteExecutor';
import { useExecutorSessionState, useManagedLatestControlState } from './useExecutorSession';
import { useStableCallback } from './useStableCallback';
import { clearUserInputSubmitHandler, setUserInputSubmitHandler } from '../state/actions/userInputActions.js';
import type { EditorGraphRunOptions } from './editorGraphRunOptions.js';
import { remoteObservationReadOnlyState } from '../state/remoteObservation.js';

export function useGraphExecutor() {
  const selectedExecutor = useAtomValue(selectedExecutorState);
  const loadedRecording = useAtomValue(currentProjectLoadedRecordingState);
  const localExecutor = useLocalExecutor();
  const remoteExecutor = useRemoteExecutor();
  const session = useExecutorSessionState();
  const hasLoadedRecording = !!loadedRecording;
  const managedControls = useManagedLatestControlState();
  const observingRemote =
    (useAtomValue(remoteObservationReadOnlyState) || managedControls?.readOnly) && !hasLoadedRecording;
  const ignoreEditorRun = useStableCallback(async (options: EditorGraphRunOptions = {}) => {
    if (options.throwOnError) {
      throw new Error('The current executor mode cannot run graphs from the editor.');
    }
    return undefined;
  });
  const allowEditorGraphRun = canRunGraphFromEditor({
    observingRemote,
    hasLoadedRecording,
    selectedExecutor,
    session,
  });

  const liveExecutor = shouldUseRemoteExecutor({
    selectedExecutor,
    session,
  })
    ? remoteExecutor
    : localExecutor;

  const graphRunExecutor = shouldUseRemoteExecutor({
    hasLoadedRecording,
    selectedExecutor,
    session,
  })
    ? remoteExecutor
    : localExecutor;

  const graphControlExecutor = hasLoadedRecording ? localExecutor : liveExecutor;
  const submitLiveUserInput = liveExecutor.submitUserInput;
  const submitManagedUserInput = remoteExecutor.submitUserInput;

  useEffect(() => {
    setUserInputSubmitHandler((node, answers, prompt) => {
      if (prompt) submitManagedUserInput(node, answers, prompt);
      else submitLiveUserInput(node, answers);
    });

    return () => {
      clearUserInputSubmitHandler();
    };
  }, [submitLiveUserInput, submitManagedUserInput]);

  const tryRunGraph = useStableCallback(async (options: EditorGraphRunOptions = {}) => {
    if (options.requireLiveRun && hasLoadedRecording) {
      if (options.throwOnError) {
        throw new Error('Web app actions cannot run while a recording is loaded.');
      }
      return undefined;
    }

    if (!allowEditorGraphRun) {
      return await ignoreEditorRun(options);
    }

    return await graphRunExecutor.tryRunGraph(options);
  });

  return {
    tryRunGraph,
    tryAbortGraph: observingRemote ? async () => {} : graphControlExecutor.tryAbortGraph,
    tryPauseGraph: observingRemote ? () => {} : graphControlExecutor.tryPauseGraph,
    tryResumeGraph: observingRemote ? () => {} : graphControlExecutor.tryResumeGraph,
    tryRunEvaluation: observingRemote ? async () => undefined : liveExecutor.tryRunEvaluation,
    tryRetryInterruptedEvaluation: observingRemote
      ? async () => undefined
      : remoteExecutor.tryRetryInterruptedEvaluation,
  };
}
