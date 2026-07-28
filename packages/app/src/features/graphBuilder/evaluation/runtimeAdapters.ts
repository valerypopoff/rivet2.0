import { cloneDeep } from 'lodash-es';
import {
  GRAPH_BUILDER_PROTOCOL_VERSION,
  canonicalGraphBuilderAuthoringStringify,
  hashCanonicalGraphBuilderValue,
  hashGraphBuilderString,
  type GraphBuilderAuthoringProject,
  type GraphDiagnostic,
} from '../graphBuilderDomain.js';
import { GRAPH_BUILDER_VALIDATION_RULES_VERSION, type GraphBuilderBaseIdentity } from '../identity.js';
import {
  runLegacyGraphBuilderDraft,
  type LegacyGraphBuilderAgentExecution,
  type LegacyGraphBuilderAgentExecutor,
} from '../legacyDraftRunner.js';
import { createGraphBuilderAuthoringCatalog } from '../authoringCatalog.js';
import { createPlanBGraphBuilderSessionRuntime } from '../planBSessionRuntime.js';
import {
  isGraphBuilderTerminalViewState,
  type GraphBuilderPolicyExecutionResult,
  type GraphBuilderPolicyTurn,
  type GraphBuilderSessionViewState,
} from '../sessionController.js';
import type {
  GraphBuilderEvaluationAdapter,
  GraphBuilderEvaluationAdapterInput,
  GraphBuilderEvaluationAdapterResult,
  GraphBuilderEvaluationAuditSurface,
} from './harness.js';
import type { GraphBuilderProviderAttempt } from './contracts.js';

export type PlanBGraphBuilderEvaluationPolicyExecutor = (
  turn: GraphBuilderPolicyTurn,
  context: Readonly<{
    fixture: GraphBuilderEvaluationAdapterInput['fixture'];
    trial: number;
    abortSignal: AbortSignal;
  }>,
) => Promise<GraphBuilderPolicyExecutionResult>;

export type GraphBuilderEvaluationTrialCollector = Readonly<{
  requiredAuditSurfaceKinds?: readonly ('log' | 'recording')[];
  takeAuditedSurfaces(): readonly GraphBuilderEvaluationAuditSurface[];
  takeProviderAttempts(): readonly GraphBuilderProviderAttempt[];
}>;

export type CreatePlanBGraphBuilderEvaluationAdapterOptions = Readonly<{
  createTrialCollector?: (input: GraphBuilderEvaluationAdapterInput) => GraphBuilderEvaluationTrialCollector;
  executePolicy: PlanBGraphBuilderEvaluationPolicyExecutor;
}>;

export type CreateHardenedLegacyGraphBuilderEvaluationAdapterOptions = Readonly<{
  createTrialCollector?: (input: GraphBuilderEvaluationAdapterInput) => GraphBuilderEvaluationTrialCollector;
  executeAgent: LegacyGraphBuilderAgentExecutor;
}>;

/**
 * Runs the hardened legacy policy against the same private draft runner used
 * by production. As-shipped legacy remains artifact-only because that retired
 * implementation cannot be reconstructed from the hardened runtime.
 */
