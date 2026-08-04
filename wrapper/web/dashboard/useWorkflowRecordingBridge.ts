import { ExecutionRecorder, type ProjectId } from '@valerypopoff/rivet2-core';
import { useCallback, useEffect, useMemo, useRef, type SetStateAction } from 'react';

import type { LoadedRecording } from '../../../rivet/packages/app/src/state/execution';
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
  currentProjectId,
  loadedProjectPath,
  openedProjectPaths,
  setLoadedRecording,
  selectBrowserExecutor,
}: {
  currentProjectId?: ProjectId;
  loadedProjectPath: string | null;
  openedProjectPaths: readonly string[];
  setLoadedRecording: (recording: SetStateAction<LoadedRecording | null>) => void;
  selectBrowserExecutor: () => void;
}) {
  const recordingByProjectPathRef = useRef(new Map<string, LoadedWorkflowRecording>());
  const activateWorkflowRecording = useCallback((
    loadedRecording: LoadedWorkflowRecording,
    projectId: ProjectId,
  ) => {
    selectBrowserExecutor();
    setLoadedRecording({ ...loadedRecording, projectId });
  }, [selectBrowserExecutor, setLoadedRecording]);

  useEffect(() => {
    const openPaths = new Set(openedProjectPaths);
    for (const projectPath of recordingByProjectPathRef.current.keys()) {
      if (projectPath !== loadedProjectPath && !openPaths.has(projectPath)) {
        recordingByProjectPathRef.current.delete(projectPath);
      }
    }
  }, [loadedProjectPath, openedProjectPaths]);

  useEffect(() => {
    let cancelled = false;
    const projectPath = loadedProjectPath;
    if (!projectPath) {
      return;
    }

    const recordingId = getWorkflowRecordingIdFromVirtualProjectPath(projectPath);
    if (!recordingId || !currentProjectId) {
      return;
    }

    const cachedRecording = recordingByProjectPathRef.current.get(projectPath);
    if (cachedRecording) {
      activateWorkflowRecording(cachedRecording, currentProjectId);
      return;
    }

    void fetchLoadedWorkflowRecording(recordingId)
      .then((loadedRecording) => {
        if (cancelled) {
          return;
        }

        recordingByProjectPathRef.current.set(projectPath, loadedRecording);
        activateWorkflowRecording(loadedRecording, currentProjectId);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        console.error('Failed to restore workflow recording:', error);
        setLoadedRecording((currentRecording) =>
          currentRecording?.projectId === currentProjectId ? null : currentRecording);
      });

    return () => {
      cancelled = true;
    };
  }, [activateWorkflowRecording, currentProjectId, loadedProjectPath, setLoadedRecording]);

  return useMemo(() => ({
    activateWorkflowRecording,
    recordingByProjectPathRef,
  }), [activateWorkflowRecording]);
}
