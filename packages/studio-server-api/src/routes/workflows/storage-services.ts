import type { ProjectId } from '@valerypopoff/rivet2-node';
import type { WorkflowDataBackend } from './data-backend.js';
import type { RuntimeHealthCheckContext } from '../../runtime-health.js';
import type { RivetStudioLLMProfileHealthStore } from '../../llm-profile-health/store.js';
import type { RivetStudioEvaluationStore } from '../../evaluation-runs/store.js';
import type { HostedEvaluationCoordinator } from '../../evaluation-runs/hosted-coordinator.js';
import type {
  ManagedReconciliationFindingDetailQuery,
  ManagedReconciliationFindingDetail,
} from './managed/reconciliation.js';
import { createHttpError } from '../../utils/httpError.js';

type Disposable = { dispose(): Promise<void> };
export interface LocalWorkflowResources extends WorkflowDataBackend, Disposable {
  initialize(): void | Promise<void>;
  checkHealth(context?: RuntimeHealthCheckContext): Promise<void>;
  getActiveWriteCount(): number;
  getPendingCatalogOperationCount(): number;
  cleanupRecordings(): Promise<number>;
}
export interface ManagedWorkflowResources extends WorkflowDataBackend, Disposable {
  initialize(): Promise<void>;
  drain(): Promise<void>;
  checkHealth(context?: RuntimeHealthCheckContext): Promise<void>;
  getLLMProfileHealthStore(): Promise<RivetStudioLLMProfileHealthStore>;
  getEvaluationStore(): Promise<RivetStudioEvaluationStore>;
  getHostedEvaluationCoordinator(): Promise<HostedEvaluationCoordinator>;
  listManagedReconciliationFindingDetails(
    query: ManagedReconciliationFindingDetailQuery,
  ): Promise<{ findings: ManagedReconciliationFindingDetail[]; offset: number; pageSize: number }>;
}
export type WorkflowStorageServiceDependencies = {
  mode: 'legacy' | 'sqlite' | 'managed';
  createLocal(beforeDeleteProject: (id: string) => Promise<void>): LocalWorkflowResources;
  createManaged(): ManagedWorkflowResources;
  createProfileHealth(): RivetStudioLLMProfileHealthStore & Disposable;
  createEvaluations(): RivetStudioEvaluationStore & Disposable;
  profileHealthExists(): Promise<boolean>;
  initializeLegacy(): Promise<void>;
  drainLegacy(): Promise<void>;
  flushRecordings(): Promise<void>;
  flushRecordingOutcomes(): Promise<void>;
  assertRetentionAllowed(): void;
};

/** One installation/generation owns resources, timers and shutdown ordering.
 * New resources cannot be created during drain; accepted recording tasks may
 * still use existing resources until persistence and evidence updates settle. */