export function createHardenedLegacyGraphBuilderEvaluationAdapter(
  options: CreateHardenedLegacyGraphBuilderEvaluationAdapterOptions,
): GraphBuilderEvaluationAdapter {
  const usedCollectors = new WeakSet<object>();
  const seenProviderAttemptIds = new Set<string>();
  return async (input) => {
    if (input.resultSlot !== 'hardened-legacy') {
      throw new Error(
        input.resultSlot === 'as-shipped-legacy'
          ? 'As-shipped legacy evaluation requires its preserved baseline artifact.'
          : `Hardened legacy evaluation cannot populate result slot "${input.resultSlot}".`,
      );
    }

    const trialCollector = createTrialCollector(options.createTrialCollector, input, usedCollectors);
    const sessionAbort = new AbortController();
    const unlinkAbort = forwardAbort(input.signal, sessionAbort);
    const auditedAgentInputs: GraphBuilderEvaluationAuditSurface[] = [];
    const collect = createTrialCollectionDrainer(trialCollector, seenProviderAttemptIds);
    let agentInvocation = 0;
    let cancellationRequested = false;
    const executeAgent = async (execution: LegacyGraphBuilderAgentExecution): Promise<void> => {
      agentInvocation += 1;
      auditedAgentInputs.push({
        kind: 'source-input',
        label: `legacy-agent-input-${String(agentInvocation).padStart(4, '0')}`,
        value: {
          graphProjection: execution.graphProjection,
          request: execution.request,
        },
      });
      const pending = options.executeAgent({
        ...execution,
        abortSignal: sessionAbort.signal,
      });
      if (input.fixture.expectation.gates.cancellationRollback) {
        cancellationRequested = true;
        sessionAbort.abort('Synthetic evaluation cancellation');
      }
      await pending;
    };

    try {
      const catalog = createGraphBuilderAuthoringCatalog({
        registry: input.materialization.registry,
        project: input.materialization.project,
        referencedProjects: input.materialization.referencedProjects,
        safeSettingsAdapters: input.materialization.safeSettingsAdapters,
      });
      let result;
      try {
        result = await runLegacyGraphBuilderDraft({
          abortSignal: sessionAbort.signal,
          activeGraphId: input.materialization.activeGraphId,
          baseProject: input.materialization.project,
          catalog,
          executeAgent,
          referencedProjects: input.materialization.referencedProjects,
          registry: input.materialization.registry,
          request: input.fixture.request,
        });
      } catch (error) {
        if (cancellationRequested && sessionAbort.signal.aborted) {
          return { ...legacyEvaluationCommon(), outcome: 'canceled' };
        }
        throw error;
      }

      if (result.status === 'canceled') {
        return { ...legacyEvaluationCommon(), outcome: 'canceled' };
      }
      if (input.fixture.expectation.gates.conflictProtection && result.status === 'ready-for-preview') {
        return {
          ...legacyEvaluationCommon(),
          outcome: 'conflicted',
          conflict: { baseChanged: true, commitRejected: true },
        };
      }
      if (result.status === 'ready-for-preview') {
        Object.assign(input.materialization.project, cloneDeep(result.draft));
      }
      return { ...legacyEvaluationCommon(), outcome: 'success' };
    } catch (error) {
      input.signal.throwIfAborted();
      return {
        ...legacyEvaluationCommon(),
        outcome: 'failed',
        diagnostics: [{ code: 'evaluation-adapter-error', severity: 'error' }],
      };
    } finally {
      unlinkAbort();
    }

    function legacyEvaluationCommon() {
      const trialCollection = collect();
      return {
        cancellationRequested,
        providerAttempts: trialCollection.providerAttempts,
        requiredAuditSurfaceKinds: trialCollector.requiredAuditSurfaceKinds,
        auditedSurfaces: [...auditedAgentInputs, ...trialCollection.auditedSurfaces],
      };
    }
  };
}

/**
 * Runs checked fixtures through the same host runtime factory as the
 * production Plan B hook. The policy executor is explicit so normal tests can
 * use deterministic scripted decisions while credentialed evaluation can use
 * the real policy runner.
 */
