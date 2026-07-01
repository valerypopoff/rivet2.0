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

function normalizeNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value));
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : fallback;
  }

  return fallback;
}

export function normalizeWorkflowRecordingLimitSettings(value: unknown): WorkflowRecordingLimitSettings {
  const raw = value && typeof value === 'object'
    ? value as RunRecordingsSettingsDraft
    : {};

  return {
    maxPendingWrites: normalizeNumber(
      raw.maxPendingWrites,
      DEFAULT_WORKFLOW_RECORDING_LIMIT_SETTINGS.maxPendingWrites,
    ),
    retentionDays: normalizeNumber(
      raw.retentionDays,
      DEFAULT_WORKFLOW_RECORDING_LIMIT_SETTINGS.retentionDays,
    ),
    maxRunsPerEndpoint: normalizeNumber(
      raw.maxRunsPerEndpoint,
      DEFAULT_WORKFLOW_RECORDING_LIMIT_SETTINGS.maxRunsPerEndpoint,
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
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[workflow-recordings] Failed to read run-recordings app settings:', error);
    }

    return DEFAULT_WORKFLOW_RECORDING_LIMIT_SETTINGS;
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