export class WorkflowStorageServices {
  #phase: 'open' | 'draining' | 'closed' = 'open';
  #managed?: Promise<ManagedWorkflowResources>;
  #managedInstance?: ManagedWorkflowResources;
  #local?: Promise<LocalWorkflowResources>;
  #localInstance?: LocalWorkflowResources;
  #health?: RivetStudioLLMProfileHealthStore & Disposable;
  #evaluations?: RivetStudioEvaluationStore & Disposable;
  #initializing?: Promise<void>;
  #draining?: Promise<void>;
  #disposing?: Promise<void>;
  #retentionTimer?: ReturnType<typeof setInterval>;
  #retention?: Promise<void>;
  readonly mode: WorkflowStorageServiceDependencies['mode'];
  constructor(readonly dependencies: WorkflowStorageServiceDependencies) {
    this.mode = dependencies.mode;
  }
  get phase() {
    return this.#phase;
  }
  #allow(existing: unknown): void {
    if (this.#phase === 'closed' || (this.#phase === 'draining' && !existing))
      throw createHttpError(503, 'Workflow services are shutting down.');
  }
  getLocalActiveWriteCount(): number {
    return this.#localInstance?.getActiveWriteCount() ?? 0;
  }
  getLocalPendingOperationCount(): number {
    return this.#localInstance?.getPendingCatalogOperationCount() ?? 0;
  }
  async getProfileHealth(): Promise<RivetStudioLLMProfileHealthStore> {
    if (this.mode === 'managed') return (await this.getManaged()).getLLMProfileHealthStore();
    return this.#getLocalProfileHealth();
  }
  #getLocalProfileHealth(): RivetStudioLLMProfileHealthStore & Disposable {
    this.#allow(this.#health);
    return (this.#health ??= this.dependencies.createProfileHealth());
  }
  async getEvaluations(): Promise<RivetStudioEvaluationStore> {
    if (this.mode === 'managed') return (await this.getManaged()).getEvaluationStore();
    return this.#getLocalEvaluations();
  }
  #getLocalEvaluations(): RivetStudioEvaluationStore & Disposable {
    this.#allow(this.#evaluations);
    return (this.#evaluations ??= this.dependencies.createEvaluations());
  }
  async resetLocalProjectHealth(projectId: ProjectId): Promise<void> {
    if (this.mode === 'managed') throw new Error('Local project health is not selected.');
    this.#allow(this.#health);
    if (!this.#health && !(await this.dependencies.profileHealthExists()) && !this.#health) return;
    await this.#getLocalProfileHealth().reset({ projectId });
  }
  getManaged(): Promise<ManagedWorkflowResources> {
    this.#allow(this.#managed);
    if (this.mode !== 'managed') throw new Error('Managed workflow services are not selected.');
    return (this.#managed ??= this.#open(
      () => {
        return (this.#managedInstance = this.dependencies.createManaged());
      },
      () => {
        this.#managed = undefined;
        this.#managedInstance = undefined;
      },
    ));
  }
  getLocal(): Promise<LocalWorkflowResources> {
    this.#allow(this.#local);
    if (this.mode !== 'sqlite') throw new Error('SQLite workflow services are not selected.');
    return (this.#local ??= this.#open(
      () => {
        const backend = this.dependencies.createLocal(async (id) => {
          await this.resetLocalProjectHealth(id as ProjectId);
          await this.#getLocalEvaluations().deleteProject(id as ProjectId);
        });
        this.#localInstance = backend;
        return backend;
      },
      () => {
        this.#local = undefined;
        this.#localInstance = undefined;
      },
    ));
  }
  async #open<T extends Disposable & { initialize(): void | Promise<void> }>(
    create: () => T,
    clear: () => void,
  ): Promise<T> {
    // Defer construction so assignment owns failures from synchronous factories too.
    return Promise.resolve().then(async () => {
      let resource: T;
      try {
        this.#allow(undefined);
        resource = create();
      } catch (error) {
        clear();
        throw error;
      }
      try {
        await resource.initialize();
        return resource;
      } catch (error) {
        // A failed close may leave a worker/pool alive. Keep that owner fenced;
        // neither a retry nor shutdown may silently replace or abandon it.
        try {
          await resource.dispose();
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Workflow initialization and cleanup failed.');
        }
        clear();
        throw error;
      }
    });
  }
  async getData(): Promise<WorkflowDataBackend> {
    if (this.mode === 'legacy') throw new Error('Legacy storage has no SQL data backend.');
    return this.mode === 'sqlite' ? this.getLocal() : this.getManaged();
  }
  initialize(): Promise<void> {
    this.#allow(undefined);
    return (this.#initializing ??= (async () => {
      if (this.mode === 'legacy') await this.dependencies.initializeLegacy();
      else await this.getData();
      if (this.#phase !== 'open') throw createHttpError(503, 'Workflow services are shutting down.');
      if (this.mode === 'sqlite') {
        this.#retentionTimer = setInterval(() => this.#cleanup(), 60_000);
        this.#retentionTimer.unref();
        this.#cleanup();
      }
    })().catch((error) => {
      if (this.#phase === 'open') this.#initializing = undefined;
      throw error;
    }));
  }
  #cleanup(): void {
    if (this.#phase !== 'open' || this.#retention || !this.#localInstance) return;
    try {
      this.dependencies.assertRetentionAllowed();
    } catch {
      return;
    }
    this.#retention = Promise.resolve()
      .then(() => this.#localInstance!.cleanupRecordings())
      .then(() => undefined)
      .catch(() => {
        console.warn('[local-metadata] Recording retention stopped without deleting unverified artifacts.');
      })
      .finally(() => {
        this.#retention = undefined;
      });
  }
  /** Fence resource construction and settle producers/persistence without
   * closing stores. Transport admission remains the server's responsibility. */
  drain(): Promise<void> {
    if (this.#draining) return this.#draining;
    this.#phase = 'draining';
    clearInterval(this.#retentionTimer);
    this.#retentionTimer = undefined;
    return (this.#draining = (async () => {
      // Fence an existing managed adapter immediately, before waiting for its
      // initialization. Otherwise a late initializer can start a producer in
      // the gap between shutdown being requested and this owner reaching it.
      const managedDraining = this.#managedInstance?.drain();
      void managedDraining?.catch(() => undefined);
      await this.#initializing?.catch(() => undefined);
      await Promise.allSettled([this.#local, this.#managed]);
      await this.#retention;
      // Stop producers before draining their recording/evidence consumers.
      await managedDraining;
      if (this.mode === 'legacy') await this.dependencies.drainLegacy();
      await this.dependencies.flushRecordings();
      await this.dependencies.flushRecordingOutcomes();
    })());
  }
  dispose(): Promise<void> {
    return (this.#disposing ??= (async () => {
      await this.drain();
      // Catalog shutdown drains accepted operations, including parent-side
      // deletion hooks. Their operational stores must remain usable until SQL
      // termination is confirmed; an unknown close outcome keeps them open.
      await (this.#managedInstance ?? this.#localInstance)?.dispose();
      this.#phase = 'closed';
      const results = await Promise.allSettled([
        Promise.resolve().then(() => this.#health?.dispose()),
        Promise.resolve().then(() => this.#evaluations?.dispose()),
      ]);
      const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
      if (errors.length) throw new AggregateError(errors, 'Workflow service disposal failed.');
    })());
  }
}
