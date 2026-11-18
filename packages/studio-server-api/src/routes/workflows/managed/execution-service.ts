import { workflowFailure } from '../workflow-failure.js';
import { LRUCache } from 'lru-cache';
import type { ManagedWorkflowBlobStore } from './blob-store.js';
import { MAX_ENDPOINT_RELEASE_BYTES } from './endpoint-release-manifest.js';
import { loadEndpointReleaseArtifacts, readEndpointRelease } from './endpoint-release-reader.js';
import { createPreparedEndpointRelease } from './endpoint-release-runtime.js';
import { validateManagedSubgraphTarget } from './subgraph-access.js';
import { performance } from 'node:perf_hooks';
import {
  NodeDatasetProvider,
  type Project,
  type ResolvedSubgraphProject,
  type SubgraphProjectTarget,
} from '@valerypopoff/rivet2-node';
import type { Pool } from 'pg';

import { createHttpError } from '../../../utils/httpError.js';
import { normalizeWorkflowEndpointLookupName } from '../endpoint-names.js';
import { getManagedWorkflowProjectVirtualPath, resolveManagedWorkflowRelativeReference } from '../virtual-paths.js';
import {
  type ManagedWorkflowExecutionInvalidationController,
  MANAGED_WORKFLOW_EXECUTION_INVALIDATION_RETRY_LIMIT,
} from './execution-invalidation.js';
import type {
  ManagedWorkflowExecutionCache,
  ManagedRevisionMaterializationCacheEntry,
  ManagedWorkflowRunKind,
} from './execution-cache.js';
import type {
  ManagedExecutionProjectResult,
  ManagedExecutionPointerLookupResult,
  ManagedExecutionResolveSnapshot,
  ManagedExecutionRevisionRecord,
  ManagedExecutionWorkflowRecord,
  ManagedWebAppAccessPolicy,
} from './execution-types.js';

type ManagedWorkflowExecutionContext = {
  pool: Pool;
  blobStore?: ManagedWorkflowBlobStore;
  executionCache: ManagedWorkflowExecutionCache;
  executionInvalidationController: ManagedWorkflowExecutionInvalidationController;
  queries: {
    getWorkflowByRelativePath(client: Pool, relativePath: string): Promise<ManagedExecutionWorkflowRecord | null>;
    getWorkflowById(client: Pool, workflowId: string): Promise<ManagedExecutionWorkflowRecord | null>;
    getRevision(client: Pool, revisionId: string | null | undefined): Promise<ManagedExecutionRevisionRecord | null>;
    resolveExecutionPointerFromDatabase(
      client: Pool,
      runKind: ManagedWorkflowRunKind,
      lookupName: string,
    ): Promise<ManagedExecutionPointerLookupResult | null>;
    resolveWebAppAccessPolicyFromDatabase(client: Pool, lookupName: string): Promise<ManagedWebAppAccessPolicy | null>;
  };
  revisions: {
    readRevisionContents(
      revision: ManagedExecutionRevisionRecord,
    ): Promise<{ contents: string; datasetsContents: string | null }>;
  };
};

type ManagedWorkflowExecutionServiceDependencies = {
  context: ManagedWorkflowExecutionContext;
};

// Only immutable source bytes and route metadata may be shared by concurrent
// loads. Mutable project/dataset state is constructed for each caller below.
type ReadyEndpointRelease = ReturnType<typeof createPreparedEndpointRelease>;
type ManagedExecutionSource = Omit<ManagedExecutionProjectResult, 'project' | 'attachedData' | 'datasetProvider' | 'frozenReferences'> & {
  release?: ReadyEndpointRelease;
  workflowId: string;
  materialization: ManagedRevisionMaterializationCacheEntry;
};

