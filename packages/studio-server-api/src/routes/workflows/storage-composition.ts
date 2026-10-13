import path from 'node:path';
import { getLocalMetadataServingSelection } from '../../local-metadata/serving-selection.js';
import { assertLocalMetadataWritesAllowed } from '../../local-metadata/runtime-control.js';
import { SqliteWorkflowBackend } from '../../local-metadata/sqlite-workflow-backend.js';
import {
  FilesystemRivetLLMProfileHealthStore,
  getFilesystemLLMProfileHealthDatabasePath,
} from '../../llm-profile-health/filesystem-store.js';
import { FilesystemRivetEvaluationStore } from '../../evaluation-runs/filesystem-store.js';
import { flushLLMProfileHealthRecordingOutcomes } from '../../llm-profile-health/recording-outcomes.js';
import { ManagedWorkflowBackend } from './managed/backend.js';
import { getManagedWorkflowStorageConfig, isManagedWorkflowStorageEnabled } from './storage-config.js';
import { ensureWorkflowsRoot, listProjectPathsRecursive, pathExists, PROJECT_EXTENSION } from './fs-helpers.js';
import { readStoredWorkflowProjectSettings } from './publication.js';
import {
  initializeFilesystemProjectTransactions,
  waitForFilesystemWorkflowStorageIdle,
} from './filesystem-project-transactions.js';
import { getFilesystemExecutionCache } from './filesystem-execution-cache.js';
import { initializeWorkflowRecordingStorage, flushWorkflowExecutionRecordingPersistence } from './recordings.js';
import { WorkflowStorageServices } from './storage-services.js';

/** The only serving resource construction site. Offline importers construct
 * their own adapters and never join this installation's timers or lifecycle. */
export function createWorkflowStorageServices(): WorkflowStorageServices {
  const local = getLocalMetadataServingSelection();
  const mode = local ? 'sqlite' : isManagedWorkflowStorageEnabled() ? 'managed' : 'legacy';
  const managedConfig = mode === 'managed' ? getManagedWorkflowStorageConfig() : undefined;
  return new WorkflowStorageServices({
    mode,
    createLocal: (beforeDeleteProject) => {
      if (!local) throw new Error('No SQLite generation selected.');
      return new SqliteWorkflowBackend({
        ...local,
        databasePath: local.catalogDatabasePath,
        worker: true,
        virtualRoot: local.source.workflows,
        withWrite: async (operation) => {
          assertLocalMetadataWritesAllowed();
          return operation();
        },
        beforeDeleteProject,
      });
    },
    createManaged: () => {
      if (!managedConfig) throw new Error('No managed workflow storage selected.');
      return new ManagedWorkflowBackend(managedConfig);
    },
    createProfileHealth: () => new FilesystemRivetLLMProfileHealthStore(),
    createEvaluations: () => new FilesystemRivetEvaluationStore(),
    profileHealthExists: () => pathExists(getFilesystemLLMProfileHealthDatabasePath()),
    initializeLegacy: async () => {
      const root = await ensureWorkflowsRoot();
      await initializeFilesystemProjectTransactions(root);
      for (const projectPath of await listProjectPathsRecursive(root))
        await readStoredWorkflowProjectSettings(projectPath, path.basename(projectPath, PROJECT_EXTENSION));
      await getFilesystemExecutionCache().initialize(root);
      await initializeWorkflowRecordingStorage(root);
    },
    drainLegacy: waitForFilesystemWorkflowStorageIdle,
    flushRecordings: flushWorkflowExecutionRecordingPersistence,
    flushRecordingOutcomes: flushLLMProfileHealthRecordingOutcomes,
    assertRetentionAllowed: assertLocalMetadataWritesAllowed,
  });
}
// Compatibility facade for existing routes. New services accept the instance
// or their narrower repositories; they must not create independent singletons.
let servingServices: WorkflowStorageServices | undefined;
export function getWorkflowStorageServices(): WorkflowStorageServices {
  return (servingServices ??= createWorkflowStorageServices());
}
export function peekWorkflowStorageServices(): WorkflowStorageServices | undefined {
  return servingServices;
}
export async function disposeWorkflowStorageServices(): Promise<void> {
  const owner = servingServices;
  if (!owner) return;
  await owner.dispose();
  // A new serving generation may be explicitly initialized after completed
  // disposal. Never detach a failed or still-running old owner.
  if (servingServices === owner) servingServices = undefined;
}
