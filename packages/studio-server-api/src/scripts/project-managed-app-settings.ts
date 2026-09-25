import {
  disposeAppSettingsRepositories,
  initializeAppSettingsRepositories,
} from '../app-settings/settings-repository.js';
import {
  assertKubernetesStorageModes,
  projectDeploymentStorageSettings,
  readDeploymentStorageRuntimeSettingsSync,
} from '../deployment-storage-settings.js';
import { projectNodeExecutorProxySettings } from '../node-executor-proxy-settings.js';

await initializeAppSettingsRepositories();
try {
  const activeStorage = readDeploymentStorageRuntimeSettingsSync();
  if (process.env.RIVET_DEPLOYMENT_TOPOLOGY === 'replicated') assertKubernetesStorageModes(activeStorage);
  const pathStyleValue = process.env.RIVET_DEPLOYMENT_STORAGE_FORCE_PATH_STYLE?.trim();
  const bootstrapLocation = {
    objectStorageBucket: process.env.RIVET_DEPLOYMENT_STORAGE_BUCKET?.trim(),
    objectStorageEndpoint: process.env.RIVET_DEPLOYMENT_STORAGE_ENDPOINT?.trim().replace(/\/+$/, ''),
    objectStorageRegion: process.env.RIVET_DEPLOYMENT_STORAGE_REGION?.trim(),
    objectStoragePrefix: process.env.RIVET_DEPLOYMENT_STORAGE_PREFIX?.trim(),
    objectStorageForcePathStyle: pathStyleValue === undefined ? undefined : pathStyleValue.toLowerCase() === 'true',
  };
  const mismatchedFields = (Object.keys(bootstrapLocation) as Array<keyof typeof bootstrapLocation>).filter(
    (field) => bootstrapLocation[field] !== undefined && bootstrapLocation[field] !== activeStorage[field],
  );
  if (mismatchedFields.length > 0) {
    console.warn(
      `[deployment-storage] Helm bootstrap differs from the authoritative PostgreSQL settings row (${mismatchedFields.join(', ')}). Existing object locations remain active; investigate before treating this rollout as a storage migration.`,
    );
  }
  await Promise.all([projectDeploymentStorageSettings(), projectNodeExecutorProxySettings()]);
  console.log('[app-settings] Projected managed settings into pod-local runtime files.');
} finally {
  await disposeAppSettingsRepositories();
}
