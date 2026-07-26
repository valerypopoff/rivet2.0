import {
  newId,
  type GraphId,
  type NodeConnection,
  type NodeId,
  type NodeRegistration,
  type Project,
  type ProjectId,
} from '@valerypopoff/rivet2-core';
import {
  GraphBuilderTransactionKernel,
  graphBuilderStringTupleKey,
  type ApplyPatchResult,
  type GraphBuilderTouchedScope,
  type GraphDiagnostic,
  type GraphPatch,
} from '../../domain/graphBuilder/index.js';
import { createAppGraphBuilderAuthoringSemantics } from './authoringSemantics.js';
import { createGraphBuilderAuthoringCatalog, type GraphBuilderNodeAuthoringAdapter } from './authoringCatalog.js';
import type { GraphBuilderCommitOutcome } from './editorGateway.js';
import type { GraphBuilderProjectDataManifestEntry } from './editorSnapshot.js';
import type { GraphBuilderBaseIdentity } from './identity.js';
import { GRAPH_BUILDER_POLICY_VERSION } from './policyManifest.js';
import { buildGraphBuilderProjection, createGraphBuilderReadExecutor } from './readExecutor.js';
import {
  GraphBuilderSessionController,
  type GraphBuilderMetricsSink,
  type GraphBuilderPolicyExecutionResult,
  type GraphBuilderPolicyTurn,
  type GraphBuilderSessionLimits,
} from './sessionController.js';

type AuthoringProject = Omit<Project, 'data'>;

const ALLOWED_PLAN_B_OPERATIONS = [
  'createNode',
  'updateNodeSettings',
  'updateNodeEnvelope',
  'deleteNode',
  'connect',
  'disconnect',
] as const;

export type CreatePlanBGraphBuilderSessionRuntimeOptions = {
  activeGraphId: GraphId;
  authoringPreferences?: Readonly<{
    applyDefaultNodeColors: boolean;
  }>;
  authoringProject: AuthoringProject;
  base: GraphBuilderBaseIdentity;
  commit(input: { draft: AuthoringProject; draftRevision: number; summary: string }): GraphBuilderCommitOutcome;
  executePolicy(turn: GraphBuilderPolicyTurn, abortSignal: AbortSignal): Promise<GraphBuilderPolicyExecutionResult>;
  idGenerator?: () => NodeId;
  limits?: Partial<GraphBuilderSessionLimits>;
  metricsSink?: GraphBuilderMetricsSink;
  mutableBoundaryGraphIds?: readonly GraphId[];
  policyVersion?: string;
  projectDataManifest?: readonly GraphBuilderProjectDataManifestEntry[];
  referencedProjects: Record<ProjectId, Project>;
  registry: NodeRegistration<any, any>;
  request: string;
  safeSettingsAdapters?: Readonly<Record<string, GraphBuilderNodeAuthoringAdapter>>;
  sessionId?: string;
  verifyIdentity(): {
    matches: boolean;
    currentFingerprint: string;
  };
};

export type PlanBGraphBuilderSessionRuntime = Readonly<{
  controller: GraphBuilderSessionController;
  getDraft(): AuthoringProject;
  getDraftRevision(): number;
}>;

/**
 * Constructs the host-owned Plan B runtime without React, Jotai, credentials,
 * or provider selection. Production and evaluation both use this seam; callers
 * own policy transport, current-identity checks, and the authoritative commit.
 */
export function createPlanBGraphBuilderSessionRuntime(
  options: CreatePlanBGraphBuilderSessionRuntimeOptions,
): PlanBGraphBuilderSessionRuntime {
  const catalog = createGraphBuilderAuthoringCatalog({
    registry: options.registry,
    project: options.authoringProject,
    referencedProjects: options.referencedProjects,
    safeSettingsAdapters: options.safeSettingsAdapters,
    authoringPreferences: options.authoringPreferences,
  });
  const semantics = createAppGraphBuilderAuthoringSemantics({
    registry: options.registry,
    catalog,
    referencedProjects: options.referencedProjects,
    mutableBoundaryGraphIds: options.mutableBoundaryGraphIds,
  });
  const kernel = new GraphBuilderTransactionKernel({
    project: options.authoringProject,
    activeGraphId: options.activeGraphId,
    authorization: {
      allowedGraphIds: [options.activeGraphId],
      allowedOperations: [...ALLOWED_PLAN_B_OPERATIONS],
      allowSemanticCrossGraphPropagation: false,
      sensitiveFieldAccess: 'none',
    },
    semantics,
    idGenerator: options.idGenerator ?? (() => newId() as NodeId),
  });

  let latestDiagnostics: GraphDiagnostic[] = [];
  const kernelFacade = {
    applyPatch(patch: GraphPatch): ApplyPatchResult {
      const result = kernel.applyPatch(patch);
      const fresh = result.disposition === 'replayed' ? result.original : result;
      latestDiagnostics = [...fresh.diagnostics];
      return result;
    },
    getDraft: () => kernel.getDraft(),
    getDraftDelta: () => kernel.getDraftDelta(),
    getDraftRevision: () => kernel.getDraftRevision(),
    hasDraftChanges: () => kernel.hasDraftChanges(),
  };
  const readExecutor = createGraphBuilderReadExecutor({
    activeGraphId: options.activeGraphId,
    projectDataContext: {
      manifest: [...(options.projectDataManifest ?? [])],
    },
    catalog,
    semantics,
    getDraft: kernelFacade.getDraft,
    getDraftRevision: kernelFacade.getDraftRevision,
    getDiagnostics: () => latestDiagnostics,
    getDraftDelta: kernelFacade.getDraftDelta,
  });

  const controller = new GraphBuilderSessionController({
    sessionId: options.sessionId,
    request: options.request,
    base: options.base,
    policyVersion: options.policyVersion ?? GRAPH_BUILDER_POLICY_VERSION,
    kernel: kernelFacade,
    buildProjection: ({ delta, diagnostics, draft, draftRevision }) =>
      buildGraphBuilderProjection({
        project: draft,
        activeGraphId: options.activeGraphId,
        draftRevision,
        catalog,
        diagnostics,
        delta,
      }),
    read: (readRequest, readContext) => readExecutor.execute(readRequest, readContext),
    executePolicy: options.executePolicy,
    validateDraft: (draft) =>
      semantics.validateCandidate({
        base: options.authoringProject,
        candidate: draft,
        touchedScope: completeActiveGraphScope(
          options.activeGraphId,
          draft.graphs[options.activeGraphId]?.nodes.map((node) => node.id) ?? [],
          draft.graphs[options.activeGraphId]?.connections ?? [],
        ),
      }),
    verifyIdentity: options.verifyIdentity,
    commit: options.commit,
    limits: options.limits,
    metricsSink: options.metricsSink,
  });

  return {
    controller,
    getDraft: kernelFacade.getDraft,
    getDraftRevision: kernelFacade.getDraftRevision,
  };
}

function completeActiveGraphScope(
  graphId: GraphId,
  nodeIds: readonly NodeId[],
  connections: readonly NodeConnection[],
): GraphBuilderTouchedScope {
  return {
    graphIds: [graphId],
    nodeIds: [...nodeIds],
    connectionKeys: connections.map((connection) =>
      graphBuilderStringTupleKey(
        connection.outputNodeId,
        connection.outputId,
        connection.inputNodeId,
        connection.inputId,
      ),
    ),
    operationIndices: [],
  };
}
