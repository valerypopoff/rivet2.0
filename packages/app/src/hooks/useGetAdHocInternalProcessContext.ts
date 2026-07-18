import {
  type ChartNode,
  coerceTypeOptional,
  type GraphId,
  type GraphRunId,
  type Outputs,
  type ProcessId,
  type InternalProcessContext,
  type PortId,
  type RootRunId,
  GptTokenizerTokenizer,
  logRuntimeDebug,
} from '@valerypopoff/rivet2-core';
import { useCallback } from 'react';
import { fillMissingSettingsFromEnvironmentVariables } from '../utils/tauri';
import { TauriNativeApi } from '../model/native/TauriNativeApi';
import { nanoid } from 'nanoid/non-secure';
import { useAtomValue } from 'jotai';
import { settingsState } from '../state/settings';
import { useDependsOnPlugins } from './useDependsOnPlugins';
import { loadedProjectState, referencedProjectsState } from '../state/savedGraphs';
import { TauriProjectReferenceLoader } from '../model/TauriProjectReferenceLoader';
import {
  useAudioProvider,
  useDatasetProvider,
  useEnvironmentProvider,
  usePathPolicyProvider,
} from '../providers/ProvidersContext';

export function useGetAdHocInternalProcessContext() {
  const audioProvider = useAudioProvider();
  const datasetProvider = useDatasetProvider();
  const environmentProvider = useEnvironmentProvider();
  const pathPolicy = usePathPolicyProvider();
  const settings = useAtomValue(settingsState);
  const plugins = useDependsOnPlugins();
  const referencedProjects = useAtomValue(referencedProjectsState);
  const loadedProject = useAtomValue(loadedProjectState);

  return useCallback(
    async (options?: {
      onPartialResult?: (result: string) => void;
      signal?: AbortSignal;
    }): Promise<InternalProcessContext> => {
      const rootRunId = nanoid() as RootRunId;
      const graphRunId = nanoid() as GraphRunId;

      return {
        executor: 'browser',
        node: {} as ChartNode,
        tokenizer: new GptTokenizerTokenizer(),
        contextValues: {},
        activeOutputPortIds: new Set<PortId>(),
        isDirectRunTarget: false,

        createSubProcessor: undefined!,
        settings: await fillMissingSettingsFromEnvironmentVariables(settings, plugins, {
          environmentProvider,
        }),
        nativeApi: new TauriNativeApi(),
        datasetProvider,
        audioProvider,
        processId: nanoid() as ProcessId,
        execution: {
          graphId: 'ad-hoc' as GraphId,
          graphRunId,
          rootRunId,
        },
        executionCache: new Map(),
        externalFunctions: {},
        getGlobal: undefined!,
        getCachedStoredValue: undefined!,
        getStoredValue: undefined!,
        getGraphBoundary: undefined!,

        graphInputs: {},
        graphOutputs: {},
        graphInputNodeValues: {},
        project: undefined!,
        raiseEvent: undefined!,
        reportProgress: () => undefined,
        setGlobal: undefined!,
        setStoredValue: undefined!,
        signal: options?.signal ?? new AbortController().signal,
        trace: (trace: string) => logRuntimeDebug('Ad-hoc process trace', { trace }),
        waitEvent: undefined!,
        waitForGlobal: undefined!,
        waitForStoredValue: undefined!,
        onPartialOutputs: (outputs: Outputs) => {
          const responsePartial = coerceTypeOptional(outputs['response' as PortId], 'string');
          if (responsePartial) {
            options?.onPartialResult?.(responsePartial);
          }
        },
        abortGraph: undefined!,
        getPluginConfig: undefined!,
        attachedData: {},
        requestUserInput: undefined!,
        codeRunner: undefined!,
        referencedProjects,
        projectPath: loadedProject.path ?? undefined,
        projectReferenceLoader: new TauriProjectReferenceLoader(pathPolicy),
      };
    },
    [
      audioProvider,
      datasetProvider,
      environmentProvider,
      loadedProject,
      pathPolicy,
      plugins,
      referencedProjects,
      settings,
    ],
  );
}
