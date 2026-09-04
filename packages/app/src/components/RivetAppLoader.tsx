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
import { EvaluationLibrarySyncDialog } from './evaluations/EvaluationLibrarySyncDialog.js';
import { evaluationLibraryState, evaluationLibrarySyncIssueState } from '../state/evaluations.js';
import { handleError } from '../utils/errorHandling.js';
import { describeEvaluationLibraryRemoteChange } from '../utils/evaluationLibraryRemoteChange.js';
import { toast } from 'react-toastify';

// Storage-backed atoms read synchronously on mount, so this subtree must stay behind the
// async hybrid-storage bootstrap or settings/theme atoms can lock in default values.
const InitializedRivetApp = ({ children }: { children?: ReactNode }) => {
  const settings = useAtomValue(settingsState);
  const plugins = useDependsOnPlugins();
  const environmentProvider = useEnvironmentProvider();
  const evaluationStore = useEvaluationStore();
  const evaluationLibrary = useAtomValue(evaluationLibraryState);
  const setEvaluationLibrary = useSetAtom(evaluationLibraryState);
  const evaluationLibrarySyncIssue = useAtomValue(evaluationLibrarySyncIssueState);
  const setEvaluationLibrarySyncIssue = useSetAtom(evaluationLibrarySyncIssueState);
  const pendingLibraryWrite = useRef(Promise.resolve());
  const lastObservedLibrary = useRef(evaluationLibrary);
  const evaluationLibrarySyncIssueId = useRef<string>();

  useEffect(() => {
    if (!evaluationStore.subscribeLibrarySyncIssue) {
      evaluationLibrarySyncIssueId.current = undefined;
      setEvaluationLibrarySyncIssue(undefined);
      return;
    }
    return evaluationStore.subscribeLibrarySyncIssue((issue) => {
      evaluationLibrarySyncIssueId.current = issue?.id;
      setEvaluationLibrarySyncIssue(issue);
    });
  }, [evaluationStore]);

  useEffect(() => {
    // Hydration updates the atom before this subtree mounts. Do not turn every
    // application start into a redundant write (or overwrite a recoverable
    // resource that normalization omitted). Only persist subsequent edits.
    if (lastObservedLibrary.current === evaluationLibrary) return;
    lastObservedLibrary.current = evaluationLibrary;
    const librarySnapshot = structuredClone(evaluationLibrary);
    const issueIdBeforeWrite = evaluationLibrarySyncIssueId.current;
    // Hosted stores capture resource deltas at the moment the atom changes so
    // a later acknowledgement cannot accidentally replay an older full
    // library over another browser's unrelated edit. Local stores retain the
    // existing serialized whole-library write path.
    const write = evaluationStore.mutateLibrary
      ? evaluationStore.putLibrary(librarySnapshot)
      : (pendingLibraryWrite.current = pendingLibraryWrite.current
          .catch(() => undefined)
          .then(() => evaluationStore.putLibrary(librarySnapshot)));
    void write.catch((error) => {
      // The hosted store exposes conflicts and retryable failures through the
      // dedicated resolution dialog. Do not hide that actionable state behind
      // a generic toast. Stores without that capability retain the legacy
      // error handling behavior.
      if (
        evaluationLibrarySyncIssueId.current !== undefined &&
        evaluationLibrarySyncIssueId.current !== issueIdBeforeWrite
      ) {
        return;
      }
      handleError(error, 'Failed to save the evaluation library');
    });
  }, [evaluationLibrary, evaluationStore]);

  useEffect(() => {
    if (!evaluationStore.subscribeLibraryInvalidation || !evaluationStore.getLibrarySyncSnapshot) return;
    let disposed = false;
    let refreshInFlight = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryCount = 0;
    let pending:
      | {
          epoch: string;
          revision: number;
        }
      | undefined;
    let notificationBaseline: typeof evaluationLibrary | undefined;

    const retryDelay = () => Math.min(1_000 * 2 ** retryCount++, 30_000);
    const scheduleRetry = () => {
      retryTimer ??= setTimeout(() => {
        retryTimer = undefined;
        refresh();
      }, retryDelay());
    };
    const shouldRefreshAgain = (target: { epoch: string; revision: number }, revision: number): boolean =>
      pending !== undefined && (pending.epoch !== target.epoch || pending.revision > revision);

    const refresh = () => {
      if (disposed) return;
      if (refreshInFlight) return;
      if (!pending) return;
      refreshInFlight = true;
      void (async () => {
        const target = pending!;
        try {
          const snapshot = await evaluationStore.getLibrarySyncSnapshot!();
          const library = await evaluationStore.getLibrary();
          if (disposed) return;
          // This is a server-orchestrated rebase, not a user edit. Advance
          // the observer before setting the atom so it cannot trigger a
          // redundant persistence write.
          lastObservedLibrary.current = library;
          setEvaluationLibrary(library);
          if (!shouldRefreshAgain(target, snapshot.revision)) {
            pending = undefined;
            retryCount = 0;
            if (retryTimer) {
              clearTimeout(retryTimer);
              retryTimer = undefined;
            }
            if (notificationBaseline && evaluationLibrarySyncIssueId.current === undefined) {
              const message = describeEvaluationLibraryRemoteChange(notificationBaseline, library);
              if (message) toast.info(message, { toastId: `evaluation-library-${target.epoch}-${target.revision}` });
            }
            notificationBaseline = undefined;
          } else {
            // A newly notified revision may not yet be visible through a
            // replica. Keep the token, but never turn that lag into a tight
            // request loop.
            scheduleRetry();
          }
        } catch (error) {
          console.warn('Failed to refresh the evaluation library:', error);
          scheduleRetry();
        }
      })().finally(() => {
        refreshInFlight = false;
        if (!disposed && pending && retryTimer === undefined) refresh();
      });
    };
    const unsubscribe = evaluationStore.subscribeLibraryInvalidation((invalidation) => {
      if (disposed) return;
      if (
        pending === undefined ||
        pending.epoch !== invalidation.epoch ||
        invalidation.revision > pending.revision
      ) {
        pending = { epoch: invalidation.epoch, revision: invalidation.revision };
      }
      notificationBaseline ??= lastObservedLibrary.current;
      refresh();
    });
    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      unsubscribe();
    };
  }, [evaluationStore, setEvaluationLibrary]);

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
      <EvaluationLibrarySyncDialog
        issue={evaluationLibrarySyncIssue}
        onResolve={async (input) => {
          if (!evaluationStore.resolveLibraryConflict) {
            throw new Error('This evaluation store cannot resolve shared-library conflicts.');
          }
          const library = await evaluationStore.resolveLibraryConflict(input);
          lastObservedLibrary.current = library;
          setEvaluationLibrary(library);
        }}
        onRetry={async () => {
          if (!evaluationStore.retryLibrarySync) {
            throw new Error('This evaluation store cannot retry the pending shared-library save.');
          }
          const library = await evaluationStore.retryLibrarySync();
          lastObservedLibrary.current = library;
          setEvaluationLibrary(library);
        }}
      />
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
  const setEvaluationLibrarySyncIssue = useSetAtom(evaluationLibrarySyncIssueState);

  useAsyncEffect(async () => {
    const generation = ++initializationGeneration.current;
    setIsLoading(true);
    setLoadingError(undefined);
    // The atom is process-global, while a hosted store can be replaced for a
    // tenant/session change. Never let an unresolved issue from the old
    // persistence boundary briefly render against the replacement store.
    setEvaluationLibrarySyncIssue(undefined);
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
  }, [evaluationStore, setEvaluationLibrary, setEvaluationLibrarySyncIssue, storage]);

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
