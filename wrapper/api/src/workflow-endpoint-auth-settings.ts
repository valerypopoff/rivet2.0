import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import type {
  WorkflowEndpointAuthSettings,
  WorkflowEndpointAuthSettingsDraft,
} from '../../shared/app-settings-types.js';
import { writePrivateJsonSettingsFile } from './settings-file-writer.js';
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

export function readWorkflowEndpointAuthSettingsSync(): WorkflowEndpointAuthSettings {
  const settingsPath = getWorkflowEndpointAuthSettingsPath();

  try {
    return readWorkflowEndpointAuthSettingsFromText(fs.readFileSync(settingsPath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        ...DEFAULT_WORKFLOW_ENDPOINT_AUTH_SETTINGS,
        updatedAt: null,
        source: 'default',
      };
    }

    throw error;
  }
}

export async function readWorkflowEndpointAuthSettings(): Promise<WorkflowEndpointAuthSettings> {
  const settingsPath = getWorkflowEndpointAuthSettingsPath();

  try {
    return readWorkflowEndpointAuthSettingsFromText(await fsp.readFile(settingsPath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        ...DEFAULT_WORKFLOW_ENDPOINT_AUTH_SETTINGS,
        updatedAt: null,
        source: 'default',
      };
    }

    throw error;
  }
}

export async function writeWorkflowEndpointAuthSettings(draft: unknown): Promise<WorkflowEndpointAuthSettings> {
  const previousSettings = await readWorkflowEndpointAuthSettings();
  const settings = normalizeWorkflowEndpointAuthSettingsDraft(draft, previousSettings);
  const saved: WorkflowEndpointAuthSettings = {
    ...settings,
    updatedAt: new Date().toISOString(),
    source: 'app-settings',
  };

  await writePrivateJsonSettingsFile(getWorkflowEndpointAuthSettingsPath(), {
    version: 1,
    requireBearerAuth: saved.requireBearerAuth,
    updatedAt: saved.updatedAt,
  });

  return saved;
}
