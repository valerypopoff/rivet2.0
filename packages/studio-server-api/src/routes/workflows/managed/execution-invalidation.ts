import { randomUUID } from 'node:crypto';
import { Client, type ClientConfig, type PoolClient } from 'pg';
import {
  EVALUATION_LIBRARY_INVALIDATION_CHANNEL,
  evaluationLibrarySourceInstanceId,
} from '../../../evaluation-runs/library-invalidation.js';

import type {
  ManagedExecutionInvalidationEvent,
  ManagedExecutionResolveSnapshot,
  ManagedExecutionWorkflowGenerationRecord,
  ManagedExecutionWorkflowSnapshot,
} from './execution-types.js';

type ManagedExecutionInvalidationNotification = {
  channel: string;
  payload?: string | null;
};

type ManagedExecutionInvalidationListener = {
  connect(): Promise<unknown>;
  query(text: string, values?: unknown[]): Promise<unknown>;
  end(): Promise<unknown>;
  on(event: 'notification', handler: (message: ManagedExecutionInvalidationNotification) => void): void;
  on(event: 'error', handler: (error: unknown) => void): void;
  on(event: 'end', handler: () => void): void;
  removeAllListeners(): void;
};

type ManagedExecutionReconnectTimer = {
  unref?(): void;
};

type ManagedExecutionTransactionHooks = {
  onCommit(task: () => Promise<void>): void;
};

type ManagedWorkflowExecutionInvalidationControllerOptions = {
  databaseConnectionConfig: ClientConfig;
  withManagedDbRetry<T>(scope: string, run: () => Promise<T>): Promise<T>;
  invalidateWorkflowEndpointPointers(workflowId: string): void;
  clearEndpointPointers(): void;
  onWorkflowChanged?(workflowId: string): void;
  onAllChanged?(): void;
  onExternalInvalidation?(): void;
  onEvaluationLibraryChanged?(revision: number | null): void;
  createListener?: () => ManagedExecutionInvalidationListener;
  now?: () => number;
  scheduleReconnect?: (task: () => void, delayMs: number) => ManagedExecutionReconnectTimer;
  clearReconnect?: (timer: ManagedExecutionReconnectTimer) => void;
};

export const MANAGED_WORKFLOW_EXECUTION_INVALIDATION_CHANNEL = 'managed_workflow_execution_changed';
export const MANAGED_WORKFLOW_EXECUTION_LISTENER_RECONNECT_DELAY_MS = 1_000;
export const MANAGED_WORKFLOW_EXECUTION_INVALIDATION_RETRY_LIMIT = 2;
export const MANAGED_WORKFLOW_EXECUTION_WORKFLOW_GENERATION_RETENTION_MS = 10 * 60_000;
export const MANAGED_WORKFLOW_EXECUTION_WORKFLOW_GENERATION_PRUNE_INTERVAL = 128;

export class ManagedWorkflowExecutionInvalidationController {
  readonly #instanceId = randomUUID();
  readonly #databaseConnectionConfig: ClientConfig;
  readonly #withManagedDbRetry: ManagedWorkflowExecutionInvalidationControllerOptions['withManagedDbRetry'];
  readonly #invalidateWorkflowEndpointPointers: (workflowId: string) => void;
  readonly #clearEndpointPointers: () => void;
  readonly #onWorkflowChanged: (workflowId: string) => void;
  readonly #onAllChanged: () => void;
  readonly #onExternalInvalidation: () => void;
  readonly #onEvaluationLibraryChanged?: (revision: number | null) => void;
  readonly #createListener: () => ManagedExecutionInvalidationListener;
  readonly #now: () => number;
  readonly #scheduleReconnect: (task: () => void, delayMs: number) => ManagedExecutionReconnectTimer;
  readonly #clearReconnect: (timer: ManagedExecutionReconnectTimer) => void;
  #listener: ManagedExecutionInvalidationListener | null = null;
  #listenerHealthy = false;
  #listenerPromise: Promise<void> | null = null;
  #listenerClosePromise: Promise<void> | null = null;
  #disposePromise: Promise<void> | null = null;
  #reconnectTimer: ManagedExecutionReconnectTimer | null = null;
  #disposed = false;
  #executionPointerAnyGeneration = 0;
  #executionPointerGlobalGeneration = 0;
  #executionPointerGlobalUpdatedAt = 0;
  readonly #executionPointerWorkflowGenerations = new Map<string, ManagedExecutionWorkflowGenerationRecord>();
  #executionPointerWorkflowGenerationInvalidationCount = 0;
  readonly #activeWorkflowLoads = new Map<string, number>();

