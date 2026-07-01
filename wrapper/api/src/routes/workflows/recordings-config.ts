import fs from 'node:fs';
import path from 'node:path';

import type { RunRecordingsSettingsDraft } from '../../../../shared/app-settings-types.js';
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

export function readWorkflowRecordingLimitSettings(): WorkflowRecordingLimitSettings {
  try {
    const settingsText = fs.readFileSync(getRunRecordingsSettingsPath(), 'utf8');
    return normalizeWorkflowRecordingLimitSettings(JSON.parse(settingsText));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return DEFAULT_WORKFLOW_RECORDING_LIMIT_SETTINGS;
    }

    throw error;
  }
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
