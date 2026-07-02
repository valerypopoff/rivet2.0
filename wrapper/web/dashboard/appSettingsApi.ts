import { RIVET_API_BASE_URL } from '../../shared/hosted-env';
import type {
  NodeExecutorProxySettings,
  NodeExecutorProxySettingsDraft,
  DeploymentStorageSettings,
  DeploymentStorageSettingsDraft,
  ExecutorUrlOverrideSettings,
  ExecutorUrlOverrideSettingsDraft,
  PublicRouteSettings,
  PublicRouteSettingsDraft,
  RunRecordingsSettings,
  RunRecordingsSettingsDraft,
  RuntimeLimitSettings,
  RuntimeLimitSettingsDraft,
  WebAppAuthSettings,
  WebAppAuthSettingsDraft,
  WorkflowEndpointAuthSettings,
  WorkflowEndpointAuthSettingsDraft,
} from '../../shared/app-settings-types';
import { parseJsonResponse } from './apiRequest';

const API = `${RIVET_API_BASE_URL}/app-settings`;

const appSettingsJsonResponse = <T,>(response: Response) => parseJsonResponse<T>(response, {
  nonJsonErrorMessage:
    'App settings API returned HTML instead of JSON. Make sure you are accessing the app through the proxy and that /api/app-settings is routed to the API service.',
});

export async function fetchNodeExecutorProxySettings(): Promise<NodeExecutorProxySettings> {
  const response = await fetch(`${API}/node-executor-proxy`, {
    cache: 'no-store',
  });
  return appSettingsJsonResponse<NodeExecutorProxySettings>(response);
}

export async function saveNodeExecutorProxySettings(
  settings: NodeExecutorProxySettingsDraft,
): Promise<NodeExecutorProxySettings> {
  const response = await fetch(`${API}/node-executor-proxy`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  return appSettingsJsonResponse<NodeExecutorProxySettings>(response);
}

export async function fetchExecutorUrlOverrideSettings(): Promise<ExecutorUrlOverrideSettings> {
  const response = await fetch(`${API}/executor-url-overrides`, {
    cache: 'no-store',
  });
  return appSettingsJsonResponse<ExecutorUrlOverrideSettings>(response);
}

export async function saveExecutorUrlOverrideSettings(
  settings: ExecutorUrlOverrideSettingsDraft,
): Promise<ExecutorUrlOverrideSettings> {
  const response = await fetch(`${API}/executor-url-overrides`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  return appSettingsJsonResponse<ExecutorUrlOverrideSettings>(response);
}

export async function fetchRunRecordingsSettings(): Promise<RunRecordingsSettings> {
  const response = await fetch(`${API}/run-recordings`, {
    cache: 'no-store',
  });
  return appSettingsJsonResponse<RunRecordingsSettings>(response);
}

export async function saveRunRecordingsSettings(
  settings: RunRecordingsSettingsDraft,
): Promise<RunRecordingsSettings> {
  const response = await fetch(`${API}/run-recordings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  return appSettingsJsonResponse<RunRecordingsSettings>(response);
}

export async function fetchRuntimeLimitSettings(): Promise<RuntimeLimitSettings> {
  const response = await fetch(`${API}/runtime-limits`, {
    cache: 'no-store',
  });
  return appSettingsJsonResponse<RuntimeLimitSettings>(response);
}

export async function saveRuntimeLimitSettings(
  settings: RuntimeLimitSettingsDraft,
): Promise<RuntimeLimitSettings> {
  const response = await fetch(`${API}/runtime-limits`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  return appSettingsJsonResponse<RuntimeLimitSettings>(response);
}

export async function fetchDeploymentStorageSettings(): Promise<DeploymentStorageSettings> {
  const response = await fetch(`${API}/deployment-storage`, {
    cache: 'no-store',
  });
  return appSettingsJsonResponse<DeploymentStorageSettings>(response);
}

export async function saveDeploymentStorageSettings(
  settings: DeploymentStorageSettingsDraft,
): Promise<DeploymentStorageSettings> {
  const response = await fetch(`${API}/deployment-storage`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  return appSettingsJsonResponse<DeploymentStorageSettings>(response);
}

export async function fetchPublicRouteSettings(): Promise<PublicRouteSettings> {
  const response = await fetch(`${API}/public-routes`, {
    cache: 'no-store',
  });
  return appSettingsJsonResponse<PublicRouteSettings>(response);
}

export async function savePublicRouteSettings(
  settings: PublicRouteSettingsDraft,
): Promise<PublicRouteSettings> {
  const response = await fetch(`${API}/public-routes`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  return appSettingsJsonResponse<PublicRouteSettings>(response);
}

export async function fetchWorkflowEndpointAuthSettings(): Promise<WorkflowEndpointAuthSettings> {
  const response = await fetch(`${API}/workflow-endpoint-auth`, {
    cache: 'no-store',
  });
  return appSettingsJsonResponse<WorkflowEndpointAuthSettings>(response);
}

export async function saveWorkflowEndpointAuthSettings(
  settings: WorkflowEndpointAuthSettingsDraft,
): Promise<WorkflowEndpointAuthSettings> {
  const response = await fetch(`${API}/workflow-endpoint-auth`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  return appSettingsJsonResponse<WorkflowEndpointAuthSettings>(response);
}

export async function fetchWebAppAuthSettings(): Promise<WebAppAuthSettings> {
  const response = await fetch(`${API}/web-app-auth`, {
    cache: 'no-store',
  });
  return appSettingsJsonResponse<WebAppAuthSettings>(response);
}

export async function saveWebAppAuthSettings(
  settings: WebAppAuthSettingsDraft,
): Promise<WebAppAuthSettings> {
  const response = await fetch(`${API}/web-app-auth`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  return appSettingsJsonResponse<WebAppAuthSettings>(response);
}
