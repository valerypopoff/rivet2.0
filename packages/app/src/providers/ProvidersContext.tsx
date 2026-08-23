import { createContext, useContext, useMemo, type FC, type ReactNode } from 'react';
import { type IOProvider } from '../io/IOProvider.js';
import {
  type DatasetProvider,
  type AudioProvider,
  type ProjectId,
  type CombinedDataset,
  type RivetLLMProfileHealthSnapshot,
  type RivetLLMProfileHealthStore,
} from '@valerypopoff/rivet2-core';
import { type EvaluationRunStore, type EvaluationStore } from '@valerypopoff/rivet2-evaluations';
import { LocalEvaluationRunStore } from './EvaluationRunStore.js';
import { TauriEvaluationStore } from './TauriEvaluationStore.js';
import { BrowserIOProvider } from '../io/BrowserIOProvider.js';
import { LegacyBrowserIOProvider } from '../io/LegacyBrowserIOProvider.js';
import { TauriIOProvider } from '../io/TauriIOProvider.js';
import { BrowserDatasetProvider } from '../io/BrowserDatasetProvider.js';
import { TauriBrowserAudioProvider } from '../io/TauriBrowserAudioProvider.js';
import { deleteGlobalDataRef, getGlobalDataRef, setGlobalDataRef } from '../utils/globals/globalDataRefs.js';
import { getDefaultEnvironmentProvider, getDefaultPathPolicyProvider } from '../utils/tauri.js';
import type { AsyncStorageBackend } from '../state/storage/indexedDB.js';
import { BrowserStaticDataStore, type StaticDataStore } from './StaticDataStore.js';

export type DataRefStore = {
  get(key: string): ReturnType<typeof getGlobalDataRef>;
  set(
    key: string,
    value: Parameters<typeof setGlobalDataRef>[1],
    options?: Parameters<typeof setGlobalDataRef>[2],
  ): void;
  delete(key: string): void;
};

export type DataRefReader = Pick<DataRefStore, 'get'>;

export type AppDatasetProvider = DatasetProvider & {
  loadDatasets?(projectId: ProjectId): Promise<void>;
  importDatasetsForProject?(projectId: ProjectId, datasets: CombinedDataset[]): Promise<void>;
};

export type EnvironmentProvider = {
  getEnvVar(name: string): Promise<string | undefined>;
};

export type PathPolicyProvider = {
  allowDataFileNeighbor(projectFilePath: string): Promise<void>;
  readRelativeProjectFile?(currentProjectPath: string, projectFilePath: string): Promise<string>;
};

/**
 * Optional operational surface supplied by a host that owns shared LLM
 * profile health. It is intentionally separate from the execution store so a
 * browser host can expose permissioned HTTP list/reset operations without
 * exposing its atomic store implementation to the editor.
 */
export type LLMProfileHealthAdminProvider = {
  /** Omitted means the host-backed administration covers every executor. */
  executionScope?: 'browser-only' | 'shared';
  list(input: { projectId: ProjectId }): Promise<readonly RivetLLMProfileHealthSnapshot[]>;
  reset(input: { key?: string; projectId: ProjectId }): Promise<void>;
};

export type Providers = {
  io: IOProvider;
  datasets: AppDatasetProvider;
  audio: AudioProvider;
  dataRefs: DataRefStore;
  environment: EnvironmentProvider;
  pathPolicy: PathPolicyProvider;
  staticData: StaticDataStore;
  llmProfileHealthAdmin?: LLMProfileHealthAdminProvider;
  llmProfileHealthStore?: RivetLLMProfileHealthStore;
  /** Complete persistence boundary for local evaluation resources and evidence. */
  evaluationStore: EvaluationStore;
  /** @deprecated Supply and consume evaluationStore instead. */
  evaluationRunStore: EvaluationRunStore;
};

export type ProviderOverrides = Partial<Omit<Providers, 'dataRefs'>> & {
  dataRefs?: Partial<DataRefStore>;
  storage?: AsyncStorageBackend;
};

