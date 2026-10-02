import { useState } from 'react';
import { useSetAtom } from 'jotai';
import useAsyncEffect from 'use-async-effect';
import {
  allInitializeStoreFns,
  configureHybridStorageBackend,
  flushHybridStorageGroup,
  getWorkspaceRecoveryStorage,
  initializeWorkspaceRecovery,
  type AsyncStorageBackend,
} from '../state/storage.js';
import { clearLegacyInvalidOpenAiApiKeyPlaceholder } from '../state/settings.js';
import { evaluationLibraryState, evaluationLibrarySyncIssueState } from '../state/evaluations.js';
import { useEvaluationStore } from '../providers/ProvidersContext.js';
import { useRivetAppHostCallbacks } from '../providers/HostCallbacksContext.js';
import { handleError } from '../utils/errorHandling.js';
import { useStableCallback } from './useStableCallback.js';
import { retryWorkspaceInitialization } from '../state/storage/workspaceRecoveryRetry.js';
import { WorkspaceRecoveryAccessError, WorkspaceRecoveryDataError } from '../state/storage/workspaceRecovery.js';

/** Only the current persistence owner may hydrate editor state or publish readiness. */
export function useInitializeWorkspace(storage?: AsyncStorageBackend): {
  loading: boolean;
  error?: string;
  canChooseRecovery: boolean;
  retry: () => void;
} {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [canChooseRecovery, setCanChooseRecovery] = useState(false);
  const [retryRevision, setRetryRevision] = useState(0);
  const evaluationStore = useEvaluationStore();
  const [initializedSource, setInitializedSource] = useState<{
    evaluationStore: typeof evaluationStore;
    storage: AsyncStorageBackend | undefined;
  }>();
  const { onInitializationError } = useRivetAppHostCallbacks();
  const reportInitializationError = useStableCallback(async (error: unknown) => {
    try {
      await onInitializationError?.(error);
    } catch (callbackError) {
      handleError(callbackError, 'Hosted onInitializationError callback failed', { toastError: false });
    }
  });
  const setEvaluationLibrary = useSetAtom(evaluationLibraryState);
  const setEvaluationLibrarySyncIssue = useSetAtom(evaluationLibrarySyncIssueState);

  useAsyncEffect(
    async (isMounted) => {
      setIsLoading(true);
      setError(undefined);
      setCanChooseRecovery(false);
      // A replacement host must not inherit an unresolved issue from the old store.
      setEvaluationLibrarySyncIssue(undefined);
      let recovery = getWorkspaceRecoveryStorage();
      const isCurrent = () => isMounted() && getWorkspaceRecoveryStorage() === recovery;
      try {
        configureHybridStorageBackend(storage);
        recovery = getWorkspaceRecoveryStorage();

        await retryWorkspaceInitialization(async () => {
          for (const initializeFn of allInitializeStoreFns) {
            await initializeFn(isCurrent);
            if (!isCurrent()) return;
          }
          await initializeWorkspaceRecovery(isCurrent);
          if (!isCurrent()) return;

          if (clearLegacyInvalidOpenAiApiKeyPlaceholder()) await flushHybridStorageGroup('recoil-persist');
          if (!isCurrent()) return;

          const initialization = await evaluationStore.initialize?.();
          if (!isCurrent()) return;
          if (initialization?.warning) console.warn(initialization.warning);
          const library = await evaluationStore.getLibrary();
          if (!isCurrent()) return;
          setEvaluationLibrary(library);
        }, isCurrent);
        if (!isCurrent()) return;
        setInitializedSource({ evaluationStore, storage });
        setIsLoading(false);
      } catch (error) {
        if (!isCurrent()) return;
        const message = error instanceof Error ? error.message : String(error);
        handleError(error, 'Failed to initialize persistent workspace data', { toastError: false });
        setInitializedSource({ evaluationStore, storage });
        setError(message || 'Unknown persistence error');
        setCanChooseRecovery(
          error instanceof WorkspaceRecoveryAccessError ||
            (error instanceof WorkspaceRecoveryDataError && error.canChooseRecovery),
        );
        setIsLoading(false);
        void reportInitializationError(error);
      }
    },
    [
      evaluationStore,
      reportInitializationError,
      setEvaluationLibrary,
      setEvaluationLibrarySyncIssue,
      storage,
      retryRevision,
    ],
  );

  const sourceIsCurrent =
    initializedSource?.evaluationStore === evaluationStore && initializedSource.storage === storage;
  return {
    loading: isLoading || !sourceIsCurrent,
    error,
    canChooseRecovery,
    retry: () => setRetryRevision((revision) => revision + 1),
  };
}
