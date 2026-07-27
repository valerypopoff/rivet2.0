import { newId, type RuntimeSettings } from '@valerypopoff/rivet2-core';
import { useStore } from 'jotai';
import { cloneDeep } from 'lodash-es';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  captureGraphBuilderEditorContext,
  prepareGraphBuilderCommit,
  publishGraphBuilderHistorySnapshotState,
  tryCommitGraphBuilderDraftState,
} from '../features/graphBuilder/editorGateway.js';
import { createPlanBGraphBuilderSessionRuntime } from '../features/graphBuilder/planBSessionRuntime.js';
import { createGraphBuilderPolicyRunner } from '../features/graphBuilder/policyRunner.js';
import {
  isGraphBuilderTerminalViewState,
  type GraphBuilderSessionController,
  type GraphBuilderSessionViewState,
} from '../features/graphBuilder/sessionController.js';
import { waitForGraphBuilderStartupTask } from '../features/graphBuilder/startupTask.js';
import { useEnvironmentProvider } from '../providers/ProvidersContext.js';
import { activeGraphBuilderSessionOwnerState } from '../state/graphBuilderAi.js';
import { settingsState } from '../state/settings.js';
import { fillMissingSettingsFromEnvironmentVariables } from '../utils/tauri.js';

type PlanBGraphBuilderSession = {
  capturedModelDisplayName?: string;
  sessionId?: string;
  state?: GraphBuilderSessionViewState;
};

/**
 * React ownership adapter for the host-owned Plan B session. It deliberately
 * keeps the controller, credential-bearing runtime settings, and private draft
 * out of Jotai and out of the authoritative editor graph until Apply.
 */
