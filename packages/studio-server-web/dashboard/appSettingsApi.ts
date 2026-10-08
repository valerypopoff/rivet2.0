import { RIVET_API_BASE_URL } from '../../studio-server-shared/hosted-env';
import type {
  DeploymentStorageSettings,
  DeploymentStorageSettingsDraft,
  EnvironmentVariableSettings,
  EnvironmentVariableSettingsDraft,
  EnvironmentVariableValue,
  ExecutorUrlOverrideSettings,
  ExecutorUrlOverrideSettingsDraft,
  NodeExecutorProxySettings,
  NodeExecutorProxySettingsDraft,
  PublicRouteSettings,
  PublicRouteSettingsDraft,
  RunRecordingsSettings,
  RunRecordingsSettingsDraft,
  RuntimeLimitSettings,
  RuntimeLimitSettingsDraft,
  ServerUiSession,
  TrustedClientSettings,
  TrustedClientSettingsDraft,
  WebAppAuthSettings,
  WebAppAuthSettingsDraft,
  WorkflowEndpointAuthSettings,
  WorkflowEndpointAuthSettingsDraft,
} from '../../studio-server-shared/app-settings-types';
import { parseJsonResponse } from './apiRequest';

const API = `${RIVET_API_BASE_URL}/app-settings`;

export async function readServerUiSession(signal?: AbortSignal): Promise<ServerUiSession> {
  return appSettingsJsonResponse(await fetch(`${API}/server-ui-session`, { cache: 'no-store', signal }));
}

export type VmMigrationTarget = {
  databaseUrl: string;
  databaseSslMode: 'disable' | 'require' | 'verify-full';
  bucket: string;
  endpoint: string;
  region: string;
  prefix: string;
  forcePathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  settingsEncryptionKey: string;
  targetOffline: boolean;
  runtimePlatformCompatible: boolean;
};

export type VmMigrationStatus = {
  available: boolean;
  unavailableReason?: string | null;
  sourceKind?: 'legacy' | 'sqlite';
  precopyAvailable?: boolean;
  maintenance: { enteredAt: string } | null;
  drain: { ready: boolean; blockers: string[] } | null;
  job: {
    id: string;
    phase:
      | 'precopying'
      | 'precopy_complete'
      | 'copying'
      | 'verifying'
      | 'verified'
      | 'failed'
      | 'interrupted'
      | 'invalidated';
    startedAt: string;
    finishedAt: string | null;
    message: string | null;
    progress?: { completed: number; byDomain: Record<string, number>; lastItem: { domain: string; id: string } | null };
    precopyCompleted?: boolean;
    finalCopyStarted?: boolean;
    targetIdentity?: string;
    report?: {
      projects: number;
      folders: number;
      recordings: number;
      publishedEndpoints: number;
      publishedWebApps: number;
      evaluationAndHealthRows: number;
      runtimeLibraryPackages: number;
      appSettingsDomains: number;
      checked: string[];
    };
    deploymentReview?: { reviewedAt: string; sourceManifestHash: string };
  } | null;
};

export type VmMigrationSourceInventory = {
  projects: number;
  folders: number;
  recordingBundles: number;
  publishedEndpoints: number;
  publishedWebApps: number;
  publishedVersions: number;
  savedSettingsDomains: number;
  sourceDatabaseAuthority: string;
  codeNodes: number;
  fileNodes: number;
  warnings: string[];
};

export async function readVmMigrationSourceInventory(): Promise<VmMigrationSourceInventory> {
  return appSettingsJsonResponse(await fetch(`${API}/vm-migration/inventory`, { cache: 'no-store' }));
}

export async function readVmMigrationStatus(): Promise<VmMigrationStatus> {
  return appSettingsJsonResponse(await fetch(`${API}/vm-migration`, { cache: 'no-store' }));
}

export async function testVmMigrationDatabase(target: VmMigrationTarget): Promise<void> {
  await appSettingsJsonResponse(
    await fetch(`${API}/vm-migration/test-database`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Rivet-Migration-Intent': '1' },
      body: JSON.stringify({ databaseUrl: target.databaseUrl, databaseSslMode: target.databaseSslMode }),
    }),
  );
}

export async function testVmMigrationObjectStorage(target: VmMigrationTarget): Promise<void> {
  await appSettingsJsonResponse(
    await fetch(`${API}/vm-migration/test-object-storage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Rivet-Migration-Intent': '1' },
      body: JSON.stringify({
        bucket: target.bucket,
        endpoint: target.endpoint,
        region: target.region,
        prefix: target.prefix,
        forcePathStyle: target.forcePathStyle,
        accessKeyId: target.accessKeyId,
        secretAccessKey: target.secretAccessKey,
      }),
    }),
  );
}

export async function enterVmMigrationMode(): Promise<VmMigrationStatus> {
  return appSettingsJsonResponse(
    await fetch(`${API}/vm-migration/maintenance`, { method: 'POST', headers: { 'X-Rivet-Migration-Intent': '1' } }),
  );
}

export async function leaveVmMigrationMode(target?: VmMigrationTarget): Promise<void> {
  await appSettingsJsonResponse(
    await fetch(`${API}/vm-migration/maintenance`, {
      method: 'DELETE',
      headers: target
        ? { 'Content-Type': 'application/json', 'X-Rivet-Migration-Intent': '1' }
        : { 'X-Rivet-Migration-Intent': '1' },
      body: target ? JSON.stringify(target) : undefined,
    }),
  );
}

export async function acknowledgeInterruptedVmMigration(): Promise<VmMigrationStatus> {
  return appSettingsJsonResponse(
    await fetch(`${API}/vm-migration/recover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Rivet-Migration-Intent': '1' },
      body: JSON.stringify({ importerStopped: true }),
    }),
  );
}