const ProvidersContext = createContext<Providers | null>(null);

export function useProviders(): Providers {
  const ctx = useContext(ProvidersContext);
  if (!ctx) {
    throw new Error('useProviders must be used within a ProvidersProvider');
  }
  return ctx;
}

export function useIOProvider(): IOProvider {
  return useProviders().io;
}

export function useDatasetProvider(): AppDatasetProvider {
  return useProviders().datasets;
}

export function useAudioProvider(): AudioProvider {
  return useProviders().audio;
}

export function useDataRefs(): DataRefStore {
  return useProviders().dataRefs;
}

export function useEnvironmentProvider(): EnvironmentProvider {
  return useProviders().environment;
}

export function usePathPolicyProvider(): PathPolicyProvider {
  return useProviders().pathPolicy;
}

export function useStaticDataStore(): StaticDataStore {
  return useProviders().staticData;
}

export function useLLMProfileHealthAdmin(): LLMProfileHealthAdminProvider | undefined {
  return useProviders().llmProfileHealthAdmin;
}

export function useLLMProfileHealthStore(): RivetLLMProfileHealthStore | undefined {
  return useProviders().llmProfileHealthStore;
}

export function useEvaluationRunStore(): EvaluationRunStore {
  return useProviders().evaluationStore;
}

export function useEvaluationStore(): EvaluationStore {
  return useProviders().evaluationStore;
}

export function createLLMProfileHealthAdminProvider(
  store: RivetLLMProfileHealthStore,
  options: { executionScope?: LLMProfileHealthAdminProvider['executionScope'] } = {},
): LLMProfileHealthAdminProvider {
  return {
    ...(options.executionScope == null ? {} : { executionScope: options.executionScope }),
    list: ({ projectId }) => Promise.resolve(store.list({ projectId })),
    reset: async ({ key, projectId }) => {
      if (key == null) {
        await store.reset({ projectId });
        return;
      }

      const projectEntries = await store.list({ projectId });
      if (!projectEntries.some((entry) => entry.identity.key === key)) {
        throw new Error('The requested LLM profile health record does not belong to the active project.');
      }
      await store.reset({ key });
    },
  };
}

export function resolveLLMProfileHealthProviders(
  overrides: Pick<ProviderOverrides, 'llmProfileHealthAdmin' | 'llmProfileHealthStore'> = {},
): Pick<Providers, 'llmProfileHealthAdmin' | 'llmProfileHealthStore'> {
  const store = overrides.llmProfileHealthStore;
  if (store) {
    return {
      llmProfileHealthStore: store,
      ...(overrides.llmProfileHealthAdmin == null ? {} : { llmProfileHealthAdmin: overrides.llmProfileHealthAdmin }),
    };
  }

  if (overrides.llmProfileHealthAdmin) {
    return {
      llmProfileHealthAdmin: overrides.llmProfileHealthAdmin,
    };
  }

  return {};
}

function createDefaultDataRefs(): DataRefStore {
  return {
    get: getGlobalDataRef,
    set: setGlobalDataRef,
    delete: deleteGlobalDataRef,
  };
}

function combineLegacyEvaluationRunStore(runStore: EvaluationRunStore, libraryStore: EvaluationStore): EvaluationStore {
  return {
    initialize: () => libraryStore.initialize?.() ?? Promise.resolve(),
    getLibrary: () => libraryStore.getLibrary(),
    putLibrary: (library) => libraryStore.putLibrary(library),
    put: (run) => runStore.put(run),
    updateRunName: (input) => runStore.updateRunName(input),
    get: (input) => runStore.get(input),
    list: (input) => runStore.list(input),
    delete: (input) => runStore.delete(input),
    putDatasetSnapshot: (snapshot) => runStore.putDatasetSnapshot(snapshot),
    getDatasetSnapshot: (input) => runStore.getDatasetSnapshot(input),
    putRecording: (artifact) => runStore.putRecording(artifact),
    getRecording: (input) => runStore.getRecording(input),
    updateRecordingRetention: (input) => runStore.updateRecordingRetention(input),
    promoteBaseline: (input) => runStore.promoteBaseline(input),
  };
}

