import { useMemo } from 'react';

import { runRecordingsSettingsResource } from '../appSettingsApi';
import {
  defaultMaxRunsPerEndpoint,
  defaultRetentionDays,
  type RunRecordingsSettingsForm,
} from './model';
import { useSettingsFormResource } from './useSettingsFormResource';

const defaultForm: RunRecordingsSettingsForm = {
  maxPendingWrites: '100',
  maxRunsPerEndpoint: defaultMaxRunsPerEndpoint,
  maxRunsPerEndpointMode: 'latest',
  retentionDays: defaultRetentionDays,
  recordingRetentionMode: 'limited',
};

export function useRunRecordingsForm(enabled: boolean) {
  const resource = useSettingsFormResource({
    defaultForm,
    enabled,
    resource: runRecordingsSettingsResource,
    toForm: (settings): RunRecordingsSettingsForm => ({
      maxPendingWrites: String(settings.maxPendingWrites),
      maxRunsPerEndpoint: settings.maxRunsPerEndpoint === 0
        ? defaultMaxRunsPerEndpoint
        : String(settings.maxRunsPerEndpoint),
      maxRunsPerEndpointMode: settings.maxRunsPerEndpoint === 0 ? 'all' : 'latest',
      retentionDays: settings.retentionDays === 0 ? defaultRetentionDays : String(settings.retentionDays),
      recordingRetentionMode: settings.retentionDays === 0 ? 'forever' : 'limited',
    }),
  });
  const draft = useMemo(() => ({
    maxPendingWrites: resource.form.maxPendingWrites.trim(),
    maxRunsPerEndpoint: resource.form.maxRunsPerEndpointMode === 'all'
      ? '0'
      : resource.form.maxRunsPerEndpoint.trim(),
    retentionDays: resource.form.recordingRetentionMode === 'forever'
      ? '0'
      : resource.form.retentionDays.trim(),
  }), [resource.form]);
  const baselineDraft = useMemo(() => ({
    maxPendingWrites: resource.baseline.maxPendingWrites.trim(),
    maxRunsPerEndpoint: resource.baseline.maxRunsPerEndpointMode === 'all'
      ? '0'
      : resource.baseline.maxRunsPerEndpoint.trim(),
    retentionDays: resource.baseline.recordingRetentionMode === 'forever'
      ? '0'
      : resource.baseline.retentionDays.trim(),
  }), [resource.baseline]);

  return {
    ...resource,
    changed: JSON.stringify(draft) !== JSON.stringify(baselineDraft),
    controlsDisabled: !resource.loaded || resource.loading || resource.saving,
    revert: () => resource.resetForm(),
    save: () => resource.save(draft),
  };
}