export function createPlanBGraphBuilderEvaluationAdapter(
  options: CreatePlanBGraphBuilderEvaluationAdapterOptions,
): GraphBuilderEvaluationAdapter {
  const usedCollectors = new WeakSet<object>();
  const seenProviderAttemptIds = new Set<string>();
  return async (input) => {
    if (input.resultSlot !== 'plan-b') {
      throw new Error(`Plan B evaluation cannot populate result slot "${input.resultSlot}".`);
    }

    const trialCollector = createTrialCollector(options.createTrialCollector, input, usedCollectors);
    const collect = createTrialCollectionDrainer(trialCollector, seenProviderAttemptIds);
    const policyTurns: GraphBuilderPolicyTurn[] = [];
    const base = createEvaluationBaseIdentity(input);
    let identityMatches = true;
    let currentFingerprint = base.projectFingerprint;
    let nodeSequence = 0;
    let runtime: ReturnType<typeof createPlanBGraphBuilderSessionRuntime> | undefined;
    try {
      runtime = createPlanBGraphBuilderSessionRuntime({
        activeGraphId: input.materialization.activeGraphId,
        authoringProject: cloneDeep(input.materialization.project),
        base,
        commit: ({ draft, draftRevision, summary }) => {
          if (!identityMatches) {
            return {
              status: 'conflicted',
              commitId: `${base.projectId}:evaluation:${input.trial}`,
              currentFingerprint,
              reason: 'Synthetic evaluation identity changed before Apply.',
            };
          }
          Object.assign(input.materialization.project, cloneDeep(draft));
          return {
            status: 'committed',
            commitId: `${base.projectId}:evaluation:${input.trial}`,
            draftRevision,
            summary,
          };
        },
        executePolicy: async (turn, abortSignal) => {
          policyTurns.push(cloneDeep(turn));
          return options.executePolicy(turn, {
            fixture: input.fixture,
            trial: input.trial,
            abortSignal,
          });
        },
        idGenerator: () => `evaluation-${input.fixture.id}-${input.trial}-node-${(nodeSequence += 1)}` as never,
        mutableBoundaryGraphIds: isSyntheticTransientCanvas(input) ? [input.materialization.activeGraphId] : [],
        projectDataManifest: [],
        referencedProjects: input.materialization.referencedProjects,
        registry: input.materialization.registry,
        request: input.fixture.request,
        safeSettingsAdapters: input.materialization.safeSettingsAdapters,
        sessionId: `evaluation-${input.fixture.id}-${input.trial}`,
        verifyIdentity: () => ({
          matches: identityMatches,
          currentFingerprint,
        }),
      });
    } catch (error) {
      input.signal.throwIfAborted();
      const trialCollection = collect();
      return {
        outcome: 'failed',
        diagnostics: [{ code: 'evaluation-adapter-error', severity: 'error' }],
        providerAttempts: trialCollection.providerAttempts,
        requiredAuditSurfaceKinds: trialCollector.requiredAuditSurfaceKinds,
        auditedSurfaces: trialCollection.auditedSurfaces,
      };
    }

    let cancellationRequested = false;
    const unsubscribe = runtime.controller.subscribe((state) => {
      if (
        input.fixture.expectation.gates.cancellationRollback &&
        !cancellationRequested &&
        'policyAttempts' in state &&
        state.policyAttempts >= 1
      ) {
        cancellationRequested = true;
        void runtime.controller.cancel();
      }
    });

    try {
      await runtime.controller.start();
      let state = runtime.controller.getState();
      if (input.fixture.expectation.gates.cancellationRollback) {
        cancellationRequested = true;
        await runtime.controller.cancel();
        state = runtime.controller.getState();
      } else if (input.fixture.expectation.gates.conflictProtection && state.status === 'ready-for-preview') {
        identityMatches = false;
        currentFingerprint = hashCanonicalGraphBuilderValue({
          base: base.projectFingerprint,
          fixture: input.fixture.id,
          trial: input.trial,
          simulatedExternalChange: true,
        });
        await runtime.controller.apply();
        state = runtime.controller.getState();
      } else if (state.status === 'ready-for-preview') {
        await runtime.controller.apply();
        state = runtime.controller.getState();
      }

      const result = mapPlanBStateToEvaluationResult(input, state, runtime.getDraft());
      const trialCollection = collect();
      return {
        ...result,
        cancellationRequested,
        providerAttempts: trialCollection.providerAttempts,
        requiredAuditSurfaceKinds: trialCollector.requiredAuditSurfaceKinds,
        auditedSurfaces: [
          ...policyTurns.map((turn, index) => ({
            kind: 'source-input' as const,
            label: `policy-turn-${String(index + 1).padStart(4, '0')}`,
            value: turn,
          })),
          ...trialCollection.auditedSurfaces,
        ],
      };
    } catch (error) {
      input.signal.throwIfAborted();
      const trialCollection = collect();
      return {
        outcome: 'failed',
        diagnostics: [{ code: 'evaluation-adapter-error', severity: 'error' }],
        cancellationRequested,
        providerAttempts: trialCollection.providerAttempts,
        requiredAuditSurfaceKinds: trialCollector.requiredAuditSurfaceKinds,
        auditedSurfaces: [
          ...policyTurns.map((turn, index) => ({
            kind: 'source-input' as const,
            label: `policy-turn-${String(index + 1).padStart(4, '0')}`,
            value: turn,
          })),
          ...trialCollection.auditedSurfaces,
        ],
      };
    } finally {
      unsubscribe();
      const state = runtime.controller.getState();
      if (!isGraphBuilderTerminalViewState(state)) {
        await runtime.controller.discard();
      }
    }
  };
}

