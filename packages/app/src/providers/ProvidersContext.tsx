import { createContext, useContext, useMemo, type FC, type ReactNode } from 'react';
import { type IOProvider } from '../io/IOProvider.js';
import {
  type DatasetProvider,
  type AudioProvider,
  type ProjectId,
  type CombinedDataset,
} from '@valerypopoff/rivet2-core';
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

export type Providers = {
  io: IOProvider;
  datasets: AppDatasetProvider;
  audio: AudioProvider;
  dataRefs: DataRefStore;
  environment: EnvironmentProvider;
  pathPolicy: PathPolicyProvider;
  staticData: StaticDataStore;
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

function createDefaultDataRefs(): DataRefStore {
  return {
    get: getGlobalDataRef,
    set: setGlobalDataRef,
    delete: deleteGlobalDataRef,
  };
}

function createDefaultProviders(
  overrides: Pick<ProviderOverrides, 'datasets' | 'pathPolicy' | 'staticData'> = {},
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
