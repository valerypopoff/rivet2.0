import { performance } from 'node:perf_hooks';
import { NodeDatasetProvider, deserializeDatasets, loadProjectAndAttachedDataFromString, loadProjectFromString, type Project } from '@valerypopoff/rivet2-node';
import type { Pool } from 'pg';

import { createHttpError } from '../../../utils/httpError.js';
import { normalizeWorkflowEndpointLookupName } from '../endpoint-names.js';
import { getManagedWorkflowProjectVirtualPath, resolveManagedWorkflowRelativeReference } from '../virtual-paths.js';
import {
  ManagedWorkflowExecutionInvalidationController,
  MANAGED_WORKFLOW_EXECUTION_INVALIDATION_RETRY_LIMIT,
} from './execution-invalidation.js';
import { ManagedWorkflowExecutionCache, type ManagedRevisionMaterializationCacheEntry, type ManagedWorkflowRunKind } from './execution-cache.js';
import type {
  ManagedExecutionProjectResult,
  ManagedExecutionPointerLookupResult,
  ManagedExecutionResolveSnapshot,
  ManagedExecutionRevisionRecord,
  ManagedExecutionWorkflowRecord,
} from './execution-types.js';

type ManagedWorkflowExecutionBlobStore = {
  getText(key: string): Promise<string>;
};

type ManagedWorkflowExecutionContext = {
  pool: Pool;
  blobStore: ManagedWorkflowExecutionBlobStore;
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
  };
  revisions: {
    readRevisionContents(revision: ManagedExecutionRevisionRecord): Promise<{ contents: string; datasetsContents: string | null }>;
  };
};

type ManagedWorkflowExecutionServiceDependencies = {
  context: ManagedWorkflowExecutionContext;
};

