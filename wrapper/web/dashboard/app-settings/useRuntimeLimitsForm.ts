import { useMemo } from 'react';

import type { RuntimeLimitSettingsDraft } from '../../../shared/app-settings-types';
import { runtimeLimitSettingsResource } from '../appSettingsApi';
import {
  createRuntimeLimitForm,
  miBStringToBytesString,
  type RuntimeLimitSettingsForm,
  type RuntimeLimitSettingsScope,
} from './model';
import { useSettingsFormResource } from './useSettingsFormResource';

const defaultForm: RuntimeLimitSettingsForm = {
  commandTimeoutSeconds: '30',
  maxOutputMiB: '10',
  proxyReadTimeoutSeconds: '180',
  webAppActionRequestLimitMiB: '100',
  dockerWaitTimeoutSeconds: '1200',
};

function mergeSavedForm(
  saved: RuntimeLimitSettingsForm,
  current: RuntimeLimitSettingsForm,
  scope: RuntimeLimitSettingsScope | null,
): RuntimeLimitSettingsForm {
  if (scope === 'shell') {
    return { ...current, commandTimeoutSeconds: saved.commandTimeoutSeconds, maxOutputMiB: saved.maxOutputMiB };
  }
  if (scope === 'proxy-timeout') {
    return { ...current, proxyReadTimeoutSeconds: saved.proxyReadTimeoutSeconds };
  }
  if (scope === 'web-app-request-size') {
    return { ...current, webAppActionRequestLimitMiB: saved.webAppActionRequestLimitMiB };
  }
  if (scope === 'docker') {
    return { ...current, dockerWaitTimeoutSeconds: saved.dockerWaitTimeoutSeconds };
  }
  return saved;
}

export function useRuntimeLimitsForm(enabled: boolean) {
  const resource = useSettingsFormResource({
    defaultForm,
    enabled,
    mergeSavedForm,
    resource: runtimeLimitSettingsResource,
    toForm: createRuntimeLimitForm,
  });
  const changed = useMemo(() => ({
    docker: resource.form.dockerWaitTimeoutSeconds.trim() !== resource.baseline.dockerWaitTimeoutSeconds,
    proxyTimeout: resource.form.proxyReadTimeoutSeconds.trim() !== resource.baseline.proxyReadTimeoutSeconds,
    shell: (
      resource.form.commandTimeoutSeconds.trim() !== resource.baseline.commandTimeoutSeconds ||
      resource.form.maxOutputMiB.trim() !== resource.baseline.maxOutputMiB
    ),
    webAppRequestSize: (
      resource.form.webAppActionRequestLimitMiB.trim() !== resource.baseline.webAppActionRequestLimitMiB
    ),
  }), [resource.baseline, resource.form]);

  const save = (scope: RuntimeLimitSettingsScope) => {
    const draft: RuntimeLimitSettingsDraft = scope === 'shell'
      ? {
          commandTimeoutSeconds: resource.form.commandTimeoutSeconds.trim(),
          maxOutputBytes: miBStringToBytesString(resource.form.maxOutputMiB),
        }
      : scope === 'proxy-timeout'
        ? { proxyReadTimeoutSeconds: resource.form.proxyReadTimeoutSeconds.trim() }
        : scope === 'web-app-request-size'
          ? { webAppActionRequestLimitBytes: miBStringToBytesString(resource.form.webAppActionRequestLimitMiB) }
          : { dockerWaitTimeoutSeconds: resource.form.dockerWaitTimeoutSeconds.trim() };
    return resource.save(draft, scope);
  };

  const revert = (scope: RuntimeLimitSettingsScope) => {
    resource.setForm((current) => mergeSavedForm(resource.baseline, current, scope));
    resource.clearFeedback();
  };

  return {
    ...resource,
    changed,
    controlsDisabled: !resource.loaded || resource.loading || resource.saving,
    revert,
    save,
  };
}