function mapPlanBStateToEvaluationResult(
  input: GraphBuilderEvaluationAdapterInput,
  state: GraphBuilderSessionViewState,
  draft: GraphBuilderAuthoringProject,
): GraphBuilderEvaluationAdapterResult {
  if (state.status === 'ready-for-preview') {
    return {
      outcome: 'success',
      graph: cloneDeep(draft.graphs[input.materialization.activeGraphId] ?? null),
      diagnostics: evaluationDiagnostics(state.preview.diagnostics),
    };
  }
  if (state.status === 'awaiting-user') {
    return { outcome: 'clarified' };
  }
  if (!isGraphBuilderTerminalViewState(state)) {
    return {
      outcome: 'failed',
      diagnostics: [{ code: `unexpected-${state.status}`, severity: 'error' }],
    };
  }

  switch (state.result.status) {
    case 'committed':
    case 'no-change':
      return {
        outcome: 'success',
        diagnostics: state.retainedPreview ? evaluationDiagnostics(state.retainedPreview.diagnostics) : [],
      };
    case 'cannot-complete':
      return {
        outcome: 'unsupported',
        diagnostics: [{ code: state.result.code, severity: 'info' }],
      };
    case 'canceled':
    case 'discarded':
      return { outcome: 'canceled' };
    case 'conflicted':
      return {
        outcome: 'conflicted',
        conflict: { baseChanged: true, commitRejected: true },
      };
    case 'failed':
      return {
        outcome: 'failed',
        diagnostics: evaluationDiagnostics(state.result.diagnostics),
      };
    case 'budget-exhausted':
      return {
        outcome: 'failed',
        diagnostics: [
          ...evaluationDiagnostics(state.result.diagnostics),
          { code: 'budget-exhausted', severity: 'error' },
        ],
      };
    case 'expired':
      return {
        outcome: 'failed',
        diagnostics: [{ code: 'session-expired', severity: 'error' }],
      };
  }
}

function evaluationDiagnostics(
  diagnostics: readonly GraphDiagnostic[],
): NonNullable<GraphBuilderEvaluationAdapterResult['diagnostics']> {
  return diagnostics.map((diagnostic) => ({
    code: diagnostic.ruleId,
    severity: diagnostic.severity,
  }));
}

