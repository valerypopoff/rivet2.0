import type {
  EvaluationDatasetSnapshot,
  EvaluationLibrary,
  EvaluationRecordingArtifact,
  EvaluationRun,
  EvaluationStore,
  EvaluationStoreInitialization,
} from '@valerypopoff/rivet2-evaluations';
import type { ProjectId } from '@valerypopoff/rivet2-core';
import { invokeNative, isInTauri } from '../utils/platform/core.js';
import {
  LocalEvaluationRunStore,
  type EvaluationKeyValueBackend,
  type EvaluationStoreEntry,
} from './EvaluationRunStore.js';

const LEGACY_MIGRATION_ID = 'webview-evaluations-v1';

type TauriEvaluationMigrationApi = {
  completed(migrationId: string): Promise<boolean>;
  import(migrationId: string, entries: readonly EvaluationStoreEntry[]): Promise<void>;
};

const defaultMigrationApi: TauriEvaluationMigrationApi = {
  completed: (migrationId) =>
    invokeNative<boolean>('evaluation_store_migration_completed', {
      migrationId,
    }),
  import: async (migrationId, entries) => {
    await invokeNative('evaluation_store_import_legacy', { migrationId, entries });
  },
};

class TauriEvaluationKeyValueBackend implements EvaluationKeyValueBackend {
  async get(key: string): Promise<string | null> {
    return invokeNative<string | null>('evaluation_store_get', { key });
  }

  async set(key: string, value: string): Promise<void> {
    await invokeNative('evaluation_store_set', { key, value });
  }

  async delete(key: string): Promise<void> {
    await invokeNative('evaluation_store_delete', { key });
  }
}

/**
 * Desktop evaluation store. Browser-era evidence is copied atomically into
 * app-local SQLite once; a failed migration keeps the browser store active for
 * the complete session instead of splitting new writes between backends.
 */
export class TauriEvaluationStore implements EvaluationStore {
  readonly #browserStore: LocalEvaluationRunStore;
  readonly #nativeStore: LocalEvaluationRunStore;
  readonly #migrationApi: TauriEvaluationMigrationApi;
  #activeStore?: EvaluationStore;
  #initializePromise?: Promise<EvaluationStoreInitialization | void>;

  constructor(
    options: {
      browserStore?: LocalEvaluationRunStore;
      backend?: EvaluationKeyValueBackend;
      migrationApi?: TauriEvaluationMigrationApi;
    } = {},
  ) {
    this.#browserStore = options.browserStore ?? new LocalEvaluationRunStore();
    this.#nativeStore = new LocalEvaluationRunStore({
      backend: options.backend ?? new TauriEvaluationKeyValueBackend(),
      storageLabel: 'application evaluation database',
    });
    this.#migrationApi = options.migrationApi ?? defaultMigrationApi;
  }

  static isSupported(): boolean {
    return isInTauri();
  }

  async initialize(): Promise<EvaluationStoreInitialization | void> {
    this.#initializePromise ??= this.initializeOnce();
    return this.#initializePromise;
  }

  private async initializeOnce(): Promise<EvaluationStoreInitialization | void> {
    try {
      const migrated = await this.#migrationApi.completed(LEGACY_MIGRATION_ID);
      if (!migrated) {
        const entries = await this.#browserStore.exportEntries({ requireIndexedDb: true });
        await this.#migrationApi.import(LEGACY_MIGRATION_ID, entries);
      }
      await this.#nativeStore.initialize();
      this.#activeStore = this.#nativeStore;
      return;
    } catch (error) {
      await this.#browserStore.initialize();
      this.#activeStore = this.#browserStore;
      const detail = error instanceof Error ? error.message : String(error);
      return {
        warning: `Rivet could not open or migrate its application evaluation database. This session is using the legacy browser store${detail ? `: ${detail}` : '.'}`,
      };
    }
  }

  private async store(): Promise<EvaluationStore> {
    await this.initialize();
    return this.#activeStore!;
  }

  async getLibrary(): Promise<EvaluationLibrary> {
    return (await this.store()).getLibrary();
  }

  async putLibrary(library: EvaluationLibrary): Promise<void> {
    await (await this.store()).putLibrary(library);
  }

  async put(run: EvaluationRun): Promise<void> {
    await (await this.store()).put(run);
  }

  async updateRunName(input: {
    projectId: ProjectId;
    runId: string;
    name?: string;
  }): Promise<EvaluationRun | undefined> {
    return (await this.store()).updateRunName(input);
  }

  async get(input: { projectId: ProjectId; runId: string }): Promise<EvaluationRun | undefined> {
    return (await this.store()).get(input);
  }

  async list(input: { projectId: ProjectId; suiteId?: string }): Promise<readonly EvaluationRun[]> {
    return (await this.store()).list(input);
  }

  async delete(input: { projectId: ProjectId; runId: string }): Promise<void> {
    await (await this.store()).delete(input);
  }

  async putDatasetSnapshot(snapshot: EvaluationDatasetSnapshot): Promise<void> {
    await (await this.store()).putDatasetSnapshot(snapshot);
  }

  async getDatasetSnapshot(input: {
    projectId: ProjectId;
    fingerprint: string;
  }): Promise<EvaluationDatasetSnapshot | undefined> {
    return (await this.store()).getDatasetSnapshot(input);
  }

  async putRecording(artifact: EvaluationRecordingArtifact): Promise<void> {
    await (await this.store()).putRecording(artifact);
  }

  async getRecording(input: {
    projectId: ProjectId;
    recordingId: string;
  }): Promise<EvaluationRecordingArtifact | undefined> {
    return (await this.store()).getRecording(input);
  }

  async updateRecordingRetention(input: {
    projectId: ProjectId;
    recordingId: string;
    retention: EvaluationRecordingArtifact['reference']['retention'];
    expiresAt?: string;
  }): Promise<void> {
    await (await this.store()).updateRecordingRetention(input);
  }

  async promoteBaseline(input: { projectId: ProjectId; runId: string }): Promise<void> {
    await (await this.store()).promoteBaseline(input);
  }
}

export type { EvaluationStoreEntry };
