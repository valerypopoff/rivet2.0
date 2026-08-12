import { RIVET_API_BASE_URL } from '../../shared/hosted-env';
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
  TrustedHostSettings,
  TrustedHostSettingsDraft,
  WebAppAuthSettings,
  WebAppAuthSettingsDraft,
  WorkflowEndpointAuthSettings,
  WorkflowEndpointAuthSettingsDraft,
} from '../../shared/app-settings-types';
import { parseJsonResponse } from './apiRequest';

const API = `${RIVET_API_BASE_URL}/app-settings`;

export type AppSettingsResourceResult<T> = {
  revision: string | null;
  settings: T;
};

export type AppSettingsResource<TSettings, TDraft> = {
  read(): Promise<AppSettingsResourceResult<TSettings>>;
  update(draft: TDraft, revision?: string | null): Promise<AppSettingsResourceResult<TSettings>>;
};

const appSettingsJsonResponse = <T,>(response: Response) => parseJsonResponse<T>(response, {
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
      return readResponse(await fetch(`${API}/${path}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(revision ? { 'If-Match': revision } : {}),
        },
        body: JSON.stringify(draft),
      }));
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
export const runtimeLimitSettingsResource = createAppSettingsResource<
  RuntimeLimitSettings,
  RuntimeLimitSettingsDraft
>('runtime-limits');
export const trustedHostSettingsResource = createAppSettingsResource<
  TrustedHostSettings,
  TrustedHostSettingsDraft
>('trusted-hosts');
export const deploymentStorageSettingsResource = createAppSettingsResource<
  DeploymentStorageSettings,
  DeploymentStorageSettingsDraft
>('deployment-storage');
export const publicRouteSettingsResource = createAppSettingsResource<
  PublicRouteSettings,
  PublicRouteSettingsDraft
>('public-routes');
export const workflowEndpointAuthSettingsResource = createAppSettingsResource<
  WorkflowEndpointAuthSettings,
  WorkflowEndpointAuthSettingsDraft
>('workflow-endpoint-auth');
export const webAppAuthSettingsResource = createAppSettingsResource<
  WebAppAuthSettings,
  WebAppAuthSettingsDraft
>('web-app-auth');
