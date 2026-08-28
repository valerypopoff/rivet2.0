import { useMemo } from 'react';

import { ENVIRONMENT_VARIABLES_CHANGED_CHANNEL } from '../../../studio-server-shared/environment-variable-events';
import { environmentVariableSettingsResource } from '../appSettingsApi';
import {
  createEnvironmentVariableForm,
  type EnvironmentVariableSettingsForm,
  type EnvironmentVariableSettingsFormEntry,
} from './model';
import { useSettingsFormResource } from './useSettingsFormResource';

const defaultForm: EnvironmentVariableSettingsForm = { variables: [] };

function createClientId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `environment-variable-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function publishEnvironmentVariableChange(): void {
  if (typeof BroadcastChannel === 'undefined') {
    return;
  }

  const channel = new BroadcastChannel(ENVIRONMENT_VARIABLES_CHANGED_CHANNEL);
  channel.postMessage({ revision: String(Date.now()) });
  channel.close();
}

function isEntryChanged(
  entry: EnvironmentVariableSettingsFormEntry,
  baseline: EnvironmentVariableSettingsFormEntry | undefined,
): boolean {
  return !baseline
    || entry.name !== baseline.name
    || entry.browserAccess !== baseline.browserAccess
    || entry.valueTouched;
}

export function useEnvironmentVariablesForm(enabled: boolean) {
  const resource = useSettingsFormResource({
    afterSave: publishEnvironmentVariableChange,
    defaultForm,
    enabled,
    resource: environmentVariableSettingsResource,
    toForm: createEnvironmentVariableForm,
  });
  const draft = useMemo(() => ({
    variables: resource.form.variables.map((entry) => ({
      ...(entry.id ? { id: entry.id } : {}),
      name: entry.name.trim(),
      browserAccess: entry.browserAccess,
      ...(!entry.id || entry.valueTouched ? { value: entry.value } : {}),
    })),
  }), [resource.form.variables]);
  const baselineById = useMemo(
    () => new Map(resource.baseline.variables.map((entry) => [entry.id, entry])),
    [resource.baseline.variables],
  );
  const changed = resource.form.variables.length !== resource.baseline.variables.length
    || resource.form.variables.some((entry) => isEntryChanged(entry, entry.id ? baselineById.get(entry.id) : undefined));

  return {
    ...resource,
    add: () => resource.setForm((form) => ({
      variables: [
        ...form.variables,
        {
          clientId: createClientId(),
          name: '',
          value: '',
          valueConfigured: false,
          valueTouched: true,
          browserAccess: false,
        },
      ],
    })),
    changed,
    controlsDisabled: !resource.loaded || resource.loading || resource.saving,
    remove: (clientId: string) => resource.setForm((form) => ({
      variables: form.variables.filter((entry) => entry.clientId !== clientId),
    })),
    revert: () => resource.resetForm(),
    save: () => resource.save(draft),
  };
}
