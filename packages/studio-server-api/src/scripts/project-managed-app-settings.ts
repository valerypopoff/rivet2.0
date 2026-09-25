import {
  disposeAppSettingsRepositories,
  initializeAppSettingsRepositories,
} from '../app-settings/settings-repository.js';
import {
  assertKubernetesStorageModes,
  getDeploymentStorageBootstrapDrift,
  readDeploymentStorageRuntimeSettingsSync,
} from '../deployment-storage-settings.js';

await initializeAppSettingsRepositories();
try {
  const activeStorage = readDeploymentStorageRuntimeSettingsSync();
  if (process.env.RIVET_DEPLOYMENT_TOPOLOGY === 'replicated') assertKubernetesStorageModes(activeStorage);
  const mismatchedFields = process.env.RIVET_DEPLOYMENT_TOPOLOGY === 'replicated'
    ? getDeploymentStorageBootstrapDrift(activeStorage) : [];
  if (mismatchedFields.length > 0) {
    console.warn(
      `[deployment-storage] Helm bootstrap differs from the authoritative PostgreSQL settings row (${mismatchedFields.join(', ')}). The row remains authoritative; reconcile configuration before rollout.`,
    );
  }
  console.log('[app-settings] Validated authoritative managed storage settings without local projection.');
} finally {
  await disposeAppSettingsRepositories();
}