export async function startVmMigration(target: VmMigrationTarget): Promise<void> {
  await appSettingsJsonResponse(
    await fetch(`${API}/vm-migration/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Rivet-Migration-Intent': '1' },
      body: JSON.stringify(target),
    }),
  );
}

export async function startVmMigrationPrecopy(target: VmMigrationTarget): Promise<void> {
  await appSettingsJsonResponse(
    await fetch(`${API}/vm-migration/precopy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Rivet-Migration-Intent': '1' },
      body: JSON.stringify(target),
    }),
  );
}

export type VmMigrationDeploymentChecks = {
  backupCompleted: boolean;
  deploymentSettingsMatch: boolean;
  functionalRehearsalPassed: boolean;
  externalDependenciesReviewed: boolean;
  rollbackWindowUnderstood: boolean;
};

export async function reviewVmMigrationDeployment(
  target: VmMigrationTarget,
  checks: VmMigrationDeploymentChecks,
): Promise<void> {
  await appSettingsJsonResponse(
    await fetch(`${API}/vm-migration/deployment-review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Rivet-Migration-Intent': '1' },
      body: JSON.stringify({ target, checks }),
    }),
  );
}

export async function readCurrentTrustedClient(): Promise<{ clientAddress: string | null; trusted: boolean }> {
  return appSettingsJsonResponse(await fetch(`${API}/trusted-clients/current-request`, { cache: 'no-store' }));
}

export type AppSettingsResourceResult<T> = {
  revision: string | null;
  settings: T;
};

export type AppSettingsResource<TSettings, TDraft> = {
  read(): Promise<AppSettingsResourceResult<TSettings>>;
  update(draft: TDraft, revision?: string | null): Promise<AppSettingsResourceResult<TSettings>>;
};

const appSettingsJsonResponse = <T>(response: Response) =>
  parseJsonResponse<T>(response, {
    nonJsonErrorMessage:
      'App settings API returned HTML instead of JSON. Make sure you are accessing the app through the proxy and that /api/app-settings is routed to the API service.',
  });

function createAppSettingsResource<TSettings, TDraft>(path: string): AppSettingsResource<TSettings, TDraft> {
  const readResponse = async (response: Response): Promise<AppSettingsResourceResult<TSettings>> => ({
    revision: response.headers.get('etag'),
    settings: await appSettingsJsonResponse<TSettings>(response),
  });

  return {
    async read() {
      return readResponse(await fetch(`${API}/${path}`, { cache: 'no-store' }));
    },
    async update(draft, revision) {
      return readResponse(
        await fetch(`${API}/${path}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            ...(revision ? { 'If-Match': revision } : {}),
          },
          body: JSON.stringify(draft),
        }),
      );
    },
  };
}

export const nodeExecutorProxySettingsResource = createAppSettingsResource<
  NodeExecutorProxySettings,
  NodeExecutorProxySettingsDraft
>('node-executor-proxy');
export const environmentVariableSettingsResource = createAppSettingsResource<
  EnvironmentVariableSettings,
  EnvironmentVariableSettingsDraft
>('environment-variables');

export async function readEnvironmentVariableValue(
  id: string,
  signal?: AbortSignal,
): Promise<EnvironmentVariableValue> {
  return appSettingsJsonResponse<EnvironmentVariableValue>(
    await fetch(`${API}/environment-variables/${encodeURIComponent(id)}/value`, { cache: 'no-store', signal }),
  );
}
export const executorUrlOverrideSettingsResource = createAppSettingsResource<
  ExecutorUrlOverrideSettings,
  ExecutorUrlOverrideSettingsDraft
>('executor-url-overrides');
export const runRecordingsSettingsResource = createAppSettingsResource<
  RunRecordingsSettings,
  RunRecordingsSettingsDraft
>('run-recordings');
export const runtimeLimitSettingsResource = createAppSettingsResource<RuntimeLimitSettings, RuntimeLimitSettingsDraft>(
  'runtime-limits',
);
export const trustedClientSettingsResource = createAppSettingsResource<
  TrustedClientSettings,
  TrustedClientSettingsDraft
>('trusted-clients');
export const deploymentStorageSettingsResource = createAppSettingsResource<
  DeploymentStorageSettings,
  DeploymentStorageSettingsDraft
>('deployment-storage');
export const publicRouteSettingsResource = createAppSettingsResource<PublicRouteSettings, PublicRouteSettingsDraft>(
  'public-routes',
);
export const workflowEndpointAuthSettingsResource = createAppSettingsResource<
  WorkflowEndpointAuthSettings,
  WorkflowEndpointAuthSettingsDraft
>('workflow-endpoint-auth');
export const webAppAuthSettingsResource = createAppSettingsResource<WebAppAuthSettings, WebAppAuthSettingsDraft>(
  'web-app-auth',
);