export class ManagedWorkflowExecutionService {
  readonly #pool: Pool;
  readonly #blobStore?: ManagedWorkflowBlobStore;
  readonly #readyReleases = new LRUCache<string, ReadyEndpointRelease>({
    max: 128, maxSize: MAX_ENDPOINT_RELEASE_BYTES, sizeCalculation: (entry) => entry.bytes,
  });
  readonly #releaseLoads = new Map<string, Promise<ReadyEndpointRelease>>();
  readonly #executionCache: ManagedWorkflowExecutionCache;
  readonly #invalidationController: ManagedWorkflowExecutionInvalidationController;
  readonly #getWorkflowByRelativePath: (
    client: Pool,
    relativePath: string,
  ) => Promise<ManagedExecutionWorkflowRecord | null>;
  readonly #getWorkflowById: (client: Pool, workflowId: string) => Promise<ManagedExecutionWorkflowRecord | null>;
  readonly #getRevision: (
    client: Pool,
    revisionId: string | null | undefined,
  ) => Promise<ManagedExecutionRevisionRecord | null>;
  readonly #readRevisionContents: (
    revision: ManagedExecutionRevisionRecord,
  ) => Promise<{ contents: string; datasetsContents: string | null }>;
  readonly #resolveExecutionPointerFromDatabase: (
    client: Pool,
    runKind: ManagedWorkflowRunKind,
    lookupName: string,
  ) => Promise<ManagedExecutionPointerLookupResult | null>;
  readonly #resolveWebAppAccessPolicyFromDatabase: (
    client: Pool,
    lookupName: string,
  ) => Promise<ManagedWebAppAccessPolicy | null>;
  readonly #endpointLoadInflight = new Map<string, Promise<ManagedExecutionSource | null>>();
  readonly #revisionMaterializationInflight = new Map<string, Promise<ManagedRevisionMaterializationCacheEntry>>();

  constructor(dependencies: ManagedWorkflowExecutionServiceDependencies) {
    this.#pool = dependencies.context.pool;
    this.#blobStore = dependencies.context.blobStore;
    this.#executionCache = dependencies.context.executionCache;
    this.#invalidationController = dependencies.context.executionInvalidationController;
    this.#getWorkflowByRelativePath = dependencies.context.queries.getWorkflowByRelativePath;
    this.#getWorkflowById = dependencies.context.queries.getWorkflowById;
    this.#getRevision = dependencies.context.queries.getRevision;
    this.#readRevisionContents = (revision) => dependencies.context.revisions.readRevisionContents(revision);
    this.#resolveExecutionPointerFromDatabase = dependencies.context.queries.resolveExecutionPointerFromDatabase;
    this.#resolveWebAppAccessPolicyFromDatabase = dependencies.context.queries.resolveWebAppAccessPolicyFromDatabase;
  }

  async loadPublishedExecutionProject(
    endpointName: string,
    requireFreshPointer = false,
  ): Promise<ManagedExecutionProjectResult | null> {
    return this.#loadExecutionProjectByEndpoint('published', endpointName, requireFreshPointer);
  }

  async loadLatestExecutionProject(
    endpointName: string,
    requireFreshPointer = false,
  ): Promise<ManagedExecutionProjectResult | null> {
    return this.#loadExecutionProjectByEndpoint('latest', endpointName, requireFreshPointer);
  }

  async loadPublishedWebAppExecutionProject(slug: string): Promise<ManagedExecutionProjectResult | null> {
    return this.#loadExecutionProjectByEndpoint('web-app', slug);
  }

  async loadLatestWebAppExecutionProject(slug: string): Promise<ManagedExecutionProjectResult | null> {
    return this.#loadExecutionProjectByEndpoint('latest-web-app', slug);
  }

  async resolveWebAppAccessPolicy(slug: string): Promise<ManagedWebAppAccessPolicy | null> {
    return this.#resolveWebAppAccessPolicyFromDatabase(this.#pool, normalizeWorkflowEndpointLookupName(slug));
  }

  createProjectReferenceLoader() {
    const service = this;

    return {
      async loadProject(
        currentProjectPath: string | undefined,
        reference: { id: string; hintPaths?: string[]; title?: string },
      ) {
        if (!currentProjectPath) {
          throw new Error(
            `Could not load project "${reference.title ?? reference.id}" because the current project path is missing.`,
          );
        }

        for (const hintPath of reference.hintPaths ?? []) {
          let relativePath: string;
          try {
            relativePath = resolveManagedWorkflowRelativeReference(currentProjectPath, hintPath);
          } catch {
            continue;
          }

          const project = await service.#loadExecutionReferencedProjectByRelativePath(relativePath, reference.id);
          if (project) {
            return project;
          }
        }

        const workflowById = await service.#loadExecutionReferencedProjectById(reference.id);
        if (workflowById) {
          return workflowById;
        }

        throw new Error(
          `Could not load project "${reference.title ?? reference.id} (${reference.id})": all hint paths failed.`,
        );
      },
    };
  }

  async loadSubgraphTarget(
    target: SubgraphProjectTarget,
    remainingRetries = MANAGED_WORKFLOW_EXECUTION_INVALIDATION_RETRY_LIMIT,
  ): Promise<ResolvedSubgraphProject> {
    if (target.callerProjectId) await validateManagedSubgraphTarget(this.#pool, target);
    const resolveSnapshot = this.#invalidationController.captureResolveSnapshot();
    const workflow = await this.#getWorkflowById(this.#pool, target.projectId);
    if (!workflow) throw createHttpError(404, `Subgraph project ${target.projectId} was not found.`);
    if (this.#invalidationController.shouldRetryAfterResolve(resolveSnapshot, workflow.workflow_id)) {
      if (remainingRetries > 0) return this.loadSubgraphTarget(target, remainingRetries - 1);
      throw createHttpError(503, 'Subgraph project changed while loading. Retry the run.');
    }
    const revisionId =
      target.version === 'published' ? workflow.published_revision_id : workflow.current_draft_revision_id;
    if (!revisionId) {
      throw workflowFailure(
        target.version === 'published' ? 'workflow_publication_missing' : 'workflow_state_changed',
        `Subgraph project ${target.projectId} has no ${target.version} version.`,
      );
    }
    const workflowSnapshot = this.#invalidationController.captureWorkflowSnapshot(workflow.workflow_id);
    this.#invalidationController.beginWorkflowLoad(workflow.workflow_id);
    try {
      const materialization = await this.#getOrLoadRevisionMaterialization(revisionId, null);
      if (
        this.#invalidationController.shouldRetryAfterMaterialize(
          resolveSnapshot,
          workflow.workflow_id,
          workflowSnapshot,
        )
      ) {
        if (remainingRetries > 0) return this.loadSubgraphTarget(target, remainingRetries - 1);
        throw createHttpError(503, 'Subgraph project changed while loading. Retry the run.');
      }
      const { project, datasets } = this.#executionCache.parsedDefinitions.materialize(materialization);
      if (project.metadata.id !== target.projectId) {
        throw createHttpError(500, `Subgraph project ${target.projectId} has a mismatched saved identity.`);
      }
      return {
        project,
        datasetProvider: new NodeDatasetProvider(datasets),
        revisionKey: `managed:${revisionId}`,
        projectContents: materialization.contents,
        datasetsContents: materialization.datasetsContents ?? undefined,
        sourceProjectPath: getManagedWorkflowProjectVirtualPath(workflow.relative_path),
      };
    } finally {
      this.#invalidationController.endWorkflowLoad(workflow.workflow_id);
    }
  }

  async #loadExecutionProjectByEndpoint(
    runKind: ManagedWorkflowRunKind,
    endpointName: string,
    requireFreshPointer = false,
  ): Promise<ManagedExecutionProjectResult | null> {
    const lookupName = normalizeWorkflowEndpointLookupName(endpointName);
    if (requireFreshPointer) {
      // A request arriving after an access change must not join a lookup that
      // began before the commit, even if cache invalidation is still in flight.
      return this.#materializeExecutionProject(
        await this.#loadExecutionProjectByEndpointOnce(runKind, lookupName, {
          forceBypassPointerCache: true,
        }),
      );
    }
    const endpointCacheKey = `${runKind}:${lookupName}`;
    const resolveSnapshot = this.#invalidationController.captureResolveSnapshot();
    const endpointLoadInflightKey = `${endpointCacheKey}:${resolveSnapshot.anyGeneration}`;
    const existingLoad = this.#endpointLoadInflight.get(endpointLoadInflightKey);
    if (existingLoad) {
      return this.#materializeExecutionProject(await existingLoad);
    }

    const loadPromise = this.#loadExecutionProjectByEndpointOnce(runKind, lookupName).finally(() => {
      this.#endpointLoadInflight.delete(endpointLoadInflightKey);
    });
    this.#endpointLoadInflight.set(endpointLoadInflightKey, loadPromise);
    return this.#materializeExecutionProject(await loadPromise);
  }

  #materializeExecutionProject(source: ManagedExecutionSource | null): ManagedExecutionProjectResult | null {
    if (!source) return null;
    const startedAt = performance.now();
    const { workflowId, materialization, release, ...metadata } = source;
    const { project, attachedData, datasets } = this.#executionCache.parsedDefinitions.materialize(materialization);
    if (project.metadata.id !== workflowId) {
      throw createHttpError(500, 'Execution project artifact has a mismatched saved identity.');
    }
    const detachedMetadata = structuredClone(metadata);
    detachedMetadata.debug.materializeMs += Math.max(0, Math.round(performance.now() - startedAt));
    return {
      ...detachedMetadata, project, attachedData, datasetProvider: new NodeDatasetProvider(datasets),
      ...(release ? { frozenReferences: release.createRunReferences(this.#executionCache.parsedDefinitions) } : {}),
    };
  }

  async #loadExecutionProjectByEndpointOnce(
    runKind: ManagedWorkflowRunKind,
    lookupName: string,
    options: {
      forceBypassPointerCache?: boolean;
      allowPointerFallback?: boolean;
      remainingInvalidationRetries?: number;
    } = {},
  ): Promise<ManagedExecutionSource | null> {
    const remainingInvalidationRetries =
      options.remainingInvalidationRetries ?? MANAGED_WORKFLOW_EXECUTION_INVALIDATION_RETRY_LIMIT;
    const resolveSnapshot = this.#invalidationController.captureResolveSnapshot();
    const resolveStartedAt = performance.now();
    const endpointCacheKey = `${runKind}:${lookupName}`;
    const canUsePointerCache = this.#invalidationController.isPointerCacheHealthy() && !options.forceBypassPointerCache;
    const cachedPointer = canUsePointerCache ? this.#executionCache.getEndpointPointer(endpointCacheKey) : null;
    let pointer = cachedPointer;
    let revision: ManagedExecutionRevisionRecord | null = null;
    let workflowSnapshot = cachedPointer
      ? this.#invalidationController.captureWorkflowSnapshot(cachedPointer.workflowId)
      : null;
    const cacheStatus = cachedPointer
      ? 'hit'
      : this.#invalidationController.isPointerCacheHealthy() && !options.forceBypassPointerCache
        ? 'miss'
        : 'bypass';

    if (!pointer) {
      const resolved = await this.#resolveExecutionPointerFromDatabase(this.#pool, runKind, lookupName);
      if (!resolved) {
        if (
          this.#invalidationController.shouldRetryAfterResolve(resolveSnapshot, null) &&
          remainingInvalidationRetries > 0
        ) {
          return this.#loadExecutionProjectByEndpointOnce(runKind, lookupName, {
            forceBypassPointerCache: true,
            remainingInvalidationRetries: remainingInvalidationRetries - 1,
          });
        }

        return null;
      }

      pointer = resolved.pointer;
      revision = resolved.revision;
      workflowSnapshot = this.#invalidationController.captureWorkflowSnapshot(pointer.workflowId);

      if (this.#invalidationController.shouldRetryAfterResolve(resolveSnapshot, pointer.workflowId)) {
        if (remainingInvalidationRetries > 0) {
          return this.#loadExecutionProjectByEndpointOnce(runKind, lookupName, {
            forceBypassPointerCache: true,
            remainingInvalidationRetries: remainingInvalidationRetries - 1,
          });
        }

        throw createHttpError(503, 'Workflow endpoint changed while loading. Retry the request.');
      }

      if (canUsePointerCache) {
        this.#executionCache.setEndpointPointer(endpointCacheKey, pointer);
      }
    }

    const resolveMs = Math.max(0, Math.round(performance.now() - resolveStartedAt));
    this.#invalidationController.beginWorkflowLoad(pointer.workflowId);
    try {
      const materializeStartedAt = performance.now();

      const release = pointer.releaseId
        ? await this.#loadReadyRelease(pointer.releaseId, pointer.workflowId, pointer.revisionId)
        : undefined;
      let materialization: ManagedRevisionMaterializationCacheEntry;
      try {
        materialization = release?.root ?? (await this.#getOrLoadRevisionMaterialization(pointer.revisionId, revision));
      } catch (error) {
        const isMissingRevision =
          typeof error === 'object' &&
          error != null &&
          'status' in error &&
          Number((error as { status?: unknown }).status) === 404;

        if (cachedPointer && options.allowPointerFallback !== false && isMissingRevision) {
          this.#invalidationController.markWorkflowChanged(pointer.workflowId);
          return this.#loadExecutionProjectByEndpointOnce(runKind, lookupName, {
            forceBypassPointerCache: true,
            allowPointerFallback: false,
            remainingInvalidationRetries,
          });
        }

        throw error;
      }

      const retryAfterMaterialize = this.#retryAfterMaterialize(
        resolveSnapshot,
        pointer.workflowId,
        workflowSnapshot,
        remainingInvalidationRetries,
        (nextRetries) =>
          this.#loadExecutionProjectByEndpointOnce(runKind, lookupName, {
            forceBypassPointerCache: true,
            remainingInvalidationRetries: nextRetries,
          }),
        'Workflow endpoint changed while loading. Retry the request.',
      );
      if (retryAfterMaterialize) {
        return retryAfterMaterialize;
      }

      return {
        workflowId: pointer.workflowId,
        materialization,
        release,
        projectVirtualPath: getManagedWorkflowProjectVirtualPath(pointer.relativePath),
        revisionKey: `managed:${pointer.revisionId}`,
        endpointAccess: pointer.endpointAccess,
        webAppUiGraphId: pointer.webAppUiGraphId,
        webAppAllowedEmails: pointer.webAppAllowedEmails,
        webAppBindingId: pointer.webAppId == null ? undefined : `managed:${pointer.webAppId}`,
        webAppPolicyInvalidationKey: pointer.webAppId == null ? undefined : `managed:${pointer.workflowId}`,
        debug: {
          cacheStatus,
          resolveMs,
          materializeMs: Math.max(0, Math.round(performance.now() - materializeStartedAt)),
        },
      };
    } finally {
      this.#invalidationController.endWorkflowLoad(pointer.workflowId);
    }
  }

  async #loadReadyRelease(releaseId: string, workflowId: string, revisionId: string) {
    const cached = this.#readyReleases.get(releaseId);
    if (cached && cached.root.revisionId === revisionId && cached.projectId === workflowId) return cached;
    const key = JSON.stringify([releaseId, workflowId, revisionId]);
    const pending = this.#releaseLoads.get(key);
    if (pending) return pending;
    // Full captures are larger than the old pre-admission root read. Bound
    // distinct cold loads while allowing duplicate requests to share one.
    if (this.#releaseLoads.size >= 4)
      throw createHttpError(503, 'Captured endpoint revisions are busy loading. Try again shortly.');
    const blobStore = this.#blobStore;
    if (!blobStore) throw createHttpError(503, 'This server cannot read the captured endpoint revision.');
    const load = (async () => {
      const stored = await readEndpointRelease(this.#pool, releaseId, workflowId, revisionId);
      const release = createPreparedEndpointRelease(stored, await loadEndpointReleaseArtifacts({ blobStore }, stored));
      this.#readyReleases.set(releaseId, release);
      return release;
    })().finally(() => this.#releaseLoads.delete(key));
    this.#releaseLoads.set(key, load);
    return load;
  }

  #retryAfterMaterialize<T>(
    resolveSnapshot: ManagedExecutionResolveSnapshot,
    workflowId: string,
    workflowSnapshot: ReturnType<ManagedWorkflowExecutionInvalidationController['captureWorkflowSnapshot']> | null,
    remainingInvalidationRetries: number,
    retry: (nextRetries: number) => Promise<T>,
    errorMessage: string,
  ): Promise<T> | null {
    if (
      !workflowSnapshot ||
      !this.#invalidationController.shouldRetryAfterMaterialize(resolveSnapshot, workflowId, workflowSnapshot)
    ) {
      return null;
    }

    if (remainingInvalidationRetries > 0) {
      return retry(remainingInvalidationRetries - 1);
    }

    throw createHttpError(503, errorMessage);
  }

  async #getOrLoadRevisionMaterialization(
    revisionId: string,
    knownRevision: ManagedExecutionRevisionRecord | null,
  ): Promise<ManagedRevisionMaterializationCacheEntry> {
    const cached = this.#executionCache.getRevisionMaterialization(revisionId);
    if (cached) {
      return cached;
    }

    const existingLoad = this.#revisionMaterializationInflight.get(revisionId);
    if (existingLoad) {
      return existingLoad;
    }

    const loadPromise = (async () => {
      const revision = knownRevision ?? (await this.#getRevision(this.#pool, revisionId));
      if (!revision) {
        throw createHttpError(404, 'Project revision not found');
      }

      const contents = await this.#readRevisionContents(revision);
      const materialization = {
        revisionId,
        contents: contents.contents,
        datasetsContents: contents.datasetsContents,
      } satisfies ManagedRevisionMaterializationCacheEntry;
      this.#executionCache.setRevisionMaterialization(materialization);
      return materialization;
    })().finally(() => {
      this.#revisionMaterializationInflight.delete(revisionId);
    });

    this.#revisionMaterializationInflight.set(revisionId, loadPromise);
    return loadPromise;
  }

  async #loadExecutionReferencedProjectByRelativePath(
    relativePath: string,
    expectedWorkflowId: string,
  ): Promise<Project | null> {
    return this.#loadExecutionReferencedProject(
      () => this.#getWorkflowByRelativePath(this.#pool, relativePath),
      expectedWorkflowId,
    );
  }

  async #loadExecutionReferencedProjectById(workflowId: string): Promise<Project | null> {
    return this.#loadExecutionReferencedProject(() => this.#getWorkflowById(this.#pool, workflowId), workflowId);
  }

  async #loadExecutionReferencedProject(
    loadWorkflow: () => Promise<ManagedExecutionWorkflowRecord | null>,
    expectedWorkflowId: string,
    options: {
      remainingInvalidationRetries?: number;
    } = {},
  ): Promise<Project | null> {
    const remainingInvalidationRetries =
      options.remainingInvalidationRetries ?? MANAGED_WORKFLOW_EXECUTION_INVALIDATION_RETRY_LIMIT;
    const resolveSnapshot = this.#invalidationController.captureResolveSnapshot();
    const workflow = await loadWorkflow();
    if (!workflow) {
      return null;
    }

    if (this.#invalidationController.shouldRetryAfterResolve(resolveSnapshot, workflow.workflow_id)) {
      if (remainingInvalidationRetries > 0) {
        return this.#loadExecutionReferencedProject(loadWorkflow, expectedWorkflowId, {
          remainingInvalidationRetries: remainingInvalidationRetries - 1,
        });
      }

      throw createHttpError(503, 'Referenced workflow changed while loading. Retry the request.');
    }

    // A hint may now name another project after a move or path reuse. It is
    // discovery only; do not read that project's revision or bypass ID lookup.
    if (workflow.workflow_id !== expectedWorkflowId) {
      return null;
    }

    const revisionId = workflow.published_revision_id ?? workflow.current_draft_revision_id;
    if (!revisionId) {
      return null;
    }

    const workflowSnapshot = this.#invalidationController.captureWorkflowSnapshot(workflow.workflow_id);
    this.#invalidationController.beginWorkflowLoad(workflow.workflow_id);
    try {
      const materialization = await this.#getOrLoadRevisionMaterialization(revisionId, null);
      const retryAfterMaterialize = this.#retryAfterMaterialize(
        resolveSnapshot,
        workflow.workflow_id,
        workflowSnapshot,
        remainingInvalidationRetries,
        (nextRetries) =>
          this.#loadExecutionReferencedProject(loadWorkflow, expectedWorkflowId, {
            remainingInvalidationRetries: nextRetries,
          }),
        'Referenced workflow changed while loading. Retry the request.',
      );
      if (retryAfterMaterialize) {
        return retryAfterMaterialize;
      }

      const { project } = this.#executionCache.parsedDefinitions.materialize(materialization);
      if (project.metadata.id !== expectedWorkflowId) {
        throw createHttpError(500, `Referenced project ${expectedWorkflowId} has a mismatched saved identity.`);
      }

      return project;
    } finally {
      this.#invalidationController.endWorkflowLoad(workflow.workflow_id);
    }
  }
}
