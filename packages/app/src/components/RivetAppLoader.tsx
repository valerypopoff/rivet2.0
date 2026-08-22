import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  allInitializeStoreFns,
  configureHybridStorageBackend,
  flushHybridStorageGroup,
  type AsyncStorageBackend,
} from '../state/storage';
import useAsyncEffect from 'use-async-effect';
import { RivetApp } from './RivetApp';
import { useAtomValue, useSetAtom } from 'jotai';
import { clearLegacyInvalidOpenAiApiKeyPlaceholder, settingsState } from '../state/settings.js';
import { useDependsOnPlugins } from '../hooks/useDependsOnPlugins.js';
import { fillMissingSettingsFromEnvironmentVariables } from '../utils/tauri.js';
import { prefetchChatV2DiscoveredModelOptions } from '../utils/chatV2ModelCatalog.js';
import { useEnvironmentProvider, useEvaluationStore } from '../providers/ProvidersContext.js';
import { evaluationLibraryState } from '../state/evaluations.js';
import { handleError } from '../utils/errorHandling.js';

// Storage-backed atoms read synchronously on mount, so this subtree must stay behind the
// async hybrid-storage bootstrap or settings/theme atoms can lock in default values.
const InitializedRivetApp = ({ children }: { children?: ReactNode }) => {
  const settings = useAtomValue(settingsState);
  const plugins = useDependsOnPlugins();
  const environmentProvider = useEnvironmentProvider();
  const evaluationStore = useEvaluationStore();
  const evaluationLibrary = useAtomValue(evaluationLibraryState);
  const pendingLibraryWrite = useRef(Promise.resolve());
  const lastObservedLibrary = useRef(evaluationLibrary);

  useEffect(() => {
    // Hydration updates the atom before this subtree mounts. Do not turn every
    // application start into a redundant write (or overwrite a recoverable
    // resource that normalization omitted). Only persist subsequent edits.
    if (lastObservedLibrary.current === evaluationLibrary) return;
    lastObservedLibrary.current = evaluationLibrary;
    const librarySnapshot = structuredClone(evaluationLibrary);
    const write = pendingLibraryWrite.current
      .catch(() => undefined)
      .then(() => evaluationStore.putLibrary(librarySnapshot));
    pendingLibraryWrite.current = write;
    void write.catch((error) => handleError(error, 'Failed to save the evaluation library'));
  }, [evaluationLibrary, evaluationStore]);

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
  const [loadingError, setLoadingError] = useState<string>();
  const [initializedSource, setInitializedSource] = useState<{
    evaluationStore: ReturnType<typeof useEvaluationStore>;
    storage: AsyncStorageBackend | undefined;
  }>();
  const initializationGeneration = useRef(0);
  const evaluationStore = useEvaluationStore();
  const setEvaluationLibrary = useSetAtom(evaluationLibraryState);

  useAsyncEffect(async () => {
    const generation = ++initializationGeneration.current;
    setIsLoading(true);
    setLoadingError(undefined);
    try {
      configureHybridStorageBackend(storage);

      for (const initializeFn of allInitializeStoreFns) {
        await initializeFn();
      }

      if (clearLegacyInvalidOpenAiApiKeyPlaceholder()) {
        await flushHybridStorageGroup('recoil-persist');
      }

      const initialization = await evaluationStore.initialize?.();
      if (initialization?.warning) console.warn(initialization.warning);
      const library = await evaluationStore.getLibrary();
      if (initializationGeneration.current !== generation) return;
      setEvaluationLibrary(library);
      setInitializedSource({ evaluationStore, storage });
      setIsLoading(false);
    } catch (error) {
      if (initializationGeneration.current !== generation) return;
      const message = error instanceof Error ? error.message : String(error);
      handleError(error, 'Failed to initialize evaluation persistence', { toastError: false });
      setInitializedSource({ evaluationStore, storage });
      setLoadingError(message || 'Unknown persistence error');
      setIsLoading(false);
    }
  }, [evaluationStore, setEvaluationLibrary, storage]);

  const sourceIsCurrent =
    initializedSource?.evaluationStore === evaluationStore && initializedSource.storage === storage;
  if (isLoading || !sourceIsCurrent) {
    return loadingFallback;
  }

  if (loadingError) {
    return <div>Rivet could not load evaluation data: {loadingError}</div>;
  }

  return <InitializedRivetApp>{children}</InitializedRivetApp>;
};
