import { useAtomValue } from 'jotai';
import { useEffect } from 'react';
import { loadedRecordingState } from '../state/execution';
import { selectedExecutorState } from '../state/settings';
import { canRunGraphFromEditor, shouldUseRemoteExecutor } from '../state/selectors/executionSelectors.js';
import { useLocalExecutor } from './useLocalExecutor';
import { useRemoteExecutor } from './useRemoteExecutor';
import { useExecutorSessionState } from './useExecutorSession';
import { useStableCallback } from './useStableCallback';
import { clearUserInputSubmitHandler, setUserInputSubmitHandler } from '../state/actions/userInputActions.js';
import type { EditorGraphRunOptions } from './editorGraphRunOptions.js';

export function useGraphExecutor() {
  const selectedExecutor = useAtomValue(selectedExecutorState);
  const loadedRecording = useAtomValue(loadedRecordingState);
  const localExecutor = useLocalExecutor();
  const remoteExecutor = useRemoteExecutor();
  const session = useExecutorSessionState();
  const hasLoadedRecording = !!loadedRecording;
  const ignoreEditorRun = useStableCallback(async (options: EditorGraphRunOptions = {}) => {
    if (options.throwOnError) {
      throw new Error('The current executor mode cannot run graphs from the editor.');
    }
    return undefined;
  });
  const allowEditorGraphRun = canRunGraphFromEditor({
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

  useEffect(() => {
    setUserInputSubmitHandler(liveExecutor.submitUserInput);

    return () => {
      clearUserInputSubmitHandler();
    };
  }, [liveExecutor.submitUserInput]);

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
    tryAbortGraph: graphControlExecutor.tryAbortGraph,
    tryPauseGraph: graphControlExecutor.tryPauseGraph,
    tryResumeGraph: graphControlExecutor.tryResumeGraph,
    tryRunTests: liveExecutor.tryRunTests,
  };
}
