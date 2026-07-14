import path from 'node:path';

import type {
  WorkflowEndpointAuthSettings,
  WorkflowEndpointAuthSettingsDraft,
} from '../../shared/app-settings-types.js';
import { VersionedSettingsRepository } from './app-settings/settings-repository.js';
import { badRequest } from './utils/httpError.js';

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

function isPresent(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeBoolean(value: unknown, fieldLabel: string): boolean {
  if (typeof value !== 'boolean') {
    throw badRequest(`${fieldLabel} must be true or false`);
  }

  return value;
}

function normalizeWorkflowEndpointAuthSettingsDraft(
  value: unknown,
  fallback = DEFAULT_WORKFLOW_ENDPOINT_AUTH_SETTINGS,
): Omit<WorkflowEndpointAuthSettings, 'source' | 'updatedAt'> {
  const raw = value && typeof value === 'object'
    ? value as WorkflowEndpointAuthSettingsDraft
    : {};

  return {
    requireBearerAuth: isPresent(raw, 'requireBearerAuth')
      ? normalizeBoolean(raw.requireBearerAuth, 'Require bearer token')
      : fallback.requireBearerAuth,
  };
}

function readWorkflowEndpointAuthSettingsFromText(settingsText: string): WorkflowEndpointAuthSettings {
  const parsed = JSON.parse(settingsText) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw badRequest('Workflow endpoint auth settings must be an object');
  }

  const settings = normalizeWorkflowEndpointAuthSettingsDraft(parsed);
  const raw = parsed as { updatedAt?: unknown };

  return {
    ...settings,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
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
