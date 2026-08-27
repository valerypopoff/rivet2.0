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

type ParsedStorageUrl = {
  bucket: string;
  endpoint: string | null;
  region: string | null;
  forcePathStyle: boolean;
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

function parseManagedStorageUrl(rawUrl: string): ParsedStorageUrl {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw badRequest(`Invalid storage URL "${rawUrl}"`);
  }

  const pathSegments = url.pathname
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);
  const hostParts = url.hostname.split('.').filter(Boolean);

  if (pathSegments.length > 0) {
    const bucket = pathSegments[0]!;
    return {
      bucket,
      endpoint: url.origin,
      region: hostParts[0] === 's3' && hostParts[1] ? hostParts[1]! : null,
      forcePathStyle: true,
    };
  }

  if (hostParts.length >= 2) {
    const bucket = hostParts[0]!;
    let region: string | null = null;
    let endpointHost = hostParts.slice(1).join('.');

    if (url.hostname.endsWith('.digitaloceanspaces.com') && hostParts.length >= 3) {
      region = hostParts[1] ?? null;
      endpointHost = hostParts.slice(1).join('.');
    } else if (hostParts[1] === 's3') {
      region = hostParts[2] ?? null;
      endpointHost = hostParts.slice(1).join('.');
    }

    return {
      bucket,
      endpoint: `${url.protocol}//${endpointHost}`,
      region,
      forcePathStyle: false,
    };
  }

  throw badRequest(`Storage URL "${rawUrl}" does not include a bucket name`);
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
    throw badRequest('Managed workflow storage is not enabled. Configure Object storage in Settings -> Storage and restart the API/executor processes.');
  }

  const parsedStorageUrl = parseManagedStorageUrl(deploymentSettings.storageUrl);

  return {
    databaseMode: deploymentSettings.databaseMode,
    databaseUrl: stripDatabaseSslQueryOptions(deploymentSettings.databaseConnectionString),
    databaseSslMode: deploymentSettings.databaseSslMode,
    objectStorageBucket: parsedStorageUrl.bucket,
    objectStorageRegion: parsedStorageUrl.region || 'us-east-1',
    objectStorageEndpoint: parsedStorageUrl.endpoint,
    objectStorageAccessKeyId: deploymentSettings.storageAccessKeyId,
    objectStorageSecretAccessKey: deploymentSettings.storageAccessKey,
    objectStoragePrefix: 'workflows/',
    objectStorageForcePathStyle: parsedStorageUrl.forcePathStyle,
  };
}
