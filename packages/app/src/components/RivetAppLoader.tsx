import { useState, type ReactNode } from 'react';
import {
  allInitializeStoreFns,
  configureHybridStorageBackend,
  flushHybridStorageGroup,
  type AsyncStorageBackend,
} from '../state/storage';
import useAsyncEffect from 'use-async-effect';
import { RivetApp } from './RivetApp';
import { useAtomValue } from 'jotai';
import { clearLegacyInvalidOpenAiApiKeyPlaceholder, settingsState } from '../state/settings.js';
import { useDependsOnPlugins } from '../hooks/useDependsOnPlugins.js';
import { fillMissingSettingsFromEnvironmentVariables } from '../utils/tauri.js';
import { prefetchChatV2DiscoveredModelOptions } from '../utils/chatV2ModelCatalog.js';
import { useEnvironmentProvider } from '../providers/ProvidersContext.js';

// Storage-backed atoms read synchronously on mount, so this subtree must stay behind the
// async hybrid-storage bootstrap or settings/theme atoms can lock in default values.
const InitializedRivetApp = ({ children }: { children?: ReactNode }) => {
  const settings = useAtomValue(settingsState);
  const plugins = useDependsOnPlugins();
  const environmentProvider = useEnvironmentProvider();

  useAsyncEffect(async () => {
    const resolvedSettings = await fillMissingSettingsFromEnvironmentVariables(settings, plugins, {
      environmentProvider,
    });
    prefetchChatV2DiscoveredModelOptions({
      settings: resolvedSettings,
      plugins,
    });
  }, [environmentProvider, plugins, settings]);

  return (
    <>
      <RivetApp />
      {children}
    </>
  );
};

export const RivetAppLoader = ({
  children,
  loadingFallback = <div>Loading...</div>,
  storage,
}: {
  children?: ReactNode;
  loadingFallback?: ReactNode;
  storage?: AsyncStorageBackend;
}) => {
  const [isLoading, setIsLoading] = useState(true);

  useAsyncEffect(async () => {
    configureHybridStorageBackend(storage);

    for (const initializeFn of allInitializeStoreFns) {
      await initializeFn();
    }

    if (clearLegacyInvalidOpenAiApiKeyPlaceholder()) {
      await flushHybridStorageGroup('recoil-persist');
    }

    setIsLoading(false);
  }, [storage]);

  if (isLoading) {
    return loadingFallback;
  }

  return <InitializedRivetApp>{children}</InitializedRivetApp>;
};
