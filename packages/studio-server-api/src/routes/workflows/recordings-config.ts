import path from 'node:path';

import type { RunRecordingsSettings, RunRecordingsSettingsDraft } from '../../../../studio-server-shared/app-settings-types.js';
import { VersionedSettingsRepository } from '../../app-settings/settings-repository.js';
import { parseBoolean, parseEnum, parseIntWithMinimum } from '../../utils/env-parsing.js';
import { getAppDataRoot } from '../../security.js';

export type WorkflowRecordingCompression = 'gzip' | 'identity';

export type WorkflowRecordingDatasetMode = 'none' | 'all';

export type WorkflowRecordingLimitSettings = {
  maxPendingWrites: number;
  retentionDays: number;
  maxRunsPerEndpoint: number;
};

export const RUN_RECORDINGS_SETTINGS_RELATIVE_PATH = path.join('settings', 'run-recordings.json');

export const DEFAULT_WORKFLOW_RECORDING_LIMIT_SETTINGS: WorkflowRecordingLimitSettings = {
  maxPendingWrites: 100,
  retentionDays: 14,
  maxRunsPerEndpoint: 100,
};

const MAX_RECORDING_SETTING_VALUE = 1_000_000;

export type WorkflowRecordingConfig = {
  enabled: boolean;
  compression: WorkflowRecordingCompression;
  gzipLevel: number;
  maxPendingWrites: number;
  includePartialOutputs: boolean;
  includeTrace: boolean;
  datasetMode: WorkflowRecordingDatasetMode;
  retentionDays: number;
  maxRunsPerEndpoint: number;
  maxTotalBytes: number;
};

function hasOwn(value: object, key: keyof RunRecordingsSettingsDraft): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeNumber(value: unknown, fallback: number, fieldLabel: string): number {
  if (typeof value === 'undefined' || value === null || value === '') {
    return fallback;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${fieldLabel} must be a non-negative whole number`);
    }

    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  throw new Error(`${fieldLabel} must be a non-negative whole number`);
}

export function normalizeWorkflowRecordingLimitSettings(value: unknown): WorkflowRecordingLimitSettings {
  const raw = value && typeof value === 'object'
    ? value as RunRecordingsSettingsDraft
    : {};

  return {
    maxPendingWrites: normalizeNumber(
      hasOwn(raw, 'maxPendingWrites') ? raw.maxPendingWrites : undefined,
      DEFAULT_WORKFLOW_RECORDING_LIMIT_SETTINGS.maxPendingWrites,
      'Queued recording writes',
    ),
    retentionDays: normalizeNumber(
      hasOwn(raw, 'retentionDays') ? raw.retentionDays : undefined,
      DEFAULT_WORKFLOW_RECORDING_LIMIT_SETTINGS.retentionDays,
      'Days to keep recordings',
    ),
    maxRunsPerEndpoint: normalizeNumber(
      hasOwn(raw, 'maxRunsPerEndpoint') ? raw.maxRunsPerEndpoint : undefined,
      DEFAULT_WORKFLOW_RECORDING_LIMIT_SETTINGS.maxRunsPerEndpoint,
      'Runs kept per workflow endpoint',
    ),
  };
}

export function getRunRecordingsSettingsPath(): string {
  return path.join(
    path.resolve(process.env.RIVET_APP_DATA_ROOT?.trim() || getAppDataRoot()),
    RUN_RECORDINGS_SETTINGS_RELATIVE_PATH,
  );
}

function normalizeRunRecordingsSettingsDraft(value: unknown): WorkflowRecordingLimitSettings {
  const settings = normalizeWorkflowRecordingLimitSettings(value);
  for (const [label, setting] of [
    ['Queued recording writes', settings.maxPendingWrites],
    ['Runs kept per workflow endpoint', settings.maxRunsPerEndpoint],
    ['Days to keep recordings', settings.retentionDays],
  ] as const) {
    if (setting > MAX_RECORDING_SETTING_VALUE) {
      throw new Error(`${label} is too large`);
    }
  }
  return settings;
}

export const runRecordingsSettingsRepository = new VersionedSettingsRepository<RunRecordingsSettings>({
  key: 'run recordings',
  currentVersion: 1,
  getPath: getRunRecordingsSettingsPath,
  getDefault: () => ({
    ...DEFAULT_WORKFLOW_RECORDING_LIMIT_SETTINGS,
    updatedAt: null,
    source: 'default',
  }),
  parseStored: (stored) => ({
    ...normalizeRunRecordingsSettingsDraft(stored),
    updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : null,
    source: 'app-settings',
  }),
  serialize: (settings) => ({
    maxPendingWrites: settings.maxPendingWrites,
    maxRunsPerEndpoint: settings.maxRunsPerEndpoint,
    retentionDays: settings.retentionDays,
    updatedAt: settings.updatedAt,
  }),
});

export function readWorkflowRecordingLimitSettings(): WorkflowRecordingLimitSettings {
  const settings = runRecordingsSettingsRepository.readSync().value;
  return {
    maxPendingWrites: settings.maxPendingWrites,
    retentionDays: settings.retentionDays,
    maxRunsPerEndpoint: settings.maxRunsPerEndpoint,
  };
}

export async function readRunRecordingsSettings(): Promise<RunRecordingsSettings> {
  return (await runRecordingsSettingsRepository.read()).value;
}

export async function writeRunRecordingsSettings(draft: unknown, expectedRevision?: string): Promise<RunRecordingsSettings> {
  return (await runRecordingsSettingsRepository.update((previous) => ({
    ...normalizeRunRecordingsSettingsDraft({
      ...previous,
      ...(draft && typeof draft === 'object' ? draft : {}),
    }),
    updatedAt: new Date().toISOString(),
    source: 'app-settings',
  }), expectedRevision)).value;
}

export function getWorkflowRecordingConfig(): WorkflowRecordingConfig {
  const compression = parseEnum(process.env.RIVET_RECORDINGS_COMPRESS, ['gzip', 'identity'], 'gzip');
  const datasetMode = parseEnum(process.env.RIVET_RECORDINGS_DATASET_MODE, ['none', 'all'], 'none');
  const limitSettings = readWorkflowRecordingLimitSettings();

  return {
    enabled: parseBoolean(process.env.RIVET_RECORDINGS_ENABLED, true),
    compression,
    gzipLevel: Math.min(9, parseIntWithMinimum(process.env.RIVET_RECORDINGS_GZIP_LEVEL, 4, 0)),
    maxPendingWrites: limitSettings.maxPendingWrites,
    includePartialOutputs: parseBoolean(process.env.RIVET_RECORDINGS_INCLUDE_PARTIAL_OUTPUTS, false),
    includeTrace: parseBoolean(process.env.RIVET_RECORDINGS_INCLUDE_TRACE, false),
    datasetMode,
    retentionDays: limitSettings.retentionDays,
    maxRunsPerEndpoint: limitSettings.maxRunsPerEndpoint,
    maxTotalBytes: parseIntWithMinimum(process.env.RIVET_RECORDINGS_MAX_TOTAL_BYTES, 0, 0),
  };
}

export function isWorkflowRecordingEnabled(): boolean {
  return getWorkflowRecordingConfig().enabled;
}

export function getWorkflowExecutionRecorderOptions() {
  const config = getWorkflowRecordingConfig();
  return {
    includePartialOutputs: config.includePartialOutputs,
    includeTrace: config.includeTrace,
  };
}

export function shouldSnapshotWorkflowRecordingDatasets(): boolean {
  return getWorkflowRecordingConfig().datasetMode === 'all';
}
