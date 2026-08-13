import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';
import { ExecutorSessionProvider, type ExecutorSessionHostConfig } from './providers/ExecutorSessionContext.js';
import { ProvidersProvider, type ProviderOverrides } from './providers/ProvidersContext.js';
import {
  HostCallbacksProvider,
  type RivetAppHostActiveProjectChangedEvent,
  type RivetAppHostCallbacks,
  type RivetAppHostOpenErrorEvent,
  type RivetAppHostOpenProjectCountChangedEvent,
  type RivetAppHostProjectSavedEvent,
} from './providers/HostCallbacksContext.js';
import { HostUiConfigProvider, type RivetAppHostUiConfig } from './providers/HostUiConfigContext.js';
import { RivetAppLoader } from './components/RivetAppLoader.js';
import { RivetAppHostLifecycle } from './components/RivetAppHostLifecycle.js';
import { RivetWorkspaceHostBridge } from './components/RivetWorkspaceHostBridge.js';
import type { RivetWorkspaceHost } from './hooks/useRivetWorkspaceHost.js';

export type RivetAppHostProps = {
  children?: ReactNode;
  executor?: ExecutorSessionHostConfig;
  loadingFallback?: ReactNode;
  onActiveProjectChanged?: (event: RivetAppHostActiveProjectChangedEvent) => void;
  onOpenError?: (event: RivetAppHostOpenErrorEvent) => void;
  onOpenProjectCountChanged?: (event: RivetAppHostOpenProjectCountChangedEvent) => void;
  onProjectSaved?: (event: RivetAppHostProjectSavedEvent) => void;
  onWorkspaceHostDisposed?: (workspaceHost: RivetWorkspaceHost) => void;
  onWorkspaceHostReady?: (workspaceHost: RivetWorkspaceHost) => void;
  providers?: ProviderOverrides;
  queryClient?: QueryClient;
  ui?: RivetAppHostUiConfig;
};

/**
 * Stable embedding shell for hosted/wrapper applications that mount Rivet's app
 * UI from source. Use this instead of rendering RivetApp directly so required
 * providers and async storage bootstrap stay in sync with the desktop app.
 */
export function RivetAppHost({
  children,
  executor,
  loadingFallback,
  onActiveProjectChanged,
  onOpenError,
  onOpenProjectCountChanged,
  onProjectSaved,
  onWorkspaceHostDisposed,
  onWorkspaceHostReady,
  providers,
  queryClient,
  ui,
}: RivetAppHostProps) {
  const [defaultQueryClient] = useState(() => new QueryClient());
  const storage = providers?.storage;
  const runtimeProviders = useMemo(() => {
    if (!providers) {
      return undefined;
    }

    const { storage: _storage, ...providerOverrides } = providers;
    return providerOverrides;
  }, [providers]);
  const callbacks: RivetAppHostCallbacks = useMemo(
    () => ({
      onActiveProjectChanged,
      onOpenError,
      onOpenProjectCountChanged,
      onProjectSaved,
    }),
    [onActiveProjectChanged, onOpenError, onOpenProjectCountChanged, onProjectSaved],
  );

  return (
    <QueryClientProvider client={queryClient ?? defaultQueryClient}>
      <HostCallbacksProvider callbacks={callbacks}>
        <HostUiConfigProvider config={ui}>
          <ProvidersProvider providers={runtimeProviders}>
            <ExecutorSessionProvider hostConfig={executor}>
              <RivetAppLoader loadingFallback={loadingFallback} storage={storage}>
                <RivetAppHostLifecycle />
                {onWorkspaceHostReady ? (
                  <RivetWorkspaceHostBridge onReady={onWorkspaceHostReady} onDispose={onWorkspaceHostDisposed} />
                ) : null}
                {children}
              </RivetAppLoader>
            </ExecutorSessionProvider>
          </ProvidersProvider>
        </HostUiConfigProvider>
      </HostCallbacksProvider>
    </QueryClientProvider>
  );
}

