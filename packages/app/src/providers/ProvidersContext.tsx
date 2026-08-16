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
import { type EvaluationRunStore } from '@valerypopoff/rivet2-evaluations';
import { LocalEvaluationRunStore } from './EvaluationRunStore.js';
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
  /**
   * Operational evaluation history is deliberately separate from project YAML.
   * Hosts can replace this ephemeral editor default with a durable shared store.
   */
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
  return useProviders().evaluationRunStore;
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

function createDefaultProviders(
  overrides: Pick<
    ProviderOverrides,
    'datasets' | 'evaluationRunStore' | 'llmProfileHealthAdmin' | 'llmProfileHealthStore' | 'pathPolicy' | 'staticData'
  > = {},
): Providers {
  const datasets = overrides.datasets ?? new BrowserDatasetProvider();
  const pathPolicy = overrides.pathPolicy ?? getDefaultPathPolicyProvider();
  const staticData = overrides.staticData ?? new BrowserStaticDataStore();

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
    evaluationRunStore: overrides.evaluationRunStore ?? new LocalEvaluationRunStore(),
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

export const ProvidersProvider: FC<{ providers?: ProviderOverrides; children: ReactNode }> = ({
  providers,
  children,
}) => {
  const value = useMemo(() => {
    if (!providers) {
      return getDefaultProviders();
    }

    const { storage: _storage, ...runtimeProviders } = providers;
    const defaults = createDefaultProviders(runtimeProviders);
    return {
      ...defaults,
      ...runtimeProviders,
      dataRefs: {
        ...defaults.dataRefs,
        ...runtimeProviders.dataRefs,
      },
    } satisfies Providers;
  }, [providers]);

  return <ProvidersContext.Provider value={value}>{children}</ProvidersContext.Provider>;
};
