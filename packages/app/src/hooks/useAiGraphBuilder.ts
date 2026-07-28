import { newId } from '@valerypopoff/rivet2-core';
import { useAtomValue, useStore } from 'jotai';
import { cloneDeep } from 'lodash-es';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import type { GraphBuilderAuthoringProject, GraphDraftDelta } from '../domain/graphBuilder/index.js';
import { createGraphBuilderAuthoringCatalog } from '../features/graphBuilder/authoringCatalog.js';
import {
  captureGraphBuilderEditorContext,
  prepareGraphBuilderCommit,
  publishGraphBuilderHistorySnapshotState,
  tryCommitGraphBuilderDraftState,
  type GraphBuilderCommitOutcome,
} from '../features/graphBuilder/editorGateway.js';
import { graphBuilderBaseIdentityMatches, type GraphBuilderBaseIdentity } from '../features/graphBuilder/identity.js';
import { runLegacyGraphBuilderDraft } from '../features/graphBuilder/legacyDraftRunner.js';
import { createBundledLegacyGraphBuilderAgentExecutor } from '../features/graphBuilder/legacyGraphCreatorAgentExecutor.js';
import { revalidateLegacyGraphBuilderStartup } from '../features/graphBuilder/legacySessionStartup.js';
import type { GraphBuilderPreview, GraphBuilderSessionViewState } from '../features/graphBuilder/sessionController.js';
import { waitForGraphBuilderStartupTask } from '../features/graphBuilder/startupTask.js';
import { useEnvironmentProvider } from '../providers/ProvidersContext.js';
import { activeGraphBuilderSessionOwnerState } from '../state/graphBuilderAi.js';
import { settingsState } from '../state/settings.js';
import { handleError } from '../utils/errorHandling.js';
import type { ResolvedAiAssistModelSettings } from '../utils/aiAssistModelSettings.js';
import { fillMissingSettingsFromEnvironmentVariables } from '../utils/tauri.js';
import { formatLegacyGraphBuilderAccounting, LegacyGraphBuilderAccounting } from './legacyGraphBuilderLogging.js';
import { useCenterViewOnGraph } from './useCenterViewOnGraph.js';
import { useDependsOnPlugins } from './useDependsOnPlugins.js';

type PendingLegacyDraft = {
  base: GraphBuilderBaseIdentity;
  draft: GraphBuilderAuthoringProject;
  draftRevision: number;
  preview: GraphBuilderPreview;
  sessionId: string;
};

type ActiveLegacySession = {
  abortController?: AbortController;
  sessionId: string;
};

type LegacyGraphBuilderSession = {
  capturedModelDisplayName?: string;
  sessionId?: string;
  state?: GraphBuilderSessionViewState;
};

/**
 * Temporary rollback adapter for the legacy Graph Creator policy. The policy
 * now runs entirely against the same private-draft/atomic-commit boundary as
 * Plan B; only its model orchestration remains legacy.
 */
