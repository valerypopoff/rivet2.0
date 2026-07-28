import {
  type GraphId,
  type NodeId,
  type NodeRegistration,
  type Project,
  type ProjectId,
} from '@valerypopoff/rivet2-core';
import {
  calculateGraphBuilderDraftDelta,
  graphBuilderStringTupleKey,
  type GraphBuilderTouchedScope,
  type GraphDiagnostic,
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
import { createVirtualGraphWorkspace } from './virtualGraphWorkspace.js';

type AuthoringProject = Omit<Project, 'data'>;

export type CreatePlanBGraphBuilderSessionRuntimeOptions = {
  activeGraphId: GraphId;
  authoringPreferences?: Readonly<{
    applyDefaultNodeColors: boolean;
  }>;
  authoringProject: AuthoringProject;
  base: GraphBuilderBaseIdentity;
  commit(input: { draft: AuthoringProject; draftRevision: number; summary: string }): GraphBuilderCommitOutcome;
  executePolicy(
    turn: GraphBuilderPolicyTurn,
    abortSignal: AbortSignal,
    reportActivity: () => void,
  ): Promise<GraphBuilderPolicyExecutionResult>;
  /** @deprecated Virtual-document patches carry graph-local node IDs directly. */
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
    // Existing graph interfaces remain stable so an edit cannot silently
    // invalidate callers. The virtual workspace may add new optional surface
    // to any graph; only transient canvases retain fully mutable boundaries.
    additiveBoundaryGraphIds: Object.keys(options.authoringProject.graphs) as GraphId[],
    mutableBoundaryGraphIds: options.mutableBoundaryGraphIds,
  });
  const workspace = createVirtualGraphWorkspace({
    project: options.authoringProject,
    normalizeCandidate: ({ candidate, changedGraphIds, current }) => {
      const createdNodeIds = changedGraphIds.flatMap((graphId) => {
        const existingIds = new Set(current.graphs[graphId]?.nodes.map((node) => node.id) ?? []);
        return (
          candidate.graphs[graphId]?.nodes.filter((node) => !existingIds.has(node.id)).map((node) => node.id) ?? []
        );
      });
      return semantics.normalizeCandidate({
        base: current,
        project: candidate,
        createdNodeIds,
        touchedScope: completeGraphScope(changedGraphIds, candidate),
      }).project;
    },
    validateCandidate: ({ candidate, changedGraphIds }) =>
      semantics.validateCandidate({
        base: options.authoringProject,
        candidate,
        touchedScope: completeGraphScope(changedGraphIds, candidate),
      }),
  });

  let latestDiagnostics: GraphDiagnostic[] = [];
  const kernelFacade = {
    applyDocumentPatch(input: { patchId: string; expectedDraftRevision: number; unifiedDiff: string }) {
      const result = workspace.applyDocumentPatch(input);
      const fresh = result.disposition === 'replayed' ? result.original : result;
      latestDiagnostics = [...fresh.diagnostics];
      return result;
    },
    replaceDocument(input: { patchId: string; expectedDraftRevision: number; path: string; contents: string }) {
      const result = workspace.replaceDocument(input);
      const fresh = result.disposition === 'replayed' ? result.original : result;
      latestDiagnostics = [...fresh.diagnostics];
      return result;
    },
    getDraft: () => workspace.getDraft(),
    getDraftDelta: () =>
      calculateGraphBuilderDraftDelta(options.authoringProject, workspace.getDraft(), options.activeGraphId),
    getProjectDraftDelta: () => workspace.getProjectDraftDelta(),
    getDraftRevision: () => workspace.getDraftRevision(),
    hasDraftChanges: () => workspace.hasDraftChanges(),
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
    readVirtualDocument: ({ path, startLine, lineCount, startOffset }) =>
      workspace.readDocument(path, startLine, lineCount, startOffset),
  });

  const controller = new GraphBuilderSessionController({
    sessionId: options.sessionId,
    request: options.request,
    base: options.base,
    policyVersion: options.policyVersion ?? GRAPH_BUILDER_POLICY_VERSION,
    kernel: kernelFacade,
    buildWorkspaceContext: () => workspace.getPolicyWorkspaceContext(options.activeGraphId),
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
        touchedScope: completeGraphScope(
          workspace.getProjectDraftDelta().graphDeltas.map((delta) => delta.graphId as GraphId),
          draft,
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

function completeGraphScope(graphIds: readonly GraphId[], project: AuthoringProject): GraphBuilderTouchedScope {
  const uniqueGraphIds = [...new Set(graphIds)];
  return {
    graphIds: uniqueGraphIds,
    nodeIds: uniqueGraphIds.flatMap((graphId) => project.graphs[graphId]?.nodes.map((node) => node.id) ?? []),
    connectionKeys: uniqueGraphIds.flatMap(
      (graphId) =>
        project.graphs[graphId]?.connections.map((connection) =>
          graphBuilderStringTupleKey(
            connection.outputNodeId,
            connection.outputId,
            connection.inputNodeId,
            connection.inputId,
          ),
        ) ?? [],
    ),
    operationIndices: [],
  };
}