export function resolveEvaluationStoreProvider(
  overrides: Pick<ProviderOverrides, 'evaluationRunStore' | 'evaluationStore'>,
): EvaluationStore {
  if (overrides.evaluationStore) return overrides.evaluationStore;

  const localStore = TauriEvaluationStore.isSupported() ? new TauriEvaluationStore() : new LocalEvaluationRunStore();
  return overrides.evaluationRunStore
    ? combineLegacyEvaluationRunStore(overrides.evaluationRunStore, localStore)
    : localStore;
}

function createDefaultProviders(
  overrides: Pick<
    ProviderOverrides,
    | 'datasets'
    | 'evaluationRunStore'
    | 'evaluationStore'
    | 'llmProfileHealthAdmin'
    | 'llmProfileHealthStore'
    | 'pathPolicy'
    | 'staticData'
  > = {},
): Providers {
  const datasets = overrides.datasets ?? new BrowserDatasetProvider();
  const pathPolicy = overrides.pathPolicy ?? getDefaultPathPolicyProvider();
  const staticData = overrides.staticData ?? new BrowserStaticDataStore();
  const evaluationStore = resolveEvaluationStoreProvider(overrides);

  let io: IOProvider;
  if (TauriIOProvider.isSupported()) {
    io = new TauriIOProvider(datasets, pathPolicy);
  } else if (BrowserIOProvider.isSupported()) {
    io = new BrowserIOProvider();
  } else {
    io = new LegacyBrowserIOProvider();
  }

  return {
    io,
    datasets,
    audio: new TauriBrowserAudioProvider(),
    dataRefs: createDefaultDataRefs(),
    environment: getDefaultEnvironmentProvider(),
    pathPolicy,
    staticData,
    evaluationStore,
    evaluationRunStore: evaluationStore,
    ...resolveLLMProfileHealthProviders(overrides),
  };
}

// Default providers singleton (for non-React code that can't use context)
let defaultProviders: Providers | undefined;

export function getDefaultProviders(): Providers {
  if (!defaultProviders) {
    defaultProviders = createDefaultProviders();
  }
  return defaultProviders;
}

export const ProvidersProvider: FC<{ providers?: ProviderOverrides; children?: ReactNode }> = ({
  providers,
  children,
}) => {
  const hasProviderOverrides = providers !== undefined;
  // Evaluation evidence is durable application state. Its boundary is owned
  // only by the two explicit store overrides, never by unrelated adapters
  // such as path policy, data references, or static data.
  const evaluationStore = useMemo(
    () =>
      hasProviderOverrides
        ? resolveEvaluationStoreProvider({
            evaluationRunStore: providers?.evaluationRunStore,
            evaluationStore: providers?.evaluationStore,
          })
        : getDefaultProviders().evaluationStore,
    [hasProviderOverrides, providers?.evaluationRunStore, providers?.evaluationStore],
  );
  const value = useMemo(() => {
    if (!providers) return getDefaultProviders();

    const {
      storage: _storage,
      evaluationStore: _evaluationStore,
      evaluationRunStore: _evaluationRunStore,
      ...runtimeProviders
    } = providers;
    const defaults = createDefaultProviders({ ...runtimeProviders, evaluationStore });
    return {
      ...defaults,
      ...runtimeProviders,
      // Keep both public names on the same resolved boundary. In particular,
      // a legacy run-only override must not leak back out after it has been
      // combined with the local library store above.
      evaluationStore: defaults.evaluationStore,
      evaluationRunStore: defaults.evaluationStore,
      dataRefs: {
        ...defaults.dataRefs,
        ...runtimeProviders.dataRefs,
      },
    } satisfies Providers;
  }, [evaluationStore, providers]);

  return <ProvidersContext.Provider value={value}>{children}</ProvidersContext.Provider>;
};