export class ManagedWorkflowExecutionService {
  readonly #pool: Pool;
  readonly #blobStore: ManagedWorkflowExecutionBlobStore;
  readonly #executionCache: ManagedWorkflowExecutionCache;
  readonly #invalidationController: ManagedWorkflowExecutionInvalidationController;
  readonly #getWorkflowByRelativePath: (client: Pool, relativePath: string) => Promise<ManagedExecutionWorkflowRecord | null>;
  readonly #getWorkflowById: (client: Pool, workflowId: string) => Promise<ManagedExecutionWorkflowRecord | null>;
  readonly #getRevision: (client: Pool, revisionId: string | null | undefined) => Promise<ManagedExecutionRevisionRecord | null>;
  readonly #readRevisionContents: (revision: ManagedExecutionRevisionRecord) => Promise<{ contents: string; datasetsContents: string | null }>;
  readonly #resolveExecutionPointerFromDatabase: (
    client: Pool,
    runKind: ManagedWorkflowRunKind,
    lookupName: string,
  ) => Promise<ManagedExecutionPointerLookupResult | null>;
  readonly #endpointLoadInflight = new Map<string, Promise<ManagedExecutionProjectResult | null>>();
  readonly #revisionMaterializationInflight = new Map<string, Promise<ManagedRevisionMaterializationCacheEntry>>();

  constructor(dependencies: ManagedWorkflowExecutionServiceDependencies) {
    this.#pool = dependencies.context.pool;
    this.#blobStore = dependencies.context.blobStore as ManagedWorkflowExecutionBlobStore;
    this.#executionCache = dependencies.context.executionCache;
    this.#invalidationController = dependencies.context.executionInvalidationController;
    this.#getWorkflowByRelativePath = dependencies.context.queries.getWorkflowByRelativePath;
    this.#getWorkflowById = dependencies.context.queries.getWorkflowById;
    this.#getRevision = dependencies.context.queries.getRevision;
    this.#readRevisionContents = (revision) => dependencies.context.revisions.readRevisionContents(revision);
    this.#resolveExecutionPointerFromDatabase = dependencies.context.queries.resolveExecutionPointerFromDatabase;
  }

  async loadPublishedExecutionProject(endpointName: string): Promise<ManagedExecutionProjectResult | null> {
    return this.#loadExecutionProjectByEndpoint('published', endpointName);
  }

  async loadLatestExecutionProject(endpointName: string): Promise<ManagedExecutionProjectResult | null> {
    return this.#loadExecutionProjectByEndpoint('latest', endpointName);
  }

  async loadPublishedWebAppExecutionProject(slug: string): Promise<ManagedExecutionProjectResult | null> {
    return this.#loadExecutionProjectByEndpoint('web-app', slug);
  }

  async loadLatestWebAppExecutionProject(slug: string): Promise<ManagedExecutionProjectResult | null> {
    return this.#loadExecutionProjectByEndpoint('latest-web-app', slug);
  }

  createProjectReferenceLoader() {
    const service = this;

    return {
      async loadProject(currentProjectPath: string | undefined, reference: { id: string; hintPaths?: string[]; title?: string }) {
        if (!currentProjectPath) {
          throw new Error(`Could not load project "${reference.title ?? reference.id}" because the current project path is missing.`);
        }

        for (const hintPath of reference.hintPaths ?? []) {
          let relativePath: string;
          try {
            relativePath = resolveManagedWorkflowRelativeReference(currentProjectPath, hintPath);
          } catch {
            continue;
          }

          const project = await service.#loadExecutionReferencedProjectByRelativePath(relativePath);
          if (project) {
            return project;
          }
        }

        const workflowById = await service.#loadExecutionReferencedProjectById(reference.id);
        if (workflowById) {
          return workflowById;
        }

        throw new Error(`Could not load project "${reference.title ?? reference.id} (${reference.id})": all hint paths failed.`);
      },
    };
  }

  async #loadExecutionProjectByEndpoint(
    runKind: ManagedWorkflowRunKind,
    endpointName: string,
  ): Promise<ManagedExecutionProjectResult | null> {
    const lookupName = normalizeWorkflowEndpointLookupName(endpointName);
    const endpointCacheKey = `${runKind}:${lookupName}`;
    const resolveSnapshot = this.#invalidationController.captureResolveSnapshot();
    const endpointLoadInflightKey = `${endpointCacheKey}:${resolveSnapshot.anyGeneration}`;
    const existingLoad = this.#endpointLoadInflight.get(endpointLoadInflightKey);
    if (existingLoad) {
      return existingLoad;
    }

    const loadPromise = this.#loadExecutionProjectByEndpointOnce(runKind, lookupName)
      .finally(() => {
        this.#endpointLoadInflight.delete(endpointLoadInflightKey);
      });
    this.#endpointLoadInflight.set(endpointLoadInflightKey, loadPromise);
    return loadPromise;
  }

  async #loadExecutionProjectByEndpointOnce(
    runKind: ManagedWorkflowRunKind,
    lookupName: string,
    options: {
      forceBypassPointerCache?: boolean;
      allowPointerFallback?: boolean;
      remainingInvalidationRetries?: number;
    } = {},
  ): Promise<ManagedExecutionProjectResult | null> {
    const remainingInvalidationRetries = options.remainingInvalidationRetries ?? MANAGED_WORKFLOW_EXECUTION_INVALIDATION_RETRY_LIMIT;
    const resolveSnapshot = this.#invalidationController.captureResolveSnapshot();
    const resolveStartedAt = performance.now();
    const endpointCacheKey = `${runKind}:${lookupName}`;
    const canUsePointerCache = this.#invalidationController.isPointerCacheHealthy() && !options.forceBypassPointerCache;
    const cachedPointer = canUsePointerCache
      ? this.#executionCache.getEndpointPointer(endpointCacheKey)
      : null;
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
        if (this.#invalidationController.shouldRetryAfterResolve(resolveSnapshot, null) && remainingInvalidationRetries > 0) {
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

      let materialization: ManagedRevisionMaterializationCacheEntry;
      try {
        materialization = await this.#getOrLoadRevisionMaterialization(pointer.revisionId, revision);
      } catch (error) {
        const isMissingRevision = typeof error === 'object' &&
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
        (nextRetries) => this.#loadExecutionProjectByEndpointOnce(runKind, lookupName, {
          forceBypassPointerCache: true,
          remainingInvalidationRetries: nextRetries,
        }),
        'Workflow endpoint changed while loading. Retry the request.',
      );
      if (retryAfterMaterialize) {
        return retryAfterMaterialize;
      }

      const [project, attachedData] = loadProjectAndAttachedDataFromString(materialization.contents);
      const datasetProvider = new NodeDatasetProvider(
        materialization.datasetsContents ? deserializeDatasets(materialization.datasetsContents) : [],
      );

      const retryAfterProjectLoad = this.#retryAfterMaterialize(
        resolveSnapshot,
        pointer.workflowId,
        workflowSnapshot,
        remainingInvalidationRetries,
        (nextRetries) => this.#loadExecutionProjectByEndpointOnce(runKind, lookupName, {
          forceBypassPointerCache: true,
          remainingInvalidationRetries: nextRetries,
        }),
        'Workflow endpoint changed while loading. Retry the request.',
      );
      if (retryAfterProjectLoad) {
        return retryAfterProjectLoad;
      }

      return {
        project,
        attachedData,
        datasetProvider,
        projectVirtualPath: getManagedWorkflowProjectVirtualPath(pointer.relativePath),
        revisionKey: `managed:${pointer.revisionId}`,
        webAppUiGraphId: pointer.webAppUiGraphId,
        webAppAllowedEmails: pointer.webAppAllowedEmails,
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

  #retryAfterMaterialize<T>(
    resolveSnapshot: ManagedExecutionResolveSnapshot,
    workflowId: string,
    workflowSnapshot: ReturnType<ManagedWorkflowExecutionInvalidationController['captureWorkflowSnapshot']> | null,
    remainingInvalidationRetries: number,
    retry: (nextRetries: number) => Promise<T>,
    errorMessage: string,
  ): Promise<T> | null {
    if (!workflowSnapshot || !this.#invalidationController.shouldRetryAfterMaterialize(resolveSnapshot, workflowId, workflowSnapshot)) {
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
      const revision = knownRevision ?? await this.#getRevision(this.#pool, revisionId);
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
    })()
      .finally(() => {
        this.#revisionMaterializationInflight.delete(revisionId);
      });

    this.#revisionMaterializationInflight.set(revisionId, loadPromise);
    return loadPromise;
  }

  async #loadExecutionReferencedProjectByRelativePath(
    relativePath: string,
    options: {
      remainingInvalidationRetries?: number;
    } = {},
  ): Promise<Project | null> {
    return this.#loadExecutionReferencedProject(
      () => this.#getWorkflowByRelativePath(this.#pool, relativePath),
      options,
    );
  }

  async #loadExecutionReferencedProjectById(
    workflowId: string,
    options: {
      remainingInvalidationRetries?: number;
    } = {},
  ): Promise<Project | null> {
    return this.#loadExecutionReferencedProject(
      () => this.#getWorkflowById(this.#pool, workflowId),
      options,
    );
  }

  async #loadExecutionReferencedProject(
    loadWorkflow: () => Promise<ManagedExecutionWorkflowRecord | null>,
    options: {
      remainingInvalidationRetries?: number;
    } = {},
  ): Promise<Project | null> {
    const remainingInvalidationRetries = options.remainingInvalidationRetries ?? MANAGED_WORKFLOW_EXECUTION_INVALIDATION_RETRY_LIMIT;
    const resolveSnapshot = this.#invalidationController.captureResolveSnapshot();
    const workflow = await loadWorkflow();
    if (!workflow) {
      return null;
    }

    if (this.#invalidationController.shouldRetryAfterResolve(resolveSnapshot, workflow.workflow_id)) {
      if (remainingInvalidationRetries > 0) {
        return this.#loadExecutionReferencedProject(loadWorkflow, {
          remainingInvalidationRetries: remainingInvalidationRetries - 1,
        });
      }

      throw createHttpError(503, 'Referenced workflow changed while loading. Retry the request.');
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
        (nextRetries) => this.#loadExecutionReferencedProject(loadWorkflow, {
          remainingInvalidationRetries: nextRetries,
        }),
        'Referenced workflow changed while loading. Retry the request.',
      );
      if (retryAfterMaterialize) {
        return retryAfterMaterialize;
      }

      const project = loadProjectFromString(materialization.contents);
      const retryAfterProjectLoad = this.#retryAfterMaterialize(
        resolveSnapshot,
        workflow.workflow_id,
        workflowSnapshot,
        remainingInvalidationRetries,
        (nextRetries) => this.#loadExecutionReferencedProject(loadWorkflow, {
          remainingInvalidationRetries: nextRetries,
        }),
        'Referenced workflow changed while loading. Retry the request.',
      );
      if (retryAfterProjectLoad) {
        return retryAfterProjectLoad;
      }

      return project;
    } finally {
      this.#invalidationController.endWorkflowLoad(workflow.workflow_id);
    }
  }

  async #readRevisionContentsFromBlobStore(
    revision: ManagedExecutionRevisionRecord,
  ): Promise<{ contents: string; datasetsContents: string | null }> {
    const [contents, datasetsContents] = await Promise.all([
      this.#blobStore.getText(revision.project_blob_key),
      revision.dataset_blob_key ? this.#blobStore.getText(revision.dataset_blob_key) : Promise.resolve(null),
    ]);

    return {
      contents,
      datasetsContents,
    };
  }
}