export function usePlanBGraphBuilder() {
  const store = useStore();
  const environmentProvider = useEnvironmentProvider();
  const [session, setSession] = useState<PlanBGraphBuilderSession>({});
  const controllerRef = useRef<GraphBuilderSessionController>();
  const startupAbortRef = useRef<AbortController>();
  const unsubscribeRef = useRef<() => void>();
  const sessionIdRef = useRef<string>();
  const mountedRef = useRef(true);

  const releaseOwnership = useCallback(
    (sessionId: string) => {
      const owner = store.get(activeGraphBuilderSessionOwnerState);
      if (owner?.sessionId === sessionId) {
        store.set(activeGraphBuilderSessionOwnerState, undefined);
      }
    },
    [store],
  );

  const disposeController = useCallback(
    (options: { cancel: boolean }) => {
      const controller = controllerRef.current;
      const startupAbort = startupAbortRef.current;
      unsubscribeRef.current?.();
      unsubscribeRef.current = undefined;
      controllerRef.current = undefined;
      startupAbortRef.current = undefined;
      startupAbort?.abort('Graph Builder session disposed');
      if (options.cancel && controller) {
        void controller.cancel();
      }
      const sessionId = controller?.sessionId ?? sessionIdRef.current;
      if (sessionId) {
        releaseOwnership(sessionId);
      }
    },
    [releaseOwnership],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      disposeController({ cancel: true });
    };
  }, [disposeController]);

  const start = useCallback(
    async (request: string): Promise<void> => {
      if (controllerRef.current || startupAbortRef.current || !request.trim()) {
        return;
      }

      let initialContext: ReturnType<typeof captureGraphBuilderEditorContext>;
      try {
        initialContext = captureGraphBuilderEditorContext(store);
      } catch {
        const failedSessionId = newId();
        setSession({
          sessionId: failedSessionId,
          state: failedSessionState(
            failedSessionId,
            'editor-context-capture-failed',
            'Rivet could not safely capture the current project for Graph Builder.',
          ),
        });
        return;
      }
      if (!initialContext.eligibility.eligible) {
        setSession({
          capturedModelDisplayName: initialContext.assistModel.displayName,
          state: failedSessionState(newId(), 'ineligible', initialContext.eligibility.reason),
        });
        return;
      }
      if (initialContext.assistModel.missingConfiguration) {
        setSession({
          capturedModelDisplayName: initialContext.assistModel.displayName,
          state: failedSessionState(
            newId(),
            'invalid-model-configuration',
            initialContext.assistModel.missingConfiguration,
          ),
        });
        return;
      }

      const sessionId = newId();
      sessionIdRef.current = sessionId;
      const startupAbort = new AbortController();
      startupAbortRef.current = startupAbort;
      store.set(activeGraphBuilderSessionOwnerState, {
        projectId: initialContext.base.projectId,
        sessionId,
      });
      setSession({
        capturedModelDisplayName: initialContext.assistModel.displayName,
        sessionId,
        state: {
          status: 'gathering-context',
          sessionId,
          policyAttempts: 0,
          progress: 'Preparing the private Graph Builder session…',
        },
      });

      try {
        const runtimeSettingsResult = await waitForGraphBuilderStartupTask(
          fillMissingSettingsFromEnvironmentVariables(store.get(settingsState), [], {
            environmentProvider,
          }),
          startupAbort.signal,
        );
        if (runtimeSettingsResult.status === 'aborted') {
          releaseOwnership(sessionId);
          return;
        }
        const runtimeSettings = Object.freeze(cloneDeep(runtimeSettingsResult.value)) as Readonly<RuntimeSettings>;
        if (startupAbort.signal.aborted || !mountedRef.current) {
          releaseOwnership(sessionId);
          return;
        }

        const currentOwner = store.get(activeGraphBuilderSessionOwnerState);
        if (currentOwner?.sessionId !== sessionId || currentOwner.projectId !== initialContext.base.projectId) {
          setSession({
            capturedModelDisplayName: initialContext.assistModel.displayName,
            sessionId,
            state: conflictedSessionState(sessionId, initialContext.base, initialContext.base.projectFingerprint),
          });
          return;
        }

        const context = captureGraphBuilderEditorContext(store, sessionId);
        if (
          !context.eligibility.eligible ||
          context.base.projectCanonicalIdentity !== initialContext.base.projectCanonicalIdentity ||
          context.base.registryContractCanonicalIdentity !== initialContext.base.registryContractCanonicalIdentity ||
          context.base.referencedProjectsCanonicalIdentity !==
            initialContext.base.referencedProjectsCanonicalIdentity ||
          context.base.policyConfigFingerprint !== initialContext.base.policyConfigFingerprint
        ) {
          setSession({
            capturedModelDisplayName: initialContext.assistModel.displayName,
            sessionId,
            state: conflictedSessionState(sessionId, initialContext.base, context.base.projectFingerprint),
          });
          releaseOwnership(sessionId);
          return;
        }

        const policyRunner = createGraphBuilderPolicyRunner();
        const { controller } = createPlanBGraphBuilderSessionRuntime({
          sessionId,
          request: request.trim(),
          base: context.base,
          activeGraphId: context.base.activeGraphId,
          authoringProject: context.snapshot.authoringProject,
          referencedProjects: context.referencedProjects,
          registry: context.registry,
          projectDataManifest: context.snapshot.projectDataManifest,
          authoringPreferences: {
            applyDefaultNodeColors: context.authoringPreferences.applyDefaultNodeColors,
          },
          mutableBoundaryGraphIds: context.snapshot.transientGraph ? [context.base.activeGraphId] : [],
          executePolicy: (turn, abortSignal, reportActivity) =>
            policyRunner.execute(turn, {
              assistModel: context.assistModel,
              runtimeSettings,
              abortSignal,
              onActivity: reportActivity,
            }),
          verifyIdentity: () => {
            const live = captureGraphBuilderEditorContext(store, sessionId);
            return {
              matches:
                live.eligibility.eligible &&
                live.base.projectCanonicalIdentity === context.base.projectCanonicalIdentity &&
                live.base.registryContractCanonicalIdentity === context.base.registryContractCanonicalIdentity &&
                live.base.referencedProjectsCanonicalIdentity === context.base.referencedProjectsCanonicalIdentity &&
                live.base.policyConfigFingerprint === context.base.policyConfigFingerprint &&
                live.base.validationRulesVersion === context.base.validationRulesVersion &&
                live.base.protocolVersion === context.base.protocolVersion,
              currentFingerprint: live.base.projectFingerprint,
            };
          },
          commit: ({ draft, draftRevision, summary }) => {
            const prepared = prepareGraphBuilderCommit({
              base: context.base,
              commitId: `${sessionId}:commit`,
              ownerSessionId: sessionId,
              draft,
              draftRevision,
              summary,
            });
            return store.set(tryCommitGraphBuilderDraftState, {
              prepared,
              publishHistorySnapshot: (activeGraphId, snapshot) =>
                store.set(publishGraphBuilderHistorySnapshotState, {
                  activeGraphId,
                  snapshot,
                }),
            });
          },
        });

        if (startupAbortRef.current !== startupAbort || startupAbort.signal.aborted) {
          releaseOwnership(sessionId);
          return;
        }
        startupAbortRef.current = undefined;
        controllerRef.current = controller;
        unsubscribeRef.current = controller.subscribe((nextState) => {
          if (!mountedRef.current || controllerRef.current?.sessionId !== nextState.sessionId) {
            return;
          }
          setSession({
            capturedModelDisplayName: context.assistModel.displayName,
            sessionId,
            state: nextState,
          });
          if (isGraphBuilderTerminalViewState(nextState)) {
            releaseOwnership(sessionId);
          }
        });
        await controller.start();
      } catch {
        if (!startupAbort.signal.aborted && mountedRef.current) {
          setSession({
            capturedModelDisplayName: initialContext.assistModel.displayName,
            sessionId,
            state: failedSessionState(
              sessionId,
              'session-start-failed',
              'Rivet could not start a safe Graph Builder session.',
            ),
          });
        }
        releaseOwnership(sessionId);
      } finally {
        if (startupAbortRef.current === startupAbort) {
          startupAbortRef.current = undefined;
        }
      }
    },
    [environmentProvider, releaseOwnership, store],
  );

  const resume = useCallback(async (answer: string) => {
    const controller = controllerRef.current;
    const state = controller?.getState();
    if (controller && state?.status === 'awaiting-user') {
      await controller.resume(state.resumeToken, answer);
    }
  }, []);

  const apply = useCallback(async () => {
    await controllerRef.current?.apply();
  }, []);

  const discard = useCallback(async () => {
    await controllerRef.current?.discard();
  }, []);

  const cancel = useCallback(async () => {
    const startupAbort = startupAbortRef.current;
    startupAbort?.abort('Graph Builder canceled');
    await controllerRef.current?.cancel();
    if (sessionIdRef.current) {
      releaseOwnership(sessionIdRef.current);
      if (startupAbort && mountedRef.current) {
        setSession((current) => ({
          ...current,
          state: {
            status: 'canceled',
            sessionId: sessionIdRef.current!,
            result: { status: 'canceled' },
          },
        }));
      }
    }
  }, [releaseOwnership]);

  const reset = useCallback(async () => {
    const state = controllerRef.current?.getState();
    if (state?.status === 'committing') {
      return;
    }
    if (state && !isGraphBuilderTerminalViewState(state)) {
      await controllerRef.current?.discard();
    }
    disposeController({ cancel: false });
    sessionIdRef.current = undefined;
    setSession({});
  }, [disposeController]);

  return {
    ...session,
    apply,
    cancel,
    discard,
    reset,
    resume,
    start,
  };
}

function failedSessionState(sessionId: string, code: string, userMessage: string): GraphBuilderSessionViewState {
  return {
    status: 'failed',
    sessionId,
    result: {
      status: 'failed',
      failure: { code, userMessage },
      diagnostics: [],
    },
  };
}

function conflictedSessionState(
  sessionId: string,
  base: Parameters<typeof prepareGraphBuilderCommit>[0]['base'],
  currentFingerprint: string,
): GraphBuilderSessionViewState {
  return {
    status: 'conflicted',
    sessionId,
    result: {
      status: 'conflicted',
      base: {
        projectId: base.projectId,
        activeGraphId: base.activeGraphId,
        editorRevision: base.editorRevision,
        projectFingerprint: base.projectFingerprint,
        registryContractFingerprint: base.registryContractFingerprint,
        referencedProjectsFingerprint: base.referencedProjectsFingerprint,
        policyConfigFingerprint: base.policyConfigFingerprint,
        validationRulesVersion: base.validationRulesVersion,
        protocolVersion: base.protocolVersion,
      },
      currentFingerprint,
    },
  };
}