export function useLegacyAiGraphBuilder({ onFeedback }: { onFeedback: (feedback: string) => void }) {
  const store = useStore();
  const settings = useAtomValue(settingsState);
  const plugins = useDependsOnPlugins();
  const environmentProvider = useEnvironmentProvider();
  const centerView = useCenterViewOnGraph();
  const [session, setSession] = useState<LegacyGraphBuilderSession>({});
  const activeRef = useRef<ActiveLegacySession>();
  const pendingRef = useRef<PendingLegacyDraft>();
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

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const active = activeRef.current;
      active?.abortController?.abort('Legacy Graph Builder disposed');
      if (active) {
        releaseOwnership(active.sessionId);
      }
      activeRef.current = undefined;
      pendingRef.current = undefined;
    };
  }, [releaseOwnership]);

  const start = useCallback(
    async (request: string, requestedModel: ResolvedAiAssistModelSettings): Promise<void> => {
      if (activeRef.current || !request.trim()) {
        return;
      }

      let initialContext: ReturnType<typeof captureGraphBuilderEditorContext>;
      try {
        initialContext = captureGraphBuilderEditorContext(store);
      } catch {
        const sessionId = newId();
        setSession({
          capturedModelDisplayName: requestedModel.displayName,
          sessionId,
          state: failedState(
            sessionId,
            'editor-context-capture-failed',
            'Rivet could not safely capture the current project for Graph Builder.',
          ),
        });
        return;
      }
      if (!initialContext.eligibility.eligible) {
        const sessionId = newId();
        setSession({
          capturedModelDisplayName: initialContext.assistModel.displayName,
          sessionId,
          state: failedState(sessionId, 'ineligible', initialContext.eligibility.reason),
        });
        return;
      }
      if (initialContext.assistModel.missingConfiguration) {
        const sessionId = newId();
        setSession({
          capturedModelDisplayName: initialContext.assistModel.displayName,
          sessionId,
          state: failedState(sessionId, 'invalid-model-configuration', initialContext.assistModel.missingConfiguration),
        });
        return;
      }

      const sessionId = newId();
      const abortController = new AbortController();
      activeRef.current = { abortController, sessionId };
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
          progress: 'Preparing the private legacy Graph Builder draft…',
        },
      });

      let retainDraft = false;
      let workingToastId: ReturnType<typeof toast.info> | undefined;
      const accounting = new LegacyGraphBuilderAccounting();
      const isCurrent = () => activeRef.current?.sessionId === sessionId;
      const logWithTime = (message: string) => {
        if (isCurrent()) {
          onFeedback(`[${new Date().toLocaleTimeString()}] ${message}`);
        }
      };

      try {
        const context = captureGraphBuilderEditorContext(store, sessionId);
        if (!context.eligibility.eligible || !graphBuilderBaseIdentityMatches(initialContext.base, context.base)) {
          setSession({
            capturedModelDisplayName: initialContext.assistModel.displayName,
            sessionId,
            state: conflictedState(sessionId, initialContext.base, context.base.projectFingerprint),
          });
          return;
        }

        workingToastId = toast.info('Working…');
        logWithTime(`Starting AI graph builder with ${context.assistModel.displayName}.`);
        logWithTime(`Request received (${request.length} chars).`);
        setSession({
          capturedModelDisplayName: context.assistModel.displayName,
          sessionId,
          state: {
            status: 'editing',
            sessionId,
            policyAttempts: 0,
            progress: 'The legacy policy is preparing a private graph draft…',
          },
        });

        const runtimeSettingsResult = await waitForGraphBuilderStartupTask(
          fillMissingSettingsFromEnvironmentVariables(settings, plugins, {
            environmentProvider,
          }),
          abortController.signal,
        );
        if (runtimeSettingsResult.status === 'aborted') {
          return;
        }
        const runtimeSettings = runtimeSettingsResult.value;
        const startupRevalidation = revalidateLegacyGraphBuilderStartup({
          abortSignal: abortController.signal,
          base: context.base,
          captureContext: () => captureGraphBuilderEditorContext(store, sessionId),
          isCurrent: isCurrent(),
          isMounted: mountedRef.current,
        });
        if (startupRevalidation.status === 'abandoned') {
          return;
        }
        if (startupRevalidation.status === 'conflicted') {
          setSession({
            capturedModelDisplayName: context.assistModel.displayName,
            sessionId,
            state: conflictedState(sessionId, context.base, startupRevalidation.currentFingerprint),
          });
          return;
        }

        const executeAgent = createBundledLegacyGraphBuilderAgentExecutor({
          assistModel: context.assistModel,
          runtimeSettings,
          onChatV2CallFinished: (event) => {
            accounting.record(event);
          },
        });

        const result = await runLegacyGraphBuilderDraft({
          abortSignal: abortController.signal,
          activeGraphId: context.base.activeGraphId,
          baseProject: context.snapshot.authoringProject,
          catalog: createGraphBuilderAuthoringCatalog({
            registry: context.registry,
            project: context.snapshot.authoringProject,
            referencedProjects: context.referencedProjects,
            authoringPreferences: {
              applyDefaultNodeColors: context.authoringPreferences.applyDefaultNodeColors,
            },
          }),
          executeAgent,
          onFeedback: logWithTime,
          onProgress: (progress) => {
            if (!isCurrent() || !mountedRef.current) {
              return;
            }
            if (progress.type === 'draft-changed') {
              setSession({
                capturedModelDisplayName: context.assistModel.displayName,
                sessionId,
                state: {
                  status: 'editing',
                  sessionId,
                  policyAttempts: 0,
                  progress: draftProgressMessage(progress.delta, progress.draftRevision),
                },
              });
            } else if (progress.type === 'model-update') {
              setSession({
                capturedModelDisplayName: context.assistModel.displayName,
                sessionId,
                state: {
                  status: 'editing',
                  sessionId,
                  policyAttempts: 0,
                  progress: progress.message,
                },
              });
            }
          },
          referencedProjects: context.referencedProjects,
          registry: context.registry,
          request: request.trim(),
        });

        if (!isCurrent() || !mountedRef.current) {
          return;
        }
        if (result.status === 'canceled') {
          setSession({
            capturedModelDisplayName: context.assistModel.displayName,
            sessionId,
            state: canceledState(sessionId),
          });
          return;
        }

        const live = captureGraphBuilderEditorContext(store, sessionId);
        if (!live.eligibility.eligible || !graphBuilderBaseIdentityMatches(context.base, live.base)) {
          setSession({
            capturedModelDisplayName: context.assistModel.displayName,
            sessionId,
            state:
              result.status === 'ready-for-preview'
                ? {
                    ...conflictedState(sessionId, context.base, live.base.projectFingerprint),
                    retainedPreview: result.preview,
                  }
                : conflictedState(sessionId, context.base, live.base.projectFingerprint),
          });
          return;
        }

        if (result.status === 'no-change') {
          setSession({
            capturedModelDisplayName: context.assistModel.displayName,
            sessionId,
            state: {
              status: 'no-change',
              sessionId,
              result: {
                status: 'no-change',
                base: publicBase(context.base),
                summary: result.summary,
              },
            },
          });
          return;
        }

        pendingRef.current = {
          base: context.base,
          draft: result.draft,
          draftRevision: result.draftRevision,
          preview: result.preview,
          sessionId,
        };
        retainDraft = true;
        activeRef.current = { sessionId };
        setSession({
          capturedModelDisplayName: context.assistModel.displayName,
          sessionId,
          state: {
            status: 'ready-for-preview',
            sessionId,
            preview: result.preview,
          },
        });
        logWithTime('Private draft is ready for preview. The editor graph is unchanged until Apply.');
      } catch (error) {
        if (!isCurrent() || !mountedRef.current) {
          return;
        }
        if (abortController.signal.aborted) {
          setSession({
            capturedModelDisplayName: initialContext.assistModel.displayName,
            sessionId,
            state: canceledState(sessionId),
          });
        } else {
          logWithTime('FAILED Graph Builder request failed. See the error notification for details.');
          handleError(error, 'AI graph builder failed', {
            metadata: {
              model: initialContext.assistModel.displayName,
              promptLength: request.length,
            },
          });
          setSession({
            capturedModelDisplayName: initialContext.assistModel.displayName,
            sessionId,
            state: failedState(
              sessionId,
              'legacy-policy-failed',
              'The legacy Graph Builder could not prepare a safe draft.',
            ),
          });
        }
      } finally {
        logWithTime(`ACCOUNTING ${formatLegacyGraphBuilderAccounting(accounting.snapshot())}`);
        if (workingToastId != null) {
          toast.dismiss(workingToastId);
        }
        if (!retainDraft && activeRef.current?.sessionId === sessionId) {
          activeRef.current = undefined;
          pendingRef.current = undefined;
          releaseOwnership(sessionId);
        }
      }
    },
    [environmentProvider, onFeedback, plugins, releaseOwnership, settings, store],
  );

  const apply = useCallback(async () => {
    const pending = pendingRef.current;
    if (!pending || session.state?.status !== 'ready-for-preview') {
      return;
    }
    setSession((current) => ({
      ...current,
      state: {
        status: 'committing',
        sessionId: pending.sessionId,
        preview: pending.preview,
      },
    }));

    let outcome: GraphBuilderCommitOutcome;
    try {
      const prepared = prepareGraphBuilderCommit({
        base: pending.base,
        commitId: `${pending.sessionId}:commit`,
        draft: pending.draft,
        draftRevision: pending.draftRevision,
        ownerSessionId: pending.sessionId,
        summary: pending.preview.summary,
      });
      outcome = store.set(tryCommitGraphBuilderDraftState, {
        prepared,
        publishHistorySnapshot: (activeGraphId, snapshot) =>
          store.set(publishGraphBuilderHistorySnapshotState, {
            activeGraphId,
            snapshot,
          }),
      });
    } catch {
      outcome = {
        status: 'protocol-error',
        commitId: `${pending.sessionId}:commit`,
        reason: 'The prepared legacy draft could not be committed safely.',
      };
    }

    pendingRef.current = undefined;
    activeRef.current = undefined;
    releaseOwnership(pending.sessionId);
    if (outcome.status === 'committed') {
      const committedGraph = pending.draft.graphs[pending.base.activeGraphId];
      if (committedGraph) {
        centerView(cloneDeep(committedGraph));
      }
      setSession((current) => ({
        ...current,
        state: {
          status: 'committed',
          sessionId: pending.sessionId,
          result: {
            status: 'committed',
            base: publicBase(pending.base),
            draftRevision: pending.draftRevision,
            summary: pending.preview.summary,
          },
        },
      }));
      return;
    }
    if (outcome.status === 'conflicted') {
      setSession((current) => ({
        ...current,
        state: {
          ...conflictedState(pending.sessionId, pending.base, outcome.currentFingerprint),
          retainedPreview: pending.preview,
        },
      }));
      return;
    }
    setSession((current) => ({
      ...current,
      state: {
        ...failedState(
          pending.sessionId,
          outcome.status === 'ineligible' ? 'commit-ineligible' : 'commit-protocol-error',
          outcome.reason,
        ),
        retainedPreview: pending.preview,
      },
    }));
  }, [centerView, releaseOwnership, session.state?.status, store]);

  const cancel = useCallback(async () => {
    const active = activeRef.current;
    if (!active) {
      return;
    }
    active.abortController?.abort('Legacy Graph Builder canceled');
    pendingRef.current = undefined;
    activeRef.current = undefined;
    releaseOwnership(active.sessionId);
    if (mountedRef.current) {
      setSession((current) => ({
        ...current,
        state: canceledState(active.sessionId),
      }));
    }
  }, [releaseOwnership]);

  const discard = useCallback(async () => {
    const active = activeRef.current;
    if (!active) {
      return;
    }
    active.abortController?.abort('Legacy Graph Builder draft discarded');
    pendingRef.current = undefined;
    activeRef.current = undefined;
    releaseOwnership(active.sessionId);
    setSession((current) => ({
      ...current,
      state: {
        status: 'discarded',
        sessionId: active.sessionId,
        result: {
          status: 'discarded',
          summary: 'The private legacy draft was discarded without changing the project.',
        },
      },
    }));
  }, [releaseOwnership]);

  const reset = useCallback(async () => {
    const active = activeRef.current;
    active?.abortController?.abort('Legacy Graph Builder session reset');
    if (active) {
      releaseOwnership(active.sessionId);
    }
    activeRef.current = undefined;
    pendingRef.current = undefined;
    setSession({});
  }, [releaseOwnership]);

  return {
    ...session,
    apply,
    cancel,
    discard,
    reset,
    start,
  };
}