  constructor(options: ManagedWorkflowExecutionInvalidationControllerOptions) {
    this.#databaseConnectionConfig = options.databaseConnectionConfig;
    this.#withManagedDbRetry = options.withManagedDbRetry;
    this.#invalidateWorkflowEndpointPointers = options.invalidateWorkflowEndpointPointers;
    this.#clearEndpointPointers = options.clearEndpointPointers;
    this.#onWorkflowChanged = options.onWorkflowChanged ?? (() => {});
    this.#onAllChanged = options.onAllChanged ?? (() => {});
    this.#onExternalInvalidation = options.onExternalInvalidation ?? (() => {});
    this.#onEvaluationLibraryChanged = options.onEvaluationLibraryChanged;
    this.#createListener = options.createListener ?? (() => new Client(this.#databaseConnectionConfig));
    this.#now = options.now ?? Date.now;
    this.#scheduleReconnect = options.scheduleReconnect ?? ((task, delayMs) => setTimeout(task, delayMs));
    this.#clearReconnect =
      options.clearReconnect ??
      ((timer) => {
        clearTimeout(timer as NodeJS.Timeout);
      });
  }

  async initialize(): Promise<void> {
    if (this.#disposed || this.#listenerHealthy) {
      return;
    }

    if (this.#listenerPromise) {
      await this.#listenerPromise;
      return;
    }
    if (this.#listenerClosePromise) {
      await this.#listenerClosePromise.catch(() => undefined);
      // Another initializer may have acquired the next client while we waited.
      if (this.#listenerPromise) {
        await this.#listenerPromise;
        return;
      }
      // Failed close retains the exact owner. Cache misses still use fresh SQL
      // reads, but reconnecting must not allocate an overlapping listener.
      if (this.#listener || this.#disposed) return;
    }

    this.#listenerPromise = (async () => {
      const listener = this.#createListener();
      this.#listener = listener;
      this.#listenerClosePromise = null;

      try {
        await this.#withManagedDbRetry('managed execution invalidation listener connect', () => listener.connect());
        await this.#withManagedDbRetry('managed execution invalidation listener listen', () =>
          listener.query(`LISTEN ${MANAGED_WORKFLOW_EXECUTION_INVALIDATION_CHANNEL}`),
        );
        if (this.#onEvaluationLibraryChanged) {
          await this.#withManagedDbRetry('managed evaluation library listener listen', () =>
            listener.query(`LISTEN ${EVALUATION_LIBRARY_INVALIDATION_CHANNEL}`),
          );
        }
      } catch (error) {
        try {
          await this.#closeListener(listener);
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Execution invalidation startup and cleanup failed.');
        }
        if (!this.#disposed) {
          this.#listenerHealthy = false;
          this.markAllChanged();
          this.#notifyEvaluationLibrary(null);
          this.#scheduleListenerReconnect();
        }
        throw error;
      }

      if (this.#disposed) {
        await this.#closeListener(listener);
        return;
      }

      listener.on('notification', (message) => {
        if (message.channel === EVALUATION_LIBRARY_INVALIDATION_CHANNEL && this.#onEvaluationLibraryChanged) {
          try {
            const event = JSON.parse(message.payload ?? '') as { revision?: unknown; sourceInstanceId?: unknown };
            if (
              event.sourceInstanceId !== evaluationLibrarySourceInstanceId &&
              typeof event.sourceInstanceId === 'string' &&
              typeof event.revision === 'number' &&
              Number.isSafeInteger(event.revision) &&
              event.revision >= 0
            )
              this.#notifyEvaluationLibrary(event.revision);
          } catch {
            this.#notifyEvaluationLibrary(null);
          }
          return;
        }
        if (message.channel !== MANAGED_WORKFLOW_EXECUTION_INVALIDATION_CHANNEL || !message.payload) {
          return;
        }

        try {
          this.#handleNotification(JSON.parse(message.payload) as ManagedExecutionInvalidationEvent);
        } catch (error) {
          console.error('[managed-workflows] Failed to process execution invalidation payload:', error);
        }
      });
      listener.on('error', (error) => {
        this.#reportError('Execution invalidation listener error:', error);
        void this.#handleListenerFailure(listener);
      });
      listener.on('end', () => {
        void this.#handleListenerFailure(listener);
      });

