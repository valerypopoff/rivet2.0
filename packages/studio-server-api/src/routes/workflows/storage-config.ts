import { badRequest } from '../../utils/httpError.js';
import { readDeploymentStorageRuntimeSettingsSync } from '../../deployment-storage-settings.js';

export type WorkflowStorageBackendMode = 'filesystem' | 'managed';
export type ManagedWorkflowDatabaseMode = 'local-docker' | 'managed';
export type ManagedWorkflowDatabaseSslMode = 'disable' | 'require' | 'verify-full';

export type ManagedWorkflowStorageConfig = {
  databaseMode: ManagedWorkflowDatabaseMode;
  databaseUrl: string;
  databaseSslMode: ManagedWorkflowDatabaseSslMode;
  objectStorageBucket: string;
  objectStorageRegion: string;
  objectStorageEndpoint: string | null;
  objectStorageAccessKeyId: string;
  objectStorageSecretAccessKey: string;
  objectStoragePrefix: string;
  objectStorageForcePathStyle: boolean;
};

function stripDatabaseSslQueryOptions(rawConnectionString: string): string {
  try {
    const url = new URL(rawConnectionString);
    url.searchParams.delete('sslmode');
    return url.toString();
  } catch {
    return rawConnectionString;
  }
}

export function getWorkflowStorageBackendMode(): WorkflowStorageBackendMode {
  const deploymentSettings = readDeploymentStorageRuntimeSettingsSync();
  return deploymentSettings.storageMode;
}

export function isManagedWorkflowStorageEnabled(): boolean {
  return getWorkflowStorageBackendMode() === 'managed';
}

export function getManagedWorkflowStorageConfig(): ManagedWorkflowStorageConfig {
  const deploymentSettings = readDeploymentStorageRuntimeSettingsSync();

  if (deploymentSettings.storageMode !== 'managed') {
    throw badRequest(
      'Managed workflow storage is not enabled. Configure Object storage in Settings -> Storage and restart the API/executor processes.',
    );
  }

  return {
    databaseMode: deploymentSettings.databaseMode,
    databaseUrl: stripDatabaseSslQueryOptions(deploymentSettings.databaseConnectionString),
    databaseSslMode: deploymentSettings.databaseSslMode,
    objectStorageBucket: deploymentSettings.objectStorageBucket,
    objectStorageRegion: deploymentSettings.objectStorageRegion,
    objectStorageEndpoint: deploymentSettings.objectStorageEndpoint || null,
    objectStorageAccessKeyId: deploymentSettings.storageAccessKeyId,
    objectStorageSecretAccessKey: deploymentSettings.storageAccessKey,
    objectStoragePrefix: deploymentSettings.objectStoragePrefix,
    objectStorageForcePathStyle: deploymentSettings.objectStorageForcePathStyle,
  };
}
