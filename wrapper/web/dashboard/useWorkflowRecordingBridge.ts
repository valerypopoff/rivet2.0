import { ExecutionRecorder } from '@valerypopoff/rivet2-core';
import { useCallback, useEffect, useMemo, useRef } from 'react';

import {
  getWorkflowRecordingIdFromVirtualProjectPath,
} from '../../shared/workflow-recording-types';
import { fetchWorkflowRecordingArtifactText } from './workflowApi';

export type LoadedWorkflowRecording = {
  path: string;
  recorder: ExecutionRecorder;
};

export function getRecordingStartGraphId(recorder: ExecutionRecorder): string | undefined {
  for (const event of recorder.events) {
    if (event.type === 'start') {
      return event.data.startGraph;
    }

    if (event.type === 'graphStart') {
      return event.data.graphId;
    }
  }

  return undefined;
}

export async function fetchLoadedWorkflowRecording(recordingId: string): Promise<LoadedWorkflowRecording> {
  const serializedRecording = await fetchWorkflowRecordingArtifactText(recordingId, 'recording');
  return {
    path: `${recordingId}.rivet-recording`,
    recorder: ExecutionRecorder.deserializeFromString(serializedRecording),
  };
}

export function useWorkflowRecordingBridge({
  loadedProjectPath,
  setLoadedRecording,
  selectBrowserExecutor,
}: {
  loadedProjectPath: string | null;
  setLoadedRecording: (recording: LoadedWorkflowRecording | null) => void;
  selectBrowserExecutor: () => void;
}) {
  const recordingByProjectPathRef = useRef(new Map<string, LoadedWorkflowRecording>());
  const activateWorkflowRecording = useCallback((loadedRecording: LoadedWorkflowRecording) => {
    selectBrowserExecutor();
    setLoadedRecording(loadedRecording);
  }, [selectBrowserExecutor, setLoadedRecording]);

  useEffect(() => {
    let cancelled = false;
    const projectPath = loadedProjectPath;
    if (!projectPath) {
      setLoadedRecording(null);
      return;
    }

    const cachedRecording = recordingByProjectPathRef.current.get(projectPath);
    if (cachedRecording) {
      activateWorkflowRecording(cachedRecording);
      return;
    }

    const recordingId = getWorkflowRecordingIdFromVirtualProjectPath(projectPath);
    if (!recordingId) {
      setLoadedRecording(null);
      return;
    }

    setLoadedRecording(null);
    void fetchLoadedWorkflowRecording(recordingId)
      .then((loadedRecording) => {
        if (cancelled) {
          return;
        }

        recordingByProjectPathRef.current.set(projectPath, loadedRecording);
        activateWorkflowRecording(loadedRecording);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        console.error('Failed to restore workflow recording:', error);
        setLoadedRecording(null);
      });

    return () => {
      cancelled = true;
    };
  }, [activateWorkflowRecording, loadedProjectPath, setLoadedRecording]);

  return useMemo(() => ({
    activateWorkflowRecording,
    recordingByProjectPathRef,
  }), [activateWorkflowRecording]);
}