function draftProgressMessage(delta: GraphDraftDelta, draftRevision: number): string {
  const changeCount =
    (delta.addedNodeCount ?? delta.addedNodes.length) +
    (delta.updatedNodeCount ?? delta.updatedNodes.length) +
    (delta.removedNodeCount ?? delta.removedNodes.length) +
    (delta.addedConnectionCount ?? delta.addedConnections.length) +
    (delta.removedConnectionCount ?? delta.removedConnections.length);
  return `Prepared private draft revision ${draftRevision} (${changeCount} change${changeCount === 1 ? '' : 's'}).`;
}

function publicBase(base: GraphBuilderBaseIdentity) {
  return {
    projectId: base.projectId,
    activeGraphId: base.activeGraphId,
    editorRevision: base.editorRevision,
    projectFingerprint: base.projectFingerprint,
    registryContractFingerprint: base.registryContractFingerprint,
    referencedProjectsFingerprint: base.referencedProjectsFingerprint,
    policyConfigFingerprint: base.policyConfigFingerprint,
    validationRulesVersion: base.validationRulesVersion,
    protocolVersion: base.protocolVersion,
  };
}

function canceledState(sessionId: string): GraphBuilderSessionViewState {
  return {
    status: 'canceled',
    sessionId,
    result: { status: 'canceled' },
  };
}

function failedState(sessionId: string, code: string, userMessage: string) {
  return {
    status: 'failed' as const,
    sessionId,
    result: {
      status: 'failed' as const,
      failure: { code, userMessage },
      diagnostics: [],
    },
  };
}

function conflictedState(sessionId: string, base: GraphBuilderBaseIdentity, currentFingerprint: string) {
  return {
    status: 'conflicted' as const,
    sessionId,
    result: {
      status: 'conflicted' as const,
      base: publicBase(base),
      currentFingerprint,
    },
  };
}
