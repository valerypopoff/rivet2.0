import { RIVET_API_BASE_URL } from '../../shared/hosted-env';
import type {
  NodeExecutorProxySettings,
  NodeExecutorProxySettingsDraft,
  RunRecordingsSettings,
  RunRecordingsSettingsDraft,
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