function createEvaluationBaseIdentity(input: GraphBuilderEvaluationAdapterInput): GraphBuilderBaseIdentity {
  const projectCanonicalIdentity = canonicalGraphBuilderAuthoringStringify(input.materialization.project);
  const referencedProjectsCanonicalIdentity = canonicalGraphBuilderAuthoringStringify(
    input.materialization.referencedProjects,
  );
  const registryContractCanonicalIdentity = canonicalGraphBuilderAuthoringStringify({
    nodeTypes: [...input.materialization.registry.getNodeTypes()].sort(),
    safeSettingsAdapters: Object.keys(input.materialization.safeSettingsAdapters).sort(),
  });
  const projectId = input.materialization.project.metadata.id;
  if (!projectId) {
    throw new Error(`Evaluation fixture "${input.fixture.id}" has no project ID.`);
  }

  return {
    activeGraphId: input.materialization.activeGraphId,
    editorRevision: 0,
    policyConfigFingerprint: hashCanonicalGraphBuilderValue({
      mode: 'evaluation',
      resultSlot: input.resultSlot,
    }),
    projectCanonicalIdentity,
    projectFingerprint: hashGraphBuilderString(projectCanonicalIdentity),
    projectId,
    protocolVersion: GRAPH_BUILDER_PROTOCOL_VERSION,
    referencedProjectsCanonicalIdentity,
    referencedProjectsFingerprint: hashGraphBuilderString(referencedProjectsCanonicalIdentity),
    registryContractCanonicalIdentity,
    registryContractFingerprint: hashGraphBuilderString(registryContractCanonicalIdentity),
    validationRulesVersion: GRAPH_BUILDER_VALIDATION_RULES_VERSION,
  };
}

function isSyntheticTransientCanvas(input: GraphBuilderEvaluationAdapterInput): boolean {
  const graph = input.materialization.project.graphs[input.materialization.activeGraphId];
  return graph?.nodes.length === 0 && graph.connections.length === 0;
}

function forwardAbort(source: AbortSignal, target: AbortController): () => void {
  const abort = (): void => target.abort(source.reason);
  if (source.aborted) {
    abort();
    return () => undefined;
  }
  source.addEventListener('abort', abort, { once: true });
  return () => source.removeEventListener('abort', abort);
}

const EMPTY_TRIAL_COLLECTOR: GraphBuilderEvaluationTrialCollector = Object.freeze({
  requiredAuditSurfaceKinds: [],
  takeAuditedSurfaces: () => [],
  takeProviderAttempts: () => [],
});

function createTrialCollector(
  factory: ((input: GraphBuilderEvaluationAdapterInput) => GraphBuilderEvaluationTrialCollector) | undefined,
  input: GraphBuilderEvaluationAdapterInput,
  usedCollectors: WeakSet<object>,
): GraphBuilderEvaluationTrialCollector {
  if (!factory) {
    return EMPTY_TRIAL_COLLECTOR;
  }
  const collector = factory(input);
  if (usedCollectors.has(collector)) {
    throw new Error('Graph Builder evaluation trial collectors must not be reused across fixture trials.');
  }
  usedCollectors.add(collector);
  return collector;
}

function takeTrialCollection(
  collector: GraphBuilderEvaluationTrialCollector,
  seenProviderAttemptIds: Set<string>,
): Readonly<{
  auditedSurfaces: readonly GraphBuilderEvaluationAuditSurface[];
  providerAttempts: readonly GraphBuilderProviderAttempt[];
}> {
  const providerAttempts = cloneDeep(collector.takeProviderAttempts());
  for (const attempt of providerAttempts) {
    if (seenProviderAttemptIds.has(attempt.attemptId)) {
      throw new Error(`Provider attempt "${attempt.attemptId}" was returned by more than one evaluation trial.`);
    }
    seenProviderAttemptIds.add(attempt.attemptId);
  }
  return {
    providerAttempts,
    auditedSurfaces: [...collector.takeAuditedSurfaces()],
  };
}

function createTrialCollectionDrainer(
  collector: GraphBuilderEvaluationTrialCollector,
  seenProviderAttemptIds: Set<string>,
): () => ReturnType<typeof takeTrialCollection> {
  let drained = false;
  let collection: ReturnType<typeof takeTrialCollection> | undefined;
  let drainError: unknown;

  return () => {
    if (collection) {
      return collection;
    }
    if (drained) {
      throw drainError;
    }
    drained = true;
    try {
      collection = takeTrialCollection(collector, seenProviderAttemptIds);
      return collection;
    } catch (error) {
      drainError = error;
      throw error;
    }
  };
}
