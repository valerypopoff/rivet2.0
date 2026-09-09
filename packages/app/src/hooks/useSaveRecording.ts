import { useAtomValue } from 'jotai';
import { currentProjectLoadedRecordingState, lastRecordingState } from '../state/execution';
import { useIOProvider } from '../providers/ProvidersContext';
import { wrapAsync } from '../utils/errorHandling.js';
import { getRecordingSaveSource, serializeRecordingSaveSource } from '../utils/recordingSaveSource.js';

export function useSaveRecording() {
  const ioProvider = useIOProvider();
  const loadedRecording = useAtomValue(currentProjectLoadedRecordingState);
  const lastLiveRecording = useAtomValue(lastRecordingState);
  const source = getRecordingSaveSource({ loadedRecording, lastLiveRecording });

  const saveRecording = wrapAsync(
    async () => {
      if (source == null) return;
      // Resolve and serialize synchronously at click time. The file picker can
      // yield while tabs change, but it must keep exporting this tab's source.
      await ioProvider.saveString(serializeRecordingSaveSource(source), `recording-${Date.now()}.rivet-recording`);
    },
    'Failed to save recording',
    {
      metadata: {
        recordingSource: source?.kind ?? 'none',
        recordingLength: source?.kind === 'last-live-recording' ? source.serialized.length : undefined,
      },
    },
  );

  return { hasRecordingToSave: source != null, saveRecording };
}
