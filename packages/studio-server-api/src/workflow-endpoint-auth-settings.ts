import path from 'node:path';

import type {
  WorkflowEndpointAuthSettings,
  WorkflowEndpointAuthSettingsDraft,
} from '../../studio-server-shared/app-settings-types.js';
import { hasSetting, requireBooleanSetting, requireSettingsRecord, toSettingsRecord } from './app-settings/schema.js';
import { VersionedSettingsRepository } from './app-settings/settings-repository.js';

const repoRoot = path.resolve(process.cwd(), '..', '..');
const WORKFLOW_ENDPOINT_AUTH_SETTINGS_RELATIVE_PATH = path.join('settings', 'workflow-endpoint-auth.json');

export const DEFAULT_WORKFLOW_ENDPOINT_AUTH_SETTINGS: Omit<WorkflowEndpointAuthSettings, 'source' | 'updatedAt'> = {
  requireBearerAuth: true,
};

function getAppDataRootForWorkflowEndpointAuth(): string {
  return path.resolve(process.env.RIVET_APP_DATA_ROOT?.trim() || path.join(repoRoot, '.data', 'rivet-app'));
}

export function getWorkflowEndpointAuthSettingsPath(): string {
  return path.join(getAppDataRootForWorkflowEndpointAuth(), WORKFLOW_ENDPOINT_AUTH_SETTINGS_RELATIVE_PATH);
}

function normalizeWorkflowEndpointAuthSettingsDraft(
  value: unknown,
  fallback = DEFAULT_WORKFLOW_ENDPOINT_AUTH_SETTINGS,
): Omit<WorkflowEndpointAuthSettings, 'source' | 'updatedAt'> {
  const raw = toSettingsRecord(value) as WorkflowEndpointAuthSettingsDraft;

  return {
    requireBearerAuth: hasSetting(raw, 'requireBearerAuth')
      ? requireBooleanSetting(raw.requireBearerAuth, 'Require bearer token')
      : fallback.requireBearerAuth,
  };
}

function readWorkflowEndpointAuthSettingsFromText(settingsText: string): WorkflowEndpointAuthSettings {
  const parsed = requireSettingsRecord(JSON.parse(settingsText) as unknown, 'Workflow endpoint auth settings must be an object');

  const settings = normalizeWorkflowEndpointAuthSettingsDraft(parsed);
  return {
    ...settings,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    source: 'app-settings',
  };
}

export const workflowEndpointAuthSettingsRepository = new VersionedSettingsRepository<WorkflowEndpointAuthSettings>({
  key: 'workflow endpoint auth',
  currentVersion: 1,
  getPath: getWorkflowEndpointAuthSettingsPath,
  getDefault: () => ({
    ...DEFAULT_WORKFLOW_ENDPOINT_AUTH_SETTINGS,
    updatedAt: null,
    source: 'default',
  }),
  parseStored: (stored) => readWorkflowEndpointAuthSettingsFromText(JSON.stringify(stored)),
  serialize: (settings) => ({
    requireBearerAuth: settings.requireBearerAuth,
    updatedAt: settings.updatedAt,
  }),
});

export function readWorkflowEndpointAuthSettingsSync(): WorkflowEndpointAuthSettings {
  return workflowEndpointAuthSettingsRepository.readSync().value;
}

export async function readWorkflowEndpointAuthSettings(): Promise<WorkflowEndpointAuthSettings> {
  return (await workflowEndpointAuthSettingsRepository.read()).value;
}

export async function writeWorkflowEndpointAuthSettings(
  draft: unknown,
  expectedRevision?: string,
): Promise<WorkflowEndpointAuthSettings> {
  return (await workflowEndpointAuthSettingsRepository.update((previousSettings) => ({
    ...normalizeWorkflowEndpointAuthSettingsDraft(draft, previousSettings),
    updatedAt: new Date().toISOString(),
    source: 'app-settings',
  }), expectedRevision)).value;
}