export { RivetApp } from './components/RivetApp.js';
export { RivetAppLoader } from './components/RivetAppLoader.js';
export {
  ExecutorSessionProvider,
  useExecutorSessionHostConfig,
  useExecutorSessionRuntime,
  type ExecutorSessionHostConfig,
} from './providers/ExecutorSessionContext.js';
export {
  getDefaultProviders,
  ProvidersProvider,
  useAudioProvider,
  useDataRefs,
  useDatasetProvider,
  useEnvironmentProvider,
  useIOProvider,
  useLLMProfileHealthAdmin,
  useLLMProfileHealthStore,
  usePathPolicyProvider,
  useProviders,
  useStaticDataStore,
  type AppDatasetProvider,
  type DataRefReader,
  type DataRefStore,
  type EnvironmentProvider,
  type LLMProfileHealthAdminProvider,
  type PathPolicyProvider,
  type ProviderOverrides,
  type Providers,
} from './providers/ProvidersContext.js';
export {
  BrowserStaticDataStore,
  MemoryStaticDataStore,
  type StaticDataRecord,
  type StaticDataStore,
} from './providers/StaticDataStore.js';
export {
  HostCallbacksProvider,
  useRivetAppHostCallbacks,
  type RivetAppHostActiveProjectChangedEvent,
  type RivetAppHostCallbacks,
  type RivetAppHostOpenErrorEvent,
  type RivetAppHostOpenProjectCountChangedEvent,
  type RivetAppHostProjectSavedEvent,
} from './providers/HostCallbacksContext.js';
export {
  HostUiConfigProvider,
  isRivetAppHostCapabilityEnabled,
  shouldCheckForUpdates,
  shouldPreloadCodeEditor,
  useRivetAppHostUiConfig,
  type RivetAppHostCapability,
  type RivetAppHostUiConfig,
} from './providers/HostUiConfigContext.js';
export type { FileMenuConfig, FileMenuItemId } from './utils/fileMenuConfiguration.js';
export type { WorkspaceTabItemId, WorkspaceTabsConfig } from './utils/workspaceTabs.js';
export { RivetWorkspaceHostBridge, type RivetWorkspaceHostBridgeProps } from './components/RivetWorkspaceHostBridge.js';
export {
  createExecutorSessionRuntime,
  DEFAULT_REMOTE_DEBUGGER_URL,
  INTERNAL_EXECUTOR_URL,
  type ExecutorSessionRuntime,
  type ExecutorSessionState,
  type ExecutorSessionStatus,
  type ExecutorSessionCapabilities,
  type ExecutorSessionConnectedEvent,
  type ExecutorSessionDisconnectedEvent,
  type ExecutorSessionDisconnectReason,
  type ExecutorSessionLifecycleEvent,
  type ExecutorSessionTarget,
  type PendingGraphExecution,
} from './hooks/executorSession.js';
export { useRivetWorkspaceHost } from './hooks/useRivetWorkspaceHost.js';
export type {
  MoveProjectPathsInput,
  RivetOpeningProjectTabHandle,
  RivetOpeningProjectTabInput,
  RivetOpeningProjectTabOptions,
  RivetProjectCompareOptions,
  RivetProjectCleanBaselineSnapshotInput,
  RivetProjectOpenOptions,
  RivetProjectMetadataPatch,
  RivetProjectMetadataUpdateOptions,
  RivetProjectReplaceOptions,
  RivetProjectSnapshotInput,
  RivetProjectTabUiState,
  RivetWorkspaceHost,
} from './hooks/useRivetWorkspaceHost.js';
export {
  attachAndStartExecutorSidecar,
  detachAndStopExecutorSidecar,
  executorSidecarRuntime,
} from './hooks/useExecutorSidecar.js';
export {
  fillMissingSettingsFromEnvironmentVariables,
  getDefaultEnvironmentProvider,
  getDefaultPathPolicyProvider,
  getEnvVar,
  isInTauri,
} from './utils/tauri.js';
export {
  getLLMChatV2ApiKeyEnvVarNames,
  getLLMChatV2CustomProviderApiKeyEnvVarNames,
} from './utils/chatV2ProviderEnv.js';
export {
  compareProjects,
  getProjectConnectionComparisonKey,
  getProjectNodeFieldComparisons,
  type ProjectComparison,
  type ProjectComparisonChangeKind,
  type ProjectConnectionComparison,
  type ProjectGraphComparison,
  type ProjectNodeFieldComparison,
  type ProjectNodeComparison,
} from '@valerypopoff/rivet2-core';
export type { ProjectCompareSideLabels } from './state/projectComparison.js';
export {
  configureHybridStorageBackend,
  IndexedDBStorage,
  MemoryAsyncStorage,
  type AsyncStorageBackend,
} from './state/storage.js';
export type { IOProvider, PathBasedIOProvider } from './io/IOProvider.js';