      this.#listenerHealthy = true;
      this.#notifyExternal();
      this.#notifyEvaluationLibrary(null);
      this.#clearListenerReconnectTimer();
    })()
      .catch((error) => {
        if (!this.#disposed) {
          this.#reportError('Execution invalidation listener initialization failed:', error);
        }
      })
      .finally(() => {
        this.#listenerPromise = null;
      });

    await this.#listenerPromise;
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposed = true;
    this.markAllChanged();
    this.#clearListenerReconnectTimer();
    this.#listenerHealthy = false;
    return (this.#disposePromise = (async () => {
      // An initializer owns its connecting client until it settles. Do not
      // acknowledge shutdown while that client can still become connected.
      await this.#listenerPromise;
      if (this.#listener) await this.#closeListener(this.#listener);
      else await this.#listenerClosePromise;
    })());
  }

  #closeListener(listener: ManagedExecutionInvalidationListener): Promise<void> {
    if (this.#listener !== listener) return Promise.resolve();
    return (this.#listenerClosePromise ??= Promise.resolve().then(async () => {
      listener.removeAllListeners();
      await listener.end();
      if (this.#listener === listener) this.#listener = null;
    }));
  }

  #reportError(message: string, error: unknown): void {
    try {
      console.error('[managed-workflows] ' + message, error);
    } catch {
      // Diagnostics cannot prevent retirement or alter its acknowledgement.
    }
  }

  isPointerCacheHealthy(): boolean {
    return this.#listenerHealthy;
  }

  markWorkflowChanged(workflowId: string): void {
    const now = this.#now();
    this.#executionPointerAnyGeneration += 1;
    const current = this.#executionPointerWorkflowGenerations.get(workflowId);
    this.#executionPointerWorkflowGenerations.set(workflowId, {
      generation: (current?.generation ?? 0) + 1,
      updatedAt: now,
    });
    this.#maybePruneWorkflowGenerations(now);
    this.#invalidateWorkflowEndpointPointers(workflowId);
    this.#onWorkflowChanged(workflowId);
  }

  markAllChanged(): void {
    const now = this.#now();
    this.#executionPointerAnyGeneration += 1;
    this.#executionPointerGlobalGeneration += 1;
    this.#executionPointerGlobalUpdatedAt = now;
    this.#executionPointerWorkflowGenerations.clear();
    this.#executionPointerWorkflowGenerationInvalidationCount = 0;
    this.#clearEndpointPointers();
    this.#onAllChanged();
  }

  beginWorkflowLoad(workflowId: string): void {
    this.#activeWorkflowLoads.set(workflowId, (this.#activeWorkflowLoads.get(workflowId) ?? 0) + 1);
  }

  endWorkflowLoad(workflowId: string): void {
    const current = this.#activeWorkflowLoads.get(workflowId);
    if (!current || current <= 1) {
      this.#activeWorkflowLoads.delete(workflowId);
      return;
    }

    this.#activeWorkflowLoads.set(workflowId, current - 1);
  }

  captureResolveSnapshot(): ManagedExecutionResolveSnapshot {
    return {
      startedAtWallClock: this.#now(),
      anyGeneration: this.#executionPointerAnyGeneration,
      globalGeneration: this.#executionPointerGlobalGeneration,
      globalUpdatedAt: this.#executionPointerGlobalUpdatedAt,
    };
  }

  captureWorkflowSnapshot(workflowId: string): ManagedExecutionWorkflowSnapshot {
    return {
      workflowId,
      generation: this.#getWorkflowGeneration(workflowId),
    };
  }

  shouldRetryAfterResolve(snapshot: ManagedExecutionResolveSnapshot, workflowId: string | null): boolean {
    if (this.#executionPointerAnyGeneration === snapshot.anyGeneration) {
      return false;
    }

    if (!workflowId) {
      return true;
    }

    const workflowGenerationRecord = this.#executionPointerWorkflowGenerations.get(workflowId);
    const sameWorkflowChangedDuringResolve =
      workflowGenerationRecord != null && workflowGenerationRecord.updatedAt >= snapshot.startedAtWallClock;
    const clearAllChangedDuringResolve =
      this.#executionPointerGlobalGeneration !== snapshot.globalGeneration &&
      this.#executionPointerGlobalUpdatedAt >= snapshot.startedAtWallClock;

    return sameWorkflowChangedDuringResolve || clearAllChangedDuringResolve;
  }

  shouldRetryAfterMaterialize(
    globalSnapshot: ManagedExecutionResolveSnapshot,
    workflowId: string,
    workflowSnapshot: ManagedExecutionWorkflowSnapshot,
  ): boolean {
    return (
      this.#executionPointerGlobalGeneration !== globalSnapshot.globalGeneration ||
      this.#getWorkflowGeneration(workflowId) !== workflowSnapshot.generation
    );
  }

  async queueWorkflowInvalidation(
    client: Pick<PoolClient, 'query'>,
    hooks: ManagedExecutionTransactionHooks,
    workflowId: string,
  ): Promise<void> {
    await this.#emitInvalidationEvent(client, {
      eventType: 'workflow-changed',
      workflowId,
      sourceInstanceId: this.#instanceId,
    });

    hooks.onCommit(async () => {
      this.markWorkflowChanged(workflowId);
    });
  }

  async queueGlobalInvalidation(
    client: Pick<PoolClient, 'query'>,
    hooks: ManagedExecutionTransactionHooks,
  ): Promise<void> {
    await this.#emitInvalidationEvent(client, {
      eventType: 'clear-all',
      sourceInstanceId: this.#instanceId,
    });

    hooks.onCommit(async () => {
      this.markAllChanged();
    });
  }

  /** Catalog hints share the existing transaction/LISTEN transport, but do not
   * evict published execution caches for an unrelated empty folder or draft. */
  async queueCatalogInvalidation(client: Pick<PoolClient, 'query'>): Promise<void> {
    await this.#emitInvalidationEvent(client, { eventType: 'catalog-changed', sourceInstanceId: this.#instanceId });
  }

  #handleNotification(event: ManagedExecutionInvalidationEvent): void {
    if (event.sourceInstanceId === this.#instanceId) {
      return;
    }
    this.#notifyExternal();

    if (event.eventType === 'catalog-changed') return;

    if (event.eventType === 'clear-all') {
      this.markAllChanged();
      return;
    }

    this.markWorkflowChanged(event.workflowId);
  }

  async #handleListenerFailure(listener: ManagedExecutionInvalidationListener): Promise<void> {
    if (this.#listener !== listener || this.#listenerClosePromise) {
      return;
    }

    this.#listenerHealthy = false;
    this.markAllChanged();
    this.#notifyExternal();
    this.#notifyEvaluationLibrary(null);
    try {
      await this.#closeListener(listener);
    } catch (error) {
      this.#reportError('Execution invalidation listener close is unconfirmed:', error);
      return;
    }
    this.#scheduleListenerReconnect();
  }

  #notifyExternal(): void {
    try {
      this.#onExternalInvalidation();
    } catch {
      console.warn('[managed-workflows] An observational invalidation callback failed.');
    }
  }

  #notifyEvaluationLibrary(revision: number | null): void {
    try {
      this.#onEvaluationLibraryChanged?.(revision);
    } catch {
      console.warn('[managed-workflows] An evaluation library observer failed.');
    }
  }

  #scheduleListenerReconnect(): void {
    if (this.#disposed || this.#reconnectTimer || this.#listener) {
      return;
    }

    this.#reconnectTimer = this.#scheduleReconnect(() => {
      this.#reconnectTimer = null;
      void this.initialize();
    }, MANAGED_WORKFLOW_EXECUTION_LISTENER_RECONNECT_DELAY_MS);
    this.#reconnectTimer.unref?.();
  }

  #clearListenerReconnectTimer(): void {
    if (!this.#reconnectTimer) {
      return;
    }

    this.#clearReconnect(this.#reconnectTimer);
    this.#reconnectTimer = null;
  }

  #getWorkflowGeneration(workflowId: string): number {
    return this.#executionPointerWorkflowGenerations.get(workflowId)?.generation ?? 0;
  }

  #maybePruneWorkflowGenerations(now: number): void {
    this.#executionPointerWorkflowGenerationInvalidationCount += 1;
    if (
      this.#executionPointerWorkflowGenerationInvalidationCount %
        MANAGED_WORKFLOW_EXECUTION_WORKFLOW_GENERATION_PRUNE_INTERVAL !==
      0
    ) {
      return;
    }

    const cutoff = now - MANAGED_WORKFLOW_EXECUTION_WORKFLOW_GENERATION_RETENTION_MS;
    for (const [workflowId, record] of this.#executionPointerWorkflowGenerations) {
      if (this.#activeWorkflowLoads.has(workflowId)) {
        continue;
      }

      if (record.updatedAt >= cutoff) {
        continue;
      }

      this.#executionPointerWorkflowGenerations.delete(workflowId);
    }
  }

  async #emitInvalidationEvent(
    client: Pick<PoolClient, 'query'>,
    event: ManagedExecutionInvalidationEvent,
  ): Promise<void> {
    await client.query('SELECT pg_notify($1, $2)', [
      MANAGED_WORKFLOW_EXECUTION_INVALIDATION_CHANNEL,
      JSON.stringify(event),
    ]);
  }
}
